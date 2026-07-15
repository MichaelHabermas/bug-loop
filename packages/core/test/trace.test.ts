import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { TraceRecorder, type RunTrace } from "../src";

const outputPath = join(import.meta.dir, ".tmp-trace", "trace.json");

const resolved = {
  pipeline: "langgraph" as const,
  triage: {
    harness: "heuristic",
    requestedModel: null,
    effectiveModel: null,
    effort: null,
    source: "default" as const,
  },
  testWriter: {
    harness: "grok",
    requestedModel: null,
    effectiveModel: null,
    effort: null,
    source: "default" as const,
  },
  fixer: {
    harness: "codex",
    requestedModel: "gpt-test",
    effectiveModel: "gpt-test",
    effort: null,
    source: "arg" as const,
  },
  regressionTests: "triage-decides" as const,
  maxFixAttempts: 2,
  mode: { fix: true, live: false, fromStart: true },
};

const workload = {
  benchmarkId: "leaky-service-seeded-v1",
  seed: 42,
  caseCount: 50,
  codeRevision: "abc123",
};

afterEach(() => {
  rmSync(join(import.meta.dir, ".tmp-trace"), { recursive: true, force: true });
});

test("TraceRecorder accumulates sequenced events and writes the RunTrace shape", async () => {
  const times = [
    "2026-07-14T12:00:00.000Z",
    "2026-07-14T12:00:00.010Z",
    "2026-07-14T12:00:00.025Z",
    "2026-07-14T12:00:00.030Z",
  ].map((value) => new Date(value));
  const recorder = new TraceRecorder({
    pipeline: "langgraph",
    outputPath,
    runId: "fixture-run",
    resolved,
    workload,
    now: () => times.shift() ?? new Date("2026-07-14T12:00:00.030Z"),
  });
  const event = recorder.start("detect", "deadbeef");
  event.finish("4 actionable", { actionable: 4 });
  const trace = await recorder.finish();
  expect(trace.events[0]).toMatchObject({
    seq: 1,
    stage: "detect",
    fingerprint: "deadbeef",
    durationMs: 15,
    outcome: "4 actionable",
  });
  const written = await Bun.file(outputPath).json() as RunTrace;
  expect(written.runId).toBe("fixture-run");
  expect(written.schemaVersion).toBe(2);
  expect(written.resolved.pipeline).toBe("langgraph");
  expect(written.label).toBeUndefined();
  expect(written.resolved.fixer.effectiveModel).toBe("gpt-test");
  expect(written.workload).toEqual(workload);
  expect(written.events).toHaveLength(1);
});

test("TraceRecorder includes optional label when provided", async () => {
  const recorder = new TraceRecorder({
    pipeline: "agent-sdk",
    outputPath,
    runId: "labeled-run",
    resolved: { ...resolved, pipeline: "agent-sdk" },
    workload,
    label: "grok-low",
    now: () => new Date("2026-07-14T12:00:00.000Z"),
  });
  recorder.start("ingest").finish("ok");
  const trace = await recorder.finish();
  expect(trace.label).toBe("grok-low");
  const written = await Bun.file(outputPath).json() as RunTrace;
  expect(written.label).toBe("grok-low");
});

test("TraceRecorder records one agent call with explicit usage status per attempt", async () => {
  const recorder = new TraceRecorder({
    pipeline: "langgraph",
    resolved,
    workload,
    outputPath,
    now: () => new Date("2026-07-14T12:00:00.000Z"),
  });
  recorder.start("fix", "abc").finish("attempt 1", undefined, {
    harness: "codex",
    model: "gpt-test",
    totalTokens: 123,
  });
  recorder.start("fix", "abc").finish("attempt 2");
  const trace = await recorder.finish();
  expect(trace.agentCalls).toHaveLength(2);
  expect(trace.agentCalls[0]).toMatchObject({
    stage: "fixer",
    fingerprint: "abc",
    harness: "codex",
    effectiveModel: "gpt-test",
    usage: { status: "tokens-only", totalTokens: 123 },
  });
  expect(trace.agentCalls[1]?.usage).toEqual({
    status: "unavailable",
    reason: "harness-did-not-report-usage",
  });
});
