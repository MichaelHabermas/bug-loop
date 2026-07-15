/**
 * Meta-tests: prove each seeded bug fires under its trigger.
 *
 * Lives under top-level `bench/` (not apps/leaky-service/test) and is gated by
 * BUGLOOP_BENCH=1 so that:
 * 1. Default `bun test` skips them → pipeline pristine-suite eligibility stays green.
 * 2. Post-fix verification is not blocked by assertions that require bugs to exist.
 *
 * Run with: `bun run test:bench`
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resetStore } from "../../apps/leaky-service/src/store";
import { handleRequest } from "../../apps/leaky-service/src/server";

const BASE = "http://leaky-service.bench";
const LOG_DIR = join(import.meta.dir, ".tmp-bench-logs");
const LOG_PATH = join(LOG_DIR, "repro.jsonl");
const describeBench = process.env["BUGLOOP_BENCH"] === "1" ? describe : describe.skip;
const originalLogPath = process.env["LOG_PATH"];

function appFetch(
  path: string,
  init?: RequestInit,
  deps?: { shippingProvider?: (orderId: string) => Promise<{ trackingNumber: string }> },
): Promise<Response> {
  return handleRequest(new Request(`${BASE}${path}`, init), {
    shippingProvider: deps?.shippingProvider ??
      (async (orderId) => ({ trackingNumber: `BENCH-${orderId}` })),
  });
}

async function createOrder(sku = "BENCH"): Promise<string> {
  const res = await appFetch("/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customer: { id: "bench", name: "Bench" },
      items: [{ sku, qty: 1, priceCents: 100 }],
    }),
  });
  const body = (await res.json()) as { id: string };
  return body.id;
}

beforeAll(() => {
  mkdirSync(LOG_DIR, { recursive: true });
  process.env["LOG_PATH"] = LOG_PATH;
});

beforeEach(() => {
  resetStore();
});

afterAll(() => {
  if (originalLogPath === undefined) delete process.env["LOG_PATH"];
  else process.env["LOG_PATH"] = originalLogPath;
  rmSync(LOG_DIR, { recursive: true, force: true });
});

describeBench("seeded-bug repro fires (meta; not eligibility coverage)", () => {
  test("missing-customer: POST /orders without customer → 500", async () => {
    const res = await appFetch("/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ sku: "X", qty: 1, priceCents: 100 }] }),
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  test("invalid-since: GET /orders?since=last-week → 500", async () => {
    const res = await appFetch("/orders?since=last-week");
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  test("shipping-timeout: ship is fire-and-forget (returns before provider settles)", async () => {
    const id = await createOrder("SHIP");
    // In-process unhandled rejections fail Bun's test harness, so we prove the
    // structural bug (response returned while provider still pending) rather than
    // letting the default timeout reject unhandled inside this process.
    let settled = false;
    const response = await handleRequest(
      new Request(`${BASE}/orders/${id}/ship`, { method: "POST" }),
      {
        shippingProvider: () =>
          new Promise((resolve) => {
            setTimeout(() => {
              settled = true;
              resolve({ trackingNumber: `TRK-${id}` });
            }, 50);
          }),
      },
    );
    expect(response.status).toBe(200);
    expect(settled).toBe(false);
    await Bun.sleep(80);
    expect(settled).toBe(true);
  });

  test("items-index: GET items?index=99 → 500", async () => {
    const id = await createOrder("ITEM");
    const res = await appFetch(`/orders/${id}/items?index=99`);
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  test("malformed-json: POST /orders/import with bad body → 500 and logs literal route", async () => {
    const res = await appFetch("/orders/import", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{not-json",
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    // Fingerprint/policy require the literal import route, not POST /orders/:id.
    expect(existsSync(LOG_PATH)).toBe(true);
    const lines = readFileSync(LOG_PATH, "utf8").trim().split("\n").filter(Boolean);
    const lastError = [...lines]
      .reverse()
      .map((line) => JSON.parse(line) as { level?: string; msg?: string; route?: string })
      .find((e) => e.level === "error" && e.msg === "handler error");
    expect(lastError?.route).toBe("POST /orders/import");
  });

  test("missing-receipt: GET receipt for unknown id → 500", async () => {
    const res = await appFetch("/orders/ord_missing/receipt");
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  test("stats-div-zero: GET /stats/orders default window → 500", async () => {
    const res = await appFetch("/stats/orders");
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  test("ship-then-cancel: cancel after ship → 500", async () => {
    const id = await createOrder("STC");
    await appFetch(`/orders/${id}/ship`, { method: "POST" });
    const res = await appFetch(`/orders/${id}/cancel`, { method: "POST" });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  test("pagination-overflow: page=2 after >pageSize orders → 500", async () => {
    for (let i = 0; i < 21; i += 1) {
      await createOrder(`P${i}`);
    }
    const res = await appFetch("/orders?page=2");
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  test("export-header: GET /orders with x-export → 500", async () => {
    await createOrder("EXP");
    const res = await appFetch("/orders", { headers: { "x-export": "full" } });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  test("double-ship: second ship → 500", async () => {
    const id = await createOrder("DBL");
    await appFetch(`/orders/${id}/ship`, { method: "POST" });
    const res = await appFetch(`/orders/${id}/ship`, { method: "POST" });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  test("refund-token (unknown-class): malformed bearer → 500", async () => {
    const id = await createOrder("REF");
    const res = await appFetch(`/orders/${id}/refund`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-jwt" },
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  test("tax-region (unknown-class): missing customer region → 500", async () => {
    const id = await createOrder("TAX");
    const res = await appFetch(`/orders/${id}/tax`);
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  test("over-discount: creates with warn path (non-500 product ambiguity)", async () => {
    const res = await appFetch("/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customer: { id: "d", name: "Disc" },
        items: [{ sku: "D", qty: 1, priceCents: 1000 }],
        discountPercent: 150,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { totalCents: number };
    expect(body.totalCents).toBeLessThan(0);
  });
});
