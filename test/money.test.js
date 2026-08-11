/* The bill-arithmetic guard.

   HISTORY — why this file was rewritten. It used to slice totals() out of
   web2/proto/index.html and pin that. But web2 stopped serving any route when
   /app and /v2 were both repointed at web3/proto/index.html, so this guard was
   aimed at dead code. It passed — 20,000 randomised carts, all green — while
   the terminal that actually took money had drifted to a GST-EXCLUSIVE model
   and was charging 8% (GGST) or 17% (TGST) more than the guest portal quoted
   for the same dish. A guard pointed at code nobody runs is worse than no
   guard, because it reads as coverage.

   It now runs the SHIPPED text: money.js (the single implementation) and
   totals() sliced out of web3/proto/index.html, the file /v2 and /app serve.

   THE MODEL: menu prices are GST-INCLUSIVE. GST is EXTRACTED as the tax
   fraction rate/(1+rate) of the inclusive amount — never added on top, never
   re-grossed off a rounded exclusive base.

   Invariant, exact in integer laari:  items − discount + fee + service + GST = total
*/
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const M = require(path.join(ROOT, "web3", "proto", "money.js"));

/* ── Slice the SHIPPED terminal's totals() and run it against a stub ──────── */
const html = fs.readFileSync(path.join(ROOT, "web3", "proto", "index.html"), "utf8");
function sliceMethod(src, sig) {
  const start = src.indexOf(sig);
  assert.notEqual(start, -1, `${sig} not found in the shipped terminal — renamed?`);
  let i = src.indexOf("{", start), depth = 0, j = i;
  for (;;) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) break; }
    j++;
  }
  return src.slice(i, j + 1);
}
const totalsBody = sliceMethod(html, "totals(tk, split) {");
const totalsFn = new Function("window", "K", "return function (tk, split) " + totalsBody);

/* The stub carries exactly what totals() reads: the outlet's tax profile, the
   menu, and window.KPOS_MONEY. */
function till({ menu, gstBp = 800, svcBp = 1000 }) {
  const K = () => ({ MENU: menu });
  const self = {
    outlet: () => ({ rate: gstBp / 100, sc: svcBp / 100 }),
    menuPrice: (m) => m.price,
  };
  const fn = totalsFn({ KPOS_MONEY: M }, K);
  return (tk, split) => fn.call(self, tk, split);
}

describe("money — the shipped terminal's totals()", () => {
  const menu = [{ id: "a", price: 100 }, { id: "b", price: 33.33 }, { id: "c", price: 7.77 }];
  const run = till({ menu });

  test("an empty cart is all zeroes", () => {
    const t = run({ lines: [] });
    for (const k of ["sub", "disc", "goods", "svc", "tax", "total"]) assert.equal(t[k], 0, k);
  });

  test("GST is EXTRACTED from an inclusive price, never added on top", () => {
    // One MVR 100 dish, GGST 8%, no service charge.
    const t = till({ menu, svcBp: 0 })({ lines: [{ id: "a", qty: 1 }] });
    assert.equal(t.total, 100, "the guest pays the menu price");
    assert.equal(t.L.gst, Math.round(10000 * 0.08 / 1.08), "GST is the tax fraction within");
    assert.equal(t.L.items + t.L.gst, 10000, "net + GST = the inclusive price");
  });

  test("service charge is inside the total, not bolted on after tax", () => {
    const t = run({ lines: [{ id: "a", qty: 1 }] });          // 8% GST, 10% service
    assert.equal(t.total, 110, "goods 100 + service 10, GST contained");
    assert.equal(t.L.total, 11000);
  });

  test("zero GST leaves the total untaxed and still balanced", () => {
    const t = till({ menu, gstBp: 0 })({ lines: [{ id: "a", qty: 2 }] });
    assert.equal(t.L.gst, 0);
    assert.equal(t.L.items - t.L.disc + t.L.fee + t.L.svc + t.L.gst, t.L.total);
  });

  test("the bill balances across 20,000 randomised carts", () => {
    let checked = 0;
    for (const gstBp of [0, 800, 1700]) {
      for (const svcBp of [0, 1000]) {
        const r = till({ menu, gstBp, svcBp });
        for (let i = 0; i < 3334; i++) {
          const n = 1 + Math.floor(Math.random() * 4);
          const lines = [];
          for (let k = 0; k < n; k++) {
            lines.push({ id: menu[Math.floor(Math.random() * menu.length)].id,
                         qty: 1 + Math.floor(Math.random() * 6),
                         disc: [0, 0, 0, 10, 25][Math.floor(Math.random() * 5)] });
          }
          const t = r({ lines, discountPct: [0, 0, 0, 5, 12.5][Math.floor(Math.random() * 5)] });
          const L = t.L;
          assert.equal(L.items - L.disc + L.fee + L.svc + L.gst, L.total,
            `invariant broke: ${JSON.stringify({ gstBp, svcBp, lines, L })}`);
          assert.ok(L.total >= 0 && L.gst >= 0 && L.svc >= 0, "no negative money");
          checked++;
        }
      }
    }
    assert.ok(checked >= 20000, `only ${checked} carts checked`);
  });

  test("line amounts are rounded once from the line, not from the unit price", () => {
    // 3 × 33.33 = 99.99, not 3 × round(33.33) = 99.00 or 100.
    const t = till({ menu, gstBp: 0, svcBp: 0 })({ lines: [{ id: "b", qty: 3 }] });
    assert.equal(t.L.total, 9999);
  });

  test("a fractional-laari unit price does not drift across quantity", () => {
    const r = till({ menu, gstBp: 0, svcBp: 0 });
    for (const qty of [1, 7, 13, 99, 1000]) {
      const t = r({ lines: [{ id: "c", qty }] });
      assert.equal(t.L.total, Math.round(777 * qty), `qty ${qty}`);
    }
  });

  test("per-line net amounts sum exactly to the subtotal", () => {
    const r = till({ menu });
    for (let i = 0; i < 500; i++) {
      const lines = Array.from({ length: 1 + Math.floor(Math.random() * 5) }, () => ({
        id: menu[Math.floor(Math.random() * menu.length)].id, qty: 1 + Math.floor(Math.random() * 5) }));
      const t = r({ lines });
      assert.equal(t.L.lines.reduce((a, v) => a + v, 0), t.L.items);
    }
  });
});

describe("money — money.js directly", () => {
  test("service charge applies to goods, never to the delivery fee", () => {
    const b = M.billTotals({ lines: [{ unit: 10000, qty: 1 }], gstBp: 800, svcBp: 1000,
                             feeLaari: 5000, serviceApplies: true });
    assert.equal(b.svc + M.taxWithin(1000, 0.08), 1000, "service is 10% of goods only");
    assert.equal(b.items - b.disc + b.fee + b.svc + b.gst, b.total);
  });

  test("takeaway carries no service charge", () => {
    const b = M.billTotals({ lines: [{ unit: 10000, qty: 1 }], gstBp: 800, svcBp: 1000,
                             serviceApplies: false });
    assert.equal(b.svc, 0);
    assert.equal(b.total, 10000);
  });

  test("a bill discount reduces goods before service and GST", () => {
    const b = M.billTotals({ lines: [{ unit: 10000, qty: 1 }], billDiscPct: 10,
                             gstBp: 800, svcBp: 1000, serviceApplies: true });
    assert.equal(b.total, 9900, "90 goods + 9 service");
    assert.equal(b.items - b.disc + b.fee + b.svc + b.gst, b.total);
  });
});
