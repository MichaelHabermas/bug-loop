import { expect, test } from "bun:test";
import {
  FIX_SUMMARY_MARKER,
  OpenCodeFixer,
  OpenCodeTestWriter,
  configuredOpenCodeModel,
  normalizeOpenCodeModel,
  parseOpenCodeJsonOutput,
  type ProcessResult,
  type ProcessRunner,
  type TestWriteInput,
  type Incident,
} from "../src";

test("configuredOpenCodeModel and normalizeOpenCodeModel", () => {
  expect(configuredOpenCodeModel({})).toBeUndefined();
  expect(configuredOpenCodeModel({ BUGLOOP_OPENCODE_MODEL: "" })).toBeUndefined();
  expect(
    configuredOpenCodeModel({
      BUGLOOP_OPENCODE_MODEL: "openrouter/deepseek/deepseek-v4-pro",
    }),
  ).toBe("openrouter/deepseek/deepseek-v4-pro");
  expect(normalizeOpenCodeModel("deepseek/deepseek-v4-pro")).toBe(
    "openrouter/deepseek/deepseek-v4-pro",
  );
  expect(normalizeOpenCodeModel("openrouter/qwen/qwen3-coder")).toBe(
    "openrouter/qwen/qwen3-coder",
  );
});

test("OpenCodeFixer constructs opencode run --auto --format json command", async () => {
  const calls: Array<{ command: string[]; cwd: string }> = [];
  const runner: ProcessRunner = async (command, options): Promise<ProcessResult> => {
    calls.push({ command, cwd: options.cwd });
    if (command[0] === "opencode") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          type: "text",
          part: { text: `${FIX_SUMMARY_MARKER}\nGuarded input.` },
          providerMeta: { openrouter: { generationId: "gen-cmd-test" } },
        }),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: " M apps/leaky-service/src/server.ts\n",
      stderr: "",
    };
  };
  const fixer = new OpenCodeFixer(["apps/leaky-service/src"], runner, {
    model: "deepseek/deepseek-v4-pro",
    enrichCost: false,
  });
  const output = await fixer.fix({
    worktreeDir: "/tmp/bug-loop-worktree",
    issueTitle: "TypeError on POST /orders",
    issueBody: "HTTP 500",
    attempt: 1,
  });

  expect(calls[0]?.cwd).toBe("/tmp/bug-loop-worktree");
  expect(calls[0]?.command.slice(0, 8)).toEqual([
    "opencode",
    "run",
    "--auto",
    "--format",
    "json",
    "-m",
    "openrouter/deepseek/deepseek-v4-pro",
    "--dir",
  ]);
  expect(calls[0]?.command[8]).toBe("/tmp/bug-loop-worktree");
  expect(calls[0]?.command[9]).toContain(FIX_SUMMARY_MARKER);
  expect(calls[0]?.command[9]).toContain("<issueTitle>");
  expect(output.description).toBe("Guarded input.");
  expect(output.filesChanged).toEqual(["apps/leaky-service/src/server.ts"]);
  expect(fixer.takeGenerationIds()).toEqual(["gen-cmd-test"]);
  const cost = fixer.takeCost();
  expect(cost?.harness).toBe("opencode");
  expect(cost?.generationIds).toEqual(["gen-cmd-test"]);
  expect(cost?.usd).toBeUndefined();
  expect(cost?.costSource).toBe("unavailable");
});

test("parseOpenCodeJsonOutput extracts text + generation id from NDJSON fixture", async () => {
  const stdout = await Bun.file(
    new URL("./fixtures/opencode-stdout-with-gen.json", import.meta.url),
  ).text();
  const parsed = parseOpenCodeJsonOutput(stdout);
  expect(parsed?.generationIds).toContain("gen-abc123xyz");
  expect(extractSummary(parsed?.text ?? "")).toContain("missing null guard");
  expect(parsed?.model).toBe("openrouter/deepseek/deepseek-v4-pro");
});

test("parseOpenCodeJsonOutput missing gen-id leaves empty generationIds", async () => {
  const stdout = await Bun.file(
    new URL("./fixtures/opencode-stdout-no-gen.json", import.meta.url),
  ).text();
  const parsed = parseOpenCodeJsonOutput(stdout);
  expect(parsed?.generationIds).toEqual([]);
  expect(parsed?.text).toContain("Guarded missing customer");
});

