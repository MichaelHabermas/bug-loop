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
  branchPrefix: string;
  worktreeRoot: string;
  maxFixAttempts: number;
  fixer: FixerKind;
  invariantWarnPrefixes: string[];
}

export type PipelineConfigInput = Omit<PipelineConfig, "branchPrefix"> & {
  branchPrefix?: string;
};

function normalizePrefix(prefix: string): string {
  return prefix.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function definePipelineConfig(input: PipelineConfigInput): PipelineConfig {
  const fixScope = input.fixScope.map(normalizePrefix).filter(Boolean);
  if (fixScope.length === 0) throw new Error("fixScope must contain at least one path prefix");
  if (!Number.isInteger(input.maxFixAttempts) || input.maxFixAttempts < 1) {
    throw new Error("maxFixAttempts must be a positive integer");
  }
  return {
    ...input,
    baseUrl: input.baseUrl.replace(/\/$/, ""),
    fixScope,
    branchPrefix: input.branchPrefix ?? "bugloop/fix-",
  };
}

export function isPathInFixScope(path: string, fixScope: string[]): boolean {
  const normalized = normalizePrefix(path);
  return fixScope.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}
