/* Regression suite for the audited business rules (QA-01).
   Covers, by business risk: sync idempotency & ledger dedup, server-side money
   validation (FIN-01), credit-limit enforcement (FIN-02), the compliance-flags
   review API, stock-ledger consumption/refund, tenant isolation + auth, and the
   security controls (headers SEC-01, login throttle SEC-02).

   Black-box over the real HTTP API against a live server + Postgres (see
   helpers.js). Deterministic: each test uses its own freshly-registered org. */
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers");
const jwt = require("jsonwebtoken");
const FORGE_SECRET = "test-secret"; // matches helpers.js childEnv.JWT_SECRET

before(async () => { await H.startServer(); });
after(() => { H.stopServer(); });

/* ── Auth & tenant isolation ─────────────────────────────────────────── */
describe("auth & tenancy", () => {
  test("sync/admin endpoints reject unauthenticated requests", async () => {
    assert.equal((await H.req("GET", "/api/pull")).status, 401);
    assert.equal((await H.req("POST", "/api/ops", { body: { ops: [] } })).status, 401);
    assert.equal((await H.req("GET", "/api/inv/ingredients")).status, 401);
    assert.equal((await H.req("GET", "/api/inv/flags")).status, 401);
  });

  test("one org cannot read another org's data (RLS)", async () => {
    const a = await H.registerOrg({ tag: "iso-a" });
    const b = await H.registerOrg({ tag: "iso-b" });
    await H.ops(b.token, [{ opId: "b-secret", puts: [{ kind: "customers", id: "b-cust", data: { id: "b-cust", name: "ORGB-SECRET" } }] }]);
    const aPull = await H.pull(a.token, 0);
    const leaked = (aPull.json.entities || []).some((e) => JSON.stringify(e.data).includes("ORGB-SECRET"));
    assert.equal(leaked, false, "org A must not see org B's customer");
    const own = await H.until(async () =>
      (((await H.pull(b.token, 0)).json.entities || []).some((e) => JSON.stringify(e.data).includes("ORGB-SECRET"))) || null);
    assert.equal(own, true, "org B must see its own customer");
  });

  test("registration rejects a password below the minimum length (§3.5)", async () => {
    const short = await H.req("POST", "/api/register", {
      body: { email: H.uniqEmail("pwshort"), password: "abc123", storeName: "Weak", currency: "MVR", pin: "1234" },
    });
    assert.equal(short.status, 400, "a <8-char password must be rejected");
    // a compliant password still registers fine
    const okReg = await H.req("POST", "/api/register", {
      body: { email: H.uniqEmail("pwok"), password: "longenough1", storeName: "OK", currency: "MVR", pin: "1234" },
    });
    assert.equal(okReg.status, 200, "an ≥8-char password registers");
    assert.ok(okReg.json && okReg.json.token, "register returns a token");
  });
});

/* ── Sync idempotency ────────────────────────────────────────────────── */
describe("sync idempotency", () => {
  test("replaying the same opId does not duplicate the sale", async () => {
    const o = await H.registerOrg({ tag: "idem" });
    const op = { opId: "same-op", puts: [{ kind: "sales", id: "s1", data: { id: "s1", type: "sale", lines: [{ pid: "x", qty: 1 }], total: 100 } }] };
    for (let i = 0; i < 3; i++) await H.ops(o.token, [op]);
    const pull = await H.pull(o.token, 0);
    const sales = (pull.json.entities || []).filter((e) => e.kind === "sales" && e.id === "s1");
    assert.equal(sales.length, 1, "3x replay of one opId → exactly one sale");
  });

  test("pull returns only rows newer than the cursor", async () => {
    const o = await H.registerOrg({ tag: "cursor" });
    await H.ops(o.token, [{ opId: "c1", puts: [{ kind: "customers", id: "c-1", data: { id: "c-1", name: "First" } }] }]);
    /* Capture the cursor only once c-1 is actually visible. The never-skip
       visibility guard can transiently hide a freshly-committed row while an
       unrelated concurrent transaction holds the snapshot xmin down; capturing
       a cursor below c-1's rowver would then harmlessly (but non-deterministically)
       re-send c-1 on the next pull. Polling removes that race from the assertion. */
    const first = await H.until(async () => {
      const p = await H.pull(o.token, 0);
      return (p.json.entities || []).some((e) => e.id === "c-1") ? p : null;
    });
    const cursor = first.json.rowver;
    await H.ops(o.token, [{ opId: "c2", puts: [{ kind: "customers", id: "c-2", data: { id: "c-2", name: "Second" } }] }]);
    const second = await H.until(async () => {
      const p = await H.pull(o.token, cursor);
      return (p.json.entities || []).some((e) => e.id === "c-2") ? p : null;
    });
    const ids = (second.json.entities || []).map((e) => e.id);
    assert.ok(ids.includes("c-2"), "the newer customer is returned");
    assert.ok(!ids.includes("c-1"), "the older customer is not re-sent");
  });
});

/* ── FIN-01: server-side money validation ────────────────────────────── */
describe("money integrity (FIN-01)", () => {
  let o;
  before(async () => {
    o = await H.registerOrg({ tag: "money" });
    await H.ops(o.token, [{ opId: "seed-prod", puts: [{ kind: "products", id: "m-burger", data: { id: "m-burger", name: "Burger", price: 9500 } }] }]);
  });
  const flaggedIds = async () => (((await H.invGet(o.token, "/flags")).json || {}).sales || []).map((s) => s.id);
  const pushSale = (id, data) => H.ops(o.token, [{ opId: "op-" + id, puts: [{ kind: "sales", id, data: { id, type: "sale", ...data } }] }]);

  test("a tampered total is flagged, not silently trusted", async () => {
    await pushSale("m-tampered", { no: "INV-T", lines: [{ pid: "m-burger", qty: 1, price: 9500, taxable: true }], subtotal: 9500, gst: 760, total: 1 });
    assert.ok((await flaggedIds()).includes("m-tampered"));
  });
  test("an under-priced line (below catalogue) is flagged", async () => {
    await pushSale("m-underpriced", { no: "INV-U", lines: [{ pid: "m-burger", qty: 1, price: 1, taxable: true }], subtotal: 1, gst: 0, total: 1 });
    assert.ok((await flaggedIds()).includes("m-underpriced"));
  });
  /* Priced GST-INCLUSIVE, which is this app's decided model: a catalogue price
     of 9500 means the guest pays 9500, with 704 of GST contained in it.
     This fixture used to read subtotal 9500 / gst 760 / total 10260 — GST added
     ON TOP — and passed, because nothing checked the tax model. The oracle in
     taxModelDivergence() flags exactly that shape now, and it was right to:
     a sale like the old fixture overcharges the guest by 8%. */
  test("an honest sale is NOT flagged", async () => {
    await pushSale("m-honest", { no: "INV-H", lines: [{ pid: "m-burger", qty: 1, price: 9500, amount: 8796, discPct: 0, taxable: true }], subtotal: 8796, billDisc: 0, billDiscPct: 0, gst: 704, svcCharge: 0, fee: 0, total: 9500 });
    assert.ok(!(await flaggedIds()).includes("m-honest"));
  });
  /* Also GST-INCLUSIVE. 50% off a 9500 catalogue price is a 4750 bill containing
     352 of GST. This fixture read total 5130 — 4750 with 8% added on top — and
     survived the first version of the oracle only because that version ignored
     per-line discounts and so compared against the wrong baseline. Reading
     discPct is what exposed it. */
  test("a legitimately discounted line is NOT flagged", async () => {
    await pushSale("m-disc", { no: "INV-D", lines: [{ pid: "m-burger", qty: 1, price: 9500, amount: 4398, discPct: 50, taxable: true }], subtotal: 4398, billDisc: 0, billDiscPct: 0, gst: 352, svcCharge: 0, fee: 0, total: 4750 });
    assert.ok(!(await flaggedIds()).includes("m-disc"));
  });
  test("a free-of-charge sale (total 0) is NOT flagged", async () => {
    await pushSale("m-foc", { no: "INV-F", foc: true, focValue: 9500, lines: [{ pid: "m-burger", qty: 1, price: 9500 }], subtotal: 9500, total: 0 });
    assert.ok(!(await flaggedIds()).includes("m-foc"));
  });
});

/* ── FIN-02: credit-limit enforcement ────────────────────────────────── */
describe("credit limit (FIN-02)", () => {
  let o;
  /* Read the customer back by polling until the just-applied balance is
     visible. A single pull(since=0) can transiently miss a freshly-committed
     row while an unrelated concurrent transaction holds the snapshot xmin down
     (the same never-skip visibility guard the sync cursor relies on), which
     surfaced as a NaN balance under the suite's concurrent registration load.
     Polling for the expected value asserts the same behaviour without the race. */
  const balWhen = (id, bal) => H.until(async () => {
    const c = ((await H.pull(o.token, 0)).json.entities || []).find((e) => e.kind === "customers" && e.id === id);
    return c && Number(c.data.balance) === bal ? c.data : null;
  });
  before(async () => {
    o = await H.registerOrg({ tag: "credit" });
    await H.ops(o.token, [{ opId: "cust", puts: [{ kind: "customers", id: "cl-cust", data: { id: "cl-cust", name: "Credit Cust", balance: 0, creditLimit: 10000 } }] }]);
  });
  const credit = (opId, bal) => H.ops(o.token, [{ opId, puts: [], deltas: { cust: [{ id: "cl-cust", pts: 0, bal }] } }]);

  test("under the limit does not flag", async () => {
    await credit("cl-1", 6000);
    const d = await balWhen("cl-cust", 6000);
    assert.equal(d.creditOverLimit, false);
  });
  test("crossing the limit flags with the overage, balance still applied", async () => {
    await credit("cl-2", 6000); // 12000 > 10000
    const d = await balWhen("cl-cust", 12000); // money owed is recorded even over limit
    assert.equal(d.creditOverLimit, true);
    assert.equal(Number(d.creditOverBy), 2000);
  });
  test("paying back under the limit clears the flag", async () => {
    await credit("cl-3", -8000); // 4000 < 10000
    const d = await balWhen("cl-cust", 4000);
    assert.equal(d.creditOverLimit, false);
  });
  test("a customer with no limit is never flagged", async () => {
    await H.ops(o.token, [{ opId: "cust2", puts: [{ kind: "customers", id: "nolimit", data: { id: "nolimit", name: "No Limit", balance: 0, creditLimit: 0 } }] }]);
    await H.ops(o.token, [{ opId: "nl-1", puts: [], deltas: { cust: [{ id: "nolimit", pts: 0, bal: 999999 }] } }]);
    const d = await balWhen("nolimit", 999999);
    assert.equal(d.creditOverLimit, false);
  });
});

