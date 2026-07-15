import { expect, test } from "bun:test";
import { parseArgs } from "../src/index";

test("parses --trace without changing existing CLI options", () => {
  expect(parseArgs([
    "--from-start",
    "--fix",
    "--base",
    "http://localhost:3000/",
    "--trace",
    "traces/custom.json",
  ])).toEqual({
    fromStart: true,
    fix: true,
    live: false,
    watch: false,
    baseUrl: "http://localhost:3000",
    tracePath: "traces/custom.json",
  });
});

test("parses optional --label and leaves it unset when omitted", () => {
  expect(parseArgs(["--label", "baseline"])).toEqual({
    fromStart: false,
    fix: false,
    live: false,
    watch: false,
    baseUrl: "http://localhost:3000",
    label: "baseline",
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
  expect(parseArgs(["--watch", "--fix"])).toMatchObject({
    watch: true,
    fix: true,
    live: false,
    fromStart: false,
  });
});

test("refuses --from-start with --watch", () => {
  expect(() => parseArgs(["--watch", "--from-start"])).toThrow(
    /--watch cannot be combined with --from-start/,
  );
});
