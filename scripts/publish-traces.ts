/**
 * Publish sweep RunTrace files into docs/runs-data.js for the runs dashboard.
 *
 * Usage:
 *   bun run scripts/publish-traces.ts
 *   bun run scripts/publish-traces.ts traces/sweep-baseline.json traces/sweep-grok-low.json
 *   bun run publish:traces
 *
 * Writes docs/runs-data.js with:
 *   window.BUGLOOP_RUNS = [{ label, trace }, ...];
 *   window.BUGLOOP_PRICES = { ... };
 *   window.BUGLOOP_PRICES_META = { ... };
 */

import { basename, resolve } from "node:path";
import { readdir } from "node:fs/promises";
import type { CostSample, PipelineKind, RunTrace, TraceEvent } from "@bug-loop/core/trace";

export interface ModelPrice {
  inPerM: number;
  outPerM: number;
}

export interface PricesMeta {
  asOf: string;
  sources: string[];
  note: string;
  notes: Record<string, string>;
}

export interface PublishedRun {
  label: string;
  trace: RunTrace;
}

/** USD per million tokens (input / output). Verified list prices as of 2026-07-14. */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "grok-4.5": { inPerM: 2.0, outPerM: 6.0 },
  "gpt-5.6-sol": { inPerM: 5.0, outPerM: 30.0 },
  "gpt-5.6-terra": { inPerM: 2.5, outPerM: 15.0 },
  "gpt-5.6-luna": { inPerM: 1.0, outPerM: 6.0 },
  "claude-sonnet-5": { inPerM: 3.0, outPerM: 15.0 },
  // Alias used by BUGLOOP_TRIAGE_MODEL / Claude Agent SDK shorthand
  sonnet: { inPerM: 3.0, outPerM: 15.0 },
  "claude-haiku-4-5": { inPerM: 1.0, outPerM: 5.0 },
  haiku: { inPerM: 1.0, outPerM: 5.0 },
  // Exact model id observed in sweep cost samples (Anthropic dated snapshot id)
  "claude-haiku-4-5-20251001": { inPerM: 1.0, outPerM: 5.0 },
  "claude-opus-4-8": { inPerM: 5.0, outPerM: 25.0 },
  opus: { inPerM: 5.0, outPerM: 25.0 },
};

export const DEFAULT_PRICES_META: PricesMeta = {
  asOf: "2026-07-14",
  sources: [
    "xAI docs.x.ai/docs/models (grok)",
    "OpenAI developers.openai.com/api/docs/pricing (gpt-5.6)",
    "Anthropic platform docs cached 2026-06-24 (claude)",
  ],
  note: "Enterprise API list prices — for subscription users this is the API-equivalent cost of the same tokens.",
  notes: {
    "grok-4.5":
      "Under-200K-token prompt rate (2.00/6.00 USD per MTok); at/above 200K is 4.00/12.00 — this table uses the under-200K rate.",
    "claude-sonnet-5":
      "Standard rate 3.00/15.00 USD per MTok; intro pricing 2.00/10.00 through 2026-08-31.",
  },
};

