/* GUARD: the guest quote must equal the till charge.

   This is the test that was supposed to stop the worst money bug this system
   has had, and did not — because it compared web2/proto/index.html (a till that
   no longer serves any route) against orderBreakdown(). Both used the inclusive
   model, so it stayed green while the SHIPPED terminal (web3/proto/index.html)
   priced bills GST-EXCLUSIVE. A guest was quoted MVR 11,000 on their phone and
   charged MVR 11,880 at the counter for the identical dish — exactly the GST
   rate apart — and nothing noticed, because auditSaleMoney() only checks a sale
   against its own declared components, never against a canonical tax model.

   So this now pins the two implementations that actually run:
     · totals() sliced out of web3/proto/index.html   (what /v2 and /app serve)
     · orderBreakdown() sliced out of index.js        (what a QR guest is quoted)
   across GST rates, service charges, order types, discounts and a delivery fee,
   comparing the WHOLE breakdown — not just `total`, which is blind to a GST
   split that is wrong in both directions at once.

   Both delegate to web3/proto/money.js, so this is really asserting that the
   two adapters onto it stay honest. If someone reintroduces a second copy of
   the maths, this fails.
*/
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const M = require(path.join(ROOT, "web3", "proto", "money.js"));

/* ── the till side: the SHIPPED terminal ─────────────────────────────────── */
const html = fs.readFileSync(path.join(ROOT, "web3", "proto", "index.html"), "utf8");
function sliceBraces(src, sig) {
  const start = src.indexOf(sig);
  assert.notEqual(start, -1, `${sig} not found — renamed?`);
  let i = src.indexOf("{", start), depth = 0, j = i;
  for (;;) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) break; }
    j++;
  }
  return src.slice(i, j + 1);
}
const totalsFn = new Function("window", "K",
  "return function (tk, split) " + sliceBraces(html, "totals(tk, split) {"));

function tillQuote({ menu, gstBp, svcBp, lines, discPct, channel }) {
  const fn = totalsFn({ KPOS_MONEY: M }, () => ({ MENU: menu }));
  const self = { outlet: () => ({ rate: gstBp / 100, sc: svcBp / 100 }), menuPrice: (m) => m.price };
  return fn.call(self, { lines, discountPct: discPct, channel }).L;
}

/* ── the guest side: the SHIPPED server ──────────────────────────────────── */
const server = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
function sliceConst(name) {
  const i = server.indexOf("const " + name + " = ");
  assert.notEqual(i, -1, `${name} not found in index.js — renamed?`);
  const j = server.indexOf("\n};", i);
  return server.slice(i, j + 3);
}
const orderBreakdown = new Function("KPOS_MONEY", `
  const lineTotal = (l) => Math.round((Number(l.price) || 0) * (Number(l.qty) || Number(l.q) || 0));
  ${sliceConst("gstBpOf")}
  ${sliceConst("orderSubtotal")}
  ${sliceConst("orderBreakdown")}
  return orderBreakdown;`)(M);

describe("guest quote equals till charge", () => {
  test("the whole breakdown matches across the rate/service/type/discount matrix", () => {
    const cases = [];
    for (const gstBp of [0, 800, 1700]) {
      for (const svcBp of [0, 500, 1000]) {
        for (const channel of ["dine_in", "takeaway"]) {
          for (const discPct of [0, 5, 12.5, 33.3]) {
            for (const unit of [1, 777, 3333, 10000, 123456]) {
              for (const qty of [1, 3, 7]) {
                const menu = [{ id: "x", price: unit / 100 }];   // the till takes MVR
                const till = tillQuote({ menu, gstBp, svcBp, lines: [{ id: "x", qty }], discPct, channel });
                const guest = orderBreakdown(
                  { items: [{ price: unit, qty }], otype: channel === "dine_in" ? "dinein" : "takeaway",
                    discPct, fee: 0 },
                  { gstBp, svcChargeBp: svcBp });

                const where = JSON.stringify({ gstBp, svcBp, channel, discPct, unit, qty });
                assert.equal(till.total, guest.total, `total differs · ${where}`);
                assert.equal(till.gst, guest.gst, `GST differs · ${where}`);
                assert.equal(till.svc, guest.svc, `service differs · ${where}`);
                assert.equal(till.disc, guest.disc, `discount differs · ${where}`);
                assert.equal(till.items, guest.items, `subtotal differs · ${where}`);
                cases.push(1);
              }
            }
          }
        }
      }
    }
    assert.ok(cases.length >= 1000, `only ${cases.length} combinations compared`);
  });

  test("a delivery fee is taxed but never carries the service charge", () => {
    const guest = orderBreakdown(
      { items: [{ price: 10000, qty: 1 }], otype: "delivery", fee: 5000 },
      { gstBp: 800, svcChargeBp: 1000 });
    assert.equal(guest.svc, 0, "delivery takes no service charge");
    assert.equal(guest.total, 15000, "goods 100 + fee 50, both GST-inclusive");
    assert.ok(guest.gst > 0, "the fee is part of the taxable supply");
    assert.equal(guest.items + guest.fee - guest.disc + guest.svc + guest.gst, guest.total);
  });

  test("a GST-unregistered store is charged no GST on either surface", () => {
    // taxMap.none = 0 at onboarding. `Number(x || 800)` used to read that zero
    // as "absent" and substitute 8%, so a business that is not registered to
    // collect GST had it extracted, printed on receipts and posted to GST payable.
    const menu = [{ id: "x", price: 100 }];
    const till = tillQuote({ menu, gstBp: 0, svcBp: 1000, lines: [{ id: "x", qty: 1 }], discPct: 0, channel: "dine_in" });
    const guest = orderBreakdown({ items: [{ price: 10000, qty: 1 }], otype: "dinein" },
                                 { gstBp: 0, svcChargeBp: 1000 });
    assert.equal(till.gst, 0, "till charged GST to an unregistered store");
    assert.equal(guest.gst, 0, "guest portal charged GST to an unregistered store");
    assert.equal(till.total, guest.total);
  });

  test("a discounted guest order still satisfies the sale invariant", () => {
    // The settle path stores subtotal = items + fee alongside billDisc; pairing
    // a post-discount subtotal with billDisc subtracted the discount twice.
    for (const discPct of [0, 10, 25, 33.3]) {
      const b = orderBreakdown({ items: [{ price: 10000, qty: 2 }], otype: "dinein", discPct, fee: 0 },
                               { gstBp: 800, svcChargeBp: 1000 });
      const subtotal = b.items + b.fee;
      assert.equal(subtotal - b.disc + b.svc + b.gst, b.total, `discPct ${discPct}`);
    }
  });
});
