import { cleanStoreId, db, getSelectedStoreId, uuid } from "./db.js";

export async function enqueueOp({ puts = [], dels = [], deltas = {}, entityKind = "mixed", entityId = "", storeId }) {
  const selectedStore = cleanStoreId(storeId || await getSelectedStoreId());
  const op = {
    opId: uuid(),
    storeId: selectedStore,
    status: "pending",
    createdAt: Date.now(),
    entityKind,
    entityId: String(entityId || ""),
    puts: puts.map((p) => ({ ...p, storeId: p.storeId || selectedStore, data: p.data ? { ...p.data, storeId: p.data.storeId || selectedStore } : p.data })),
    dels: dels.map((d) => ({ ...d, storeId: d.storeId || selectedStore })),
    deltas,
    attempts: 0,
    lastError: ""
  };

  await db.syncQueue.put(op);
  return op;
}

export function enqueuePut(kind, id, data, storeId) {
  return enqueueOp({
    storeId,
    entityKind: kind,
    entityId: id,
    puts: [{ kind, id: String(id), data }]
  });
}

export function enqueueDelete(kind, id, storeId) {
  return enqueueOp({
    storeId,
    entityKind: kind,
    entityId: id,
    dels: [{ kind, id: String(id) }]
  });
}

export function enqueueStockDelta(productId, delta, storeId) {
  return enqueueOp({
    storeId,
    entityKind: "products",
    entityId: productId,
    deltas: { stock: [{ id: String(productId), d: Number(delta) || 0 }] }
  });
}

export function enqueueCustomerDelta(customerId, { points = 0, balance = 0 }, storeId) {
  return enqueueOp({
    storeId,
    entityKind: "customers",
    entityId: customerId,
    deltas: { cust: [{ id: String(customerId), pts: Number(points) || 0, bal: Number(balance) || 0 }] }
  });
}

export async function markOpsSynced(ops) {
  await db.transaction("rw", db.syncQueue, async () => {
    for (const op of ops) await db.syncQueue.update(op.opId, { status: "synced", syncedAt: Date.now(), lastError: "" });
  });
}

export async function markOpsFailed(ops, error) {
  const message = error?.message || String(error || "sync failed");
  await db.transaction("rw", db.syncQueue, async () => {
    for (const op of ops) {
      await db.syncQueue.update(op.opId, {
        status: "pending",
        attempts: Number(op.attempts || 0) + 1,
        lastError: message,
        lastAttemptAt: Date.now()
      });
    }
  });
}
