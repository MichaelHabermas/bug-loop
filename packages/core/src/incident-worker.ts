import type { PipelineConfig } from "./config";
import {
  createResolvedTestWriter,
  type TestWriter,
} from "./test-writer";
import { takeFixerCost, type Fixer } from "./fixer";
import { runRegressionTestStage, type RegressionTestStrategy } from "./regression";
import { buildIssueInput } from "./ticket";
import {
  createAttemptId,
  createCorrelationId,
  type ResolvedAgent,
  type TraceRecorder,
} from "./trace";
import type {
  FixAttempt,
  IncidentTriage,
  RegressionTestRecord,
  VerifyResult,
} from "./types";
import {
  PristineSuiteCache,
  verifyWithRunner,
  type VerifyRunner,
} from "./verifier";
import type { IssueDetails } from "./github";
import type { WorktreeOperations } from "./worktree";
import { mapWithConcurrency } from "./concurrency";

export type IncidentOutcome = "verified" | "give-up";

export interface IncidentResult {
  readonly correlationId: string;
  readonly item: IncidentTriage;
  readonly outcome: IncidentOutcome;
  readonly branch: string;
  readonly worktreeDir: string;
  readonly regressionTest: RegressionTestRecord;
  readonly fixAttempts: readonly FixAttempt[];
  readonly verifyResults: readonly VerifyResult[];
  readonly finalFix: FixAttempt;
  readonly finalVerify: VerifyResult;
}

export interface IncidentWorkerInput {
  item: IncidentTriage;
  config: PipelineConfig;
  recorder?: TraceRecorder;
  worktrees: WorktreeOperations;
  createFixer(): Fixer;
  createTestWriter?: () => TestWriter;
  testWriterResolution: ResolvedAgent;
  createVerifier(): VerifyRunner;
  readIssue(number: number): Promise<IssueDetails | null>;
  regressionTestStrategy?: RegressionTestStrategy;
  pristineSuiteCache: PristineSuiteCache;
}

