import type { PipelineConfig, WatchSettings } from "./config";
import { readCursor } from "./cursor";
import { readNewEvents, type Cursor } from "./logtail";

export interface WatchPassContext {
  /** 1-based pass index within this watch session. */
  passNumber: number;
  /** Shared correlation id for every pass of this daemon run. */
  watchSessionId: string;
  /** Events observed in the debounced batch that triggered this pass. */
  eventsInBatch: number;
  /** Label suffix fragment `-watch-passN` (without a base prefix). */
  labelSuffix: string;
}

export interface WatchPassResult {
  /** Optional summary line for the operator log. */
  detail?: string;
}

export interface WatchRunnerOptions {
  config: PipelineConfig;
  /** Override config.watch (already resolved settings). */
  watch?: WatchSettings;
  /**
   * One-shot pipeline pass. Must run the same triage/ticket/fix machinery
   * as a normal CLI invocation and write its own v2 trace before resolving.
   * The watch runner never reimplements pipeline stages.
   */
  runPass: (context: WatchPassContext) => Promise<WatchPassResult | void>;
  /** When aborted, finish the in-flight pass then exit cleanly. */
  signal?: AbortSignal;
  /** Operator-facing log sink (defaults to console.log). */
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Injected session id for tests; production uses crypto.randomUUID(). */
  watchSessionId?: string;
  /**
   * How long each sleep step is while waiting for debounce quiet.
   * Defaults to min(250, debounceMs) so tests can accelerate time.
   */
  debounceTickMs?: number;
}

export interface WatchRunnerResult {
  watchSessionId: string;
  passesCompleted: number;
  exitReason: "signal" | "stop";
}

const HEARTBEAT_LINE = "watching - no new events";

function defaultSleep(ms: number): Promise<void> {
  return Bun.sleep(ms);
}

/**
 * Long-lived daemon: poll the log via cursor + readNewEvents, debounce a quiet
 * period, then invoke the injected one-shot pipeline pass for each batch.
 * Cross-pass dedupe is owned by the pass (cursor advance + GitHub markers).
 */
export async function runWatchDaemon(
  options: WatchRunnerOptions,
): Promise<WatchRunnerResult> {
  const watch = options.watch ?? options.config.watch;
  const log = options.log ?? ((line: string) => console.log(line));
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const watchSessionId = options.watchSessionId ?? crypto.randomUUID();
  const debounceTickMs = options.debounceTickMs ?? Math.min(250, watch.debounceMs);

  let stopRequested = options.signal?.aborted === true;
  const onAbort = (): void => {
    stopRequested = true;
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  let passesCompleted = 0;
  let lastHeartbeatAt = now();
  let stoppedAfterPass = false;

  log(
    `[watch] session=${watchSessionId} poll=${watch.pollIntervalMs}ms debounce=${watch.debounceMs}ms heartbeat=${watch.heartbeatMs}ms`,
  );

  try {
    while (!stopRequested) {
      const cursor = await readCursor(options.config.cursorPath);
      const snapshot = await readNewEvents(options.config.logPath, cursor);

      if (snapshot.events.length === 0) {
        if (now() - lastHeartbeatAt >= watch.heartbeatMs) {
          log(HEARTBEAT_LINE);
          lastHeartbeatAt = now();
        }
        await sleep(watch.pollIntervalMs);
        continue;
      }

      const batch = await collectDebouncedBatch({
        logPath: options.config.logPath,
        startCursor: cursor,
        initial: snapshot,
        debounceMs: watch.debounceMs,
        tickMs: debounceTickMs,
        sleep,
        now,
        shouldStop: () => stopRequested,
      });

      if (batch.events.length === 0) {
        // Interrupted before a stable batch; loop and re-check stop.
        continue;
      }

      if (stopRequested) {
        // New events arrived but shutdown was requested before the pass started.
        // Do not start a new pass; exit cleanly.
        break;
      }

      passesCompleted += 1;
      const passNumber = passesCompleted;
      const labelSuffix = `-watch-pass${passNumber}`;
      log(
        `[watch] pass=${passNumber} events=${batch.events.length} session=${watchSessionId}`,
      );

      const result = await options.runPass({
        passNumber,
        watchSessionId,
        eventsInBatch: batch.events.length,
        labelSuffix,
      });
      if (result?.detail !== undefined) {
        log(`[watch] pass=${passNumber} ${result.detail}`);
      }
      lastHeartbeatAt = now();
      if (stopRequested) {
        // Signal arrived during the pass; we finished it, then exit.
        stoppedAfterPass = true;
        break;
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (stoppedAfterPass) {
      log(`[watch] session=${watchSessionId} stopped after in-flight pass passes=${passesCompleted}`);
    } else {
      log(`[watch] session=${watchSessionId} stopped passes=${passesCompleted}`);
    }
  }

  return {
    watchSessionId,
    passesCompleted,
    exitReason: stopRequested ? "signal" : "stop",
  };
}

interface DebounceInput {
  logPath: string;
  startCursor: Cursor;
  initial: { events: unknown[]; cursor: Cursor };
  debounceMs: number;
  tickMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  shouldStop: () => boolean;
}

async function collectDebouncedBatch(input: DebounceInput): Promise<{
  events: unknown[];
  cursor: Cursor;
}> {
  let cursor = input.initial.cursor;
  let events = [...input.initial.events];
  let lastGrowthAt = input.now();

  while (!input.shouldStop()) {
    const quietFor = input.now() - lastGrowthAt;
    if (quietFor >= input.debounceMs) {
      return { events, cursor };
    }

    const waitMs = Math.min(input.tickMs, Math.max(1, input.debounceMs - quietFor));
    await input.sleep(waitMs);

    const more = await readNewEvents(input.logPath, cursor);
    if (more.events.length > 0) {
      events = events.concat(more.events);
      cursor = more.cursor;
      lastGrowthAt = input.now();
    }
  }

  // Shutdown during debounce: do not start a pass with a partial batch.
  return { events: [], cursor: input.startCursor };
}
