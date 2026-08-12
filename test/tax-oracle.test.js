/* Regression suite for the TAX-MODEL ORACLE.

   Why this file exists: every other money check reconciles a sale against its
   own declared figures, which is exactly why the cross-surface tax divergence
   survived for months. The terminal added GST on top of a tax-inclusive
   catalogue price while the guest portal extracted it; each side satisfied
   `subtotal − discount + service + GST = total` perfectly, and the suite was
   green throughout. Self-consistency cannot catch a wrong model.

   `taxModelDivergence()` recomputes the basket from the CATALOGUE — the one
   input both surfaces share — prices it through the canonical `billTotals()`,
   and flags a total that matches the grossed-up model while missing the store's
   actual one.

   These tests do two jobs, and the second matters as much as the first:
     1. It catches the historical bug. A sale priced the old way is flagged.
     2. It does NOT fire on legitimate sales. A flag lands in a manager's review
        queue, so a noisy oracle is worse than none — most of this file is
        false-positive defence. */
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers");
const M = require("../web3/proto/money.js");

before(async () => { await H.startServer(); });
after(() => { H.stopServer(); });

const GST_BP = 800;                       // GGST 8%, the default a new store gets

/* Build a sale the honest way: priced through the shared billTotals(). */
function honestSale(id, basket, opts = {}) {
  const svc = opts.svcBp || 0;
  const b = M.billTotals({
    lines: basket.map((x) => ({ unit: x.price, qty: x.qty, disc: 0 })),
    gstBp: GST_BP, svcBp: svc, serviceApplies: svc > 0,
    billDiscPct: opts.billDiscPct || 0, feeLaari: opts.fee || 0,
  });
  const at = Date.now();
  return {
    id, no: id, at, t: at, total: b.total, subtotal: b.items, gst: b.gst,
    svcCharge: b.svc, billDisc: b.disc, billDiscPct: opts.billDiscPct || 0,
    fee: opts.fee || 0, tender: "cash",
    lines: basket.map((x, i) => ({ pid: x.pid, qty: x.qty, price: x.price, amount: b.lines[i] })),
    payments: [{ method: "cash", amount: b.total }],
  };
}

/* Re-price a sale the way the bug did: treat the tax-INCLUSIVE catalogue price
   as if it were net, then add GST on top.

   Built from first principles rather than by scaling an honest sale, because
   the fixture has to be INTERNALLY CONSISTENT — every component reconciling
   against every other — or it would trip the ordinary component checks and
   prove nothing. That self-consistency is precisely what let the real bug
   survive: only an independent recomputation can see it. */
function grossedUpSale(id, basket, opts = {}) {
  const r = GST_BP / 1e4;
  const sp = (opts.svcBp || 0) / 1e4;
  const lines = basket.map((x) => ({ pid: x.pid, qty: x.qty, price: x.price, amount: x.price * x.qty }));
  const items = lines.reduce((a, l) => a + l.amount, 0);       // treated as NET — the bug
  const svc = Math.round(items * sp);
  const gst = Math.round((items + svc) * r);                   // added ON TOP
  const at = Date.now();
  return {
    id, no: id, at, t: at,
    subtotal: items, billDisc: 0, billDiscPct: 0, svcCharge: svc, gst,
    total: items + svc + gst, fee: 0, tender: "cash", lines,
    payments: [{ method: "cash", amount: items + svc + gst }],
  };
}

/* Give the store a real service-charge rate. The oracle deliberately takes the
   RATE from the store, never from the sale — a sale must not be able to explain
   away its own discrepancy — so a service-charge fixture only means anything
   once the store actually has one configured. */
