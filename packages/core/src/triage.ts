import { fingerprintEvent } from "./fingerprint";
import type { Incident, LogEvent } from "./types";

export function isStructuredActionable(
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
