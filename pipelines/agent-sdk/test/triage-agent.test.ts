import { expect, test } from "bun:test";
import { fingerprintEvent, type Incident, type LogEvent } from "@bug-loop/core";
import {
  ClaudeTriageAgent,
  costFromSdkResult,
  parseTriageResult,
  TRIAGE_MAX_TURNS,
  TRIAGE_RETRY_COUNT,
  type TriageAgentInput,
  type TriageSdkAttempt,
  type TriageSdkAttemptResult,
} from "../src/triage-agent";

function input(level: LogEvent["level"] = "error"): TriageAgentInput {
  const event: LogEvent = {
    ts: "2026-07-13T12:00:00.000Z",
    level,
    msg: level === "warn" ? "order total negative; policy unclear" : "handler error",
    route: "POST /orders",
    status: level === "warn" ? 201 : 500,
    ...(level === "error"
      ? {
          err: {
            name: "TypeError",
            message: "undefined customer",
            stack: "TypeError: undefined customer\n at handleCreate (apps/leaky-service/src/server.ts:70:27)",
          },
        }
      : {}),
  };
  const incident: Incident = {
    fingerprint: fingerprintEvent(event),
    sampleEvents: [event],
    count: 1,
    firstSeen: event.ts,
    lastSeen: event.ts,
  };
  return {
    incident,
    repro: {
      reproduced: level === "error",
      command: "curl example.test",
      evidence: level === "error" ? "HTTP 500" : "HTTP 201",
    },
  };
}

test("parses strict triage JSON", () => {
  expect(parseTriageResult(
    '{"decision":"mechanical","reason":"reproduced","fixBrief":"Inspect server.ts handleCreate. Add an input guard before dereferencing customer.","regressionTest":{"warranted":true,"reason":"missing coverage","mustPin":[{"claim":"non-5xx status","class":"status-class"},{"claim":"TypeError signature absent","class":"signature-absence"}],"mustNotPin":["exact message text","generated IDs"],"suggestedLocation":"apps/leaky-service/test/orders.test.ts"}}',
    input(),
  )).toEqual({
    decision: "mechanical",
    reason: "reproduced",
    fixBrief: "Inspect server.ts handleCreate. Add an input guard before dereferencing customer.",
    regressionTest: {
      warranted: true,
      reason: "missing coverage",
      mustPin: [
        { claim: "non-5xx status", class: "status-class" },
        { claim: "TypeError signature absent", class: "signature-absence" },
      ],
      mustNotPin: ["exact message text", "generated IDs"],
      suggestedLocation: "apps/leaky-service/test/orders.test.ts",
    },
  });
});

test("extracts the first JSON object embedded in prose", () => {
  const result = parseTriageResult(
    'Result follows: {"decision":"needs-human","reason":"policy","fixBrief":"The discount policy is ambiguous. Product input is required before changing server.ts.","regressionTest":{"warranted":true,"reason":"pin a guess","mustPin":[{"claim":"negative totals are accepted","class":"behavior"}],"mustNotPin":[],"suggestedLocation":"apps/leaky-service/test/orders.test.ts"}} trailing text',
    input(),
  );
  expect(result.decision).toBe("needs-human");
  expect(result.reason).toBe("policy");
  expect(result.regressionTest.warranted).toBe(false);
  expect(result.regressionTest.reason).toStartWith("test.todo(");
  expect(result.regressionTest.mustPin).toEqual([]);
});

test("falls back to the deterministic heuristic for garbage", () => {
  expect(parseTriageResult("not json", input())).toMatchObject({
    decision: "mechanical",
    fixBrief: "",
    regressionTest: {
      warranted: true,
      mustPin: [
        {
          claim: "the response stays outside the 5xx status-code class",
          class: "status-class",
        },
        {
          claim: "the TypeError failure signature is absent",
          class: "signature-absence",
        },
      ],
      mustNotPin: expect.arrayContaining(["exact response message text"]),
    },
  });
  const warningFallback = parseTriageResult("{}", input("warn"));
  expect(warningFallback.decision).toBe("needs-human");
  expect(warningFallback.fixBrief).toBe("");
  expect(warningFallback.regressionTest.warranted).toBe(false);
  expect(warningFallback.regressionTest.reason).toStartWith("test.todo(");
});

test("captures exact Claude Agent SDK result usage and cost fields", () => {
  expect(costFromSdkResult({
    usage: { input_tokens: 4321, output_tokens: 765 },
    total_cost_usd: 0.0842,
    modelUsage: { "claude-sonnet-4-5": {} },
  })).toEqual({
    harness: "claude-agent-sdk",
    model: "claude-sonnet-4-5",
    inputTokens: 4321,
    outputTokens: 765,
    usd: 0.0842,
  });
});

