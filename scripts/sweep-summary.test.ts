import { expect, test } from "bun:test";
import { summarizeTrace } from "./sweep-summary";

test("separates initial fixes from retries and sums known USD", () => {
  const row = summarizeTrace("traces/sweep-v1.json", {
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T00:00:02.000Z",
    events: [
      {
        stage: "fix",
        fingerprint: "a",
        outcome: "attempt 1",
        durationMs: 500,
        cost: { usd: 0.1 },
      },
      {
        stage: "fix",
        fingerprint: "a",
        outcome: "attempt 2",
        durationMs: 600,
        cost: { usd: 0.2 },
      },
      {
        stage: "fix",
        fingerprint: "b",
        outcome: "attempt 1",
        durationMs: 400,
      },
      { stage: "verify", outcome: "verified", durationMs: 100 },
    ],
  });

  expect(row).toMatchObject({
    fixesAttempted: 2,
    retries: 1,
    fixesVerified: 1,
    totalDurationMs: 2000,
    dominantSeam: "fix",
  });
  expect(row.knownUsd).toBeCloseTo(0.3);
});

test("uses v2 agent calls for spend without double-counting event costs", () => {
  const row = summarizeTrace("traces/sweep-v2.json", {
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T00:00:01.000Z",
    events: [{
      stage: "fix",
      fingerprint: "a",
      outcome: "attempt 1",
      durationMs: 500,
      cost: { usd: 9 },
    }],
    agentCalls: [
      { stage: "triage", usage: { status: "reported", usd: 0.5 } },
      { stage: "fixer", usage: { status: "reported", usd: 0.2 } },
      { stage: "testWriter", usage: { status: "unavailable", reason: "not reported" } },
    ],
  });

  expect(row.knownUsd).toBeCloseTo(0.7);
  expect(row.dominantSeam).toBe("triage");
});
