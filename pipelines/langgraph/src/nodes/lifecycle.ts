import {
  formatPrFilesList,
  formatRegressionTestIntent,
  rewritePathsForPrBody,
  GitWorktreeOperations,
  GitHubClient,
  type IssueDetails,
  type PRInput,
  type PRRef,
  type TriageState,
  type WorktreeOperations,
  type PipelineConfig,
} from "@bug-loop/core";

export interface GitHubOperations {
  readIssue(number: number): Promise<IssueDetails | null>;
  commentIssue(number: number, body: string): Promise<void>;
  replaceIssueLabel(number: number, remove: string, add: string): Promise<void>;
  createPullRequest(input: PRInput): Promise<PRRef>;
}

export interface LifecycleDependencies {
  config: PipelineConfig;
  github?: GitHubOperations;
  worktrees?: WorktreeOperations;
  repoRoot?: string;
}

function dependencies(input: LifecycleDependencies): {
  github: GitHubOperations;
  worktrees: WorktreeOperations;
} {
  return {
    github: input.github ?? new GitHubClient(input.config.repo),
    worktrees: input.worktrees ?? new GitWorktreeOperations(
      input.repoRoot ?? process.cwd(),
      input.config.worktreeRoot,
      input.config.fixScope,
      input.config.testScope,
    ),
  };
}

function issueNumber(state: TriageState): number {
  const number = state.activeTicket?.issueNumber;
  if (number === undefined) throw new Error("lifecycle node requires an issue ticket");
  return number;
}

function advance(state: TriageState): Partial<TriageState> {
  const queue = state.fixQueue ?? [];
  return {
    activeIncident: queue[0] ?? null,
    fixQueue: queue.slice(1),
    worktreeDir: null,
    retryCount: 0,
    activeFix: undefined,
    activeVerify: undefined,
    activeRegressionTest: undefined,
    activeTicket: undefined,
    activeRepro: undefined,
  };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function giveUpWithDependencies(
  state: TriageState,
  input: LifecycleDependencies,
): Promise<Partial<TriageState>> {
  const { github, worktrees } = dependencies(input);
  const number = issueNumber(state);
  const worktreeDir = state.worktreeDir;
  const errors = [...state.errors];
  try {
    try {
      await github.commentIssue(
        number,
        `Automated fix gave up after ${state.retryCount} attempts.\n\n${state.activeVerify?.detail ?? "Verification did not provide details."}`,
      );
    } catch (error: unknown) {
      errors.push(`give-up comment issue ${number}: ${errorDetail(error)}`);
    }
    try {
      await github.replaceIssueLabel(
        number,
        input.config.labels.mechanical,
        input.config.labels.needsHuman,
      );
    } catch (error: unknown) {
      errors.push(`give-up label issue ${number}: ${errorDetail(error)}`);
    }
    console.log(`[give-up] issue=${number} attempts=${state.retryCount}`);
  } finally {
    if (worktreeDir) {
      try {
        await worktrees.remove(worktreeDir);
      } catch (error: unknown) {
        errors.push(`remove worktree ${worktreeDir}: ${errorDetail(error)}`);
      }
    }
  }
  return { ...advance(state), errors };
}

function pullRequestBody(state: TriageState, number: number, worktreeRoot: string): string {
  const fix = state.activeFix;
  const verify = state.activeVerify;
  if (!fix || !verify) throw new Error("pr requires fix and verify results");
  return [
    "## What changed",
    "",
    rewritePathsForPrBody(fix.description, worktreeRoot),
    "",
    `Files: ${formatPrFilesList([
      ...fix.filesChanged,
      ...(state.activeRegressionTest?.filesChanged ?? []),
    ], worktreeRoot)}`,
    "",
    formatRegressionTestIntent(state.activeRegressionTest),
    "",
    "## Verification",
    "",
    "### Reproduction before",
    "",
    state.activeRepro?.evidence ?? "No pre-fix evidence recorded.",
    "",
    "### Reproduction after",
    "",
    verify.reproEvidence ?? verify.detail,
    "",
    `- Regression test: ${verify.regressionTestDetail ?? (verify.regressionTestPasses ? "pass" : "fail")}`,
    `- Tests: ${verify.testSummary ?? (verify.testsPass ? "pass" : "fail")}`,
    `- Typecheck: ${verify.typecheckDetail ?? (verify.typecheckPasses ? "pass" : "fail")}`,
    "",
    `Fixes #${number}`,
  ].join("\n");
}

export async function prWithDependencies(
  state: TriageState,
  input: LifecycleDependencies,
): Promise<Partial<TriageState>> {
  const { github, worktrees } = dependencies(input);
  const incident = state.activeIncident;
  const fix = state.activeFix;
  const worktreeDir = state.worktreeDir;
  if (!incident || !fix || !worktreeDir || !state.activeVerify?.verified) {
    throw new Error("pr requires a verified fix in an active worktree");
  }
  const number = issueNumber(state);
  const short = `${incident.fingerprint.errName} on ${incident.fingerprint.route}`;
  const message = `fix: ${short} (${input.config.labels.pipeline} pipeline)\n\nFixes #${number}`;
  let pullRequest: PRRef | undefined;
  const errors = [...state.errors];
  try {
    await worktrees.commit({ worktreeDir, message });
    await worktrees.push({ worktreeDir, branch: fix.branch });
    pullRequest = await github.createPullRequest({
      title: `[${input.config.labels.pipeline}] fix: ${short}`,
      body: pullRequestBody(state, number, input.config.worktreeRoot),
      head: fix.branch,
      base: "main",
      labels: [input.config.labels.pipeline],
    });
    await github.commentIssue(number, `Fix verified and PR opened: ${pullRequest.url}`);
    console.log(`[pr] issue=${number} url=${pullRequest.url}`);
  } catch (error: unknown) {
    errors.push(`pr issue ${number}: ${errorDetail(error)}`);
  } finally {
    try {
      await worktrees.remove(worktreeDir);
    } catch (error: unknown) {
      errors.push(`remove worktree ${worktreeDir}: ${errorDetail(error)}`);
    }
  }
  return {
    ...advance(state),
    errors,
    pullRequests: pullRequest
      ? [...(state.pullRequests ?? []), pullRequest]
      : state.pullRequests,
  };
}
