/**
 * Matrix / pilot helpers for OpenRouter × OpenCode sweeps.
 * Pure functions + config loading — the shell driver is scripts/model-sweep.sh.
 *
 * Budget: hard halt when cumulative reported USD exceeds budgetHaltUsd ($18 default).
 * Soft cap is budgetCapUsd ($20); halt margin = cap − halt.
 */

import { resolve } from "node:path";
import {
  reportedUsdFromTrace,
  shouldHaltBudget,
  sumReportedUsd,
} from "../packages/core/src/openrouter";

export interface ModelSweepConfig {
  models: string[];
  trials: number;
  budgetHaltUsd: number;
  budgetCapUsd: number;
  trafficCount: number;
  seedBase: number;
}

export interface SweepTrialPlan {
  modelId: string;
  /** Short slug for labels/paths (last path segment, alnum). */
  modelShort: string;
  trial: number;
  seed: number;
  label: string;
  tracePath: string;
  /** Full openrouter/<id> for BUGLOOP_OPENCODE_MODEL. */
  openCodeModel: string;
}

export interface BudgetCheckResult {
  trialUsd: number;
  cumulativeUsd: number;
  halt: boolean;
  message?: string;
}

const DEFAULT_CONFIG: ModelSweepConfig = {
  models: [
    "deepseek/deepseek-v4-pro",
    "qwen/qwen3-coder",
    "z-ai/glm-5.2",
    "moonshotai/kimi-k2.7-code",
    "nvidia/nemotron-3-super-120b-a12b",
  ],
  trials: 3,
  budgetHaltUsd: 18,
  budgetCapUsd: 20,
  trafficCount: 50,
  seedBase: 100,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function modelShortName(modelId: string): string {
  const last = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
  return last.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48) || "model";
}

export function openRouterModelToOpenCode(modelId: string): string {
  const trimmed = modelId.trim();
  if (trimmed.startsWith("openrouter/")) return trimmed;
  return `openrouter/${trimmed}`;
}

export function parseModelSweepConfig(value: unknown): ModelSweepConfig {
  if (!isRecord(value)) throw new Error("model-sweep config root must be an object");
  const modelsRaw = value["models"];
  if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) {
    throw new Error("model-sweep config.models must be a non-empty string array");
  }
  const models = modelsRaw.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`model-sweep config.models[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
  const asPositive = (key: string, fallback: number): number => {
    const raw = value[key];
    if (raw === undefined) return fallback;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      throw new Error(`model-sweep config.${key} must be a positive number`);
    }
    return raw;
  };
  return {
    models,
    trials: Math.floor(asPositive("trials", DEFAULT_CONFIG.trials)),
    budgetHaltUsd: asPositive("budgetHaltUsd", DEFAULT_CONFIG.budgetHaltUsd),
    budgetCapUsd: asPositive("budgetCapUsd", DEFAULT_CONFIG.budgetCapUsd),
    trafficCount: Math.floor(asPositive("trafficCount", DEFAULT_CONFIG.trafficCount)),
    seedBase: Math.floor(asPositive("seedBase", DEFAULT_CONFIG.seedBase)),
  };
}

export async function loadModelSweepConfig(path: string): Promise<ModelSweepConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`model-sweep config not found: ${path}`);
  }
  return parseModelSweepConfig(await file.json());
}

/**
 * Build the ordered trial matrix. Pilot mode: first model × 1 trial only.
 * Seeds rotate: seedBase + (modelIndex * trials) + (trial - 1).
 */
export function planSweepTrials(
  config: ModelSweepConfig,
  options: { pilot?: boolean; tracesDir?: string } = {},
): SweepTrialPlan[] {
  const models = options.pilot === true ? config.models.slice(0, 1) : config.models;
  const trials = options.pilot === true ? 1 : config.trials;
  const tracesDir = options.tracesDir ?? "traces";
  const plans: SweepTrialPlan[] = [];
  models.forEach((modelId, modelIndex) => {
    const short = modelShortName(modelId);
    for (let trial = 1; trial <= trials; trial++) {
      const seed = config.seedBase + modelIndex * config.trials + (trial - 1);
      const label = `or-${short}-t${trial}`;
      plans.push({
        modelId,
        modelShort: short,
        trial,
        seed,
        label,
        tracePath: `${tracesDir}/sweep-${label}.json`,
        openCodeModel: openRouterModelToOpenCode(modelId),
      });
    }
  });
  return plans;
}

export function checkBudgetAfterTrial(input: {
  cumulativeUsd: number;
  trialUsd: number;
  haltAtUsd: number;
  capUsd: number;
  label: string;
}): BudgetCheckResult {
  const cumulativeUsd = input.cumulativeUsd + input.trialUsd;
  const halt = shouldHaltBudget(cumulativeUsd, input.haltAtUsd);
  if (!halt) {
    return { trialUsd: input.trialUsd, cumulativeUsd, halt: false };
  }
  const margin = input.capUsd - input.haltAtUsd;
  return {
    trialUsd: input.trialUsd,
    cumulativeUsd,
    halt: true,
    message:
      `BUDGET HALT after ${input.label}: cumulative reported OpenRouter USD ` +
      `$${cumulativeUsd.toFixed(4)} exceeds halt threshold $${input.haltAtUsd.toFixed(2)} ` +
      `(soft cap $${input.capUsd.toFixed(2)}, margin $${margin.toFixed(2)}). Stopping matrix sweep.`,
  };
}

export function trialUsdFromTraceFile(trace: unknown): number {
  if (!isRecord(trace)) return 0;
  return reportedUsdFromTrace({
    events: Array.isArray(trace["events"])
      ? (trace["events"] as Array<{ cost?: { usd?: number } }>)
      : undefined,
    agentCalls: Array.isArray(trace["agentCalls"])
      ? (trace["agentCalls"] as Array<{ usage?: { status?: string; usd?: number } }>)
      : undefined,
  });
}

export { sumReportedUsd, shouldHaltBudget, reportedUsdFromTrace };

/** CLI: print trial plan as JSON (used by model-sweep.sh). */
async function main(argv = process.argv.slice(2)): Promise<void> {
  let configPath = resolve("scripts/model-sweep.config.json");
  let pilot = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--pilot") pilot = true;
    else if (arg === "--config") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--config requires a path");
      configPath = resolve(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run scripts/model-sweep.ts [--pilot] [--config path]\n" +
          "Prints the trial plan JSON for model-sweep.sh.",
      );
      return;
    }
  }
  const config = await loadModelSweepConfig(configPath);
  const plans = planSweepTrials(config, { pilot });
  console.log(JSON.stringify({
    config: {
      ...config,
      // Echo that placeholders must be verified live.
      modelsMustBeVerified:
        "Verify each id against GET https://openrouter.ai/api/v1/models before a live run.",
    },
    pilot,
    plans,
  }, null, 2));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
