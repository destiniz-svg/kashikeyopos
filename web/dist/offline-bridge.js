/* KashikeyoPOS offline bridge.
   Intercepts existing write fetches from the prebuilt POS shell, queues failed
   writes in IndexedDB, and replays them when online. */
(() => {
  const DB_NAME = "kashikeyo-pos-offline-bridge";
  const DB_VERSION = 2;
  const STORE = "queuedWrites";
  const WRITE_PATH = /^(\/api\/ops|\/p\/[^/]+\/(order|call))/;
  const originalFetch = window.fetch.bind(window);
  let replaying = false;

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const cleanStoreId = (v) => String(v || "main").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "main";

  function currentStoreId(url, headers, body) {
    let payload = {};
    try { payload = typeof body === "string" ? JSON.parse(body) : {}; } catch {}
    return cleanStoreId(
      payload.storeId ||
      new URL(url, location.href).searchParams.get("storeId") ||
      new URL(url, location.href).searchParams.get("store") ||
      new URL(url, location.href).searchParams.get("st") ||
      headers["x-store-id"] ||
      headers["X-Store-Id"] ||
      window.KashikeyoStoreId ||
      localStorage.getItem("kashikeyo.storeId") ||
      "main"
    );
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        let store;
        if (!db.objectStoreNames.contains(STORE)) store = db.createObjectStore(STORE, { keyPath: "id" });
        else store = req.transaction.objectStore(STORE);
        if (!store.indexNames.contains("status")) store.createIndex("status", "status", { unique: false });
        if (!store.indexNames.contains("createdAt")) store.createIndex("createdAt", "createdAt", { unique: false });
        if (!store.indexNames.contains("storeId")) store.createIndex("storeId", "storeId", { unique: false });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function tx(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const result = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  function requestInfo(input, init = {}) {
    const url = typeof input === "string" ? input : input.url;
    const absolute = new URL(url, location.href);
    const method = (init.method || (typeof input !== "string" && input.method) || "GET").toUpperCase();
    const headers = {};
    const sourceHeaders = new Headers(init.headers || (typeof input !== "string" ? input.headers : undefined));
    sourceHeaders.forEach((value, key) => { headers[key] = value; });
    const body = init.body || null;
    const storeId = currentStoreId(absolute.href, headers, body);
    headers["X-Store-Id"] = storeId;
    return { url, absolute, method, headers, body, storeId };
  }

  function isQueueableWrite(info) {
    return info.method !== "GET" && info.absolute.origin === location.origin && WRITE_PATH.test(info.absolute.pathname);
  }

  function localOrderFromBody(info) {
    let payload = {};
    try { payload = typeof info.body === "string" ? JSON.parse(info.body) : {}; } catch {}
    const now = Date.now();
    return {
      id: uuid(),
      storeId: info.storeId,
      no: `LOCAL-${info.storeId.toUpperCase()}-${String(now).slice(-6)}`,
      table: payload.table || "Queued",
      items: Array.isArray(payload.items) ? payload.items : [],
      status: "queued",
      createdAt: now,
      paidOnline: !!payload.payOnline,
      call: false,
      source: "offline-bridge",
      otype: payload.gtype === "delivery" ? "delivery" : payload.gtype === "pickup" ? "takeaway" : "dinein",
      customerId: payload.custId || null,
      customerName: null,
      zone: null,
      fee: 0,
      note: payload.note || ""
    };
  }

  function syntheticResponse(info, queuedId) {
    if (/\/p\/[^/]+\/order$/.test(info.absolute.pathname)) {
      return new Response(JSON.stringify({ ok: true, queued: true, queuedId, order: localOrderFromBody(info) }), { status: 202, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, queued: true, queuedId, storeId: info.storeId, rowver: 0 }), { status: 202, headers: { "Content-Type": "application/json" } });
  }

  async function queueWrite(info, reason) {
    const item = { id: uuid(), storeId: info.storeId, url: info.url, method: info.method, headers: info.headers, body: info.body, status: "pending", attempts: 0, lastError: reason || "offline", createdAt: Date.now(), updatedAt: Date.now() };
    await tx("readwrite", (store) => store.put(item));
    window.dispatchEvent(new CustomEvent("kashikeyo:offline-queued", { detail: item }));
    return item;
  }

  async function getPending() {
    return tx("readonly", (store) => new Promise((resolve, reject) => {
      const req = store.index("status").getAll("pending");
      req.onsuccess = () => resolve(req.result.sort((a, b) => a.createdAt - b.createdAt));
      req.onerror = () => reject(req.error);
    }));
  }

  async function updateQueued(item, patch) {
    await tx("readwrite", (store) => store.put({ ...item, ...patch, updatedAt: Date.now() }));
  }

  async function replayQueuedWrites() {
    if (replaying || !navigator.onLine) return;
    replaying = true;
    try {
      const pending = await getPending();
      for (const item of pending) {
        try {
          const res = await originalFetch(item.url, { method: item.method, headers: item.headers, body: item.body });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await updateQueued(item, { status: "synced", syncedAt: Date.now(), lastError: "" });
          window.dispatchEvent(new CustomEvent("kashikeyo:offline-synced", { detail: item }));
        } catch (err) {
          await updateQueued(item, { attempts: Number(item.attempts || 0) + 1, lastError: err.message || String(err) });
          break;
        }
      }
    } finally {
      replaying = false;
    }
  }

  window.fetch = async (input, init = {}) => {
    const info = requestInfo(input, init);
    if (!isQueueableWrite(info)) return originalFetch(input, init);
    try {
      const res = await originalFetch(input, { ...init, headers: info.headers });
      if (res.ok || navigator.onLine) return res;
      const queued = await queueWrite(info, `HTTP ${res.status}`);
      return syntheticResponse(info, queued.id);
    } catch (err) {
      const queued = await queueWrite(info, err.message || String(err));
      return syntheticResponse(info, queued.id);
    }
  };

  window.KashikeyoOffline = { queueWrite, replayQueuedWrites, getPendingWrites: getPending, setStoreId: (storeId) => { const s = cleanStoreId(storeId); window.KashikeyoStoreId = s; localStorage.setItem("kashikeyo.storeId", s); } };
  window.addEventListener("online", () => replayQueuedWrites());
  setInterval(() => replayQueuedWrites(), 15000);
  replayQueuedWrites();
})();
