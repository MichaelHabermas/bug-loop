import {
  findOpenIssueByMarker,
  fingerprintEvent,
  type Incident,
  type IssueRef,
  type LogEvent,
  type TriageState,
} from "@bug-loop/shared";
import { currentSummary } from "../state";
import { writeCursor } from "../cursor";

type IssueLookup = (hash: string) => Promise<IssueRef | null>;

export async function dedupeEvents(
  events: LogEvent[],
  lookup: IssueLookup = findOpenIssueByMarker,
): Promise<{ all: Incident[]; fresh: Incident[]; existingIssues: Array<IssueRef | null> }> {
  const grouped = new Map<string, Incident>();
  for (const event of events) {
    const fingerprint = fingerprintEvent(event);
    const existing = grouped.get(fingerprint.hash);
    if (existing) {
      existing.count += 1;
      if (event.ts < existing.firstSeen) existing.firstSeen = event.ts;
      if (event.ts > existing.lastSeen) existing.lastSeen = event.ts;
      existing.sampleEvents = [...existing.sampleEvents, event].slice(-3);
      continue;
    }
    grouped.set(fingerprint.hash, {
      fingerprint,
      sampleEvents: [event],
      count: 1,
      firstSeen: event.ts,
      lastSeen: event.ts,
    });
  }

  const all = [...grouped.values()];
  const existingIssues = await Promise.all(
    all.map((incident) => lookup(incident.fingerprint.hash)),
  );
  const fresh = all.filter((_, index) => existingIssues[index] === null);
  return { all, fresh, existingIssues };
}

export async function dedupeWithLookup(
  state: TriageState,
  lookup: IssueLookup,
): Promise<Partial<TriageState>> {
  const result = await dedupeEvents(state.actionableEvents ?? [], lookup);
  const config = state.config;
  if (result.fresh.length === 0 && config?.nextCursorOffset !== undefined) {
    await writeCursor(config.cursorPath, { offset: config.nextCursorOffset });
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

export async function dedupeNode(state: TriageState): Promise<Partial<TriageState>> {
  return dedupeWithLookup(state, findOpenIssueByMarker);
}
