import { describe, expect, test } from "bun:test";
import {
  FakeTestWriter,
  assessRegressionTestEligibility,
  authorizeRegressionTestSpec,
  definePipelineConfig,
  formatRegressionTestIntent,
  heuristicRegressionTestSpec,
  runRegressionTestStage,
  shouldGenerateRegressionTest,
  verifyWithRunner,
  type CheckResult,
  type Incident,
  type RegressionTestRecord,
  type RouteDecision,
  type TriageState,
  type VerifyRunner,
  type WorktreeOperations,
} from "../src";

const incident: Incident = {
  fingerprint: {
    hash: "abcdef0123456789",
    errName: "TypeError",
    topFrame: "handleCreate (services/api/src/handler.ts:10:1)",
    route: "POST /orders",
  },
  sampleEvents: [{
    ts: "2026-07-14T00:00:00.000Z",
    level: "error",
    msg: "handler error",
    route: "POST /orders",
    status: 500,
    err: { name: "TypeError", message: "customer missing" },
  }],
  count: 1,
  firstSeen: "2026-07-14T00:00:00.000Z",
  lastSeen: "2026-07-14T00:00:00.000Z",
};

const config = definePipelineConfig({
  repo: "example/repo",
  labels: { pipeline: "pipeline", mechanical: "mechanical", needsHuman: "human" },
  logPath: "logs/app.jsonl",
  baseUrl: "http://localhost:3000",
  cursorPath: ".cursor.json",
  fixScope: ["services/api/src"],
  testScope: ["services/api/test"],
  worktreeRoot: ".worktrees",
  maxFixAttempts: 2,
  fixer: "codex",
  invariantWarnPrefixes: [],
});

const repro = { reproduced: true, command: "curl example.test", evidence: "HTTP 500" };
const mechanical: RouteDecision = {
  kind: "mechanical",
  reason: "deterministic",
  regressionTest: heuristicRegressionTestSpec(
    { kind: "mechanical", reason: "deterministic" },
    incident,
    repro,
    "services/api/test",
  ),
};

function worktrees(calls: string[]): WorktreeOperations {
  return {
    async create(input) {
      return { worktreeDir: "/tmp/worktree", branch: input.branch, baseCommit: "base" };
    },
    async commit(input) {
      calls.push(`commit:${input.scope ?? "fix"}`);
      return { commit: "pipeline-test" };
    },
    async push() {},
    async remove() {},
    async reset() {
      calls.push("reset");
    },
    async verifyProvenance() {
      return {
        passes: true,
        changedPaths: ["services/api/test/orders.test.ts"],
        outOfScopePaths: [],
        unexpectedCommits: [],
        detail: "trusted working tree",
      };
    },
  };
}

function runner(results: CheckResult[]): VerifyRunner {
  return {
    async verifyRepro() {
      return { passes: true, detail: "signature absent" };
    },
    async runTests() {
      return results.shift() ?? { passes: true, detail: "suite green" };
    },
    async runTestFiles() {
      return results.shift() ?? { passes: true, detail: "test green" };
    },
    async runTypecheck() {
      return { passes: true, detail: "types green" };
    },
  };
}

describe("regression-test eligibility and policy", () => {
  test("requires deterministic repro, mechanical routing, and a green pre-fix suite", () => {
    expect(assessRegressionTestEligibility({
      repro: { ...repro, reproduced: false },
      route: mechanical,
      baseline: { passes: true, detail: "suite green" },
    }).eligible).toBe(false);
    expect(assessRegressionTestEligibility({
      repro,
      route: mechanical,
      baseline: { passes: false, detail: "existing failure" },
    }).eligible).toBe(false);
    expect(assessRegressionTestEligibility({
      repro,
      route: mechanical,
      baseline: { passes: true, detail: "suite green" },
    }).eligible).toBe(true);
  });

  test("never skips, always forces, and triage-decides honors the warrant", () => {
    const eligibility = { eligible: true, detail: "eligible" };
    expect(shouldGenerateRegressionTest("never", eligibility, mechanical.regressionTest!)).toBe(false);
    expect(shouldGenerateRegressionTest(
      "triage-decides",
      eligibility,
      { ...mechanical.regressionTest!, warranted: false },
    )).toBe(false);
    expect(shouldGenerateRegressionTest(
      "always",
      eligibility,
      { ...mechanical.regressionTest!, warranted: false },
    )).toBe(true);
  });

  test("needs-human intent is a non-warranted test.todo ambiguity question", () => {
    const spec = heuristicRegressionTestSpec(
      { kind: "needs-human", reason: "discount policy is ambiguous" },
      incident,
      { ...repro, reproduced: false },
      "services/api/test",
    );
    expect(spec.warranted).toBe(false);
    expect(spec.reason).toStartWith("test.todo(");
    expect(spec.reason).toContain("discount policy is ambiguous");
    expect(spec.mustPin).toEqual([]);
  });

  test("downgrades uncited behavior claims to unratified todo notes", () => {
    const spec = authorizeRegressionTestSpec({
      warranted: true,
      reason: "model proposal",
      mustPin: [
        { claim: "TypeError signature is absent", class: "signature-absence" },
        { claim: "returns 200 and ships after provider rejection", class: "behavior" },
      ],
      mustNotPin: [],
      suggestedLocation: "services/api/test",
    }, []);

    expect(spec.mustPin).toEqual([
      { claim: "TypeError signature is absent", class: "signature-absence" },
    ]);
    expect(spec.unratifiedBehavior).toEqual([
      { claim: "returns 200 and ships after provider rejection", class: "behavior" },
    ]);
    expect(formatRegressionTestIntent({
      spec,
      status: "skipped",
      detail: "todo",
      filesChanged: [],
      attempts: [],
    })).toContain("### Unratified behavior (not pinned - needs human ratification)");
  });

  test("keeps behavior claims backed by the consumer contract registry", () => {
    const spec = authorizeRegressionTestSpec({
      warranted: true,
      reason: "ratified contract",
      mustPin: [{
        claim: "valid create returns 201",
        class: "behavior",
        source: "orders.create.valid.status",
      }],
      mustNotPin: [],
      suggestedLocation: "services/api/test",
    }, [{ id: "orders.create.valid.status", statement: "A valid create returns HTTP 201." }]);

    expect(spec.mustPin).toEqual([{
      claim: "valid create returns 201",
      class: "behavior",
      source: "orders.create.valid.status",
    }]);
    expect(spec.unratifiedBehavior).toEqual([]);
  });
});

