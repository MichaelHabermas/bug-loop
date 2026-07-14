import { expect, test } from "bun:test";
import {
  buildFixPrompt,
  definePipelineConfig,
  GitWorktreeOperations,
  isPathInFixScope,
  verifyWithRunner,
  type ProcessRunner,
  type TriageState,
  type VerifyRunner,
} from "../src";

const config = definePipelineConfig({
  repo: "example/repo",
  labels: { pipeline: "pipeline", mechanical: "mechanical", needsHuman: "human" },
  logPath: "logs/app.jsonl",
  baseUrl: "http://localhost:3000/",
  cursorPath: ".cursor.json",
  fixScope: ["services/api/src/"],
  testScope: ["services/api/test/"],
  worktreeRoot: ".scratch/worktrees",
  maxFixAttempts: 3,
  fixer: "codex",
  invariantWarnPrefixes: ["invariant failed"],
});

test("PipelineConfig applies defaults and normalizes path-like values", () => {
  expect(config.branchPrefix).toBe("bugloop/fix-");
  expect(config.baseUrl).toBe("http://localhost:3000");
  expect(config.fixScope).toEqual(["services/api/src"]);
  expect(config.testScope).toEqual(["services/api/test"]);
  expect(config.regressionTests).toBe("triage-decides");
  expect(isPathInFixScope("services/api/src/handler.ts", config.fixScope)).toBe(true);
  expect(isPathInFixScope("services/api/src-old/handler.ts", config.fixScope)).toBe(false);
});

test("fixScope reaches the fixer prompt and verification guard", async () => {
  const prompt = buildFixPrompt({
    worktreeDir: "/tmp/worktree",
    issueTitle: "failure",
    issueBody: "evidence",
    attempt: 1,
  }, config.fixScope);
  expect(prompt).toContain("services/api/src");
  expect(prompt).not.toContain("apps/leaky-service");

  const runner: VerifyRunner = {
    async verifyRepro() {
      return { passes: true, detail: "signature absent" };
    },
    async runTests() {
      return { passes: true, detail: "tests pass" };
    },
    async runTypecheck() {
      return { passes: true, detail: "types pass" };
    },
  };
  const state: TriageState = {
    logPath: config.logPath,
    events: [],
    incidents: [],
    activeIncident: {
      fingerprint: { hash: "abc", errName: "Error", topFrame: "handler", route: "POST /x" },
      sampleEvents: [],
      count: 1,
      firstSeen: "2026-07-14T00:00:00.000Z",
      lastSeen: "2026-07-14T00:00:00.000Z",
    },
    worktreeDir: "/tmp/worktree",
    activeFix: {
      attempt: 1,
      branch: "bugloop/fix-abc",
      description: "patch",
      filesChanged: ["services/api/src/handler.ts"],
    },
    retryCount: 0,
    errors: [],
  };
  const accepted = await verifyWithRunner(state, runner, config.fixScope);
  expect(accepted.activeVerify?.scopePasses).toBe(true);
  const rejected = await verifyWithRunner({
    ...state,
    activeFix: { ...state.activeFix!, filesChanged: ["services/api/test/handler.test.ts"] },
  }, runner, config.fixScope);
  expect(rejected.activeVerify?.scopePasses).toBe(false);
});

test("fixScope reaches worktree commit pathspecs", async () => {
  const commands: string[][] = [];
  const runner: ProcessRunner = async (command) => {
    commands.push(command);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const worktrees = new GitWorktreeOperations(
    "/repo",
    config.worktreeRoot,
    config.fixScope,
    config.testScope,
    runner,
  );
  await worktrees.commit({ worktreeDir: "/repo/.scratch/worktrees/abc", message: "fix" });
  expect(commands[0]).toEqual([
    "git",
    "-C",
    "/repo/.scratch/worktrees/abc",
    "add",
    "--",
    "services/api/src",
  ]);
  await worktrees.commit({
    worktreeDir: "/repo/.scratch/worktrees/abc",
    message: "test",
    scope: "test",
  });
  expect(commands[2]).toEqual([
    "git",
    "-C",
    "/repo/.scratch/worktrees/abc",
    "add",
    "--",
    "services/api/test",
  ]);
});

test("PipelineConfig rejects overlapping fix and test scopes", () => {
  expect(() => definePipelineConfig({
    ...config,
    fixScope: ["services/api"],
    testScope: ["services/api/test"],
  })).toThrow("fixScope and testScope must not overlap");
});
