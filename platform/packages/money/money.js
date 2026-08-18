'use strict';
/* money.js — the ONE bill calculation for the KashikeyoPOS platform.
 *
 * WHY ONE FILE. A bill gets computed in at least three places: the till (what
 * the cashier sees), the server (what is persisted, taxed and posted to the
 * ledger) and the guest's phone (what it quotes). Written three times they
 * drift, and the drift is silent because each copy satisfies its own internal
 * invariant. So there is one implementation: Node requires it, the browsers
 * load it as a script.
 *
 * UNITS: integer LAARI (MVR × 100) in and out. Never floats — 0.1 + 0.2 is not
 * 0.3, and a restaurant does that arithmetic a few thousand times a day. The
 * database columns are numeric(12,2) in MVR, so the edge converts once, at the
 * edge, and nowhere else.
 *
 * THE TAX MODEL (decided, not inferred): menu prices are GST-INCLUSIVE. A dish
 * priced 100 means the guest hands over 100 for the goods. GST is EXTRACTED as
 * the tax fraction rate/(1+rate) of the inclusive amount — never added on top,
 * and never re-grossed off a rounded exclusive base, which is not a round trip.
 *
 * ORDER OF OPERATIONS, and it matters for every figure below it:
 *   1. goods      = Σ line inclusive amounts, each rounded once from the line
 *   2. discount   = applied to goods, before anything else
 *   3. service    = service_pct of the DISCOUNTED goods. Not of the fee, and
 *                   not of the tax — a service charge on tax is a charge on a
 *                   charge, and MIRA would have a view about it.
 *   4. taxable    = discounted goods + service. Service charge is part of the
 *                   supply, so it is taxed.
 *   5. tax        = the GST contained WITHIN taxable
 *   6. total      = taxable + fee, then cash rounding if tendered in cash
 *
 * The invariant every caller may rely on, exact in integer laari:
 *     gross − discount + service + tax + rounding = total
 * which is the same equation the `sale_adds_up` check constraint enforces in
 * the database, so a bill that fails it here is a sale Postgres will refuse.
 *
 * `gross`, `discount` and `service` in that equation are all NET of tax, with
 * the whole of the GST in `tax`. priceBill() therefore returns two discounts:
 * `discountIncl` is what the cashier keyed and what prints on the bill, and
 * `discount` is its net counterpart, named for the column it belongs in so
 * persisting a result is a field-for-field copy with nothing to mix up.
 */

const R = Math.round;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/* rate is a PERCENTAGE (8 for GGST, 16 for TGST) because that is how it is
   written on a tax certificate and how it is stored in chain.tax_version. */
const frac = (ratePct) => num(ratePct) / 100;

/** The GST contained within a tax-inclusive amount. */
function taxWithin(inclLaari, ratePct) {
  const r = frac(ratePct);
  return R(num(inclLaari) * r / (1 + r));
}

/** One line's inclusive amount. Rounded ONCE from the line, never by
 *  multiplying a rounded unit price back out — that drifts by a laari per unit
 *  and a 40-line banquet bill lands visibly wrong. */
function lineIncl(unitLaari, qty) {
  return R(num(unitLaari) * num(qty));
}

/**
 * Price a whole bill.
 *
 * @param {object} bill
 * @param {Array}  bill.lines      [{ unitPrice (laari), qty }]
 * @param {number} bill.discount   laari off the goods, absolute
 * @param {number} bill.servicePct e.g. 10
 * @param {number} bill.taxRate    percentage, e.g. 8
 * @param {number} bill.fee        delivery or similar, laari, GST-inclusive,
 *                                 NOT service-chargeable
 * @param {number} bill.roundTo    cash rounding increment in laari (0 = none)
 * @returns {object} every figure the sale row needs, all integer laari
 */
