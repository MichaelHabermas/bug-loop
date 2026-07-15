import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RegressionTestPolicy } from "./config";

export interface CostSample {
  harness: "claude-agent-sdk" | "codex" | "grok";
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  usd?: number;
  raw?: string;
}

export interface TraceEvent {
  seq: number;
  stage: string;
  fingerprint?: string;
  correlationId?: string;
  attemptId?: string;
  startedAt: string;
  durationMs: number;
  outcome: string;
  detail?: Record<string, unknown>;
  cost?: CostSample;
}

export type PipelineKind = "langgraph" | "agent-sdk";
export type ResolutionSource = "default" | "env" | "arg";

export interface ResolvedAgent {
  harness: string;
  requestedModel: string | null;
  effectiveModel: string | null;
  effort: string | null;
  source: ResolutionSource;
}

export interface ResolvedPipeline {
  pipeline: PipelineKind;
  triage: ResolvedAgent;
  testWriter: ResolvedAgent;
  fixer: ResolvedAgent;
  regressionTests: RegressionTestPolicy;
  maxFixAttempts: number;
  mode: {
    fix: boolean;
    live: boolean;
    fromStart: boolean;
  };
}

export interface TraceWorkload {
  benchmarkId: string;
  seed: number;
  caseCount: number;
  codeRevision: string;
}

export type AgentUsage =
  | {
      status: "reported";
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      usd: number;
    }
  | {
      status: "tokens-only";
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    }
  | {
      status: "unavailable";
      reason: string;
    };

export interface AgentFallback {
  type: string;
  reason: string;
}

export interface AgentCall {
  seq: number;
  stage: string;
  fingerprint?: string;
  correlationId?: string;
  attemptId?: string;
  harness: string;
  effectiveModel: string | null;
  effort: string | null;
  durationMs: number;
  outcome: string;
  usage: AgentUsage;
  fallback?: AgentFallback;
}

export interface RunTrace {
  schemaVersion: 2;
  runId: string;
  startedAt: string;
  finishedAt: string;
  resolved: ResolvedPipeline;
  workload: TraceWorkload;
  label?: string;
  events: TraceEvent[];
  agentCalls: AgentCall[];
}

export interface TraceRecorderOptions {
  pipeline: PipelineKind;
  resolved: ResolvedPipeline;
  workload: TraceWorkload;
  outputPath?: string;
  traceRoot?: string;
  runId?: string;
  label?: string;
  now?: () => Date;
}

export interface RecordAgentCallInput {
  stage: "triage" | "testWriter" | "fixer" | string;
  resolution: "triage" | "testWriter" | "fixer";
  fingerprint?: string;
  correlationId?: string;
  attemptId?: string;
  durationMs: number;
  outcome: string;
  cost?: CostSample;
  unavailableReason?: string;
  fallback?: AgentFallback;
}

export interface TraceEventHandle {
  finish(
    outcome: string,
    detail?: Record<string, unknown>,
    cost?: CostSample,
  ): TraceEvent;
}

export interface TraceIdentity {
  correlationId: string;
  attemptId?: string;
}

export function createCorrelationId(runId: string, fingerprint: string): string {
  return `${runId}:${fingerprint}`;
}

export function createAttemptId(
  correlationId: string,
  stage: string,
  attempt: number,
): string {
  return `${correlationId}:${stage}:${attempt}`;
}

function cloneResolved(resolved: ResolvedPipeline): ResolvedPipeline {
  return {
    ...resolved,
    triage: { ...resolved.triage },
    testWriter: { ...resolved.testWriter },
    fixer: { ...resolved.fixer },
    mode: { ...resolved.mode },
  };
}

function usageFromCost(cost: CostSample | undefined, reason: string): AgentUsage {
  if (cost?.usd !== undefined) {
    return {
      status: "reported",
      ...(cost.inputTokens === undefined ? {} : { inputTokens: cost.inputTokens }),
      ...(cost.outputTokens === undefined ? {} : { outputTokens: cost.outputTokens }),
      ...(cost.totalTokens === undefined ? {} : { totalTokens: cost.totalTokens }),
      usd: cost.usd,
    };
  }
  if (
    cost?.inputTokens !== undefined || cost?.outputTokens !== undefined ||
    cost?.totalTokens !== undefined
  ) {
    return {
      status: "tokens-only",
      ...(cost.inputTokens === undefined ? {} : { inputTokens: cost.inputTokens }),
      ...(cost.outputTokens === undefined ? {} : { outputTokens: cost.outputTokens }),
      ...(cost.totalTokens === undefined ? {} : { totalTokens: cost.totalTokens }),
    };
  }
  return { status: "unavailable", reason };
}

export class TraceRecorder {
  readonly runId: string;
  readonly outputPath: string;
  private readonly now: () => Date;
  private readonly startedAt: string;
  private readonly label: string | undefined;
  private readonly resolved: ResolvedPipeline;
  private readonly workload: TraceWorkload;
  private readonly events: TraceEvent[] = [];
  private readonly agentCalls: AgentCall[] = [];
  private finishedAt: string | undefined;