describe("red-pre and green-post enforcement", () => {
  test("rejects a test-writer source edit before running the test", async () => {
    const calls: string[] = [];
    const result = await runRegressionTestStage({
      config,
      worktreeDir: "/tmp/worktree",
      incident,
      repro,
      route: mechanical,
      writer: new FakeTestWriter(async () => ({
        description: "changed source",
        filesChanged: ["services/api/src/handler.ts"],
      })),
      verifier: runner([
        { passes: true, detail: "suite green" },
        { passes: false, detail: "unused" },
        { passes: false, detail: "unused" },
      ]),
      worktrees: worktrees(calls),
      baseCommit: "base",
      expectedHead: "base",
    });
    expect(result.record.status).toBe("failed");
    expect(result.record.detail).toContain("scope: fail");
    expect(calls).toEqual(["reset", "reset"]);
  });

  test("rejects green-pre and accepts red-pre followed by green-post", async () => {
    const greenCalls: string[] = [];
    const greenPre = await runRegressionTestStage({
      config: { ...config, maxFixAttempts: 1 },
      worktreeDir: "/tmp/worktree",
      incident,
      repro,
      route: mechanical,
      writer: new FakeTestWriter(async () => ({
        description: "test",
        filesChanged: ["services/api/test/orders.test.ts"],
      })),
      verifier: runner([
        { passes: true, detail: "suite green" },
        { passes: true, detail: "1 pass" },
      ]),
      worktrees: worktrees(greenCalls),
      baseCommit: "base",
      expectedHead: "base",
    });
    expect(greenPre.record.status).toBe("failed");
    expect(greenPre.record.detail).toContain("red: fail");

    const redCalls: string[] = [];
    const redPre = await runRegressionTestStage({
      config,
      worktreeDir: "/tmp/worktree",
      incident,
      repro,
      route: mechanical,
      writer: new FakeTestWriter(async () => ({
        description: "guards missing customer",
        filesChanged: ["services/api/test/orders.test.ts"],
      })),
      verifier: runner([
        { passes: true, detail: "suite green" },
        { passes: false, detail: "expected non-5xx, received 500" },
      ]),
      worktrees: worktrees(redCalls),
      baseCommit: "base",
      expectedHead: "base",
    });
    expect(redPre.record.status).toBe("established");
    expect(redCalls).toEqual(["commit:test"]);

    const activeRegressionTest = redPre.record as RegressionTestRecord;
    const state: TriageState = {
      logPath: config.logPath,
      events: [],
      incidents: [incident],
      activeIncident: incident,
      worktreeDir: "/tmp/worktree",
      worktreeBaseCommit: "base",
      pipelineHeadCommit: "pipeline-test",
      activeFix: {
        attempt: 1,
        branch: "bugloop/fix-abcdef01",
        description: "fix",
        filesChanged: ["services/api/src/handler.ts"],
        stageBaseCommit: "pipeline-test",
      },
      activeRegressionTest,
      retryCount: 0,
      errors: [],
    };
    const verified = await verifyWithRunner(state, runner([
      { passes: true, detail: "regression green" },
      { passes: true, detail: "suite green" },
    ]), config.fixScope, {
      ...worktrees([]),
      async verifyProvenance() {
        return {
          passes: true,
          changedPaths: ["services/api/src/handler.ts"],
          outOfScopePaths: [],
          unexpectedCommits: [],
          detail: "trusted working tree",
        };
      },
    });
    expect(verified.activeVerify?.verified).toBe(true);
    expect(verified.activeVerify?.regressionTestPasses).toBe(true);
    expect(verified.activeRegressionTest?.greenEvidence).toBe("regression green");
  });
});