export interface IncidentBatchInput extends Omit<IncidentWorkerInput, "item" | "pristineSuiteCache"> {
  items: readonly IncidentTriage[];
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableResult(result: IncidentResult): IncidentResult {
  return deepFreeze(structuredClone(result));
}

export async function runIncidentWorker(input: IncidentWorkerInput): Promise<IncidentResult> {
  const route = input.item.route;
  const repro = input.item.repro;
  const ticket = input.item.ticket;
  if (route?.kind !== "mechanical" || !repro || !ticket) {
    throw new Error("incident worker requires a ticketed mechanical route with repro evidence");
  }
  const fingerprint = input.item.incident.fingerprint.hash;
  const fingerprint8 = fingerprint.slice(0, 8);
  const correlationId = createCorrelationId(input.recorder?.runId ?? "untraced", fingerprint);
  const branch = `${input.config.branchPrefix}${fingerprint8}`;
  const created = await input.worktrees.create({ branch, fingerprint8 });
  try {
    const fixer = input.createFixer();
    const verifier = input.createVerifier();
    let testWriter: TestWriter | undefined;
    const regression = await runRegressionTestStage({
      config: input.config,
      worktreeDir: created.worktreeDir,
      incident: input.item.incident,
      repro,
      route,
      createWriter: () => {
        testWriter ??= input.createTestWriter?.() ?? createResolvedTestWriter(
          input.config.testScope,
          input.testWriterResolution,
        );
        return testWriter;
      },
      strategy: input.regressionTestStrategy,
      verifier,
      worktrees: input.worktrees,
      baseCommit: created.baseCommit,
      expectedHead: created.baseCommit,
      recorder: input.recorder,
      pristineSuiteCache: input.pristineSuiteCache,
    });
    const generatedIssue = buildIssueInput(input.item, input.config.labels);
    let issue: IssueDetails | null = null;
    try {
      issue = await input.readIssue(ticket.issueNumber);
    } catch (error: unknown) {
      console.warn(`[fix] issue read failed; using generated issue body: ${errorDetail(error)}`);
    }

    const fixAttempts: FixAttempt[] = [];
    const verifyResults: VerifyResult[] = [];
    let previousFailure: string | undefined;
    let activeRegressionTest = regression.record;
    for (let attempt = 1; attempt <= input.config.maxFixAttempts; attempt += 1) {
      const attemptId = createAttemptId(correlationId, "fix", attempt);
      const fixEvent = input.recorder?.start("fix", fingerprint, { correlationId, attemptId });
      let fix: FixAttempt;
      try {
        const output = await fixer.fix({
          worktreeDir: created.worktreeDir,
          issueTitle: issue?.title ?? generatedIssue.title,
          issueBody: issue?.body ?? generatedIssue.body,
          attempt,
          fixBrief: route.fixBrief ?? "",
          ...(previousFailure === undefined ? {} : { previousFailure }),
        });
        fix = {
          attempt,
          branch,
          ...output,
          stageBaseCommit: regression.pipelineHeadCommit,
        };
        fixEvent?.finish(
          `attempt ${attempt}`,
          { attempt, filesChanged: output.filesChanged },
          takeFixerCost(fixer),
        );
      } catch (error: unknown) {
        fix = {
          attempt,
          branch,
          description: `Fixer failed: ${errorDetail(error)}`,
          filesChanged: [],
          stageBaseCommit: regression.pipelineHeadCommit,
        };
        fixEvent?.finish(
          "error",
          { attempt, error: errorDetail(error) },
          takeFixerCost(fixer),
        );
      }
      fixAttempts.push(fix);
      const verifyState = {
        logPath: input.config.logPath,
        pipelineConfig: input.config,
        events: [],
        incidents: [input.item.incident],
        activeIncident: input.item.incident,
        worktreeDir: created.worktreeDir,
        worktreeBaseCommit: created.baseCommit,
        pipelineHeadCommit: regression.pipelineHeadCommit,
        activeRepro: repro,
        activeTicket: ticket,
        activeFix: fix,
        activeRegressionTest,
        retryCount: attempt - 1,
        errors: [],
      };
      const verifyAttemptId = createAttemptId(correlationId, "verify", attempt);
      const verifyEvent = input.recorder?.start("verify", fingerprint, {
        correlationId,
        attemptId: verifyAttemptId,
      });
      const verified = await verifyWithRunner(
        verifyState,
        verifier,
        input.config.fixScope,
        input.worktrees,
      );
      const result = verified.activeVerify;
      if (!result) throw new Error("verify did not return a result");
      verifyEvent?.finish(result.verified ? "verified" : "failed", {
        attempt,
        scopePasses: result.scopePasses,
        regressionTestPasses: result.regressionTestPasses,
        reproPasses: result.reproPasses,
        testsPass: result.testsPass,
        typecheckPasses: result.typecheckPasses,
      });
      verifyResults.push(result);
      activeRegressionTest = verified.activeRegressionTest ?? activeRegressionTest;
      if (result.verified) {
        return immutableResult({
          correlationId,
          item: input.item,
          outcome: "verified",
          branch,
          worktreeDir: created.worktreeDir,
          regressionTest: activeRegressionTest,
          fixAttempts,
          verifyResults,
          finalFix: fix,
          finalVerify: result,
        });
      }
      previousFailure = result.detail;
    }
    const finalFix = fixAttempts.at(-1);
    const finalVerify = verifyResults.at(-1);
    if (!finalFix || !finalVerify) throw new Error("incident worker completed without an attempt");
    return immutableResult({
      correlationId,
      item: input.item,
      outcome: "give-up",
      branch,
      worktreeDir: created.worktreeDir,
      regressionTest: activeRegressionTest,
      fixAttempts,
      verifyResults,
      finalFix,
      finalVerify,
    });
  } catch (error: unknown) {
    try {
      await input.worktrees.remove(created.worktreeDir);
    } catch (cleanupError: unknown) {
      console.warn(`failed to remove incident worktree: ${errorDetail(cleanupError)}`);
    }
    throw error;
  }
}

export async function runIncidentWorkers(
  input: IncidentBatchInput,
): Promise<Array<IncidentResult | Error>> {
  const pristineSuiteCache = new PristineSuiteCache();
  const { items, ...workerInput } = input;
  return mapWithConcurrency(
    items,
    input.config.incidentConcurrency,
    async (item) => {
      try {
        return await runIncidentWorker({ ...workerInput, item, pristineSuiteCache });
      } catch (error: unknown) {
        return error instanceof Error ? error : new Error(String(error));
      }
    },
  );
}
