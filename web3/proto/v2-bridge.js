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

  // The terminal's network pill can simulate a link drop even when the browser
  // is genuinely online (the "Try it" offline demo, and a real staff-triggered
  // "go offline" for a flaky venue). When set, the queue holds durably in
  // IndexedDB and nothing is POSTed until the pill is flipped back on — so a
  // sale closed offline really does stack in the outbox, not silently sync.
  function forcedOffline() { return window.__v2ForceOffline === true; }

  // ── Drain the queue. Idempotent: /api/ops de-dupes on opId, so a partial
  //    send that we retry never double-books. Backoff via attempts count. ─────
  function flush() {
    if (_flushing) return Promise.resolve();
    var tk = token();
    if (!tk || forcedOffline() || (navigator.onLine === false)) return Promise.resolve();
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
      // Per-line discount reduces the line, rounded once from the line itself.
      var unit = unitLaari(m, outlet), qty = num(l.qty), disc = num(l.disc);
      var amount = Math.round(unit * qty * (1 - disc / 100));
      subtotal += amount;
      lines.push({ pid: l.id, qty: qty, price: unit, amount: amount, discPct: disc || 0 });
    });
    if (!lines.length) return;

    // Bill discount comes off the goods subtotal; service charge and GST are
    // charged on the discounted goods, so subtotal − billDisc + svc + gst =
    // total holds — the exact invariant the server's money audit re-checks.
    var billDiscPct = num(sale.discountPct);
    var billDisc = Math.round(subtotal * billDiscPct / 100);
    var goods = subtotal - billDisc;
    var svcCharge = Math.round(goods * sc / 100);
    var gst = Math.round((goods + svcCharge) * rate / 100);
    var total = goods + svcCharge + gst;
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
      lines: lines, subtotal: subtotal, billDisc: billDisc, billDiscPct: billDiscPct, svcCharge: svcCharge, gst: gst, total: total,
      payments: [{ method: tender, amount: total,
        given: sale.given != null ? Math.round(num(sale.given) * 100) : total,
        change: sale.change != null ? Math.round(num(sale.change) * 100) : 0 }],
    };
    if (sale.customerId) { data.customerId = sale.customerId; data.customerName = sale.customerName || ""; }
    // MIRA tax invoice: when the cashier issued the receipt in a B2B customer's
    // name, persist the buyer block + docType so the permanent record — and any
    // reprint — is a valid tax invoice they can claim input tax against.
    if (sale.buyerName) {
      data.buyerName = String(sale.buyerName);
      if (sale.buyerTin) data.buyerTin = String(sale.buyerTin);
      data.docType = "taxinvoice";
    }
    // A credit/tab sale is money owed: raise the customer's balance the way the
    // register does (deltas.cust → the server's FIN-02 accrual, which also does
    // the over-limit check). Idempotent — the op is deduped by opId, so a replay
    // never double-charges the tab.
    var opObj = { opId: id, puts: [{ kind: "sales", id: id, data: data }] };
    if (data.customerId && (tender === "credit" || tender === "tab")) {
      opObj.deltas = { cust: [{ id: data.customerId, bal: total, pts: 0 }] };
    }
    var op = { id: id, lamport: lamport, state: "queued", attempts: 0, total: total,
      body: { ops: [opObj] } };

    // Durable FIRST, then optimistic network. If IndexedDB is unavailable, fall
    // back to a best-effort direct POST rather than dropping the sale silently.
    putOp(op).then(flush).catch(function () {
      var tk = token(); if (!tk) return;
      fetch("/api/ops", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + tk }, body: JSON.stringify(op.body) }).catch(function () {});
    });
  }

  // ── Public: persist a refund as an opposing `sales` entity (type refund) ────
  // A refund never edits the original sale. It posts a reversal the server
  // audits (sale.refund, with reason + amount), which the Z-report, GST return
  // and P&L already subtract from net; a credit refund also lowers the
  // customer's drawn balance via a negative FIN-02 accrual. Idempotent by opId.
  //
  // Manager approval (SEC-03): a refund is a money-out movement, so the server
  // only stamps it approved when the batch carries a fresh /api/elevate token.
  // When a store password is supplied we verify it, then POST the op directly
  // with X-Elevation so the refund lands APPROVED and clears the audit flag —
  // exactly what the register (/app) does. If that fails (wrong password, or
  // offline) we still persist through the durable outbox so no refund is lost;
  // it simply lands "pending review" until a manager re-approves. Returns a
  // Promise resolving { ok, approved, error } so the till can show a result.
  function pushRefund(refund) {
    if (!token() || !refund) return Promise.resolve({ ok: false, error: "no session" });
    // Money moves OUT on a refund, so every figure is stored negative — the
    // same shape the register (/app) posts. The Z-report sums `gross += total`
    // and `cash += payment.amount`, so a negative total nets the day's takings
    // and drawer down; a positive one would double-count the sale. The refunds
    // tally itself reads Math.abs, so it stays a positive number either way.
    var mag = Math.round(num(refund.amount) * 100);         // laari, magnitude
    if (!(mag > 0)) return Promise.resolve({ ok: false, error: "amount required" });
    var total = -mag;                                       // signed: paid out
    var tender = refund.tender || "cash";
    var id = "r_v2_" + (refund.no || "refund") + "_" + Date.now();
    var data = {
      type: "refund", no: (refund.no || id) + "-R", refundOf: refund.no || null,
      tender: tender, at: Date.now(), reason: refund.reason || "", note: refund.note || "",
      lines: [], subtotal: total, fee: 0, billDisc: 0, gst: 0, svcCharge: 0,
      total: total, userName: refund.by || "",
      payments: [{ method: tender, amount: total }],
    };
    if (refund.customerId) { data.customerId = refund.customerId; data.customerName = refund.customerName || ""; }
    var opObj = { opId: id, puts: [{ kind: "sales", id: id, data: data }] };
    // A credit refund gives money back against the tab: lower the drawn balance
    // (negative delta; the server floors it at zero).
    if (refund.customerId && tender === "credit") {
      opObj.deltas = { cust: [{ id: refund.customerId, bal: total, pts: 0 }] };
    }
    var op = { id: id, lamport: Date.now(), state: "queued", attempts: 0, total: mag, body: { ops: [opObj] } };

    // Durable fallback: queue it so a failed/offline approval never loses the
    // refund. It drains on the next flush and lands pending review.
    function queueDurably() {
      return putOp(op).then(flush).catch(function () {
        var tk = token(); if (!tk) return;
        return fetch("/api/ops", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + tk }, body: JSON.stringify(op.body) }).catch(function () {});
      });
    }

    var tk = token();
    var pwd = refund.password || "";
    // No password, or offline → durable queue only (pending approval).
    if (!pwd || navigator.onLine === false) {
      return queueDurably().then(function () { return { ok: true, approved: false }; });
    }
    // Elevate with the store password, then post the refund approved in one
    // batch. Any failure falls through to the durable queue.
    return fetch("/api/elevate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + tk },
      body: JSON.stringify({ password: pwd }),
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j }; });
    }).then(function (x) {
      if (!x.ok || !x.j || !x.j.elevation) {
        // Wrong password → surface it; do NOT queue (the till lets them retry).
        return { ok: false, error: (x.j && x.j.error) || "wrong password" };
      }
      return fetch("/api/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + tk, "X-Elevation": x.j.elevation },
        body: JSON.stringify(op.body),
      }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then(function (jj) {
        try { console.log("[v2] refund posted", id, "MVR", (mag / 100).toFixed(2), "approved", "rowver", jj && jj.rowver); } catch (e) {}
        return { ok: true, approved: true };
      });
    }).catch(function () {
      // Network hiccup after a valid password: don't lose the refund.
      return queueDurably().then(function () { return { ok: true, approved: false }; });
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
  window.__v2PushRefund = pushRefund;
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
