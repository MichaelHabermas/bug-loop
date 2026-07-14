import { expect, test } from "bun:test";
import { fingerprintEvent, type Incident, type LogEvent } from "@bug-loop/shared";
import { parseTriageResult, type TriageAgentInput } from "../src/triage-agent";

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
    '{"decision":"mechanical","reason":"reproduced","fixBrief":"Inspect server.ts handleCreate. Add an input guard before dereferencing customer."}',
    input(),
  )).toEqual({
    decision: "mechanical",
    reason: "reproduced",
    fixBrief: "Inspect server.ts handleCreate. Add an input guard before dereferencing customer.",
  });
});

test("extracts the first JSON object embedded in prose", () => {
  const result = parseTriageResult(
    'Result follows: {"decision":"needs-human","reason":"policy","fixBrief":"The discount policy is ambiguous. Product input is required before changing server.ts."} trailing text',
    input(),
  );
  expect(result.decision).toBe("needs-human");
  expect(result.reason).toBe("policy");
});

test("falls back to the deterministic heuristic for garbage", () => {
  expect(parseTriageResult("not json", input())).toMatchObject({
    decision: "mechanical",
    fixBrief: "",
  });
  expect(parseTriageResult("{}", input("warn"))).toMatchObject({
    decision: "needs-human",
    fixBrief: "",
  });
});
