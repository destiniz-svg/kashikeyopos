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
    const bPull = await H.pull(b.token, 0);
    const own = (bPull.json.entities || []).some((e) => JSON.stringify(e.data).includes("ORGB-SECRET"));
    assert.equal(own, true, "org B must see its own customer");
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
    const first = await H.pull(o.token, 0);
    const cursor = first.json.rowver;
    await H.ops(o.token, [{ opId: "c2", puts: [{ kind: "customers", id: "c-2", data: { id: "c-2", name: "Second" } }] }]);
    const second = await H.pull(o.token, cursor);
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
  test("an honest sale is NOT flagged", async () => {
    await pushSale("m-honest", { no: "INV-H", lines: [{ pid: "m-burger", qty: 1, price: 9500, discPct: 0, taxable: true }], subtotal: 9500, billDisc: 0, billDiscPct: 0, gst: 760, svcCharge: 0, fee: 0, total: 10260 });
    assert.ok(!(await flaggedIds()).includes("m-honest"));
  });
  test("a legitimately discounted line is NOT flagged", async () => {
    await pushSale("m-disc", { no: "INV-D", lines: [{ pid: "m-burger", qty: 1, price: 9500, discPct: 50, taxable: true }], subtotal: 4750, billDisc: 0, billDiscPct: 0, gst: 380, svcCharge: 0, fee: 0, total: 5130 });
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
  const balOf = async (id) => {
    const c = ((await H.pull(o.token, 0)).json.entities || []).find((e) => e.kind === "customers" && e.id === id);
    return c ? c.data : {};
  };
  before(async () => {
    o = await H.registerOrg({ tag: "credit" });
    await H.ops(o.token, [{ opId: "cust", puts: [{ kind: "customers", id: "cl-cust", data: { id: "cl-cust", name: "Credit Cust", balance: 0, creditLimit: 10000 } }] }]);
  });
  const credit = (opId, bal) => H.ops(o.token, [{ opId, puts: [], deltas: { cust: [{ id: "cl-cust", pts: 0, bal }] } }]);

  test("under the limit does not flag", async () => {
    await credit("cl-1", 6000);
    const d = await balOf("cl-cust");
    assert.equal(Number(d.balance), 6000);
    assert.equal(d.creditOverLimit, false);
  });
  test("crossing the limit flags with the overage, balance still applied", async () => {
    await credit("cl-2", 6000); // 12000 > 10000
    const d = await balOf("cl-cust");
    assert.equal(Number(d.balance), 12000, "money owed is recorded even over limit");
    assert.equal(d.creditOverLimit, true);
    assert.equal(Number(d.creditOverBy), 2000);
  });
  test("paying back under the limit clears the flag", async () => {
    await credit("cl-3", -8000); // 4000 < 10000
    const d = await balOf("cl-cust");
    assert.equal(Number(d.balance), 4000);
    assert.equal(d.creditOverLimit, false);
  });
  test("a customer with no limit is never flagged", async () => {
    await H.ops(o.token, [{ opId: "cust2", puts: [{ kind: "customers", id: "nolimit", data: { id: "nolimit", name: "No Limit", balance: 0, creditLimit: 0 } }] }]);
    await H.ops(o.token, [{ opId: "nl-1", puts: [], deltas: { cust: [{ id: "nolimit", pts: 0, bal: 999999 }] } }]);
    const d = await balOf("nolimit");
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

    assert.equal((await H.invPost(o.token, "/flags/sale/f-sale/ack", { by: "tester" })).status, 200);
    assert.equal((await H.invPost(o.token, "/flags/credit/f-cust/ack", { by: "tester" })).status, 200);

    flags = (await H.invGet(o.token, "/flags")).json;
    assert.ok(!flags.sales.some((s) => s.id === "f-sale"), "acked sale drops off");
    assert.ok(!flags.credit.some((c) => c.id === "f-cust"), "acked customer drops off");

    // acking an unknown flag 404s
    assert.equal((await H.invPost(o.token, "/flags/sale/nope/ack", {})).status, 404);
  });
});

/* ── Stock ledger consumption + refund ───────────────────────────────── */
describe("stock ledger", () => {
  test("a recipe sale deducts stock once; refund restores it", async () => {
    const o = await H.registerOrg({ tag: "stock" });
    // ingredient with 1000 ml on hand
    await H.invPost(o.token, "/ingredients", { id: "s-milk", name: "Milk", baseUnit: "ml", location: "Fridge" });
    await H.invPost(o.token, "/adjust", { ingredientId: "s-milk", mode: "correct", qty: 1000 });
    // a product that uses 200 ml per unit
    await H.ops(o.token, [{ opId: "sp", puts: [{ kind: "products", id: "s-latte", data: { id: "s-latte", name: "Latte", price: 5000 } }] }]);
    await H.invPut(o.token, "/recipes/s-latte", { lines: [{ ingredientId: "s-milk", qty: 200 }] });

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
  test("a sold-out item (recipe at zero stock) is refused with 409", async () => {
    // an ingredient with no stock + a product that needs it → 0 servings available
    await H.invPost(o.token, "/ingredients", { id: "g-bean", name: "Beans", baseUnit: "g", location: "Dry" });
    await H.ops(o.token, [{ opId: "gc", puts: [{ kind: "products", id: "g-coffee", data: { id: "g-coffee", name: "Coffee", price: 4000 } }] }]);
    await H.invPut(o.token, "/recipes/g-coffee", { lines: [{ ingredientId: "g-bean", qty: 10 }] });
    assert.equal((await order({ items: [{ pid: "g-coffee", qty: 1 }], gtype: "pickup" })).status, 409);
  });
  test("an unknown workspace 404s", async () => {
    assert.equal((await H.req("POST", "/p/no-such-slug-xyz/order", { body: { items: [{ pid: "g-tea", qty: 1 }], gtype: "pickup" } })).status, 404);
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
        lines: [{ pid: "g-tea", qty: 2, price: 3000, taxable: true }], subtotal: 6000, gst: 480, total: 6480, payments: [{ method: "Cash", amount: 6480 }] } }] },
      { opId: "cm-ord", puts: [{ kind: "orders", id: orderId, data: { id: orderId, status: "completed", saleId: "cm-sale", settledAtTill: true } }] },
    ]);
    const ents = (await H.pull(o.token, 0)).json.entities || [];
    const sale = ents.find((e) => e.kind === "sales" && e.id === "cm-sale");
    const ord = ents.find((e) => e.kind === "orders" && e.id === orderId);
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
    const main = await idsFor("main");
    const b2 = await idsFor("branch2");
    assert.ok(main.includes("products:p-main"), "main store sees its product");
    assert.ok(!main.includes("products:p-b2"), "main store does NOT see branch2's product");
    assert.ok(b2.includes("products:p-b2"), "branch2 sees its product");
    assert.ok(!b2.includes("products:p-main"), "branch2 does NOT see main's product");
  });

  test("shared-kind entities (customers) are global to every store", async () => {
    assert.ok((await idsFor("main")).includes("customers:shared-cust"), "customer visible from main");
    assert.ok((await idsFor("branch2")).includes("customers:shared-cust"), "same customer visible from branch2");
  });
});

/* ── Security controls (run last: the throttle test blocks this IP) ───── */
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
});
