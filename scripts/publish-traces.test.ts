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
import type { TraceEvent } from "@bug-loop/core/trace";

const tmpRoot = join(import.meta.dir, ".tmp-publish-traces");

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

interface LegacyTrace {
  runId: string;
  startedAt: string;
  finishedAt: string;
  pipeline: string;
  label?: string;
  config: Record<string, unknown>;
  events: TraceEvent[];
}

function minimalTrace(overrides: Partial<LegacyTrace> = {}): LegacyTrace {
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

function minimalV2Trace(): Record<string, unknown> {
  const agent = {
    harness: "grok",
    requestedModel: null,
    effectiveModel: null,
    effort: "low",
    source: "env",
  };
  return {
    schemaVersion: 2,
    runId: "run-v2",
    startedAt: "2026-07-14T12:00:00.000Z",
    finishedAt: "2026-07-14T12:00:01.000Z",
    label: "v2",
    resolved: {
      pipeline: "langgraph",
      triage: { ...agent, harness: "heuristic", effort: null, source: "default" },
      testWriter: { ...agent },
      fixer: { ...agent },
      regressionTests: "triage-decides",
      maxFixAttempts: 2,
      incidentConcurrency: 3,
      mode: { fix: true, live: false, fromStart: true },
    },
    workload: {
      benchmarkId: "leaky-service-seeded-v1",
      seed: 42,
      caseCount: 50,
      codeRevision: "abc123",
    },
    events: minimalTrace().events,
    agentCalls: [{
      seq: 1,
      stage: "fixer",
      correlationId: "run-v2:fingerprint",
      attemptId: "run-v2:fingerprint:fix:1",
      harness: "grok",
      effectiveModel: null,
      effort: "low",
      durationMs: 25,
      outcome: "success",
      usage: { status: "tokens-only", totalTokens: 10 },
    }],
  };
}

describe("parseRunTrace", () => {
  test("accepts a valid RunTrace", () => {
    const trace = parseRunTrace(minimalTrace({ label: "baseline" }));
    expect(trace.runId).toBe("run-1");
    expect(trace.schemaVersion).toBe(1);
    expect(trace.resolved.pipeline).toBe("agent-sdk");
    expect(trace.workload.codeRevision).toBe("unknown-v1");
    expect(trace.label).toBe("baseline");
    expect(trace.events).toHaveLength(1);
  });

  test("rejects non-object roots", () => {
    expect(() => parseRunTrace(null)).toThrow("trace root must be an object");
    expect(() => parseRunTrace("nope")).toThrow("trace root must be an object");
  });

  test("rejects invalid pipeline", () => {
    expect(() => parseRunTrace(minimalTrace({ pipeline: "other" }))).toThrow(
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

  test("validates and accepts schema v2 traces", () => {
    const trace = parseRunTrace(minimalV2Trace());
    expect(trace.schemaVersion).toBe(2);
    expect(trace.workload.benchmarkId).toBe("leaky-service-seeded-v1");
    expect(trace.agentCalls).toHaveLength(1);
    expect(trace.agentCalls[0]).toMatchObject({
      correlationId: "run-v2:fingerprint",
      attemptId: "run-v2:fingerprint:fix:1",
    });
  });

  test("retains watchSessionId, watchPass, and mode.watch from v2 traces", () => {
    const raw = minimalV2Trace();
    const resolved = raw["resolved"] as Record<string, unknown>;
    const mode = resolved["mode"] as Record<string, unknown>;
    resolved["mode"] = { ...mode, watch: true };
    raw["workload"] = {
      ...(raw["workload"] as Record<string, unknown>),
      watchSessionId: "session-abc",
      watchPass: 3,
    };
    const trace = parseRunTrace(raw);
    expect(trace.schemaVersion).toBe(2);
    if (trace.schemaVersion !== 2) throw new Error("expected v2");
    expect(trace.workload.watchSessionId).toBe("session-abc");
    expect(trace.workload.watchPass).toBe(3);
    expect(trace.resolved.mode.watch).toBe(true);

    // Safe projection used by publish must not drop watch fields.
    const source = buildRunsDataSource([{
      label: "watch-pass",
      workloadKey: "k",
      resolvedConfigKey: "r",
      trace,
    }]);
    expect(source).toContain("session-abc");
    expect(source).toContain('"watchPass": 3');
    expect(source).toContain('"watch": true');
  });

  test("rejects invalid watchPass / mode.watch", () => {
    const badPass = minimalV2Trace();
    badPass["workload"] = {
      ...(badPass["workload"] as Record<string, unknown>),
      watchPass: 0,
    };
    expect(() => parseRunTrace(badPass)).toThrow(/watchPass must be a positive integer/);

    const badWatch = minimalV2Trace();
    const resolved = badWatch["resolved"] as Record<string, unknown>;
    const mode = resolved["mode"] as Record<string, unknown>;
    resolved["mode"] = { ...mode, watch: "yes" };
    expect(() => parseRunTrace(badWatch)).toThrow(/mode.watch must be boolean/);
  });

  test("rejects malformed v2 usage and fallback metadata", () => {
    const missingTokens = minimalV2Trace();
    const calls = missingTokens["agentCalls"] as Array<Record<string, unknown>>;
    calls[0] = { ...calls[0], usage: { status: "tokens-only" } };
    expect(() => parseRunTrace(missingTokens)).toThrow(
      "tokens-only usage must include at least one token count",
    );

    const malformedFallback = minimalV2Trace();
    const fallbackCalls = malformedFallback["agentCalls"] as Array<Record<string, unknown>>;
    fallbackCalls[0] = { ...fallbackCalls[0], fallback: { type: "heuristic" } };
    expect(() => parseRunTrace(malformedFallback)).toThrow(
      "fallback must include string type and reason",
    );
  });
});

describe("labelFromFilename / labelForTrace", () => {
  test("strips sweep- prefix and .json extension", () => {
    expect(labelFromFilename("traces/sweep-baseline.json")).toBe("baseline");
    expect(labelFromFilename("sweep-grok-low.json")).toBe("grok-low");
    expect(labelFromFilename("/abs/path/example-run.json")).toBe("example-run");
  });

  test("prefers non-empty trace.label over filename", () => {
    const labeled = parseRunTrace(minimalTrace({ label: "from-trace" }));
    expect(labelForTrace(labeled, "traces/sweep-baseline.json")).toBe("from-trace");
  });

  test("falls back to filename when label is missing or blank", () => {
    expect(labelForTrace(parseRunTrace(minimalTrace()), "traces/sweep-codex-luna.json")).toBe("codex-luna");
    expect(labelForTrace(parseRunTrace(minimalTrace({ label: "   " })), "traces/sweep-haiku-triage.json")).toBe(
      "haiku-triage",
    );
  });
});

describe("buildRunsDataSource / publishTraces", () => {
  test("emits window.BUGLOOP_RUNS, PRICES, and PRICES_META assignments", () => {
    const trace = parseRunTrace(minimalTrace());
    const source = buildRunsDataSource([{
      label: "baseline",
      workloadKey: "unknown-v1|null|null|unknown-v1",
      resolvedConfigKey: "legacy",
      trace,
    }]);
    expect(source).toContain("window.BUGLOOP_RUNS = ");
    expect(source).toContain("window.BUGLOOP_PRICES = ");
    expect(source).toContain("window.BUGLOOP_PRICES_META = ");
    expect(source).toContain('"asOf": "2026-07-14"');
    expect(source).toContain("gpt-5.6-luna");
    expect(source).toContain("claude-haiku-4-5-20251001");
  });

  test("safe projection strips absolute paths, prompts, argv, and raw usage", () => {
    const trace = parseRunTrace(minimalTrace({
      label: "C:\\Users\\michael\\private-run",
      config: {
        logPath: "/Users/michael/secret/log.jsonl",
        maxFixAttempts: 2,
        regressionTests: "triage-decides",
      },
      events: [{
        seq: 1,
        stage: "fix",
        startedAt: "2026-07-14T12:00:00.000Z",
        durationMs: 1,
        outcome: "edited /Users/michael/repo/src/app.ts",
        detail: {
          prompt: "private prompt",
          userPrompt: "second private prompt",
          argv: ["--secret"],
          rawArgv: ["--other-secret"],
          file: "/Users/michael/repo/src/app.ts",
        },
        cost: {
          harness: "codex",
          inputTokens: 1,
          raw: "cwd=/Users/michael/repo",
        },
      }],
    }));
    const source = buildRunsDataSource([{
      label: "safe",
      workloadKey: "legacy",
      resolvedConfigKey: "legacy",
      trace,
    }]);
    expect(source).not.toContain("/Users/");
    expect(source).not.toContain("C:\\\\Users\\\\");
    expect(source).not.toContain("private prompt");
    expect(source).not.toContain("second private prompt");
    expect(source).not.toContain("--secret");
    expect(source).not.toContain("--other-secret");
    expect(source).not.toContain('"raw"');
    expect(source).toContain("[local-path-redacted]");
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
