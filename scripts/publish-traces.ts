import { basename, resolve } from "node:path";
import { readdir } from "node:fs/promises";
import type {
  AgentCall,
  AgentUsage,
  CostSample,
  PipelineKind,
  ResolvedAgent,
  ResolvedPipeline,
  RunTrace,
  TraceEvent,
  TraceWorkload,
} from "@bug-loop/core/trace";

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

interface LegacyWorkload {
  benchmarkId: "unknown-v1";
  seed: null;
  caseCount: null;
  codeRevision: "unknown-v1";
}

interface LegacyResolvedAgent {
  harness: "unknown-v1";
  requestedModel: null;
  effectiveModel: null;
  effort: null;
  source: "unknown-v1";
}

interface LegacyResolvedPipeline {
  pipeline: PipelineKind;
  triage: LegacyResolvedAgent;
  testWriter: LegacyResolvedAgent;
  fixer: LegacyResolvedAgent;
  regressionTests: "always" | "triage-decides" | "never" | "unknown-v1";
  maxFixAttempts: number | "unknown-v1";
  incidentConcurrency: "unknown-v1";
  mode: {
    fix: "unknown-v1";
    live: "unknown-v1";
    fromStart: "unknown-v1";
  };
}

export interface PublishedTraceV1 {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  finishedAt: string;
  pipeline: PipelineKind;
  config: {
    fixer: "unknown-v1";
    regressionTests: "always" | "triage-decides" | "never" | "unknown-v1";
    maxFixAttempts: number | "unknown-v1";
    incidentConcurrency: number | "unknown-v1";
  };
  resolved: LegacyResolvedPipeline;
  workload: LegacyWorkload;
  label?: string;
  events: TraceEvent[];
  agentCalls: [];
  compatibility: {
    resolved: "unknown-v1";
    workload: "unknown-v1";
  };
}

export type PublishedTraceV2 = RunTrace & {
  pipeline: PipelineKind;
  config: {
    fixer: string;
    regressionTests: "always" | "triage-decides" | "never";
    maxFixAttempts: number;
    incidentConcurrency: number;
  };
};

export type PublishedTrace = PublishedTraceV2 | PublishedTraceV1;

export interface PublishedRun {
  label: string;
  workloadKey: string;
  resolvedConfigKey: string;
  trace: PublishedTrace;
}

export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "grok-4.5": { inPerM: 2.0, outPerM: 6.0 },
  "gpt-5.6-sol": { inPerM: 5.0, outPerM: 30.0 },
  "gpt-5.6-terra": { inPerM: 2.5, outPerM: 15.0 },
  "gpt-5.6-luna": { inPerM: 1.0, outPerM: 6.0 },
  "claude-sonnet-5": { inPerM: 3.0, outPerM: 15.0 },
  sonnet: { inPerM: 3.0, outPerM: 15.0 },
  "claude-haiku-4-5": { inPerM: 1.0, outPerM: 5.0 },
  haiku: { inPerM: 1.0, outPerM: 5.0 },
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
  note: "Enterprise API list prices - for subscription users this is the API-equivalent cost of the same tokens.",
  notes: {
    "grok-4.5":
      "Under-200K-token prompt rate (2.00/6.00 USD per MTok); at/above 200K is 4.00/12.00 - this table uses the under-200K rate.",
    "claude-sonnet-5":
      "Standard rate 3.00/15.00 USD per MTok; intro pricing 2.00/10.00 through 2026-08-31.",
  },
};

const PIPELINES = new Set<PipelineKind>(["langgraph", "agent-sdk"]);
const HARNESSES = new Set<CostSample["harness"]>(["claude-agent-sdk", "codex", "grok"]);
const SOURCES = new Set(["default", "env", "arg"]);
const LOCAL_PATH = /[A-Za-z]:\\(?:Users|home|tmp|workspace|repos)(?:\\[^\s)\]`'"]+)+|\/(?:Users|home|private|tmp|var\/folders|opt|workspace|root|mnt|Volumes)\/[^\s)\]`'"\\]*/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function cleanString(value: string): string {
  return value.replace(LOCAL_PATH, "[local-path-redacted]");
}

