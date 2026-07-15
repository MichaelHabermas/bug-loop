import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInitialState, createTriageGraph } from "../src/graph";
import { routeAfterTicket } from "../src/graph";
import { HeuristicClassifier } from "../src/classifier";
import { resolvePipelineRuntime, TraceRecorder, type RunTrace } from "@bug-loop/core";
import {
  createLeakyServicePipelineConfig,
  leakyServiceReproStrategy,
} from "@bug-loop/leaky-service/bug-loop";

const TMP = join(import.meta.dir, ".tmp-graph");
const FIXTURE = join(import.meta.dir, "fixtures", "all-bugs.jsonl");
const originalDryRun = process.env["DRY_RUN"];

function pipelineConfig(cursorPath = join(TMP, "cursor.json")) {
  return createLeakyServicePipelineConfig({
    cursorPath,
    baseUrl: "http://127.0.0.1:1",
    fixer: "codex",
    logPath: FIXTURE,
  });
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  process.env["DRY_RUN"] = "1";
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  if (originalDryRun === undefined) delete process.env["DRY_RUN"];
  else process.env["DRY_RUN"] = originalDryRun;
});

test("graph processes all four signatures and tolerates an unreachable service", async () => {
  const config = pipelineConfig();
  const resolved = resolvePipelineRuntime({
    pipeline: "langgraph",
    config,
    mode: { fromStart: true, fix: false, live: false },
    overrides: { triage: true },
  });
  const tracePath = join(TMP, "langgraph-trace.json");
  const recorder = new TraceRecorder({
    pipeline: "langgraph",
    resolved,
    workload: { ...config.workload, codeRevision: "test-revision" },
    outputPath: tracePath,
    runId: "langgraph-test-run",
  });
  const graph = createTriageGraph(config, {
    classifier: new HeuristicClassifier(config.invariantWarnPrefixes),
    reproStrategy: leakyServiceReproStrategy,
    recorder,
    resolved,
  });
  const result = await graph.invoke(
    createInitialState(config, {
      fromStart: true,
    }),
    { configurable: { thread_id: "smoke-test" } },
  );

  expect(result.summary).toEqual({
    eventsRead: 4,
    actionable: 4,
    incidents: 4,
    newIncidents: 4,
    reproduced: 0,
    issuesFiled: 4,
  });
  expect(result.triage).toHaveLength(4);
  expect(result.triage.every((item) => item.ticket !== undefined)).toBe(true);

  const rerun = await graph.invoke(
    createInitialState(config, {
      fromStart: false,
    }),
    { configurable: { thread_id: "smoke-test-rerun" } },
  );
  expect(rerun.summary?.eventsRead).toBe(0);
  expect(rerun.summary?.newIncidents).toBe(0);
  await recorder.finish();
  const trace = await Bun.file(tracePath).json() as RunTrace;
  expect(trace.events.slice(0, 6).map((event) => event.stage)).toEqual([
    "ingest",
    "detect",
    "dedupe",
    "reproduce",
    "route",
    "ticket",
  ]);
});

test("compiled graph exposes the fix cycle and only routes fix-enabled mechanical work into it", () => {
  const config = pipelineConfig();
  const graph = createTriageGraph(config, {
    classifier: new HeuristicClassifier(config.invariantWarnPrefixes),
  });
  const edges = graph.getGraph().edges.map((edge) => `${edge.source}->${edge.target}`);
  expect(edges).toContain("ticket->testgen");
  expect(edges).toContain("testgen->fix");
  expect(edges).toContain("fix->verify");
  expect(edges).toContain("verify->fix");
  expect(edges).toContain("verify->pr");

  const active = {
    fingerprint: {
      hash: "abcdef0123456789",
      errName: "TypeError",
      topFrame: "at handleCreate (apps/leaky-service/src/server.ts)",
      route: "POST /orders",
    },
    sampleEvents: [],
    count: 1,
    firstSeen: "2026-07-13T12:00:00.000Z",
    lastSeen: "2026-07-13T12:00:00.000Z",
  };
  const mechanical = {
    incident: active,
    route: { kind: "mechanical" as const, reason: "reproduced" },
    ticket: { issueNumber: 1, url: "https://example.test/issues/1" },
  };
  const needsHuman = {
    ...mechanical,
    route: { kind: "needs-human" as const, reason: "ambiguous" },
  };
  expect(routeAfterTicket(createInitialState(config, {
    fromStart: true,
    fix: true,
    live: false,
  }), [mechanical])).toBe("testgen");
  expect(routeAfterTicket(createInitialState(config, {
    fromStart: true,
    fix: true,
    live: false,
  }), [needsHuman])).toBe("end");
  expect(routeAfterTicket(createInitialState(config, {
    fromStart: true,
    fix: false,
    live: false,
  }), [mechanical])).toBe("end");
});
