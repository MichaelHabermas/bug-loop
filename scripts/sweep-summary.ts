import { basename, resolve } from "node:path";
import { readdir } from "node:fs/promises";

interface CostSample {
  usd?: number;
}

interface TraceEvent {
  stage: string;
  fingerprint?: string;
  outcome: string;
  durationMs: number;
  cost?: CostSample;
}

interface AgentCallLike {
  stage: string;
  usage: {
    status: string;
    usd?: number;
  };
}

export interface RunTraceLike {
  startedAt: string;
  finishedAt: string;
  events: TraceEvent[];
  agentCalls?: AgentCallLike[];
}

export interface SweepRow {
  config: string;
  path: string;
  fixesAttempted: number;
  retries: number;
  fixesVerified: number;
  totalDurationMs: number;
  knownUsd?: number;
  dominantSeam: string;
  error?: string;
}

function configNameFromPath(path: string): string {
  const base = basename(path, ".json");
  return base.startsWith("sweep-") ? base.slice("sweep-".length) : base;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseRunTrace(value: unknown): RunTraceLike {
  if (!isRecord(value)) throw new Error("trace root must be an object");
  const { startedAt, finishedAt, events } = value;
  if (typeof startedAt !== "string" || typeof finishedAt !== "string") {
    throw new Error("trace must include startedAt and finishedAt strings");
  }
  if (!Array.isArray(events)) throw new Error("trace.events must be an array");
  const parsedEvents = events.map((event, index): TraceEvent => {
    if (!isRecord(event)) throw new Error(`events[${index}] must be an object`);
    if (
      typeof event["stage"] !== "string" || typeof event["outcome"] !== "string" ||
      typeof event["durationMs"] !== "number"
    ) throw new Error(`events[${index}] is invalid`);
    const cost = isRecord(event["cost"]) && typeof event["cost"]["usd"] === "number"
      ? { usd: event["cost"]["usd"] as number }
      : undefined;
    return {
      stage: event["stage"],
      outcome: event["outcome"],
      durationMs: event["durationMs"],
      ...(typeof event["fingerprint"] === "string" ? { fingerprint: event["fingerprint"] } : {}),
      ...(cost === undefined ? {} : { cost }),
    };
  });
  const agentCalls = Array.isArray(value["agentCalls"])
    ? value["agentCalls"].flatMap((call): AgentCallLike[] => {
        if (!isRecord(call) || typeof call["stage"] !== "string" || !isRecord(call["usage"])) {
          return [];
        }
        const usage = call["usage"];
        return [{
          stage: call["stage"],
          usage: {
            status: typeof usage["status"] === "string" ? usage["status"] : "unavailable",
            ...(typeof usage["usd"] === "number" ? { usd: usage["usd"] } : {}),
          },
        }];
      })
    : undefined;
  return {
    startedAt,
    finishedAt,
    events: parsedEvents,
    ...(agentCalls === undefined ? {} : { agentCalls }),
  };
}

function fixAttemptNumber(event: TraceEvent): number | undefined {
  const match = event.outcome.match(/\battempt\s+(\d+)\b/i);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function seamForStage(stage: string): string {
  if (stage === "triage" || stage === "route") return "triage";
  if (stage === "fix" || stage === "fixer") return "fix";
  if (stage === "testgen" || stage === "testWriter") return "test-writing";
  return "other";
}

export function summarizeTrace(path: string, trace: RunTraceLike): SweepRow {
  const fixEvents = trace.events.filter((event) => event.stage === "fix");
  const seenFingerprints = new Set<string>();
  let fixesAttempted = 0;
  let retries = 0;
  for (const event of fixEvents) {
    const attempt = fixAttemptNumber(event);
    if (attempt !== undefined) {
      if (attempt === 1) fixesAttempted += 1;
      else retries += 1;
      continue;
    }
    const key = event.fingerprint ?? `unkeyed-${fixesAttempted + retries}`;
    if (seenFingerprints.has(key)) retries += 1;
    else {
      seenFingerprints.add(key);
      fixesAttempted += 1;
    }
  }
  const fixesVerified = trace.events.filter(
    (event) => event.stage === "verify" && event.outcome === "verified",
  ).length;
  const started = Date.parse(trace.startedAt);
  const finished = Date.parse(trace.finishedAt);
  const totalDurationMs = Number.isFinite(started) && Number.isFinite(finished)
    ? Math.max(0, finished - started)
    : trace.events.reduce((sum, event) => sum + event.durationMs, 0);

  const seamUsd = new Map<string, number>();
  const addCost = (stage: string, usd: number | undefined) => {
    if (usd === undefined) return;
    const seam = seamForStage(stage);
    seamUsd.set(seam, (seamUsd.get(seam) ?? 0) + usd);
  };
  if (trace.agentCalls !== undefined) {
    for (const call of trace.agentCalls) addCost(call.stage, call.usage.usd);
  } else {
    for (const event of trace.events) addCost(event.stage, event.cost?.usd);
  }
  const knownUsd = seamUsd.size === 0
    ? undefined
    : [...seamUsd.values()].reduce((sum, usd) => sum + usd, 0);
  const dominantSeam = [...seamUsd.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ??
    "unknown";
  return {
    config: configNameFromPath(path),
    path,
    fixesAttempted,
    retries,
    fixesVerified,
    totalDurationMs,
    ...(knownUsd === undefined ? {} : { knownUsd }),
    dominantSeam,
  };
}

async function resolveTracePaths(argv: string[]): Promise<string[]> {
  if (argv.length > 0) return argv.map((path) => resolve(path));
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
  const remainder = seconds - minutes * 60;
  return `${minutes}m${remainder.toFixed(0).padStart(2, "0")}s`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function printTable(rows: SweepRow[]): void {
  const headers = [
    "config",
    "fixes attempted",
    "retries",
    "fixes verified",
    "wall time",
    "known USD",
    "dominant seam",
  ] as const;
  const cells = rows.map((row) => row.error === undefined
    ? [
        row.config,
        String(row.fixesAttempted),
        String(row.retries),
        String(row.fixesVerified),
        formatDuration(row.totalDurationMs),
        row.knownUsd === undefined ? "n/a" : `$${row.knownUsd.toFixed(4)}`,
        row.dominantSeam,
      ]
    : [row.config, "-", "-", "-", "-", "-", `error: ${row.error}`]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...cells.map((row) => row[index]?.length ?? 0))
  );
  const line = (parts: readonly string[]) =>
    parts.map((part, index) => pad(part, widths[index] ?? 0)).join("  ");
  console.log(line(headers));
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
      rows.push(summarizeTrace(path, parseRunTrace(await Bun.file(path).json())));
    } catch (error: unknown) {
      rows.push({
        config: configNameFromPath(path),
        path,
        fixesAttempted: 0,
        retries: 0,
        fixesVerified: 0,
        totalDurationMs: 0,
        dominantSeam: "unknown",
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
