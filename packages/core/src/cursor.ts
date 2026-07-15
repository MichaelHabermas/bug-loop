import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Cursor } from "./logtail";
import type { TriageRunConfig } from "./types";

export async function readCursor(path: string): Promise<Cursor> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { offset: 0 };
  try {
    const value: unknown = await file.json();
    if (typeof value !== "object" || value === null) return { offset: 0 };
    const offset = (value as Record<string, unknown>)["offset"];
    return typeof offset === "number" && offset >= 0 ? { offset } : { offset: 0 };
  } catch {
    return { offset: 0 };
  }
}

export async function writeCursor(path: string, cursor: Cursor): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(cursor, null, 2)}\n`);
}

/**
 * Byte offset a successful pass must persist.
 *
 * Invariant: commit exactly the end offset of the last fully-parsed,
 * actually-ingested record (`nextCursorOffset`) — never current EOF.
 * Watch may set `commitCursorOffset` as the ingest read boundary; after
 * capped ingest those two agree. Prefer ingested over the pin when both
 * are present so empty-pass and ticket paths cannot skip mid-listOpenIssues
 * appends or clip partial trailing JSONL.
 */
export function resolveCommitCursorOffset(
  config: TriageRunConfig | undefined,
  logPath: string,
): number {
  if (config?.nextCursorOffset !== undefined) {
    return config.nextCursorOffset;
  }
  if (config?.commitCursorOffset !== undefined) {
    return config.commitCursorOffset;
  }
  // Last resort when ingest did not record an offset (should be rare).
  return Bun.file(logPath).size;
}
