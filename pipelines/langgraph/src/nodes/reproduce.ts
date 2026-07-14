import {
  reproduceIncident,
  type IncidentTriage,
  type ReproStrategy,
  type TriageState,
} from "@bug-loop/core";
import { currentSummary } from "../state";

export async function reproduceNode(
  state: TriageState,
  strategy?: ReproStrategy,
): Promise<Partial<TriageState>> {
  const triage: IncidentTriage[] = [];
  const baseUrl = state.pipelineConfig?.baseUrl ?? "http://localhost:3000";
  for (const item of state.triage ?? []) {
    const repro = await reproduceIncident({
      logPath: state.logPath,
      baseUrl,
      incident: item.incident,
    }, strategy);
    triage.push({ ...item, repro });
  }
  const reproduced = triage.filter(
    (item) => item.incident.sampleEvents[0]?.level === "error" && item.repro?.reproduced,
  ).length;
  console.log(`[reproduce] reproduced=${reproduced}/${triage.length}`);
  return { triage, summary: { ...currentSummary(state), reproduced } };
}
