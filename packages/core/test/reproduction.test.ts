import { expect, test } from "bun:test";
import {
  fingerprintEvent,
  reproduceIncident,
  type Incident,
  type LogEvent,
  type ReproStrategy,
} from "../src";

const event: LogEvent = {
  ts: "2026-07-14T00:00:00.000Z",
  level: "error",
  msg: "handler failed",
  route: "POST /widgets",
  err: { name: "TypeError", message: "missing widget" },
};
const incident: Incident = {
  fingerprint: fingerprintEvent(event),
  sampleEvents: [event],
  count: 1,
  firstSeen: event.ts,
  lastSeen: event.ts,
};

test("reproduction delegates derivation and execution to the injected strategy", async () => {
  let derived = false;
  const strategy: ReproStrategy = {
    derive(input) {
      derived = input.sample === event;
      return {
        command: "curl -X POST http://localhost:3000/widgets",
        async reproduce() {
          return { reproduced: true, evidence: "HTTP 500" };
        },
        async verify() {
          return { passes: true, detail: "signature absent" };
        },
      };
    },
  };
  const result = await reproduceIncident({
    logPath: "logs/app.jsonl",
    baseUrl: "http://localhost:3000",
    incident,
  }, strategy);
  expect(derived).toBe(true);
  expect(result).toEqual({
    reproduced: true,
    command: "curl -X POST http://localhost:3000/widgets",
    evidence: "HTTP 500",
  });
});

test("reproduction safely declines when no strategy can derive a request", async () => {
  const result = await reproduceIncident({
    logPath: "logs/app.jsonl",
    baseUrl: "http://localhost:3000",
    incident,
  });
  expect(result.reproduced).toBe(false);
  expect(result.command).toBe("");
  expect(result.evidence).toContain("No reproduction could be derived");
});
