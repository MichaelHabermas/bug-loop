import type { TriageState, TriageSummary } from "@bug-loop/core";

export const EMPTY_SUMMARY: TriageSummary = {
  eventsRead: 0,
  actionable: 0,
  incidents: 0,
  newIncidents: 0,
  reproduced: 0,
  issuesFiled: 0,
};

export function currentSummary(state: TriageState): TriageSummary {
  return state.summary ?? EMPTY_SUMMARY;
}
