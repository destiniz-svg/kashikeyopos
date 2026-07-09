import { db, getCloudSession, getPullCursor, setPullCursor } from "./db.js";
import { markOpsFailed, markOpsSynced } from "./syncQueue.js";

const KIND_TABLES = {
  products: db.products,
  customers: db.customers,
  orders: db.orders,
  payments: db.payments,
  tables: db.tables,
  zones: db.zones,
  settings: db.settings
};

let syncing = false;

function apiBase(session) {
  return (session.serverUrl || "").replace(/\/+$/, "");
}

function authHeaders(session) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.token}`
  };
}

export async function pushPendingOps(session) {
  const pending = await db.syncQueue
    .where("status")
    .equals("pending")
    .sortBy("createdAt");

  if (!pending.length) return { pushed: 0 };

  const res = await fetch(`${apiBase(session)}/api/ops`, {
    method: "POST",
    headers: authHeaders(session),
    body: JSON.stringify({ ops: pending })
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || "push failed");
    await markOpsFailed(pending, err);
    throw err;
  }

  await markOpsSynced(pending);
  return { pushed: pending.length, rowver: body.rowver || 0 };
}

export async function pullRemoteChanges(session) {
  const since = await getPullCursor();
  const res = await fetch(`${apiBase(session)}/api/pull?since=${since}`, {
    headers: { Authorization: `Bearer ${session.token}` }
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "pull failed");

  await db.transaction("rw", Object.values(KIND_TABLES).concat(db.syncState), async () => {
    for (const entity of body.entities || []) {
      const table = KIND_TABLES[entity.kind];
      if (!table) continue;
      if (entity.deleted) await table.delete(String(entity.id));
      else await table.put({ ...entity.data, id: String(entity.id), rowver: entity.rowver, synced: true });
    }
    await setPullCursor(body.rowver || since);
  });

  return { pulled: (body.entities || []).length, rowver: body.rowver || since, more: !!body.more };
}

export async function syncNow() {
  if (syncing) return { ok: false, reason: "already_syncing" };
  const session = await getCloudSession();
  if (!session?.token || !session?.serverUrl) return { ok: false, reason: "not_paired" };
  if (!navigator.onLine) return { ok: false, reason: "offline" };

  syncing = true;
  try {
    const push = await pushPendingOps(session);
    let pull = await pullRemoteChanges(session);
    while (pull.more) pull = await pullRemoteChanges(session);
    return { ok: true, push, pull };
  } finally {
    syncing = false;
  }
}

export function startSyncLoop({ intervalMs = 15000 } = {}) {
  window.addEventListener("online", () => syncNow().catch(console.warn));
  const timer = setInterval(() => {
    if (navigator.onLine) syncNow().catch(console.warn);
  }, intervalMs);
  return () => clearInterval(timer);
}
