/* Guard: the guest quote must equal the till charge.

   CLAUDE.md states the rule: orderBreakdown() in index.js is the guest-portal
   MIRROR of totals() in web2/proto/index.html. Two implementations of one tax
   calculation, on two sides of the wire. If they drift, a customer is quoted
   one price on their phone and charged another at the counter, and nothing in
   the app notices.

   A FIRST VERSION OF THIS TEST WAS THEATRE, and the way it failed is worth
   keeping: it posted an order to /p/:slug/order and compared only `total`.
   Prices are GST-INCLUSIVE, so total = goods + service — the GST split never
   enters it, and with the service charge at 0 neither does the service rate.
   Deliberately breaking orderBreakdown (GST added on top; service charged on
   the delivery fee) left all five cases passing. Comparing totals alone is
   blind to exactly the drift this is meant to catch.

   So both implementations are sliced out of the shipped files and run
   side by side over the whole breakdown — excl, gst, svc, total — across rates
   and order types, including a non-zero service charge and a delivery fee so
   every term is actually exercised. No server, no database, milliseconds.
*/
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

/* ── slice the till side out of the HTML ─────────────────────────────── */
const html = fs.readFileSync(path.join(ROOT, "web2", "proto", "index.html"), "utf8");
function sliceBody(src, name) {
  const start = src.indexOf(name + "(){");
  assert.notEqual(start, -1, `${name}() not found — renamed?`);
  let i = src.indexOf("{", start), depth = 0, j = i;
  for (;;) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) break; }
    j++;
  }
  return src.slice(i, j + 1);
}
const totalsFn = new Function("return function () " + sliceBody(html, "totals"))();

/* ── slice the server side out of index.js ───────────────────────────── */
const server = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
function sliceConst(src, name) {
  const m = new RegExp("const\\s+" + name + "\\s*=\\s*").exec(src);
  assert.ok(m, `${name} not found in index.js — renamed?`);
  let i = m.index + m[0].length, depth = 0, j = i, started = false;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === "{" || c === "(") { depth++; started = true; }
    else if (c === "}" || c === ")") depth--;
    else if (c === ";" && started && depth === 0) break;
  }
  return src.slice(i, j);
}
const orderBreakdown = new Function(
  "lineTotal", "orderSubtotal",
  "return " + sliceConst(server, "orderBreakdown"),
)(
  (l) => Math.round(Number(l.price) * Number(l.qty) * (1 - (Number(l.discPct) || 0) / 100)),
  null,
);
/* orderSubtotal is referenced inside orderBreakdown; rebuild it from the
   shipped source too rather than paraphrasing it. */
const orderSubtotalSrc = sliceConst(server, "orderSubtotal");
const realBreakdown = new Function(
  "lineTotal",
  "const orderSubtotal = " + orderSubtotalSrc + ";\nreturn " + sliceConst(server, "orderBreakdown"),
)((l) => Math.round(Number(l.price) * Number(l.qty) * (1 - (Number(l.discPct) || 0) / 100)));

/* ── the till side, same cart ────────────────────────────────────────── */
function tillL(cart, { gstBp, svcBp, orderType, feeMvr = 0 }) {
  const ctx = {
    state: {
      cart, discountPct: 0, orderType,
      deliveryZoneIx: feeMvr ? 0 : null,
      storeP: { gstBp, svcChargeBp: svcBp },
    },
    DZONES: feeMvr ? [{ fee: feeMvr }] : [],
    /* These mirror the SHIPPED rate()/scPct() exactly, including the fallback.
       An earlier stub returned 0 for gstBp:0 and manufactured a divergence
       that does not exist — the till's rate() only honours gstBp when it is
       > 0 and otherwise falls through to the sector default, and the server's
       `settings.gstBp || 800` lands on the same 8%. Both agree; the stub was
       wrong. (That they agree on 8% for a store that means ZERO is a separate,
       pre-existing limitation — neither side can express a GST-exempt store.
       It is noted in docs/reskin-plan.md, not silently fixed here.) */
    rate() { const sp = this.state.storeP; return sp && Number(sp.gstBp) > 0 ? Number(sp.gstBp) / 10000 : 8 / 100; },
    scPct() { const sp = this.state.storeP; return sp && sp.svcChargeBp != null ? Math.max(0, Number(sp.svcChargeBp) || 0) / 10000 : 0; },
  };
  return totalsFn.call(ctx).L;
}

const OTYPE = { dine: "dinein", take: "takeaway", delivery: "delivery" };

describe("guest quote equals till charge", () => {
  const CARTS = [
    [{ price: 3000, qty: 1 }],
    [{ price: 3000, qty: 2 }, { price: 3500, qty: 1 }],
    [{ price: 999, qty: 7 }],
    [{ price: 4500, qty: 3 }, { price: 1500, qty: 2 }, { price: 6500, qty: 1 }],
    [{ price: 3333, qty: 3 }],
  ];
  const RATES = [
    { gstBp: 800, svcBp: 0 },
    { gstBp: 800, svcBp: 1000 },
    { gstBp: 1600, svcBp: 1000 },
    { gstBp: 0, svcBp: 0 },
    { gstBp: 1700, svcBp: 500 },
  ];

  for (const [ci, items] of CARTS.entries()) {
    for (const [ri, rates] of RATES.entries()) {
      for (const otype of ["dine", "take"]) {
        test(`cart ${ci + 1} / rates ${ri + 1} / ${otype}: full breakdown matches`, () => {
          const settings = { gstBp: rates.gstBp, svcChargeBp: rates.svcBp };
          const srv = realBreakdown(
            { items: items.map((i) => ({ ...i, taxable: true })), otype: OTYPE[otype], fee: 0 },
            settings,
          );
          const till = tillL(items.map((i) => ({ unit: i.price / 100, qty: i.qty })), {
            gstBp: rates.gstBp, svcBp: rates.svcBp, orderType: otype,
          });
          const msg = ` server=${JSON.stringify(srv)} till=${JSON.stringify({ excl: till.excl, gst: till.gst, svc: till.svc, total: till.total })}`;
          assert.equal(srv.total, till.total, "total drift —" + msg);
          assert.equal(srv.gst, till.gst, "GST drift —" + msg);
          assert.equal(srv.svc, till.svc, "service-charge drift —" + msg);
          assert.equal(srv.excl, till.excl, "net-of-tax drift —" + msg);
        });
      }
    }
  }

  test("a delivery fee is taxed but never carries the service charge", () => {
    const items = [{ price: 10000, qty: 1, taxable: true }];
    const settings = { gstBp: 800, svcChargeBp: 1000 };
    const srv = realBreakdown({ items, otype: "delivery", fee: 4000 }, settings);
    const till = tillL([{ unit: 100, qty: 1 }], { gstBp: 800, svcBp: 1000, orderType: "delivery", feeMvr: 40 });
    assert.equal(srv.svc, 0, "delivery takes no service charge on the server");
    assert.equal(till.svc, 0, "delivery takes no service charge on the till");
    assert.equal(srv.total, till.total, `fee drift: server ${srv.total} vs till ${till.total}`);
  });
});
