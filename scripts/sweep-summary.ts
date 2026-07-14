/**
 * Summarize cost-sweep RunTrace files for comparison.
 *
 * Usage:
 *   bun run scripts/sweep-summary.ts traces/sweep-baseline.json traces/sweep-grok-low.json
 *   bun run scripts/sweep-summary.ts   # discovers traces/sweep-*.json
 */

import { basename, resolve } from "node:path";
import { readdir } from "node:fs/promises";

interface CostSample {
  harness?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  usd?: number;
  raw?: string;
}

interface TraceEvent {
  stage: string;
  outcome: string;
  durationMs: number;
  cost?: CostSample;
}

interface RunTrace {
  startedAt: string;
  finishedAt: string;
  pipeline?: string;
  config?: {
    fixer?: string;
  };
  events: TraceEvent[];
}

interface SweepRow {
  config: string;
  path: string;
  fixesAttempted: number;
  fixesVerified: number;
  totalDurationMs: number;
  costSamples: number;
  error?: string;
}

function configNameFromPath(path: string): string {
  const base = basename(path, ".json");
  return base.startsWith("sweep-") ? base.slice("sweep-".length) : base;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTraceEvent(value: unknown): value is TraceEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value["stage"] === "string" &&
    typeof value["outcome"] === "string" &&
    typeof value["durationMs"] === "number"
  );
}

function parseRunTrace(value: unknown): RunTrace {
  if (!isRecord(value)) throw new Error("trace root must be an object");
  const { startedAt, finishedAt, events } = value;
  if (typeof startedAt !== "string" || typeof finishedAt !== "string") {
    throw new Error("trace must include startedAt and finishedAt strings");
  }
  if (!Array.isArray(events)) throw new Error("trace.events must be an array");
  if (!events.every(isTraceEvent)) {
    throw new Error("trace.events contains invalid event objects");
  }
  const config = isRecord(value["config"]) ? value["config"] : undefined;
  return {
    startedAt,
    finishedAt,
    ...(typeof value["pipeline"] === "string" ? { pipeline: value["pipeline"] } : {}),
    ...(config === undefined
      ? {}
      : {
          config: {
            ...(typeof config["fixer"] === "string" ? { fixer: config["fixer"] } : {}),
          },
        }),
    events,
  };
}

function summarizeTrace(path: string, trace: RunTrace): SweepRow {
  const fixesAttempted = trace.events.filter((event) => event.stage === "fix").length;
  const fixesVerified = trace.events.filter(
    (event) => event.stage === "verify" && event.outcome === "verified",
  ).length;
  const costSamples = trace.events.filter((event) => event.cost !== undefined).length;
  const started = Date.parse(trace.startedAt);
  const finished = Date.parse(trace.finishedAt);
  const totalDurationMs =
    Number.isFinite(started) && Number.isFinite(finished)
      ? Math.max(0, finished - started)
      : trace.events.reduce((sum, event) => sum + event.durationMs, 0);

  return {
    config: configNameFromPath(path),
    path,
    fixesAttempted,
    fixesVerified,
    totalDurationMs,
    costSamples,
  };
}

async function resolveTracePaths(argv: string[]): Promise<string[]> {
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds - minutes * 60;
  return `${minutes}m${rem.toFixed(0).padStart(2, "0")}s`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function printTable(rows: SweepRow[]): void {
  const headers = [
    "config",
    "fixes attempted",
    "fixes verified",
    "total duration",
    "cost samples",
  ] as const;

  const cells = rows.map((row) => {
    if (row.error !== undefined) {
      return [
        row.config,
        "—",
        "—",
        "—",
        `error: ${row.error}`,
      ];
    }
    return [
      row.config,
      String(row.fixesAttempted),
      String(row.fixesVerified),
      formatDuration(row.totalDurationMs),
      String(row.costSamples),
    ];
  });

  const widths = headers.map((header, col) =>
    Math.max(header.length, ...cells.map((row) => row[col]?.length ?? 0)),
  );

  const line = (parts: string[]) =>
    parts.map((part, index) => pad(part, widths[index] ?? 0)).join("  ");

  console.log(line([...headers]));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of cells) console.log(line(row));
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const paths = await resolveTracePaths(argv);
  if (paths.length === 0) {
    console.error("No sweep traces found. Pass paths or place files at traces/sweep-*.json");
    process.exitCode = 1;
    return;
  }

  const rows: SweepRow[] = [];
  for (const path of paths) {
    try {
      const raw: unknown = await Bun.file(path).json();
      const trace = parseRunTrace(raw);
      rows.push(summarizeTrace(path, trace));
    } catch (error) {
      rows.push({
        config: configNameFromPath(path),
        path,
        fixesAttempted: 0,
        fixesVerified: 0,
        totalDurationMs: 0,
        costSamples: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  printTable(rows);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
