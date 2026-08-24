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
        /* WHICH DATABASE IS THIS? Outlet ids repeat across installs —
           staging's outlet 1 and production's outlet 1 are both "1" — and
           this outbox keys its rows by that number. The install's uuid is
           what tells them apart. A CHANGE of install on the same origin and
           outlet id is exactly the accident that once replayed demo data
           into a real store, so it is announced, and flush() parks every op
           the old install queued. */
        var inst = ((b && b.kpos) || {}).INSTALL || "";
        if (inst) {
          var prev = this.local("install");
          this.install = inst;
          this.local("install", inst);
          if (prev && prev !== inst) {
            try {
              root.dispatchEvent(new CustomEvent("kpos-install-changed",
                { detail: { from: prev, to: inst } }));
            } catch (e2) {}
          }
        }
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
        install: this.install || this.local("install") || "",
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

    /* The ops the replay has given up on, with the server's reason. */
    async parked() {
      var all = await this.pending();
      var oid = this.outletId;
      return all.filter(function (o) { return o.parked && o.outletId === oid; });
    }

    /* Back into the replay, with a fresh allowance — for after whatever
       refused it has been fixed. */
    async retryOp(opId) {
      try {
        var db = await this.db();
        var rows = await this.pending();
        var row = rows.filter(function (o) { return o.opId === opId; })[0];
        if (!row) return false;
        delete row.parked;
        row.attempts = 0;
        // An operator sending a parked op again is adopting it into THIS
        // install — that decision is exactly what the park was waiting for.
        row.install = this.install || this.local("install") || row.install || "";
        await tx(db, "readwrite", function (os) { os.put(row); });
      } catch (e) { return false; }
      this.flush();
      return true;
    }

    /* Discarding is a decision, so it leaves a record: the op is deleted
       from the outbox and an audit op naming exactly what was given up — and
       by whom — takes its place in the replay. */
    async discardOp(opId, by) {
      var row;
      try {
        var db = await this.db();
        var rows = await this.pending();
        row = rows.filter(function (o) { return o.opId === opId; })[0];
        if (!row) return false;
        await tx(db, "readwrite", function (os) { os.delete(opId); });
      } catch (e) { return false; }
      await this.queue({
        kind: "op_discarded",
        label: (row.kind || "op") + " discarded after " + (row.attempts || 0)
          + " refusals" + (by ? " · by " + by : "") + " · " + (row.error || "no reason recorded"),
        entity: "sync",
        payload: { of: row.opId, kind: row.kind, label: row.label,
          error: row.error || "", attempts: row.attempts || 0, by: by || "" }
      });
      return true;
    }

    /* ── the dead-letter lane ──────────────────────────────────────────
       A server REFUSAL is not a network failure: the outlet answered and
       said no. Retrying it every five seconds forever is how one poison op
       used to keep a till's outbox hot for the life of the device. So a
       refusal is counted, and on the eighth the op is PARKED — still
       durable, still visible with the server's reason, but out of the
       replay. A parked op is an operator's decision now: send it again
       after the cause is fixed, or discard it, which writes an audit op
       naming what was given up. Network failures never count — a dead link
       says nothing about the op. */
    async flush() {
      if (this._flushing || !this._online || !this.token || !this.outletId) return null;
      if (root.__kposForceOffline === true) return null;
      var ops = await this.pending();
      /* ANOTHER INSTALL'S OPS NEVER REPLAY HERE. An op stamped with a
         different install id — or with none, from before installs had names
         — was queued against a different database that happens to share this
         outlet's number. Pushing it would file one store's demo night into
         another store's books, so it PARKS instead: durable, visible with
         the reason, and "Send it again" adopts it into this install only
         because a person decided that. */
      var inst = this.install || this.local("install") || "";
      if (inst) {
        var strangers = ops.filter((o) => o.outletId === this.outletId
          && !o.parked && (o.install || "") !== inst);
        if (strangers.length) {
          var db0 = await this.db();
          var parkedNow = [];
          for (const row of strangers) {
            row.parked = Date.now();
            row.error = row.install
              ? "queued against a different install of this outlet"
              : "queued before this terminal knew which install it serves";
            parkedNow.push({ opId: row.opId, kind: row.kind, label: row.label,
              error: row.error, attempts: row.attempts || 0 });
            await tx(db0, "readwrite", function (os) { os.put(row); });
          }
          try { root.dispatchEvent(new CustomEvent("kpos-op-parked", { detail: parkedNow })); }
          catch (e) {}
        }
      }
      ops = ops.filter((o) => o.outletId === this.outletId && !o.parked
        && (!inst || (o.install || "") === inst))
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
          var parkedNow = [];
          for (const f of failed) {
            const row = ops.filter((o) => o.opId === f.opId)[0];
            if (!row) continue;
            row.attempts = (row.attempts || 0) + 1;
            row.error = f.error;
            if (row.attempts >= KashikeyoAPI.DEAD_TRIES) {
              row.parked = Date.now();
              parkedNow.push({ opId: row.opId, kind: row.kind, label: row.label,
                error: row.error, attempts: row.attempts });
            }
            await tx(db, "readwrite", function (os) { os.put(row); });
          }
          try { root.dispatchEvent(new CustomEvent("kpos-sync-error", { detail: failed })); }
          catch (e) {}
          if (parkedNow.length) {
            try { root.dispatchEvent(new CustomEvent("kpos-op-parked", { detail: parkedNow })); }
            catch (e) {}
          }
        }
        try { root.dispatchEvent(new CustomEvent("kpos-sync-done", { detail: r.results || [] })); }
        catch (e) {}
        return r.results;
      } catch (e) {
        return null;   // stays queued
      } finally {
        this._flushing = false;
        var left = (await this.pending()).filter(function (o) { return !o.parked; });
        if (left.length && this._online) setTimeout(() => this.flush(), 5000);
      }
    }

    /* ── the LAN print relay ────────────────────────────────────────────
       The till cannot open a TCP socket, so an Ethernet printer is reached
       through the server — which is only real when the server shares the
       printer's network. The server enforces that honestly; this just
       carries the bytes. */
    print(host, b64) {
      return this._fetch("/api/outlet/" + this.outletId + "/print", {
        method: "POST", body: { host: host, data: b64 }
      });
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
    /* The store's public address. Not an outbox op: a rename is refused by
       name when somebody else holds the address, and a refusal that arrives
       three hours later through a replay queue is a refusal nobody sees. */
    handle(want) {
      return this._fetch("/api/outlet/" + this.outletId + "/handle"
        + (want ? "?h=" + encodeURIComponent(want) : ""));
    }
    rename(handle) {
      return this._fetch("/api/outlet/" + this.outletId + "/handle",
        { method: "PATCH", body: { handle: handle } });
    }
    /* Inviting a customer to their own portal, on a named channel. Not an
       outbox op: a sign-in code lives ten minutes, and one replayed later is
       a code nobody can use. The answer carries the address the SERVER
       spelled, because only the server knows where the base domain ends, and
       whether anything was actually SENT — never a guess. */
    inviteMember(id, via, to) {
      return this._fetch("/api/outlet/" + this.outletId + "/member/"
        + encodeURIComponent(id) + "/invite",
        { method: "POST", body: { via: via || "email", to: to || null } });
    }
    /* Taking it back. The history stays: the row reads Revoked, never Not
       invited. Rank 3 — the server refuses a cashier. */
    revokeMember(id) {
      return this._fetch("/api/outlet/" + this.outletId + "/member/"
        + encodeURIComponent(id) + "/revoke", { method: "POST", body: {} });
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
  // Eight refusals ≈ forty seconds of the outlet saying no. A transient
  // ordering problem (a line before its ticket) resolves well inside that; a
  // payload the server will never accept does not, and holding the whole
  // outbox hot for it is the failure this lane exists to end.
  KashikeyoAPI.DEAD_TRIES = 8;

  if (typeof module !== "undefined" && module.exports) module.exports = { KashikeyoAPI };
})(typeof window !== "undefined" ? window : globalThis);
