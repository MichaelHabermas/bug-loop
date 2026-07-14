import { resolve } from "node:path";
import {
  TraceRecorder,
  definePipelineConfig,
  groupIncidents,
  parseCliCost,
  readNewEvents,
} from "../src";

const repoRoot = resolve(import.meta.dir, "../../..");
const fixturePath = resolve(repoRoot, "pipelines/langgraph/test/fixtures/all-bugs.jsonl");
const codexFixturePath = resolve(import.meta.dir, "../test/fixtures/codex-stdout.txt");
const outputPath = resolve(repoRoot, "traces/example-run.json");
const events = (await readNewEvents(fixturePath)).events;
const incidents = groupIncidents(events);
let tick = 0;
const now = () => new Date(Date.parse("2026-07-14T12:00:00.000Z") + tick++ * 17);
const config = definePipelineConfig({
  repo: "MichaelHabermas/bug-loop",
  labels: {
    pipeline: "bug-loop",
    mechanical: "auto-fix-candidate",
    needsHuman: "needs-human",
  },
  logPath: "logs/leaky-service.jsonl",
  baseUrl: "http://127.0.0.1:3000",
  cursorPath: "pipelines/langgraph/.cursor.json",
  fixScope: ["apps/leaky-service/src"],
  worktreeRoot: ".worktrees",
  maxFixAttempts: 2,
  fixer: "codex",
  invariantWarnPrefixes: ["order total negative"],
});
const recorder = new TraceRecorder({
  pipeline: "langgraph",
  config,
  outputPath,
  runId: "example-langgraph-run",
  now,
});

const record = (
  stage: string,
  outcome: string,
  detail: Record<string, unknown>,
  fingerprint?: string,
) => {
  const handle = recorder.start(stage, fingerprint);
  handle.finish(outcome, detail);
};

record("ingest", `${events.length} events`, { events: events.length });
record("detect", `${events.length} actionable`, { actionable: events.length });
record("dedupe", `${incidents.length} new incidents`, {
  incidents: incidents.length,
  newIncidents: incidents.length,
});
record("reproduce", "3 reproduced", { reproduced: 3 });
record("route", "3 mechanical", { mechanical: 3, needsHuman: 1 });
record("ticket", "4 issues", { issuesFiled: 4 });

const fixed = incidents.find((incident) => incident.fingerprint.errName === "TypeError");
if (!fixed) throw new Error("fixture did not contain the TypeError incident");
const fix = recorder.start("fix", fixed.fingerprint.hash);
fix.finish(
  "attempt 1",
  { attempt: 1, filesChanged: ["apps/leaky-service/src/server.ts"] },
  parseCliCost(await Bun.file(codexFixturePath).text(), "codex"),
);
record("verify", "verified", {
  attempt: 1,
  scopePasses: true,
  reproPasses: true,
  testsPass: true,
  typecheckPasses: true,
}, fixed.fingerprint.hash);
record("pr", "completed", { issueNumber: 1, pullRequestNumber: 5 }, fixed.fingerprint.hash);

await recorder.finish();