function safeValue(value: unknown): unknown {
  if (typeof value === "string") return cleanString(value);
  if (Array.isArray(value)) return value.map(safeValue);
  if (!isRecord(value)) return value;
  const projected: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (
      normalizedKey === "raw" || normalizedKey.endsWith("argv") ||
      normalizedKey.includes("prompt")
    ) continue;
    projected[key] = safeValue(child);
  }
  return projected;
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
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "usd"] as const) {
    if (value[key] !== undefined && !nonNegative(value[key])) {
      throw new Error(`${path}.${key} must be a non-negative number`);
    }
  }
  return {
    harness: harness as CostSample["harness"],
    ...(typeof model === "string" ? { model } : {}),
    ...(nonNegative(value["inputTokens"]) ? { inputTokens: value["inputTokens"] } : {}),
    ...(nonNegative(value["outputTokens"]) ? { outputTokens: value["outputTokens"] } : {}),
    ...(nonNegative(value["totalTokens"]) ? { totalTokens: value["totalTokens"] } : {}),
    ...(nonNegative(value["usd"]) ? { usd: value["usd"] } : {}),
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
  const cost = value["cost"] === undefined
    ? undefined
    : parseCostSample(value["cost"], `${path}.cost`);
  const detail = isRecord(value["detail"])
    ? safeValue(value["detail"]) as Record<string, unknown>
    : undefined;
  return {
    seq: value["seq"] as number,
    stage: value["stage"] as string,
    startedAt: value["startedAt"] as string,
    durationMs: value["durationMs"] as number,
    outcome: cleanString(value["outcome"] as string),
    ...(typeof value["fingerprint"] === "string" ? { fingerprint: value["fingerprint"] } : {}),
    ...(detail === undefined ? {} : { detail }),
    ...(cost === undefined ? {} : { cost }),
  };
}

function parseResolvedAgent(value: unknown, path: string): ResolvedAgent {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (typeof value["harness"] !== "string") throw new Error(`${path}.harness must be a string`);
  for (const key of ["requestedModel", "effectiveModel", "effort"] as const) {
    if (value[key] !== null && typeof value[key] !== "string") {
      throw new Error(`${path}.${key} must be a string or null`);
    }
  }
  if (typeof value["source"] !== "string" || !SOURCES.has(value["source"])) {
    throw new Error(`${path}.source is invalid`);
  }
  return {
    harness: value["harness"] as string,
    requestedModel: value["requestedModel"] as string | null,
    effectiveModel: value["effectiveModel"] as string | null,
    effort: value["effort"] as string | null,
    source: value["source"] as ResolvedAgent["source"],
  };
}

function parseResolved(value: unknown): ResolvedPipeline {
  if (!isRecord(value)) throw new Error("resolved must be an object");
  if (typeof value["pipeline"] !== "string" || !PIPELINES.has(value["pipeline"] as PipelineKind)) {
    throw new Error("resolved.pipeline must be langgraph or agent-sdk");
  }
  if (value["regressionTests"] !== "always" && value["regressionTests"] !== "triage-decides" &&
      value["regressionTests"] !== "never") {
    throw new Error("resolved.regressionTests is invalid");
  }
  if (!Number.isInteger(value["maxFixAttempts"]) || (value["maxFixAttempts"] as number) < 1) {
    throw new Error("resolved.maxFixAttempts must be a positive integer");
  }
  const incidentConcurrency = value["incidentConcurrency"] ?? 1;
  if (!Number.isInteger(incidentConcurrency) || (incidentConcurrency as number) < 1) {
    throw new Error("resolved.incidentConcurrency must be a positive integer");
  }
  if (!isRecord(value["mode"])) throw new Error("resolved.mode must be an object");
  const mode = value["mode"];
  for (const key of ["fix", "live", "fromStart"] as const) {
    if (typeof mode[key] !== "boolean") throw new Error(`resolved.mode.${key} must be boolean`);
  }
  return {
    pipeline: value["pipeline"] as PipelineKind,
    triage: parseResolvedAgent(value["triage"], "resolved.triage"),
    testWriter: parseResolvedAgent(value["testWriter"], "resolved.testWriter"),
    fixer: parseResolvedAgent(value["fixer"], "resolved.fixer"),
    regressionTests: value["regressionTests"],
    maxFixAttempts: value["maxFixAttempts"] as number,
    incidentConcurrency: incidentConcurrency as number,
    mode: {
      fix: mode["fix"] as boolean,
      live: mode["live"] as boolean,
      fromStart: mode["fromStart"] as boolean,
    },
  };
}

