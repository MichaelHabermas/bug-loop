import { expect, test } from "bun:test";
import {
  CodexFixer,
  configuredCodexModel,
  configuredGrokEffort,
  extractFixSummary,
  FIX_SUMMARY_MARKER,
  GrokFixer,
  parseCliCost,
  parseGrokJsonOutput,
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

test("GrokFixer passes --effort when configured", async () => {
  const calls: Array<{ command: string[] }> = [];
  const runner: ProcessRunner = async (command): Promise<ProcessResult> => {
    calls.push({ command });
    if (command[0] === "grok") {
      return { exitCode: 0, stdout: "Fixed.", stderr: "" };
    }
    return { exitCode: 0, stdout: " M apps/leaky-service/src/server.ts\n", stderr: "" };
  };
  const fixer = new GrokFixer(["apps/leaky-service/src"], runner, "low");
  await fixer.fix({
    worktreeDir: "/tmp/bug-loop-worktree",
    issueTitle: "bug",
    issueBody: "body",
    attempt: 1,
  });
  expect(calls[0]?.command.slice(0, 4)).toEqual(["grok", "--effort", "low", "-p"]);
});

test("CodexFixer passes -m when model is configured", async () => {
  const calls: Array<{ command: string[] }> = [];
  const runner: ProcessRunner = async (command): Promise<ProcessResult> => {
    calls.push({ command });
    if (command[0] === "codex") {
      return { exitCode: 0, stdout: "Fixed.", stderr: "" };
    }
    return { exitCode: 0, stdout: " M apps/leaky-service/src/server.ts\n", stderr: "" };
  };
  const fixer = new CodexFixer(["apps/leaky-service/src"], runner, "gpt-5.6-luna");
  await fixer.fix({
    worktreeDir: "/tmp/bug-loop-worktree",
    issueTitle: "bug",
    issueBody: "body",
    attempt: 1,
  });
  expect(calls[0]?.command.slice(0, 6)).toEqual([
    "codex",
    "exec",
    "--full-auto",
    "-m",
    "gpt-5.6-luna",
    "-C",
  ]);
  expect(calls[0]?.command[6]).toBe("/tmp/bug-loop-worktree");
});

test("CodexFixer omits -m when model is undefined", async () => {
  const calls: Array<{ command: string[] }> = [];
  const runner: ProcessRunner = async (command): Promise<ProcessResult> => {
    calls.push({ command });
    if (command[0] === "codex") {
      return { exitCode: 0, stdout: "Fixed.", stderr: "" };
    }
    return { exitCode: 0, stdout: " M apps/leaky-service/src/server.ts\n", stderr: "" };
  };
  const fixer = new CodexFixer(["apps/leaky-service/src"], runner, undefined);
  await fixer.fix({
    worktreeDir: "/tmp/bug-loop-worktree",
    issueTitle: "bug",
    issueBody: "body",
    attempt: 1,
  });
  expect(calls[0]?.command.slice(0, 5)).toEqual([
    "codex",
    "exec",
    "--full-auto",
    "-C",
    "/tmp/bug-loop-worktree",
  ]);
});

test("configuredGrokEffort reads and validates BUGLOOP_GROK_EFFORT", () => {
  expect(configuredGrokEffort({})).toBeUndefined();
  expect(configuredGrokEffort({ BUGLOOP_GROK_EFFORT: "" })).toBeUndefined();
  expect(configuredGrokEffort({ BUGLOOP_GROK_EFFORT: "low" })).toBe("low");
  expect(configuredGrokEffort({ BUGLOOP_GROK_EFFORT: "max" })).toBe("max");
  expect(() => configuredGrokEffort({ BUGLOOP_GROK_EFFORT: "turbo" })).toThrow(
    /BUGLOOP_GROK_EFFORT must be one of/,
  );
});

test("configuredCodexModel reads BUGLOOP_CODEX_MODEL", () => {
  expect(configuredCodexModel({})).toBeUndefined();
  expect(configuredCodexModel({ BUGLOOP_CODEX_MODEL: "" })).toBeUndefined();
  expect(configuredCodexModel({ BUGLOOP_CODEX_MODEL: "gpt-5.6-luna" })).toBe("gpt-5.6-luna");
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
    model: "gpt-5.6-luna",
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

test("parseCliCost tolerates realistic codex total-only footer with commas and model line", async () => {
  const codex = parseCliCost(
    await Bun.file(new URL("./fixtures/codex-stdout-total-only.txt", import.meta.url)).text(),
    "codex",
  );
  expect(codex).toMatchObject({
    harness: "codex",
    model: "gpt-5.6-luna",
  });
  expect(codex?.inputTokens).toBeUndefined();
  expect(codex?.outputTokens).toBeUndefined();
  expect(codex?.raw).toContain("tokens used");
  expect(codex?.raw).toContain("45,678");
});

test("parseCliCost accepts inline tokens-used and bullet-prefixed lines", () => {
  const inline = parseCliCost("model: gpt-5.6-luna\ntokens used: 1,234\n", "codex");
  expect(inline).toMatchObject({ harness: "codex", model: "gpt-5.6-luna" });
  expect(inline?.raw).toMatch(/tokens used/i);

  const bullet = parseCliCost("• tokens used: 9,876\n", "codex");
  expect(bullet).toMatchObject({ harness: "codex" });
  expect(bullet?.raw).toMatch(/9,876/);
});

test("parseGrokJsonOutput extracts text but finds no usage on documented envelope", () => {
  const parsed = parseGrokJsonOutput(JSON.stringify({
    text: `${FIX_SUMMARY_MARKER}\nGuarded input.`,
    stopReason: "EndTurn",
    sessionId: "abc123",
    requestId: "xyz789",
  }));
  expect(parsed?.text).toContain(FIX_SUMMARY_MARKER);
  expect(parsed?.cost).toBeUndefined();
  expect(extractFixSummary(parsed?.text ?? "")).toBe("Guarded input.");
});

test("parseGrokJsonOutput captures usage when a future envelope includes it", () => {
  const parsed = parseGrokJsonOutput(JSON.stringify({
    text: "done",
    model: "grok-code",
    usage: { input_tokens: 100, output_tokens: 20, total_cost_usd: 0.01 },
  }));
  expect(parsed?.cost).toMatchObject({
    harness: "grok",
    model: "grok-code",
    inputTokens: 100,
    outputTokens: 20,
    usd: 0.01,
  });
});
