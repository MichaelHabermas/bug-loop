import { expect, test } from "bun:test";
import { mapWithConcurrency } from "../src";

test("mapWithConcurrency rejects invalid worker counts", async () => {
  expect(mapWithConcurrency([1], 0, async (value) => value)).rejects.toThrow(
    "concurrency must be a positive integer",
  );
  expect(mapWithConcurrency([1], 1.5, async (value) => value)).rejects.toThrow(
    "concurrency must be a positive integer",
  );
});