  constructor(options: TraceRecorderOptions) {
    if (options.pipeline !== options.resolved.pipeline) {
      throw new Error("TraceRecorder pipeline must match resolved.pipeline");
    }
    this.now = options.now ?? (() => new Date());
    this.runId = options.runId ?? crypto.randomUUID();
    this.outputPath = options.outputPath ?? join(options.traceRoot ?? "traces", `${this.runId}.json`);
    this.label = options.label;
    this.resolved = cloneResolved(options.resolved);
    this.workload = { ...options.workload };
    this.startedAt = this.now().toISOString();
  }

  start(stage: string, fingerprint?: string, identity?: TraceIdentity): TraceEventHandle {
    const started = this.now();
    let completed = false;
    return {
      finish: (outcome, detail, cost) => {
        if (completed) throw new Error(`trace event ${stage} was already finished`);
        completed = true;
        const event: TraceEvent = {
          seq: this.events.length + 1,
          stage,
          ...(fingerprint === undefined ? {} : { fingerprint }),
          ...(identity === undefined ? {} : { correlationId: identity.correlationId }),
          ...(identity?.attemptId === undefined ? {} : { attemptId: identity.attemptId }),
          startedAt: started.toISOString(),
          durationMs: Math.max(0, this.now().getTime() - started.getTime()),
          outcome,
          ...(detail === undefined ? {} : { detail }),
          ...(cost === undefined ? {} : { cost }),
        };
        this.events.push(event);
        if (stage === "fix") {
          this.recordAgentCall({
            stage: "fixer",
            resolution: "fixer",
            ...(fingerprint === undefined ? {} : { fingerprint }),
            ...(identity === undefined ? {} : { correlationId: identity.correlationId }),
            ...(identity?.attemptId === undefined ? {} : { attemptId: identity.attemptId }),
            durationMs: event.durationMs,
            outcome,
            ...(cost === undefined ? {} : { cost }),
          });
        } else if (stage === "testgen") {
          this.recordAgentCall({
            stage: "testWriter",
            resolution: "testWriter",
            ...(fingerprint === undefined ? {} : { fingerprint }),
            ...(identity === undefined ? {} : { correlationId: identity.correlationId }),
            ...(identity?.attemptId === undefined ? {} : { attemptId: identity.attemptId }),
            durationMs: event.durationMs,
            outcome,
            ...(cost === undefined ? {} : { cost }),
          });
        }
        return event;
      },
    };
  }

  recordAgentCall(input: RecordAgentCallInput): AgentCall {
    const resolution = this.resolved[input.resolution];
    const call: AgentCall = {
      seq: this.agentCalls.length + 1,
      stage: input.stage,
      ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      harness: resolution.harness,
      effectiveModel: input.cost?.model ?? resolution.effectiveModel,
      effort: resolution.effort,
      durationMs: Math.max(0, input.durationMs),
      outcome: input.outcome,
      usage: usageFromCost(
        input.cost,
        input.unavailableReason ?? "harness-did-not-report-usage",
      ),
      ...(input.fallback === undefined ? {} : { fallback: { ...input.fallback } }),
    };
    this.agentCalls.push(call);
    return call;
  }

  snapshot(): RunTrace {
    return {
      schemaVersion: 2,
      runId: this.runId,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt ?? this.now().toISOString(),
      resolved: cloneResolved(this.resolved),
      workload: { ...this.workload },
      ...(this.label === undefined ? {} : { label: this.label }),
      events: [...this.events],
      agentCalls: [...this.agentCalls],
    };
  }

  async finish(): Promise<RunTrace> {
    this.finishedAt ??= this.now().toISOString();
    const trace = this.snapshot();
    await mkdir(dirname(this.outputPath), { recursive: true });
    await Bun.write(this.outputPath, `${JSON.stringify(trace, null, 2)}\n`);
    return trace;
  }
}

export function combineCostSamples(samples: CostSample[]): CostSample | undefined {
  const first = samples[0];
  if (!first) return undefined;
  if (samples.some((sample) => sample.harness !== first.harness)) return undefined;
  const models = new Set(samples.map((sample) => sample.model).filter((model) => model !== undefined));
  const sum = (select: (sample: CostSample) => number | undefined): number | undefined => {
    const values = samples.map(select).filter((value): value is number => value !== undefined);
    return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);
  };
  const inputTokens = sum((sample) => sample.inputTokens);
  const outputTokens = sum((sample) => sample.outputTokens);
  const totalTokens = sum((sample) => sample.totalTokens);
  const usd = sum((sample) => sample.usd);
  const raw = samples.map((sample) => sample.raw).filter((value): value is string => value !== undefined);
  return {
    harness: first.harness,
    ...(models.size === 1 ? { model: [...models][0] } : {}),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(usd === undefined ? {} : { usd }),
    ...(raw.length === 0 ? {} : { raw: raw.join("\n") }),
  };
}
