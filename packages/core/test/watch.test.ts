import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  definePipelineConfig,
  issueLooksFixResolved,
  readCursor,
  resolveCommitCursorOffset,
  resolveWatchSettings,
  runWatchDaemon,
  shouldEnterWatchFixLoop,
  watchPassLabel,
  watchTraceOutputPath,
  writeCursor,
  type WatchPassContext,
} from "../src";
import type { LogEvent } from "../src/types";

const TMP = join(import.meta.dir, ".tmp-watch");
const LOG = join(TMP, "app.jsonl");
const CURSOR = join(TMP, "cursor.json");

function line(msg: string, level: LogEvent["level"] = "error"): string {
  const event: LogEvent = {
    ts: new Date().toISOString(),
    level,
    msg,
    route: "POST /orders",
    err: { name: "TypeError", message: msg },
  };
  return `${JSON.stringify(event)}\n`;
}

function testConfig() {
  return definePipelineConfig({
    repo: "example/repo",
    labels: { pipeline: "pipeline", mechanical: "mechanical", needsHuman: "human" },
    logPath: LOG,
    baseUrl: "http://localhost:3000",
    cursorPath: CURSOR,
    fixScope: ["src"],
    testScope: ["test"],
    worktreeRoot: ".worktrees",
    maxFixAttempts: 2,
    fixer: "grok",
    invariantWarnPrefixes: [],
    watch: {
      pollIntervalMs: 20,
      debounceMs: 40,
      heartbeatMs: 80,
    },
  }, {});
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(LOG, "");
  writeFileSync(CURSOR, `${JSON.stringify({ offset: 0 }, null, 2)}\n`);
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("watchPassLabel / resolveWatchSettings / watchTraceOutputPath", () => {
  test("builds label suffix -watch-passN", () => {
    expect(watchPassLabel(undefined, 1)).toBe("watch-pass1");
    expect(watchPassLabel("baseline", 3)).toBe("baseline-watch-pass3");
  });

  test("inserts pass suffix before the file extension", () => {
    expect(watchTraceOutputPath("traces/x.json", 1)).toBe("traces/x.pass1.json");
    expect(watchTraceOutputPath("traces/x.json", 12)).toBe("traces/x.pass12.json");
    expect(watchTraceOutputPath("x.json", 2)).toBe("x.pass2.json");
    expect(watchTraceOutputPath("noext", 1)).toBe("noext.pass1");
  });

  test("env overrides beat config partials", () => {
    const settings = resolveWatchSettings(
      { pollIntervalMs: 1000, debounceMs: 2000, heartbeatMs: 3000 },
      {
        BUGLOOP_WATCH_POLL_MS: "15000",
        BUGLOOP_WATCH_DEBOUNCE_MS: "5000",
        BUGLOOP_WATCH_HEARTBEAT_MS: "60000",
      },
    );
    expect(settings).toEqual({
      pollIntervalMs: 15_000,
      debounceMs: 5_000,
      heartbeatMs: 60_000,
    });
  });

  test("rejects non-positive env values", () => {
    expect(() => resolveWatchSettings({}, { BUGLOOP_WATCH_POLL_MS: "0" })).toThrow(
      /BUGLOOP_WATCH_POLL_MS must be a positive integer/,
    );
  });
});

describe("runWatchDaemon", () => {
  test("runs multiple passes as the log grows and advances the cursor via runPass", async () => {
    const config = testConfig();
    const passes: WatchPassContext[] = [];
    const logs: string[] = [];
    const controller = new AbortController();

    const daemon = runWatchDaemon({
      config,
      watchSessionId: "session-multi",
      signal: controller.signal,
      log: (line) => logs.push(line),
      debounceTickMs: 10,
      runPass: async (ctx) => {
        passes.push(ctx);
        // Simulate one-shot ingest: consume everything currently unread.
        const cursor = await readCursor(config.cursorPath);
        const file = Bun.file(config.logPath);
        await writeCursor(config.cursorPath, { offset: file.size });
        void cursor;
        if (passes.length >= 2) controller.abort();
        return { detail: `ok-${ctx.passNumber}` };
      },
    });

    // First burst
    appendFileSync(LOG, line("burst-1-a") + line("burst-1-b"));
    await Bun.sleep(100);
    // Second burst after pass 1 should have advanced cursor
    appendFileSync(LOG, line("burst-2"));
    await Bun.sleep(100);

    const result = await daemon;
    expect(result.passesCompleted).toBeGreaterThanOrEqual(2);
    expect(passes[0]?.watchSessionId).toBe("session-multi");
    expect(passes[1]?.watchSessionId).toBe("session-multi");
    expect(passes[0]?.passNumber).toBe(1);
    expect(passes[1]?.passNumber).toBe(2);
    expect(passes[0]?.labelSuffix).toBe("-watch-pass1");
    expect(passes.every((pass) => pass.eventsInBatch > 0)).toBe(true);
    // Cursor advanced by runPass — second pass must not re-see first-batch-only offset 0
    const finalCursor = await readCursor(config.cursorPath);
    expect(finalCursor.offset).toBe(Bun.file(LOG).size);
  });

  test("debounce batches rapid appends into a single pass", async () => {
    const config = testConfig();
    const batches: number[] = [];
    const controller = new AbortController();

    const daemon = runWatchDaemon({
      config,
      watch: { pollIntervalMs: 15, debounceMs: 60, heartbeatMs: 10_000 },
      watchSessionId: "session-debounce",
      signal: controller.signal,
      log: () => {},
      debounceTickMs: 10,
      runPass: async (ctx) => {
        batches.push(ctx.eventsInBatch);
        await writeCursor(config.cursorPath, { offset: Bun.file(config.logPath).size });
        controller.abort();
      },
    });

    appendFileSync(LOG, line("a"));
    await Bun.sleep(15);
    appendFileSync(LOG, line("b"));
    await Bun.sleep(15);
    appendFileSync(LOG, line("c"));

    await daemon;
    expect(batches).toHaveLength(1);
    expect(batches[0]).toBe(3);
  });

  test("cross-pass dedupe: second pass sees no events when cursor already at EOF", async () => {
    const config = testConfig();
    appendFileSync(LOG, line("only-once"));
    // Seed cursor at EOF as if a prior pass already consumed the log.
    await writeCursor(CURSOR, { offset: Bun.file(LOG).size });

    const controller = new AbortController();
    let passes = 0;
    const logs: string[] = [];

    const daemon = runWatchDaemon({
      config,
      watch: { pollIntervalMs: 20, debounceMs: 30, heartbeatMs: 40 },
      signal: controller.signal,
      log: (line) => logs.push(line),
      debounceTickMs: 10,
      runPass: async () => {
        passes += 1;
      },
    });

    // Allow a couple of poll cycles + heartbeats with no growth.
    await Bun.sleep(120);
    controller.abort();
    await daemon;
    expect(passes).toBe(0);
    expect(logs.some((line) => line.includes("watching - no new events"))).toBe(true);
  });

  test("shutdown mid-pass waits for the in-flight pass to finish", async () => {
    const config = testConfig();
    const controller = new AbortController();
    let passStarted = false;
    let passFinished = false;
    const order: string[] = [];

    const daemon = runWatchDaemon({
      config,
      watch: { pollIntervalMs: 15, debounceMs: 25, heartbeatMs: 10_000 },
      signal: controller.signal,
      log: () => {},
      debounceTickMs: 5,
      runPass: async () => {
        passStarted = true;
        order.push("pass-start");
        // Request shutdown while pass is in flight.
        controller.abort();
        await Bun.sleep(50);
        await writeCursor(config.cursorPath, { offset: Bun.file(config.logPath).size });
        passFinished = true;
        order.push("pass-end");
      },
    });

    appendFileSync(LOG, line("in-flight"));
    const result = await daemon;
    expect(passStarted).toBe(true);
    expect(passFinished).toBe(true);
    expect(order).toEqual(["pass-start", "pass-end"]);
    expect(result.passesCompleted).toBe(1);
    expect(result.exitReason).toBe("signal");
  });

  test("emits idle heartbeat while watching with no new events", async () => {
    const config = testConfig();
    const controller = new AbortController();
    const logs: string[] = [];

    const daemon = runWatchDaemon({
      config,
      watch: { pollIntervalMs: 15, debounceMs: 20, heartbeatMs: 30 },
      signal: controller.signal,
      log: (line) => logs.push(line),
      debounceTickMs: 5,
      runPass: async () => {},
    });

    await Bun.sleep(100);
    controller.abort();
    await daemon;
    expect(logs.filter((line) => line === "watching - no new events").length).toBeGreaterThanOrEqual(1);
  });

  test("does not start a new pass after shutdown is requested during debounce", async () => {
    const config = testConfig();
    const controller = new AbortController();
    let passes = 0;

    const daemon = runWatchDaemon({
      config,
      watch: { pollIntervalMs: 15, debounceMs: 200, heartbeatMs: 10_000 },
      signal: controller.signal,
      log: () => {},
      debounceTickMs: 20,
      runPass: async () => {
        passes += 1;
      },
    });

    appendFileSync(LOG, line("will-not-run"));
    // Abort while debounce quiet period is still open.
    await Bun.sleep(30);
    controller.abort();
    await daemon;
    expect(passes).toBe(0);
  });

  test("event appended mid-pass is ingested by the following pass (cursor pins batch end)", async () => {
    const config = testConfig();
    const controller = new AbortController();
    const passOffsets: number[] = [];
    const passEvents: string[][] = [];
    let midPassWritten = false;

    const daemon = runWatchDaemon({
      config,
      watch: { pollIntervalMs: 15, debounceMs: 40, heartbeatMs: 10_000 },
      watchSessionId: "session-cursor-race",
      signal: controller.signal,
      log: () => {},
      debounceTickMs: 10,
      runPass: async (ctx) => {
        passOffsets.push(ctx.batchEndOffset);
        // Simulate pipeline ingest from cursor → batch end only, then a mid-pass append.
        const cursor = await readCursor(config.cursorPath);
        const slice = await Bun.file(config.logPath).slice(cursor.offset, ctx.batchEndOffset).text();
        const msgs = slice
          .split("\n")
          .filter(Boolean)
          .map((raw) => (JSON.parse(raw) as LogEvent).msg);
        passEvents.push(msgs);

        if (!midPassWritten) {
          // Service writes another event after ingest / before cursor commit.
          appendFileSync(LOG, line("mid-pass-event"));
          midPassWritten = true;
          // Correct commit: batch end, NEVER current file size.
          await writeCursor(config.cursorPath, {
            offset: resolveCommitCursorOffset(
              { fromStart: false, watch: true, commitCursorOffset: ctx.batchEndOffset },
              config.logPath,
            ),
          });
          // Prove file grew past the committed boundary.
          expect(Bun.file(config.logPath).size).toBeGreaterThan(ctx.batchEndOffset);
        } else {
          await writeCursor(config.cursorPath, { offset: ctx.batchEndOffset });
          controller.abort();
        }
      },
    });

    appendFileSync(LOG, line("batch-1"));
    await daemon;

    expect(passEvents.length).toBeGreaterThanOrEqual(2);
    expect(passEvents[0]).toEqual(["batch-1"]);
    expect(passEvents[1]).toContain("mid-pass-event");
    expect(passOffsets[0]).toBeLessThan(Bun.file(LOG).size);
  });
});

describe("watch fix re-entry guards", () => {
  test("session fingerprint + outcome labels block fix re-entry", () => {
    const session = new Set<string>(["fp-done"]);
    expect(shouldEnterWatchFixLoop({
      fingerprint: "fp-done",
      sessionProcessed: session,
    })).toBe(false);
    expect(shouldEnterWatchFixLoop({
      fingerprint: "fp-new",
      sessionProcessed: session,
      openIssueLabels: ["bug-loop", "auto-fix-candidate", "bug-loop:fixed"],
    })).toBe(false);
    expect(shouldEnterWatchFixLoop({
      fingerprint: "fp-new",
      sessionProcessed: session,
      openIssueLabels: ["bug-loop", "needs-human", "bug-loop:gave-up"],
    })).toBe(false);
    // Restart-safe: empty in-memory set, durable outcome label on the issue.
    expect(shouldEnterWatchFixLoop({
      fingerprint: "fp-restart",
      sessionProcessed: new Set(),
      openIssueLabels: ["bug-loop:fixed"],
    })).toBe(false);
    expect(shouldEnterWatchFixLoop({
      fingerprint: "fp-new",
      sessionProcessed: session,
      openIssueLabels: ["bug-loop", "auto-fix-candidate"],
    })).toBe(true);
    expect(issueLooksFixResolved([])).toBe(false);
    expect(issueLooksFixResolved(["bug-loop", "auto-fix-candidate"])).toBe(false);
    expect(issueLooksFixResolved(["bug-loop:fixed"])).toBe(true);
    expect(issueLooksFixResolved(["bug-loop:gave-up"])).toBe(true);
  });
});
