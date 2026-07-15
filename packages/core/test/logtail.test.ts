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
    expect(result.cursor.offset).toBe(Buffer.byteLength(complete, "utf8"));

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

  test("endOffset caps the read so post-boundary events stay unconsumed", async () => {
    const first = line({ msg: "in-batch" });
    const second = line({ msg: "after-batch" });
    writeFileSync(LOG, first + second);
    const batchEnd = Buffer.byteLength(first, "utf8");

    const r1 = await readNewEvents(LOG, { offset: 0 }, { endOffset: batchEnd });
    expect(r1.events.map((e) => e.msg)).toEqual(["in-batch"]);
    expect(r1.cursor.offset).toBe(batchEnd);

    const r2 = await readNewEvents(LOG, r1.cursor);
    expect(r2.events.map((e) => e.msg)).toEqual(["after-batch"]);
    expect(r2.cursor.offset).toBe(Bun.file(LOG).size);
  });

  test("multibyte log lines ingest exactly once across two runs", async () => {
    const first = line({ msg: "emoji ✅ and café" });
    const second = line({ msg: "second line 日本語" });
    writeFileSync(LOG, first + second);
    expect(Buffer.byteLength(first, "utf8")).toBeGreaterThan(first.length);

    const r1 = await readNewEvents(LOG);
    expect(r1.events.map((e) => e.msg)).toEqual([
      "emoji ✅ and café",
      "second line 日本語",
    ]);
    expect(r1.cursor.offset).toBe(Bun.file(LOG).size);
    expect(r1.cursor.offset).toBe(Buffer.byteLength(first + second, "utf8"));

    // Second run from committed cursor: nothing re-ingested.
    const r2 = await readNewEvents(LOG, r1.cursor);
    expect(r2.events).toEqual([]);
    expect(r2.cursor.offset).toBe(r1.cursor.offset);
  });

  test("partial multibyte trailing line does not advance past incomplete bytes", async () => {
    const complete = line({ msg: "done ✅" });
    // Truncate mid-sequence of a multibyte character in a following line.
    const partialPrefix = '{"ts":"2026-07-13T00:00:00.000Z","level":"info","msg":"café';
    writeFileSync(LOG, complete + partialPrefix);

    const r1 = await readNewEvents(LOG);
    expect(r1.events.map((e) => e.msg)).toEqual(["done ✅"]);
    expect(r1.cursor.offset).toBe(Buffer.byteLength(complete, "utf8"));
    expect(r1.cursor.offset).toBeLessThan(Bun.file(LOG).size);

    appendFileSync(LOG, '"}\n');
    const r2 = await readNewEvents(LOG, r1.cursor);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0]?.msg).toBe("café");
    expect(r2.cursor.offset).toBe(Bun.file(LOG).size);
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
