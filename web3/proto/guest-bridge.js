/* guest-bridge — turns a guest's "Send to the kitchen" into a real order.
 * The reference guest portal fires the cart client-side (sendKitchen); this
 * bridge also POSTs it to the public /p/:slug/order endpoint so the order lands
 * in the store's backend and shows up on the terminal (KDS / Orders). The store
 * slug comes from the QR URL (?s=<slug>); the endpoint prices the order with the
 * store's real rates and returns the order ref. No auth — guests are anonymous. */
(function () {
  function slug() {
    try { return new URLSearchParams(location.search).get("s") || ""; } catch (e) { return ""; }
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
})();
