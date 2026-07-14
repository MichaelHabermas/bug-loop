import { expect, test } from "bun:test";
import {
  FIX_SUMMARY_MARKER,
  GrokTestWriter,
  buildTestWriterPrompt,
  type Incident,
  type ProcessResult,
  type ProcessRunner,
  type TestWriteInput,
} from "../src";

const incident: Incident = {
  fingerprint: {
    hash: "abcdef0123456789",
    errName: "TypeError",
    topFrame: "handleCreate (apps/leaky-service/src/server.ts:10:1)",
    route: "POST /orders",
  },
  sampleEvents: [],
  count: 1,
  firstSeen: "2026-07-14T00:00:00.000Z",
  lastSeen: "2026-07-14T00:00:00.000Z",
};

function input(): TestWriteInput {
  return {
    worktreeDir: "/tmp/worktree",
    incident,
    repro: { reproduced: true, command: "curl example.test", evidence: "HTTP 500" },
    assertionSpec: {
      warranted: true,
      reason: "missing coverage",
      mustPin: ["status is outside the 5xx class", "TypeError signature is absent"],
      mustNotPin: ["exact response message text", "generated IDs"],
      suggestedLocation: "apps/leaky-service/test/orders.test.ts",
    },
    attempt: 2,
    previousFailure: "test passed against the base revision",
  };
}

test("TestWriter prompt enforces one scoped, durable, non-snapshot test", () => {
  const prompt = buildTestWriterPrompt(input(), ["apps/leaky-service/test"]);
  expect(prompt).toContain("Write ONE focused regression test");
  expect(prompt).toContain("Edit only test files inside: apps/leaky-service/test");
  expect(prompt).toContain("Do not edit source files");
  expect(prompt).toContain("Snapshot tests are forbidden");
  expect(prompt).toContain("Exact-message assertions are forbidden");
  expect(prompt).toContain("status is outside the 5xx class");
  expect(prompt).toContain("test passed against the base revision");
  expect(prompt).toContain(FIX_SUMMARY_MARKER);
});

test("GrokTestWriter mirrors CliFixer output and cost behavior", async () => {
  const calls: string[][] = [];
  const runner: ProcessRunner = async (command): Promise<ProcessResult> => {
    calls.push(command);
    if (command[0] === "grok") {
      return {
        exitCode: 0,
        stdout: [
          "input tokens: 120",
          "output tokens: 30",
          FIX_SUMMARY_MARKER,
          "Added a missing-customer regression test.",
        ].join("\n"),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: "?? apps/leaky-service/test/missing-customer.test.ts\n",
      stderr: "",
    };
  };
  const writer = new GrokTestWriter(["apps/leaky-service/test"], runner);
  const output = await writer.write(input());
  expect(calls[0]?.slice(0, 2)).toEqual(["grok", "-p"]);
  expect(output).toEqual({
    description: "Added a missing-customer regression test.",
    filesChanged: ["apps/leaky-service/test/missing-customer.test.ts"],
  });
  expect(writer.takeCost()).toMatchObject({
    harness: "grok",
    inputTokens: 120,
    outputTokens: 30,
  });
});
