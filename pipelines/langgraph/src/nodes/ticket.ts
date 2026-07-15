import {
  buildIssueInput,
  resolveCommitCursorOffset,
  type IncidentTriage,
  type IssueInput,
  type IssueRef,
  type TriageState,
  writeCursor,
  type PipelineLabels,
} from "@bug-loop/core";
import { currentSummary } from "../state";

type IssueCreator = (input: IssueInput) => Promise<IssueRef>;

export async function ticketWithCreator(
  state: TriageState,
  issueCreator: IssueCreator,
  labels: PipelineLabels,
): Promise<Partial<TriageState>> {
  const triage: IncidentTriage[] = [];
  const errors = [...state.errors];
  let issuesFiled = 0;
  let ticketFailed = false;
  for (const item of state.triage ?? []) {
    if (item.ticket) {
      triage.push(item);
      continue;
    }
    try {
      const issue = await issueCreator(buildIssueInput(item, labels));
      triage.push({
        ...item,
        ticket: { issueNumber: issue.number, url: issue.url },
      });
      issuesFiled += 1;
    } catch (error: unknown) {
      ticketFailed = true;
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`ticket ${item.incident.fingerprint.hash}: ${message}`);
      triage.push(item);
    }
  }
  const config = state.config;
  if (!ticketFailed && config) {
    // One-shot commits at EOF (skip repro-emitted logs). Watch commits the
    // debounced batch end so mid-pass service events are not skipped.
    const cursorPath = state.pipelineConfig?.cursorPath;
    if (!cursorPath) throw new Error("ticket requires pipelineConfig.cursorPath");
    await writeCursor(cursorPath, {
      offset: resolveCommitCursorOffset(config, state.logPath),
    });
  }
  console.log(`[ticket] issues=${issuesFiled}`);
  return {
    triage,
    errors,
    summary: { ...currentSummary(state), issuesFiled },
  };
}

export async function ticketNode(
  state: TriageState,
  issueCreator: IssueCreator,
  labels: PipelineLabels,
): Promise<Partial<TriageState>> {
  return ticketWithCreator(state, issueCreator, labels);
}

export { buildIssueInput };