function parseWorkload(value: unknown): TraceWorkload {
  if (!isRecord(value)) throw new Error("workload must be an object");
  for (const key of ["benchmarkId", "codeRevision"] as const) {
    if (typeof value[key] !== "string") throw new Error(`workload.${key} must be a string`);
  }
  for (const key of ["seed", "caseCount"] as const) {
    if (!nonNegative(value[key])) throw new Error(`workload.${key} must be non-negative`);
  }
  return {
    benchmarkId: value["benchmarkId"] as string,
    seed: value["seed"] as number,
    caseCount: value["caseCount"] as number,
    codeRevision: value["codeRevision"] as string,
  };
}

function parseUsage(value: unknown, path: string): AgentUsage {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (value["status"] === "unavailable") {
    if (typeof value["reason"] !== "string") throw new Error(`${path}.reason must be a string`);
    return { status: "unavailable", reason: value["reason"] };
  }
  if (value["status"] !== "reported" && value["status"] !== "tokens-only") {
    throw new Error(`${path}.status is invalid`);
  }
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    if (value[key] !== undefined && !nonNegative(value[key])) {
      throw new Error(`${path}.${key} must be non-negative`);
    }
  }
  if (value["status"] === "reported") {
    if (!nonNegative(value["usd"])) throw new Error(`${path}.usd must be non-negative`);
    return {
      status: "reported",
      ...(nonNegative(value["inputTokens"]) ? { inputTokens: value["inputTokens"] } : {}),
      ...(nonNegative(value["outputTokens"]) ? { outputTokens: value["outputTokens"] } : {}),
      ...(nonNegative(value["totalTokens"]) ? { totalTokens: value["totalTokens"] } : {}),
      usd: value["usd"],
    };
  }
  if (
    !nonNegative(value["inputTokens"]) && !nonNegative(value["outputTokens"]) &&
    !nonNegative(value["totalTokens"])
  ) {
    throw new Error(`${path} tokens-only usage must include at least one token count`);
  }
  return {
    status: "tokens-only",
    ...(nonNegative(value["inputTokens"]) ? { inputTokens: value["inputTokens"] } : {}),
    ...(nonNegative(value["outputTokens"]) ? { outputTokens: value["outputTokens"] } : {}),
    ...(nonNegative(value["totalTokens"]) ? { totalTokens: value["totalTokens"] } : {}),
  };
}

