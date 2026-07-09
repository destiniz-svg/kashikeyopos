/* KashikeyoPOS offline bridge.
   Works with the prebuilt POS bundle by intercepting existing fetch writes.
   Source-level modules live under /frontend; this bridge wires the deployed
   minified shell into the same local-first behavior without a rebuild. */
(() => {
  const DB_NAME = "kashikeyo-pos-offline-bridge";
  const DB_VERSION = 1;
  const STORE = "queuedWrites";
  const WRITE_PATH = /^(\/api\/ops|\/p\/[^/]+\/(order|call))/;
  const originalFetch = window.fetch.bind(window);
  let replaying = false;

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("status", "status", { unique: false });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function tx(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      const result = fn(store);
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
    return { url, absolute, method, headers, body: init.body || null };
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
      no: `LOCAL-${String(now).slice(-6)}`,
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
      return new Response(JSON.stringify({ ok: true, queued: true, queuedId, order: localOrderFromBody(info) }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ ok: true, queued: true, queuedId, rowver: 0 }), {
      status: 202,
      headers: { "Content-Type": "application/json" }
    });
  }

  async function queueWrite(info, reason) {
    const item = {
      id: uuid(),
      url: info.url,
      method: info.method,
      headers: info.headers,
      body: info.body,
      status: "pending",
      attempts: 0,
      lastError: reason || "offline",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await tx("readwrite", (store) => store.put(item));
    window.dispatchEvent(new CustomEvent("kashikeyo:offline-queued", { detail: item }));
    return item;
  }

  async function getPending() {
    return tx("readonly", (store) => {
      const req = store.index("status").getAll("pending");
      return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result.sort((a, b) => a.createdAt - b.createdAt));
        req.onerror = () => reject(req.error);
      });
    });
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
          const res = await originalFetch(item.url, {
            method: item.method,
            headers: item.headers,
            body: item.body
          });
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
      const res = await originalFetch(input, init);
      if (res.ok || navigator.onLine) return res;
      const queued = await queueWrite(info, `HTTP ${res.status}`);
      return syntheticResponse(info, queued.id);
    } catch (err) {
      const queued = await queueWrite(info, err.message || String(err));
      return syntheticResponse(info, queued.id);
    }
  };

  window.KashikeyoOffline = {
    queueWrite,
    replayQueuedWrites,
    getPendingWrites: getPending
  };

  window.addEventListener("online", () => replayQueuedWrites());
  setInterval(() => replayQueuedWrites(), 15000);
  replayQueuedWrites();
})();
