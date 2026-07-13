import { describe, expect, test } from "bun:test";
import { fingerprintEvent, normalizeFrame, topAppFrame } from "../src/fingerprint";
import type { LogEvent } from "../src/types";

function errEvent(overrides: Partial<LogEvent> & { stack: string; name?: string }): LogEvent {
  return {
    ts: "2026-07-13T12:00:00.000Z",
    level: "error",
    msg: "handler failed",
    reqId: overrides.reqId ?? "req-1",
    route: overrides.route ?? "POST /orders",
    status: 500,
    err: {
      name: overrides.name ?? "TypeError",
      message: "Cannot read properties of undefined (reading 'id')",
      stack: overrides.stack,
    },
  };
}

describe("normalizeFrame", () => {
  test("strips line and column, keeps path and function", () => {
    expect(normalizeFrame("at handleCreate (src/server.ts:42:11)")).toBe(
      "at handleCreate (src/server.ts)",
    );
  });

  test("strips line:col without parens", () => {
    expect(normalizeFrame("at src/server.ts:42:11")).toBe("at src/server.ts");
  });
});

describe("topAppFrame", () => {
  test("picks first app frame, skips bun internals", () => {
    const stack = [
      "TypeError: boom",
      "    at handleCreate (src/server.ts:42:11)",
      "    at processTicksAndRejections (bun:internal)",
    ].join("\n");
    expect(topAppFrame(stack)).toBe("at handleCreate (src/server.ts)");
  });
});

describe("fingerprintEvent", () => {
  test("same cause, different reqId → same hash", () => {
    const stack =
      "TypeError: Cannot read properties of undefined (reading 'id')\n" +
      "    at handleCreate (src/server.ts:88:22)\n" +
      "    at fetch (bun:main)";

    const a = errEvent({ reqId: "aaa", stack });
    const b = errEvent({ reqId: "bbb", stack: stack.replace(":88:22", ":99:01") });

    const fa = fingerprintEvent(a);
    const fb = fingerprintEvent(b);

    expect(fa.hash).toBe(fb.hash);
    expect(fa.errName).toBe("TypeError");
    expect(fa.route).toBe("POST /orders");
    expect(fa.topFrame).toBe("at handleCreate (src/server.ts)");
  });

  test("different causes → different hash", () => {
    const typeErr = errEvent({
      name: "TypeError",
      route: "POST /orders",
      stack:
        "TypeError: x\n    at handleCreate (src/server.ts:10:1)",
    });
    const rangeErr = errEvent({
      name: "RangeError",
      route: "GET /orders",
      stack:
        "RangeError: Invalid time value\n    at handleList (src/server.ts:50:1)",
    });

    expect(fingerprintEvent(typeErr).hash).not.toBe(fingerprintEvent(rangeErr).hash);
  });

  test("warn-level invariant fingerprints on route + msg prefix", () => {
    const a: LogEvent = {
      ts: "2026-07-13T12:00:00.000Z",
      level: "warn",
      msg: "order total negative; spec unclear whether discounts may exceed subtotal",
      reqId: "r1",
      route: "POST /orders",
    };
    const b: LogEvent = {
      ...a,
      reqId: "r2",
      ts: "2026-07-13T12:01:00.000Z",
    };
    const fa = fingerprintEvent(a);
    const fb = fingerprintEvent(b);
    expect(fa.hash).toBe(fb.hash);
    expect(fa.errName).toBe("WarnInvariant");
    expect(fa.route).toBe("POST /orders");
  });
});
