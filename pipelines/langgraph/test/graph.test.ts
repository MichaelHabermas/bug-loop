import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInitialState, createTriageGraph } from "../src/graph";
import { HeuristicClassifier } from "../src/classifier";

const TMP = join(import.meta.dir, ".tmp-graph");
const FIXTURE = join(import.meta.dir, "fixtures", "all-bugs.jsonl");
const originalDryRun = process.env["DRY_RUN"];

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  process.env["DRY_RUN"] = "1";
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  if (originalDryRun === undefined) delete process.env["DRY_RUN"];
  else process.env["DRY_RUN"] = originalDryRun;
});

test("graph processes all four signatures and tolerates an unreachable service", async () => {
  const graph = createTriageGraph({ classifier: new HeuristicClassifier() });
  const result = await graph.invoke(
    createInitialState({
      logPath: FIXTURE,
      cursorPath: join(TMP, "cursor.json"),
      fromStart: true,
      baseUrl: "http://127.0.0.1:1",
    }),
    { configurable: { thread_id: "smoke-test" } },
  );

  expect(result.summary).toEqual({
    eventsRead: 4,
    actionable: 4,
    incidents: 4,
    newIncidents: 4,
    reproduced: 0,
    issuesFiled: 4,
  });
  expect(result.triage).toHaveLength(4);
  expect(result.triage.every((item) => item.ticket !== undefined)).toBe(true);

  const rerun = await graph.invoke(
    createInitialState({
      logPath: FIXTURE,
      cursorPath: join(TMP, "cursor.json"),
      fromStart: false,
      baseUrl: "http://127.0.0.1:1",
    }),
    { configurable: { thread_id: "smoke-test-rerun" } },
  );
  expect(rerun.summary?.eventsRead).toBe(0);
  expect(rerun.summary?.newIncidents).toBe(0);
});
