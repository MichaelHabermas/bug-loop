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
  type RoutingPolicy,
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
  const createFixer = () => new FakeFixer(async (input) => {
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
      return { worktreeDir: join(TMP, input.fingerprint8), branch: input.branch, baseCommit: "base" };
    },
    async commit(input) {
      worktreeCalls.push(`commit:${input.message}`);
      return { commit: input.scope === "test" ? "pipeline-test" : "pipeline-fix" };
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
    async verifyProvenance(input) {
      const changedPaths = input.scope[0]?.includes("test")
        ? ["apps/leaky-service/test/regression.test.ts"]
        : ["apps/leaky-service/src/server.ts"];
      return {
        passes: true,
        changedPaths,
        outOfScopePaths: [],
        unexpectedCommits: [],
        detail: "trusted working tree",
      };
    },
  };

  const issues: IssueInput[] = [];
  const comments: string[] = [];
  const labelSwaps: string[] = [];
  const pullRequests: PRInput[] = [];
  let issueListCalls = 0;
  let issueReadCalls = 0;
  const github: GitHubOperations = {
    async listOpenIssues() {
      issueListCalls += 1;
      return [];
    },
    async createIssue(input) {
      issues.push(input);
      const number = issues.length;
      return { number, url: `https://example.test/issues/${number}` };
    },
    async readIssue() {
      issueReadCalls += 1;
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
    const incidentClass = incident.fingerprint.errName === "TypeError"
      ? "leaky-service.missing-customer"
      : incident.fingerprint.errName === "RangeError"
        ? "leaky-service.invalid-since"
        : "leaky-service.shipping-timeout";
    return {
      kind: "authorized",
      incidentClass,
      reason: "mapped to authorized class",
      fixBrief: `Inspect ${incident.fingerprint.topFrame}. Apply the smallest source fix.`,
    };
  });
  const routingPolicy: RoutingPolicy = {
    authorizedClasses: [
      "leaky-service.missing-customer",
      "leaky-service.invalid-since",
      "leaky-service.shipping-timeout",
    ],
    evaluate: ({ incident }) => incident.sampleEvents[0]?.level === "warn"
      ? { kind: "deny", reason: "policy ambiguity" }
      : { kind: "unknown", reason: "agent mapping required" },
  };

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
    createFixer,
    createTestWriter: () => new FakeTestWriter(async ({ incident }) => {
      const path = `apps/leaky-service/test/${incident.fingerprint.hash.slice(0, 8)}.test.ts`;
      redPending.add(path);
      return { description: "focused regression", filesChanged: [path] };
    }),
    verifier,
    worktrees,
    github,
    reproStrategy,
    routingPolicy,
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
  expect(issueListCalls).toBe(1);
  expect(issueReadCalls).toBe(3);
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
  expect(trace.schemaVersion).toBe(2);
  expect(trace.resolved.pipeline).toBe("agent-sdk");
  expect(trace.resolved.fixer).toMatchObject({ harness: "injected", source: "arg" });
  expect(trace.workload).toMatchObject({
    benchmarkId: "leaky-service-seeded-v2",
    seed: 42,
    caseCount: 14,
  });
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
  expect(trace.agentCalls.filter((call) => call.stage === "triage")).toHaveLength(3);
  expect(trace.agentCalls.filter((call) => call.stage === "fixer")).toHaveLength(5);
  expect(trace.agentCalls.filter((call) => call.stage === "testWriter")).toHaveLength(3);
  expect(trace.agentCalls.every((call) =>
    call.correlationId?.startsWith(`${trace.runId}:`) === true &&
    call.attemptId?.startsWith(`${call.correlationId}:`) === true
  )).toBe(true);
  const lifecycleEvents = trace.events.filter(
    (event) => event.stage === "pr" || event.stage === "give-up",
  );
  expect(lifecycleEvents).toHaveLength(3);
  expect(lifecycleEvents.every((event) =>
    event.correlationId?.startsWith(`${trace.runId}:`) === true &&
    event.attemptId?.startsWith(`${event.correlationId}:`) === true
  )).toBe(true);
  expect(pullRequests.every((pr) => pr.body.includes("## Regression test intent"))).toBe(true);
  expect(pullRequests.every((pr) => pr.body.includes("### Must pin"))).toBe(true);

  const rerun = await runAgentSdkPipeline(config, {
    fromStart: false,
    fix: false,
    live: false,
    tracePath: join(TMP, "rerun-trace.json"),
  }, { triageAgent, github, repoRoot: TMP, reproStrategy, routingPolicy });
  expect(rerun.summary.eventsRead).toBe(0);
  expect(rerun.summary.newIncidents).toBe(0);
  expect(issueListCalls).toBe(2);
  expect(triageCalls).toBe(3);
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
    async listOpenIssues() {
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

test("watch mode commits cursor to batch end so mid-pass events are seen next pass", async () => {
  const logPath = join(TMP, "watch-cursor.jsonl");
  const cursorPath = join(TMP, "watch-cursor-offset.json");
  const firstEvent = {
    ts: "2026-07-15T12:00:00.000Z",
    level: "error" as const,
    msg: "batch event",
    route: "POST /orders",
    err: {
      name: "TypeError",
      message: "undefined customer",
      stack: "TypeError: undefined customer\n    at handleCreate (src/server.ts:10:1)",
    },
  };
  await Bun.write(logPath, `${JSON.stringify(firstEvent)}\n`);
  const batchEndOffset = Bun.file(logPath).size;

  const config = createLeakyServicePipelineConfig({
    cursorPath,
    baseUrl: "http://127.0.0.1:1",
    fixer: "grok",
    logPath,
  });

  const github: GitHubOperations = {
    async listOpenIssues() {
      return [];
    },
    async createIssue() {
      // Mid-pass: service appends another event after ingest (simulating race window).
      const mid = {
        ...firstEvent,
        ts: "2026-07-15T12:00:01.000Z",
        msg: "mid-pass event",
        err: {
          name: "RangeError",
          message: "invalid since",
          stack: "RangeError: invalid since\n    at listOrders (src/server.ts:20:1)",
        },
      };
      await Bun.write(logPath, `${await Bun.file(logPath).text()}${JSON.stringify(mid)}\n`);
      return { number: 1, url: "https://example.test/issues/1" };
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

  const reproStrategy = {
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
  } satisfies ReproStrategy;

  const routingPolicy: RoutingPolicy = {
    authorizedClasses: [],
    evaluate: () => ({ kind: "deny", reason: "ticket only" }),
  };

  const pass1 = await runAgentSdkPipeline(config, {
    fromStart: false,
    fix: false,
    live: false,
    watch: true,
    commitCursorOffset: batchEndOffset,
    watchSessionId: "sess-cursor",
    watchPass: 1,
    tracePath: join(TMP, "pass1.json"),
  }, { github, reproStrategy, routingPolicy, repoRoot: TMP });

  expect(pass1.summary.eventsRead).toBe(1);
  const cursorAfter = await Bun.file(cursorPath).json() as { offset: number };
  expect(cursorAfter.offset).toBe(batchEndOffset);
  expect(Bun.file(logPath).size).toBeGreaterThan(batchEndOffset);

  const pass2 = await runAgentSdkPipeline(config, {
    fromStart: false,
    fix: false,
    live: false,
    watch: true,
    commitCursorOffset: Bun.file(logPath).size,
    watchSessionId: "sess-cursor",
    watchPass: 2,
    tracePath: join(TMP, "pass2.json"),
  }, { github, reproStrategy, routingPolicy, repoRoot: TMP });

  expect(pass2.summary.eventsRead).toBe(1);
  expect(pass2.summary.incidents).toBe(1);
});

test("watch --fix: same fingerprint routes/tickets twice but fix loop only once per session", async () => {
  const logPath = join(TMP, "watch-fix.jsonl");
  const cursorPath = join(TMP, "watch-fix-cursor.json");
  const event = {
    ts: "2026-07-15T12:00:00.000Z",
    level: "error" as const,
    msg: "handler error",
    route: "POST /orders",
    err: {
      name: "TypeError",
      message: "undefined customer",
      stack: "TypeError: undefined customer\n    at handleCreate (src/server.ts:10:1)",
    },
  };
  await Bun.write(logPath, `${JSON.stringify(event)}\n`);

  const config = createLeakyServicePipelineConfig({
    cursorPath,
    baseUrl: "http://127.0.0.1:1",
    fixer: "grok",
    logPath,
  });

  const sessionFixFingerprints = new Set<string>();
  const fixCalls: number[] = [];
  const openIssues: Array<{ number: number; url: string; body: string }> = [];

  const github: GitHubOperations = {
    async listOpenIssues() {
      return openIssues.map((issue) => ({ ...issue }));
    },
    async createIssue(input) {
      const number = openIssues.length + 1;
      const issue = { number, url: `https://example.test/issues/${number}`, body: input.body };
      openIssues.push(issue);
      return { number, url: issue.url };
    },
    async readIssue() {
      return null;
    },
    async commentIssue(number, body) {
      const issue = openIssues.find((item) => item.number === number);
      if (issue) issue.body = `${issue.body}\n${body}`;
    },
    async replaceIssueLabel() {},
    async createPullRequest() {
      return { number: 9, url: "https://example.test/pull/9" };
    },
  };

  const worktrees: WorktreeOperations = {
    async create(input) {
      return { worktreeDir: join(TMP, input.fingerprint8), branch: input.branch, baseCommit: "base" };
    },
    async commit() {
      return { commit: "c1" };
    },
    async push() {},
    async remove() {},
    async reset() {},
    async verifyProvenance() {
      return {
        passes: true,
        changedPaths: ["apps/leaky-service/src/server.ts"],
        outOfScopePaths: [],
        unexpectedCommits: [],
        detail: "ok",
      };
    },
  };

  const redPending = new Set<string>();
  const verifier: VerifyRunner = {
    async verifyRepro() {
      return { passes: true, detail: "signature absent" };
    },
    async runTests() {
      return { passes: true, detail: "green" };
    },
    async runTestFiles(_worktreeDir, files) {
      const file = files[0] ?? "";
      if (redPending.delete(file)) {
        return { passes: false, detail: "expected non-5xx, received 500" };
      }
      return { passes: true, detail: "green" };
    },
    async runTypecheck() {
      return { passes: true, detail: "clean" };
    },
  };

  const triageAgent = new FakeTriageAgent(async () => ({
    kind: "authorized",
    incidentClass: "leaky-service.missing-customer",
    reason: "mapped",
    fixBrief: "fix missing customer",
  }));
  const routingPolicy: RoutingPolicy = {
    authorizedClasses: ["leaky-service.missing-customer"],
    evaluate: () => ({ kind: "unknown", reason: "agent" }),
  };
  const reproStrategy = {
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
  } satisfies ReproStrategy;

  const deps = {
    triageAgent,
    createFixer: () => new FakeFixer(async () => {
      fixCalls.push(1);
      return {
        description: "patch",
        filesChanged: ["apps/leaky-service/src/server.ts"],
      };
    }),
    createTestWriter: () => new FakeTestWriter(async ({ incident }) => {
      const path = `apps/leaky-service/test/${incident.fingerprint.hash.slice(0, 8)}.test.ts`;
      redPending.add(path);
      return { description: "test", filesChanged: [path] };
    }),
    verifier,
    worktrees,
    github,
    reproStrategy,
    routingPolicy,
    repoRoot: TMP,
  };

  const pass1 = await runAgentSdkPipeline(config, {
    fromStart: true,
    fix: true,
    live: false,
    watch: true,
    sessionFixFingerprints,
    watchSessionId: "sess-fix",
    watchPass: 1,
    tracePath: join(TMP, "fix-pass1.json"),
  }, deps);

  expect(pass1.summary.issuesFiled).toBe(1);
  expect(fixCalls).toHaveLength(1);
  expect(sessionFixFingerprints.size).toBe(1);

  // Same fingerprint reappears (reset cursor) while issue stays open.
  await Bun.write(cursorPath, `${JSON.stringify({ offset: 0 }, null, 2)}\n`);

  const pass2 = await runAgentSdkPipeline(config, {
    fromStart: false,
    fix: true,
    live: false,
    watch: true,
    sessionFixFingerprints,
    watchSessionId: "sess-fix",
    watchPass: 2,
    tracePath: join(TMP, "fix-pass2.json"),
  }, deps);

  // Second pass still routes/tickets existing open issue...
  expect(pass2.summary.incidents).toBe(1);
  expect(pass2.summary.newIncidents).toBe(0);
  // ...but does not re-enter the fix loop.
  expect(fixCalls).toHaveLength(1);
  const trace2 = await Bun.file(join(TMP, "fix-pass2.json")).json() as RunTrace;
  expect(trace2.events.filter((event) => event.stage === "fix")).toHaveLength(0);
  expect(trace2.events.some((event) => event.stage === "route")).toBe(true);
  expect(trace2.events.some((event) => event.stage === "ticket")).toBe(true);
});