function priceBill(bill) {
  const lines = (bill && bill.lines) || [];
  const linesIncl = lines.map((l) => lineIncl(l && l.unitPrice, l && l.qty));
  const goodsIncl = linesIncl.reduce((a, v) => a + v, 0);

  // A discount cannot exceed the goods: a negative bill is not a discount, it
  // is a refund, and it goes through a credit note where it can be approved.
  const discountIncl = Math.min(Math.max(0, R(num(bill && bill.discount))), goodsIncl);
  const netGoods = goodsIncl - discountIncl;

  const service = R(netGoods * num(bill && bill.servicePct) / 100);
  const fee = Math.max(0, R(num(bill && bill.fee)));

  const rate = num(bill && bill.taxRate);
  const taxableIncl = netGoods + service + fee;

  /* Tax is extracted from each component separately and SUMMED, rather than
     taken off the combined figure, so the ledger's GST credit is the sum of
     the parts it is posted against. Taking it off the whole and splitting it
     afterwards leaves a laari nobody owns. */
  const taxGoods = taxWithin(netGoods, rate);
  const taxService = taxWithin(service, rate);
  const taxFee = taxWithin(fee, rate);
  const tax = taxGoods + taxService + taxFee;

  const roundTo = Math.max(0, R(num(bill && bill.roundTo)));
  const total = roundTo > 1 ? Math.round(taxableIncl / roundTo) * roundTo : taxableIncl;
  const rounding = total - taxableIncl;

  /* The NET figures the sale row and the ledger carry. Each is computed by
     SUBTRACTION from the inclusive figure it belongs to, never by an
     independent division — that is what makes
         gross − discount + service + tax + rounding = total
     exact in integers rather than usually-right.
     `discountNet` is derived first and `gross` is then built to sit exactly one
     discount above the net goods, so the subtraction in the invariant lands on
     netGoodsNet with nothing left over. The fee rides inside `gross`: the sale
     row has no fee column, and it is income like any other line. */
  const netGoodsNet = netGoods - taxGoods;
  const serviceNet = service - taxService;
  const feeNet = fee - taxFee;
  const discountNet = R(discountIncl / (1 + frac(rate)));
  const gross = netGoodsNet + discountNet + feeNet;

  /* Per-line net amounts, split so they sum EXACTLY to the net goods figure.
     The last line absorbs the residual, which is why it is computed by
     subtraction rather than rounded on its own. Computed against the
     PRE-discount goods, because a line's own contribution to income does not
     change because the bill as a whole was discounted — the discount is its
     own posting, to 4090. */
  const goodsNet = goodsIncl - taxWithin(goodsIncl, rate);
  const netLines = [];
  let acc = 0;
  for (let i = 0; i < linesIncl.length; i++) {
    const v = i === linesIncl.length - 1
      ? goodsNet - acc
      : R(linesIncl[i] / (1 + frac(rate)));
    netLines.push(v);
    acc += v;
  }

  /* The keys are named for the SALE COLUMNS they belong in, so persisting a
     result is a field-for-field copy and there is no opportunity to put the
     tax-inclusive discount into a column the check constraint reads as net.
     The inclusive figures a person actually sees keep the `Incl` suffix. */
  return {
    linesIncl,           // what each line shows on the bill, tax-inclusive
    netLines,            // what each line contributes to income, ex-tax
    goodsIncl,           // goods, tax-inclusive, before discount
    discountIncl,        // the discount as the cashier entered it
    gross,               // sale.gross    — net of tax, fee folded in
    discount: discountNet, // sale.discount — net of tax, so the invariant closes
    service: serviceNet, // sale.service  — net of tax
    tax,                 // sale.tax      — all GST: goods + service + fee
    rounding,            // sale.rounding — cash rounding, signed
    total,               // sale.total    — what the guest actually pays
    taxRate: rate,
    taxGoods, taxService, taxFee, feeNet,
  };
}

/**
 * What a credit note gives back.
 *
 * ALL OF IT IS A SHARE OF THE SALE'S OWN FIGURES. Crediting two lines out of
 * nine gives back the same fraction of the discount, the service charge and the
 * tax that those lines carried when they were sold — not a fresh calculation.
 * Recomputing the tax at today's rate would restate a filed month the first
 * time a rate changed; recomputing it at the sale's rate would be a second
 * arithmetic beside the one that produced the receipt.
 *
 * It lives HERE, beside priceBill, for the reason priceBill lives here: the
 * screen shows the refund before anybody presses anything and the server posts
 * it afterwards, and a figure that differs by a laari between those two is a
 * guest being told one number and given another. The browser loads this file
 * as a script and the server requires it — one function, two callers.
 *
 *   goodsNet  the credited lines, net of tax, in laari
 *   sale      { gross, discount, service, tax } — the sale's own, in laari
 */
function creditShare(goodsNet, sale) {
  const goods = R(num(goodsNet));
  const saleGoods = R(num(sale && sale.gross));
  const share = saleGoods > 0 ? goods / saleGoods : 0;
  const discount = R(num(sale && sale.discount) * share);
  const service = R(num(sale && sale.service) * share);
  const tax = R(num(sale && sale.tax) * share);
  return {
    goods, discount, service, tax,
    /* Net of the discount, which is the figure that goes on the credit note
       row and the one the ledger credits to 4000 less the reversal to 4090. */
    goodsAfterDiscount: goods - discount,
    total: goods - discount + service + tax,
  };
}

/** Does a sale row's own declared arithmetic hold? The same equation the
 *  database's `sale_adds_up` constraint enforces, available to the application
 *  so a bad payload is refused with a readable message instead of a
 *  constraint-violation stack. */
function saleAddsUp(s) {
  const lhs = num(s.gross) - num(s.discount) + num(s.service) + num(s.tax) + num(s.rounding);
  return Math.abs(lhs - num(s.total)) < 0.005;
}

module.exports = { priceBill, taxWithin, lineIncl, creditShare, saleAddsUp };
