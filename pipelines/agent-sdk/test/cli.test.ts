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
    baseUrl: "http://localhost:3000",
    tracePath: "traces/custom.json",
  });
});

test("parses optional --label and leaves it unset when omitted", () => {
  expect(parseArgs(["--label", "baseline"])).toEqual({
    fromStart: false,
    fix: false,
    live: false,
    baseUrl: "http://localhost:3000",
    label: "baseline",
  });
  expect(parseArgs([])).not.toHaveProperty("label");
  expect(() => parseArgs(["--label"])).toThrow("--label requires a name");
});
