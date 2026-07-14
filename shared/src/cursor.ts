import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Cursor } from "./logtail";

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
