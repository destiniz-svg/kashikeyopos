import { cleanStoreId, db, getSelectedStoreId, uuid } from "../offline/db.js";
import { enqueueCustomerDelta, enqueuePut, enqueueStockDelta } from "../offline/syncQueue.js";
import { syncNow } from "../offline/syncManager.js";

function money(n) {
  return Math.round(Number(n || 0));
}

function lineTotal(line) {
  const qty = Number(line.qty || 1);
  const price = money(line.price);
  const discount = Number(line.discPct || 0) / 100;
  return Math.round(price * qty * (1 - discount));
}

function makeLocalOrderNumber(register = "R1", storeId = "main") {
  const d = new Date();
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `LOCAL-${storeId.toUpperCase()}-${register}-${day}-${String(Date.now()).slice(-6)}`;
}

export async function createTransaction({
  cart,
  customer = null,
  table = "Walk-in",
  orderType = "dinein",
  payments = [],
  settings = {},
  register = "R1",
  storeId,
  note = ""
}) {
  if (!Array.isArray(cart) || !cart.length) throw new Error("cart is empty");

  const selectedStore = cleanStoreId(storeId || await getSelectedStoreId());
  const now = Date.now();
  const orderId = uuid();
  const gstBp = Number(settings.gstBp ?? 800);
  const items = cart.map((item) => ({
    pid: String(item.pid || item.id || item.productId),
    name: item.name || "Item",
    emoji: item.emoji || "",
    price: money(item.price),
    cost: money(item.cost),
    unit: item.unit || "pcs",
    vendor: !!item.vendor,
    qty: Math.max(1, Number(item.qty || 1)),
    discPct: Number(item.discPct || 0)
  }));

  const subtotal = items.reduce((sum, item) => sum + lineTotal(item), 0);
  const tax = Math.round(subtotal * gstBp / 10000);
  const total = subtotal + tax;

  const order = {
    id: orderId,
    storeId: selectedStore,
    no: makeLocalOrderNumber(register, selectedStore),
    localNo: true,
    table,
    items,
    status: "new",
    createdAt: now,
    businessDate: new Date(now).toISOString().slice(0, 10),
    source: "pos",
    otype: orderType,
    covers: 1,
    customerId: customer?.id ? String(customer.id) : null,
    customerName: customer?.name || null,
    note: String(note || "").slice(0, 200),
    subtotal,
    tax,
    total,
    synced: false
  };

  const paymentRows = payments.map((payment) => ({
    id: uuid(),
    storeId: selectedStore,
    orderId,
    method: payment.method || "cash",
    amount: money(payment.amount),
    createdAt: now,
    synced: false
  }));

  await db.transaction("rw", db.orders, db.payments, db.products, db.customers, db.syncQueue, async () => {
    await db.orders.put(order);
    for (const payment of paymentRows) await db.payments.put(payment);

    await enqueuePut("orders", order.id, order, selectedStore);
    for (const payment of paymentRows) await enqueuePut("payments", payment.id, payment, selectedStore);

    for (const item of items) {
      if (!item.pid) continue;
      const current = await db.products.get(item.pid);
      if (current) await db.products.update(item.pid, { stock: Number(current.stock || 0) - item.qty, storeId: current.storeId || selectedStore, updatedAt: now });
      await enqueueStockDelta(item.pid, -item.qty, selectedStore);
    }

    if (order.customerId) {
      const earnedPoints = Math.floor(total / 100);
      const currentCustomer = await db.customers.get(order.customerId);
      if (currentCustomer) {
        await db.customers.update(order.customerId, {
          points: Number(currentCustomer.points || 0) + earnedPoints,
          updatedAt: now
        });
      }
      if (earnedPoints) await enqueueCustomerDelta(order.customerId, { points: earnedPoints }, selectedStore);
    }
  });

  if (navigator.onLine) syncNow().catch(console.warn);

  return { order, payments: paymentRows };
}
