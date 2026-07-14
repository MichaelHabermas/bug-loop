import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  FakeFixer,
  FakeTestWriter,
  type FixInput,
  type IssueInput,
  type PRInput,
  type ReproStrategy,
  type ReproStrategyInput,
  type RunTrace,
  type VerifyRunner,
  type WorktreeOperations,
} from "@bug-loop/core";
import { createLeakyServicePipelineConfig } from "@bug-loop/leaky-service/bug-loop";
import { runAgentSdkPipeline, type GitHubOperations } from "../src/pipeline";
import { FakeTriageAgent } from "../src/triage-agent";

const TMP = join(import.meta.dir, ".tmp-pipeline");
const FIXTURE = join(import.meta.dir, "fixtures", "all-bugs.jsonl");
const originalDryRun = process.env["DRY_RUN"];

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

test("plain orchestrator routes, retries, gives up, and never fixes needs-human incidents", async () => {
  const config = createLeakyServicePipelineConfig({
    cursorPath: join(TMP, "cursor.json"),
    baseUrl: "http://127.0.0.1:1",
    fixer: "grok",
    logPath: FIXTURE,
  });
  const fixInputs: FixInput[] = [];
  const redPending = new Set<string>();
  const fixer = new FakeFixer(async (input) => {
    fixInputs.push(input);
    return {
      description: `patch ${input.issueTitle} attempt ${input.attempt}`,
      filesChanged: ["apps/leaky-service/src/server.ts"],
    };
  });

  const reproAttempts = new Map<string, number>();
  const verifier: VerifyRunner = {
    async verifyRepro({ incident }) {
      const name = incident.fingerprint.errName;
      const attempt = (reproAttempts.get(name) ?? 0) + 1;
      reproAttempts.set(name, attempt);
      const passes = name === "RangeError" || (name === "TypeError" && attempt === 2);
      return { passes, detail: passes ? `${name} signature absent` : `${name} still broken` };
    },
    async runTests() {
      return { passes: true, detail: "50 pass, 0 fail" };
    },
    async runTestFiles(_worktreeDir, files) {
      const file = files[0] ?? "";
      if (redPending.delete(file)) {
        return { passes: false, detail: "expected non-5xx, received 500" };
      }
      return { passes: true, detail: "1 pass, 0 fail" };
    },
    async runTypecheck() {
      return { passes: true, detail: "TypeScript clean" };
    },
  };

  const worktreeCalls: string[] = [];
  const worktrees: WorktreeOperations = {
    async create(input) {
      worktreeCalls.push(`create:${input.fingerprint8}`);
      return { worktreeDir: join(TMP, input.fingerprint8), branch: input.branch };
    },
    async commit(input) {
      worktreeCalls.push(`commit:${input.message}`);
    },
    async push(input) {
      worktreeCalls.push(`push:${input.branch}`);
    },
    async remove(worktreeDir) {
      worktreeCalls.push(`remove:${worktreeDir}`);
    },
    async reset(worktreeDir) {
      worktreeCalls.push(`reset:${worktreeDir}`);
    },
  };

  const issues: IssueInput[] = [];
  const comments: string[] = [];
  const labelSwaps: string[] = [];
  const pullRequests: PRInput[] = [];
  const github: GitHubOperations = {
    async findOpenIssueByMarker() {
      return null;
    },
    async createIssue(input) {
      issues.push(input);
      const number = issues.length;
      return { number, url: `https://example.test/issues/${number}` };
    },
    async readIssue() {
      return null;
    },
    async commentIssue(number, body) {
      comments.push(`${number}:${body}`);
    },
    async replaceIssueLabel(number, remove, add) {
      labelSwaps.push(`${number}:${remove}:${add}`);
    },
    async createPullRequest(input) {
      pullRequests.push(input);
      const number = pullRequests.length;
      return { number, url: `https://example.test/pull/${number}` };
    },
  };

  let triageCalls = 0;
  const triageAgent = new FakeTriageAgent(async ({ incident }) => {
    triageCalls += 1;
    return {
      decision: incident.sampleEvents[0]?.level === "warn" ? "needs-human" : "mechanical",
      reason: incident.sampleEvents[0]?.level === "warn" ? "policy ambiguity" : "reproduced crash",
      fixBrief: `Inspect ${incident.fingerprint.topFrame}. Apply the smallest source fix.`,
      regressionTest: {
        warranted: incident.sampleEvents[0]?.level !== "warn",
        reason: incident.sampleEvents[0]?.level === "warn"
          ? 'test.todo("What discount behavior should be required?")'
          : "The deterministic crash is missing regression coverage.",
        mustPin: incident.sampleEvents[0]?.level === "warn"
          ? []
          : ["status is outside the 5xx class", `${incident.fingerprint.errName} signature is absent`],
        mustNotPin: ["exact response message text", "generated IDs"],
        suggestedLocation: "apps/leaky-service/test",
      },
    };
  });

  const reproStrategy = {
    derive({ incident }: ReproStrategyInput) {
      const reproduced = incident.sampleEvents[0]?.level === "error";
      return {
        command: `curl ${incident.fingerprint.route}`,
        async reproduce() {
          return {
            reproduced,
            evidence: reproduced ? "HTTP 500" : "HTTP 201 policy ambiguity",
          };
        },
        async verify() {
          return { passes: true, detail: "unused by fake verifier" };
        },
      };
    },
  } satisfies ReproStrategy;

  const result = await runAgentSdkPipeline(config, {
    fromStart: true,
    fix: true,
    live: false,
    tracePath: join(TMP, "trace.json"),
  }, {
    triageAgent,
    fixer,
    testWriter: new FakeTestWriter(async ({ incident }) => {
      const path = `apps/leaky-service/test/${incident.fingerprint.hash.slice(0, 8)}.test.ts`;
      redPending.add(path);
      return { description: "focused regression", filesChanged: [path] };
    }),
    verifier,
    worktrees,
    github,
    reproStrategy,
    repoRoot: TMP,
  });

  expect(result.summary).toEqual({
    eventsRead: 4,
    actionable: 4,
    incidents: 4,
    newIncidents: 4,
    reproduced: 3,
    issuesFiled: 4,
  });
  expect(issues).toHaveLength(4);
  expect(worktreeCalls.filter((call) => call.startsWith("create:"))).toHaveLength(3);
  expect(fixInputs.some((input) => input.issueTitle.includes("WarnInvariant"))).toBe(false);

  const typeErrorRetry = fixInputs.find(
    (input) => input.issueTitle.includes("TypeError") && input.attempt === 2,
  );
  expect(typeErrorRetry?.previousFailure).toContain("TypeError still broken");
  expect(typeErrorRetry?.fixBrief).toContain("handleCreate");

  expect(labelSwaps).toEqual(["3:auto-fix-candidate:needs-human"]);
  expect(comments.join("\n")).toContain("3:Automated fix gave up after 2 attempts");
  expect(pullRequests).toHaveLength(2);
  expect(result.state.errors).toEqual([]);
  const trace = await Bun.file(join(TMP, "trace.json")).json() as RunTrace;
  expect(trace.events.slice(0, 6).map((event) => event.stage)).toEqual([
    "ingest",
    "detect",
    "dedupe",
    "reproduce",
    "route",
    "ticket",
  ]);
  expect(trace.events.filter((event) => event.stage === "fix")).toHaveLength(5);
  expect(trace.events.filter((event) => event.stage === "verify")).toHaveLength(5);
  expect(trace.events.filter((event) => event.stage === "testgen")).toHaveLength(3);
  expect(trace.events.filter((event) => event.stage === "verify-test-red")).toHaveLength(3);
  expect(pullRequests.every((pr) => pr.body.includes("## Regression test intent"))).toBe(true);
  expect(pullRequests.every((pr) => pr.body.includes("### Must pin"))).toBe(true);

  const rerun = await runAgentSdkPipeline(config, {
    fromStart: false,
    fix: false,
    live: false,
    tracePath: join(TMP, "rerun-trace.json"),
  }, { triageAgent, github, repoRoot: TMP, reproStrategy });
  expect(rerun.summary.eventsRead).toBe(0);
  expect(rerun.summary.newIncidents).toBe(0);
  expect(triageCalls).toBe(4);
});

test("records a failed stage before finalizing the trace", async () => {
  const tracePath = join(TMP, "failed-trace.json");
  const config = createLeakyServicePipelineConfig({
    cursorPath: join(TMP, "cursor.json"),
    baseUrl: "http://127.0.0.1:1",
    fixer: "grok",
    logPath: FIXTURE,
  });
  const github: GitHubOperations = {
    async findOpenIssueByMarker() {
      throw new Error("lookup failed");
    },
    async createIssue() {
      throw new Error("unused");
    },
    async readIssue() {
      return null;
    },
    async commentIssue() {},
    async replaceIssueLabel() {},
    async createPullRequest() {
      throw new Error("unused");
    },
  };

  await expect(runAgentSdkPipeline(config, {
    fromStart: true,
    fix: false,
    live: false,
    tracePath,
  }, { github, repoRoot: TMP })).rejects.toThrow("lookup failed");

  const trace = await Bun.file(tracePath).json() as RunTrace;
  expect(trace.events.map((event) => [event.stage, event.outcome])).toEqual([
    ["ingest", "4 events"],
    ["detect", "4 actionable"],
    ["dedupe", "error"],
  ]);
  expect(trace.events[2]?.detail).toEqual({ error: "lookup failed" });
});
