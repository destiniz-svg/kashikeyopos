/* v2-bridge — offline-first sale persistence for the reference terminal.
 *
 * The reference confirmPay() closes a ticket; this bridge turns that settlement
 * into a real `sales` entity and drives it to the server through a durable
 * outbox, following 06-OFFLINE-SYNC.md:
 *   - Durable before optimistic: the op is written to IndexedDB FIRST, then the
 *     network POST is attempted. A crash or a dropped link never loses a sale.
 *   - Idempotent replay: each op carries a stable opId; /api/ops de-dupes on it,
 *     so replaying after a reconnect books the sale exactly once.
 *   - The queue drains on reconnect, on tab focus, and on a short interval.
 * With no back-office session there is no ops token, so this is inert and the
 * terminal stays in pure demo mode.
 *
 * Money is booked in laari (MVR x100), matching the reference totals(): menu
 * prices are GST-exclusive, service charge is a % of goods, GST is charged on
 * (goods + service) — the exact shape auditSaleMoney() re-checks server-side. */
(function () {
  var DB_NAME = "kpos-v2", STORE = "ops", VERSION = 1;
  var _db = null, _flushing = false;

  function num(v) { return Number(v) || 0; }

  // ── IndexedDB: the durable outbox (never localStorage — see the spec) ──────
  function openDB() {
    return new Promise(function (resolve, reject) {
      if (_db) return resolve(_db);
      if (!window.indexedDB) return reject(new Error("no indexedDB"));
      var rq = indexedDB.open(DB_NAME, VERSION);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: "id" });
          os.createIndex("state", "state", { unique: false });
        }
      };
      rq.onsuccess = function () { _db = rq.result; resolve(_db); };
      rq.onerror = function () { reject(rq.error); };
    });
  }
  function tx(mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode), os = t.objectStore(STORE), out;
        Promise.resolve(fn(os)).then(function (r) { out = r; });
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }
  function putOp(op) { return tx("readwrite", function (os) { os.put(op); }); }
  function allOps() {
    return tx("readonly", function (os) {
      return new Promise(function (res) { var r = os.getAll(); r.onsuccess = function () { res(r.result || []); }; });
    });
  }
  function delOp(id) { return tx("readwrite", function (os) { os.delete(id); }); }

  function token() { return (window.KPOS_REAL && window.KPOS_REAL.token) || null; }

  // ── Drain the queue. Idempotent: /api/ops de-dupes on opId, so a partial
  //    send that we retry never double-books. Backoff via attempts count. ─────
  function flush() {
    if (_flushing) return Promise.resolve();
    var tk = token();
    if (!tk || (navigator.onLine === false)) return Promise.resolve();
    _flushing = true;
    return allOps().then(function (ops) {
      var pending = ops.filter(function (o) { return o.state !== "sent"; })
        .sort(function (a, b) { return (a.lamport || 0) - (b.lamport || 0); });
      var chain = Promise.resolve();
      pending.forEach(function (o) {
        chain = chain.then(function () {
          return fetch("/api/ops", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + tk },
            body: JSON.stringify(o.body),
          }).then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
          }).then(function (j) {
            // Confirmed by the server → drop from the outbox.
            try { console.log("[v2] sale synced", o.id, "MVR", (o.total / 100).toFixed(2), "rowver", j && j.rowver); } catch (e) {}
            return delOp(o.id);
          }).catch(function (e) {
            o.attempts = (o.attempts || 0) + 1; o.error = String(e && e.message || e);
            return putOp(o); // stays queued, retried on the next drain
          });
        });
      });
      return chain;
    }).then(function () { _flushing = false; }, function () { _flushing = false; });
  }

  // ── Public: enqueue a completed settlement, then try to drain immediately ──
  function unitLaari(m, outlet) {
    // GST-exclusive menu price in laari; service charge and GST are added once
    // below. No TGST uplift here — that double-taxed tourist outlets and is gone
    // from menuPrice() too.
    return Math.round(num(m.price) * 100);
  }
  function pushSale(sale) {
    if (!token()) return;                                   // no session → demo only
    var outlet = (window.KPOS_REAL && window.KPOS_REAL.outlet) || {};
    var rate = num(outlet.rate), sc = num(outlet.sc);
    var MENU = (window.KPOS && window.KPOS.MENU) || [];
    var byId = {}; MENU.forEach(function (m) { byId[m.id] = m; });

    var lines = [], subtotal = 0;
    (sale.lines || []).forEach(function (l) {
      var m = byId[l.id]; if (!m) return;
      var unit = unitLaari(m, outlet), qty = num(l.qty), amount = unit * qty;
      subtotal += amount;
      lines.push({ pid: l.id, qty: qty, price: unit, amount: amount });
    });
    if (!lines.length) return;

    var svcCharge = Math.round(subtotal * sc / 100);
    var gst = Math.round((subtotal + svcCharge) * rate / 100);
    var total = subtotal + svcCharge + gst;
    var tender = sale.tender || "cash";
    var id = "s_v2_" + (sale.no || "sale") + "_" + Date.now();
    var lamport = Date.now();
    // Real channel from the ticket (dine_in/qr/takeaway/delivery), not a fixed
    // "v2" tag — otherwise the Orders/Delivery/QR boards can never see anything
    // but dine-in. A sale also records the customer it belongs to when one is
    // linked (credit account or loyalty member), which is what makes the
    // customer's purchase history and any credit charge real.
    var CHANS = { dine_in: 1, qr: 1, takeaway: 1, delivery: 1 };
    var channel = CHANS[sale.channel] ? sale.channel : "dine_in";
    var data = {
      type: "sale", no: sale.no || id, table: sale.table != null ? sale.table : null,
      tender: tender, at: Date.now(), channel: channel,
      lines: lines, subtotal: subtotal, billDisc: 0, svcCharge: svcCharge, gst: gst, total: total,
      payments: [{ method: tender, amount: total,
        given: sale.given != null ? Math.round(num(sale.given) * 100) : total,
        change: sale.change != null ? Math.round(num(sale.change) * 100) : 0 }],
    };
    if (sale.customerId) { data.customerId = sale.customerId; data.customerName = sale.customerName || ""; }
    var op = { id: id, lamport: lamport, state: "queued", attempts: 0, total: total,
      body: { ops: [{ opId: id, puts: [{ kind: "sales", id: id, data: data }] }] } };

    // Durable FIRST, then optimistic network. If IndexedDB is unavailable, fall
    // back to a best-effort direct POST rather than dropping the sale silently.
    putOp(op).then(flush).catch(function () {
      var tk = token(); if (!tk) return;
      fetch("/api/ops", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + tk }, body: JSON.stringify(op.body) }).catch(function () {});
    });
  }

  // ── Public: persist a clock punch (a time_entries entity) ──────────────────
  // clockIn/clockOut in the terminal set local state and call this so the punch
  // survives a reload and is visible to labour, payroll and the CFO panel. The
  // entity id is stable (the local "ck…" id), so a clock-out upserts the same
  // row; the opId differs for the in vs out leg so the server records both.
  function pushClock(entry) {
    if (!token() || !entry || !entry.id) return;
    var id = String(entry.id);
    var leg = entry.out ? "out" : "in";
    var data = {
      type: "time_entry", staffId: entry.staff, outlet: entry.outlet,
      in: num(entry.in), out: num(entry.out), late: num(entry.late), at: Date.now(),
    };
    var op = { id: id + "-" + leg, lamport: Date.now(), state: "queued", attempts: 0, total: 0,
      body: { ops: [{ opId: id + "-" + leg, puts: [{ kind: "time_entries", id: id, data: data }] }] } };
    putOp(op).then(flush).catch(function () {
      var tk = token(); if (!tk) return;
      fetch("/api/ops", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + tk }, body: JSON.stringify(op.body) }).catch(function () {});
    });
  }

  // ── Public: upsert a reservation entity (approve/decline/seat from the till) ─
  // The till reads reservations from KPOS_REAL.reservations and writes status
  // changes back through this. The entity id is stable, so approving then
  // seating the same booking upserts one row; a distinct opId per status leg
  // lets the server record each transition.
  function pushReservation(resv) {
    if (!token() || !resv || !resv.id) return;
    var id = String(resv.id);
    var data = {
      id: id, storeId: resv.storeId || null, status: resv.status || "pending",
      source: resv.source || "till", name: resv.name || "Guest", phone: resv.phone || "",
      party: num(resv.party) || 2, time: resv.time || "", date: resv.date || "",
      note: resv.note || "", table: resv.table || "", custId: resv.custId || null,
      t: num(resv.at) || Date.now(),
    };
    var op = { id: "resv_" + id + "_" + (resv.status || "x") + "_" + Date.now(), lamport: Date.now(),
      state: "queued", attempts: 0, total: 0,
      body: { ops: [{ opId: "resv_" + id + "_" + (resv.status || "x") + "_" + Date.now(),
        puts: [{ kind: "reservations", id: id, data: data }] }] } };
    putOp(op).then(flush).catch(function () {
      var tk = token(); if (!tk) return;
      fetch("/api/ops", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + tk }, body: JSON.stringify(op.body) }).catch(function () {});
    });
  }

  function queuedCount() { return allOps().then(function (o) { return o.filter(function (x) { return x.state !== "sent"; }).length; }); }

  window.__v2PushClock = pushClock;
  window.__v2PushSale = pushSale;
  window.__v2PushReservation = pushReservation;
  window.__v2Outbox = { flush: flush, queued: queuedCount };

  // Drain triggers: reconnect, tab focus, and a slow safety-net interval.
  window.addEventListener("online", flush);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) flush(); });
  setInterval(flush, 15000);
  // Attempt an initial drain once the page settles (covers ops left by a prior
  // offline session on this device).
  if (document.readyState === "complete") setTimeout(flush, 1500);
  else window.addEventListener("load", function () { setTimeout(flush, 1500); });
})();
