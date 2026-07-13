import type { Fingerprint, LogEvent } from "./types";

/**
 * Normalize a stack frame: keep file path + function name, drop line/column
 * so a line-shifting fix does not change the fingerprint identity.
 *
 * Examples:
 *   "at handleCreate (src/server.ts:42:11)" → "at handleCreate (src/server.ts)"
 *   "at src/server.ts:42:11" → "at src/server.ts"
 */
export function normalizeFrame(frame: string): string {
  return frame
    .trim()
    .replace(/:\d+:\d+\)?$/, (m) => (m.endsWith(")") ? ")" : ""))
    .replace(/:\d+:\d+/g, "");
}

/**
 * Pick the first stack frame that looks like application code
 * (not Bun/node internals or anonymous wrappers).
 */
export function topAppFrame(stack: string | undefined): string {
  if (!stack) return "<no-stack>";
  const lines = stack.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("at ")) continue;
    if (line.includes("node:internal") || line.includes("bun:")) continue;
    if (line.includes("native") && !line.includes(".ts") && !line.includes(".js")) {
      continue;
    }
    return normalizeFrame(line);
  }
  // Fall back to first "at " line even if internal
  const first = lines.find((l) => l.startsWith("at "));
  return first ? normalizeFrame(first) : "<no-stack>";
}

function hashMaterial(parts: string[]): string {
  const material = parts.join("|");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(material);
  return hasher.digest("hex").slice(0, 16);
}

/**
 * Build a stable fingerprint from an error (or warn-invariant) log event.
 *
 * - error events: errName + top app frame (no line/col) + route
 * - warn events (e.g. negative total): route + msg prefix (no stack)
 */
export function fingerprintEvent(event: LogEvent): Fingerprint {
  const route = event.route ?? "<unknown>";

  if (event.level === "warn") {
    const msgPrefix = (event.msg ?? "").slice(0, 80);
    const errName = "WarnInvariant";
    const topFrame = msgPrefix;
    const hash = hashMaterial([errName, topFrame, route]);
    return { hash, errName, topFrame, route };
  }

  const errName = event.err?.name ?? "Error";
  const topFrame = topAppFrame(event.err?.stack);
  const hash = hashMaterial([errName, topFrame, route]);
  return { hash, errName, topFrame, route };
}