test("OpenCodeFixer marks cost unavailable when JSON has no generation id", async () => {
  const noGen = await Bun.file(
    new URL("./fixtures/opencode-stdout-no-gen.json", import.meta.url),
  ).text();
  const runner: ProcessRunner = async (command): Promise<ProcessResult> => {
    if (command[0] === "opencode") {
      return { exitCode: 0, stdout: noGen, stderr: "" };
    }
    return { exitCode: 0, stdout: " M apps/leaky-service/src/server.ts\n", stderr: "" };
  };
  const fixer = new OpenCodeFixer(["apps/leaky-service/src"], runner, {
    model: "openrouter/qwen/qwen3-coder",
    enrichCost: false,
  });
  await fixer.fix({
    worktreeDir: "/tmp/wt",
    issueTitle: "bug",
    issueBody: "body",
    attempt: 1,
  });
  expect(fixer.takeGenerationIds()).toEqual([]);
  const cost = fixer.takeCost();
  expect(cost?.usd).toBeUndefined();
  expect(cost?.generationIds).toBeUndefined();
  expect(cost?.raw).toContain("no generation ids");
  expect(cost?.costSource).toBe("unavailable");
});

test("OpenCodeFixer enriches CostSample via injected OpenRouter fetch", async () => {
  const generationFixture = await Bun.file(
    new URL("./fixtures/openrouter-generation.json", import.meta.url),
  ).text();
  const runner: ProcessRunner = async (command): Promise<ProcessResult> => {
    if (command[0] === "opencode") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          type: "text",
          part: { text: `${FIX_SUMMARY_MARKER}\nFixed.` },
          generationId: "gen-abc123xyz",
        }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: " M apps/leaky-service/src/server.ts\n", stderr: "" };
  };
  const fixer = new OpenCodeFixer(["apps/leaky-service/src"], runner, {
    model: "openrouter/deepseek/deepseek-v4-pro",
    openRouterApiKey: "test-key",
    enrichCost: true,
    openRouterFetch: async (url) => {
      expect(url).toContain("gen-abc123xyz");
      return {
        ok: true,
        status: 200,
        text: async () => generationFixture,
        json: async () => JSON.parse(generationFixture) as unknown,
      };
    },
  });
  await fixer.fix({
    worktreeDir: "/tmp/wt",
    issueTitle: "bug",
    issueBody: "body",
    attempt: 1,
  });
  expect(fixer.takeCost()).toMatchObject({
    harness: "opencode",
    usd: 0.0042,
    costSource: "openrouter-generation",
    generationIds: ["gen-abc123xyz"],
  });
});

test("OpenCodeTestWriter mirrors command construction", async () => {
  const calls: string[][] = [];
  const runner: ProcessRunner = async (command): Promise<ProcessResult> => {
    calls.push(command);
    if (command[0] === "opencode") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          type: "text",
          part: { text: `${FIX_SUMMARY_MARKER}\nAdded regression.` },
          generation_id: "gen-tw-1",
        }),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: "?? apps/leaky-service/test/missing-customer.test.ts\n",
      stderr: "",
    };
  };
  const incident: Incident = {
    fingerprint: {
      hash: "abcdef0123456789",
      errName: "TypeError",
      topFrame: "handleCreate (apps/leaky-service/src/server.ts:10:1)",
      route: "POST /orders",
    },
    sampleEvents: [],
    count: 1,
    firstSeen: "2026-07-14T00:00:00.000Z",
    lastSeen: "2026-07-14T00:00:00.000Z",
  };
  const input: TestWriteInput = {
    worktreeDir: "/tmp/worktree",
    incident,
    repro: { reproduced: true, command: "curl", evidence: "500" },
    assertionSpec: {
      warranted: true,
      reason: "coverage",
      mustPin: [{ claim: "no 5xx", class: "status-class" }],
      mustNotPin: [],
      suggestedLocation: "apps/leaky-service/test/orders.test.ts",
    },
    attempt: 1,
  };
  const writer = new OpenCodeTestWriter(
    ["apps/leaky-service/test"],
    runner,
    "qwen/qwen3-coder",
    { enrichCost: false },
  );
  const output = await writer.write(input);
  expect(calls[0]?.slice(0, 7)).toEqual([
    "opencode",
    "run",
    "--auto",
    "--format",
    "json",
    "-m",
    "openrouter/qwen/qwen3-coder",
  ]);
  expect(output.description).toBe("Added regression.");
  expect(writer.takeGenerationIds()).toEqual(["gen-tw-1"]);
});

function extractSummary(text: string): string {
  const idx = text.lastIndexOf(FIX_SUMMARY_MARKER);
  if (idx === -1) return text;
  return text.slice(idx + FIX_SUMMARY_MARKER.length).trim();
}
