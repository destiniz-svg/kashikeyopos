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

/* ── Security controls (run last: the throttle test blocks this IP) ───── */

describe("flagged-sale reporting (FIN-1)", () => {
  test("ledger-export segregates money-audit-flagged sales into a variance line", async () => {
    const o = await H.registerOrg({ tag: "flag" });
    await H.ops(o.token, [{ opId: "fp", puts: [
      { kind: "settings", id: "settings", data: { id: "settings", gstBp: 800, svcChargeBp: 0 } },
      { kind: "products", id: "fb", data: { id: "fb", name: "Burger", price: 10000 } },
    ] }]);
    // an honest sale (not flagged) …
    await H.ops(o.token, [{ opId: "fs1", puts: [{ kind: "sales", id: "fclean", data: { id: "fclean", no: "C1", type: "sale", subtotal: 10000, gst: 800, billDisc: 0, svcCharge: 0, total: 10800, lines: [{ pid: "fb", qty: 1, price: 10000 }], payments: [{ method: "cash", amount: 10800 }], gstBp: 800, t: Date.now() } }] }]);
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
