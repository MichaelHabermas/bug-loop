import { expect, test } from "bun:test";
import {
  costSampleFromOpenRouterUsage,
  enrichOpenRouterCost,
  parseOpenRouterActivityResponse,
  parseOpenRouterGenerationResponse,
  parseOpenRouterModelsResponse,
  reportedUsdFromTrace,
  shouldHaltBudget,
  sumReportedUsd,
  type FetchLike,
} from "../src";

test("parseOpenRouterGenerationResponse extracts tokens + usd", async () => {
  const body = await Bun.file(
    new URL("./fixtures/openrouter-generation.json", import.meta.url),
  ).json();
  const parsed = parseOpenRouterGenerationResponse(body, "gen-abc123xyz");
  expect(parsed).toMatchObject({
    id: "gen-abc123xyz",
    model: "deepseek/deepseek-v4-pro",
    inputTokens: 1200,
    outputTokens: 340,
    usd: 0.0042,
  });
});

test("parseOpenRouterActivityResponse lists generation rows", async () => {
  const body = await Bun.file(
    new URL("./fixtures/openrouter-activity.json", import.meta.url),
  ).json();
  const rows = parseOpenRouterActivityResponse(body);
  expect(rows).toHaveLength(2);
  expect(rows[0]?.id).toBe("gen-window-1");
  expect(sumReportedUsd(rows)).toBeCloseTo(0.002);
});

test("parseOpenRouterModelsResponse filters to wanted ids", () => {
  const body = {
    data: [
      {
        id: "deepseek/deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        pricing: { prompt: "0.000001", completion: "0.000002" },
      },
      { id: "other/model", pricing: { prompt: "1", completion: "1" } },
    ],
  };
  const found = parseOpenRouterModelsResponse(body, [
    "deepseek/deepseek-v4-pro",
    "missing/model",
  ]);
  expect(found).toHaveLength(1);
  expect(found[0]?.id).toBe("deepseek/deepseek-v4-pro");
  expect(found[0]?.promptPricePerToken).toBeCloseTo(0.000001);
});

test("enrichOpenRouterCost uses generation ids (fake fetch, no network)", async () => {
  const fixture = await Bun.file(
    new URL("./fixtures/openrouter-generation.json", import.meta.url),
  ).text();
  const fetchImpl: FetchLike = async (url) => {
    expect(url).toContain("/generation?id=gen-abc123xyz");
    return {
      ok: true,
      status: 200,
      text: async () => fixture,
      json: async () => JSON.parse(fixture) as unknown,
    };
  };
  const result = await enrichOpenRouterCost({
    generationIds: ["gen-abc123xyz"],
    model: "openrouter/deepseek/deepseek-v4-pro",
    client: { apiKey: "test-key", fetch: fetchImpl },
  });
  expect(result.usageStatus).toBe("reported");
  expect(result.source.kind).toBe("openrouter-generation");
  expect(result.sample).toMatchObject({
    harness: "opencode",
    usd: 0.0042,
    inputTokens: 1200,
    outputTokens: 340,
    costSource: "openrouter-generation",
    generationIds: ["gen-abc123xyz"],
  });
});

test("enrichOpenRouterCost marks unavailable when gen lookup empty (no fabricate)", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: false,
    status: 404,
    text: async () => "missing",
    json: async () => ({}),
  });
  const result = await enrichOpenRouterCost({
    generationIds: ["gen-missing"],
    client: { apiKey: "test-key", fetch: fetchImpl },
  });
  expect(result.usageStatus).toBe("unavailable");
  expect(result.sample.usd).toBeUndefined();
  expect(result.sample.costSource).toBe("unavailable");
  expect(result.source.kind).toBe("unavailable");
});

test("enrichOpenRouterCost falls back to activity window when gen-ids missing", async () => {
  const activity = await Bun.file(
    new URL("./fixtures/openrouter-activity.json", import.meta.url),
  ).text();
  const fetchImpl: FetchLike = async (url) => {
    expect(url).toContain("/activity");
    return {
      ok: true,
      status: 200,
      text: async () => activity,
      json: async () => JSON.parse(activity) as unknown,
    };
  };
  const result = await enrichOpenRouterCost({
    generationIds: [],
    window: {
      startedAt: new Date("2026-07-15T12:00:00.000Z"),
      finishedAt: new Date("2026-07-15T12:05:00.000Z"),
    },
    client: { apiKey: "test-key", fetch: fetchImpl },
  });
  expect(result.source.kind).toBe("openrouter-activity-fallback");
  expect(result.usageStatus).toBe("reported");
  expect(result.sample.usd).toBeCloseTo(0.002);
  expect(result.sample.costSource).toBe("openrouter-activity-fallback");
  if (result.source.kind === "openrouter-activity-fallback") {
    expect(result.source.reason).toContain("lacked generation ids");
  }
});

test("enrichOpenRouterCost documents missing gen-ids without window (no fabricate)", async () => {
  const result = await enrichOpenRouterCost({
    generationIds: [],
    client: {
      apiKey: "test-key",
      fetch: async () => {
        throw new Error("network must not be called");
      },
    },
  });
  expect(result.usageStatus).toBe("unavailable");
  expect(result.sample.usd).toBeUndefined();
  expect(result.source.kind).toBe("unavailable");
  if (result.source.kind === "unavailable") {
    expect(result.source.reason).toContain("no-generation-ids");
  }
});

test("costSampleFromOpenRouterUsage never invents usd", () => {
  const sample = costSampleFromOpenRouterUsage(
    [{ id: "gen-1", inputTokens: 10, raw: "{}" }],
    "openrouter-generation",
  );
  expect(sample.usd).toBeUndefined();
  expect(sample.inputTokens).toBe(10);
});

test("sumReportedUsd and shouldHaltBudget arithmetic", () => {
  expect(sumReportedUsd([{ usd: 1.5 }, { usd: 2 }, {}])).toBeCloseTo(3.5);
  expect(sumReportedUsd([])).toBe(0);
  expect(shouldHaltBudget(18, 18)).toBe(false);
  expect(shouldHaltBudget(18.0001, 18)).toBe(true);
  expect(shouldHaltBudget(17.99, 18)).toBe(false);
});

test("reportedUsdFromTrace prefers agentCalls reported status", () => {
  expect(
    reportedUsdFromTrace({
      events: [{ cost: { usd: 9 } }],
      agentCalls: [
        { usage: { status: "reported", usd: 0.4 } },
        { usage: { status: "unavailable" } },
        { usage: { status: "reported", usd: 0.1 } },
      ],
    }),
  ).toBeCloseTo(0.5);
});
