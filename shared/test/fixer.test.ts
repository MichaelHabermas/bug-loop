import { expect, test } from "bun:test";
import {
  GrokFixer,
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
  const fixer = new GrokFixer(runner);

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
