import type { ReproStrategy, TriageState } from "@bug-loop/core";
import type { Classifier } from "../classifier";
import { currentSummary } from "../state";

const CLASSIFICATION_CONCURRENCY = 8;

export async function detectWithClassifier(
  state: TriageState,
  classifier: Classifier,
  reproStrategy?: ReproStrategy,
): Promise<Partial<TriageState>> {
  const classifications: boolean[] = [];
  for (let index = 0; index < state.events.length; index += CLASSIFICATION_CONCURRENCY) {
    const batch = state.events.slice(index, index + CLASSIFICATION_CONCURRENCY);
    classifications.push(...(await Promise.all(batch.map((event) => classifier.classify(event)))));
  }
  const actionable = state.events
    .filter((_, index) => classifications[index])
    .map((event) => reproStrategy?.normalizeEvent?.(event) ?? event);
  console.log(`[detect] actionable=${actionable.length}`);
  return {
    actionableEvents: actionable,
    summary: { ...currentSummary(state), actionable: actionable.length },
  };
}

export async function detectNode(
  state: TriageState,
  classifier: Classifier,
  reproStrategy?: ReproStrategy,
): Promise<Partial<TriageState>> {
  return detectWithClassifier(state, classifier, reproStrategy);
}
