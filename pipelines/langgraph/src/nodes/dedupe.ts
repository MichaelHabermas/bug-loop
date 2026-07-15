import {
  groupIncidents,
  findOpenIssueByMarker,
  resolveCommitCursorOffset,
  type Incident,
  type IssueRef,
  type LogEvent,
  type OpenIssue,
  type TriageState,
  writeCursor,
} from "@bug-loop/core";
import { currentSummary } from "../state";

export async function dedupeEvents(
  events: LogEvent[],
  openIssues: readonly OpenIssue[],
): Promise<{ all: Incident[]; fresh: Incident[]; existingIssues: Array<IssueRef | null> }> {
  const all = groupIncidents(events);
  const existingIssues = all.map((incident) =>
    findOpenIssueByMarker(openIssues, incident.fingerprint.hash)
  );
  const fresh = all.filter((_, index) => existingIssues[index] === null);
  return { all, fresh, existingIssues };
}

export async function dedupeWithLookup(
  state: TriageState,
  openIssues: readonly OpenIssue[],
): Promise<Partial<TriageState>> {
  const result = await dedupeEvents(state.actionableEvents ?? [], openIssues);
  const config = state.config;
  if (
    result.fresh.length === 0 &&
    config &&
    (config.commitCursorOffset !== undefined || config.nextCursorOffset !== undefined)
  ) {
    const cursorPath = state.pipelineConfig?.cursorPath;
    if (!cursorPath) throw new Error("dedupe requires pipelineConfig.cursorPath");
    await writeCursor(cursorPath, {
      offset: resolveCommitCursorOffset(config, state.logPath),
    });
  }
  console.log(`[dedupe] incidents=${result.all.length} new=${result.fresh.length}`);
  const incidents = config?.fix ? result.all : result.fresh;
  return {
    incidents,
    triage: incidents.map((incident) => {
      const index = result.all.indexOf(incident);
      const existing = result.existingIssues[index];
      return existing
        ? { incident, ticket: { issueNumber: existing.number, url: existing.url } }
        : { incident };
    }),
    summary: {
      ...currentSummary(state),
      incidents: result.all.length,
      newIncidents: result.fresh.length,
    },
  };
}

export async function dedupeNode(
  state: TriageState,
  openIssues: readonly OpenIssue[],
): Promise<Partial<TriageState>> {
  return dedupeWithLookup(state, openIssues);
}
