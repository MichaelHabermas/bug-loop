import { expect, test } from "bun:test";
import {
  extractFixSummary,
  FIX_SUMMARY_MARKER,
  GrokFixer,
  parseCliCost,
  type ProcessResult,
  type ProcessRunner,
} from "../src";

test("GrokFixer passes the prompt as -p and reports git porcelain changes", async () => {
  const calls: Array<{ command: string[]; cwd: string }> = [];
  const runner: ProcessRunner = async (command, options): Promise<ProcessResult> => {
    calls.push({ command, cwd: options.cwd });
    if (command[0] === "grok") {
      return { exitCode: 0, stdout: "Guarded missing customer input.", stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: " M apps/leaky-service/src/server.ts\n",
      stderr: "",
    };
  };
  const fixer = new GrokFixer(["apps/leaky-service/src"], runner);

  const output = await fixer.fix({
    worktreeDir: "/tmp/bug-loop-worktree",
    issueTitle: "TypeError on POST /orders",
    issueBody: "HTTP 500",
    attempt: 2,
    fixBrief: "The likely root cause is handleCreate in apps/leaky-service/src/server.ts. Validate customer before reading its id.",
    previousFailure: "TypeError signature still present",
  });

  expect(calls).toHaveLength(2);
  expect(calls[0]?.command.slice(0, 2)).toEqual(["grok", "-p"]);
  expect(calls[0]?.cwd).toBe("/tmp/bug-loop-worktree");
  expect(calls[0]?.command[2]).toContain("<triageFixBrief>");
  expect(calls[0]?.command[2]).toContain("handleCreate in apps/leaky-service/src/server.ts");
  expect(calls[0]?.command[2]).toContain("TypeError signature still present");
  expect(calls[0]?.command[2]).toContain(FIX_SUMMARY_MARKER);
  expect(calls[1]?.command).toEqual([
    "git",
    "-C",
    "/tmp/bug-loop-worktree",
    "status",
    "--porcelain",
  ]);
  expect(output).toEqual({
    description: "Guarded missing customer input.",
    filesChanged: ["apps/leaky-service/src/server.ts"],
  });
});

test("extractFixSummary strips narration before the marker", () => {
  const stdout = [
    "I'll inspect the failing handler...",
    "Checking how the request body is parsed...",
    FIX_SUMMARY_MARKER,
    "Root cause: missing null guard on customer.",
    "Changed handleCreate to return 400 when customer is absent.",
  ].join("\n");

  expect(extractFixSummary(stdout)).toBe(
    "Root cause: missing null guard on customer.\nChanged handleCreate to return 400 when customer is absent.",
  );
});

test("extractFixSummary uses the last marker when present multiple times", () => {
  const stdout = [
    "Working...",
    FIX_SUMMARY_MARKER,
    "Draft summary that should be ignored.",
    "More work...",
    FIX_SUMMARY_MARKER,
    "Final root cause and what changed.",
  ].join("\n");

  expect(extractFixSummary(stdout)).toBe("Final root cause and what changed.");
});

test("extractFixSummary falls back to full stdout when marker is absent", () => {
  const stdout = "  Guarded missing customer input.  \n";
  expect(extractFixSummary(stdout)).toBe("Guarded missing customer input.");
});

test("extractFixSummary falls back to full stdout when marker has empty tail", () => {
  const stdout = [
    "I'll inspect the failing handler...",
    "Made the change.",
    FIX_SUMMARY_MARKER,
    "",
  ].join("\n");

  expect(extractFixSummary(stdout)).toBe(stdout.trim());
  expect(extractFixSummary(stdout)).not.toBe("");
});

test("GrokFixer uses extractFixSummary for description", async () => {
  const runner: ProcessRunner = async (command): Promise<ProcessResult> => {
    if (command[0] === "grok") {
      return {
        exitCode: 0,
        stdout: [
          "I'll inspect the failing handler...Checking how...",
          FIX_SUMMARY_MARKER,
          "Guarded missing customer input.",
        ].join("\n"),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: " M apps/leaky-service/src/server.ts\n",
      stderr: "",
    };
  };
  const fixer = new GrokFixer(["apps/leaky-service/src"], runner);
  const output = await fixer.fix({
    worktreeDir: "/tmp/bug-loop-worktree",
    issueTitle: "TypeError on POST /orders",
    issueBody: "HTTP 500",
    attempt: 1,
  });
  expect(output.description).toBe("Guarded missing customer input.");
  expect(output.description).not.toContain("I'll inspect");
});

test("parseCliCost captures only usage present in CLI stdout fixtures", async () => {
  const codex = parseCliCost(
    await Bun.file(new URL("./fixtures/codex-stdout.txt", import.meta.url)).text(),
    "codex",
  );
  expect(codex).toMatchObject({
    harness: "codex",
    model: "gpt-5.5-codex",
    inputTokens: 12345,
    outputTokens: 678,
  });
  expect(codex?.raw).toContain("tokens used");

  const grok = parseCliCost(
    await Bun.file(new URL("./fixtures/grok-stdout.txt", import.meta.url)).text(),
    "grok",
  );
  expect(grok).toMatchObject({
    harness: "grok",
    inputTokens: 2100,
    outputTokens: 450,
    usd: 0.031,
  });
  expect(parseCliCost("No usage was printed.", "codex")).toBeUndefined();
});