/* ── Compliance flags review API ─────────────────────────────────────── */
describe("compliance flags API", () => {
  test("lists flagged sales + over-limit customers, and ack clears them", async () => {
    const o = await H.registerOrg({ tag: "flags" });
    await H.ops(o.token, [{ opId: "fp", puts: [{ kind: "products", id: "fb", data: { id: "fb", name: "B", price: 9500 } }] }]);
    await H.ops(o.token, [{ opId: "fs", puts: [{ kind: "sales", id: "f-sale", data: { id: "f-sale", no: "INV-X", type: "sale", lines: [{ pid: "fb", qty: 1, price: 9500, taxable: true }], subtotal: 9500, gst: 760, total: 5 } }] }]);
    await H.ops(o.token, [{ opId: "fc", puts: [{ kind: "customers", id: "f-cust", data: { id: "f-cust", name: "Over", balance: 0, creditLimit: 5000 } }] }]);
    await H.ops(o.token, [{ opId: "fcd", puts: [], deltas: { cust: [{ id: "f-cust", pts: 0, bal: 9000 }] } }]);

    let flags = (await H.invGet(o.token, "/flags")).json;
    assert.ok(flags.sales.some((s) => s.id === "f-sale"), "flagged sale listed");
    assert.ok(flags.credit.some((c) => c.id === "f-cust"), "over-limit customer listed");

    assert.equal((await H.invPost({ cookie: o.cookie }, "/flags/sale/f-sale/ack", { by: "tester" })).status, 200);
    assert.equal((await H.invPost({ cookie: o.cookie }, "/flags/credit/f-cust/ack", { by: "tester" })).status, 200);

    flags = (await H.invGet(o.token, "/flags")).json;
    assert.ok(!flags.sales.some((s) => s.id === "f-sale"), "acked sale drops off");
    assert.ok(!flags.credit.some((c) => c.id === "f-cust"), "acked customer drops off");

    // acking an unknown flag 404s
    assert.equal((await H.invPost({ cookie: o.cookie }, "/flags/sale/nope/ack", {})).status, 404);
  });
});

/* ── Stock ledger consumption + refund ───────────────────────────────── */
describe("stock ledger", () => {
  test("a recipe sale deducts stock once; refund restores it", async () => {
    const o = await H.registerOrg({ tag: "stock" });
    // ingredient with 1000 ml on hand
    await H.invPost({ cookie: o.cookie }, "/ingredients", { id: "s-milk", name: "Milk", baseUnit: "ml", location: "Fridge" });
    await H.invPost({ cookie: o.cookie }, "/adjust", { ingredientId: "s-milk", mode: "correct", qty: 1000 });
    // a product that uses 200 ml per unit
    await H.ops(o.token, [{ opId: "sp", puts: [{ kind: "products", id: "s-latte", data: { id: "s-latte", name: "Latte", price: 5000 } }] }]);
    await H.invPut({ cookie: o.cookie }, "/recipes/s-latte", { lines: [{ ingredientId: "s-milk", qty: 200 }] });

    const stockOf = async (id) => {
      const list = (await H.invGet(o.token, "/ingredients")).json.ingredients || [];
      const i = list.find((x) => x.id === id);
      return i ? Number(i.current_stock) : null;
    };
    assert.equal(await stockOf("s-milk"), 1000, "opening stock");

    // sell 1 latte → 200 ml consumed
    const saleData = { id: "st-sale", type: "sale", lines: [{ pid: "s-latte", qty: 1, price: 5000, taxable: true }], subtotal: 5000, gst: 400, total: 5400 };
    await H.ops(o.token, [{ opId: "st-op", puts: [{ kind: "sales", id: "st-sale", data: saleData }] }]);
    await H.until(async () => (await stockOf("s-milk")) === 800);

    // replay the SAME sale under a NEW opId → ledger dedups on ref, no double deduction
    await H.ops(o.token, [{ opId: "st-op-2", puts: [{ kind: "sales", id: "st-sale", data: saleData }] }]);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await stockOf("s-milk"), 800, "duplicate sale must not deduct twice");

    // refund → 200 ml restored
    await H.ops(o.token, [{ opId: "rf-op", puts: [{ kind: "sales", id: "st-refund", data: { id: "st-refund", type: "refund", lines: [{ pid: "s-latte", qty: 1 }], total: 5400 } }] }]);
    await H.until(async () => (await stockOf("s-milk")) === 1000);
    assert.equal(await stockOf("s-milk"), 1000, "refund restores stock");
  });

  /* AUDIT-CRIT-OVERSELL gap fix: a till sale is never rejected for
     insufficient stock (offline resilience — the till can't do real-time
     locking either), so it can legitimately drive current_stock negative.
     That's accepted, but was previously silent. Prove it now surfaces via
     the same serverAudit/flags mechanism the money check already uses. */
  test("a till sale that oversells an ingredient is flagged for manager review, not silently allowed through", async () => {
    const o = await H.registerOrg({ tag: "oversell" });
    await H.invPost({ cookie: o.cookie }, "/ingredients", { id: "ov-bean", name: "Beans", baseUnit: "g", location: "Dry" });
    await H.invPost({ cookie: o.cookie }, "/adjust", { ingredientId: "ov-bean", mode: "correct", qty: 5 }); // only 5g on hand
    await H.ops(o.token, [{ opId: "ov-p", puts: [{ kind: "products", id: "ov-coffee", data: { id: "ov-coffee", name: "Coffee", price: 4000 } }] }]);
    await H.invPut({ cookie: o.cookie }, "/recipes/ov-coffee", { lines: [{ ingredientId: "ov-bean", qty: 10 }] }); // needs 10g/cup
    const saleData = { id: "ov-sale", type: "sale", no: "INV-OV", lines: [{ pid: "ov-coffee", qty: 1, price: 4000, taxable: true }], subtotal: 4000, gst: 320, total: 4320, payments: [{ method: "Cash", amount: 4320 }] };
    const push = await H.ops(o.token, [{ opId: "ov-op", puts: [{ kind: "sales", id: "ov-sale", data: saleData }] }]);
    assert.equal(push.status, 200, "the sale is accepted despite insufficient stock");
    const flagged = await H.until(async () => {
      const f = ((await H.invGet(o.token, "/flags")).json || {}).sales || [];
      const hit = f.find((s) => s.id === "ov-sale");
      return (hit && Array.isArray(hit.reasons) && hit.reasons.some((r) => /Oversold/.test(r))) ? hit : null;
    });
    assert.ok(flagged, "the oversold sale is flagged with an Oversold reason for the Payments > Review tab");
  });
});

/* ── AUDIT-MED-CONFLICT gap fix: a client is told when its own write lost a
   conflict, instead of the staleness guard silently keeping the newer stored
   copy with no signal — see the /api/ops handler's droppedWrites tracking. */
describe("conflict visibility (AUDIT-MED-CONFLICT)", () => {
  test("a stale push (older updatedAt) is reported back as dropped, not silently reverted", async () => {
    const o = await H.registerOrg({ tag: "conflict" });
    await H.ops(o.token, [{ opId: "cf-1", puts: [{ kind: "products", id: "cf-item", data: { id: "cf-item", name: "New Name", price: 1000, updatedAt: 2000 } }] }]);
    const r2 = await H.ops(o.token, [{ opId: "cf-2", puts: [{ kind: "products", id: "cf-item", data: { id: "cf-item", name: "Stale Name", price: 999, updatedAt: 1000 } }] }]);
    assert.equal(r2.status, 200);
    assert.ok(r2.json.dropped && r2.json.dropped.some((d) => d.kind === "products" && d.id === "cf-item"), "the stale push is reported as dropped");
    const cur = await H.pullEntity(o.token, "products", (e) => e.id === "cf-item");
    assert.equal(cur.data.name, "New Name", "the newer data is what's actually stored — the stale push never applied");
  });

  test("a normal (non-conflicting) push reports no drops", async () => {
    const o = await H.registerOrg({ tag: "conflict-ok" });
    const r = await H.ops(o.token, [{ opId: "cfo-1", puts: [{ kind: "products", id: "cfo-item", data: { id: "cfo-item", name: "Item", price: 500, updatedAt: 1000 } }] }]);
    assert.equal(r.status, 200);
    assert.equal(r.json.dropped, undefined, "no dropped field when nothing was overridden");
  });

  test("either side missing updatedAt still lets the incoming write through (unchanged fallback, not reported as dropped)", async () => {
    const o = await H.registerOrg({ tag: "conflict-nots" });
    await H.ops(o.token, [{ opId: "cfn-1", puts: [{ kind: "products", id: "cfn-item", data: { id: "cfn-item", name: "First" } }] }]);
    const r2 = await H.ops(o.token, [{ opId: "cfn-2", puts: [{ kind: "products", id: "cfn-item", data: { id: "cfn-item", name: "Second" } }] }]);
    assert.equal(r2.status, 200);
    assert.equal(r2.json.dropped, undefined, "the no-timestamp fallback always applies the incoming write, so there's nothing to report");
    const cur = await H.pullEntity(o.token, "products", (e) => e.id === "cfn-item");
    assert.equal(cur.data.name, "Second", "incoming still wins when neither side can be compared");
  });
});

