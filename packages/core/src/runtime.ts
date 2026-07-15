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
    const model = env["BUGLOOP_TRIAGE_MODEL"] ?? "sonnet";
    return {
      harness: "claude-agent-sdk",
      requestedModel: model,
      effectiveModel: model,
      effort: null,
      source: env["BUGLOOP_TRIAGE_MODEL"] === undefined ? "default" : "env",
    };
  }
  if (env["OPENAI_API_KEY"] !== undefined) {
    const model = env["BUGLOOP_CLASSIFIER_MODEL"] ?? "gpt-4o-mini";
    return {
      harness: "openai-api",
      requestedModel: model,
      effectiveModel: model,
      effort: null,
      source: "env",
    };
  }
  return {
    harness: "heuristic",
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
  const harness = env["BUGLOOP_FIXER"] ?? config.fixer;
  if (harness !== "codex" && harness !== "grok") {
    throw new Error(`BUGLOOP_FIXER must be codex or grok, received ${harness}`);
  }
  const requestedModel = harness === "codex" ? env["BUGLOOP_CODEX_MODEL"] ?? null : null;
  const effort = harness === "grok" ? env["BUGLOOP_GROK_EFFORT"] ?? null : null;
  return {
    harness,
    requestedModel,
    effectiveModel: requestedModel,
    effort,
    source: env["BUGLOOP_FIXER"] !== undefined || requestedModel !== null || effort !== null
      ? "env"
      : "default",
  };
}

function resolveTestWriter(
  env: Record<string, string | undefined>,
  injected: boolean,
): ResolvedAgent {
  if (injected) return injectedAgent();
  const harness = env["BUGLOOP_TESTWRITER"] ?? "grok";
  if (harness !== "codex" && harness !== "grok") {
    throw new Error(`BUGLOOP_TESTWRITER must be codex or grok, received ${harness}`);
  }
  const requestedModel = harness === "codex" ? env["BUGLOOP_CODEX_MODEL"] ?? null : null;
  const effort = harness === "grok" ? env["BUGLOOP_GROK_EFFORT"] ?? null : null;
  return {
    harness,
    requestedModel,
    effectiveModel: requestedModel,
    effort,
    source: env["BUGLOOP_TESTWRITER"] !== undefined || requestedModel !== null || effort !== null
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
