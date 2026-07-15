import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { definePipelineConfig, TraceRecorder, type RunTrace } from "../src";

const outputPath = join(import.meta.dir, ".tmp-trace", "trace.json");

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
  const config = definePipelineConfig({
    repo: "example/repo",
    labels: { pipeline: "pipeline", mechanical: "mechanical", needsHuman: "human" },
    logPath: "logs/app.jsonl",
    baseUrl: "http://localhost:3000",
    cursorPath: ".cursor.json",
    fixScope: ["src"],
    testScope: ["test"],
    worktreeRoot: ".worktrees",
    maxFixAttempts: 2,
    fixer: "codex",
    invariantWarnPrefixes: [],
  });
  const recorder = new TraceRecorder({
    pipeline: "langgraph",
    config,
    outputPath,
    runId: "fixture-run",
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
  expect(written.pipeline).toBe("langgraph");
  expect(written.label).toBeUndefined();
  expect(written.config.fixScope).toEqual(["src"]);
  expect(written.config.testScope).toEqual(["test"]);
  expect(written.config.regressionTests).toBe("triage-decides");
  expect(written.events).toHaveLength(1);
});

test("TraceRecorder includes optional label when provided", async () => {
  const config = definePipelineConfig({
    repo: "example/repo",
    labels: { pipeline: "pipeline", mechanical: "mechanical", needsHuman: "human" },
    logPath: "logs/app.jsonl",
    baseUrl: "http://localhost:3000",
    cursorPath: ".cursor.json",
    fixScope: ["src"],
    testScope: ["test"],
    worktreeRoot: ".worktrees",
    maxFixAttempts: 2,
    fixer: "codex",
    invariantWarnPrefixes: [],
  });
  const recorder = new TraceRecorder({
    pipeline: "agent-sdk",
    config,
    outputPath,
    runId: "labeled-run",
    label: "grok-low",
    now: () => new Date("2026-07-14T12:00:00.000Z"),
  });
  recorder.start("ingest").finish("ok");
  const trace = await recorder.finish();
  expect(trace.label).toBe("grok-low");
  const written = await Bun.file(outputPath).json() as RunTrace;
  expect(written.label).toBe("grok-low");
});
