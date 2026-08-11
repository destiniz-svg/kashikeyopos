/* Regression suite for PAGED RECEIPT HISTORY (D-06).

   Why this file exists: the /v2 page inject carries the 200 most recent sales
   and there was no second page to ask for — the projection lived inline in the
   inject, so nothing else could produce a receipt row. At the 100
   transactions/hour this app is sized for, 200 receipts is two hours of
   trading: yesterday's ticket could not be opened, reprinted or refunded from
   the terminal at all.

   The rules these tests lock in:
     1. GET /api/app2/orders pages the whole history, newest first.
     2. Paging is by CURSOR, not OFFSET — every receipt is served exactly once
        even though the till keeps writing while an operator scrolls.
     3. A page whose rows are all voids/refunds still ADVANCES the cursor. It
        returns an empty `orders` array, and paging from a returned row instead
        of the last row scanned would re-serve the skipped rows forever.
     4. An older receipt carries its refund state, so a refunded ticket pulled
        out of history cannot be refunded a second time.
     5. A history row is the same shape as an injected row. */
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers");

before(async () => { await H.startServer(); });
after(() => { H.stopServer(); });

async function kposReal(cookie) {
  const html = await (await fetch(H.BASE + "/v2", { headers: { Cookie: cookie } })).text();
  const T = "window.KPOS_REAL=";
  const a = html.indexOf(T);
  let b = html.indexOf(";window.KPOS_BUILD", a);
  if (b < 0) b = html.indexOf(";</script>", a);
  return JSON.parse(html.slice(a + T.length, b));
}

/* Write n sales, one minute apart going backwards from `now`. Batched so the
   test does not open n HTTP requests. */
async function writeSales(token, n, now, extra = () => ({})) {
  for (let batch = 0; batch < n; batch += 50) {
    const ops = [];
    for (let i = batch; i < Math.min(n, batch + 50); i++) {
      const at = now - i * 60000;
      ops.push({ opId: "op-" + i, puts: [{ kind: "sales", id: "s" + i,
        data: { id: "s" + i, no: "KO-" + (1000 + i), at, t: at, total: 10000, subtotal: 9259,
          gst: 741, tender: "cash", lines: [], payments: [{ method: "cash", amount: 10000 }], ...extra(i) } }] });
    }
    const r = await H.ops(token, ops);
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
}

const getPage = (cookie, q) => H.req("GET", "/api/app2/orders" + q, { cookie });

describe("paged receipt history", () => {
  test("the whole history is reachable, each receipt exactly once", async () => {
    const org = await H.registerOrg({ tag: "hist" });
    const N = 320, now = Date.now();
    await writeSales(org.token, N, now);

    const real = await kposReal(org.cookie);
    assert.equal(real.orders.length, 200, "the inject is still capped — that is what pagination exists for");

    const seen = new Set(real.orders.map((o) => o.no));
    let before = Math.min(...real.orders.map((o) => o.at)), beforeId = null, pages = 0, dupes = 0;
    for (;;) {
      const r = await getPage(org.cookie, `?limit=100&before=${before}${beforeId ? "&beforeId=" + beforeId : ""}`);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      pages++;
      for (const o of r.json.orders) { if (seen.has(o.no)) dupes++; seen.add(o.no); }
      if (!r.json.more) break;
      before = r.json.nextBefore; beforeId = r.json.nextBeforeId;
      assert.ok(pages < 20, "cursor is not advancing");
    }
    assert.equal(dupes, 0, "cursor paging must never re-serve a receipt");
    assert.equal(seen.size, N, "every receipt must be reachable");
  });

  test("history rows are the same shape as injected rows", async () => {
    const org = await H.registerOrg({ tag: "hist-shape" });
    await writeSales(org.token, 210, Date.now());
    const real = await kposReal(org.cookie);
    const r = await getPage(org.cookie, `?limit=20&before=${Math.min(...real.orders.map((o) => o.at))}`);
    assert.ok(r.json.orders.length, "expected a page of older receipts");
    assert.deepEqual(
      Object.keys(r.json.orders[0]).sort(), Object.keys(real.orders[0]).sort(),
      "an older receipt must render with the same fields as a recent one",
    );
  });

  test("a page of voided rows advances the cursor instead of looping", async () => {
    const org = await H.registerOrg({ tag: "hist-void" });
    const now = Date.now();
    const ops = [];
    for (let i = 0; i < 3; i++) ops.push({ opId: "s" + i, puts: [{ kind: "sales", id: "s" + i, data: { id: "s" + i, no: "S-" + i, at: now - i * 1000, t: now - i * 1000, total: 10000, lines: [] } }] });
    for (let i = 0; i < 12; i++) ops.push({ opId: "v" + i, puts: [{ kind: "sales", id: "v" + i, data: { id: "v" + i, no: "V-" + i, at: now - 1e5 - i * 1000, t: now - 1e5 - i * 1000, total: 5000, void: true, lines: [] } }] });
    ops.push({ opId: "old", puts: [{ kind: "sales", id: "old", data: { id: "old", no: "OLD-1", at: now - 9e5, t: now - 9e5, total: 7000, lines: [] } }] });
    ops.push({ opId: "ref", puts: [{ kind: "sales", id: "ref", data: { id: "ref", no: "R-1", at: now - 8e5, t: now - 8e5, type: "refund", refundOf: "OLD-1", total: -7000, lines: [] } }] });
    assert.equal((await H.ops(org.token, ops)).status, 200);

    let before = null, beforeId = null, pages = 0;
    const got = [];
    for (;;) {
      const r = await getPage(org.cookie, `?limit=5${before ? "&before=" + before + (beforeId ? "&beforeId=" + beforeId : "") : ""}`);
      pages++;
      got.push(...r.json.orders);
      if (!r.json.more) break;
      before = r.json.nextBefore; beforeId = r.json.nextBeforeId;
      assert.ok(pages < 10, "an all-filtered page did not advance the cursor");
    }
    const nos = got.map((o) => o.no).sort();
    assert.deepEqual(nos, ["OLD-1", "S-0", "S-1", "S-2"], "voids and refunds are not receipts; everything else must be reached");
    const old = got.find((o) => o.no === "OLD-1");
    assert.equal(old.refunded, true, "a refunded ticket pulled from history must say so, or it can be refunded twice");
    assert.equal(old.refundAmt, 70);
  });

  test("no cursor returns the newest page; limit is clamped; anonymous is refused", async () => {
    const org = await H.registerOrg({ tag: "hist-args" });
    const now = Date.now();
    await writeSales(org.token, 12, now);

    const first = await getPage(org.cookie, "?limit=5");
    assert.deepEqual(first.json.orders.map((o) => o.no), ["KO-1000", "KO-1001", "KO-1002", "KO-1003", "KO-1004"]);
    assert.equal(first.json.more, true);

    const clamped = await getPage(org.cookie, "?limit=99999");
    assert.ok(clamped.json.orders.length <= 200, "an unbounded limit would let one request read the whole ledger");

    const anon = await H.req("GET", "/api/app2/orders");
    assert.equal(anon.status, 401);
  });

  test("history is tenant-scoped", async () => {
    const now = Date.now();
    const a = await H.registerOrg({ tag: "hist-a" });
    const b = await H.registerOrg({ tag: "hist-b" });
    await writeSales(a.token, 6, now);
    const r = await getPage(b.cookie, "?limit=100");
    assert.deepEqual(r.json.orders, [], "one store must never see another store's receipts");
  });
});
