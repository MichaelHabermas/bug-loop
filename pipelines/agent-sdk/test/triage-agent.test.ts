import { expect, test } from "bun:test";
import { fingerprintEvent, type Incident, type LogEvent } from "@bug-loop/core";
import {
  costFromSdkResult,
  parseTriageResult,
  type TriageAgentInput,
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
    '{"decision":"mechanical","reason":"reproduced","fixBrief":"Inspect server.ts handleCreate. Add an input guard before dereferencing customer.","regressionTest":{"warranted":true,"reason":"missing coverage","mustPin":["non-5xx status","TypeError signature absent"],"mustNotPin":["exact message text","generated IDs"],"suggestedLocation":"apps/leaky-service/test/orders.test.ts"}}',
    input(),
  )).toEqual({
    decision: "mechanical",
    reason: "reproduced",
    fixBrief: "Inspect server.ts handleCreate. Add an input guard before dereferencing customer.",
    regressionTest: {
      warranted: true,
      reason: "missing coverage",
      mustPin: ["non-5xx status", "TypeError signature absent"],
      mustNotPin: ["exact message text", "generated IDs"],
      suggestedLocation: "apps/leaky-service/test/orders.test.ts",
    },
  });
});

test("extracts the first JSON object embedded in prose", () => {
  const result = parseTriageResult(
    'Result follows: {"decision":"needs-human","reason":"policy","fixBrief":"The discount policy is ambiguous. Product input is required before changing server.ts.","regressionTest":{"warranted":true,"reason":"pin a guess","mustPin":["negative totals are accepted"],"mustNotPin":[],"suggestedLocation":"apps/leaky-service/test/orders.test.ts"}} trailing text',
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
        "the response stays outside the 5xx status-code class",
        "the TypeError failure signature is absent",
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
