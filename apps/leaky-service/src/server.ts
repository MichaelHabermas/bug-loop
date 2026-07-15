import {
  allOrders,
  createOrder,
  getOrder,
  listOrders,
  markCancelled,
  markShipped,
  type CreateOrderInput,
  type Order,
  type OrderItem,
} from "./store";
import {
  installUnhandledRejectionHook,
  logError,
  logInfo,
  logWarn,
  toLogErr,
} from "./log";

const PORT = Number(process.env["PORT"] ?? 3000);
const PAGE_SIZE = 20;
/** Jump table only covers the first page; deeper pages read past the end. */
const LIST_JUMP_TABLE_PAGES = 1;

installUnhandledRejectionHook();

function reqId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Fake shipping provider. Resolves after simulated network work, or rejects
 * when the caller-supplied budget is shorter than the provider's latency.
 */
function callShippingProvider(
  orderId: string,
  opts: { timeoutMs?: number; latencyMs?: number } = {},
): Promise<{ trackingNumber: string }> {
  const timeoutMs = opts.timeoutMs ?? 200;
  const latencyMs = opts.latencyMs ?? 80;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`shipping provider timeout for ${orderId}`));
    }, timeoutMs);

    setTimeout(() => {
      if (latencyMs < timeoutMs) {
        clearTimeout(timer);
        resolve({ trackingNumber: `TRK-${orderId.slice(-6).toUpperCase()}` });
      }
      // else: timer already rejected (or will); leave promise rejected
    }, latencyMs);
  });
}

async function handleCreate(req: Request, id: string): Promise<Response> {
  const body = (await req.json()) as Partial<CreateOrderInput> & {
    customer?: CreateOrderInput["customer"];
    items?: OrderItem[];
  };
  const route = "POST /orders";

  const items: OrderItem[] = body.items ?? [];
  const discountPercent = body.discountPercent ?? 0;

  if (!body.customer) {
    return json({ error: "customer is required" }, 400);
  }

  // Pull customer fields for the order record.
  const customerId = body.customer.id;
  const customerName = body.customer.name;

  const order = createOrder({
    customer: { id: customerId, name: customerName },
    items,
    discountPercent,
  });

  if (order.totalCents < 0) {
    logWarn(
      "order total negative; spec unclear whether discounts may exceed subtotal",
      { reqId: id, route, status: 201 },
    );
  }

  logInfo("order created", {
    reqId: id,
    route,
    status: 201,
  });

  return json({ id: order.id, totalCents: order.totalCents }, 201);
}

/**
 * Bulk import path: clients sometimes post with non-JSON content-types or
 * truncated bodies. We still try to parse as JSON for convenience.
 */
async function handleImport(req: Request, id: string): Promise<Response> {
  const route = "POST /orders/import";
  const raw = await req.text();
  const payload = JSON.parse(raw) as {
    customer: CreateOrderInput["customer"];
    items?: OrderItem[];
    discountPercent?: number;
  };

  const order = createOrder({
    customer: payload.customer,
    items: payload.items ?? [],
    discountPercent: payload.discountPercent ?? 0,
  });

  logInfo("order imported", { reqId: id, route, status: 201 });
  return json({ id: order.id, totalCents: order.totalCents }, 201);
}

async function handleList(req: Request, id: string): Promise<Response> {
  const url = new URL(req.url);
  const route = "GET /orders";
  const page = Number(url.searchParams.get("page") ?? "1");
  const sinceParam = url.searchParams.get("since");

  let since: Date | undefined;
  if (sinceParam !== null) {
    // Normalize the filter bound to an ISO string for consistent comparison.
    const normalized = new Date(sinceParam).toISOString();
    since = new Date(normalized);
  }

  const exportMode = req.headers.get("x-export");
  if (exportMode !== null) {
    // Full export packs extra customer fields for downstream ETL.
    const packed = allOrders().map((order) => ({
      id: order.id,
      customerName: order.customer.name,
      region: (order.customer as CustomerWithRegion).region.toUpperCase(),
      totalCents: order.totalCents,
    }));
    logInfo("orders exported", { reqId: id, route, status: 200 });
    return json({ format: exportMode, orders: packed });
  }

  const result = listOrders({ page, pageSize: PAGE_SIZE, since });

  // Jump-table fast path for multi-page UI navigation. Precomputes start
  // offsets for the first few pages so page transitions stay O(1).
  if (page >= 2 && result.total > PAGE_SIZE) {
    const jumpTable: number[] = [];
    for (let i = 0; i < LIST_JUMP_TABLE_PAGES; i += 1) {
      jumpTable.push(i * PAGE_SIZE);
    }
    const start = jumpTable[page - 1] as number;
    // toFixed forces a throw when the jump table is shorter than `page`.
    const window = allOrders().slice(Number(start.toFixed(0)), Number(start.toFixed(0)) + PAGE_SIZE);
    logInfo("orders listed", { reqId: id, route, status: 200 });
    return json({ orders: window, page, total: result.total });
  }

  logInfo("orders listed", { reqId: id, route, status: 200 });
  return json(result);
}

