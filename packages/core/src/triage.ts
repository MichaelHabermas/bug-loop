import { fingerprintEvent } from "./fingerprint";
import type { Incident, LogEvent, ReproResult, RouteDecision } from "./types";

export function isHeuristicallyActionable(
  event: LogEvent,
  invariantWarnPrefixes: string[],
): boolean {
  return event.level === "error" || (
    event.level === "warn" &&
    invariantWarnPrefixes.some((prefix) => event.msg.startsWith(prefix))
  );
}

export function groupIncidents(events: LogEvent[]): Incident[] {
  const grouped = new Map<string, Incident>();
  for (const event of events) {
    const fingerprint = fingerprintEvent(event);
    const existing = grouped.get(fingerprint.hash);
    if (existing) {
      existing.count += 1;
      if (event.ts < existing.firstSeen) existing.firstSeen = event.ts;
      if (event.ts > existing.lastSeen) existing.lastSeen = event.ts;
      existing.sampleEvents = [...existing.sampleEvents, event].slice(-3);
      continue;
    }
    grouped.set(fingerprint.hash, {
      fingerprint,
      sampleEvents: [event],
      count: 1,
      firstSeen: event.ts,
      lastSeen: event.ts,
    });
  }
  return [...grouped.values()];
}

export function heuristicRoute(
  incident: Incident,
  repro: ReproResult,
): RouteDecision {
  if (incident.sampleEvents[0]?.level === "warn") {
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
