import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildRunsDataSource,
  labelForTrace,
  labelFromFilename,
  parseRunTrace,
  publishTraces,
} from "./publish-traces";
import type { RunTrace } from "@bug-loop/core/trace";

const tmpRoot = join(import.meta.dir, ".tmp-publish-traces");

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function minimalTrace(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    runId: "run-1",
    startedAt: "2026-07-14T12:00:00.000Z",
    finishedAt: "2026-07-14T12:00:01.000Z",
    pipeline: "agent-sdk",
    config: {
      repo: "example/repo",
      labels: { pipeline: "p", mechanical: "m", needsHuman: "h" },
      logPath: "logs/app.jsonl",
      baseUrl: "http://localhost:3000",
      cursorPath: ".cursor.json",
      fixScope: ["src"],
      testScope: ["test"],
      branchPrefix: "bugloop/fix-",
      worktreeRoot: ".worktrees",
      maxFixAttempts: 2,
      fixer: "grok",
      regressionTests: "triage-decides",
      invariantWarnPrefixes: [],
    },
    events: [
      {
        seq: 1,
        stage: "ingest",
        startedAt: "2026-07-14T12:00:00.000Z",
        durationMs: 10,
        outcome: "0 events",
      },
    ],
    ...overrides,
  };
}

describe("parseRunTrace", () => {
  test("accepts a valid RunTrace", () => {
    const trace = parseRunTrace(minimalTrace({ label: "baseline" }));
    expect(trace.runId).toBe("run-1");
    expect(trace.pipeline).toBe("agent-sdk");
    expect(trace.label).toBe("baseline");
    expect(trace.events).toHaveLength(1);
  });

  test("rejects non-object roots", () => {
    expect(() => parseRunTrace(null)).toThrow("trace root must be an object");
    expect(() => parseRunTrace("nope")).toThrow("trace root must be an object");
  });

  test("rejects invalid pipeline", () => {
    expect(() => parseRunTrace(minimalTrace({ pipeline: "other" as RunTrace["pipeline"] }))).toThrow(
      "pipeline must be langgraph or agent-sdk",
    );
  });

  test("rejects missing events", () => {
    const bad = { ...minimalTrace(), events: undefined };
    expect(() => parseRunTrace(bad)).toThrow("events must be an array");
  });

  test("rejects invalid cost harness", () => {
    const bad = minimalTrace({
      events: [
        {
          seq: 1,
          stage: "fix",
          startedAt: "2026-07-14T12:00:00.000Z",
          durationMs: 1,
          outcome: "attempt 1",
          cost: {
            harness: "unknown" as "codex",
            inputTokens: 1,
          },
        },
      ],
    });
    expect(() => parseRunTrace(bad)).toThrow("events[0].cost.harness is invalid");
  });
});

describe("labelFromFilename / labelForTrace", () => {
  test("strips sweep- prefix and .json extension", () => {
    expect(labelFromFilename("traces/sweep-baseline.json")).toBe("baseline");
    expect(labelFromFilename("sweep-grok-low.json")).toBe("grok-low");
    expect(labelFromFilename("/abs/path/example-run.json")).toBe("example-run");
  });

  test("prefers non-empty trace.label over filename", () => {
    const labeled = minimalTrace({ label: "from-trace" });
    expect(labelForTrace(labeled, "traces/sweep-baseline.json")).toBe("from-trace");
  });

  test("falls back to filename when label is missing or blank", () => {
    expect(labelForTrace(minimalTrace(), "traces/sweep-codex-luna.json")).toBe("codex-luna");
    expect(labelForTrace(minimalTrace({ label: "   " }), "traces/sweep-haiku-triage.json")).toBe(
      "haiku-triage",
    );
  });
});

describe("buildRunsDataSource / publishTraces", () => {
  test("emits window.BUGLOOP_RUNS, PRICES, and PRICES_META assignments", () => {
    const source = buildRunsDataSource([{ label: "baseline", trace: minimalTrace() }]);
    expect(source).toContain("window.BUGLOOP_RUNS = ");
    expect(source).toContain("window.BUGLOOP_PRICES = ");
    expect(source).toContain("window.BUGLOOP_PRICES_META = ");
    expect(source).toContain('"asOf": "2026-07-14"');
    expect(source).toContain("gpt-5.6-luna");
    expect(source).toContain("claude-haiku-4-5-20251001");
  });

  test("publishTraces writes valid JS from labeled and unlabeled files", async () => {
    await mkdir(tmpRoot, { recursive: true });
    const labeledPath = join(tmpRoot, "sweep-with-label.json");
    const unlabeledPath = join(tmpRoot, "sweep-from-name.json");
    const outPath = join(tmpRoot, "runs-data.js");

    await writeFile(
      labeledPath,
      `${JSON.stringify(minimalTrace({ label: "explicit-label", runId: "a" }), null, 2)}\n`,
    );
    await writeFile(
      unlabeledPath,
      `${JSON.stringify(minimalTrace({ runId: "b" }), null, 2)}\n`,
    );

    const { runs } = await publishTraces([labeledPath, unlabeledPath], outPath);
    expect(runs.map((run) => run.label)).toEqual(["explicit-label", "from-name"]);

    const written = await Bun.file(outPath).text();
    // Evaluate in a sandbox-like object to confirm it is valid JS.
    const sandbox: {
      BUGLOOP_RUNS?: Array<{ label: string }>;
      BUGLOOP_PRICES?: Record<string, { inPerM: number; outPerM: number }>;
      BUGLOOP_PRICES_META?: { asOf: string };
    } = {};
    const fn = new Function(
      "window",
      written.replaceAll("window.", "window."),
    );
    fn(sandbox);
    expect(sandbox.BUGLOOP_RUNS).toHaveLength(2);
    expect(sandbox.BUGLOOP_RUNS?.[0]?.label).toBe("explicit-label");
    expect(sandbox.BUGLOOP_RUNS?.[1]?.label).toBe("from-name");
    expect(sandbox.BUGLOOP_PRICES?.["gpt-5.6-luna"]?.inPerM).toBe(1);
    expect(sandbox.BUGLOOP_PRICES_META?.asOf).toBe("2026-07-14");
  });
});
