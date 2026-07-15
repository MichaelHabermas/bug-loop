import { expect, test } from "bun:test";
import {
  definePipelineConfig,
  FakeFixer,
  FakeTestWriter,
  mapWithConcurrency,
  PristineSuiteCache,
  runIncidentWorker,
  TraceRecorder,
  type IncidentTriage,
  type VerifyRunner,
  type WorktreeOperations,
} from "../src";

const config = definePipelineConfig({
  repo: "example/repo",
  labels: { pipeline: "test", mechanical: "mechanical", needsHuman: "human" },
  logPath: "logs/app.jsonl",
  baseUrl: "http://localhost:3000",
  cursorPath: ".cursor.json",
  fixScope: ["src"],
  testScope: ["test"],
  worktreeRoot: ".worktrees",
  maxFixAttempts: 1,
  fixer: "codex",
  regressionTests: "always",
  invariantWarnPrefixes: [],
  incidentConcurrency: 3,
});

function item(index: number): IncidentTriage {
  const hash = `incident-${index}`;
  return {
    incident: {
      fingerprint: {
        hash,
        errName: "TypeError",
        topFrame: `handler${index}`,
        route: `POST /${index}`,
      },
      sampleEvents: [{
        ts: "2026-07-14T00:00:00.000Z",
        level: "error",
        msg: "handler error",
        route: `POST /${index}`,
        err: { name: "TypeError", message: "failure" },
      }],
      count: 1,
      firstSeen: "2026-07-14T00:00:00.000Z",
      lastSeen: "2026-07-14T00:00:00.000Z",
    },
    repro: { reproduced: true, command: `curl /${index}`, evidence: "HTTP 500" },
    route: {
      kind: "mechanical",
      incidentClass: `class-${index}`,
      reason: "authorized",
    },
    ticket: { issueNumber: index + 1, url: `https://example.test/${index + 1}` },
  };
}

test("concurrency three uses isolated workers and returns stable immutable results", async () => {
  const worktrees: WorktreeOperations = {
    async create(input) {
      return {
        worktreeDir: `/tmp/${input.fingerprint8}`,
        branch: input.branch,
        baseCommit: "shared-base",
      };
    },
    async commit() {
      return { commit: "test-commit" };
    },
    async push() {},
    async remove() {},
    async reset() {},
    async verifyProvenance(input) {
      const testScope = input.scope[0] === "test";
      return {
        passes: true,
        changedPaths: [testScope ? "test/regression.test.ts" : "src/handler.ts"],
        outOfScopePaths: [],
        unexpectedCommits: [],
        detail: "trusted",
      };
    },
  };
  let fixerInstances = 0;
  let writerInstances = 0;
  let suiteCalls = 0;
  let activeFixers = 0;
  let maxActiveFixers = 0;
  const recorder = new TraceRecorder({
    pipeline: "agent-sdk",
    runId: "concurrency-run",
    outputPath: "/tmp/bug-loop-concurrency-trace.json",
    resolved: {
      pipeline: "agent-sdk",
      triage: {
        harness: "injected",
        requestedModel: null,
        effectiveModel: null,
        effort: null,
        source: "arg",
      },
      testWriter: {
        harness: "injected",
        requestedModel: null,
        effectiveModel: null,
        effort: null,
        source: "arg",
      },
      fixer: {
        harness: "injected",
        requestedModel: null,
        effectiveModel: null,
        effort: null,
        source: "arg",
      },
      regressionTests: "always",
      maxFixAttempts: 1,
      mode: { fix: true, live: false, fromStart: true },
    },
    workload: { benchmarkId: "test", seed: 1, caseCount: 3, codeRevision: "test" },
  });
  const suiteCache = new PristineSuiteCache();
  const inputs = [item(0), item(1), item(2)];
  const results = await mapWithConcurrency(inputs, 3, async (triage) => {
    let selectedTestRuns = 0;
    const verifier: VerifyRunner = {
      async verifyRepro() {
        return { passes: true, detail: "signature absent" };
      },
      async runTests() {
        suiteCalls += 1;
        return { passes: true, detail: "suite green" };
      },
      async runTestFiles() {
        selectedTestRuns += 1;
        return selectedTestRuns === 1
          ? { passes: false, detail: "red on base" }
          : { passes: true, detail: "green after fix" };
      },
      async runTypecheck() {
        return { passes: true, detail: "types green" };
      },
    };
    return runIncidentWorker({
      item: triage,
      config,
      recorder,
      worktrees,
      createFixer() {
        fixerInstances += 1;
        return new FakeFixer(async () => {
          activeFixers += 1;
          maxActiveFixers = Math.max(maxActiveFixers, activeFixers);
          await Bun.sleep(5);
          activeFixers -= 1;
          return { description: "fix", filesChanged: ["src/handler.ts"] };
        });
      },
      createTestWriter() {
        writerInstances += 1;
        return new FakeTestWriter(async () => ({
          description: "test",
          filesChanged: ["test/regression.test.ts"],
        }));
      },
      testWriterResolution: {
        harness: "injected",
        requestedModel: null,
        effectiveModel: null,
        effort: null,
        source: "arg",
      },
      createVerifier: () => verifier,
      readIssue: async () => null,
      pristineSuiteCache: suiteCache,
    });
  });

  expect(results.map((result) => result.item.incident.fingerprint.hash)).toEqual([
    "incident-0",
    "incident-1",
    "incident-2",
  ]);
  expect(fixerInstances).toBe(3);
  expect(writerInstances).toBe(3);
  expect(maxActiveFixers).toBe(3);
  expect(suiteCalls).toBe(4);
  expect(results.every((result) => Object.isFrozen(result))).toBe(true);
  expect(results.every((result) => Object.isFrozen(result.fixAttempts))).toBe(true);

  const trace = recorder.snapshot();
  const fixEvents = trace.events.filter((event) => event.stage === "fix");
  expect(fixEvents.map((event) => event.correlationId).sort()).toEqual([
    "concurrency-run:incident-0",
    "concurrency-run:incident-1",
    "concurrency-run:incident-2",
  ]);
  expect(fixEvents.map((event) => event.attemptId).sort()).toEqual([
    "concurrency-run:incident-0:fix:1",
    "concurrency-run:incident-1:fix:1",
    "concurrency-run:incident-2:fix:1",
  ]);
  expect(trace.agentCalls.filter((call) => call.stage === "fixer").every(
    (call) => call.attemptId !== undefined && call.correlationId !== undefined,
  )).toBe(true);
});
