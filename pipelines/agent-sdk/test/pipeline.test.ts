import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  FakeFixer,
  type FixInput,
  type IssueInput,
  type PRInput,
  type VerifyRunner,
  type WorktreeOperations,
} from "@bug-loop/core";
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
  const fixInputs: FixInput[] = [];
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
    };
  });

  const result = await runAgentSdkPipeline({
    logPath: FIXTURE,
    cursorPath: join(TMP, "cursor.json"),
    fromStart: true,
    baseUrl: "http://127.0.0.1:1",
    fix: true,
    live: false,
  }, {
    triageAgent,
    fixer,
    verifier,
    worktrees,
    github,
    async reproduce({ incident }) {
      const reproduced = incident.sampleEvents[0]?.level === "error";
      return {
        reproduced,
        command: `curl ${incident.fingerprint.route}`,
        evidence: reproduced ? "HTTP 500" : "HTTP 201 policy ambiguity",
      };
    },
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

  const rerun = await runAgentSdkPipeline({
    logPath: FIXTURE,
    cursorPath: join(TMP, "cursor.json"),
    fromStart: false,
    baseUrl: "http://127.0.0.1:1",
    fix: false,
    live: false,
  }, { triageAgent, github, repoRoot: TMP });
  expect(rerun.summary.eventsRead).toBe(0);
  expect(rerun.summary.newIncidents).toBe(0);
  expect(triageCalls).toBe(4);
});
