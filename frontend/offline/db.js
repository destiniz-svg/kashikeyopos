/* Local-first IndexedDB schema for the POS frontend.
   Install Dexie in the real frontend source package: npm i dexie */
import Dexie from "dexie";

export const db = new Dexie("kashikeyo-pos-offline");

db.version(1).stores({
  products: "id, cat, updatedAt, rowver",
  customers: "id, name, phone, updatedAt, rowver",
  orders: "id, no, status, createdAt, businessDate, synced, rowver",
  payments: "id, orderId, method, createdAt, synced",
  tables: "id, name, zoneId, rowver",
  zones: "id, name, rowver",
  settings: "id, rowver",
  syncQueue: "opId, status, createdAt, entityKind, entityId",
  syncState: "key",
  auth: "key"
});

export const uuid = () => crypto.randomUUID();

export async function getCloudSession() {
  return db.auth.get("cloud");
}

export async function saveCloudSession(session) {
  return db.auth.put({
    key: "cloud",
    serverUrl: session.serverUrl || "",
    token: session.token || "",
    slug: session.slug || "",
    register: session.register || "R1",
    savedAt: Date.now()
  });
}

export async function getPullCursor() {
  const state = await db.syncState.get("pull");
  return Number(state?.rowver || 0);
}

export async function setPullCursor(rowver) {
  return db.syncState.put({ key: "pull", rowver: Number(rowver || 0), updatedAt: Date.now() });
}
