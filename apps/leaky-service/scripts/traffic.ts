/**
 * Seeded traffic generator for leaky-service.
 *
 * Usage:
 *   bun scripts/traffic.ts --count 50 --seed 42 --base http://localhost:3000
 */

interface Args {
  count: number;
  seed: number;
  base: string;
}

function parseArgs(argv: string[]): Args {
  let count = 50;
  let seed = 42;
  let base = "http://localhost:3000";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--count" && next) {
      count = Number(next);
      i++;
    } else if (a === "--seed" && next) {
      seed = Number(next);
      i++;
    } else if (a === "--base" && next) {
      base = next.replace(/\/$/, "");
      i++;
    }
  }
  return { count, seed, base };
}

/** Mulberry32 — small seeded PRNG. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind =
  | "valid_create"
  | "valid_list"
  | "valid_get"
  | "valid_ship"
  | "valid_items"
  | "valid_import"
  | "valid_receipt"
  | "valid_stats"
  | "valid_cancel"
  | "bug_null_customer"
  | "bug_bad_since"
  | "bug_ship_timeout"
  | "bug_over_discount"
  | "bug_items_index"
  | "bug_malformed_json"
  | "bug_missing_receipt"
  | "bug_stats_window"
  | "bug_ship_then_cancel"
  | "bug_pagination"
  | "bug_export_header"
  | "bug_double_ship"
  | "bug_refund_token"
  | "bug_tax_region";

const VALID_KINDS: Kind[] = [
  "valid_create",
  "valid_list",
  "valid_get",
  "valid_ship",
  "valid_items",
  "valid_import",
  "valid_receipt",
  "valid_stats",
  "valid_cancel",
];

const BUG_KINDS: Kind[] = [
  "bug_null_customer",
  "bug_bad_since",
  "bug_ship_timeout",
  "bug_over_discount",
  "bug_items_index",
  "bug_malformed_json",
  "bug_missing_receipt",
  "bug_stats_window",
  "bug_ship_then_cancel",
  "bug_pagination",
  "bug_export_header",
  "bug_double_ship",
  "bug_refund_token",
  "bug_tax_region",
];

/** Cycle bug kinds so a moderate run hits every trigger, not just a random subset. */
let bugCursor = 0;

function pickKind(rng: () => number): Kind {
  // ~65% valid, ~35% bug triggers (more kinds need more hits)
  if (rng() < 0.65) {
    return VALID_KINDS[Math.floor(rng() * VALID_KINDS.length)] ?? "valid_create";
  }
  const kind = BUG_KINDS[bugCursor % BUG_KINDS.length] ?? "bug_null_customer";
  bugCursor += 1;
  return kind;
}

const createdIds: string[] = [];
const pendingIds: string[] = [];

