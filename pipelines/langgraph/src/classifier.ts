import {
  heuristicRoute,
  isHeuristicallyActionable,
  type Incident,
  type LogEvent,
  type ReproResult,
  type ResolvedAgent,
  type RouteDecision,
} from "@bug-loop/core";

export interface Classifier {
  classify(event: LogEvent): Promise<boolean>;
  route(incident: Incident, repro: ReproResult): Promise<RouteDecision>;
  takeAgentCalls?(): ClassifierAgentCall[];
}

export interface ClassifierAgentCall {
  durationMs: number;
  outcome: string;
  fallbackReason?: string;
}

export function isNegativeTotalInvariant(
  event: LogEvent,
  invariantWarnPrefixes: string[],
): boolean {
  return event.level === "warn" &&
    invariantWarnPrefixes.some((prefix) => event.msg.startsWith(prefix));
}

export class HeuristicClassifier implements Classifier {
  constructor(private readonly invariantWarnPrefixes: string[]) {}

  async classify(event: LogEvent): Promise<boolean> {
    return isHeuristicallyActionable(event, this.invariantWarnPrefixes);
  }

  async route(incident: Incident, repro: ReproResult): Promise<RouteDecision> {
    return heuristicRoute(incident, repro);
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

function isChatCompletionResponse(value: unknown): value is ChatCompletionResponse {
  return typeof value === "object" && value !== null;
}

export class LlmClassifier implements Classifier {
  private readonly heuristic: HeuristicClassifier;
  private readonly agentCalls: ClassifierAgentCall[] = [];

  constructor(
    private readonly apiKey: string,
    invariantWarnPrefixes: string[],
    private readonly model = process.env["BUGLOOP_CLASSIFIER_MODEL"] ?? "gpt-4o-mini",
  ) {
    this.heuristic = new HeuristicClassifier(invariantWarnPrefixes);
  }

  async classify(event: LogEvent): Promise<boolean> {
    const started = performance.now();
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          max_tokens: 4,
          messages: [
            {
              role: "system",
              content:
                "Classify one structured service log. Reply ACTIONABLE only for an error, crash, or violated business invariant. Otherwise reply NOISE.",
            },
            { role: "user", content: JSON.stringify(event) },
          ],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        this.agentCalls.push({
          durationMs: Math.max(0, performance.now() - started),
          outcome: "http-error",
          fallbackReason: `classifier returned HTTP ${response.status}`,
        });
        return this.heuristic.classify(event);
      }
      const data: unknown = await response.json();
      if (!isChatCompletionResponse(data)) {
        this.agentCalls.push({
          durationMs: Math.max(0, performance.now() - started),
          outcome: "invalid-result",
          fallbackReason: "classifier response shape was invalid",
        });
        return this.heuristic.classify(event);
      }
      const content = data.choices?.[0]?.message?.content?.trim().toUpperCase();
      if (content === "ACTIONABLE" || content === "NOISE") {
        this.agentCalls.push({
          durationMs: Math.max(0, performance.now() - started),
          outcome: "success",
        });
        return content === "ACTIONABLE";
      }
      this.agentCalls.push({
        durationMs: Math.max(0, performance.now() - started),
        outcome: "invalid-result",
        fallbackReason: "classifier returned neither ACTIONABLE nor NOISE",
      });
      return this.heuristic.classify(event);
    } catch (error: unknown) {
      this.agentCalls.push({
        durationMs: Math.max(0, performance.now() - started),
        outcome: "error",
        fallbackReason: error instanceof Error ? error.message : String(error),
      });
      return this.heuristic.classify(event);
    }
  }

  takeAgentCalls(): ClassifierAgentCall[] {
    return this.agentCalls.splice(0);
  }

  async route(incident: Incident, repro: ReproResult): Promise<RouteDecision> {
    return this.heuristic.route(incident, repro);
  }
}

export function selectClassifier(
  invariantWarnPrefixes: string[],
  resolution?: ResolvedAgent,
): Classifier {
  if (resolution?.harness === "heuristic") {
    return new HeuristicClassifier(invariantWarnPrefixes);
  }
  const apiKey = process.env["OPENAI_API_KEY"];
  return apiKey
    ? new LlmClassifier(
        apiKey,
        invariantWarnPrefixes,
        resolution?.effectiveModel ?? process.env["BUGLOOP_CLASSIFIER_MODEL"] ?? "gpt-4o-mini",
      )
    : new HeuristicClassifier(invariantWarnPrefixes);
}
