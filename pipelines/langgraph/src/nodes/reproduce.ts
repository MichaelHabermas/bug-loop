import {
  reproduceIncident,
  type IncidentTriage,
  type TriageState,
} from "@bug-loop/shared";
import { currentSummary } from "../state";

export async function reproduceNode(state: TriageState): Promise<Partial<TriageState>> {
  const triage: IncidentTriage[] = [];
  const baseUrl = state.config?.baseUrl ?? "http://localhost:3000";
  for (const item of state.triage ?? []) {
    const repro = await reproduceIncident({
      logPath: state.logPath,
      baseUrl,
      incident: item.incident,
    });
    triage.push({ ...item, repro });
  }
  const reproduced = triage.filter(
    (item) => item.incident.sampleEvents[0]?.level === "error" && item.repro?.reproduced,
  ).length;
  console.log(`[reproduce] reproduced=${reproduced}/${triage.length}`);
  return { triage, summary: { ...currentSummary(state), reproduced } };
}