async function createOrder(
  base: string,
  customerId: string,
  sku: string,
): Promise<string | null> {
  const res = await fetch(`${base}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customer: { id: customerId, name: "Traffic" },
      items: [{ sku, qty: 1, priceCents: 500 }],
    }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { id?: string };
  if (body.id) {
    createdIds.push(body.id);
    pendingIds.push(body.id);
    return body.id;
  }
  return null;
}

async function send(
  base: string,
  kind: Kind,
  rng: () => number,
): Promise<{ ok: boolean; status: number }> {
  try {
    switch (kind) {
      case "valid_create": {
        const res = await fetch(`${base}/orders`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            customer: { id: `cust_${Math.floor(rng() * 1000)}`, name: "Ada" },
            items: [{ sku: "SKU-1", qty: 1 + Math.floor(rng() * 3), priceCents: 999 }],
            discountPercent: Math.floor(rng() * 20),
          }),
        });
        if (res.ok) {
          const body = (await res.json()) as { id?: string };
          if (body.id) {
            createdIds.push(body.id);
            pendingIds.push(body.id);
          }
        }
        return { ok: res.ok, status: res.status };
      }
      case "valid_list": {
        const res = await fetch(`${base}/orders?page=1`);
        return { ok: res.ok, status: res.status };
      }
      case "valid_get": {
        const id = createdIds[Math.floor(rng() * createdIds.length)];
        if (!id) return send(base, "valid_create", rng);
        const res = await fetch(`${base}/orders/${id}`);
        return { ok: res.ok, status: res.status };
      }
      case "valid_ship": {
        const createRes = await fetch(`${base}/orders`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            customer: { id: "cust_ship", name: "Shipper" },
            items: [{ sku: "SKU-SHIP", qty: 1, priceCents: 500 }],
          }),
        });
        const created = (await createRes.json()) as { id?: string };
        if (!created.id) return { ok: false, status: createRes.status };
        createdIds.push(created.id);
        const res = await fetch(`${base}/orders/${created.id}/ship`, { method: "POST" });
        return { ok: res.ok, status: res.status };
      }
      case "valid_items": {
        let id = createdIds[Math.floor(rng() * createdIds.length)];
        if (!id) id = (await createOrder(base, "cust_items", "SKU-ITEMS")) ?? undefined;
        if (!id) return { ok: false, status: 0 };
        const res = await fetch(`${base}/orders/${id}/items?index=0`);
        return { ok: res.ok, status: res.status };
      }
      case "valid_import": {
        const res = await fetch(`${base}/orders/import`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            customer: { id: "cust_import", name: "Importer" },
            items: [{ sku: "SKU-IMP", qty: 1, priceCents: 200 }],
          }),
        });
        if (res.ok) {
          const body = (await res.json()) as { id?: string };
          if (body.id) {
            createdIds.push(body.id);
            pendingIds.push(body.id);
          }
        }
        return { ok: res.ok, status: res.status };
      }
      case "valid_receipt": {
        let id = createdIds[Math.floor(rng() * createdIds.length)];
        if (!id) id = (await createOrder(base, "cust_rcpt", "SKU-RCPT")) ?? undefined;
        if (!id) return { ok: false, status: 0 };
        const res = await fetch(`${base}/orders/${id}/receipt`);
        return { ok: res.ok, status: res.status };
      }
      case "valid_stats": {
        if (createdIds.length === 0) await createOrder(base, "cust_stats", "SKU-STATS");
        const res = await fetch(`${base}/stats/orders?window=5`);
        return { ok: res.ok, status: res.status };
      }
      case "valid_cancel": {
        const id = await createOrder(base, "cust_cancel", "SKU-CANCEL");
        if (!id) return { ok: false, status: 0 };
        const res = await fetch(`${base}/orders/${id}/cancel`, { method: "POST" });
        const idx = pendingIds.indexOf(id);
        if (idx >= 0) pendingIds.splice(idx, 1);
        return { ok: res.ok, status: res.status };
      }
      case "bug_null_customer": {
        const res = await fetch(`${base}/orders`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            items: [{ sku: "SKU-X", qty: 1, priceCents: 100 }],
          }),
        });
        return { ok: res.ok, status: res.status };
      }
      case "bug_bad_since": {
        const res = await fetch(`${base}/orders?since=last-week`);
        return { ok: res.ok, status: res.status };
      }
      case "bug_ship_timeout": {
        const createRes = await fetch(`${base}/orders`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            customer: { id: "cust_t", name: "Timeout" },
            items: [{ sku: "SKU-T", qty: 1, priceCents: 100 }],
          }),
        });
        const created = (await createRes.json()) as { id?: string };
        if (!created.id) return { ok: false, status: createRes.status };
        createdIds.push(created.id);
        const res = await fetch(`${base}/orders/${created.id}/ship`, { method: "POST" });
        await Bun.sleep(80);
        return { ok: res.ok, status: res.status };
      }
      case "bug_over_discount": {
        const res = await fetch(`${base}/orders`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            customer: { id: "cust_d", name: "Discount" },
            items: [{ sku: "SKU-D", qty: 1, priceCents: 1000 }],
            discountPercent: 150,
          }),
        });
        return { ok: res.ok, status: res.status };
      }
      case "bug_items_index": {
        const id = await createOrder(base, "cust_idx", "SKU-IDX");
        if (!id) return { ok: false, status: 0 };
        const res = await fetch(`${base}/orders/${id}/items?index=99`);
        return { ok: res.ok, status: res.status };
      }
      case "bug_malformed_json": {
        const res = await fetch(`${base}/orders/import`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{not-json",
        });
        return { ok: res.ok, status: res.status };
      }
      case "bug_missing_receipt": {
        const res = await fetch(`${base}/orders/ord_does_not_exist/receipt`);
        return { ok: res.ok, status: res.status };
      }
      case "bug_stats_window": {
        const res = await fetch(`${base}/stats/orders`);
        return { ok: res.ok, status: res.status };
      }
      case "bug_ship_then_cancel": {
        const id = await createOrder(base, "cust_stc", "SKU-STC");
        if (!id) return { ok: false, status: 0 };
        await fetch(`${base}/orders/${id}/ship`, { method: "POST" });
        await Bun.sleep(50);
        const res = await fetch(`${base}/orders/${id}/cancel`, { method: "POST" });
        return { ok: res.ok, status: res.status };
      }
      case "bug_pagination": {
        while (createdIds.length < 22) {
          await createOrder(base, `cust_page_${createdIds.length}`, "SKU-PAGE");
        }
        const res = await fetch(`${base}/orders?page=2`);
        return { ok: res.ok, status: res.status };
      }
      case "bug_export_header": {
        if (createdIds.length === 0) await createOrder(base, "cust_exp", "SKU-EXP");
        const res = await fetch(`${base}/orders`, {
          headers: { "x-export": "full" },
        });
        return { ok: res.ok, status: res.status };
      }
      case "bug_double_ship": {
        const id = await createOrder(base, "cust_dbl", "SKU-DBL");
        if (!id) return { ok: false, status: 0 };
        await fetch(`${base}/orders/${id}/ship`, { method: "POST" });
        await Bun.sleep(50);
        const res = await fetch(`${base}/orders/${id}/ship`, { method: "POST" });
        return { ok: res.ok, status: res.status };
      }
      case "bug_refund_token": {
        const id = await createOrder(base, "cust_ref", "SKU-REF");
        if (!id) return { ok: false, status: 0 };
        const res = await fetch(`${base}/orders/${id}/refund`, {
          method: "POST",
          headers: { authorization: "Bearer not-a-jwt" },
        });
        return { ok: res.ok, status: res.status };
      }
      case "bug_tax_region": {
        const id = await createOrder(base, "cust_tax", "SKU-TAX");
        if (!id) return { ok: false, status: 0 };
        const res = await fetch(`${base}/orders/${id}/tax`);
        return { ok: res.ok, status: res.status };
      }
    }
  } catch {
    return { ok: false, status: 0 };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rng = mulberry32(args.seed);

  let sent = 0;
  let ok = 0;
  let errors = 0;

  for (let i = 0; i < args.count; i++) {
    const kind = pickKind(rng);
    const result = await send(args.base, kind, rng);
    sent++;
    if (result.ok) ok++;
    else errors++;
  }

  // Extra settle time for async rejections from ship timeouts
  await Bun.sleep(150);

  console.log(`traffic done: sent=${sent} ok=${ok} errors=${errors}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
