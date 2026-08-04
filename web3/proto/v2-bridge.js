/* v2-bridge — turns a completed reference ticket into a real, persisted sale.
   The reference terminal finalises a payment in confirmPay(); this bridge takes
   the ticket lines + tender and POSTs a `sales` entity to /api/ops using the
   ops bearer token the server injected (window.KPOS_REAL.token). With no session
   there is no token, so this is a no-op and the terminal stays in demo mode.

   Money model matches the reference's own totals(): menu prices are treated as
   GST-exclusive, service charge is a % of goods, GST is charged on
   (goods + service). Everything is booked in laari (MVR x100), each figure
   rounded once — the exact shape auditSaleMoney() re-checks server-side. */
(function () {
  function num(v) { return Number(v) || 0; }

  // Replicate the reference menuPrice(): a TGST (tourism) outlet rounds the
  // uplifted price to the nearest 5; a GGST outlet charges the list price.
  function unitLaari(m, outlet) {
    var p = num(m.price);
    if (outlet && outlet.tax === "TGST") p = Math.round(p * 1.12 / 5) * 5;
    return Math.round(p * 100);
  }

  function pushSale(sale) {
    var REAL = window.KPOS_REAL;
    if (!REAL || !REAL.token) return;                 // no session → demo only
    var outlet = REAL.outlet || {};
    var rate = num(outlet.rate), sc = num(outlet.sc);
    var MENU = (window.KPOS && window.KPOS.MENU) || [];
    var byId = {}; MENU.forEach(function (m) { byId[m.id] = m; });

    var lines = [], subtotal = 0;
    (sale.lines || []).forEach(function (l) {
      var m = byId[l.id]; if (!m) return;
      var unit = unitLaari(m, outlet);
      var qty = num(l.qty);
      var amount = unit * qty;
      subtotal += amount;
      lines.push({ pid: l.id, qty: qty, price: unit, amount: amount });
    });
    if (!lines.length) return;

    var svcCharge = Math.round(subtotal * sc / 100);
    var gst = Math.round((subtotal + svcCharge) * rate / 100);
    var total = subtotal + svcCharge + gst;
    var tender = sale.tender || "cash";
    var given = sale.given != null ? Math.round(num(sale.given) * 100) : total;
    var change = sale.change != null ? Math.round(num(sale.change) * 100) : 0;

    var id = "s_v2_" + (sale.no || "sale") + "_" + Date.now();
    var data = {
      type: "sale", no: sale.no || id, table: sale.table != null ? sale.table : null,
      tender: tender, at: Date.now(), channel: "v2",
      lines: lines, subtotal: subtotal, billDisc: 0, svcCharge: svcCharge, gst: gst, total: total,
      payments: [{ method: tender, amount: total, given: given, change: change }],
    };

    fetch("/api/ops", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + REAL.token },
      body: JSON.stringify({ ops: [{ opId: id, puts: [{ kind: "sales", id: id, data: data }] }] }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      try { console.log("[v2] sale persisted", id, "MVR", (total / 100).toFixed(2), "rowver", j && j.rowver); } catch (e) {}
    }).catch(function (e) { try { console.warn("[v2] sale POST failed", e); } catch (x) {} });
  }

  window.__v2PushSale = pushSale;
})();
