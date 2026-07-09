/* Local-first IndexedDB schema for the POS frontend.
   Install Dexie in the real frontend source package: npm i dexie */
import Dexie from "dexie";

export const DEFAULT_STORE_ID = "main";
export const db = new Dexie("kashikeyo-pos-offline");

db.version(2).stores({
  products: "id, storeId, cat, updatedAt, rowver",
  customers: "id, name, phone, updatedAt, rowver",
  orders: "id, storeId, no, status, createdAt, businessDate, synced, rowver",
  payments: "id, storeId, orderId, method, createdAt, synced",
  tables: "id, storeId, name, zoneId, rowver",
  zones: "id, storeId, name, rowver",
  stores: "id, code, name, active",
  settings: "id, storeId, rowver",
  syncQueue: "opId, storeId, status, createdAt, entityKind, entityId",
  syncState: "key",
  auth: "key"
});

export const uuid = () => crypto.randomUUID();
export const cleanStoreId = (value) => String(value || DEFAULT_STORE_ID).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || DEFAULT_STORE_ID;

export async function getCloudSession() {
  const session = await db.auth.get("cloud");
  return session ? { ...session, storeId: cleanStoreId(session.storeId) } : session;
}

export async function saveCloudSession(session) {
  return db.auth.put({
    key: "cloud",
    serverUrl: session.serverUrl || "",
    token: session.token || "",
    slug: session.slug || "",
    register: session.register || "R1",
    storeId: cleanStoreId(session.storeId),
    savedAt: Date.now()
  });
}

export async function getSelectedStoreId() {
  const session = await getCloudSession();
  return cleanStoreId(session?.storeId);
}

export async function getPullCursor(storeId = DEFAULT_STORE_ID) {
  const key = `pull:${cleanStoreId(storeId)}`;
  const state = await db.syncState.get(key);
  return Number(state?.rowver || 0);
}

export async function setPullCursor(rowver, storeId = DEFAULT_STORE_ID) {
  return db.syncState.put({ key: `pull:${cleanStoreId(storeId)}`, storeId: cleanStoreId(storeId), rowver: Number(rowver || 0), updatedAt: Date.now() });
}