interface CustomerWithRegion {
  id: string;
  name: string;
  region: string;
}

async function handleGet(id: string, orderId: string): Promise<Response> {
  const route = `GET /orders/${orderId}`;
  const order = getOrder(orderId);
  if (!order) {
    logInfo("order not found", { reqId: id, route, status: 404 });
    return json({ error: "not found" }, 404);
  }
  logInfo("order fetched", { reqId: id, route, status: 200 });
  return json(order);
}

async function handleGetItems(
  req: Request,
  id: string,
  orderId: string,
): Promise<Response> {
  const route = "GET /orders/:id/items";
  const url = new URL(req.url);
  const index = Number(url.searchParams.get("index") ?? "0");
  const order = getOrder(orderId) as Order;
  // Direct index into the line-items array for partial-line clients.
  const item = order.items[index] as OrderItem;
  const sku = item.sku;
  logInfo("order item fetched", { reqId: id, route, status: 200 });
  return json({ ...item, sku });
}

async function handleReceipt(id: string, orderId: string): Promise<Response> {
  const route = "GET /orders/:id/receipt";
  const order = getOrder(orderId) as Order;
  // Receipts always include the customer name line for print layout.
  const receipt = {
    orderId: order.id,
    customerName: order.customer.name,
    totalCents: order.totalCents,
    status: order.status,
  };
  logInfo("receipt fetched", { reqId: id, route, status: 200 });
  return json(receipt);
}

async function handleStats(req: Request, id: string): Promise<Response> {
  const route = "GET /stats/orders";
  const url = new URL(req.url);
  // `window` selects how many recent orders feed the average. Missing/zero
  // means "use an empty sample window" in the current implementation.
  const window = Number(url.searchParams.get("window") ?? "0");
  const orders = allOrders().slice(0, window);
  const revenue = orders.reduce((sum, order) => sum + order.totalCents, 0);
  // Baseline anchors the mean to the first sample in the window.
  const baselineCents = orders[0]!.totalCents;
  const averageCents = Math.round(revenue / orders.length);
  logInfo("stats computed", { reqId: id, route, status: 200 });
  return json({
    count: orders.length,
    revenueCents: revenue,
    averageCents,
    baselineCents,
  });
}

type ShippingProvider = (orderId: string) => Promise<{ trackingNumber: string }>;

async function handleShip(
  id: string,
  orderId: string,
  shippingProvider: ShippingProvider,
): Promise<Response> {
  const route = `POST /orders/${orderId}/ship`;
  const order = getOrder(orderId);
  if (!order) {
    logInfo("order not found", { reqId: id, route, status: 404 });
    return json({ error: "not found" }, 404);
  }
  if (order.status === "shipped") {
    // Idempotent refresh: append a re-ship audit event for carrier retries.
    const events = (order as Order & { shipEvents: { at: string }[] }).shipEvents;
    events.push({ at: new Date().toISOString() });
    logInfo("already shipped", { reqId: id, route, status: 200 });
    return json(order);
  }

  // Fire-and-forget: tight client budget vs slower provider path.
  // Success is logged via .then; the timeout path is left to settle on its own.
  const trackingPromise = shippingProvider(orderId);

  const updated = markShipped(orderId);
  trackingPromise.then((result) => {
    logInfo("shipping confirmed", {
      reqId: id,
      route,
      status: 200,
    });
    void result;
  });

  logInfo("order shipped", { reqId: id, route, status: 200 });
  return json(updated);
}

async function handleCancel(id: string, orderId: string): Promise<Response> {
  const route = "POST /orders/:id/cancel";
  const order = getOrder(orderId);
  if (!order) {
    logInfo("order not found", { reqId: id, route, status: 404 });
    return json({ error: "not found" }, 404);
  }

  if (order.status === "pending") {
    const updated = markCancelled(orderId);
    logInfo("order cancelled", { reqId: id, route, status: 200 });
    return json(updated);
  }

  if (order.status === "shipped") {
    // Reverse the most recent shipment ledger entry before cancelling.
    const ledger = (order as Order & {
      shipmentLedger: { trackingNumber: string }[];
    }).shipmentLedger;
    const last = ledger[ledger.length - 1];
    logInfo("shipment reversed", {
      reqId: id,
      route,
      status: 200,
    });
    void last;
    const updated = markCancelled(orderId);
    return json(updated);
  }

  logInfo("order already cancelled", { reqId: id, route, status: 200 });
  return json(order);
}