async function setServiceCharge(org, bp) {
  const r = await H.req("POST", "/api/app2/config", { cookie: org.cookie, body: { cfg: { svcChargeBp: bp } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}

async function seedStore(tag) {
  const org = await H.registerOrg({ tag });
  const catalogue = [
    { pid: "tp1", price: 11000 },      // the dish from the original incident
    { pid: "tp2", price: 4500 },
    { pid: "tp3", price: 2500 },
  ];
  const puts = catalogue.map((p) => ({ kind: "products", id: p.pid, data: { id: p.pid, name: "Dish " + p.pid, price: p.price, cat: 1 } }));
  assert.equal((await H.ops(org.token, [{ opId: tag + "-seed", puts }])).status, 200);
  return { org, catalogue };
}

const auditOf = async (org, sale) => {
  assert.equal((await H.ops(org.token, [{ opId: "op-" + sale.id, puts: [{ kind: "sales", id: sale.id, data: sale }] }])).status, 200);
  const e = await H.pullEntity(org.token, "sales", (x) => x.id === sale.id);
  return (e.data || {}).serverAudit || null;
};
const flaggedTaxModel = (audit) => !!(audit && (audit.reasons || []).some((r) => /tax model/.test(r)));

describe("tax-model oracle", () => {
  test("catches the original bug: GST added on top of a tax-inclusive price", async () => {
    const { org } = await seedStore("orc-bug");
    /* The incident, exactly: one dish at MVR 110.00. Honest total 11,000
       laari; the terminal charged 11,880. */
    const sale = grossedUpSale("s-bug", [{ pid: "tp1", price: 11000, qty: 1 }]);
    assert.equal(sale.total, 11880, "the fixture must reproduce the real symptom");

    const audit = await auditOf(org, sale);
    assert.ok(audit, "a grossed-up sale must be flagged");
    assert.ok(flaggedTaxModel(audit),
      "the oracle must name the tax model, not just a component mismatch: " + JSON.stringify(audit.reasons));
    assert.match(audit.reasons.join(" "), /11880/);
    assert.match(audit.reasons.join(" "), /11000/);
  });

  test("catches it across baskets and quantities", async () => {
    const { org } = await seedStore("orc-multi");
    const cases = [
      { id: "m1", basket: [{ pid: "tp2", price: 4500, qty: 3 }] },
      { id: "m2", basket: [{ pid: "tp1", price: 11000, qty: 1 }, { pid: "tp3", price: 2500, qty: 2 }] },
      { id: "m4", basket: [{ pid: "tp3", price: 2500, qty: 7 }] },
    ];
    for (const c of cases) {
      const audit = await auditOf(org, grossedUpSale(c.id, c.basket));
      assert.ok(flaggedTaxModel(audit), `${c.id} should be flagged: ` + JSON.stringify(audit && audit.reasons));
    }
  });

  test("catches it on a dine-in bill carrying the store's service charge", async () => {
    const { org } = await seedStore("orc-svc");
    await setServiceCharge(org, 1000);                       // 10%, on the STORE
    const audit = await auditOf(org, grossedUpSale("s1", [{ pid: "tp3", price: 2500, qty: 7 }], { svcBp: 1000 }));
    assert.ok(flaggedTaxModel(audit),
      "service charge must not give the wrong tax model cover: " + JSON.stringify(audit && audit.reasons));
  });

  /* ── false-positive defence ─────────────────────────────────────────── */

  test("does NOT fire on an honest sale", async () => {
    const { org } = await seedStore("orc-clean");
    await setServiceCharge(org, 1000);
    for (const [id, basket, opts] of [
      ["c1", [{ pid: "tp1", price: 11000, qty: 1 }], {}],
      ["c2", [{ pid: "tp2", price: 4500, qty: 2 }, { pid: "tp3", price: 2500, qty: 1 }], {}],
      ["c4", [{ pid: "tp2", price: 4500, qty: 3 }], { billDiscPct: 10 }],
      ["c5", [{ pid: "tp1", price: 11000, qty: 2 }], { fee: 3000 }],
      ["c6", [{ pid: "tp3", price: 2500, qty: 4 }], { svcBp: 1000 }],
    ]) {
      const audit = await auditOf(org, honestSale(id, basket, opts));
      assert.equal(flaggedTaxModel(audit), false,
        `${id} is priced through the canonical model and must not be flagged: ` + JSON.stringify(audit && audit.reasons));
    }
  });

  test("does NOT fire when add-ons legitimately raise a line above catalogue", async () => {
    const { org } = await seedStore("orc-addon");
    /* Modifiers are folded into the line price, so a legitimate sale can sit
       ABOVE the catalogue-only recomputation. That must not read as the bug. */
    const sale = honestSale("a1", [{ pid: "tp2", price: 4500, qty: 2 }]);
    const bump = M.billTotals({ lines: [{ unit: 5200, qty: 2, disc: 0 }], gstBp: GST_BP, svcBp: 0, serviceApplies: false });
    Object.assign(sale, { total: bump.total, subtotal: bump.items, gst: bump.gst,
      lines: [{ pid: "tp2", qty: 2, price: 5200, amount: bump.lines[0] }],
      payments: [{ method: "cash", amount: bump.total }] });

    const audit = await auditOf(org, sale);
    assert.equal(flaggedTaxModel(audit), false,
      "an add-on priced line is not a tax-model error: " + JSON.stringify(audit && audit.reasons));
  });

  test("stays silent when it cannot price the basket independently", async () => {
    const { org } = await seedStore("orc-bail");
    /* An unknown product id — the oracle has no catalogue price to reason from
       and must decline rather than guess. */
    const sale = grossedUpSale("b1", [{ pid: "not-in-catalogue", price: 9000, qty: 1 }]);
    const audit = await auditOf(org, sale);
    assert.equal(flaggedTaxModel(audit), false,
      "with no catalogue price the oracle must abstain, not guess");
  });

  test("the money-integrity path still never rejects a sale", async () => {
    /* The cashier has already taken the money. Flagging is the whole contract;
       refusing the write is not. */
    const { org } = await seedStore("orc-accept");
    const sale = grossedUpSale("keep", [{ pid: "tp1", price: 11000, qty: 1 }]);
    const r = await H.ops(org.token, [{ opId: "op-keep", puts: [{ kind: "sales", id: sale.id, data: sale }] }]);
    assert.equal(r.status, 200, "a flagged sale must still be accepted");
    const e = await H.pullEntity(org.token, "sales", (x) => x.id === "keep");
    assert.equal(e.data.total, 11880, "and stored exactly as the till sent it");
    assert.ok(e.data.serverAudit.flagged);
  });
});
