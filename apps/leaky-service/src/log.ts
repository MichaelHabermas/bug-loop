import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type LogLevel = "info" | "warn" | "error";

export interface LogErr {
  name: string;
  message: string;
  stack?: string;
}

export interface LogFields {
  reqId?: string;
  route?: string;
  status?: number;
  err?: LogErr;
}

// Always write under repo-root logs/ regardless of process.cwd().
const DEFAULT_LOG_PATH = join(import.meta.dir, "../../../logs/leaky-service.jsonl");

function resolveLogPath(): string {
  return process.env["LOG_PATH"] ?? DEFAULT_LOG_PATH;
}

let ensuredFor: string | null = null;

function ensureLogDir(path: string): void {
  if (ensuredFor === path) return;
  mkdirSync(dirname(path), { recursive: true });
  ensuredFor = path;
}

function errFromUnknown(err: unknown): LogErr {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      ...(err.stack !== undefined ? { stack: err.stack } : {}),
    };
  }
  return { name: "Error", message: String(err) };
}

/** One JSON line to stdout and logs/leaky-service.jsonl. */
export function writeLog(level: LogLevel, msg: string, fields: LogFields = {}): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) entry[k] = v;
  }
  const line = JSON.stringify(entry);
  console.log(line);
  const path = resolveLogPath();
  ensureLogDir(path);
  appendFileSync(path, line + "\n", "utf8");
}

export function logInfo(msg: string, fields?: LogFields): void {
  writeLog("info", msg, fields ?? {});
}

export function logWarn(msg: string, fields?: LogFields): void {
  writeLog("warn", msg, fields ?? {});
}

export function logError(msg: string, fields?: LogFields): void {
  writeLog("error", msg, fields ?? {});
}

export function toLogErr(err: unknown): LogErr {
  return errFromUnknown(err);
}

export function installUnhandledRejectionHook(): void {
  process.on("unhandledRejection", (reason: unknown) => {
    writeLog("error", "unhandledRejection", {
      err: errFromUnknown(reason),
    });
  });
}
