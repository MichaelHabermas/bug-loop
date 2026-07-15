import { join } from "node:path";
import { runProcess } from "./process";
import type { PipelineConfig } from "./config";
import type { ReproStrategy } from "./reproduction";
import type { Incident, TriageState } from "./types";
import type { WorktreeOperations } from "./worktree";

export interface CheckResult {
  passes: boolean;
  detail: string;
}

export interface VerifyReproInput {
  worktreeDir: string;
  incident: Incident;
}

export interface VerifyRunner {
  verifyRepro(input: VerifyReproInput): Promise<CheckResult>;
  runTests(worktreeDir: string): Promise<CheckResult>;
  runTestFiles?(worktreeDir: string, files: string[]): Promise<CheckResult>;
  runTypecheck(worktreeDir: string): Promise<CheckResult>;
}

export class PristineSuiteCache {
  private readonly results = new Map<string, Promise<CheckResult>>();

  get(baseSha: string, run: () => Promise<CheckResult>): Promise<CheckResult> {
    const cached = this.results.get(baseSha);
    if (cached) return cached;
    const pending = run().catch((error: unknown) => ({
      passes: false,
      detail: error instanceof Error ? error.message : String(error),
    }));
    this.results.set(baseSha, pending);
    return pending;
  }
}

export function reproCheckPasses(
  requestCompleted: boolean,
  signaturePresent: boolean,
): boolean {
  return requestCompleted && !signaturePresent;
}

function outputTail(output: string): string {
  return output.split("\n").slice(-12).join("\n").trim();
}

export class RealVerifyRunner implements VerifyRunner {
  constructor(
    private readonly config: PipelineConfig,
    private readonly reproStrategy?: ReproStrategy,
  ) {}

  async verifyRepro(input: VerifyReproInput): Promise<CheckResult> {
    const sample = input.incident.sampleEvents[0];
    if (!sample) return { passes: false, detail: "Incident has no sample log." };
    const plan = this.reproStrategy?.derive({
      logPath: this.config.logPath,
      baseUrl: this.config.baseUrl,
      incident: input.incident,
      sample,
    });
    if (!plan) return { passes: false, detail: "No verification reproduction could be derived." };
    return plan.verify(input);
  }

  async runTests(worktreeDir: string): Promise<CheckResult> {
    return this.runBunTests(worktreeDir, []);
  }

  async runTestFiles(worktreeDir: string, files: string[]): Promise<CheckResult> {
    return this.runBunTests(worktreeDir, files);
  }

  private async runBunTests(worktreeDir: string, files: string[]): Promise<CheckResult> {
    const result = await runProcess(["bun", "test", ...files], {
      cwd: worktreeDir,
      env: {
        ...Bun.env,
        PORT: "0",
        LOG_PATH: join(worktreeDir, "logs", "verify-tests.jsonl"),
      },
    });
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    const pass = combined.match(/\b(\d+) pass\b/)?.[1];
    const fail = combined.match(/\b(\d+) fail\b/)?.[1];
    const summary = pass !== undefined
      ? `${pass} pass, ${fail ?? "0"} fail`
      : outputTail(combined);
    return { passes: result.exitCode === 0, detail: summary };
  }

  async runTypecheck(worktreeDir: string): Promise<CheckResult> {
    const result = await runProcess(["bun", "run", "typecheck"], { cwd: worktreeDir });
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    return {
      passes: result.exitCode === 0,
      detail: combined ? outputTail(combined) : "TypeScript: No errors found",
    };
  }
}

async function safeCheck(check: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await check();
  } catch (error: unknown) {
    return {
      passes: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function verifyWithRunner(
  state: TriageState,
  runner: VerifyRunner,
  fixScope: string[],
  worktrees: WorktreeOperations,
): Promise<Partial<TriageState>> {
  const incident = state.activeIncident;
  const worktreeDir = state.worktreeDir;
  if (!incident || !worktreeDir) {
    throw new Error("verify requires activeIncident and worktreeDir");
  }
  const stageBaseCommit = state.activeFix?.stageBaseCommit ?? state.pipelineHeadCommit ??
    state.worktreeBaseCommit;
  if (!stageBaseCommit) throw new Error("verify requires a trusted fix-stage base commit");
  const expectedHead = state.pipelineHeadCommit ?? state.worktreeBaseCommit;
  if (!expectedHead) throw new Error("verify requires a trusted pipeline HEAD");
  const provenance = await safeCheck(async () => {
    const result = await worktrees.verifyProvenance({
      worktreeDir,
      baseCommit: stageBaseCommit,
      expectedHead,
      scope: fixScope,
    });
    return { passes: result.passes, detail: result.detail };
  });
  const scopePasses = provenance.passes;
  const skipped = (stage: string, prerequisite: string): CheckResult => ({
    passes: false,
    detail: `${stage} skipped because ${prerequisite} failed.`,
  });
  const regression = !scopePasses
    ? skipped("regression test", "scope verification")
    : state.activeRegressionTest?.status === "established"
      ? runner.runTestFiles
        ? await safeCheck(() => runner.runTestFiles!(
            worktreeDir,
            state.activeRegressionTest?.filesChanged ?? [],
          ))
        : { passes: false, detail: "Verifier cannot run selected regression test files." }
      : { passes: true, detail: "No established regression test to verify." };
  const repro = !scopePasses || !regression.passes
    ? skipped("repro", !scopePasses ? "scope verification" : "regression test")
    : await safeCheck(() => runner.verifyRepro({ worktreeDir, incident }));
  const tests = !scopePasses || !regression.passes || !repro.passes
    ? skipped("tests", !repro.passes ? "repro" : "an earlier verification stage")
    : await safeCheck(() => runner.runTests(worktreeDir));
  const typecheck = !scopePasses || !regression.passes || !repro.passes || !tests.passes
    ? skipped("typecheck", !tests.passes ? "tests" : "an earlier verification stage")
    : await safeCheck(() => runner.runTypecheck(worktreeDir));
  const verified = scopePasses && repro.passes && regression.passes && tests.passes && typecheck.passes;
  const detail = [
    `scope: ${scopePasses ? "pass" : "fail"} - ${provenance.detail}`,
    `regression test: ${regression.passes ? "pass" : "fail"} - ${regression.detail}`,
    `repro: ${repro.passes ? "pass" : "fail"} - ${repro.detail}`,
    `tests: ${tests.passes ? "pass" : "fail"} - ${tests.detail}`,
    `typecheck: ${typecheck.passes ? "pass" : "fail"} - ${typecheck.detail}`,
  ].join("\n");
  const result = {
    verified,
    scopePasses,
    reproPasses: repro.passes,
    testsPass: tests.passes,
    typecheckPasses: typecheck.passes,
    regressionTestPasses: regression.passes,
    reproEvidence: repro.detail,
    testSummary: tests.detail,
    typecheckDetail: typecheck.detail,
    regressionTestDetail: regression.detail,
    detail,
  };
  return {
    activeVerify: result,
    ...(state.activeRegressionTest?.status === "established"
      ? {
          activeRegressionTest: {
            ...state.activeRegressionTest,
            ...(regression.passes ? { greenEvidence: regression.detail } : {}),
          },
        }
      : {}),
    verifyResults: [...(state.verifyResults ?? []), result],
    retryCount: verified ? state.retryCount : state.retryCount + 1,
  };
}
