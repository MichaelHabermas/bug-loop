import { FINGERPRINT_MARKER } from "./github";
import type { IssueInput } from "./github";
import type { IncidentTriage } from "./types";

export function buildIssueInput(item: IncidentTriage): IssueInput {
  const { incident } = item;
  const repro = item.repro ?? {
    reproduced: false,
    command: "",
    evidence: "No reproduction result.",
  };
  const route = item.route ?? {
    kind: "needs-human" as const,
    reason: "No route decision was recorded.",
  };
  const sample = incident.sampleEvents[0];
  const brief = route.fixBrief
    ? ["", "## Fix brief", "", route.fixBrief]
    : [];
  const body = [
    FINGERPRINT_MARKER(incident.fingerprint.hash),
    "",
    `- Count: ${incident.count}`,
    `- First seen: ${incident.firstSeen}`,
    `- Last seen: ${incident.lastSeen}`,
    "",
    "## Sample log",
    "",
    "```json",
    JSON.stringify(sample, null, 2),
    "```",
    "",
    "## Reproduction",
    "",
    "```bash",
    repro.command,
    "```",
    "",
    `Reproduced: ${repro.reproduced ? "yes" : "no"}`,
    "",
    "```text",
    repro.evidence,
    "```",
    "",
    "## Route",
    "",
    `**${route.kind}** - ${route.reason}`,
    ...brief,
  ].join("\n");
  return {
    title: `[bug-loop] ${incident.fingerprint.errName} on ${incident.fingerprint.route}`,
    body,
    labels: [
      "bug-loop",
      route.kind === "mechanical" ? "auto-fix-candidate" : "needs-human",
    ],
  };
}
