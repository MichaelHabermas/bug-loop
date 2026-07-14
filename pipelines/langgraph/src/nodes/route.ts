import type { IncidentTriage, TriageState } from "@bug-loop/shared";
import { type Classifier, selectClassifier } from "../classifier";

export async function routeWithClassifier(
  state: TriageState,
  classifier: Classifier,
): Promise<Partial<TriageState>> {
  const triage: IncidentTriage[] = [];
  for (const item of state.triage ?? []) {
    const repro = item.repro ?? {
      reproduced: false,
      command: "",
      evidence: "Reproduction stage did not return a result.",
    };
    triage.push({ ...item, route: await classifier.route(item.incident, repro) });
  }
  const mechanical = triage.filter((item) => item.route?.kind === "mechanical").length;
  console.log(`[route] mechanical=${mechanical} needs-human=${triage.length - mechanical}`);
  return { triage };
}

export async function routeNode(state: TriageState): Promise<Partial<TriageState>> {
  return routeWithClassifier(state, selectClassifier());
}
