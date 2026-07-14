import { enrichActionableEvent, type TriageState } from "@bug-loop/core";
import { type Classifier, selectClassifier } from "../classifier";
import { currentSummary } from "../state";

const CLASSIFICATION_CONCURRENCY = 8;

export async function detectWithClassifier(
  state: TriageState,
  classifier: Classifier,
): Promise<Partial<TriageState>> {
  const classifications: boolean[] = [];
  for (let index = 0; index < state.events.length; index += CLASSIFICATION_CONCURRENCY) {
    const batch = state.events.slice(index, index + CLASSIFICATION_CONCURRENCY);
    classifications.push(...(await Promise.all(batch.map((event) => classifier.classify(event)))));
  }
  const actionable = state.events
    .filter((_, index) => classifications[index])
    .map(enrichActionableEvent);
  console.log(`[detect] actionable=${actionable.length}`);
  return {
    actionableEvents: actionable,
    summary: { ...currentSummary(state), actionable: actionable.length },
  };
}

export async function detectNode(state: TriageState): Promise<Partial<TriageState>> {
  return detectWithClassifier(state, selectClassifier());
}
