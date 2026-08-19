/* ═══ KASHIKEYO CLIENT ══════════════════════════════════════════════════════
   The seam between the terminals and the cloud. Offline is the normal case, so
   this is written the other way round from most API clients: the local cache is
   the source of truth the UI reads, and the network is a mirror that catches up.

   Three rules it enforces on behalf of the front-ends:

   1. Every read and write is scoped to one outlet. The outlet id is part of the
      session token, is re-sent in the path, and the server refuses a mismatch —
      so a client bug cannot ask for a site it is not signed in to.
   2. Every write carries an opId generated here, locally, before the network is
      touched. A reconnect replays the outbox; the server's primary key on opId
      makes the second attempt a no-op instead of a second sale.
   3. Local cache keys are namespaced per outlet. Switching sites on a shared
      terminal cannot surface the previous site's tickets, even offline.

   Usage from a DC's logic class:

     const api = new KashikeyoAPI({ baseUrl: "https://api.kashikeyo.mv" });
     await api.signIn({ outletId: 3, pin: "4821", deviceId });
     api.onSnapshot((snap) => this.setState({ live: snap }));
     api.queue("sale", salePayload);        // returns immediately, syncs later
   ═══════════════════════════════════════════════════════════════════════════ */

(function (root) {
  "use strict";

  const TOKEN_KEY = "kashikeyo.token";
  const has = typeof localStorage !== "undefined";

  function uuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  class KashikeyoAPI {
    constructor(opts) {
      const o = opts || {};
      this.baseUrl = (o.baseUrl || "").replace(/\/$/, "");
      this.outletId = o.outletId || null;
      this.token = null;
      this.rank = 0;
      this.name = "";
      this.pollMs = o.pollMs || 4000;
      this._subs = [];
      this._timer = null;
      this._flushing = false;
      this._online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
      this._restoreToken();
      if (typeof window !== "undefined") {
        window.addEventListener("online", () => { this._online = true; this.flush(); });
        window.addEventListener("offline", () => { this._online = false; });
      }
    }

    /* ── local, outlet-namespaced storage ─────────────────────────────────── */
    key(name) {
      if (!this.outletId) throw new Error("no outlet selected");
      return "kashikeyo.o" + this.outletId + "." + name;
    }
    local(name, value) {
      if (!has) return value === undefined ? null : value;
      if (value === undefined) {
        try { return JSON.parse(localStorage.getItem(this.key(name)) || "null"); }
        catch (e) { return null; }
      }
      try { localStorage.setItem(this.key(name), JSON.stringify(value)); } catch (e) {}
      return value;
    }

    /* ── identity ─────────────────────────────────────────────────────────── */
    _restoreToken() {
      if (!has) return;
      try {
        const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
        if (t && t.exp > Date.now()) {
          this.token = t.token; this.outletId = t.outletId;
          this.rank = t.rank; this.name = t.name;
        }
      } catch (e) {}
    }
    async signIn(opts) {
      const body = { outletId: opts.outletId, pin: opts.pin, deviceId: opts.deviceId || null };
      const r = await this._fetch("/api/auth/pin", { method: "POST", body: body, anon: true });
      this.token = r.token; this.outletId = r.outletId; this.rank = r.rank; this.name = r.name;
      if (has) {
        localStorage.setItem(TOKEN_KEY, JSON.stringify({
          token: r.token, outletId: r.outletId, rank: r.rank, name: r.name,
          exp: Date.now() + 11 * 3600e3
        }));
      }
      this.flush();
      return r;
    }
    signOut() {
      this.token = null; this.rank = 0;
      if (has) localStorage.removeItem(TOKEN_KEY);
      this.stop();
    }
    // The one gate the whole system uses. Kitchen 1, Till 2, Manager 3,
    // Admin 4, Owner 5 — never a name, never a title.
    canApprove(need) { return this.rank >= (need || 3); }
    canReceive() { return this.rank >= 3; }

    /* ── the live snapshot both guest portals and the floor read ──────────── */
    async snapshot() {
      if (!this.outletId) return null;
      if (!this._online) return this.local("snapshot");
      try {
        const s = await this._fetch("/api/outlet/" + this.outletId + "/snapshot");
        this.local("snapshot", s);
        return s;
      } catch (e) {
        // A failed poll is not an error condition: it is Tuesday. Serve the
        // cache and let the caller carry on taking orders.
        return this.local("snapshot");
      }
    }
    onSnapshot(fn) {
      this._subs.push(fn);
      if (!this._timer) {
        const tick = async () => {
          const s = await this.snapshot();
          if (s) this._subs.forEach(function (f) { try { f(s); } catch (e) {} });
          this._timer = setTimeout(tick, this.pollMs);
        };
        tick();
      }
      return () => { this._subs = this._subs.filter(function (f) { return f !== fn; }); };
    }
    stop() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }

    /* ── writes: queue first, network second ──────────────────────────────── */
    queue(kind, payload) {
      const op = { opId: uuid(), kind: kind, payload: payload, at: Date.now() };
      const out = (this.local("outbox") || []).concat([op]);
      this.local("outbox", out);
      this.flush();
      return op.opId;
    }
    pending() { return (this.local("outbox") || []).length; }

    async flush() {
      if (this._flushing || !this._online || !this.token || !this.outletId) return;
      const ops = this.local("outbox") || [];
      if (!ops.length) return;
      this._flushing = true;
      try {
        const r = await this._fetch("/api/outlet/" + this.outletId + "/sync/push", {
          method: "POST", body: { ops: ops.slice(0, 50) }
        });
        // Only ops the server acknowledged leave the outbox. An op that errored
        // stays put and is visible to the operator rather than silently lost.
        const doneIds = {}, failed = [];
        (r.results || []).forEach(function (x) {
          if (x.error) failed.push(x); else doneIds[x.opId] = true;
        });
        this.local("outbox", ops.filter(function (o) { return !doneIds[o.opId]; }));
        if (failed.length) this.local("syncErrors", failed);
        return r.results;
      } catch (e) {
        return null;   // stays queued
      } finally {
        this._flushing = false;
        const left = this.local("outbox") || [];
        if (left.length && this._online) setTimeout(() => this.flush(), 5000);
      }
    }

    /* ── guest side: intent only, never money ─────────────────────────────── */
    guestOrder(table, lines, extra) {
      const body = Object.assign({ table: table, lines: lines, opId: uuid() }, extra || {});
      return this._fetch("/api/outlet/" + this.outletId + "/guest/order",
        { method: "POST", body: body });
    }
    guestRequest(table, kind, detail) {
      return this._fetch("/api/outlet/" + this.outletId + "/guest/request",
        { method: "POST", body: { table: table, kind: kind, detail: detail || "" } });
    }

    /* ── the only cross-outlet read, and it is aggregates ─────────────────── */
    estateDay(date) {
      if (this.rank < 5) return Promise.reject(new Error("rank 5 required"));
      return this._fetch("/api/estate/day?date=" + encodeURIComponent(date || ""));
    }

    async _fetch(path, opts) {
      const o = opts || {};
      const headers = { "content-type": "application/json" };
      if (this.token && !o.anon) headers.authorization = "Bearer " + this.token;
      const res = await fetch(this.baseUrl + path, {
        method: o.method || "GET",
        headers: headers,
        body: o.body ? JSON.stringify(o.body) : undefined
      });
      if (res.status === 401) { this.signOut(); throw new Error("session expired"); }
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) {}
      if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
      return data;
    }
  }

  root.KashikeyoAPI = KashikeyoAPI;
  if (typeof module !== "undefined" && module.exports) module.exports = { KashikeyoAPI };
})(typeof window !== "undefined" ? window : globalThis);
