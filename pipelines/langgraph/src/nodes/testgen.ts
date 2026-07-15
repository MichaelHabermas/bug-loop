import {
  createResolvedTestWriter,
  GitWorktreeOperations,
  runRegressionTestStage,
  type PipelineConfig,
  type ResolvedAgent,
  type RegressionTestStrategy,
  type TestWriter,
  type TraceRecorder,
  type TriageState,
  type VerifyRunner,
  type WorktreeOperations,
} from "@bug-loop/core";
import { activeItem, initializeFixQueue } from "./fix";

export interface TestgenDependencies {
  config: PipelineConfig;
  writer?: TestWriter;
  verifier: VerifyRunner;
  worktrees?: WorktreeOperations;
  recorder?: TraceRecorder;
  repoRoot?: string;
  testWriterResolution: ResolvedAgent;
  regressionTestStrategy?: RegressionTestStrategy;
}

export async function testgenWithDependencies(
  state: TriageState,
  dependencies: TestgenDependencies,
): Promise<Partial<TriageState>> {
  const selected = initializeFixQueue(state);
  const incident = selected.activeIncident;
  const fingerprint8 = incident.fingerprint.hash.slice(0, 8);
  const branch = `${dependencies.config.branchPrefix}${fingerprint8}`;
  const worktrees = dependencies.worktrees ?? new GitWorktreeOperations(
    dependencies.repoRoot ?? process.cwd(),
    dependencies.config.worktreeRoot,
    dependencies.config.fixScope,
    dependencies.config.testScope,
  );
  let worktreeDir = state.worktreeDir;
  let worktreeBaseCommit = state.worktreeBaseCommit;
  if (!worktreeDir) {
    const created = await worktrees.create({ branch, fingerprint8 });
    worktreeDir = created.worktreeDir;
    worktreeBaseCommit = created.baseCommit;
  }
  if (!worktreeBaseCommit) throw new Error("testgen requires a worktree base commit");
  const expectedHead = state.pipelineHeadCommit ?? worktreeBaseCommit;
  const item = activeItem(state, incident);
  if (!item.repro || !item.route) throw new Error("testgen requires route and repro evidence");
  const result = await runRegressionTestStage({
    config: dependencies.config,
    worktreeDir,
    incident,
    repro: item.repro,
    route: item.route,
    writer: dependencies.writer,
    createWriter: () => createResolvedTestWriter(
      dependencies.config.testScope,
      dependencies.testWriterResolution,
    ),
    strategy: dependencies.regressionTestStrategy,
    verifier: dependencies.verifier,
    worktrees,
    baseCommit: expectedHead,
    expectedHead,
    recorder: dependencies.recorder,
  });
  return {
    activeIncident: incident,
    fixQueue: selected.fixQueue,
    worktreeDir,
    worktreeBaseCommit,
    pipelineHeadCommit: result.pipelineHeadCommit,
    activeTicket: item.ticket,
    activeRepro: item.repro,
    activeRegressionTest: result.record,
    regressionTestAttempts: [
      ...(state.regressionTestAttempts ?? []),
      ...result.record.attempts,
    ],
  };
}
