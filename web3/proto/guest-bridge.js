/* guest-bridge — turns a guest's "Send to the kitchen" into a real order.
 * The reference guest portal fires the cart client-side (sendKitchen); this
 * bridge also POSTs it to the public /p/:slug/order endpoint so the order lands
 * in the store's backend and shows up on the terminal (KDS / Orders). The store
 * slug comes from the QR URL (?s=<slug>); the endpoint prices the order with the
 * store's real rates and returns the order ref. No auth — guests are anonymous. */
(function () {
  function slug() {
    // ?s=<slug> on a query link, else the injected store slug (a branded
    // subdomain has no ?s= — the host carries the store).
    try { return new URLSearchParams(location.search).get("s") || (window.KPOS_REAL && window.KPOS_REAL.slug) || ""; } catch (e) { return (window.KPOS_REAL && window.KPOS_REAL.slug) || ""; }
  }
  function placeOrder(items, table, note) {
    var s = slug();
    if (!s || !items || !items.length) return;               // demo mode (no store) → no-op
    var body = {
      items: items.map(function (i) { return { pid: i.pid, qty: Number(i.qty) || 1, note: i.note || "" }; }),
      table: table || "", gtype: "dinein", note: note || "",
    };
    fetch("/p/" + encodeURIComponent(s) + "/order", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(function (r) { return r.json(); }).then(function (j) {
      try { console.log("[vg] order placed", j && j.order && j.order.no, "MVR", j && j.order && j.order.total); } catch (e) {}
    }).catch(function (e) { try { console.warn("[vg] order POST failed", e); } catch (x) {} });
  }
  window.__vgPlaceOrder = placeOrder;

  // Look up a loyalty/credit account by phone for the Customer-account tab.
  function account(phone, cb) {
    var s = slug();
    if (!s) { if (cb) cb(null); return; }
    fetch("/p/" + encodeURIComponent(s) + "/account?phone=" + encodeURIComponent(phone))
      .then(function (r) { return r.json(); })
      .then(function (j) { if (cb) cb(j); })
      .catch(function () { if (cb) cb(null); });
  }
  window.__vgAccount = account;

  // Waiter call / bill request → the store's public /p/:slug/call endpoint, so it
  // reaches the terminal floor (the localStorage bridge is demo-only and never
  // leaves the guest's own device).
  function callStaff(kind, table) {
    var s = slug();
    if (!s) return;                                          // demo mode → no-op
    fetch("/p/" + encodeURIComponent(s) + "/call", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: kind === "bill" ? "bill" : "assist", table: table || "" }),
    }).catch(function () { /* never block the guest on a call */ });
  }
  window.__vgCall = callStaff;
})();
