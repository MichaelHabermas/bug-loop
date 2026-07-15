import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInitialState, createTriageGraph } from "../src/graph";
import { routeAfterTicket } from "../src/graph";
import {
  FINGERPRINT_MARKER,
  FakeFixer,
  fingerprintEvent,
  OUTCOME_FIXED_LABEL,
  resolvePipelineRuntime,
  TraceRecorder,
  type LogEvent,
  type RunTrace,
} from "@bug-loop/core";
import {
  createLeakyServicePipelineConfig,
  leakyServiceReproStrategy,
  leakyServiceRoutingPolicy,
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
  });
  const tracePath = join(TMP, "langgraph-trace.json");
  const recorder = new TraceRecorder({
    pipeline: "langgraph",
    resolved,
    workload: { ...config.workload, codeRevision: "test-revision" },
    outputPath: tracePath,
    runId: "langgraph-test-run",
  });
  let issueListCalls = 0;
  let nextIssue = 1;
  const graph = createTriageGraph(config, {
    routingPolicy: leakyServiceRoutingPolicy,
    reproStrategy: leakyServiceReproStrategy,
    recorder,
    resolved,
    github: {
      async listOpenIssues() {
        issueListCalls += 1;
        return [];
      },
      async createIssue() {
        const number = nextIssue;
        nextIssue += 1;
        return { number, url: `https://example.test/issues/${number}` };
      },
      async readIssue() {
        return null;
      },
      async commentIssue() {},
      async addLabels() {},
      async replaceIssueLabel() {},
      async createPullRequest() {
        return { number: 1, url: "https://example.test/pull/1" };
      },
    },
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
  expect(issueListCalls).toBe(1);

  const rerun = await graph.invoke(
    createInitialState(config, {
      fromStart: false,
    }),
    { configurable: { thread_id: "smoke-test-rerun" } },
  );
  expect(rerun.summary?.eventsRead).toBe(0);
  expect(rerun.summary?.newIncidents).toBe(0);
  expect(issueListCalls).toBe(2);
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

function errorEvent(msg: string, name = "TypeError"): LogEvent {
  return {
    ts: "2026-07-15T12:00:00.000Z",
    level: "error",
    msg,
    route: "POST /orders",
    err: {
      name,
      message: name === "TypeError" ? "undefined customer" : "invalid since",
      stack: name === "TypeError"
        ? "TypeError: undefined customer\n    at handleCreate (src/server.ts:10:1)"
        : "RangeError: invalid since\n    at listOrders (src/server.ts:20:1)",
    },
  };
}

test("empty-pass commits nextCursorOffset (not EOF) so mid-listOpenIssues event is seen next run", async () => {
  const logPath = join(TMP, "empty-pass.jsonl");
  const cursorPath = join(TMP, "empty-pass-cursor.json");
  const first = errorEvent("already-ticketed");
  await Bun.write(logPath, `${JSON.stringify(first)}\n`);
  const ingestedEnd = Bun.file(logPath).size;
  const fp = fingerprintEvent(first).hash;
  const config = createLeakyServicePipelineConfig({
    cursorPath,
    baseUrl: "http://127.0.0.1:1",
    fixer: "codex",
    logPath,
  });

  let listCalls = 0;
  const graph = createTriageGraph(config, {
    routingPolicy: leakyServiceRoutingPolicy,
    reproStrategy: leakyServiceReproStrategy,
    github: {
      async listOpenIssues() {
        listCalls += 1;
        if (listCalls === 1) {
          const mid = errorEvent("arrived-during-list", "RangeError");
          await Bun.write(logPath, `${await Bun.file(logPath).text()}${JSON.stringify(mid)}\n`);
        }
        return [{
          number: 1,
          url: "https://example.test/issues/1",
          body: `${FINGERPRINT_MARKER(fp)}\n\nopen`,
         labels: [],
        }];
      },
      async createIssue() {
        throw new Error("should not file on empty-fresh pass");
      },
      async readIssue() {
        return null;
      },
      async commentIssue() {},
      async addLabels() {},
      async replaceIssueLabel() {},
      async createPullRequest() {
        throw new Error("unused");
      },
    },
  });

  const pass1 = await graph.invoke(
    createInitialState(config, {
      fromStart: false,
      watch: true,
      commitCursorOffset: ingestedEnd,
    }),
    { configurable: { thread_id: "empty-pass-1" } },
  );
  expect(pass1.summary?.eventsRead).toBe(1);
  expect(pass1.summary?.newIncidents).toBe(0);
  const cursorAfter = await Bun.file(cursorPath).json() as { offset: number };
  expect(cursorAfter.offset).toBe(ingestedEnd);
  expect(cursorAfter.offset).toBeLessThan(Bun.file(logPath).size);

  let filed = 0;
  const graph2 = createTriageGraph(config, {
    routingPolicy: {
      authorizedClasses: [],
      evaluate: () => ({ kind: "deny", reason: "ticket only" }),
    },
    reproStrategy: leakyServiceReproStrategy,
    github: {
      async listOpenIssues() {
        return [{
          number: 1,
          url: "https://example.test/issues/1",
          body: `${FINGERPRINT_MARKER(fp)}\n\nopen`,
         labels: [],
        }];
      },
      async createIssue() {
        filed += 1;
        return { number: 2, url: "https://example.test/issues/2" };
      },
      async readIssue() {
        return null;
      },
      async commentIssue() {},
      async addLabels() {},
      async replaceIssueLabel() {},
      async createPullRequest() {
        throw new Error("unused");
      },
    },
  });
  const pass2 = await graph2.invoke(
    createInitialState(config, {
      fromStart: false,
      watch: true,
      commitCursorOffset: Bun.file(logPath).size,
    }),
    { configurable: { thread_id: "empty-pass-2" } },
  );
  expect(pass2.summary?.eventsRead).toBe(1);
  expect(pass2.summary?.newIncidents).toBe(1);
  expect(filed).toBe(1);
});

test("event after debounce-close is ingested exactly once across two passes", async () => {
  const logPath = join(TMP, "debounce-boundary.jsonl");
  const cursorPath = join(TMP, "debounce-boundary-cursor.json");
  const inBatch = errorEvent("in-batch");
  const afterBatch = errorEvent("after-batch", "RangeError");
  await Bun.write(logPath, `${JSON.stringify(inBatch)}\n`);
  const batchEnd = Bun.file(logPath).size;
  await Bun.write(logPath, `${await Bun.file(logPath).text()}${JSON.stringify(afterBatch)}\n`);

  const config = createLeakyServicePipelineConfig({
    cursorPath,
    baseUrl: "http://127.0.0.1:1",
    fixer: "codex",
    logPath,
  });
  const filed: string[] = [];
  const github = {
    async listOpenIssues() {
      return [];
    },
    async createIssue(input: { title: string }) {
      filed.push(input.title);
      return { number: filed.length, url: `https://example.test/issues/${filed.length}` };
    },
    async readIssue() {
      return null;
    },
    async commentIssue() {},
    async addLabels() {},
    async replaceIssueLabel() {},
    async createPullRequest() {
      throw new Error("unused");
    },
  };
  const routingPolicy = {
    authorizedClasses: [] as string[],
    evaluate: () => ({ kind: "deny" as const, reason: "ticket only" }),
  };

  const graph = createTriageGraph(config, {
    routingPolicy,
    reproStrategy: leakyServiceReproStrategy,
    github,
  });
  const pass1 = await graph.invoke(
    createInitialState(config, {
      fromStart: false,
      watch: true,
      commitCursorOffset: batchEnd,
    }),
    { configurable: { thread_id: "boundary-1" } },
  );
  expect(pass1.summary?.eventsRead).toBe(1);
  expect(pass1.summary?.newIncidents).toBe(1);
  const cursor1 = await Bun.file(cursorPath).json() as { offset: number };
  expect(cursor1.offset).toBe(batchEnd);

  const pass2 = await graph.invoke(
    createInitialState(config, {
      fromStart: false,
      watch: true,
      commitCursorOffset: Bun.file(logPath).size,
    }),
    { configurable: { thread_id: "boundary-2" } },
  );
  expect(pass2.summary?.eventsRead).toBe(1);
  expect(pass2.summary?.newIncidents).toBe(1);
  expect(filed).toHaveLength(2);
});

test("restarted session with outcome label does not re-enter fix workers", async () => {
  const logPath = join(TMP, "restart-marker.jsonl");
  const cursorPath = join(TMP, "restart-marker-cursor.json");
  const event = errorEvent("handler error");
  await Bun.write(logPath, `${JSON.stringify(event)}\n`);
  const fp = fingerprintEvent(event).hash;
  const config = createLeakyServicePipelineConfig({
    cursorPath,
    baseUrl: "http://127.0.0.1:1",
    fixer: "codex",
    logPath,
  });
  const fixCalls: number[] = [];
  const sessionFixFingerprints = new Set<string>();
  const openIssues = [{
    number: 1,
    url: "https://example.test/issues/1",
    body: FINGERPRINT_MARKER(fp),
    labels: ["bug-loop", "auto-fix-candidate", OUTCOME_FIXED_LABEL],
  }];

  const graph = createTriageGraph(config, {
    sessionFixFingerprints,
    routingPolicy: {
      authorizedClasses: ["leaky-service.missing-customer"],
      evaluate: () => ({
        kind: "authorized" as const,
        incidentClass: "leaky-service.missing-customer",
        reason: "mapped",
      }),
    },
    reproStrategy: {
      derive() {
        return {
          command: "curl",
          async reproduce() {
            return { reproduced: true, evidence: "HTTP 500" };
          },
          async verify() {
            return { passes: true, detail: "ok" };
          },
        };
      },
    },
    createFixer: () => new FakeFixer(async () => {
      fixCalls.push(1);
      return { description: "patch", filesChanged: ["apps/leaky-service/src/server.ts"] };
    }),
    github: {
      async listOpenIssues() {
        return openIssues.map((issue) => ({ ...issue, labels: [...issue.labels] }));
      },
      async createIssue() {
        throw new Error("should not create");
      },
      async readIssue(number) {
        const issue = openIssues.find((item) => item.number === number);
        return issue ? { title: "issue", body: issue.body } : null;
      },
      async commentIssue() {},
      async addLabels() {},
      async replaceIssueLabel() {},
      async createPullRequest() {
        throw new Error("unused");
      },
    },
  });

  const result = await graph.invoke(
    createInitialState(config, {
      fromStart: true,
      fix: true,
      watch: true,
    }),
    { configurable: { thread_id: "restart-marker" } },
  );
  expect(result.summary?.newIncidents).toBe(0);
  expect(fixCalls).toHaveLength(0);
  expect(sessionFixFingerprints.size).toBe(0);
});

test("one-shot --fix: outcome label blocks re-entry even with pending self-generated repro events", async () => {
  const logPath = join(TMP, "oneshot-outcome.jsonl");
  const cursorPath = join(TMP, "oneshot-outcome-cursor.json");
  const event = errorEvent("handler error");
  const reproNoise = errorEvent("handler error");
  await Bun.write(
    logPath,
    `${JSON.stringify(event)}\n${JSON.stringify(reproNoise)}\n`,
  );
  const fp = fingerprintEvent(event).hash;
  const config = createLeakyServicePipelineConfig({
    cursorPath,
    baseUrl: "http://127.0.0.1:1",
    fixer: "codex",
    logPath,
  });
  const fixCalls: number[] = [];
  const openIssues = [{
    number: 1,
    url: "https://example.test/issues/1",
    body: FINGERPRINT_MARKER(fp),
    labels: ["bug-loop", "auto-fix-candidate", OUTCOME_FIXED_LABEL],
  }];

  const graph = createTriageGraph(config, {
    routingPolicy: {
      authorizedClasses: ["leaky-service.missing-customer"],
      evaluate: () => ({
        kind: "authorized" as const,
        incidentClass: "leaky-service.missing-customer",
        reason: "mapped",
      }),
    },
    reproStrategy: {
      derive() {
        return {
          command: "curl",
          async reproduce() {
            return { reproduced: true, evidence: "HTTP 500" };
          },
          async verify() {
            return { passes: true, detail: "ok" };
          },
        };
      },
    },
    createFixer: () => new FakeFixer(async () => {
      fixCalls.push(1);
      return { description: "patch", filesChanged: ["apps/leaky-service/src/server.ts"] };
    }),
    github: {
      async listOpenIssues() {
        return openIssues.map((issue) => ({ ...issue, labels: [...issue.labels] }));
      },
      async createIssue() {
        throw new Error("should not create issue for resolved ticket");
      },
      async readIssue(number) {
        const issue = openIssues.find((item) => item.number === number);
        return issue ? { title: "issue", body: issue.body } : null;
      },
      async commentIssue() {},
      async addLabels() {},
      async replaceIssueLabel() {},
      async createPullRequest() {
        throw new Error("should not open PR");
      },
    },
  });

  const result = await graph.invoke(
    createInitialState(config, {
      fromStart: true,
      fix: true,
      watch: false,
    }),
    { configurable: { thread_id: "oneshot-outcome" } },
  );
  expect(result.summary?.newIncidents).toBe(0);
  expect(result.summary?.incidents).toBe(1);
  expect(fixCalls).toHaveLength(0);
});

test("outcome-label guard reuses dedupe snapshot: second listOpenIssues is never called", async () => {
  // Regression: a post-ticket second listOpenIssues() that fails transiently
  // used to reject after the cursor was already committed, stranding the
  // incident. Guard must reuse the dedupe-stage snapshot (one fetch per run).
  const logPath = join(TMP, "no-second-list.jsonl");
  const cursorPath = join(TMP, "no-second-list-cursor.json");
  const event = errorEvent("handler error");
  await Bun.write(logPath, `${JSON.stringify(event)}\n`);
  const fp = fingerprintEvent(event).hash;
  const config = createLeakyServicePipelineConfig({
    cursorPath,
    baseUrl: "http://127.0.0.1:1",
    fixer: "codex",
    logPath,
  });
  let listCalls = 0;
  const fixCalls: number[] = [];
  const openIssues = [{
    number: 1,
    url: "https://example.test/issues/1",
    body: FINGERPRINT_MARKER(fp),
    labels: ["bug-loop", "auto-fix-candidate", OUTCOME_FIXED_LABEL],
  }];

  const graph = createTriageGraph(config, {
    routingPolicy: {
      authorizedClasses: ["leaky-service.missing-customer"],
      evaluate: () => ({
        kind: "authorized" as const,
        incidentClass: "leaky-service.missing-customer",
        reason: "mapped",
      }),
    },
    reproStrategy: {
      derive() {
        return {
          command: "curl",
          async reproduce() {
            return { reproduced: true, evidence: "HTTP 500" };
          },
          async verify() {
            return { passes: true, detail: "ok" };
          },
        };
      },
    },
    createFixer: () => new FakeFixer(async () => {
      fixCalls.push(1);
      return { description: "patch", filesChanged: ["apps/leaky-service/src/server.ts"] };
    }),
    github: {
      async listOpenIssues() {
        listCalls += 1;
        if (listCalls > 1) {
          throw new Error("transient listOpenIssues failure (must not be called twice)");
        }
        return openIssues.map((issue) => ({ ...issue, labels: [...issue.labels] }));
      },
      async createIssue() {
        throw new Error("should not create");
      },
      async readIssue(number) {
        const issue = openIssues.find((item) => item.number === number);
        return issue ? { title: "issue", body: issue.body } : null;
      },
      async commentIssue() {},
      async addLabels() {},
      async replaceIssueLabel() {},
      async createPullRequest() {
        throw new Error("should not open PR");
      },
    },
  });

  const result = await graph.invoke(
    createInitialState(config, {
      fromStart: true,
      fix: true,
      watch: false,
    }),
    { configurable: { thread_id: "no-second-list" } },
  );
  expect(listCalls).toBe(1);
  expect(result.summary?.newIncidents).toBe(0);
  expect(fixCalls).toHaveLength(0);
});

test("compiled graph exposes the fix cycle and only routes fix-enabled mechanical work into it", () => {
  const config = pipelineConfig();
  const graph = createTriageGraph(config, {
    routingPolicy: leakyServiceRoutingPolicy,
  });
  const edges = graph.getGraph().edges.map((edge) => `${edge.source}->${edge.target}`);
  expect(edges).toContain("ticket->workers");
  expect(edges).toContain("workers->__end__");

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
    route: {
      kind: "mechanical" as const,
      incidentClass: "orders.missing-customer",
      reason: "reproduced",
    },
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
  }), [mechanical])).toBe("workers");
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
