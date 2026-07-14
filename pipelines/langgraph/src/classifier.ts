import type {
  Incident,
  LogEvent,
  ReproResult,
  RouteDecision,
} from "@bug-loop/shared";

const NEGATIVE_TOTAL_PREFIX = "order total negative";

export interface Classifier {
  classify(event: LogEvent): Promise<boolean>;
  route(incident: Incident, repro: ReproResult): Promise<RouteDecision>;
}

export function isNegativeTotalInvariant(event: LogEvent): boolean {
  return event.level === "warn" && event.msg.startsWith(NEGATIVE_TOTAL_PREFIX);
}

export class HeuristicClassifier implements Classifier {
  async classify(event: LogEvent): Promise<boolean> {
    return event.level === "error" || isNegativeTotalInvariant(event);
  }

  async route(incident: Incident, repro: ReproResult): Promise<RouteDecision> {
    const sample = incident.sampleEvents[0];
    if (sample?.level === "warn") {
      return {
        kind: "needs-human",
        reason: "Negative totals expose an ambiguous discount policy, not a mechanical fix.",
      };
    }
    if (repro.reproduced) {
      return {
        kind: "mechanical",
        reason: "The crash has a deterministic request-level reproduction.",
      };
    }
    return {
      kind: "needs-human",
      reason: "The crash was not reproduced, so an automatic fix would be speculative.",
    };
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
