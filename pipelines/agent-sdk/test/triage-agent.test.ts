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
} from "../src/triage-agent";

const AUTHORIZED_CLASS = "leaky-service.missing-customer";

function input(): TriageAgentInput {
  const event: LogEvent = {
    ts: "2026-07-13T12:00:00.000Z",
    level: "error",
    msg: "handler error",
    route: "POST /orders",
    status: 500,
    err: { name: "TypeError", message: "undefined customer" },
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
    repro: { reproduced: true, command: "curl example.test", evidence: "HTTP 500" },
    authorizedClasses: [AUTHORIZED_CLASS],
  };
}

const VALID = JSON.stringify({
  decision: "authorized",
  incidentClass: AUTHORIZED_CLASS,
  reason: "exact class match",
  fixBrief: "Guard customer before dereferencing it in handleCreate.",
});

test("parses only authorized class mappings or needs-human", () => {
  expect(parseTriageResult(VALID, input())).toEqual({
    kind: "authorized",
    incidentClass: AUTHORIZED_CLASS,
    reason: "exact class match",
    fixBrief: "Guard customer before dereferencing it in handleCreate.",
  });
  expect(parseTriageResult(
    '{"decision":"needs-human","reason":"no exact class"}',
    input(),
  )).toEqual({ kind: "needs-human", reason: "no exact class" });
  expect(parseTriageResult(
    '{"decision":"authorized","incidentClass":"invented","reason":"guess","fixBrief":"guess"}',
    input(),
  ).kind).toBe("needs-human");
});

test("invalid SDK output retries once then routes to human", async () => {
  let calls = 0;
  const logs: string[] = [];
  const sdkAttempt: TriageSdkAttempt = async (_input, _scope, options) => {
    calls += 1;
    expect(options.maxTurns).toBe(TRIAGE_MAX_TURNS);
    return { text: "not json", error: null };
  };
  const agent = new ClaudeTriageAgent(
    "/tmp/repo",
    ["apps/leaky-service/src"],
    (message) => logs.push(message),
    sdkAttempt,
  );
  expect((await agent.resolve(input())).kind).toBe("needs-human");
  expect(calls).toBe(1 + TRIAGE_RETRY_COUNT);
  expect(logs[0]).toContain("retrying");
});

test("valid SDK output succeeds without retry", async () => {
  let calls = 0;
  const sdkAttempt: TriageSdkAttempt = async () => {
    calls += 1;
    return { text: VALID, error: null };
  };
  const agent = new ClaudeTriageAgent(
    "/tmp/repo",
    ["apps/leaky-service/src"],
    () => {},
    sdkAttempt,
  );
  expect(await agent.resolve(input())).toMatchObject({ kind: "authorized" });
  expect(calls).toBe(1);
});

test("captures SDK usage and isolates cost samples per incident", async () => {
  expect(costFromSdkResult({
    usage: { input_tokens: 4321, output_tokens: 765 },
    total_cost_usd: 0.0842,
    modelUsage: { sonnet: {} },
  })).toEqual({
    harness: "claude-agent-sdk",
    model: "sonnet",
    inputTokens: 4321,
    outputTokens: 765,
    usd: 0.0842,
  });

  const sdkAttempt: TriageSdkAttempt = async () => ({
    text: VALID,
    error: null,
    cost: { harness: "claude-agent-sdk", usd: 0.01 },
  });
  const agent = new ClaudeTriageAgent(
    "/tmp/repo",
    ["apps/leaky-service/src"],
    () => {},
    sdkAttempt,
  );
  await agent.resolve(input());
  expect(agent.takeAgentCalls().map((call) => call.cost?.usd)).toEqual([0.01]);
  expect(agent.takeAgentCalls()).toEqual([]);
});
