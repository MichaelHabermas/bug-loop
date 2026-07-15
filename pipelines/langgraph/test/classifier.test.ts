import { describe, expect, test } from "bun:test";
import type { LogEvent, TriageState } from "@bug-loop/core";
import { detectStructured } from "../src/nodes/detect";

function event(overrides: Partial<LogEvent>): LogEvent {
  return {
    ts: "2026-07-13T12:00:00.000Z",
    level: "info",
    msg: "order created",
    ...overrides,
  };
}

function state(events: LogEvent[]): TriageState {
  return {
    logPath: "logs/app.jsonl",
    events,
    incidents: [],
    retryCount: 0,
    errors: [],
  };
}

describe("structured LangGraph detection", () => {
  test("selects errors and configured invariant warnings by level and prefix", async () => {
    const result = await detectStructured(state([
      event({ level: "error" }),
      event({ level: "warn", msg: "order total negative; policy unclear" }),
      event({ level: "warn", msg: "slow request" }),
      event({}),
    ]), ["order total negative"]);
    expect(result.actionableEvents).toHaveLength(2);
    expect(result.actionableEvents?.map((item) => item.level)).toEqual(["error", "warn"]);
  });

  test("does not expose an event classifier dependency", async () => {
    expect(detectStructured.length).toBeGreaterThanOrEqual(2);
    const source = await Bun.file(new URL("../src/nodes/detect.ts", import.meta.url)).text();
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("Classifier");
  });
});
