import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readNewEvents, follow } from "../src/logtail";
import type { LogEvent } from "../src/types";

const TMP = join(import.meta.dir, ".tmp-logtail");
const LOG = join(TMP, "test.jsonl");

function line(partial: Partial<LogEvent> & { msg: string }): string {
  const event: LogEvent = {
    ts: partial.ts ?? new Date().toISOString(),
    level: partial.level ?? "info",
    msg: partial.msg,
    ...(partial.reqId !== undefined ? { reqId: partial.reqId } : {}),
    ...(partial.route !== undefined ? { route: partial.route } : {}),
    ...(partial.status !== undefined ? { status: partial.status } : {}),
  };
  return JSON.stringify(event) + "\n";
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("readNewEvents", () => {
  test("returns empty when file missing", async () => {
    const result = await readNewEvents(join(TMP, "nope.jsonl"));
    expect(result.events).toEqual([]);
    expect(result.cursor.offset).toBe(0);
  });

  test("parses complete lines and advances cursor", async () => {
    writeFileSync(
      LOG,
      line({ msg: "a", reqId: "1" }) + line({ msg: "b", reqId: "2" }),
    );
    const result = await readNewEvents(LOG);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.msg).toBe("a");
    expect(result.events[1]?.msg).toBe("b");
    expect(result.cursor.offset).toBe(Bun.file(LOG).size);
  });

  test("tolerates partial last line", async () => {
    const complete = line({ msg: "complete" });
    const partial = '{"ts":"2026-07-13T00:00:00.000Z","level":"info","msg":"part';
    writeFileSync(LOG, complete + partial);

    const result = await readNewEvents(LOG);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.msg).toBe("complete");
    expect(result.cursor.offset).toBe(complete.length);

    // Finish the partial line
    appendFileSync(LOG, 'ial"}\n');
    const result2 = await readNewEvents(LOG, result.cursor);
    expect(result2.events).toHaveLength(1);
    expect(result2.events[0]?.msg).toBe("partial");
  });

  test("skips malformed JSON lines", async () => {
    writeFileSync(LOG, "not-json\n" + line({ msg: "ok" }));
    const result = await readNewEvents(LOG);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.msg).toBe("ok");
  });

  test("incremental reads from cursor", async () => {
    writeFileSync(LOG, line({ msg: "first" }));
    const r1 = await readNewEvents(LOG);
    expect(r1.events).toHaveLength(1);

    appendFileSync(LOG, line({ msg: "second" }));
    const r2 = await readNewEvents(LOG, r1.cursor);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0]?.msg).toBe("second");
  });
});

describe("follow", () => {
  test("yields new events after start", async () => {
    writeFileSync(LOG, line({ msg: "already-there" }));

    const iter = follow(LOG, 50);
    const collected: LogEvent[] = [];

    const reader = (async () => {
      for await (const event of iter) {
        collected.push(event);
        if (collected.length >= 1) break;
      }
    })();

    // Give follow a moment to open at EOF
    await Bun.sleep(80);
    appendFileSync(LOG, line({ msg: "new-event" }));

    await Promise.race([
      reader,
      Bun.sleep(2000).then(() => {
        throw new Error("follow timed out waiting for new event");
      }),
    ]);

    await iter.return?.(undefined);
    expect(collected).toHaveLength(1);
    expect(collected[0]?.msg).toBe("new-event");
    // pre-existing line should not appear
    expect(collected.every((e) => e.msg !== "already-there")).toBe(true);
    expect(existsSync(LOG)).toBe(true);
  });
});