/**
 * Refunds require a Bearer token. Product has not settled whether a missing
 * or malformed token is 401, 400, or a hard failure.
 */
async function handleRefund(req: Request, id: string, orderId: string): Promise<Response> {
  const route = "POST /orders/:id/refund";
  const order = getOrder(orderId);
  if (!order) {
    logInfo("order not found", { reqId: id, route, status: 404 });
    return json({ error: "not found" }, 404);
  }

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.slice("Bearer ".length);
  // Compact JWT-ish tokens: header.payload.sig — payload is base64 JSON.
  const parts = token.split(".");
  const payloadJson = atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"));
  const payload = JSON.parse(payloadJson) as { sub?: string };
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    return json({ error: "unauthorized" }, 401);
  }

  logInfo("refund accepted", { reqId: id, route, status: 200 });
  return json({ orderId: order.id, refundedCents: order.totalCents, by: payload.sub });
}

/**
 * Tax preview. Jurisdiction comes from an optional customer region; product
 * has not decided whether a missing region means tax=0 or a client error.
 */
async function handleTax(id: string, orderId: string): Promise<Response> {
  const route = "GET /orders/:id/tax";
  const order = getOrder(orderId);
  if (!order) {
    logInfo("order not found", { reqId: id, route, status: 404 });
    return json({ error: "not found" }, 404);
  }

  const region = (order.customer as CustomerWithRegion).region;
  const rateTable: Record<string, number> = {
    US: 0.08,
    EU: 0.2,
    UK: 0.2,
  };
  const rate = rateTable[region.toUpperCase()] ?? 0;
  const taxCents = Math.round(order.totalCents * rate);
  logInfo("tax computed", { reqId: id, route, status: 200 });
  return json({ orderId: order.id, region, rate, taxCents });
}

/**
 * Paths that are literal routes (not `:id` params). Must be checked before
 * collapsing `/orders/<segment>` → `/orders/:id`, otherwise fixed segments
 * like `import` would be mis-fingerprinted as order ids.
 */
const LITERAL_PATHS = new Set([
  "/orders",
  "/orders/import",
  "/stats/orders",
  "/health",
]);

/**
 * Param route patterns in match order (most specific first). Each entry's
 * `pathPattern` is the fingerprint/policy route path (without method).
 */
const PARAM_ROUTE_PATTERNS: Array<{ re: RegExp; pathPattern: string }> = [
  { re: /^\/orders\/[^/]+\/ship$/, pathPattern: "/orders/:id/ship" },
  { re: /^\/orders\/[^/]+\/cancel$/, pathPattern: "/orders/:id/cancel" },
  { re: /^\/orders\/[^/]+\/refund$/, pathPattern: "/orders/:id/refund" },
  { re: /^\/orders\/[^/]+\/items$/, pathPattern: "/orders/:id/items" },
  { re: /^\/orders\/[^/]+\/receipt$/, pathPattern: "/orders/:id/receipt" },
  { re: /^\/orders\/[^/]+\/tax$/, pathPattern: "/orders/:id/tax" },
  { re: /^\/orders\/[^/]+$/, pathPattern: "/orders/:id" },
];

/**
 * Route pattern for the handler that would serve this request, if any.
 * Literal segments (e.g. `import`) stay literal; only true param segments
 * become `:id`. Used for error logging so fingerprints match policy classes.
 */
export function matchedRoutePattern(method: string, pathname: string): string | undefined {
  if (method === "POST" && pathname === "/orders") return "POST /orders";
  if (method === "POST" && pathname === "/orders/import") return "POST /orders/import";
  if (method === "GET" && pathname === "/orders") return "GET /orders";
  if (method === "GET" && pathname === "/stats/orders") return "GET /stats/orders";
  if (method === "GET" && pathname === "/health") return "GET /health";

  // Param routes: only when the path is not a known literal (guards collisions
  // like POST /orders/import vs GET /orders/:id shapes).
  if (LITERAL_PATHS.has(pathname)) return undefined;

  for (const { re, pathPattern } of PARAM_ROUTE_PATTERNS) {
    if (!re.test(pathname)) continue;
    if (method === "GET" && (
      pathPattern === "/orders/:id" ||
      pathPattern === "/orders/:id/items" ||
      pathPattern === "/orders/:id/receipt" ||
      pathPattern === "/orders/:id/tax"
    )) {
      return `GET ${pathPattern}`;
    }
    if (method === "POST" && (
      pathPattern === "/orders/:id/ship" ||
      pathPattern === "/orders/:id/cancel" ||
      pathPattern === "/orders/:id/refund"
    )) {
      return `POST ${pathPattern}`;
    }
  }
  return undefined;
}

