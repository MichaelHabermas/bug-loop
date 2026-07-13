import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";

const PORT = 3456;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG_PATH = join(import.meta.dir, ".tmp-test-logs", "happy.jsonl");

let proc: ReturnType<typeof Bun.spawn> | null = null;

async function waitForHealth(timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(50);
  }
  throw new Error("service did not become healthy");
}

beforeAll(async () => {
  rmSync(join(import.meta.dir, ".tmp-test-logs"), { recursive: true, force: true });
  proc = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      PORT: String(PORT),
      LOG_PATH,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForHealth();
});

afterAll(() => {
  proc?.kill();
  rmSync(join(import.meta.dir, ".tmp-test-logs"), { recursive: true, force: true });
});

describe("leaky-service happy path", () => {
  test("POST /orders creates an order and returns id + totalCents", async () => {
    const res = await fetch(`${BASE}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customer: { id: "c1", name: "Grace" },
        items: [
          { sku: "A", qty: 2, priceCents: 500 },
          { sku: "B", qty: 1, priceCents: 250 },
        ],
        discountPercent: 10,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; totalCents: number };
    expect(body.id).toMatch(/^ord_/);
    // subtotal 1250, 10% off → 1125
    expect(body.totalCents).toBe(1125);
  });

  test("GET /orders lists orders", async () => {
    const res = await fetch(`${BASE}/orders?page=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orders: unknown[];
      page: number;
      total: number;
    };
    expect(body.page).toBe(1);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.orders)).toBe(true);
  });

  test("GET /orders/:id returns the order", async () => {
    const create = await fetch(`${BASE}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customer: { id: "c2", name: "Alan" },
        items: [{ sku: "C", qty: 1, priceCents: 100 }],
      }),
    });
    const { id } = (await create.json()) as { id: string };

    const res = await fetch(`${BASE}/orders/${id}`);
    expect(res.status).toBe(200);
    const order = (await res.json()) as { id: string; customer: { name: string } };
    expect(order.id).toBe(id);
    expect(order.customer.name).toBe("Alan");
  });

  test("GET /orders?since= valid ISO filters without error", async () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    const res = await fetch(`${BASE}/orders?since=${encodeURIComponent(since)}`);
    expect(res.status).toBe(200);
  });

  test("POST /orders/:id/ship marks order shipped", async () => {
    const create = await fetch(`${BASE}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customer: { id: "c3", name: "Katherine" },
        items: [{ sku: "D", qty: 1, priceCents: 200 }],
      }),
    });
    const { id } = (await create.json()) as { id: string };

    const res = await fetch(`${BASE}/orders/${id}/ship`, { method: "POST" });
    expect(res.status).toBe(200);
    const order = (await res.json()) as { status: string };
    expect(order.status).toBe("shipped");

    // Allow any async shipping callbacks to settle without failing the suite
    await Bun.sleep(100);
  });

  test("modest discount does not produce negative total", async () => {
    const res = await fetch(`${BASE}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customer: { id: "c4", name: "Margaret" },
        items: [{ sku: "E", qty: 1, priceCents: 1000 }],
        discountPercent: 25,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { totalCents: number };
    expect(body.totalCents).toBe(750);
    expect(body.totalCents).toBeGreaterThanOrEqual(0);
  });
});