const PIPELINES = new Set<PipelineKind>(["langgraph", "agent-sdk"]);
const HARNESSES = new Set<CostSample["harness"]>(["claude-agent-sdk", "codex", "grok"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseCostSample(value: unknown, path: string): CostSample {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const harness = value["harness"];
  if (typeof harness !== "string" || !HARNESSES.has(harness as CostSample["harness"])) {
    throw new Error(`${path}.harness is invalid`);
  }
  const model = value["model"];
  if (model !== undefined && typeof model !== "string") {
    throw new Error(`${path}.model must be a string`);
  }
  for (const key of ["inputTokens", "outputTokens", "usd"] as const) {
    if (value[key] !== undefined && !nonNegative(value[key])) {
      throw new Error(`${path}.${key} must be a non-negative number`);
    }
  }
  const raw = value["raw"];
  if (raw !== undefined && typeof raw !== "string") {
    throw new Error(`${path}.raw must be a string`);
  }
  return {
    harness: harness as CostSample["harness"],
    ...(typeof model === "string" ? { model } : {}),
    ...(nonNegative(value["inputTokens"]) ? { inputTokens: value["inputTokens"] } : {}),
    ...(nonNegative(value["outputTokens"]) ? { outputTokens: value["outputTokens"] } : {}),
    ...(nonNegative(value["usd"]) ? { usd: value["usd"] } : {}),
    ...(typeof raw === "string" ? { raw } : {}),
  };
}

function parseTraceEvent(value: unknown, path: string): TraceEvent {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (!Number.isInteger(value["seq"])) throw new Error(`${path}.seq must be an integer`);
  for (const key of ["stage", "startedAt", "outcome"] as const) {
    if (typeof value[key] !== "string") throw new Error(`${path}.${key} must be a string`);
  }
  if (!Number.isFinite(Date.parse(value["startedAt"] as string))) {
    throw new Error(`${path}.startedAt must be a valid date`);
  }
  if (!nonNegative(value["durationMs"])) {
    throw new Error(`${path}.durationMs must be a non-negative number`);
  }
  if (value["fingerprint"] !== undefined && typeof value["fingerprint"] !== "string") {
    throw new Error(`${path}.fingerprint must be a string`);
  }
  if (value["detail"] !== undefined && !isRecord(value["detail"])) {
    throw new Error(`${path}.detail must be an object`);
  }
  const cost =
    value["cost"] === undefined ? undefined : parseCostSample(value["cost"], `${path}.cost`);
  return {
    seq: value["seq"] as number,
    stage: value["stage"] as string,
    startedAt: value["startedAt"] as string,
    durationMs: value["durationMs"] as number,
    outcome: value["outcome"] as string,
    ...(typeof value["fingerprint"] === "string" ? { fingerprint: value["fingerprint"] } : {}),
    ...(isRecord(value["detail"]) ? { detail: value["detail"] } : {}),
    ...(cost === undefined ? {} : { cost }),
  };
}

/** Validate unknown JSON as a RunTrace (dashboard-compatible shape). */
export function parseRunTrace(value: unknown): RunTrace {
  if (!isRecord(value)) throw new Error("trace root must be an object");
  for (const key of ["runId", "startedAt", "finishedAt", "pipeline"] as const) {
    if (typeof value[key] !== "string") throw new Error(`${key} must be a string`);
  }
  if (!Number.isFinite(Date.parse(value["startedAt"] as string))) {
    throw new Error("startedAt must be a valid date");
  }
  if (!Number.isFinite(Date.parse(value["finishedAt"] as string))) {
    throw new Error("finishedAt must be a valid date");
  }
  const pipeline = value["pipeline"] as string;
  if (!PIPELINES.has(pipeline as PipelineKind)) {
    throw new Error("pipeline must be langgraph or agent-sdk");
  }
  if (!isRecord(value["config"])) throw new Error("config must be an object");
  if (!Array.isArray(value["events"])) throw new Error("events must be an array");
  const events = value["events"].map((event, index) =>
    parseTraceEvent(event, `events[${index}]`),
  );
  const label = value["label"];
  if (label !== undefined && typeof label !== "string") {
    throw new Error("label must be a string");
  }
  return {
    runId: value["runId"] as string,
    startedAt: value["startedAt"] as string,
    finishedAt: value["finishedAt"] as string,
    pipeline: pipeline as PipelineKind,
    ...(typeof label === "string" ? { label } : {}),
    config: value["config"] as RunTrace["config"],
    events,
  };
}

/** Label from basename: strip .json and optional sweep- prefix. */
export function labelFromFilename(path: string): string {
  const base = basename(path).replace(/\.json$/i, "");
  const trimmed = base.startsWith("sweep-") ? base.slice("sweep-".length) : base;
  return trimmed || base || "unnamed-run";
}

/** Prefer trace.label when non-empty; otherwise derive from the file path. */
export function labelForTrace(trace: RunTrace, path: string): string {
  const fromTrace = trace.label?.trim();
  if (fromTrace) return fromTrace;
  return labelFromFilename(path);
}

export async function resolveTracePaths(argv: string[]): Promise<string[]> {
  if (argv.length > 0) {
    return argv.map((path) => resolve(path));
  }
  const tracesDir = resolve("traces");
  const entries = await readdir(tracesDir).catch(() => [] as string[]);
  return entries
    .filter((name) => name.startsWith("sweep-") && name.endsWith(".json"))
    .map((name) => resolve(tracesDir, name))
    .sort();
}

export function buildRunsDataSource(
  runs: PublishedRun[],
  prices: Record<string, ModelPrice> = DEFAULT_PRICES,
  meta: PricesMeta = DEFAULT_PRICES_META,
): string {
  const body = [
    "/* Generated by scripts/publish-traces.ts — do not edit by hand. */",
    `window.BUGLOOP_RUNS = ${JSON.stringify(runs, null, 2)};`,
    `window.BUGLOOP_PRICES = ${JSON.stringify(prices, null, 2)};`,
    `window.BUGLOOP_PRICES_META = ${JSON.stringify(meta, null, 2)};`,
    "",
  ].join("\n");
  return body;
}

export async function loadPublishedRuns(paths: string[]): Promise<PublishedRun[]> {
  const runs: PublishedRun[] = [];
  for (const path of paths) {
    const raw: unknown = await Bun.file(path).json();
    const trace = parseRunTrace(raw);
    runs.push({ label: labelForTrace(trace, path), trace });
  }
  return runs;
}

export async function publishTraces(
  argv: string[] = process.argv.slice(2),
  outputPath = resolve("docs/runs-data.js"),
): Promise<{ runs: PublishedRun[]; outputPath: string }> {
  const paths = await resolveTracePaths(argv);
  if (paths.length === 0) {
    throw new Error("No sweep traces found. Pass paths or place files at traces/sweep-*.json");
  }
  const runs = await loadPublishedRuns(paths);
  const source = buildRunsDataSource(runs);
  await Bun.write(outputPath, source);
  return { runs, outputPath };
}

if (import.meta.main) {
  publishTraces()
    .then(({ runs, outputPath }) => {
      console.log(`Wrote ${runs.length} run(s) to ${outputPath}`);
      for (const run of runs) {
        console.log(`  - ${run.label} (${run.trace.pipeline}, ${run.trace.events.length} events)`);
      }
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
