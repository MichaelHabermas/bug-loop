import {
  commentIssue,
  createPullRequest,
  readIssue,
  replaceIssueLabel,
  GitWorktreeOperations,
  type IssueDetails,
  type PRInput,
  type PRRef,
  type TriageState,
  type WorktreeOperations,
} from "@bug-loop/shared";

export interface GitHubOperations {
  readIssue(number: number): Promise<IssueDetails | null>;
  commentIssue(number: number, body: string): Promise<void>;
  replaceIssueLabel(number: number, remove: string, add: string): Promise<void>;
  createPullRequest(input: PRInput): Promise<PRRef>;
}

export interface LifecycleDependencies {
  github?: GitHubOperations;
  worktrees?: WorktreeOperations;
  repoRoot?: string;
}

const defaultGitHub: GitHubOperations = {
  readIssue,
  commentIssue,
  replaceIssueLabel,
  createPullRequest,
};

function dependencies(input: LifecycleDependencies): {
  github: GitHubOperations;
  worktrees: WorktreeOperations;
} {
  return {
    github: input.github ?? defaultGitHub,
    worktrees: input.worktrees ?? new GitWorktreeOperations(input.repoRoot ?? process.cwd()),
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
    activeTicket: undefined,
    activeRepro: undefined,
  };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function giveUpWithDependencies(
  state: TriageState,
  input: LifecycleDependencies = {},
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
      await github.replaceIssueLabel(number, "auto-fix-candidate", "needs-human");
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

function pullRequestBody(state: TriageState, number: number): string {
  const fix = state.activeFix;
  const verify = state.activeVerify;
  if (!fix || !verify) throw new Error("pr requires fix and verify results");
  return [
    "## What changed",
    "",
    fix.description,
    "",
    `Files: ${fix.filesChanged.join(", ") || "none recorded"}`,
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
    `- Tests: ${verify.testSummary ?? (verify.testsPass ? "pass" : "fail")}`,
    `- Typecheck: ${verify.typecheckDetail ?? (verify.typecheckPasses ? "pass" : "fail")}`,
    "",
    `Fixes #${number}`,
  ].join("\n");
}

export async function prWithDependencies(
  state: TriageState,
  input: LifecycleDependencies = {},
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
  const message = `fix: ${short} (bug-loop pipeline)\n\nFixes #${number}`;
  let pullRequest: PRRef | undefined;
  const errors = [...state.errors];
  try {
    await worktrees.commit({ worktreeDir, message });
    await worktrees.push({ worktreeDir, branch: fix.branch });
    pullRequest = await github.createPullRequest({
      title: `[bug-loop] fix: ${short}`,
      body: pullRequestBody(state, number),
      head: fix.branch,
      base: "main",
      labels: ["bug-loop"],
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