test("triage turn budget and retry count are fixed constants", () => {
  expect(TRIAGE_MAX_TURNS).toBe(6);
  expect(TRIAGE_RETRY_COUNT).toBe(1);
});

const VALID_TRIAGE_JSON = JSON.stringify({
  decision: "mechanical",
  reason: "reproduced",
  fixBrief: "Inspect server.ts handleCreate. Add an input guard before dereferencing customer.",
  regressionTest: {
    warranted: true,
    reason: "missing coverage",
    mustPin: [{ claim: "non-5xx status", class: "status-class" }],
    mustNotPin: ["exact message text"],
    suggestedLocation: "apps/leaky-service/test/orders.test.ts",
  },
});

test("ClaudeTriageAgent retries once after invalid JSON then succeeds", async () => {
  const logs: string[] = [];
  let calls = 0;
  const sdkAttempt: TriageSdkAttempt = async (_input, _fixScope, options) => {
    calls += 1;
    expect(options.maxTurns).toBe(TRIAGE_MAX_TURNS);
    if (calls === 1) {
      return { text: "not json", error: null };
    }
    return { text: VALID_TRIAGE_JSON, error: null };
  };
  const agent = new ClaudeTriageAgent(
    "/tmp/repo",
    ["apps/leaky-service/src"],
    ["apps/leaky-service/test"],
    (message) => logs.push(message),
    sdkAttempt,
  );
  const decision = await agent.triage(input());
  expect(calls).toBe(2);
  expect(logs).toContain("[triage] retrying after SDK result was not valid triage JSON");
  expect(decision.decision).toBe("mechanical");
  expect(decision.fixBrief).toContain("handleCreate");
});

test("ClaudeTriageAgent retries once after SDK error then falls back to heuristic", async () => {
  const logs: string[] = [];
  let calls = 0;
  const sdkAttempt: TriageSdkAttempt = async (): Promise<TriageSdkAttemptResult> => {
    calls += 1;
    return { text: null, error: "rate limited" };
  };
  const agent = new ClaudeTriageAgent(
    "/tmp/repo",
    ["apps/leaky-service/src"],
    ["apps/leaky-service/test"],
    (message) => logs.push(message),
    sdkAttempt,
  );
  const decision = await agent.triage(input());
  expect(calls).toBe(1 + TRIAGE_RETRY_COUNT);
  expect(logs[0]).toBe("[triage] retrying after SDK result error: rate limited");
  expect(logs[1]).toBe("[triage] SDK result error, using heuristic: rate limited");
  expect(decision.decision).toBe("mechanical");
  expect(decision.fixBrief).toBe("");
});

test("ClaudeTriageAgent does not retry when the first attempt is valid", async () => {
  const logs: string[] = [];
  let calls = 0;
  const sdkAttempt: TriageSdkAttempt = async () => {
    calls += 1;
    return { text: VALID_TRIAGE_JSON, error: null };
  };
  const agent = new ClaudeTriageAgent(
    "/tmp/repo",
    ["apps/leaky-service/src"],
    ["apps/leaky-service/test"],
    (message) => logs.push(message),
    sdkAttempt,
  );
  await agent.triage(input());
  expect(calls).toBe(1);
  expect(logs).toEqual([]);
});

test("records one cost sample per SDK attempt without leaking samples into the next incident", async () => {
  let calls = 0;
  const sdkAttempt: TriageSdkAttempt = async () => {
    calls += 1;
    return {
      text: calls === 1 ? "invalid" : VALID_TRIAGE_JSON,
      error: null,
      cost: {
        harness: "claude-agent-sdk",
        model: "sonnet",
        inputTokens: calls * 10,
        outputTokens: calls,
        usd: calls / 100,
      },
    };
  };
  const agent = new ClaudeTriageAgent(
    "/tmp/repo",
    ["apps/leaky-service/src"],
    ["apps/leaky-service/test"],
    () => {},
    sdkAttempt,
  );

  await agent.triage(input());
  expect(agent.takeAgentCalls().map((call) => call.cost?.usd)).toEqual([0.01, 0.02]);
  await agent.triage(input());
  expect(agent.takeAgentCalls().map((call) => call.cost?.usd)).toEqual([0.03]);
  expect(agent.takeAgentCalls()).toEqual([]);
});
