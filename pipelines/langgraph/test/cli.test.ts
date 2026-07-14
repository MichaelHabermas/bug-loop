import { expect, test } from "bun:test";
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
    baseUrl: "http://localhost:3000",
    tracePath: "traces/custom.json",
  });
});
