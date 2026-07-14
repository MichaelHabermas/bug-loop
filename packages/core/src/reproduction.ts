import type { CheckResult, VerifyReproInput } from "./verifier";
import type { Incident, LogEvent, ReproResult } from "./types";

export interface ReproduceInput {
  logPath: string;
  baseUrl: string;
  incident: Incident;
}

export interface ReproPlan {
  command: string;
  reproduce(): Promise<Omit<ReproResult, "command">>;
  verify(input: VerifyReproInput): Promise<CheckResult>;
}

export interface ReproStrategyInput extends ReproduceInput {
  sample: LogEvent;
}

export interface ReproStrategy {
  normalizeEvent?(event: LogEvent): LogEvent;
  derive(input: ReproStrategyInput): ReproPlan | null;
}

function noRepro(evidence: string): ReproResult {
  return { reproduced: false, command: "", evidence };
}

export async function reproduceIncident(
  input: ReproduceInput,
  strategy?: ReproStrategy,
): Promise<ReproResult> {
  const sample = input.incident.sampleEvents[0];
  if (!sample) return noRepro("Incident has no sample log.");
  const plan = strategy?.derive({ ...input, sample });
  if (!plan) return noRepro("No reproduction could be derived for this incident.");
  try {
    const result = await plan.reproduce();
    return { ...result, command: plan.command };
  } catch (error: unknown) {
    return {
      reproduced: false,
      command: plan.command,
      evidence:
        `Service unreachable or request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
