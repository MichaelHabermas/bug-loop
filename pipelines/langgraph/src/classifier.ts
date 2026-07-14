import {
  heuristicRoute,
  isHeuristicallyActionable,
  type Incident,
  type LogEvent,
  type ReproResult,
  type RouteDecision,
} from "@bug-loop/shared";

export interface Classifier {
  classify(event: LogEvent): Promise<boolean>;
  route(incident: Incident, repro: ReproResult): Promise<RouteDecision>;
}

export function isNegativeTotalInvariant(event: LogEvent): boolean {
  return event.level === "warn" && isHeuristicallyActionable(event);
}

export class HeuristicClassifier implements Classifier {
  async classify(event: LogEvent): Promise<boolean> {
    return isHeuristicallyActionable(event);
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
  private readonly heuristic = new HeuristicClassifier();

  constructor(
    private readonly apiKey: string,
    private readonly model = process.env["BUGLOOP_CLASSIFIER_MODEL"] ?? "gpt-4o-mini",
  ) {}

  async classify(event: LogEvent): Promise<boolean> {
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
      if (!response.ok) return this.heuristic.classify(event);
      const data: unknown = await response.json();
      if (!isChatCompletionResponse(data)) return this.heuristic.classify(event);
      const content = data.choices?.[0]?.message?.content?.trim().toUpperCase();
      if (content === "ACTIONABLE") return true;
      if (content === "NOISE") return false;
      return this.heuristic.classify(event);
    } catch {
      return this.heuristic.classify(event);
    }
  }

  async route(incident: Incident, repro: ReproResult): Promise<RouteDecision> {
    return this.heuristic.route(incident, repro);
  }
}

export function selectClassifier(): Classifier {
  const apiKey = process.env["OPENAI_API_KEY"];
  return apiKey ? new LlmClassifier(apiKey) : new HeuristicClassifier();
}
