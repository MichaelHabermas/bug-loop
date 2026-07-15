import { expect, test } from "bun:test";
import { watchTraceOutputPath } from "@bug-loop/core";
import { parseArgs } from "../src/index";

test("parses --trace without changing existing CLI options", () => {
  expect(parseArgs([
    "--from-start",
    "--fix",
    "--live",
    "--base",
    "http://localhost:3000/",
    "--trace",
    "traces/custom.json",
  ])).toEqual({
    fromStart: true,
    fix: true,
    live: true,
    watch: false,
    baseUrl: "http://localhost:3000",
    tracePath: "traces/custom.json",
  });
});

test("parses optional --label and leaves it unset when omitted", () => {
  expect(parseArgs(["--label", "codex-luna"])).toEqual({
    fromStart: false,
    fix: false,
    live: false,
    watch: false,
    baseUrl: "http://localhost:3000",
    label: "codex-luna",
  });
  expect(parseArgs([])).not.toHaveProperty("label");
  expect(() => parseArgs(["--label"])).toThrow("--label requires a name");
});

test("parses --watch and keeps --fix/--live semantics", () => {
  expect(parseArgs(["--watch"])).toEqual({
    fromStart: false,
    fix: false,
    live: false,
    watch: true,
    baseUrl: "http://localhost:3000",
  });
  expect(parseArgs(["--watch", "--fix", "--live"])).toMatchObject({
    watch: true,
    fix: true,
    live: true,
    fromStart: false,
  });
});

test("refuses --from-start with --watch", () => {
  expect(() => parseArgs(["--watch", "--from-start"])).toThrow(
    /--watch cannot be combined with --from-start/,
  );
  expect(() => parseArgs(["--from-start", "--watch"])).toThrow(
    /--watch cannot be combined with --from-start/,
  );
});

test("watch --trace path inserts pass suffix before extension (not after)", () => {
  // langgraph CLI uses watchTraceOutputPath for pass traces.
  expect(watchTraceOutputPath("traces/x.json", 1)).toBe("traces/x.pass1.json");
  expect(watchTraceOutputPath("traces/x.json", 1)).not.toBe("traces/x.json.pass1");
  const args = parseArgs(["--watch", "--trace", "traces/x.json"]);
  expect(args.tracePath).toBe("traces/x.json");
  expect(watchTraceOutputPath(args.tracePath!, 1)).toBe("traces/x.pass1.json");
});
