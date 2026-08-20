/* ═══ KASHIKEYO CLIENT ══════════════════════════════════════════════════════
   The seam between the terminals and the cloud. Offline is the normal case, so
   this is written the other way round from most API clients: the local cache
   is the source of truth the UI reads, and the network is a mirror that
   catches up.

   Four rules it enforces on behalf of the front ends:

   1. Every read and write is scoped to ONE outlet. The outlet id is inside the
      session token, is re-sent in the path, and the server refuses a mismatch
      — so a client bug cannot ask for a site it is not signed in to.
   2. Every write carries an opId generated here, locally, BEFORE the network
      is touched. A reconnect replays the outbox; the server's primary key on
      opId makes the second attempt a no-op instead of a second sale.
   3. The outbox is durable. It lives in IndexedDB, not localStorage: a till
      that crashes mid-service with a sale in a volatile queue has lost money,
      not a request.
   4. Cache keys are namespaced per outlet. Switching sites on a shared
      terminal cannot surface the previous site's tickets, even offline.
   ═══════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";

  var TOKEN_KEY = "kashikeyo.token";
  var DB_NAME = "kashikeyo", STORE = "outbox", DB_VERSION = 1;
  var has = typeof localStorage !== "undefined";

  function uuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (typeof crypto !== "undefined" && crypto.getRandomValues)
        ? crypto.getRandomValues(new Uint8Array(1))[0] % 16
        : Math.floor(Math.random() * 16);
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /* ── the durable outbox ───────────────────────────────────────────────── */
  function openDB() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === "undefined") return reject(new Error("no indexedDB"));
      var rq = indexedDB.open(DB_NAME, DB_VERSION);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: "opId" });
          os.createIndex("outlet", "outletId", { unique: false });
          os.createIndex("lamport", "lamport", { unique: false });
        }
      };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { reject(rq.error); };
    });
  }

  function tx(db, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(STORE, mode), os = t.objectStore(STORE), out;
      Promise.resolve(fn(os)).then(function (r) { out = r; });
      t.oncomplete = function () { resolve(out); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error); };
    });
  }

  class KashikeyoAPI {
    constructor(opts) {
      var o = opts || {};
      this.baseUrl = (o.baseUrl || "").replace(/\/$/, "");
      this.outletId = o.outletId || null;
      this.token = null;
      this.rank = 0;
      this.name = "";
      this.roleKey = "";
      this.staffId = null;
      this.deviceId = o.deviceId || (has ? localStorage.getItem("kashikeyo.device") : null);
      this.pollMs = o.pollMs || 5000;
      this._db = null;
      this._subs = [];
      this._timer = null;
      this._flushing = false;
      this._since = 0;
      this._online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
      this._restoreToken();
      if (typeof window !== "undefined") {
        window.addEventListener("online", () => { this._online = true; this.flush(); });
        window.addEventListener("offline", () => { this._online = false; });
        // A tab coming back to the foreground is the commonest moment a queue
        // has something to say, and the commonest moment nobody drains it.
        document.addEventListener("visibilitychange", () => {
          if (!document.hidden) this.flush();
        });
      }
    }

    db() {
      if (!this._db) this._db = openDB();
      return this._db;
    }

    /* ── local, outlet-namespaced storage ───────────────────────────────── */
    key(name) {
      if (!this.outletId) throw new Error("no outlet selected");
      return "kashikeyo.o" + this.outletId + "." + name;
    }
    local(name, value) {
      if (!has || !this.outletId) return value === undefined ? null : value;
      if (value === undefined) {
        try { return JSON.parse(localStorage.getItem(this.key(name)) || "null"); }
        catch (e) { return null; }
      }
      try { localStorage.setItem(this.key(name), JSON.stringify(value)); }
      catch (e) { /* a full quota is not a reason to stop selling */ }
      return value;
    }

    /* ── identity ──────────────────────────────────────────────────────── */
    _restoreToken() {
      if (!has) return;
      try {
        var t = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
        if (t && t.exp > Date.now()) {
          this.token = t.token; this.outletId = t.outletId;
          this.rank = t.rank; this.name = t.name; this.roleKey = t.roleKey;
          this.staffId = t.staffId;
        }
      } catch (e) { /* a corrupt token is no token */ }
    }
    _keepToken(r) {
      this.token = r.token; this.outletId = r.outletId; this.rank = r.rank;
      this.name = r.name; this.roleKey = r.roleKey; this.staffId = r.staffId;
      if (has) {
        localStorage.setItem(TOKEN_KEY, JSON.stringify({
          token: r.token, outletId: r.outletId, rank: r.rank, name: r.name,
          roleKey: r.roleKey, staffId: r.staffId,
          exp: r.expiresAt || (Date.now() + 11 * 3600e3)
        }));
      }
    }

    install() { return this._fetch("/api/auth/install", { anon: true }); }

    async signIn(opts) {
      var r = await this._fetch("/api/auth/pin", {
        method: "POST", anon: true,
        body: { outletId: opts.outletId, pin: opts.pin, deviceId: opts.deviceId || this.deviceId }
      });
      this._keepToken(r);
      this.flush();
      return r;
    }

    // Handing over the terminal: a second PIN swaps the actor without closing
    // the shift, so every subsequent action is attributable to the new person.
    async handOver(pin) {
      var r = await this._fetch("/api/auth/switch", {
        method: "POST", body: { pin: pin, deviceId: this.deviceId }
      });
      this._keepToken(r);
      return r;
    }

    signOut() {
      var was = this.token;
      this.token = null; this.rank = 0; this.name = ""; this.staffId = null;
      if (has) localStorage.removeItem(TOKEN_KEY);
      this.stop();
      if (was) {
        // Best effort: the session row is revoked server-side so the token
        // cannot be replayed from a copy of localStorage.
        fetch(this.baseUrl + "/api/auth/signout", {
          method: "POST", headers: { authorization: "Bearer " + was }
        }).catch(function () {});
      }
    }

    // The one gate the whole system uses. Kitchen 1, Till 2, Manager 3,
    // Admin 4, Owner 5 — never a name, never a title.
    canApprove(need) { return this.rank >= (need || 3); }
    canReceive() { return this.rank >= 3; }
    signedIn() { return !!this.token; }

    /* ── everything the terminal needs to come up ───────────────────────── */
    async bootstrap(days) {
      if (!this.outletId || !this.token) return null;
      if (!this._online) return this.local("bootstrap");
      try {
        var b = await this._fetch("/api/outlet/" + this.outletId + "/bootstrap"
          + (days ? "?days=" + days : ""));
        this.local("bootstrap", b);
        return b;
      } catch (e) {
        // A failed boot is not an error condition when a cache exists: it is
        // Tuesday. Serve the cache and let the floor carry on.
        return this.local("bootstrap");
      }
    }

    /* ── the tick ──────────────────────────────────────────────────────── */
    async pull() {
      if (!this.outletId || !this.token || !this._online) return null;
      try {
        var out = await this._fetch("/api/outlet/" + this.outletId + "/sync/pull?since="
          + encodeURIComponent(this._since || 0));
        this._since = out.now;
        return out;
      } catch (e) { return null; }
    }

    onTick(fn) {
      this._subs.push(fn);
      if (!this._timer) {
        var tick = async () => {
          var s = await this.pull();
          if (s) this._subs.forEach(function (f) { try { f(s); } catch (e) {} });
          this._timer = setTimeout(tick, this.pollMs);
        };
        tick();
      }
      return () => { this._subs = this._subs.filter(function (f) { return f !== fn; }); };
    }
    stop() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }

    /* ── writes: durable first, network second ─────────────────────────── */
    async queue(op) {
      var row = {
        opId: op.opId || uuid(),
        outletId: this.outletId,
        kind: op.kind, label: op.label || "", entity: op.entity || "",
        payload: op.payload || {},
        lamport: op.lamport || Date.now(),
        at: op.at || Date.now(),
        attempts: 0, error: ""
      };
      try {
        var db = await this.db();
        await tx(db, "readwrite", function (os) { os.put(row); });
      } catch (e) {
        // No IndexedDB is a browser we cannot promise durability on. Say so
        // rather than pretending the sale is safe.
        try { console.error("[kpos] durable outbox unavailable:", e.message); } catch (e2) {}
      }
      this.flush();
      return row.opId;
    }

    async pending() {
      try {
        var db = await this.db();
        return await tx(db, "readonly", function (os) {
          return new Promise(function (res) {
            var q = os.getAll();
            q.onsuccess = function () { res(q.result || []); };
          });
        });
      } catch (e) { return []; }
    }

    async flush() {
      if (this._flushing || !this._online || !this.token || !this.outletId) return null;
      if (root.__kposForceOffline === true) return null;
      var ops = await this.pending();
      ops = ops.filter((o) => o.outletId === this.outletId)
        .sort(function (a, b) { return (a.lamport || 0) - (b.lamport || 0); });
      if (!ops.length) return null;
      this._flushing = true;
      try {
        var r = await this._fetch("/api/outlet/" + this.outletId + "/sync/push", {
          method: "POST",
          body: { ops: ops.slice(0, 100).map(function (o) {
            return { opId: o.opId, kind: o.kind, label: o.label, entity: o.entity,
              payload: o.payload, lamport: o.lamport, at: o.at };
          }) }
        });
        var db = await this.db();
        var failed = [];
        for (const x of (r.results || [])) {
          if (x.error) { failed.push(x); continue; }
          // Only ops the server acknowledged leave the outbox. An op that
          // errored stays put and is visible to the operator rather than
          // silently lost.
          await tx(db, "readwrite", function (os) { os.delete(x.opId); });
        }
        if (failed.length) {
          this.local("syncErrors", failed);
          for (const f of failed) {
            const row = ops.filter((o) => o.opId === f.opId)[0];
            if (!row) continue;
            row.attempts = (row.attempts || 0) + 1;
            row.error = f.error;
            await tx(db, "readwrite", function (os) { os.put(row); });
          }
          try { root.dispatchEvent(new CustomEvent("kpos-sync-error", { detail: failed })); }
          catch (e) {}
        }
        try { root.dispatchEvent(new CustomEvent("kpos-sync-done", { detail: r.results || [] })); }
        catch (e) {}
        return r.results;
      } catch (e) {
        return null;   // stays queued
      } finally {
        this._flushing = false;
        var left = await this.pending();
        if (left.length && this._online) setTimeout(() => this.flush(), 5000);
      }
    }

    /* ── the only cross-outlet read, and it is aggregates ───────────────── */
    estateDay(date) {
      if (this.rank < 5) return Promise.reject(new Error("rank 5 required"));
      return this._fetch("/api/estate/day?date=" + encodeURIComponent(date || "")
        + "&scope=group");
    }

    /* ── plain calls the terminal makes outside the op queue ────────────── */
    devices() { return this._fetch("/api/auth/devices"); }
    registerDevice(label, kind, station) {
      return this._fetch("/api/auth/devices", { method: "POST", body: { label, kind, station } });
    }
    staff() { return this._fetch("/api/auth/staff"); }
    addStaff(body) { return this._fetch("/api/auth/staff", { method: "POST", body }); }
    editStaff(id, body) { return this._fetch("/api/auth/staff/" + id, { method: "PATCH", body }); }
    audit(limit) { return this._fetch("/api/outlet/" + this.outletId + "/audit?limit=" + (limit || 200)); }
    sales(q) {
      var p = new URLSearchParams(q || {});
      return this._fetch("/api/outlet/" + this.outletId + "/sales?" + p.toString());
    }
    onboarding() { return this._fetch("/api/onboarding/state", { anon: !this.token }); }
    onboard(step, body) {
      return this._fetch("/api/onboarding/" + step, { method: "POST", body, anon: !this.token });
    }

    async _fetch(path, opts) {
      var o = opts || {};
      var headers = { "content-type": "application/json" };
      if (this.token && !o.anon) headers.authorization = "Bearer " + this.token;
      var res = await fetch(this.baseUrl + path, {
        method: o.method || "GET",
        headers: headers,
        body: o.body ? JSON.stringify(o.body) : undefined
      });
      if (res.status === 401 && !o.anon) {
        this.signOut();
        try { root.dispatchEvent(new Event("kpos-session-expired")); } catch (e) {}
        throw new Error("session expired");
      }
      var text = await res.text();
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
      if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
      return data;
    }
  }

  root.KashikeyoAPI = KashikeyoAPI;
  if (typeof module !== "undefined" && module.exports) module.exports = { KashikeyoAPI };
})(typeof window !== "undefined" ? window : globalThis);
