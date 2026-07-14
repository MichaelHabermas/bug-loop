import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PipelineConfig } from "./config";

export interface CostSample {
  harness: "claude-agent-sdk" | "codex" | "grok";
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  usd?: number;
  raw?: string;
}

export interface TraceEvent {
  seq: number;
  stage: string;
  fingerprint?: string;
  startedAt: string;
  durationMs: number;
  outcome: string;
  detail?: Record<string, unknown>;
  cost?: CostSample;
}

export type PipelineKind = "langgraph" | "agent-sdk";

export type PipelineConfigSummary = Pick<
  PipelineConfig,
  | "repo"
  | "labels"
  | "logPath"
  | "baseUrl"
  | "cursorPath"
  | "fixScope"
  | "testScope"
  | "branchPrefix"
  | "worktreeRoot"
  | "maxFixAttempts"
  | "fixer"
  | "regressionTests"
  | "invariantWarnPrefixes"
>;

export interface RunTrace {
  runId: string;
  startedAt: string;
  finishedAt: string;
  pipeline: PipelineKind;
  config: PipelineConfigSummary;
  events: TraceEvent[];
}

export interface TraceRecorderOptions {
  pipeline: PipelineKind;
  config: PipelineConfig;
  outputPath?: string;
  traceRoot?: string;
  runId?: string;
  now?: () => Date;
}

export interface TraceEventHandle {
  finish(
    outcome: string,
    detail?: Record<string, unknown>,
    cost?: CostSample,
  ): TraceEvent;
}

export class TraceRecorder {
  readonly runId: string;
  readonly outputPath: string;
  private readonly now: () => Date;
  private readonly startedAt: string;
  private readonly pipeline: PipelineKind;
  private readonly config: PipelineConfigSummary;
  private readonly events: TraceEvent[] = [];
  private finishedAt: string | undefined;

  constructor(options: TraceRecorderOptions) {
    this.now = options.now ?? (() => new Date());
    this.runId = options.runId ?? crypto.randomUUID();
    this.outputPath = options.outputPath ?? join(options.traceRoot ?? "traces", `${this.runId}.json`);
    this.pipeline = options.pipeline;
    this.config = {
      ...options.config,
      labels: { ...options.config.labels },
      fixScope: [...options.config.fixScope],
      testScope: [...options.config.testScope],
      invariantWarnPrefixes: [...options.config.invariantWarnPrefixes],
    };
    this.startedAt = this.now().toISOString();
  }

  start(stage: string, fingerprint?: string): TraceEventHandle {
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
          startedAt: started.toISOString(),
          durationMs: Math.max(0, this.now().getTime() - started.getTime()),
          outcome,
          ...(detail === undefined ? {} : { detail }),
          ...(cost === undefined ? {} : { cost }),
        };
        this.events.push(event);
        return event;
      },
    };
  }

  snapshot(): RunTrace {
    return {
      runId: this.runId,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt ?? this.now().toISOString(),
      pipeline: this.pipeline,
      config: this.config,
      events: [...this.events],
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
  const usd = sum((sample) => sample.usd);
  const raw = samples.map((sample) => sample.raw).filter((value): value is string => value !== undefined);
  return {
    harness: first.harness,
    ...(models.size === 1 ? { model: [...models][0] } : {}),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(usd === undefined ? {} : { usd }),
    ...(raw.length === 0 ? {} : { raw: raw.join("\n") }),
  };
}
