export interface Customer {
  id: string;
  name: string;
}

export interface OrderItem {
  sku: string;
  qty: number;
  priceCents: number;
}

export type OrderStatus = "pending" | "shipped" | "cancelled";

export interface Order {
  id: string;
  customer: Customer;
  items: OrderItem[];
  discountPercent: number;
  totalCents: number;
  status: OrderStatus;
  createdAt: string;
  shippedAt?: string;
  shipEvents?: { at: string }[];
}

export interface CreateOrderInput {
  customer: Customer;
  items: OrderItem[];
  discountPercent?: number;
}

let seq = 0;
const orders = new Map<string, Order>();

export function resetStore(): void {
  orders.clear();
  seq = 0;
}

export function createOrder(input: CreateOrderInput): Order {
  seq += 1;
  const id = `ord_${String(seq).padStart(6, "0")}`;
  const subtotal = input.items.reduce(
    (sum, item) => sum + item.qty * item.priceCents,
    0,
  );
  const discountPercent = input.discountPercent ?? 0;
  const totalCents = Math.round(subtotal * (1 - discountPercent / 100));

  const order: Order = {
    id,
    customer: input.customer,
    items: input.items,
    discountPercent,
    totalCents,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  orders.set(id, order);
  return order;
}

export function getOrder(id: string): Order | undefined {
  return orders.get(id);
}

export function allOrders(): Order[] {
  return Array.from(orders.values()).sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1,
  );
}

export function orderCount(): number {
  return orders.size;
}

export function listOrders(opts: {
  page: number;
  pageSize: number;
  since?: Date;
}): { orders: Order[]; page: number; total: number } {
  const pageSize = opts.pageSize;
  const page = Math.max(1, opts.page);

  let all = allOrders();

  if (opts.since) {
    const sinceMs = opts.since.getTime();
    all = all.filter((o) => Date.parse(o.createdAt) >= sinceMs);
  }

  const total = all.length;
  const start = (page - 1) * pageSize;
  return {
    orders: all.slice(start, start + pageSize),
    page,
    total,
  };
}

export function markShipped(id: string): Order | undefined {
  const order = orders.get(id);
  if (!order) return undefined;
  order.status = "shipped";
  order.shippedAt = new Date().toISOString();
  order.shipEvents = [{ at: new Date().toISOString() }];
  return order;
}

export function markCancelled(id: string): Order | undefined {
  const order = orders.get(id);
  if (!order) return undefined;
  order.status = "cancelled";
  return order;
}