/* ── Guest / QR orders + counter-modify linkage ──────────────────────── */
describe("guest orders & counter-modify", () => {
  let o;
  before(async () => {
    o = await H.registerOrg({ tag: "guest" });
    await H.ops(o.token, [{ opId: "gp", puts: [{ kind: "products", id: "g-tea", data: { id: "g-tea", name: "Tea", price: 3000 } }] }]);
  });
  const order = (body) => H.req("POST", `/p/${o.slug}/order`, { body });

  test("a QR order is created and syncs to the till as an order entity", async () => {
    const r = await order({ items: [{ pid: "g-tea", qty: 2 }], gtype: "pickup" });
    assert.equal(r.status, 200);
    assert.ok(r.json.order && r.json.order.no, "returns an order number");
    assert.equal(r.json.order.source, "qr");
    const id = r.json.order.id;
    await H.pullEntity(o.token, "orders", (e) => e.id === id); // wait until the QR order is visible to the till
    const orders = ((await H.pull(o.token, 0)).json.entities || []).filter((e) => e.kind === "orders" && e.id === id);
    assert.equal(orders.length, 1, "the order is pullable by the till");
    assert.equal(orders[0].data.status !== "completed", true, "starts open, not settled");
  });

  test("an empty cart is rejected", async () => {
    assert.equal((await order({ items: [], gtype: "pickup" })).status, 400);
  });
  test("a dine-in order with no table is rejected", async () => {
    assert.equal((await order({ items: [{ pid: "g-tea", qty: 1 }], gtype: "dinein" })).status, 400);
  });
  test("an order of only unknown (off-menu) items is rejected", async () => {
    assert.equal((await order({ items: [{ pid: "does-not-exist", qty: 1, name: "Hack", price: 0 }], gtype: "pickup" })).status, 400);
  });
  test("a mixed cart keeps only catalogue items, priced from the server", async () => {
    const r = await order({ items: [{ pid: "g-tea", qty: 1, price: 1 }, { pid: "off-menu", qty: 5, name: "Free", price: 0 }], gtype: "pickup" });
    assert.equal(r.status, 200);
    const lines = r.json.order.items;
    assert.equal(lines.length, 1, "the off-menu item is dropped");
    assert.equal(lines[0].pid, "g-tea");
    assert.equal(lines[0].price, 3000, "server catalogue price wins over the client's price");
  });
  test("a sold-out item (recipe at zero stock) is refused with 409", async () => {
    // an ingredient with no stock + a product that needs it → 0 servings available
    await H.invPost({ cookie: o.cookie }, "/ingredients", { id: "g-bean", name: "Beans", baseUnit: "g", location: "Dry" });
    await H.ops(o.token, [{ opId: "gc", puts: [{ kind: "products", id: "g-coffee", data: { id: "g-coffee", name: "Coffee", price: 4000 } }] }]);
    await H.invPut({ cookie: o.cookie }, "/recipes/g-coffee", { lines: [{ ingredientId: "g-bean", qty: 10 }] });
    assert.equal((await order({ items: [{ pid: "g-coffee", qty: 1 }], gtype: "pickup" })).status, 409);
  });
  test("an unknown workspace 404s", async () => {
    assert.equal((await H.req("POST", "/p/no-such-slug-xyz/order", { body: { items: [{ pid: "g-tea", qty: 1 }], gtype: "pickup" } })).status, 404);
  });

  /* issue #31: the sold-out check above reads a menu snapshot that can be
     stale by the time the request lands, so two guests can both pass it for
     the last unit. These prove the server now actually reserves stock (not
     just checks it) for the guest QR path, and frees the hold once the order
     is off the board — without touching the till's own never-reject-a-sale
     behaviour. */
  test("two concurrent QR orders for the last unit: only one succeeds (real reservation, not a snapshot check)", async () => {
    await H.invPost({ cookie: o.cookie }, "/ingredients", { id: "g-milk", name: "Milk", baseUnit: "ml", location: "Fridge" });
    await H.invPost({ cookie: o.cookie }, "/adjust", { ingredientId: "g-milk", mode: "correct", qty: 100 });
    await H.ops(o.token, [{ opId: "gl", puts: [{ kind: "products", id: "g-latte", data: { id: "g-latte", name: "Latte", price: 5000 } }] }]);
    await H.invPut({ cookie: o.cookie }, "/recipes/g-latte", { lines: [{ ingredientId: "g-milk", qty: 100 }] }); // exactly 1 serving in stock
    const [a, b] = await Promise.all([
      order({ items: [{ pid: "g-latte", qty: 1 }], gtype: "pickup" }),
      order({ items: [{ pid: "g-latte", qty: 1 }], gtype: "pickup" }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], "exactly one of the two racing orders is accepted");
  });

  test("a direct-stock (no-recipe) product is also protected from oversell", async () => {
    await H.ops(o.token, [{ opId: "gc2", puts: [{ kind: "products", id: "g-cake", data: { id: "g-cake", name: "Cake Slice", price: 2000, stock: 1 } }] }]);
    const [a, b] = await Promise.all([
      order({ items: [{ pid: "g-cake", qty: 1 }], gtype: "pickup" }),
      order({ items: [{ pid: "g-cake", qty: 1 }], gtype: "pickup" }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], "exactly one of the two racing orders for the last direct-stock unit is accepted");
  });

  test("settling a QR order frees its reservation for the next guest", async () => {
    await H.invPost({ cookie: o.cookie }, "/ingredients", { id: "g-egg", name: "Egg", baseUnit: "pcs", location: "Fridge" });
    await H.invPost({ cookie: o.cookie }, "/adjust", { ingredientId: "g-egg", mode: "correct", qty: 1 });
    await H.ops(o.token, [{ opId: "ge", puts: [{ kind: "products", id: "g-omelette", data: { id: "g-omelette", name: "Omelette", price: 3500 } }] }]);
    await H.invPut({ cookie: o.cookie }, "/recipes/g-omelette", { lines: [{ ingredientId: "g-egg", qty: 1 }] });
    const first = await order({ items: [{ pid: "g-omelette", qty: 1 }], gtype: "pickup" });
    assert.equal(first.status, 200);
    // the single egg is now held — a second order for it must be refused
    assert.equal((await order({ items: [{ pid: "g-omelette", qty: 1 }], gtype: "pickup" })).status, 409);
    const settle = await H.req("POST", `/api/app2/order/${first.json.order.id}/settle`, { cookie: o.cookie, body: { tender: "cash" } });
    assert.equal(settle.status, 200);
    // settle deducts real stock (down to 0), so a third order is still refused —
    // but by the real ingredient balance now, not a leftover hold.
    assert.equal((await order({ items: [{ pid: "g-omelette", qty: 1 }], gtype: "pickup" })).status, 409);
  });

  test("cancelling a QR order frees its reservation for the next guest", async () => {
    await H.invPost({ cookie: o.cookie }, "/ingredients", { id: "g-mango", name: "Mango", baseUnit: "pcs", location: "Fridge" });
    await H.invPost({ cookie: o.cookie }, "/adjust", { ingredientId: "g-mango", mode: "correct", qty: 1 });
    await H.ops(o.token, [{ opId: "gm", puts: [{ kind: "products", id: "g-smoothie", data: { id: "g-smoothie", name: "Mango Smoothie", price: 4500 } }] }]);
    await H.invPut({ cookie: o.cookie }, "/recipes/g-smoothie", { lines: [{ ingredientId: "g-mango", qty: 1 }] });
    const first = await order({ items: [{ pid: "g-smoothie", qty: 1 }], gtype: "pickup" });
    assert.equal(first.status, 200);
    assert.equal((await order({ items: [{ pid: "g-smoothie", qty: 1 }], gtype: "pickup" })).status, 409);
    const cancel = await H.req("POST", `/api/app2/order/${first.json.order.id}/status`, { cookie: o.cookie, body: { status: "cancelled" } });
    assert.equal(cancel.status, 200);
    // the mango is untouched (never actually deducted), so releasing the hold
    // lets a new order for it succeed again.
    assert.equal((await order({ items: [{ pid: "g-smoothie", qty: 1 }], gtype: "pickup" })).status, 200);
  });

  test("settling a modified order links the sale (srcOrderId) and completes the order", async () => {
    // Guest places an order…
    const placed = await order({ items: [{ pid: "g-tea", qty: 1 }], gtype: "pickup" });
    const orderId = placed.json.order.id;
    // …the till opens it at the counter, adds a second tea, and settles: it pushes
    // a sale stamped with srcOrderId and marks the source order completed (what
    // patches #132/#133 do client-side). The server must round-trip both, and its
    // money check must still run on the counter-modified sale.
    await H.ops(o.token, [
      { opId: "cm-sale", puts: [{ kind: "sales", id: "cm-sale", data: { id: "cm-sale", no: "INV-CM", type: "sale", srcOrderId: orderId,
        // GST-inclusive, like every other priced fixture: 2 x 3000 inclusive is
        // a 6000 bill containing 444 of GST — not 6000 + 480 on top.
        lines: [{ pid: "g-tea", qty: 2, price: 3000, amount: 5556, taxable: true }], subtotal: 5556, gst: 444, total: 6000, payments: [{ method: "Cash", amount: 6000 }] } }] },
      { opId: "cm-ord", puts: [{ kind: "orders", id: orderId, data: { id: orderId, status: "completed", saleId: "cm-sale", settledAtTill: true } }] },
    ]);
    const sale = await H.pullEntity(o.token, "sales", (e) => e.id === "cm-sale");
    const ord = await H.pullEntity(o.token, "orders", (e) => e.id === orderId);
    assert.equal(sale.data.srcOrderId, orderId, "sale is linked to the source order");
    assert.equal(ord.data.status, "completed", "source order is completed");
    // honest counter-modified sale must NOT be flagged
    const flagged = (((await H.invGet(o.token, "/flags")).json || {}).sales || []).some((s) => s.id === "cm-sale");
    assert.equal(flagged, false);
  });
});

/* ── Multi-store scoping ─────────────────────────────────────────────── */
describe("multi-store scoping", () => {
  let o;
  before(async () => {
    o = await H.registerOrg({ tag: "store" }); // default store: "main"
    // A product in each of two stores + a global (shared-kind) customer.
    await H.ops(o.token, [{ opId: "s-main", puts: [{ kind: "products", id: "p-main", data: { id: "p-main", name: "Main Item", price: 100, storeId: "main" } }] }]);
    await H.ops(o.token, [{ opId: "s-b2", puts: [{ kind: "products", id: "p-b2", data: { id: "p-b2", name: "Branch Item", price: 200, storeId: "branch2" } }] }]);
    await H.ops(o.token, [{ opId: "s-cust", puts: [{ kind: "customers", id: "shared-cust", data: { id: "shared-cust", name: "Shared" } }] }]);
  });
  const idsFor = async (store) => {
    const q = store ? `/api/pull?since=0&storeId=${store}` : "/api/pull?since=0";
    return ((await H.req("GET", q, { token: o.token })).json.entities || []).map((e) => e.kind + ":" + e.id);
  };

  test("a store-scoped product is visible only from its own store", async () => {
    // Wait for each store's product to become visible before asserting cross-store
    // isolation (a single pull can transiently miss it under concurrent xmin load).
    const main = await H.until(async () => { const m = await idsFor("main"); return m.includes("products:p-main") ? m : null; });
    const b2 = await H.until(async () => { const x = await idsFor("branch2"); return x.includes("products:p-b2") ? x : null; });
    assert.ok(main.includes("products:p-main"), "main store sees its product");
    assert.ok(!main.includes("products:p-b2"), "main store does NOT see branch2's product");
    assert.ok(b2.includes("products:p-b2"), "branch2 sees its product");
    assert.ok(!b2.includes("products:p-main"), "branch2 does NOT see main's product");
  });

  test("shared-kind entities (customers) are global to every store", async () => {
    assert.ok((await H.until(async () => (await idsFor("main")).includes("customers:shared-cust") || null)), "customer visible from main");
    assert.ok((await H.until(async () => (await idsFor("branch2")).includes("customers:shared-cust") || null)), "same customer visible from branch2");
  });
});

/* ── Operational hardening (API-01/02, FIN-03/04, OPS-02) ─────────────── */
describe("operational hardening", () => {
  test("OPS-02: every response carries a correlation id", async () => {
    assert.ok((await H.req("GET", "/api/health")).headers.get("x-request-id"));
  });

  test("API-01: malformed or oversized ops batches are rejected", async () => {
    const o = await H.registerOrg({ tag: "apival" });
    assert.equal((await H.req("POST", "/api/ops", { token: o.token, body: { ops: "nope" } })).status, 400);
    const big = Array.from({ length: 1001 }, (_, i) => ({ opId: "x" + i, puts: [] }));
    assert.equal((await H.req("POST", "/api/ops", { token: o.token, body: { ops: big } })).status, 413);
  });

  test("FIN-03: sensitive events are written to the append-only audit log", async () => {
    const o = await H.registerOrg({ tag: "audit" });
    await H.ops(o.token, [{ opId: "ap", puts: [{ kind: "products", id: "ab", data: { id: "ab", name: "B", price: 9500 } }] }]);
    await H.ops(o.token, [{ opId: "as", puts: [{ kind: "sales", id: "a-sale", data: { id: "a-sale", no: "INV-A", type: "sale", lines: [{ pid: "ab", qty: 1, price: 9500, taxable: true }], subtotal: 9500, gst: 760, total: 3 } }] }]);
    await H.ops(o.token, [{ opId: "ac", puts: [{ kind: "customers", id: "a-cust", data: { id: "a-cust", name: "Over", balance: 0, creditLimit: 5000 } }] }]);
    await H.ops(o.token, [{ opId: "acd", puts: [], deltas: { cust: [{ id: "a-cust", pts: 0, bal: 9000 }] } }]);
    // logActivity is fired post-commit (async), so poll until the events land.
    const acts = await H.until(async () => {
      const a = (await H.invGet(o.token, "/activity")).json.activity || [];
      return a.some((x) => x.action === "sale.flagged") && a.some((x) => x.action === "credit.over_limit") ? a : null;
    });
    assert.ok(acts.some((x) => x.action === "sale.flagged"), "money flag logged");
    assert.ok(acts.some((x) => x.action === "credit.over_limit"), "over-limit logged");
    await H.invPost({ cookie: o.cookie }, "/flags/sale/a-sale/ack", { by: "tester" });
    const acts2 = await H.until(async () => {
      const a = (await H.invGet(o.token, "/activity")).json.activity || [];
      return a.some((x) => x.action === "flag.ack") ? a : null;
    });
    assert.ok(acts2.some((x) => x.action === "flag.ack"), "ack logged");
  });

  test("FIN-04: GL export reconciles sales into journal totals", async () => {
    const o = await H.registerOrg({ tag: "gl" });
    await H.ops(o.token, [{ opId: "gp", puts: [{ kind: "products", id: "gb", data: { id: "gb", name: "B", price: 10000 } }] }]);
    await H.ops(o.token, [{ opId: "gs", puts: [{ kind: "sales", id: "g-sale", data: { id: "g-sale", no: "INV-G", type: "sale", t: Date.now(), lines: [{ pid: "gb", qty: 1, price: 10000, taxable: true }], subtotal: 10000, billDisc: 0, gst: 800, svcCharge: 0, total: 10800, payments: [{ method: "Cash", amount: 10800 }] } }] }]);
    const g = (await H.invGet(o.token, "/ledger-export")).json.journal;
    assert.equal(g.grossSales, 10000);
    assert.equal(g.gst, 800);
    assert.equal(g.netSales, 10000);
    assert.equal(g.tenders.Cash, 10800);
    assert.equal(g.saleCount, 1);
  });

  test("payments A+: ledger-export lists non-cash tenders with their references", async () => {
    const o2 = await H.registerOrg({ tag: "tender" });
    const mk = (id, method, ref) => ({ opId: "td-" + id, puts: [{ kind: "sales", id, data: {
      id, no: "INV-" + id, t: Date.now(), type: "sale", lines: [{ pid: "x", qty: 1, price: 5000 }],
      subtotal: 5000, gst: 0, total: 5000,
      payments: [{ method, amount: 5000, ...(ref ? { ref } : {}) }] } }] });
    await H.ops(o2.token, [mk("td1", "Card", "APPR-048291"), mk("td2", "Transfer", null), mk("td3", "Cash", null)]);
    const r = (await H.invGet(o2.token, "/ledger-export")).json;
    assert.equal(r.tenderDetail.length, 2, "only Card/QR/Transfer listed (Cash excluded)");
    const card = r.tenderDetail.find((t) => t.method === "Card");
    assert.equal(card.ref, "APPR-048291", "captured reference surfaces");
    assert.equal(card.saleNo, "INV-td1");
    assert.equal(r.tenderRefsMissing, 1, "the Transfer without a ref is counted as missing");
  });
});

/* ── Manager elevation for refunds (SEC-03) ──────────────────────────────
   Note: the wrong-password case adds one shared-IP throttle failure, but the
   suite ends with a SUCCESSFUL elevation, which clears the IP counter — so
   the security suite below still starts from a clean throttle state. */
describe("manager elevation (SEC-03)", () => {
  let o;
  before(async () => { o = await H.registerOrg({ tag: "elev" }); });

  test("an unapproved refund syncs but is flagged for review; forged approval is stripped", async () => {
    await H.ops(o.token, [{ opId: "el-r1", puts: [{ kind: "sales", id: "el-ref1", data: {
      id: "el-ref1", no: "INV-EL1", type: "refund", lines: [{ pid: "x", qty: 1 }], total: 1000,
      managerApproved: { forged: true },   // client-supplied approval must never be trusted
    } }] }]);
    const ref = await H.pullEntity(o.token, "sales", (e) => e.data && e.data.no === "INV-EL1"); // refund synced (never rejected)
    assert.ok(!ref.data.managerApproved, "forged client approval stripped");
    assert.ok(ref.data.serverAudit && ref.data.serverAudit.flagged, "flagged for review");
    assert.ok(ref.data.serverAudit.reasons.join(" ").includes("manager approval"), "reason names the missing approval");
    const flags = await H.invGet(o.token, "/flags");
    assert.ok((flags.json.sales || []).some((s) => s.no === "INV-EL1" || s.id === "el-ref1"), "surfaces in the Review feed");
  });

  test("the wrong password does not elevate", async () => {
    const r = await H.req("POST", "/api/elevate", { token: o.token, body: { password: "not-the-password" } });
    assert.equal(r.status, 401);
  });

  test("an elevated refund is stamped managerApproved and not flagged", async () => {
    const e = await H.req("POST", "/api/elevate", { token: o.token, body: { password: o.password } });
    assert.equal(e.status, 200, "correct store password elevates");
    assert.ok(e.json && e.json.elevation, "elevation token returned");
    await H.req("POST", "/api/ops", { token: o.token, headers: { "X-Elevation": e.json.elevation },
      body: { ops: [{ opId: "el-r2", puts: [{ kind: "sales", id: "el-ref2", data: {
        id: "el-ref2", no: "INV-EL2", type: "refund", lines: [{ pid: "x", qty: 1 }], total: 500 } }] }] } });
    const ref = await H.pullEntity(o.token, "sales", (x) => x.data && x.data.no === "INV-EL2");
    assert.ok(ref.data.managerApproved, "server stamped the approval");
    assert.equal(ref.data.managerApproved.method, "password");
    assert.ok(!ref.data.serverAudit, "approved refund is not flagged");
  });

  test("approval survives an unelevated re-push of the same refund", async () => {
    await H.ops(o.token, [{ opId: "el-r3", puts: [{ kind: "sales", id: "el-ref2", data: {
      id: "el-ref2", no: "INV-EL2", type: "refund", lines: [{ pid: "x", qty: 1 }], total: 500 } }] }]);
    const ref = await H.pullEntity(o.token, "sales", (x) => x.data && x.data.no === "INV-EL2");
    assert.ok(ref.data.managerApproved, "server-side approval carried forward");
    assert.ok(!ref.data.serverAudit, "still unflagged after re-push");
  });
});

/* ── Offline outbox & flaky-network sync (SYNC) ───────────────────────────
   The till's client queue is a durable localStorage outbox (kashikeyo-outbox)
   flushed to /api/ops on the `online` event with stable opIds. The bundle can't
   be driven headless here, so these exercise the exact wire contract that
   durable outbox relies on: a retried flush (dropped ack), a full offline-shift
   backlog flushed at reconnect, and an auth failure mid-sync. */
describe("offline outbox & flaky-network sync (SYNC)", () => {
  const salesOf = async (o, pred = () => true) =>
    ((await H.pull(o.token, 0)).json.entities || []).filter((e) => e.kind === "sales" && !e.deleted && pred(e));
  const stockOf = async (o, id) =>
    Number((((await H.pull(o.token, 0)).json.entities || []).find((e) => e.kind === "products" && e.id === id) || { data: {} }).data.stock);

  test("a retried flush (dropped ack) applies the sale + deducts stock exactly once", async () => {
    const o = await H.registerOrg({ tag: "sync-retry" });
    await H.ops(o.token, [{ opId: "sr-p", puts: [{ kind: "products", id: "sp", data: { id: "sp", name: "X", price: 1000, stock: 10 } }] }]);
    const flush = [{ opId: "sr-sale", puts: [{ kind: "sales", id: "srs", data: { id: "srs", type: "sale", lines: [{ pid: "sp", qty: 1 }], total: 1000 } }], deltas: { stock: [{ id: "sp", d: -1 }] } }];
    for (let i = 0; i < 3; i++) assert.equal((await H.ops(o.token, flush)).status, 200); // 3 identical retries
    // Assert on the snapshot the poll validated — re-reading separately can transiently
    // miss the row again while a concurrent tx holds xmin down (the never-skip guard).
    const s = await H.until(async () => {
      const sales = (await salesOf(o)).length, stock = await stockOf(o, "sp");
      return sales === 1 && stock === 9 ? { sales, stock } : null;
    });
    assert.equal(s.sales, 1, "one sale after 3 retries");
    assert.equal(s.stock, 9, "stock deducted exactly once");
  });

  test("a full offline-shift backlog flushes exactly once; a duplicated flush is a no-op", async () => {
    const o = await H.registerOrg({ tag: "sync-backlog" });
    await H.ops(o.token, [{ opId: "bk-p", puts: [{ kind: "products", id: "bp", data: { id: "bp", name: "B", price: 500, stock: 100 } }] }]);
    const N = 25;
    const batch = Array.from({ length: N }, (_, i) => ({ opId: "bk-" + i, puts: [{ kind: "sales", id: "bs" + i, data: { id: "bs" + i, type: "sale", lines: [{ pid: "bp", qty: 1 }], total: 500 } }], deltas: { stock: [{ id: "bp", d: -1 }] } }));
    assert.equal((await H.ops(o.token, batch)).status, 200); // reconnect: whole shift flushed at once
    const settle = () => H.until(async () => {
      const sales = (await salesOf(o)).length, stock = await stockOf(o, "bp");
      return sales === N && stock === 100 - N ? { sales, stock } : null;
    });
    const s1 = await settle();
    assert.equal(s1.sales, N, `all ${N} offline sales landed`);
    assert.equal(s1.stock, 100 - N, "stock deducted once per sale");
    assert.equal((await H.ops(o.token, batch)).status, 200); // duplicated flush (ack was lost)
    const s2 = await settle();
    assert.equal(s2.sales, N, "re-flush adds no duplicates");
    assert.equal(s2.stock, 100 - N, "re-flush does not double-deduct");
  });

  test("an auth failure mid-sync loses nothing; the retry after re-auth applies exactly once", async () => {
    const o = await H.registerOrg({ tag: "sync-auth" });
    const badToken = "eyJhbGciOiJIUzI1NiJ9.eyJvIjoieCJ9.bad-signature";
    const flush = [{ opId: "ax-1", puts: [{ kind: "sales", id: "axs", data: { id: "axs", type: "sale", lines: [{ pid: "z", qty: 1 }], total: 700 } }] }];
    // token expired/invalid during the flush → rejected, and nothing is applied
    assert.equal((await H.ops(badToken, flush)).status, 401);
    assert.equal((await salesOf(o, (e) => e.id === "axs")).length, 0, "a rejected flush persists nothing");
    // the durable outbox keeps the batch and retries it after re-auth → applies once
    assert.equal((await H.ops(o.token, flush)).status, 200);
    await H.until(async () => (await salesOf(o, (e) => e.id === "axs")).length === 1);
    assert.equal((await salesOf(o, (e) => e.id === "axs")).length, 1, "retry after re-auth applies the queued sale exactly once");
  });
});

/* ── Multi-terminal concurrency (LOAD) ────────────────────────────────────
   Software stand-in for a multi-device rig: many concurrent "terminals" hitting
   one org's /api/ops at once, plus the classic last-unit conflict. Proves the
   atomic stock delta has no lost updates and sync loses/duplicates nothing under
   contention. */
describe("multi-terminal concurrency (LOAD)", () => {
  test("8 terminals × 15 sales concurrently: every sale lands once, stock stays exact", async () => {
    const o = await H.registerOrg({ tag: "multi" });
    await H.ops(o.token, [{ opId: "mt-p", puts: [{ kind: "products", id: "mp", data: { id: "mp", name: "M", price: 1000, stock: 1000 } }] }]);
    const TERMINALS = 8, PER = 15, total = TERMINALS * PER;
    await Promise.all(Array.from({ length: TERMINALS }, (_, t) => (async () => {
      for (let n = 0; n < PER; n++) {
        assert.equal((await H.ops(o.token, [{ opId: `mt-${t}-${n}`, puts: [{ kind: "sales", id: `ms-${t}-${n}`, data: { id: `ms-${t}-${n}`, type: "sale", lines: [{ pid: "mp", qty: 1 }], total: 1000 } }], deltas: { stock: [{ id: "mp", d: -1 }] } }])).status, 200);
      }
    })()));
    const settled = await H.until(async () => {
      const ents = (await H.pull(o.token, 0)).json.entities || [];
      const sales = ents.filter((e) => e.kind === "sales" && !e.deleted).length;
      const prod = ents.find((e) => e.kind === "products" && e.id === "mp");
      const stock = prod ? Number(prod.data.stock) : NaN;
      return sales === total && stock === 1000 - total ? { sales, stock } : null;
    }, { timeout: 10000 });
    assert.equal(settled.sales, total, "no sale lost or duplicated under concurrency");
    assert.equal(settled.stock, 1000 - total, "stock deducted exactly once per concurrent sale (no lost updates)");
  });

  test("two terminals sell the final unit at once: both recorded, stock floors at 0 (never negative)", async () => {
    const o = await H.registerOrg({ tag: "lastunit" });
    await H.ops(o.token, [{ opId: "lu-p", puts: [{ kind: "products", id: "lp", data: { id: "lp", name: "L", price: 1, stock: 1 } }] }]);
    await Promise.all([
      H.ops(o.token, [{ opId: "lu-A", puts: [{ kind: "sales", id: "lsA", data: { id: "lsA", type: "sale", lines: [{ pid: "lp", qty: 1 }], total: 1 } }], deltas: { stock: [{ id: "lp", d: -1 }] } }]),
      H.ops(o.token, [{ opId: "lu-B", puts: [{ kind: "sales", id: "lsB", data: { id: "lsB", type: "sale", lines: [{ pid: "lp", qty: 1 }], total: 1 } }], deltas: { stock: [{ id: "lp", d: -1 }] } }]),
    ]);
    const settled = await H.until(async () => {
      const ents = (await H.pull(o.token, 0)).json.entities || [];
      const sales = ents.filter((e) => e.kind === "sales" && !e.deleted).length;
      const prod = ents.find((e) => e.kind === "products" && e.id === "lp");
      const stock = prod ? Number(prod.data.stock) : NaN;
      return sales === 2 && stock === 0 ? { sales, stock } : null;
    });
    assert.equal(settled.sales, 2, "both offline sales recorded (never silently rejected)");
    assert.equal(settled.stock, 0, "stock floors at 0, never negative");
  });
});

/* ── Device pairing: second factor for PIN back-office login (AUDIT-SEC-PIN) ─
   Issue #30. PIN login (/api/back/login) is a real back-office session grant,
   not just the offline till's fast operator switch — a browser must now also
   carry a device cookie previously proven with the owner's email + password
   (/api/back/pair) before a PIN is even checked. Runs BEFORE the security
   suite below, which deliberately exhausts and leaves blocked the shared
   per-IP login throttle these endpoints also use — see that suite's comment. */
describe("device pairing (AUDIT-SEC-PIN)", () => {
  const setCookieVal = (r, name) => {
    const raw = r.headers.get("set-cookie") || "";
    const m = raw.match(new RegExp(name + "=([^;]+)"));
    return m ? name + "=" + m[1] : null;
  };
  let o, staffPin;
  before(async () => {
    o = await H.registerOrg({ tag: "pairing" });
    staffPin = "5566";
    const st = await H.req("POST", "/api/app2/staff", { cookie: o.cookie, body: { name: "Manager Mo", role: "manager", pin: staffPin } });
    assert.equal(st.status, 200, "test setup: staff member created");
  });

  test("PIN login from an unpaired browser is refused with needsPairing, before the PIN is even checked", async () => {
    const r = await H.req("POST", "/api/back/login", { body: { slug: o.slug, pin: staffPin } });
    assert.equal(r.status, 403);
    assert.equal(r.json.needsPairing, true);
    // A WRONG pin from the same unpaired browser gets the identical response —
    // pairing is checked first, so no PIN-guessing signal leaks either way.
    const r2 = await H.req("POST", "/api/back/login", { body: { slug: o.slug, pin: "0000" } });
    assert.equal(r2.status, 403);
    assert.equal(r2.json.needsPairing, true);
  });

  test("pairing requires the real owner password, not just a valid-looking one", async () => {
    const bad = await H.req("POST", "/api/back/pair", { body: { slug: o.slug, email: o.email, password: "totally-wrong" } });
    assert.equal(bad.status, 401);
    assert.equal(setCookieVal(bad, "kashikeyo_device"), null, "no device cookie minted on a failed pair attempt");
  });

  test("full flow: pair with the owner password, then PIN login succeeds and is remembered", async () => {
    const pair = await H.req("POST", "/api/back/pair", { body: { slug: o.slug, email: o.email, password: o.password } });
    assert.equal(pair.status, 200);
    const deviceCookie = setCookieVal(pair, "kashikeyo_device");
    assert.ok(deviceCookie, "device cookie minted on successful pairing");

    // Same browser (device cookie), correct PIN → real back-office session.
    const login = await H.req("POST", "/api/back/login", { cookie: deviceCookie, body: { slug: o.slug, pin: staffPin } });
    assert.equal(login.status, 200, "paired device + correct PIN succeeds");
    assert.equal(login.json.role, "manager");
    const sessionCookie = setCookieVal(login, "kashikeyo_session");
    assert.ok(sessionCookie, "back-office session cookie issued");

    // A DIFFERENT (unpaired) browser with the SAME PIN is still refused —
    // pairing is per-device, not a store-wide unlock.
    const otherBrowser = await H.req("POST", "/api/back/login", { body: { slug: o.slug, pin: staffPin } });
    assert.equal(otherBrowser.status, 403);
    assert.equal(otherBrowser.json.needsPairing, true, "pairing does not leak across browsers");

    // The paired device shows up in the admin's device list — managing
    // pairings needs ADMIN rank (same threshold as /api/app2/sessions), so
    // this uses the owner's own session (o.cookie), not the manager's.
    const list = await H.req("GET", "/api/app2/devices", { cookie: o.cookie + "; " + deviceCookie });
    assert.equal(list.status, 200);
    assert.equal(list.json.devices.length, 1);
    assert.equal(list.json.devices[0].current, true);

    // …and revoking it locks the device back out, requiring re-pairing.
    const revoke = await H.req("POST", "/api/app2/devices/revoke", { cookie: o.cookie, body: { deviceId: list.json.devices[0].deviceId } });
    assert.equal(revoke.status, 200);
    const afterRevoke = await H.req("POST", "/api/back/login", { cookie: deviceCookie, body: { slug: o.slug, pin: staffPin } });
    assert.equal(afterRevoke.status, 403);
    assert.equal(afterRevoke.json.needsPairing, true, "a revoked device must re-pair, even with the right PIN");
  });

  test("listing/revoking paired devices needs admin rank, not just any back-office session", async () => {
    const orgId = jwt.decode(o.cookie.split("=")[1])?.o;
    const cashierCookie = "kashikeyo_session=" + jwt.sign({ o: orgId, role: "cashier" }, FORGE_SECRET);
    const r = await H.req("GET", "/api/app2/devices", { cookie: cashierCookie });
    assert.equal(r.status, 403, "cashier rank cannot manage paired devices");
  });
});

/* ── The kitchen holds a terminal session (KDS-ROLE) ─────────────────────────
   The Kitchen Display is a /v2 screen and exists nowhere else, so refusing the
   kitchen role a terminal session left the one role whose whole job is the pass
   with no way to reach it. It signs in now — and gets the narrowest session in
   the building: the terminal draws one nav item, and the page ships that rank
   the tickets and the food and nothing else. Placed with the pairing suite,
   BEFORE the security suite below leaves this IP's login throttle blocked. */
describe("kitchen display session (KDS-ROLE)", () => {
  const setCookieVal = (r, name) => {
    const raw = r.headers.get("set-cookie") || "";
    const m = raw.match(new RegExp(name + "=([^;]+)"));
    return m ? name + "=" + m[1] : null;
  };
  const realOf = (html) => {
    const m = String(html).match(/window\.KPOS_REAL=(\{[\s\S]*?\});window\.KPOS_BUILD/);
    return m ? JSON.parse(m[1]) : null;
  };
  let o, kitchenCookie;

  before(async () => {
    o = await H.registerOrg({ tag: "kdsrole" });
    for (const [name, role, pin] of [["Cook Ali", "kitchen", "5150"], ["Till Sana", "cashier", "5151"]]) {
      const st = await H.req("POST", "/api/app2/staff", { cookie: o.cookie, body: { name, role, pin } });
      assert.equal(st.status, 200, "test setup: " + role + " created");
    }
    const pair = await H.req("POST", "/api/back/pair", { body: { slug: o.slug, email: o.email, password: o.password } });
    assert.equal(pair.status, 200, "test setup: device paired");
    const device = setCookieVal(pair, "kashikeyo_device");
    const login = await H.req("POST", "/api/back/login", { cookie: device, body: { slug: o.slug, pin: "5150" } });
    assert.equal(login.status, 200, "a kitchen PIN opens a terminal session");
    assert.equal(login.json.role, "kitchen");
    kitchenCookie = setCookieVal(login, "kashikeyo_session");
    assert.ok(kitchenCookie, "the kitchen sign-in carries a session cookie");
  });

  test("the page ships a kitchen rank the tickets and the food, and nothing else", async () => {
    const page = await H.req("GET", "/v2", { cookie: kitchenCookie });
    const real = realOf(page.text);
    assert.ok(real, "the terminal hydrates for a kitchen session");
    // What the pass needs.
    assert.ok(Array.isArray(real.menu), "the menu is present — a ticket names dishes");
    assert.equal(real.me.roleKey, "kitchen");
    // What it does not. These are not merely hidden by the UI: a shared screen
    // in the least private room in the building never receives them at all.
    // `orders` is the closed-sales list: receipts, totals, tenders, guest names.
    // The kitchen has the orders board, which runs on liveOrders — the work in
    // progress — and must never carry the day's takings alongside it.
    for (const k of ["orders", "customers", "staff", "expenses", "settlements", "assets"]) {
      assert.deepEqual(real[k], [], k + " is empty for a kitchen session");
    }
    assert.equal(real.stats.net, 0, "takings are not a fact a pass screen is told");
    assert.deepEqual(real.inventory.items, [], "stock is not shipped to the pass");
    for (const k of ["fiscal", "portal", "loyalty", "promos", "email"]) {
      assert.equal(real[k], undefined, k + " is withheld from a kitchen session");
    }
    // An EMPTY array, never a missing key: kashikeyo-data.js only replaces its
    // demo seed when the real key is present, so a deleted key would leave the
    // seeded demo roster standing on screen in place of the real one.
    assert.ok(Object.prototype.hasOwnProperty.call(real, "customers"), "the key is present and empty, not absent");
  });

  test("receipt history is refused to a kitchen rank at the endpoint too", async () => {
    // The page inject withholds it; this endpoint is the same data by another
    // door, and it only ever asked for a session.
    const hist = await H.req("GET", "/api/app2/orders?limit=20", { cookie: kitchenCookie });
    assert.equal(hist.status, 403, "the pass cannot pull the receipt history");
    const mine = await H.req("GET", "/api/app2/orders?limit=20", { cookie: o.cookie });
    assert.equal(mine.status, 200, "the owner still can");
  });

  test("a till session is untouched by the kitchen trim", async () => {
    const pair = await H.req("POST", "/api/back/pair", { body: { slug: o.slug, email: o.email, password: o.password } });
    const device = setCookieVal(pair, "kashikeyo_device");
    const login = await H.req("POST", "/api/back/login", { cookie: device, body: { slug: o.slug, pin: "5151" } });
    assert.equal(login.status, 200);
    const page = await H.req("GET", "/v2", { cookie: setCookieVal(login, "kashikeyo_session") });
    const real = realOf(page.text);
    assert.ok(real.fiscal, "a cashier still gets the fiscal block (it prints receipts)");
    assert.ok(real.stats, "a cashier still gets the figures the till shows");
  });

  test("the kitchen can bump a ticket but cannot settle it or touch the roster", async () => {
    const kot = await H.req("POST", "/api/app2/kot", { cookie: o.cookie, body: {
      items: [{ pid: "p1", name: "Margherita", qty: 2, price: 11000, station: "hot" }],
      table: "4", otype: "dine_in", station: "hot", billNo: "B-1", userName: "Owner" } });
    assert.equal(kot.status, 200, "test setup: a ticket is fired from the till");
    const id = kot.json.id;
    const bump = await H.req("POST", "/api/app2/order/" + id + "/status", { cookie: kitchenCookie, body: { status: "ready" } });
    assert.equal(bump.status, 200, "bumping a ticket is the job");
    const settle = await H.req("POST", "/api/app2/order/" + id + "/settle", { cookie: kitchenCookie, body: { tender: "cash" } });
    assert.equal(settle.status, 403, "taking the money is not");
    const staff = await H.req("POST", "/api/app2/staff", { cookie: kitchenCookie, body: { name: "Sneak", role: "manager", pin: "9999" } });
    assert.equal(staff.status, 403, "nor is minting a manager");
  });
});

/* ── A new outlet trades on its own books (OUTLET-SCOPE) ─────────────────────
   The /v2 payload is built per ORG, so it carries every outlet's live tickets
   and receipts. Nothing said which outlet a row belonged to, so a newly created
   branch drew the main store's QR tables as occupied on its own floor and
   listed its receipts as its own history. Rows now carry `store`, the terminal
   filters on it, and the paged history is scoped in SQL. */
describe("outlet scoping (OUTLET-SCOPE)", () => {
  const setCookieVal = (r, name) => {
    const raw = r.headers.get("set-cookie") || "";
    const m = raw.match(new RegExp(name + "=([^;]+)"));
    return m ? name + "=" + m[1] : null;
  };
  const realOf = (html) => {
    const m = String(html).match(/window\.KPOS_REAL=(\{[\s\S]*?\});window\.KPOS_BUILD/);
    return m ? JSON.parse(m[1]) : null;
  };
  let o, branchCookie, branchStoreId;

  before(async () => {
    o = await H.registerOrg({ tag: "outletscope" });
    // Trade at the main store: one open ticket and one settled sale.
    const kot = await H.req("POST", "/api/app2/kot", { cookie: o.cookie, body: {
      items: [{ pid: "p1", name: "Margherita", qty: 2, price: 11000, station: "hot" }],
      table: "4", otype: "dine_in", station: "hot", billNo: "B-1", userName: "Owner" } });
    assert.equal(kot.status, 200, "test setup: ticket fired at the main store");
    await H.ops(o.token, [{ opId: "os1", puts: [{ kind: "sales", id: "sale-main", data: {
      id: "sale-main", no: "INV-MAIN", at: Date.now(), total: 11000, subtotal: 10185, gst: 815,
      lines: [{ pid: "p1", qty: 1, price: 11000, amount: 10185 }], payments: [{ method: "cash", amount: 11000 }], table: 4 } }] }]);
    const mk = await H.req("POST", "/api/app2/outlets", { cookie: o.cookie,
      body: { name: "Hulhumale Branch", code: "HUL", kind: "restaurant", tables: 6, seats: 24 } });
    assert.equal(mk.status, 200, "test setup: second outlet created");
    branchStoreId = mk.json.outlet.id;
  });

  test("every ticket and receipt names the outlet that rang it", async () => {
    const page = await H.req("GET", "/v2", { cookie: o.cookie });
    const real = realOf(page.text);
    assert.ok(real, "the terminal hydrates");
    assert.ok((real.liveOrders || []).length >= 1, "the fired ticket is in the payload");
    for (const row of real.liveOrders) assert.equal(row.store, "main", "a live ticket carries its store");
    for (const row of real.orders) assert.equal(row.store, "main", "a receipt carries its store");
    assert.equal(real.me.storeId, "main", "the payload says which outlet the session is bound to");
  });

  test("switching outlet re-binds the session, so the next sale banks to the branch", async () => {
    const sw = await H.req("POST", "/api/app2/outlet", { cookie: o.cookie, body: { storeId: branchStoreId } });
    assert.equal(sw.status, 200);
    branchCookie = setCookieVal(sw, "kashikeyo_session");
    assert.ok(branchCookie, "the switch re-mints the session cookie");
    const page = await H.req("GET", "/v2", { cookie: branchCookie });
    const real = realOf(page.text);
    assert.equal(real.me.storeId, branchStoreId, "the session now names the branch");
    // The payload still carries the company's rows — scoping is by `store`, not
    // by withholding — and every one of them still says "main", which is what
    // lets the terminal keep them off the branch's floor.
    for (const row of (real.liveOrders || [])) assert.equal(row.store, "main");
    // The branch's own floor config, not the main store's.
    const mine = (real.outlets || []).filter((x) => x.storeId === branchStoreId)[0];
    assert.equal(mine.tables, 6, "the branch renders its own table count");
  });

  test("the paged receipt history is the outlet's own, not the company's", async () => {
    const mainPage = await H.req("GET", "/api/app2/orders?limit=50", { cookie: o.cookie });
    assert.equal(mainPage.status, 200);
    assert.ok(mainPage.json.orders.some((x) => x.no === "INV-MAIN"), "the main store sees its own sale");
    const branchPage = await H.req("GET", "/api/app2/orders?limit=50", { cookie: branchCookie });
    assert.equal(branchPage.status, 200);
    assert.equal(branchPage.json.orders.length, 0, "a branch that has never traded has no history");
  });
});

/* ── Security controls (run last: the throttle test blocks this IP) ───── */

describe("flagged-sale reporting (FIN-1)", () => {
  test("ledger-export segregates money-audit-flagged sales into a variance line", async () => {
    const o = await H.registerOrg({ tag: "flag" });
    await H.ops(o.token, [{ opId: "fp", puts: [
      { kind: "settings", id: "settings", data: { id: "settings", gstBp: 800, svcChargeBp: 0 } },
      { kind: "products", id: "fb", data: { id: "fb", name: "Burger", price: 10000 } },
    ] }]);
    // an honest sale (not flagged) …
    // GST-inclusive: a 10000 catalogue price is a 10000 bill containing 741 of GST.
    await H.ops(o.token, [{ opId: "fs1", puts: [{ kind: "sales", id: "fclean", data: { id: "fclean", no: "C1", type: "sale", subtotal: 9259, gst: 741, billDisc: 0, svcCharge: 0, total: 10000, lines: [{ pid: "fb", qty: 1, price: 10000, amount: 9259 }], payments: [{ method: "cash", amount: 10000 }], gstBp: 800, t: Date.now() } }] }]);
    // … and a tampered under-ring: honest lines/subtotal/gst but a total slashed
    // to 100 (vs components 10800) → server flags it, and the variance surfaces.
    await H.ops(o.token, [{ opId: "fs2", puts: [{ kind: "sales", id: "ftamper", data: { id: "ftamper", no: "T1", type: "sale", subtotal: 10000, gst: 800, billDisc: 0, svcCharge: 0, total: 100, lines: [{ pid: "fb", qty: 1, price: 10000 }], payments: [{ method: "cash", amount: 100 }], gstBp: 800, t: Date.now() } }] }]);
    const r = await H.invGet(o.token, "/ledger-export");
    assert.equal(r.status, 200);
    const f = r.json.journal.flagged;
    assert.ok(f, "journal carries a flagged block");
    assert.equal(f.count, 1, "exactly the tampered sale is flagged");
    assert.notEqual(f.variance, 0, "a non-zero variance is surfaced, not hidden");
    assert.ok(f.computedTotal > f.claimedTotal, "server-computed total exceeds the claimed one for an under-ring");
  });
});

describe("token revocation & org-status recheck (SEC-3)", () => {
  test("revoke-devices needs manager elevation, then kills tokens issued before it; a fresh login works", async () => {
    const o = await H.registerOrg({ tag: "revoke" });
    assert.equal((await H.ops(o.token, [{ opId: "rv-a", puts: [{ kind: "products", id: "rp", data: { id: "rp", name: "X", price: 100 } }] }])).status, 200, "op works before revoke");
    // unelevated revoke is refused (a stolen till token can't lock the store out)
    assert.equal((await H.req("POST", "/api/revoke-devices", { token: o.token })).status, 403);
    // elevate with the store password, then revoke
    const el = await H.req("POST", "/api/elevate", { token: o.token, body: { password: o.password } });
    assert.equal(el.status, 200); assert.ok(el.json.elevation);
    await new Promise((r) => setTimeout(r, 1100)); // JWT iat is whole seconds — ensure the cut-off lands after it
    assert.equal((await H.req("POST", "/api/revoke-devices", { token: o.token, headers: { "X-Elevation": el.json.elevation } })).status, 200);
    // the original token can no longer write money …
    assert.equal((await H.ops(o.token, [{ opId: "rv-b", puts: [{ kind: "products", id: "rp2", data: { id: "rp2", name: "Y", price: 200 } }] }])).status, 401, "revoked token rejected on /api/ops");
    // … but a new token issued after the cut-off works again (via /api/pair off the
    // still-valid cookie session; avoids the shared per-IP login throttle in tests).
    const pair = await H.req("POST", "/api/pair", { cookie: o.cookie });
    assert.equal(pair.status, 200); assert.ok(pair.json.token);
    assert.equal((await H.ops(pair.json.token, [{ opId: "rv-c", puts: [{ kind: "products", id: "rp3", data: { id: "rp3", name: "Z", price: 300 } }] }])).status, 200, "a post-cutoff token restores access");
  });
});

describe("security", () => {
  test("SEC-01: security headers are present", async () => {
    const r = await H.req("GET", "/api/health");
    assert.ok(/default-src 'self'/.test(r.headers.get("content-security-policy") || ""), "CSP present");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.ok(r.headers.get("referrer-policy"));
  });

  test("SEC-02: login throttles after repeated failures and resets on success", async () => {
    const o = await H.registerOrg({ tag: "throttle" });
    const badLogin = () => H.req("POST", "/api/login", { body: { email: o.email, password: "wrong" } });
    const goodLogin = () => H.req("POST", "/api/login", { body: { email: o.email, password: o.password } });

    // A successful login resets the failure counter.
    for (let i = 0; i < 3; i++) await badLogin();
    assert.equal((await goodLogin()).status, 200, "correct password still works after a few fails");

    // After reset it again takes the full threshold (8) to block; the 9th is 429.
    for (let i = 0; i < 8; i++) assert.equal((await badLogin()).status, 401);
    const blocked = await badLogin();
    assert.equal(blocked.status, 429, "blocked after threshold");
    assert.ok(blocked.headers.get("retry-after"), "Retry-After header set");
  });

  test("SEC-2: a till bearer token cannot reach destructive inventory routes; the back-office cookie can", async () => {
    const o = await H.registerOrg({ tag: "invauthz" });
    // The till's bearer token must be refused on cost/stock-mutating routes…
    assert.equal((await H.invPost(o.token, "/ingredients", { name: "Hack", baseUnit: "g" })).status, 403, "bearer create ingredient blocked");
    assert.equal((await H.invPost(o.token, "/adjust", { ingredientId: "x", qty: -1, kind: "waste" })).status, 403, "bearer waste adjust blocked");
    assert.equal((await H.invGet(o.token, "/owner")).status, 403, "bearer owner dashboard blocked");
    // …while a real back-office cookie session still works, and reads/sync stay open to the till.
    assert.equal((await H.invPost({ cookie: o.cookie }, "/ingredients", { name: "Tuna", baseUnit: "g" })).status, 200, "cookie create ingredient allowed");
    assert.equal((await H.invGet(o.token, "/ingredients")).status, 200, "bearer read still allowed");
    assert.equal((await H.ops(o.token, [{ opId: "az-1", puts: [{ kind: "products", id: "az-p", data: { id: "az-p", name: "X", price: 100 } }] }])).status, 200, "till sync still works");
  });
});

/* ── Production-readiness audit fixes (2026-08-08) ──────────────────────
   Regression coverage for the findings closed in that pass. Each test name
   carries the finding's id so a future regression points straight back here. */

describe("shift close is not re-closeable (AUDIT-C1)", () => {
  test("re-posting close against an already-closed shift id 404s instead of overwriting the true variance", async () => {
    const o = await H.registerOrg({ tag: "shiftreclose" });
    const open = await H.req("POST", "/api/app2/shift", { cookie: o.cookie, body: { action: "open", float: 10000 } });
    assert.equal(open.status, 200, "shift opens");
    const shiftId = open.json.id;
    const close1 = await H.req("POST", "/api/app2/shift", { cookie: o.cookie, body: { action: "close", id: shiftId, counted: 5000 } });
    assert.equal(close1.status, 200, "first close succeeds");
    // A shortage was recorded honestly: expected = float(100) + 0 cash sales = 100, counted 50 → variance -50.
    assert.equal(close1.json.shift.variance, -50, "true shortage recorded on first close");
    // Re-posting the SAME shift id — previously skipped the status='open' guard
    // that only the id-less fallback lookup enforced, silently re-running the
    // whole computation and overwriting counted/expected/variance.
    const close2 = await H.req("POST", "/api/app2/shift", { cookie: o.cookie, body: { action: "close", id: shiftId, counted: 10000 } });
    assert.equal(close2.status, 404, "a second close on the same shift id is refused, not silently re-applied");
  });
});

describe("sales are immutable once settled (AUDIT-C2)", () => {
  test("re-pushing an existing sale id with a different total does not overwrite the stored money", async () => {
    const o = await H.registerOrg({ tag: "saleimmut" });
    const original = { id: "immut-sale", type: "sale", no: "INV-IMMUT", lines: [{ pid: "x", qty: 1, price: 10800 }], subtotal: 10000, gst: 800, total: 10800, payments: [{ method: "cash", amount: 10800 }] };
    assert.equal((await H.ops(o.token, [{ opId: "im-1", puts: [{ kind: "sales", id: "immut-sale", data: original }] }])).status, 200);
    // Re-push the same id with a slashed, internally-self-consistent total and
    // a NEWER updatedAt so the pre-existing staleness guard alone would have
    // let it through — this is exactly the "resubmit with a different total"
    // attack the money-audit's own internal-consistency check cannot catch.
    const tampered = { id: "immut-sale", type: "sale", no: "INV-IMMUT", lines: [{ pid: "x", qty: 1, price: 100 }], subtotal: 93, gst: 7, total: 100, payments: [{ method: "cash", amount: 100 }], updatedAt: Date.now() + 60000 };
    assert.equal((await H.ops(o.token, [{ opId: "im-2", puts: [{ kind: "sales", id: "immut-sale", data: tampered } ] }])).status, 200, "the resubmit itself still syncs (offline-safe)");
    const stored = await H.pullEntity(o.token, "sales", (e) => e.id === "immut-sale");
    assert.equal(stored.data.total, 10800, "stored total is unchanged by the resubmit");
    assert.equal(stored.data.payments[0].amount, 10800, "stored payment is unchanged by the resubmit");
  });

  test("a brand-new sale id still inserts normally (the guard only protects an existing settled row)", async () => {
    const o = await H.registerOrg({ tag: "saleimmutnew" });
    const fresh = { id: "fresh-sale", type: "sale", lines: [{ pid: "x", qty: 1, price: 500 }], subtotal: 463, gst: 37, total: 500 };
    assert.equal((await H.ops(o.token, [{ opId: "fn-1", puts: [{ kind: "sales", id: "fresh-sale", data: fresh }] }])).status, 200);
    const stored = await H.pullEntity(o.token, "sales", (e) => e.id === "fresh-sale");
    assert.equal(stored.data.total, 500, "first insert of a new sale id is untouched by the immutability guard");
  });
});

describe("cash payouts count against shift-close expected cash (AUDIT-C3)", () => {
  test("a cash paidout expense during the shift reduces expected cash, not just sales/settlements", async () => {
    const o = await H.registerOrg({ tag: "shiftpayout" });
    const open = await H.req("POST", "/api/app2/shift", { cookie: o.cookie, body: { action: "open", float: 20000 } });
    assert.equal(open.status, 200);
    await H.ops(o.token, [{ opId: "po-1", puts: [{ kind: "expenses", id: "po-exp", data: { id: "po-exp", type: "paidout", amount: 5000, reason: "petty cash", t: Date.now() } }] }]);
    const close = await H.req("POST", "/api/app2/shift", { cookie: o.cookie, body: { action: "close", id: open.json.id, counted: 15000 } });
    assert.equal(close.status, 200);
    // expected = float(200) - paidOut(50) = 150; counted 150 → variance 0, not -50.
    assert.equal(close.json.shift.expected, 150, "expected cash nets off the payout");
    assert.equal(close.json.shift.variance, 0, "a fully-accounted payout does not manufacture a false shortage");
  });
});

describe("privileged app2 actions require rank (AUDIT-S1/S2)", () => {
  test("/api/app2/void rejects a below-till-rank session and accepts a till-rank one", async () => {
    const o = await H.registerOrg({ tag: "voidrbac" });
    // Forge a validly-signed session cookie for this real org at KITCHEN rank —
    // exercises the server-side gate itself, independent of which issuance
    // flow can produce such a cookie today.
    const orgId = jwt.decode(o.cookie.split("=")[1])?.o;
    const kitchenCookie = "kashikeyo_session=" + jwt.sign({ o: orgId, role: "kitchen" }, FORGE_SECRET);
    const tillCookie = "kashikeyo_session=" + jwt.sign({ o: orgId, role: "cashier" }, FORGE_SECRET);
    const blocked = await H.req("POST", "/api/app2/void", { cookie: kitchenCookie, body: { kind: "bill", ref: "T1", reason: "test", amount: 1000 } });
    assert.equal(blocked.status, 403, "below-till-rank session is refused (previously had no rank check at all)");
    const allowed = await H.req("POST", "/api/app2/void", { cookie: tillCookie, body: { kind: "bill", ref: "T1", reason: "test", amount: 1000 } });
    assert.equal(allowed.status, 200, "till-rank session (cashier) is still allowed");
  });

  test("/api/app2/call/:id/ack rejects a below-till-rank session", async () => {
    const o = await H.registerOrg({ tag: "ackrbac" });
    const orgId = jwt.decode(o.cookie.split("=")[1])?.o;
    const kitchenCookie = "kashikeyo_session=" + jwt.sign({ o: orgId, role: "kitchen" }, FORGE_SECRET);
    const r = await H.req("POST", "/api/app2/call/nonexistent/ack", { cookie: kitchenCookie });
    assert.equal(r.status, 403, "below-till-rank session is refused before the call is even looked up");
  });
});

