import {
  createDefaultFixer,
  GitWorktreeOperations,
  type Fixer,
  type Incident,
  type IncidentTriage,
  type IssueDetails,
  type TriageState,
  type WorktreeOperations,
  type PipelineConfig,
} from "@bug-loop/core";
import { buildIssueInput } from "./ticket";

export interface FixDependencies {
  config: PipelineConfig;
  fixer?: Fixer;
  worktrees?: WorktreeOperations;
  readIssue?: (number: number) => Promise<IssueDetails | null>;
  repoRoot?: string;
}

function mechanicalQueue(triage: IncidentTriage[]): Incident[] {
  return triage
    .filter((item) => item.route?.kind === "mechanical" && item.ticket !== undefined)
    .map((item) => item.incident);
}

export function activeItem(state: TriageState, incident: Incident): IncidentTriage {
  const item = state.triage?.find(
    (candidate) => candidate.incident.fingerprint.hash === incident.fingerprint.hash,
  );
  if (!item) throw new Error(`active incident ${incident.fingerprint.hash} is not in triage`);
  return item;
}

export function initializeFixQueue(state: TriageState): {
  activeIncident: Incident;
  fixQueue: Incident[];
} {
  if (state.activeIncident) {
    return { activeIncident: state.activeIncident, fixQueue: state.fixQueue ?? [] };
  }
  const queue = state.fixQueue ?? mechanicalQueue(state.triage ?? []);
  const activeIncident = queue[0];
  if (!activeIncident) throw new Error("fix requires a mechanical incident with a ticket");
  return { activeIncident, fixQueue: queue.slice(1) };
}

export async function fixWithDependencies(
  state: TriageState,
  dependencies: FixDependencies,
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
  const fixer = dependencies.fixer ?? createDefaultFixer(
    dependencies.config.fixScope,
    dependencies.config.fixer,
  );
  let worktreeDir = state.worktreeDir;
  if (!worktreeDir) {
    const created = await worktrees.create({ branch, fingerprint8 });
    worktreeDir = created.worktreeDir;
  }

  const item = activeItem(state, incident);
  const generatedIssue = buildIssueInput(item, dependencies.config.labels);
  let issue = state.activeIssue;
  if (issue === undefined) {
    try {
      issue = await dependencies.readIssue?.(item.ticket?.issueNumber ?? 0) ?? null;
    } catch (error: unknown) {
      issue = null;
      console.warn(
        `[fix] issue read failed; using generated issue body: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const attempt = state.retryCount + 1;
  const stageBaseCommit = state.pipelineHeadCommit ?? state.worktreeBaseCommit;
  if (!stageBaseCommit) throw new Error("fix requires a trusted pipeline HEAD");
  try {
    const output = await fixer.fix({
      worktreeDir,
      issueTitle: issue?.title ?? generatedIssue.title,
      issueBody: issue?.body ?? generatedIssue.body,
      attempt,
      fixBrief: item.route?.fixBrief ?? "",
      ...(attempt > 1 ? { previousFailure: state.activeVerify?.detail ?? "" } : {}),
    });
    console.log(`[fix] fingerprint=${fingerprint8} attempt=${attempt} files=${output.filesChanged.length}`);
    return {
      activeIncident: incident,
      fixQueue: selected.fixQueue,
      worktreeDir,
      activeTicket: item.ticket,
      activeIssue: issue,
      activeRepro: item.repro,
      activeFix: { attempt, branch, ...output, stageBaseCommit },
      fixAttempts: [
        ...(state.fixAttempts ?? []),
        { attempt, branch, ...output, stageBaseCommit },
      ],
    };
  } catch (error: unknown) {
    const description = `Fixer failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[fix] ${description}`);
    return {
      activeIncident: incident,
      fixQueue: selected.fixQueue,
      worktreeDir,
      activeTicket: item.ticket,
      activeIssue: issue,
      activeRepro: item.repro,
      activeFix: { attempt, branch, description, filesChanged: [], stageBaseCommit },
      fixAttempts: [
        ...(state.fixAttempts ?? []),
        { attempt, branch, description, filesChanged: [], stageBaseCommit },
      ],
    };
  }
}