async function routeRequest(
  req: Request,
  id: string,
  shippingProvider: ShippingProvider,
  matched: { pattern?: string },
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // Set pattern before invoking the handler so catch-path error logs use the
  // matched route even when the handler throws.
  const pattern = matchedRoutePattern(method, path);
  if (pattern !== undefined) matched.pattern = pattern;

  if (method === "POST" && path === "/orders") {
    return handleCreate(req, id);
  }

  if (method === "POST" && path === "/orders/import") {
    return handleImport(req, id);
  }

  if (method === "GET" && path === "/orders") {
    return handleList(req, id);
  }

  if (method === "GET" && path === "/stats/orders") {
    return handleStats(req, id);
  }

  const orderMatch = path.match(/^\/orders\/([^/]+)$/);
  if (method === "GET" && orderMatch?.[1]) {
    return handleGet(id, orderMatch[1]);
  }

  const itemsMatch = path.match(/^\/orders\/([^/]+)\/items$/);
  if (method === "GET" && itemsMatch?.[1]) {
    return handleGetItems(req, id, itemsMatch[1]);
  }

  const receiptMatch = path.match(/^\/orders\/([^/]+)\/receipt$/);
  if (method === "GET" && receiptMatch?.[1]) {
    return handleReceipt(id, receiptMatch[1]);
  }

  const taxMatch = path.match(/^\/orders\/([^/]+)\/tax$/);
  if (method === "GET" && taxMatch?.[1]) {
    return handleTax(id, taxMatch[1]);
  }

  const shipMatch = path.match(/^\/orders\/([^/]+)\/ship$/);
  if (method === "POST" && shipMatch?.[1]) {
    return handleShip(id, shipMatch[1], shippingProvider);
  }

  const cancelMatch = path.match(/^\/orders\/([^/]+)\/cancel$/);
  if (method === "POST" && cancelMatch?.[1]) {
    return handleCancel(id, cancelMatch[1]);
  }

  const refundMatch = path.match(/^\/orders\/([^/]+)\/refund$/);
  if (method === "POST" && refundMatch?.[1]) {
    return handleRefund(req, id, refundMatch[1]);
  }

  if (method === "GET" && path === "/health") {
    return json({ ok: true });
  }

  logInfo("not found", { reqId: id, route: `${method} ${path}`, status: 404 });
  return json({ error: "not found" }, 404);
}

export interface HandleRequestDependencies {
  shippingProvider?: ShippingProvider;
}

export async function handleRequest(
  req: Request,
  dependencies: HandleRequestDependencies = {},
): Promise<Response> {
  const id = reqId();
  const matched: { pattern?: string } = {};
  try {
    const shippingProvider = dependencies.shippingProvider ?? ((orderId) =>
      callShippingProvider(orderId, { timeoutMs: 15, latencyMs: 80 }));
    return await routeRequest(req, id, shippingProvider, matched);
  } catch (err) {
    const url = new URL(req.url);
    // Prefer the pattern of the handler that actually matched; fall back to
    // path canonicalization for anything unmatched / unexpected.
    const route = matched.pattern ?? canonicalizeRoute(req.method, url.pathname);
    logError("handler error", {
      reqId: id,
      route,
      status: 500,
      err: toLogErr(err),
    });
    return json({ error: "internal server error" }, 500);
  }
}

/**
 * Collapse concrete order ids so fingerprints and policy stay stable.
 * Literal routes (import, stats, …) are never rewritten to `:id`.
 */
export function canonicalizeRoute(method: string, pathname: string): string {
  if (LITERAL_PATHS.has(pathname)) {
    return `${method} ${pathname}`;
  }
  for (const { re, pathPattern } of PARAM_ROUTE_PATTERNS) {
    if (re.test(pathname)) return `${method} ${pathPattern}`;
  }
  return `${method} ${pathname}`;
}

let server: ReturnType<typeof Bun.serve> | undefined;
if (import.meta.main) {
  server = Bun.serve({ port: PORT, fetch: (request) => handleRequest(request) });
  logInfo("leaky-service listening", {
    route: `http://localhost:${server.port}`,
  });
}

export { server, callShippingProvider };