function parseAgentCall(value: unknown, path: string): AgentCall {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (!Number.isInteger(value["seq"])) throw new Error(`${path}.seq must be an integer`);
  for (const key of ["stage", "harness", "outcome"] as const) {
    if (typeof value[key] !== "string") throw new Error(`${path}.${key} must be a string`);
  }
  if (value["effectiveModel"] !== null && typeof value["effectiveModel"] !== "string") {
    throw new Error(`${path}.effectiveModel must be a string or null`);
  }
  if (value["effort"] !== null && typeof value["effort"] !== "string") {
    throw new Error(`${path}.effort must be a string or null`);
  }
  if (value["fingerprint"] !== undefined && typeof value["fingerprint"] !== "string") {
    throw new Error(`${path}.fingerprint must be a string`);
  }
  for (const key of ["correlationId", "attemptId"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`${path}.${key} must be a string`);
    }
  }
  if (!nonNegative(value["durationMs"])) throw new Error(`${path}.durationMs is invalid`);
  let fallback: AgentCall["fallback"];
  if (value["fallback"] !== undefined) {
    if (
      !isRecord(value["fallback"]) || typeof value["fallback"]["type"] !== "string" ||
      typeof value["fallback"]["reason"] !== "string"
    ) {
      throw new Error(`${path}.fallback must include string type and reason`);
    }
    fallback = {
      type: value["fallback"]["type"] as string,
      reason: cleanString(value["fallback"]["reason"] as string),
    };
  }
  return {
    seq: value["seq"] as number,
    stage: value["stage"] as string,
    ...(typeof value["fingerprint"] === "string" ? { fingerprint: value["fingerprint"] } : {}),
    ...(typeof value["correlationId"] === "string" ? { correlationId: value["correlationId"] } : {}),
    ...(typeof value["attemptId"] === "string" ? { attemptId: value["attemptId"] } : {}),
    harness: value["harness"] as string,
    effectiveModel: value["effectiveModel"] as string | null,
    effort: value["effort"] as string | null,
    durationMs: value["durationMs"] as number,
    outcome: cleanString(value["outcome"] as string),
    usage: parseUsage(value["usage"], `${path}.usage`),
    ...(fallback === undefined ? {} : { fallback }),
  };
}

function commonTrace(value: Record<string, unknown>): {
  runId: string;
  startedAt: string;
  finishedAt: string;
  label?: string;
  events: TraceEvent[];
} {
  for (const key of ["runId", "startedAt", "finishedAt"] as const) {
    if (typeof value[key] !== "string") throw new Error(`${key} must be a string`);
  }
  if (!Number.isFinite(Date.parse(value["startedAt"] as string))) {
    throw new Error("startedAt must be a valid date");
  }
  if (!Number.isFinite(Date.parse(value["finishedAt"] as string))) {
    throw new Error("finishedAt must be a valid date");
  }
  if (!Array.isArray(value["events"])) throw new Error("events must be an array");
  if (value["label"] !== undefined && typeof value["label"] !== "string") {
    throw new Error("label must be a string");
  }
  return {
    runId: value["runId"] as string,
    startedAt: value["startedAt"] as string,
    finishedAt: value["finishedAt"] as string,
    ...(typeof value["label"] === "string" ? { label: value["label"] } : {}),
    events: value["events"].map((event, index) => parseTraceEvent(event, `events[${index}]`)),
  };
}

function unknownAgent(): LegacyResolvedAgent {
  return {
    harness: "unknown-v1",
    requestedModel: null,
    effectiveModel: null,
    effort: null,
    source: "unknown-v1",
  };
}

export function parseRunTrace(value: unknown): PublishedTrace {
  if (!isRecord(value)) throw new Error("trace root must be an object");
  const common = commonTrace(value);
  if (value["schemaVersion"] === 2) {
    const resolved = parseResolved(value["resolved"]);
    const workload = parseWorkload(value["workload"]);
    if (!Array.isArray(value["agentCalls"])) throw new Error("agentCalls must be an array");
    return {
      schemaVersion: 2,
      ...common,
      resolved,
      workload,
      pipeline: resolved.pipeline,
      config: {
        fixer: resolved.fixer.harness,
        regressionTests: resolved.regressionTests,
        maxFixAttempts: resolved.maxFixAttempts,
        incidentConcurrency: resolved.incidentConcurrency,
      },
      agentCalls: value["agentCalls"].map((call, index) =>
        parseAgentCall(call, `agentCalls[${index}]`)
      ),
    };
  }
  if (value["schemaVersion"] !== undefined && value["schemaVersion"] !== 1) {
    throw new Error("schemaVersion must be 1 or 2");
  }
  if (typeof value["pipeline"] !== "string" || !PIPELINES.has(value["pipeline"] as PipelineKind)) {
    throw new Error("pipeline must be langgraph or agent-sdk");
  }
  if (!isRecord(value["config"])) throw new Error("config must be an object");
  const config = value["config"];
  const regressionTests = config["regressionTests"] === "always" ||
    config["regressionTests"] === "never" || config["regressionTests"] === "triage-decides"
      ? config["regressionTests"]
      : "unknown-v1";
  const maxFixAttempts = Number.isInteger(config["maxFixAttempts"]) &&
    (config["maxFixAttempts"] as number) > 0
      ? config["maxFixAttempts"] as number
      : "unknown-v1";
  return {
    schemaVersion: 1,
    ...common,
    pipeline: value["pipeline"] as PipelineKind,
    config: {
      fixer: "unknown-v1",
      regressionTests,
      maxFixAttempts,
      incidentConcurrency: "unknown-v1",
    },
    resolved: {
      pipeline: value["pipeline"] as PipelineKind,
      triage: unknownAgent(),
      testWriter: unknownAgent(),
      fixer: unknownAgent(),
      regressionTests,
      maxFixAttempts,
      incidentConcurrency: "unknown-v1",
      mode: {
        fix: "unknown-v1",
        live: "unknown-v1",
        fromStart: "unknown-v1",
      },
    },
    workload: {
      benchmarkId: "unknown-v1",
      seed: null,
      caseCount: null,
      codeRevision: "unknown-v1",
    },
    agentCalls: [],
    compatibility: { resolved: "unknown-v1", workload: "unknown-v1" },
  };
}

