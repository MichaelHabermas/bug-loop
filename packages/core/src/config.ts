import type { FixerKind } from "./fixer";

export interface PipelineLabels {
  pipeline: string;
  mechanical: string;
  needsHuman: string;
}

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
  invariantWarnPrefixes: string[];
}

export type RegressionTestPolicy = "always" | "triage-decides" | "never";

export type PipelineConfigInput = Omit<PipelineConfig, "branchPrefix" | "regressionTests"> & {
  branchPrefix?: string;
  regressionTests?: RegressionTestPolicy;
};

function normalizePrefix(prefix: string): string {
  return prefix.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function definePipelineConfig(input: PipelineConfigInput): PipelineConfig {
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
  return {
    ...input,
    baseUrl: input.baseUrl.replace(/\/$/, ""),
    fixScope,
    testScope,
    branchPrefix: input.branchPrefix ?? "bugloop/fix-",
    regressionTests: input.regressionTests ?? "triage-decides",
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
