/* v2-offline-cache — client-side snapshot of window.KPOS_REAL for offline reboot.
 *
 * /v2's HTML bakes real per-org data (menu, staff, tax, outlets...) into the page
 * at request time, unlike /app's static-shell + client-fetch model — so a plain
 * service-worker cache of the HTML would either go stale/leak a wrong-store copy,
 * or, stripped of that data, boot with nothing and silently fall back to the demo
 * dishes. This banks a copy of KPOS_REAL in IndexedDB on every successful online
 * load, so a cold reload with no network can rebuild the terminal from the last
 * real data it saw instead of showing fake menu items to a live cashier.
 *
 * No PIN hashes are involved — the server already omits `pin` from the injected
 * staff roster (see buildV2RealForOrg in index.js: "the roster carries no `pin`
 * field"), so caching KPOS_REAL wholesale adds no exposure beyond what the client
 * already received on the original online visit. A separate database from
 * v2-bridge.js's outbox (kpos-v2), so this cache can never collide with or block
 * that money-critical write queue.
 */
(function () {
  var DB_NAME = "kpos-v2-cache", STORE = "snapshot", VERSION = 1, KEY = "kpos_real";

  function openDB() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error("no indexedDB"));
      var rq = indexedDB.open(DB_NAME, VERSION);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { reject(rq.error); };
    });
  }

  // Best-effort, fire-and-forget: a cache write must never block or fail boot.
  function save(real) {
    if (!real) return Promise.resolve();
    var body;
    try { body = JSON.parse(JSON.stringify(real)); } catch (e) { return Promise.resolve(); }
    body.cachedAt = Date.now();
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        var t;
        try { t = db.transaction(STORE, "readwrite"); } catch (e) { resolve(); return; }
        t.objectStore(STORE).put(body, KEY);
        t.oncomplete = function () { resolve(); };
        t.onerror = function () { resolve(); };
        t.onabort = function () { resolve(); };
      });
    }).catch(function () {});
  }

  function load() {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        var t;
        try { t = db.transaction(STORE, "readonly"); } catch (e) { resolve(null); return; }
        var rq = t.objectStore(STORE).get(KEY);
        rq.onsuccess = function () { resolve(rq.result || null); };
        rq.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  // One-time migration for a device that used to run the OLD /app register
  // (before /app started serving this terminal): that build kept its own
  // durable outbox in localStorage (key "kashikeyo_outbox", flushed by a
  // server-injected script — see OUTBOX_JS in index.js), completely separate
  // from this terminal's own IndexedDB outbox (v2-bridge.js). That old flush
  // logic never runs again once this page's markup loads instead, so a sale
  // still queued there at the moment of the cutover would otherwise sync
  // nowhere — the cashier already took the money, with no path to record it.
  // Replays each queued op through the SAME idempotent /api/ops endpoint
  // (deduped by opId), so this can never double-book a sale even if it runs
  // more than once (e.g. a second tab, or a retry after a partial failure).
  function migrateLegacyOutbox(token) {
    if (!token) return Promise.resolve();
    var raw;
    try { raw = localStorage.getItem("kashikeyo_outbox"); } catch (e) { return Promise.resolve(); }
    if (!raw) return Promise.resolve();
    var items;
    try { items = JSON.parse(raw); } catch (e) { return Promise.resolve(); }
    if (!Array.isArray(items) || !items.length) {
      try { localStorage.removeItem("kashikeyo_outbox"); } catch (e) {}
      return Promise.resolve();
    }
    var remaining = items.slice();
    var chain = Promise.resolve();
    items.forEach(function (item) {
      chain = chain.then(function () {
        if (!item || !item.body) { remaining = remaining.filter(function (x) { return x !== item; }); return; }
        var headers = { "Content-Type": "application/json", "Authorization": "Bearer " + token };
        if (item.headers) for (var k in item.headers) headers[k] = item.headers[k];
        return fetch("/api/ops", { method: "POST", headers: headers, body: JSON.stringify(item.body) })
          .then(function (r) { if (r.ok) remaining = remaining.filter(function (x) { return x !== item; }); })
          .catch(function () { /* still offline or a fresh failure — leave it queued, retried on the next boot */ });
      });
    });
    return chain.then(function () {
      try {
        if (remaining.length) localStorage.setItem("kashikeyo_outbox", JSON.stringify(remaining));
        else localStorage.removeItem("kashikeyo_outbox");
      } catch (e) {}
    });
  }

  window.__v2Cache = { save: save, load: load, migrateLegacyOutbox: migrateLegacyOutbox };
})();
