import {
  createOrder,
  getOrder,
  listOrders,
  markShipped,
  type CreateOrderInput,
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
    customer: CreateOrderInput["customer"];
    items?: OrderItem[];
  };
  const route = "POST /orders";

  const items: OrderItem[] = body.items ?? [];
  const discountPercent = body.discountPercent ?? 0;

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

  const result = listOrders({ page, pageSize: PAGE_SIZE, since });
  logInfo("orders listed", { reqId: id, route, status: 200 });
  return json(result);
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

async function routeRequest(
  req: Request,
  id: string,
  shippingProvider: ShippingProvider,
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (method === "POST" && path === "/orders") {
    return handleCreate(req, id);
  }

  if (method === "GET" && path === "/orders") {
    return handleList(req, id);
  }

  const orderMatch = path.match(/^\/orders\/([^/]+)$/);
  if (method === "GET" && orderMatch?.[1]) {
    return handleGet(id, orderMatch[1]);
  }

  const shipMatch = path.match(/^\/orders\/([^/]+)\/ship$/);
  if (method === "POST" && shipMatch?.[1]) {
    return handleShip(id, shipMatch[1], shippingProvider);
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
  try {
    const shippingProvider = dependencies.shippingProvider ?? ((orderId) =>
      callShippingProvider(orderId, { timeoutMs: 15, latencyMs: 80 }));
    return await routeRequest(req, id, shippingProvider);
  } catch (err) {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    logError("handler error", {
      reqId: id,
      route,
      status: 500,
      err: toLogErr(err),
    });
    return json({ error: "internal server error" }, 500);
  }
}

let server: ReturnType<typeof Bun.serve> | undefined;
if (import.meta.main) {
  server = Bun.serve({ port: PORT, fetch: (request) => handleRequest(request) });
  logInfo("leaky-service listening", {
    route: `http://localhost:${server.port}`,
  });
}

export { server, callShippingProvider };
