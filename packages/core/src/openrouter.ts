/**
 * OpenRouter money-true telemetry.
 *
 * COST TRUTH comes from OpenRouter, not from the agent CLI:
 * - Prefer per-generation lookup: GET /api/v1/generation?id=<gen-id>
 * - Fallback (when gen-ids are missing): activity/usage within a run time window
 * - Never fabricate tokens or USD
 *
 * Network calls are runtime-only (operator machine). Inject `fetch` for tests.
 * Docs: https://openrouter.ai/docs
 */

import type { CostSample, CostSource } from "./trace";

export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface OpenRouterClientOptions {
  apiKey: string;
  fetch?: FetchLike;
  baseUrl?: string;
}

export interface OpenRouterGenerationUsage {
  id: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** True USD from OpenRouter. Absent only when the API omits cost. */
  usd?: number;
  raw: string;
}

export interface OpenRouterModelInfo {
  id: string;
  name?: string;
  /** Prompt price per token (USD), when present. */
  promptPricePerToken?: number;
  /** Completion price per token (USD), when present. */
  completionPricePerToken?: number;
  raw: Record<string, unknown>;
}

export type CostEnrichmentSource =
  | { kind: "openrouter-generation"; generationIds: string[] }
  | {
      kind: "openrouter-activity-fallback";
      reason: string;
      window: { startedAt: string; finishedAt: string };
    }
  | { kind: "unavailable"; reason: string };

export interface EnrichedOpenRouterCost {
  sample: CostSample;
  source: CostEnrichmentSource;
  /** Maps to AgentUsage.status when recording traces. */
  usageStatus: "reported" | "tokens-only" | "unavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replaceAll(",", "").trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function clientFetch(options: OpenRouterClientOptions): FetchLike {
  return options.fetch ?? (globalThis.fetch as FetchLike);
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
}

/**
 * Parse OpenRouter GET /generation?id=… response body into usage.
 * Accepts either `{ data: {…} }` or a bare generation object.
 */
export function parseOpenRouterGenerationResponse(
  body: unknown,
  generationId: string,
): OpenRouterGenerationUsage | undefined {
  if (!isRecord(body)) return undefined;
  const data = isRecord(body["data"]) ? body["data"] : body;

  const id = asString(data["id"]) ?? generationId;
  const model = asString(data["model"]);

  // OpenRouter documents several field names across generations + chat usage.
  const inputTokens =
    asNumber(data["tokens_prompt"]) ??
    asNumber(data["native_tokens_prompt"]) ??
    asNumber(data["prompt_tokens"]) ??
    asNumber(data["input_tokens"]);
  const outputTokens =
    asNumber(data["tokens_completion"]) ??
    asNumber(data["native_tokens_completion"]) ??
    asNumber(data["completion_tokens"]) ??
    asNumber(data["output_tokens"]);
  const totalTokens =
    asNumber(data["total_tokens"]) ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);

  // total_cost / usage / native_tokens_cost — prefer explicit total_cost.
  const usd =
    asNumber(data["total_cost"]) ??
    asNumber(data["usage"]) ??
    asNumber(data["native_tokens_cost"]) ??
    asNumber(data["cost"]);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    usd === undefined &&
    model === undefined
  ) {
    return undefined;
  }

  return {
    id,
    ...(model === undefined ? {} : { model }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(usd === undefined ? {} : { usd }),
    raw: JSON.stringify(data),
  };
}

/**
 * Parse a list of generation-like rows from activity/usage endpoints.
 * Tolerates `{ data: [...] }`, `{ data: { generations: [...] } }`, or a bare array.
 */
export function parseOpenRouterActivityResponse(
  body: unknown,
): OpenRouterGenerationUsage[] {
  if (!isRecord(body) && !Array.isArray(body)) return [];

  let rows: unknown[] = [];
  if (Array.isArray(body)) {
    rows = body;
  } else if (Array.isArray(body["data"])) {
    rows = body["data"];
  } else if (isRecord(body["data"]) && Array.isArray(body["data"]["generations"])) {
    rows = body["data"]["generations"];
  } else if (Array.isArray(body["generations"])) {
    rows = body["generations"];
  }

  const results: OpenRouterGenerationUsage[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = asString(row["id"]) ?? asString(row["generation_id"]);
    if (id === undefined) continue;
    const parsed = parseOpenRouterGenerationResponse(row, id);
    if (parsed !== undefined) results.push(parsed);
  }
  return results;
}

/**
 * Parse GET /models list; returns only entries matching `wantedIds` (exact id match).
 */
