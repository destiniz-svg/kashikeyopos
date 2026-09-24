/* ═══ THE SETTLEMENT — ONE ORDER OF OPERATIONS, EVERY SURFACE ═══════════════
   subtotal → discounts → points → amount due → tip → what is paid

   The till's pay screen, the guest phone, the member card and the sale row
   used to work this out four times, and they disagreed: the phone tipped on
   what the member paid while the till tipped on all the goods, the card took
   points off the total while the till took them off the goods, and an even
   split charged every share the whole bill's tip. A guest believes the phone,
   so a phone that quotes a figure the counter cannot match is a dispute at
   the door. There is one copy, loaded as a script by the pages and as a
   module by the server, exactly like kashikeyo-rules.js.

   Discounts are already inside `net` (the goods after discount), because the
   bill's own totals put them there. Points come off the GOODS, then service
   and tax are rebuilt on what is left — service is not charged on money the
   guest did not hand over, nor tax on a redemption. The tip is a percentage
   of the goods the payer actually pays for: never of service and tax, never
   of points, never of somebody else's share.
   ═══════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KPOS_BILL = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  function r2(n) { return Math.round((+n || 0) * 100) / 100; }

  /* o: { net, svc, tax, total?          the bill (total defaults to the sum)
          amount?                        what this payer covers, in MVR
          share?                         …or as a fraction of the bill (1)
          balance, blockPts, blockVal    the member's points and the store rate
          blocks                         blocks asked for (Infinity = all that fit)
          tipPct }                       the tip, in percent */
  function settle(o) {
    var net = +o.net || 0, svc = +o.svc || 0, tax = +o.tax || 0;
    var total = o.total != null ? +o.total : net + svc + tax;
    var share = o.amount != null ? (total ? Math.max(0, +o.amount) / total : 0)
      : (o.share != null ? Math.max(0, +o.share) : 1);
    var goods = r2(net * share);
    // Whole blocks only, at the store's rate, never more than the goods.
    var bp = Math.max(1, +o.blockPts || 100), bv = Math.max(0, +o.blockVal || 0);
    var maxBlocks = bv > 0 ? Math.max(0, Math.min(Math.floor((+o.balance || 0) / bp), Math.floor(goods / bv))) : 0;
    var blocks = Math.min(Math.max(0, Math.floor(+o.blocks || 0)), maxBlocks);
    var pointsValue = r2(blocks * bv);
    var goodsAfter = r2(goods - pointsValue);
    var service, taxAfter, due;
    if (pointsValue > 0) {
      service = r2(goodsAfter * (net ? svc / net : 0));
      taxAfter = r2((goodsAfter + service) * ((net + svc) ? tax / (net + svc) : 0));
      due = r2(goodsAfter + service + taxAfter);
    } else {
      // No redemption: the bill's own figure, untouched, so an even split's
      // whole-laari shares still sum back to the total exactly.
      service = r2(svc * share); taxAfter = r2(tax * share);
      due = o.amount != null ? r2(o.amount) : r2(total * share);
    }
    var tip = r2(goodsAfter * ((+o.tipPct || 0) / 100));
    return { goods: goods, maxBlocks: maxBlocks, blocks: blocks, pointsSpent: blocks * bp,
      pointsValue: pointsValue, goodsAfter: goodsAfter, service: service, tax: taxAfter,
      due: due, tip: tip, pay: r2(due + tip) };
  }

  return { settle: settle, r2: r2 };
});
