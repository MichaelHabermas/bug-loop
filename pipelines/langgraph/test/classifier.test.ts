import { describe, expect, test } from "bun:test";
import type { LogEvent } from "@bug-loop/core";
import { HeuristicClassifier } from "../src/classifier";

const classifier = new HeuristicClassifier();

function event(overrides: Partial<LogEvent>): LogEvent {
  return {
    ts: "2026-07-13T12:00:00.000Z",
    level: "info",
    msg: "order created",
    ...overrides,
  };
}

describe("HeuristicClassifier", () => {
  test("marks errors and the negative-total invariant actionable", async () => {
    expect(await classifier.classify(event({ level: "error" }))).toBe(true);
    expect(
      await classifier.classify(
        event({
          level: "warn",
          msg: "order total negative; spec unclear whether discounts may exceed subtotal",
        }),
      ),
    ).toBe(true);
  });

  test("rejects info logs and unrelated warnings", async () => {
    expect(await classifier.classify(event({}))).toBe(false);
    expect(await classifier.classify(event({ level: "warn", msg: "slow request" }))).toBe(
      false,
    );
  });
});
