import { expect, test } from "bun:test";
import {
  PristineSuiteCache,
  verifyWithRunner,
  type Incident,
  type TriageState,
  type VerifyRunner,
  type WorktreeOperations,
} from "../src";

const incident: Incident = {
  fingerprint: { hash: "verify", errName: "Error", topFrame: "handler", route: "POST /x" },
  sampleEvents: [],
  count: 1,
  firstSeen: "2026-07-14T00:00:00.000Z",
  lastSeen: "2026-07-14T00:00:00.000Z",
};

function state(): TriageState {
  return {
    logPath: "logs/app.jsonl",
    events: [],
    incidents: [incident],
    activeIncident: incident,
    worktreeDir: "/tmp/worktree",
    worktreeBaseCommit: "base",
    pipelineHeadCommit: "base",
    activeFix: {
      attempt: 1,
      branch: "fix/verify",
      description: "fix",
      filesChanged: ["src/handler.ts"],
      stageBaseCommit: "base",
    },
    activeRegressionTest: {
      spec: {
        warranted: true,
        reason: "manifest",
        mustPin: [],
        mustNotPin: [],
        suggestedLocation: "test",
      },
      status: "established",
      detail: "red",
      filesChanged: ["test/regression.test.ts"],
      attempts: [],
    },
    retryCount: 0,
    errors: [],
  };
}

function worktrees(calls: string[], scopePasses: boolean): WorktreeOperations {
  return {
    async create(input) {
      return { worktreeDir: "/tmp/worktree", branch: input.branch, baseCommit: "base" };
    },
    async commit() {
      return { commit: "commit" };
    },
    async push() {},
    async remove() {},
    async reset() {},
    async verifyProvenance() {
      calls.push("scope");
      return {
        passes: scopePasses,
        changedPaths: scopePasses ? ["src/handler.ts"] : ["outside.ts"],
        outOfScopePaths: scopePasses ? [] : ["outside.ts"],
        unexpectedCommits: [],
        detail: scopePasses ? "scope pass" : "scope fail",
      };
    },
  };
}

function runner(calls: string[], regressionPasses = true): VerifyRunner {
  return {
    async runTestFiles() {
      calls.push("regression");
      return { passes: regressionPasses, detail: "regression result" };
    },
    async verifyRepro() {
      calls.push("repro");
      return { passes: true, detail: "repro result" };
    },
    async runTests() {
      calls.push("suite");
      return { passes: true, detail: "suite result" };
    },
    async runTypecheck() {
      calls.push("typecheck");
      return { passes: true, detail: "typecheck result" };
    },
  };
}

test("verification is fail-fast in scope, regression, repro, suite, typecheck order", async () => {
  const scopeCalls: string[] = [];
  await verifyWithRunner(state(), runner(scopeCalls), ["src"], worktrees(scopeCalls, false));
  expect(scopeCalls).toEqual(["scope"]);

  const regressionCalls: string[] = [];
  await verifyWithRunner(
    state(),
    runner(regressionCalls, false),
    ["src"],
    worktrees(regressionCalls, true),
  );
  expect(regressionCalls).toEqual(["scope", "regression"]);

  const passingCalls: string[] = [];
  await verifyWithRunner(state(), runner(passingCalls), ["src"], worktrees(passingCalls, true));
  expect(passingCalls).toEqual(["scope", "regression", "repro", "suite", "typecheck"]);
});

test("pristine suite results are cached by base SHA including concurrent requests", async () => {
  const cache = new PristineSuiteCache();
  let calls = 0;
  const run = async () => {
    calls += 1;
    return { passes: true, detail: "124 pass" };
  };
  const [first, second] = await Promise.all([
    cache.get("base-sha", run),
    cache.get("base-sha", run),
  ]);
  expect(first).toEqual(second);
  expect(calls).toBe(1);
  await cache.get("other-sha", run);
  expect(calls).toBe(2);
});
