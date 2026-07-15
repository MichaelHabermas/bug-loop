import type { FixerKind } from "./fixer";

export interface PipelineLabels {
  pipeline: string;
  mechanical: string;
  needsHuman: string;
}

export interface ContractRegistryEntry {
  id: string;
  statement: string;
}

export interface PipelineWorkloadDefinition {
  benchmarkId: string;
  seed: number;
  caseCount: number;
}

export interface WatchSettings {
  /** How often to poll the log for new bytes while idle. */
  pollIntervalMs: number;
  /** Quiet period after the last new event before a pass starts. */
  debounceMs: number;
  /** Idle status line interval while watching with no new events. */
  heartbeatMs: number;
}

export const DEFAULT_WATCH_SETTINGS: WatchSettings = {
  pollIntervalMs: 15_000,
  debounceMs: 5_000,
  heartbeatMs: 60_000,
};

export interface PipelineConfig {
  repo: string;
  labels: PipelineLabels;
  logPath: string;
  baseUrl: string;
  cursorPath: string;
  fixScope: string[];
  testScope: string[];
  branchPrefix: string;
  worktreeRoot: string;
  maxFixAttempts: number;
  fixer: FixerKind;
  regressionTests: RegressionTestPolicy;
  contractRegistry: ContractRegistryEntry[];
  invariantWarnPrefixes: string[];
  incidentConcurrency: number;
  workload: PipelineWorkloadDefinition;
  watch: WatchSettings;
}

export type RegressionTestPolicy = "always" | "triage-decides" | "never";

export type PipelineConfigInput = Omit<
  PipelineConfig,
  | "branchPrefix"
  | "regressionTests"
  | "contractRegistry"
  | "workload"
  | "incidentConcurrency"
  | "watch"
> & {
  branchPrefix?: string;
  regressionTests?: RegressionTestPolicy;
  contractRegistry?: ContractRegistryEntry[];
  workload?: PipelineWorkloadDefinition;
  incidentConcurrency?: number;
  watch?: Partial<WatchSettings>;
};

function normalizePrefix(prefix: string): string {
  return prefix.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function nonEmptyEnv(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key];
  return value === undefined || value === "" ? undefined : value;
}

function positiveIntEnv(
  env: Record<string, string | undefined>,
  key: string,
): number | undefined {
  const raw = nonEmptyEnv(env, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer, received ${raw}`);
  }
  return value;
}

/**
 * Resolve watch-mode timing. Defaults match the daemon contract:
 * poll 15s, debounce 5s, heartbeat 60s. Env keys:
 * BUGLOOP_WATCH_POLL_MS, BUGLOOP_WATCH_DEBOUNCE_MS, BUGLOOP_WATCH_HEARTBEAT_MS.
 */
export function resolveWatchSettings(
  input?: Partial<WatchSettings>,
  env: Record<string, string | undefined> = Bun.env,
): WatchSettings {
  const pollIntervalMs =
    positiveIntEnv(env, "BUGLOOP_WATCH_POLL_MS") ??
    input?.pollIntervalMs ??
    DEFAULT_WATCH_SETTINGS.pollIntervalMs;
  const debounceMs =
    positiveIntEnv(env, "BUGLOOP_WATCH_DEBOUNCE_MS") ??
    input?.debounceMs ??
    DEFAULT_WATCH_SETTINGS.debounceMs;
  const heartbeatMs =
    positiveIntEnv(env, "BUGLOOP_WATCH_HEARTBEAT_MS") ??
    input?.heartbeatMs ??
    DEFAULT_WATCH_SETTINGS.heartbeatMs;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error("watch.pollIntervalMs must be a positive integer");
  }
  if (!Number.isInteger(debounceMs) || debounceMs < 1) {
    throw new Error("watch.debounceMs must be a positive integer");
  }
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1) {
    throw new Error("watch.heartbeatMs must be a positive integer");
  }
  return { pollIntervalMs, debounceMs, heartbeatMs };
}

/** Label for a watch pass: optional base + `-watch-passN`. */
export function watchPassLabel(baseLabel: string | undefined, passNumber: number): string {
  if (!Number.isInteger(passNumber) || passNumber < 1) {
    throw new Error("watch pass number must be a positive integer");
  }
  const suffix = `-watch-pass${passNumber}`;
  return baseLabel === undefined || baseLabel === "" ? `watch-pass${passNumber}` : `${baseLabel}${suffix}`;
}

export function definePipelineConfig(
  input: PipelineConfigInput,
  env: Record<string, string | undefined> = Bun.env,
): PipelineConfig {
  const fixScope = input.fixScope.map(normalizePrefix).filter(Boolean);
  const testScope = input.testScope.map(normalizePrefix).filter(Boolean);
  if (fixScope.length === 0) throw new Error("fixScope must contain at least one path prefix");
  if (testScope.length === 0) throw new Error("testScope must contain at least one path prefix");
  const overlaps = fixScope.some((fixPrefix) => testScope.some(
    (testPrefix) =>
      fixPrefix === testPrefix ||
      fixPrefix.startsWith(`${testPrefix}/`) ||
      testPrefix.startsWith(`${fixPrefix}/`),
  ));
  if (overlaps) throw new Error("fixScope and testScope must not overlap");
  if (!Number.isInteger(input.maxFixAttempts) || input.maxFixAttempts < 1) {
    throw new Error("maxFixAttempts must be a positive integer");
  }
  const incidentConcurrency = input.incidentConcurrency ?? 1;
  if (!Number.isInteger(incidentConcurrency) || incidentConcurrency < 1 || incidentConcurrency > 3) {
    throw new Error("incidentConcurrency must be an integer between 1 and 3");
  }
  const contractRegistry = input.contractRegistry ?? [];
  const contractIds = new Set<string>();
  for (const contract of contractRegistry) {
    if (contract.id.trim() === "" || contract.statement.trim() === "") {
      throw new Error("contractRegistry entries require non-empty id and statement values");
    }
    if (contractIds.has(contract.id)) {
      throw new Error(`contractRegistry contains duplicate id ${contract.id}`);
    }
    contractIds.add(contract.id);
  }
  return {
    ...input,
    baseUrl: input.baseUrl.replace(/\/$/, ""),
    fixScope,
    testScope,
    branchPrefix: input.branchPrefix ?? "bugloop/fix-",
    regressionTests: input.regressionTests ?? "triage-decides",
    contractRegistry: contractRegistry.map((contract) => ({ ...contract })),
    incidentConcurrency,
    workload: input.workload === undefined
      ? { benchmarkId: "unknown", seed: 0, caseCount: 0 }
      : { ...input.workload },
    watch: resolveWatchSettings(input.watch, env),
  };
}

export function isPathInScope(path: string, scope: string[]): boolean {
  const normalized = normalizePrefix(path);
  return scope.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

export function isPathInFixScope(path: string, fixScope: string[]): boolean {
  return isPathInScope(path, fixScope);
}

export function isPathInTestScope(path: string, testScope: string[]): boolean {
  return isPathInScope(path, testScope);
}
