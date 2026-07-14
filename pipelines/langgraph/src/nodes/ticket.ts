import {
  buildIssueInput,
  createIssue,
  type IncidentTriage,
  type IssueInput,
  type IssueRef,
  type TriageState,
  writeCursor,
} from "@bug-loop/shared";
import { currentSummary } from "../state";

type IssueCreator = (input: IssueInput) => Promise<IssueRef>;

export async function ticketWithCreator(
  state: TriageState,
  issueCreator: IssueCreator,
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
      const issue = await issueCreator(buildIssueInput(item));
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
    // Successful reproductions emit logs; commit at EOF so the next run sees only external traffic.
    await writeCursor(config.cursorPath, { offset: Bun.file(state.logPath).size });
  }
  console.log(`[ticket] issues=${issuesFiled}`);
  return {
    triage,
    errors,
    summary: { ...currentSummary(state), issuesFiled },
  };
}

export async function ticketNode(state: TriageState): Promise<Partial<TriageState>> {
  return ticketWithCreator(state, createIssue);
}

export { buildIssueInput };
