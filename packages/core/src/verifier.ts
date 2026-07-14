import { join } from "node:path";
import { runProcess } from "./process";
import type { PipelineConfig } from "./config";
import { isPathInFixScope } from "./config";
import type { ReproStrategy } from "./reproduction";
import type { Incident, TriageState } from "./types";

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
): Promise<Partial<TriageState>> {
  const incident = state.activeIncident;
  const worktreeDir = state.worktreeDir;
  if (!incident || !worktreeDir) {
    throw new Error("verify requires activeIncident and worktreeDir");
  }
  const repro = await safeCheck(() => runner.verifyRepro({ worktreeDir, incident }));
  const regression = state.activeRegressionTest?.status === "established"
    ? runner.runTestFiles
      ? await safeCheck(() => runner.runTestFiles!(
          worktreeDir,
          state.activeRegressionTest?.filesChanged ?? [],
        ))
      : { passes: false, detail: "Verifier cannot run selected regression test files." }
    : { passes: true, detail: "No established regression test to verify." };
  const tests = await safeCheck(() => runner.runTests(worktreeDir));
  const typecheck = await safeCheck(() => runner.runTypecheck(worktreeDir));
  const filesChanged = state.activeFix?.filesChanged ?? [];
  const scopePasses = filesChanged.length > 0 && filesChanged.every(
    (path) => isPathInFixScope(path, fixScope),
  );
  const verified = scopePasses && repro.passes && regression.passes && tests.passes && typecheck.passes;
  const detail = [
    `scope: ${scopePasses ? "pass" : "fail"} - ${filesChanged.join(", ") || "no changed files recorded"}`,
    `repro: ${repro.passes ? "pass" : "fail"} - ${repro.detail}`,
    `regression test: ${regression.passes ? "pass" : "fail"} - ${regression.detail}`,
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
