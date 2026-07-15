import { isStructuredActionable, type ReproStrategy, type TriageState } from "@bug-loop/core";
import { currentSummary } from "../state";

export async function detectStructured(
  state: TriageState,
  invariantWarnPrefixes: string[],
  reproStrategy?: ReproStrategy,
): Promise<Partial<TriageState>> {
  const actionable = state.events
    .filter((event) => isStructuredActionable(event, invariantWarnPrefixes))
    .map((event) => reproStrategy?.normalizeEvent?.(event) ?? event);
  console.log(`[detect] actionable=${actionable.length}`);
  return {
    actionableEvents: actionable,
    summary: { ...currentSummary(state), actionable: actionable.length },
  };
}

export async function detectNode(
  state: TriageState,
  invariantWarnPrefixes: string[],
  reproStrategy?: ReproStrategy,
): Promise<Partial<TriageState>> {
  return detectStructured(state, invariantWarnPrefixes, reproStrategy);
}