export function parseOpenRouterModelsResponse(
  body: unknown,
  wantedIds: readonly string[],
): OpenRouterModelInfo[] {
  if (!isRecord(body) || !Array.isArray(body["data"])) return [];
  const wanted = new Set(wantedIds);
  const found: OpenRouterModelInfo[] = [];
  for (const row of body["data"]) {
    if (!isRecord(row)) continue;
    const id = asString(row["id"]);
    if (id === undefined || !wanted.has(id)) continue;
    const pricing = isRecord(row["pricing"]) ? row["pricing"] : undefined;
    const promptPricePerToken = pricing ? asNumber(pricing["prompt"]) : undefined;
    const completionPricePerToken = pricing
      ? asNumber(pricing["completion"])
      : undefined;
    found.push({
      id,
      ...(asString(row["name"]) === undefined ? {} : { name: asString(row["name"]) }),
      ...(promptPricePerToken === undefined ? {} : { promptPricePerToken }),
      ...(completionPricePerToken === undefined ? {} : { completionPricePerToken }),
      raw: row,
    });
  }
  return found;
}

export async function fetchOpenRouterGeneration(
  generationId: string,
  options: OpenRouterClientOptions,
): Promise<OpenRouterGenerationUsage | undefined> {
  const base = options.baseUrl ?? OPENROUTER_API_BASE;
  const url = `${base}/generation?id=${encodeURIComponent(generationId)}`;
  const response = await clientFetch(options)(url, {
    method: "GET",
    headers: authHeaders(options.apiKey),
  });
  if (!response.ok) return undefined;
  const body: unknown = await response.json();
  return parseOpenRouterGenerationResponse(body, generationId);
}

/**
 * Best-effort activity window query.
 * OpenRouter's activity endpoint shape has varied; this requests a generations-like
 * listing and filters client-side by created-at when present.
 */
export async function fetchOpenRouterActivityWindow(
  options: OpenRouterClientOptions & {
    startedAt: Date;
    finishedAt: Date;
  },
): Promise<OpenRouterGenerationUsage[]> {
  const base = options.baseUrl ?? OPENROUTER_API_BASE;
  // Documented activity path; if the endpoint 404s the caller marks unavailable.
  const url = `${base}/activity`;
  const response = await clientFetch(options)(url, {
    method: "GET",
    headers: authHeaders(options.apiKey),
  });
  if (!response.ok) return [];
  const body: unknown = await response.json();
  const all = parseOpenRouterActivityResponse(body);
  const startMs = options.startedAt.getTime();
  const endMs = options.finishedAt.getTime();
  return all.filter((row) => {
    // If raw has no timestamp, keep the row (window filter best-effort only).
    try {
      const raw: unknown = JSON.parse(row.raw);
      if (!isRecord(raw)) return true;
      const created =
        asString(raw["created_at"]) ??
        asString(raw["createdAt"]) ??
        (asNumber(raw["created"]) !== undefined
          ? new Date((asNumber(raw["created"]) ?? 0) * 1000).toISOString()
          : undefined);
      if (created === undefined) return true;
      const ms = Date.parse(created);
      if (!Number.isFinite(ms)) return true;
      return ms >= startMs && ms <= endMs;
    } catch {
      return true;
    }
  });
}

