import { db, uuid } from "./db.js";

export async function enqueueOp({ puts = [], dels = [], deltas = {}, entityKind = "mixed", entityId = "" }) {
  const op = {
    opId: uuid(),
    status: "pending",
    createdAt: Date.now(),
    entityKind,
    entityId: String(entityId || ""),
    puts,
    dels,
    deltas,
    attempts: 0,
    lastError: ""
  };

  await db.syncQueue.put(op);
  return op;
}

export function enqueuePut(kind, id, data) {
  return enqueueOp({
    entityKind: kind,
    entityId: id,
    puts: [{ kind, id: String(id), data }]
  });
}

export function enqueueDelete(kind, id) {
  return enqueueOp({
    entityKind: kind,
    entityId: id,
    dels: [{ kind, id: String(id) }]
  });
}

export function enqueueStockDelta(productId, delta) {
  return enqueueOp({
    entityKind: "products",
    entityId: productId,
    deltas: { stock: [{ id: String(productId), d: Number(delta) || 0 }] }
  });
}

export function enqueueCustomerDelta(customerId, { points = 0, balance = 0 }) {
  return enqueueOp({
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
