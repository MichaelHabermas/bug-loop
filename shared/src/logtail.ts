import type { LogEvent, LogLevel } from "./types";

export interface Cursor {
  /** Byte offset into the file. */
  offset: number;
}

export interface ReadResult {
  events: LogEvent[];
  cursor: Cursor;
}

const VALID_LEVELS = new Set<LogLevel>(["info", "warn", "error"]);

function isLogEvent(value: unknown): value is LogEvent {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  if (typeof o["ts"] !== "string") return false;
  if (typeof o["level"] !== "string" || !VALID_LEVELS.has(o["level"] as LogLevel)) {
    return false;
  }
  if (typeof o["msg"] !== "string") return false;
  return true;
}

function parseLine(line: string): LogEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isLogEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read new complete JSONL lines from `path` starting at `cursor.offset`.
 * Tolerates a partial last line by not advancing past it.
 */
export async function readNewEvents(
  path: string,
  cursor: Cursor = { offset: 0 },
): Promise<ReadResult> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { events: [], cursor };
  }

  const size = file.size;
  if (cursor.offset >= size) {
    return { events: [], cursor: { offset: size } };
  }

  const slice = file.slice(cursor.offset);
  const text = await slice.text();

  const events: LogEvent[] = [];
  let consumed = 0;
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const nl = text.indexOf("\n", searchFrom);
    if (nl === -1) {
      // Partial last line — do not consume
      break;
    }
    const line = text.slice(searchFrom, nl);
    const event = parseLine(line);
    if (event) events.push(event);
    consumed = nl + 1;
    searchFrom = nl + 1;
  }

  // If the slice ends with a complete line (file ends with \n) or we only
  // saw complete lines, advance. Partial remainder stays unconsumed.
  return {
    events,
    cursor: { offset: cursor.offset + consumed },
  };
}

/**
 * Live-tail async iterator. Yields newly parsed LogEvents as they appear.
 * Polls every `pollMs` milliseconds. Call iterator.return() to stop.
 */
export async function* follow(
  path: string,
  pollMs = 200,
): AsyncGenerator<LogEvent, void, unknown> {
  let cursor: Cursor = { offset: 0 };
  // Start at EOF so we only see new lines after follow() begins
  const file = Bun.file(path);
  if (await file.exists()) {
    cursor = { offset: file.size };
  }

  try {
    while (true) {
      const result = await readNewEvents(path, cursor);
      cursor = result.cursor;
      for (const event of result.events) {
        yield event;
      }
      await Bun.sleep(pollMs);
    }
  } finally {
    // allow clean exit via .return()
  }
}
