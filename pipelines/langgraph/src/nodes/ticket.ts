import {
  FINGERPRINT_MARKER,
  createIssue,
  type IncidentTriage,
  type IssueInput,
  type IssueRef,
  type TriageState,
} from "@bug-loop/shared";
import { currentSummary } from "../state";
import { writeCursor } from "../cursor";

type IssueCreator = (input: IssueInput) => Promise<IssueRef>;

export function buildIssueInput(item: IncidentTriage): IssueInput {
  const { incident } = item;
  const repro = item.repro ?? {
    reproduced: false,
    command: "",
    evidence: "No reproduction result.",
  };
  const route = item.route ?? {
    kind: "needs-human" as const,
    reason: "No route decision was recorded.",
  };
  const sample = incident.sampleEvents[0];
  const body = [
    FINGERPRINT_MARKER(incident.fingerprint.hash),
    "",
    `- Count: ${incident.count}`,
    `- First seen: ${incident.firstSeen}`,
    `- Last seen: ${incident.lastSeen}`,
    "",
    "## Sample log",
    "",
    "```json",
    JSON.stringify(sample, null, 2),
    "```",
    "",
    "## Reproduction",
    "",
    "```bash",
    repro.command,
    "```",
    "",
    `Reproduced: ${repro.reproduced ? "yes" : "no"}`,
    "",
    "```text",
    repro.evidence,
    "```",
    "",
    "## Route",
    "",
    `**${route.kind}** - ${route.reason}`,
  ].join("\n");
  return {
    title: `[bug-loop] ${incident.fingerprint.errName} on ${incident.fingerprint.route}`,
    body,
    labels: [
      "bug-loop",
      route.kind === "mechanical" ? "auto-fix-candidate" : "needs-human",
    ],
  };
}

export async function ticketWithCreator(
  state: TriageState,
  issueCreator: IssueCreator,
): Promise<Partial<TriageState>> {
  const triage: IncidentTriage[] = [];
  const errors = [...state.errors];
  let issuesFiled = 0;
  let ticketFailed = false;
  for (const item of state.triage ?? []) {
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
