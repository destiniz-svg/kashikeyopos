/* Guard 5 of the re-skin contract (docs/reskin-plan.md).

   The re-skin must not move a single figure. Every total on every screen comes
   from totals() in web2/proto/index.html, and the panel layout the design
   supplies adds GST ON TOP — so a literal copy of its ticket would ship a tax
   bug. This test pins the arithmetic so that any drift shows up as a failing
   test rather than as a wrong bill.

   It runs the SHIPPED TEXT: totals() is sliced out of the HTML and executed
   with `new Function` against a stub `this` (the technique in CLAUDE.md), so it
   exercises what the till actually runs, not a retyped copy that can silently
   diverge. No database and no server — it is fast enough to run on every
   phase, which is the point.

   Invariant, in integer laari:  items − discount + fee + service + GST = total
*/
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "web2", "proto", "index.html");

/* Slice a method body out of the file by brace matching. */
function sliceMethod(src, name) {
  const start = src.indexOf(name + "(){");
  assert.notEqual(start, -1, `${name}() not found — did it get renamed?`);
  let i = src.indexOf("{", start), depth = 0, j = i;
  for (;;) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) break; }
    j++;
  }
  return src.slice(i, j + 1); // the { ... } body
}

const html = fs.readFileSync(SRC, "utf8");
const totalsFn = new Function("return function () " + sliceMethod(html, "totals"))();

/* The stub carries exactly what totals() reads: rate(), scPct(), DZONES and
   the slice of component state that feeds a bill. */
function makeCtx({ cart, discountPct = 0, orderType = "take", zoneIx = null, gstBp = 800, svcBp = 1000, zones = [] }) {
  return {
    state: { cart, discountPct, orderType, deliveryZoneIx: zoneIx, storeP: { gstBp, svcChargeBp: svcBp } },
    DZONES: zones,
    rate() { const sp = this.state.storeP; return sp && Number(sp.gstBp) > 0 ? Number(sp.gstBp) / 10000 : 0; },
    scPct() { const sp = this.state.storeP; return sp && sp.svcChargeBp != null ? Math.max(0, Number(sp.svcChargeBp) || 0) / 10000 : 0; },
  };
}
const totals = (opts) => totalsFn.call(makeCtx(opts));

/* Deterministic pseudo-random so a failure is reproducible from the seed. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

describe("money — totals() invariants (guard 5)", () => {
  test("an empty cart is all zeroes", () => {
    const L = totals({ cart: [] }).L;
    for (const k of Object.keys(L)) assert.equal(L[k], 0, `${k} should be 0`);
  });

  test("the bill balances across 20,000 randomised carts", () => {
    const r = rng(20260803);
    let checked = 0;
    for (let i = 0; i < 20000; i++) {
      const n = 1 + Math.floor(r() * 6);
      const cart = Array.from({ length: n }, () => ({
        unit: Math.round(r() * 20000) / 100,       // 0.00 – 200.00
        qty: 1 + Math.floor(r() * 5),
        disc: r() < 0.25 ? Math.floor(r() * 40) : 0,
      }));
      const delivery = r() < 0.3;
      const opts = {
        cart,
        discountPct: r() < 0.3 ? Math.floor(r() * 30) : 0,
        orderType: delivery ? "delivery" : r() < 0.5 ? "dine" : "take",
        zoneIx: delivery ? 0 : null,
        zones: [{ fee: Math.round(r() * 8000) / 100 }],
        gstBp: [0, 600, 800, 1600, 1700][Math.floor(r() * 5)],
        svcBp: [0, 500, 1000][Math.floor(r() * 3)],
      };
      const t = totals(opts);
      const L = t.L;

      for (const [k, v] of Object.entries(L)) {
        assert.ok(Number.isInteger(v), `seed case ${i}: ${k}=${v} is not an integer laari`);
      }
      assert.equal(
        L.items - L.disc + L.fee + L.svc + L.gst, L.total,
        `seed case ${i}: bill does not balance — ${JSON.stringify(L)} for ${JSON.stringify(opts)}`,
      );
      /* Lines must be the exact split of the goods subtotal: a sale's own lines
         have to add up to its subtotal with nothing left over. */
      assert.equal(
        t.lineL.reduce((a, v) => a + v, 0), L.items,
        `seed case ${i}: line amounts do not sum to items`,
      );
      assert.ok(L.total >= 0 && L.gst >= 0, `seed case ${i}: negative money`);
      checked++;
    }
    assert.equal(checked, 20000);
  });

  test("GST is EXTRACTED from an inclusive price, never added on top", () => {
    // One item at exactly 108.00 with 8% GST: the customer pays 108.00, and
    // 8.00 of that is tax. Adding on top would give 116.64 and be wrong.
    const t = totals({ cart: [{ unit: 108, qty: 1 }], orderType: "take", gstBp: 800, svcBp: 0 });
    assert.equal(t.L.total, 10800, "total must equal the menu price — prices are GST-inclusive");
    assert.equal(t.L.gst, 800, "GST must be the tax fraction of the inclusive amount");
    assert.equal(t.L.excl, 10000);
  });

  test("zero GST leaves the total untaxed and still balanced", () => {
    const t = totals({ cart: [{ unit: 50, qty: 3 }], orderType: "take", gstBp: 0, svcBp: 0 });
    assert.equal(t.L.gst, 0);
    assert.equal(t.L.total, 15000);
    assert.equal(t.L.items - t.L.disc + t.L.fee + t.L.svc + t.L.gst, t.L.total);
  });

  test("service charge applies to goods, not to the delivery fee", () => {
    const withFee = totals({
      cart: [{ unit: 100, qty: 1 }], orderType: "delivery", zoneIx: 0,
      zones: [{ fee: 40 }], gstBp: 800, svcBp: 1000,
    });
    assert.equal(withFee.L.svc, 0, "delivery orders take no service charge");
    assert.equal(withFee.L.total, 14000, "goods + fee, both GST-inclusive");
  });

  /* The balance invariant above CANNOT catch a bad line calculation: every
     figure derives from lineIncl, so a wrong lineIncl still balances against
     itself. That is the same tautology the day-end journal had before it was
     made capable of being wrong. These cases are an independent oracle —
     expected values computed by hand, not by the code under test. */
  test("line amounts are rounded once from the line, not from the unit price", () => {
    // 7 x 9.99 less 13% = 60.8391 -> 6084 laari, rounded ONCE from the line.
    // Rounding the unit first (999 x 7 = 6993) is a different, wrong answer.
    const t = totals({ cart: [{ unit: 9.99, qty: 7, disc: 13 }], orderType: "take", gstBp: 800, svcBp: 0 });
    assert.equal(t.L.total, 6084, "line must be rounded once, from the line itself");
    assert.equal(t.L.gst, 451, "GST is the tax fraction of 6084 at 8% inclusive");
    assert.equal(t.L.excl, 5633);
  });

  test("a fractional-laari unit price does not drift across quantity", () => {
    // 3 x 33.335 = 100.005 -> 10001 (banker-free round-half-up on the line).
    // Rounding the unit first gives 3334 x 3 = 10002.
    const t = totals({ cart: [{ unit: 33.335, qty: 3 }], orderType: "take", gstBp: 0, svcBp: 0 });
    assert.equal(t.L.total, 10001);
  });
});
