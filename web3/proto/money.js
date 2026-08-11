/* money.js — the ONE bill calculation for KashikeyoPOS.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The bill maths used to be written three times: totals() in the terminal (for
 * what the cashier sees), pushSale() in v2-bridge.js (for what is persisted and
 * audited) and orderBreakdown() in index.js (for what a QR guest is quoted).
 * Two of those extracted GST from an inclusive price; the terminal added it on
 * top. The same dish therefore cost MVR 11,000 on a guest's phone and MVR
 * 11,880 at the counter — exactly the GST rate apart — and nothing detected it,
 * because each side satisfied its own `subtotal − discount + service + GST =
 * total` invariant. auditSaleMoney() checks a sale against its own declared
 * components, not against a canonical tax model, so it had nothing to compare
 * against.
 *
 * THE MODEL (decided, not inferred): menu prices are GST-INCLUSIVE.
 * A dish priced 100 means the guest pays 100 for the goods. GST is EXTRACTED as
 * the tax fraction rate/(1+rate) of the inclusive amount — never re-grossed off
 * a rounded exclusive base, which is not a round trip. The service charge
 * applies to the discounted goods (never to the delivery fee) and is itself
 * part of the taxable supply. Every figure is rounded exactly once, from the
 * figure itself.
 *
 * UNITS: everything in and out of billTotals() is INTEGER LAARI (MVR × 100).
 * Callers convert at the edges. Integer money end to end means no float drift.
 *
 * This mirrors orderBreakdown() in index.js term for term — that is the
 * contract test/money-parity.test.js pins. Change one, change the other, and
 * run that test.
 *
 * Dual-mode: attaches to window for the browser (no build step in this repo)
 * and exports for CommonJS so tests and Node can require it.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.KPOS_MONEY = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var R = Math.round;
  var num = function (v) { var n = Number(v); return isFinite(n) ? n : 0; };

  /* The GST contained within an inclusive amount. */
  function taxWithin(inclLaari, rate) { return R(inclLaari * rate / (1 + rate)); }

  /* One ticket line's inclusive amount, rounded ONCE from the line — never by
     multiplying a rounded per-unit price back out, which drifts by laari at
     quantity. */
  function lineIncl(unitLaari, qty, discPct) {
    return R(num(unitLaari) * num(qty) * (1 - num(discPct) / 100));
  }

  /* A line's unit price in laari: the dish plus any chosen add-ons. Each is
     rounded to laari separately, matching how add-on prices are stored and
     re-priced server-side by name. */
  function unitLaari(priceMVR, addonPricesMVR) {
    var u = R(num(priceMVR) * 100);
    (addonPricesMVR || []).forEach(function (p) { u += R(num(p) * 100); });
    return u;
  }

  /**
   * The canonical bill.
   *
   * @param {Object} o
   * @param {Array}  o.lines        [{ unit (laari), qty, disc (percent) }]
   * @param {Number} o.billDiscPct  bill-level discount, percent
   * @param {Number} o.gstBp        GST in basis points (800 = 8%, 1700 = 17%)
   * @param {Number} o.svcBp        service charge in basis points (1000 = 10%)
   * @param {Number} o.feeLaari     delivery fee, GST-inclusive, never serviced
   * @param {Boolean} o.serviceApplies  service charge only applies to dine-in
   * @returns {Object} all integer laari:
   *   items  goods NET of GST, before the bill discount  (the "Subtotal" line)
   *   disc   bill discount, net of GST
   *   excl   goods net of GST after discount (carries the split residual)
   *   fee    delivery fee net of GST
   *   svc    service charge net of GST
   *   gst    total GST contained in the bill
   *   total  what the customer actually pays
   *   lines  per-line NET amounts, summing exactly to `items`
   *   linesIncl per-line INCLUSIVE amounts (what a receipt line shows)
   *
   * Invariant, exact in integers: items − disc + fee + svc + gst = total
   */
  function billTotals(o) {
    o = o || {};
    var rate = num(o.gstBp) / 10000;
    var sp = o.serviceApplies === false ? 0 : num(o.svcBp) / 10000;
    var dp = Math.max(0, Math.min(100, num(o.billDiscPct))) / 100;
    var TF = function (v) { return taxWithin(v, rate); };

    var linesIncl = (o.lines || []).map(function (l) {
      return lineIncl(l.unit, l.qty, l.disc);
    });
    var itemsIncl = linesIncl.reduce(function (a, v) { return a + v; }, 0);
    var feeIncl = R(num(o.feeLaari));
    var discIncl = R(itemsIncl * dp);
    var goodsIncl = itemsIncl - discIncl;
    var svcIncl = R(goodsIncl * sp);           // on the discounted goods, never the fee

    var total = goodsIncl + feeIncl + svcIncl; // what the customer pays, exactly
    var gst = TF(total);                       // fee + service are part of the supply
    var fee = feeIncl - TF(feeIncl);
    var svc = svcIncl - TF(svcIncl);
    var disc = discIncl - TF(discIncl);
    var excl = total - gst - svc - fee;        // goods net; carries the residual
    var items = excl + disc;

    /* Net line amounts are the split of `items`, so a sale's own lines add up
       to its subtotal with nothing left over. The last line absorbs the
       rounding residual, which is why it is computed by subtraction. */
    var lines = [], acc = 0;
    for (var i = 0; i < linesIncl.length; i++) {
      var v = i === linesIncl.length - 1 ? items - acc : R(linesIncl[i] / (1 + rate));
      lines.push(v); acc += v;
    }

    return { items: items, disc: disc, discPct: dp * 100, excl: excl, fee: fee,
             svc: svc, gst: gst, total: total, lines: lines, linesIncl: linesIncl };
  }

  return { billTotals: billTotals, taxWithin: taxWithin, lineIncl: lineIncl, unitLaari: unitLaari };
});