export function labelFromFilename(path: string): string {
  const base = basename(path).replace(/\.json$/i, "");
  const trimmed = base.startsWith("sweep-") ? base.slice("sweep-".length) : base;
  return trimmed || base || "unnamed-run";
}

export function labelForTrace(trace: PublishedTrace, path: string): string {
  const fromTrace = trace.label?.trim();
  return fromTrace || labelFromFilename(path);
}

export function workloadKey(trace: PublishedTrace): string {
  const workload = trace.workload;
  return [
    workload.benchmarkId,
    String(workload.seed),
    String(workload.caseCount),
    workload.codeRevision,
  ].join("|");
}

export function resolvedConfigKey(trace: PublishedTrace): string {
  const resolved = trace.resolved;
  const agent = (value: ResolvedAgent | LegacyResolvedAgent) => [
    value.harness,
    value.effectiveModel ?? "unknown",
    value.effort ?? "none",
  ].join(":");
  return [
    resolved.pipeline,
    agent(resolved.triage),
    agent(resolved.testWriter),
    agent(resolved.fixer),
    resolved.regressionTests,
    String(resolved.maxFixAttempts),
    String(resolved.incidentConcurrency),
    `${resolved.mode.fix}:${resolved.mode.live}:${resolved.mode.fromStart}`,
  ].join("|");
}

export async function resolveTracePaths(argv: string[]): Promise<string[]> {
  if (argv.length > 0) return argv.map((path) => resolve(path));
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
  return [
    "/* Generated by scripts/publish-traces.ts - do not edit by hand. */",
    `window.BUGLOOP_RUNS = ${JSON.stringify(safeValue(runs), null, 2)};`,
    `window.BUGLOOP_PRICES = ${JSON.stringify(prices, null, 2)};`,
    `window.BUGLOOP_PRICES_META = ${JSON.stringify(meta, null, 2)};`,
    "",
  ].join("\n");
}

export async function loadPublishedRuns(paths: string[]): Promise<PublishedRun[]> {
  const runs: PublishedRun[] = [];
  for (const path of paths) {
    const raw: unknown = await Bun.file(path).json();
    const trace = safeValue(parseRunTrace(raw)) as PublishedTrace;
    runs.push({
      label: labelForTrace(trace, path),
      workloadKey: workloadKey(trace),
      resolvedConfigKey: resolvedConfigKey(trace),
      trace,
    });
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
  await Bun.write(outputPath, buildRunsDataSource(runs));
  return { runs, outputPath };
}

if (import.meta.main) {
  publishTraces()
    .then(({ runs, outputPath }) => {
      console.log(`Wrote ${runs.length} run(s) to ${outputPath}`);
      for (const run of runs) {
        console.log(
          `  - ${run.label} (${run.trace.resolved.pipeline}, ${run.trace.events.length} events)`,
        );
      }
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