export async function listOpenRouterModels(
  options: OpenRouterClientOptions,
  wantedIds: readonly string[],
): Promise<OpenRouterModelInfo[]> {
  const base = options.baseUrl ?? OPENROUTER_API_BASE;
  const response = await clientFetch(options)(`${base}/models`, {
    method: "GET",
    headers: authHeaders(options.apiKey),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter /models failed (${response.status})`);
  }
  const body: unknown = await response.json();
  return parseOpenRouterModelsResponse(body, wantedIds);
}

function sumUsage(rows: OpenRouterGenerationUsage[]): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  usd?: number;
} {
  const sum = (select: (row: OpenRouterGenerationUsage) => number | undefined): number | undefined => {
    const values = rows.map(select).filter((v): v is number => v !== undefined);
    return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0);
  };
  return {
    inputTokens: sum((r) => r.inputTokens),
    outputTokens: sum((r) => r.outputTokens),
    totalTokens: sum((r) => r.totalTokens),
    usd: sum((r) => r.usd),
  };
}

export function costSampleFromOpenRouterUsage(
  rows: OpenRouterGenerationUsage[],
  costSource: CostSource,
  modelHint?: string,
): CostSample {
  const totals = sumUsage(rows);
  const models = new Set(
    rows.map((r) => r.model).filter((m): m is string => m !== undefined),
  );
  const model =
    models.size === 1
      ? [...models][0]
      : modelHint;
  const generationIds = rows.map((r) => r.id);
  return {
    harness: "opencode",
    ...(model === undefined ? {} : { model }),
    ...(totals.inputTokens === undefined ? {} : { inputTokens: totals.inputTokens }),
    ...(totals.outputTokens === undefined ? {} : { outputTokens: totals.outputTokens }),
    ...(totals.totalTokens === undefined ? {} : { totalTokens: totals.totalTokens }),
    ...(totals.usd === undefined ? {} : { usd: totals.usd }),
    ...(generationIds.length === 0 ? {} : { generationIds }),
    costSource,
    raw: rows.map((r) => r.raw).join("\n"),
  };
}

function usageStatusFromSample(
  sample: CostSample,
): "reported" | "tokens-only" | "unavailable" {
  if (sample.usd !== undefined) return "reported";
  if (
    sample.inputTokens !== undefined ||
    sample.outputTokens !== undefined ||
    sample.totalTokens !== undefined
  ) {
    return "tokens-only";
  }
  return "unavailable";
}

/**
 * Enrich a CostSample using OpenRouter generation ids, falling back to an
 * activity window when ids are empty. Never invents USD.
 */
export async function enrichOpenRouterCost(input: {
  generationIds: string[];
  model?: string;
  /** Required for activity-window fallback when generation ids are empty. */
  window?: { startedAt: Date; finishedAt: Date };
  client: OpenRouterClientOptions;
}): Promise<EnrichedOpenRouterCost> {
  const ids = input.generationIds.filter((id) => id.trim() !== "");

  if (ids.length > 0) {
    const rows: OpenRouterGenerationUsage[] = [];
    for (const id of ids) {
      const row = await fetchOpenRouterGeneration(id, input.client);
      if (row !== undefined) rows.push(row);
    }
    if (rows.length === 0) {
      const sample: CostSample = {
        harness: "opencode",
        ...(input.model === undefined ? {} : { model: input.model }),
        generationIds: ids,
        costSource: "unavailable",
        raw: `openrouter generation lookup returned no rows for: ${ids.join(", ")}`,
      };
      return {
        sample,
        source: {
          kind: "unavailable",
          reason: "openrouter-generation-lookup-empty",
        },
        usageStatus: "unavailable",
      };
    }
    const sample = costSampleFromOpenRouterUsage(
      rows,
      "openrouter-generation",
      input.model,
    );
    return {
      sample,
      source: { kind: "openrouter-generation", generationIds: ids },
      usageStatus: usageStatusFromSample(sample),
    };
  }

  // Fallback: activity window for the API key within the run.
  if (input.window === undefined) {
    const sample: CostSample = {
      harness: "opencode",
      ...(input.model === undefined ? {} : { model: input.model }),
      costSource: "unavailable",
      raw: "no generation ids from opencode; activity-window fallback not requested",
    };
    return {
      sample,
      source: {
        kind: "unavailable",
        reason:
          "no-generation-ids-and-no-activity-window; opencode JSON lacked generation ids",
      },
      usageStatus: "unavailable",
    };
  }

  const windowRows = await fetchOpenRouterActivityWindow({
    ...input.client,
    startedAt: input.window.startedAt,
    finishedAt: input.window.finishedAt,
  });
  const startedAt = input.window.startedAt.toISOString();
  const finishedAt = input.window.finishedAt.toISOString();

  if (windowRows.length === 0) {
    const sample: CostSample = {
      harness: "opencode",
      ...(input.model === undefined ? {} : { model: input.model }),
      costSource: "unavailable",
      raw:
        "no generation ids from opencode; activity-window fallback returned no rows " +
        `(${startedAt}..${finishedAt})`,
    };
    return {
      sample,
      source: {
        kind: "unavailable",
        reason:
          "no-generation-ids; activity-window-fallback-empty — samples marked unavailable, not fabricated",
      },
      usageStatus: "unavailable",
    };
  }

  const sample = costSampleFromOpenRouterUsage(
    windowRows,
    "openrouter-activity-fallback",
    input.model,
  );
  return {
    sample,
    source: {
      kind: "openrouter-activity-fallback",
      reason:
        "opencode JSON lacked generation ids; used OpenRouter activity window for this API key",
      window: { startedAt, finishedAt },
    },
    usageStatus: usageStatusFromSample(sample),
  };
}

/** Sum only reported (usd-present) samples. Used by the matrix budget halt. */
export function sumReportedUsd(samples: ReadonlyArray<{ usd?: number }>): number {
  let total = 0;
  for (const sample of samples) {
    if (sample.usd !== undefined && Number.isFinite(sample.usd)) {
      total += sample.usd;
    }
  }
  return total;
}

/**
 * Cumulative budget halt: stop when cumulative reported USD exceeds `haltAtUsd`.
 * Budget cap is higher (operator soft limit); halt margin is cap − halt.
 */
export function shouldHaltBudget(
  cumulativeUsd: number,
  haltAtUsd: number,
): boolean {
  return cumulativeUsd > haltAtUsd;
}

/** Extract OpenRouter-reported usd samples from a run trace-like object. */
export function reportedUsdFromTrace(trace: {
  events?: Array<{ cost?: { usd?: number; harness?: string } }>;
  agentCalls?: Array<{ usage?: { status?: string; usd?: number } }>;
}): number {
  if (trace.agentCalls !== undefined && trace.agentCalls.length > 0) {
    return sumReportedUsd(
      trace.agentCalls
        .filter((call) => call.usage?.status === "reported")
        .map((call) => ({ usd: call.usage?.usd })),
    );
  }
  return sumReportedUsd(
    (trace.events ?? [])
      .map((event) => event.cost)
      .filter((cost): cost is { usd?: number } => cost !== undefined),
  );
}
