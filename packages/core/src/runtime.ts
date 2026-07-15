import type { PipelineConfig } from "./config";
import { runProcess } from "./process";
import type {
  PipelineKind,
  ResolvedAgent,
  ResolvedPipeline,
  TraceWorkload,
} from "./trace";
import type { TriageRunConfig } from "./types";

export interface RuntimeOverrides {
  triage?: boolean;
  testWriter?: boolean;
  fixer?: boolean;
}

export interface ResolveRuntimeInput {
  pipeline: PipelineKind;
  config: PipelineConfig;
  mode: TriageRunConfig;
  env?: Record<string, string | undefined>;
  overrides?: RuntimeOverrides;
}

const GROK_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function nonEmptyEnv(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key];
  return value === undefined || value === "" ? undefined : value;
}

function grokEffort(env: Record<string, string | undefined>): string | undefined {
  const value = nonEmptyEnv(env, "BUGLOOP_GROK_EFFORT");
  if (value !== undefined && !GROK_EFFORTS.has(value)) {
    throw new Error(
      `BUGLOOP_GROK_EFFORT must be one of ${[...GROK_EFFORTS].join("|")}, received ${value}`,
    );
  }
  return value;
}

function injectedAgent(): ResolvedAgent {
  return {
    harness: "injected",
    requestedModel: null,
    effectiveModel: null,
    effort: null,
    source: "arg",
  };
}

function resolveTriage(
  pipeline: PipelineKind,
  env: Record<string, string | undefined>,
  injected: boolean,
): ResolvedAgent {
  if (injected) return injectedAgent();
  if (pipeline === "agent-sdk") {
    const configuredModel = nonEmptyEnv(env, "BUGLOOP_TRIAGE_MODEL");
    const model = configuredModel ?? "sonnet";
    return {
      harness: "claude-agent-sdk",
      requestedModel: model,
      effectiveModel: model,
      effort: null,
      source: configuredModel === undefined ? "default" : "env",
    };
  }
  return {
    harness: "policy-only",
    requestedModel: null,
    effectiveModel: null,
    effort: null,
    source: "default",
  };
}

function resolveFixer(
  config: PipelineConfig,
  env: Record<string, string | undefined>,
  injected: boolean,
): ResolvedAgent {
  if (injected) return injectedAgent();
  const configuredHarness = nonEmptyEnv(env, "BUGLOOP_FIXER");
  const harness = configuredHarness ?? config.fixer;
  if (harness !== "codex" && harness !== "grok") {
    throw new Error(`BUGLOOP_FIXER must be codex or grok, received ${harness}`);
  }
  const requestedModel = harness === "codex"
    ? nonEmptyEnv(env, "BUGLOOP_CODEX_MODEL") ?? null
    : null;
  const effort = harness === "grok" ? grokEffort(env) ?? null : null;
  return {
    harness,
    requestedModel,
    effectiveModel: requestedModel,
    effort,
    source: configuredHarness !== undefined || requestedModel !== null || effort !== null
      ? "env"
      : "default",
  };
}

function resolveTestWriter(
  env: Record<string, string | undefined>,
  injected: boolean,
): ResolvedAgent {
  if (injected) return injectedAgent();
  const configuredHarness = nonEmptyEnv(env, "BUGLOOP_TESTWRITER");
  const harness = configuredHarness ?? "grok";
  if (harness !== "codex" && harness !== "grok") {
    throw new Error(`BUGLOOP_TESTWRITER must be codex or grok, received ${harness}`);
  }
  const requestedModel = harness === "codex"
    ? nonEmptyEnv(env, "BUGLOOP_CODEX_MODEL") ?? null
    : null;
  const effort = harness === "grok" ? grokEffort(env) ?? null : null;
  return {
    harness,
    requestedModel,
    effectiveModel: requestedModel,
    effort,
    source: configuredHarness !== undefined || requestedModel !== null || effort !== null
      ? "env"
      : "default",
  };
}

export function resolvePipelineRuntime(input: ResolveRuntimeInput): ResolvedPipeline {
  const env = input.env ?? Bun.env;
  const overrides = input.overrides ?? {};
  return {
    pipeline: input.pipeline,
    triage: resolveTriage(input.pipeline, env, overrides.triage === true),
    testWriter: resolveTestWriter(env, overrides.testWriter === true),
    fixer: resolveFixer(input.config, env, overrides.fixer === true),
    regressionTests: input.config.regressionTests,
    maxFixAttempts: input.config.maxFixAttempts,
    incidentConcurrency: input.config.incidentConcurrency,
    mode: {
      fix: input.mode.fix ?? false,
      live: input.mode.live ?? false,
      fromStart: input.mode.fromStart,
    },
  };
}

export async function resolveTraceWorkload(
  config: PipelineConfig,
  repoRoot: string,
): Promise<TraceWorkload> {
  const command = ["git", "-C", repoRoot, "rev-parse", "main"];
  const result = await runProcess(command, { cwd: repoRoot }).catch(() => undefined);
  return {
    ...config.workload,
    codeRevision: result?.exitCode === 0 && result.stdout.trim() !== ""
      ? result.stdout.trim()
      : "unknown",
  };
}
