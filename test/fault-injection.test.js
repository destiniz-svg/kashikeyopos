/* FAULT INJECTION on the money path.

   Why this file exists: every other suite tests the app when things work. A POS
   spends its life where things don't — WiFi drops mid-settlement, a tablet is
   killed while the outbox is flushing, two tills replay the same queue, a
   device's clock is a day out. The design has answers for all of that
   (`ops(org_id, op_id)` idempotency, the durable outbox, the rowver cursor with
   its txid visibility guard), but nothing had ever tried to break them on
   purpose. "It should be idempotent" is a claim until something replays it.

   THE INVARIANT UNDER TEST, in every case below:
     money in == money stored.
   A sale may be delayed, retried, reordered or duplicated on the wire. It must
   land exactly once, and it must never vanish.

   Each test names the real-world fault it stands for. */
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers");
const M = require("../web3/proto/money.js");

before(async () => { await H.startServer(); });
after(() => { H.stopServer(); });

const GST_BP = 800;

function sale(id, unit = 5000, qty = 1, at = Date.now()) {
  const b = M.billTotals({ lines: [{ unit, qty, disc: 0 }], gstBp: GST_BP, svcBp: 0, serviceApplies: false });
  return {
    id, no: "FI-" + id, at, t: at, tender: "cash",
    subtotal: b.items, gst: b.gst, svcCharge: 0, billDisc: 0, total: b.total,
    lines: [{ pid: "fi-dish", qty, price: unit, amount: b.lines[0] }],
    payments: [{ method: "cash", amount: b.total }],
  };
}
const opFor = (opId, s) => ({ opId, puts: [{ kind: "sales", id: s.id, data: s }] });

async function store(tag) {
  const org = await H.registerOrg({ tag });
  await H.ops(org.token, [{ opId: tag + "-seed", puts: [{ kind: "products", id: "fi-dish", data: { id: "fi-dish", name: "Dish", price: 5000 } }] }]);
  return org;
}

/* Every non-deleted sale the server holds, by id — read through the same pull a
   real till uses, not the database.

   `expect` waits for that many sales before returning. This is a WAIT, not a
   fudge: one immediate pull can transiently miss a freshly-committed row while
   an unrelated transaction holds the cluster snapshot xmin down (the never-skip
   guard the sync cursor depends on — see helpers.pullEntity). A real till rides
   over that window on its next 5-second poll. If a sale is genuinely lost the
   count never arrives and the assertion below still fails, which is the whole
   point of the suite. */
async function salesOf(org, expect) {
  const read = async () => {
    const rows = ((await H.pull(org.token, 0)).json.entities || []).filter((e) => e.kind === "sales" && !e.deleted);
    const byId = new Map();
    for (const r of rows) byId.set(r.id, r.data);
    return byId;
  };
  if (!expect) return read();
  try { return await H.until(async () => { const m = await read(); return m.size >= expect ? m : null; }, { timeout: 8000, step: 150 }); }
  catch { return read(); }          // let the assertion report the real shortfall
}
const moneyIn = (m) => [...m.values()].reduce((a, s) => a + (Number(s.total) || 0), 0);

describe("fault injection — the money path", () => {

  test("a retried op is applied once (WiFi dropped before the ack arrived)", async () => {
    const org = await store("fi-retry");
    const s = sale("r1");
    for (let i = 0; i < 4; i++) {
      assert.equal((await H.ops(org.token, [opFor("op-r1", s)])).status, 200, "a replay must be accepted, not refused");
    }
    const sales = await salesOf(org, 1);
    assert.equal(sales.size, 1, "four deliveries of one sale must leave one sale");
    assert.equal(moneyIn(sales), s.total);
  });

  test("concurrent replays of one op collapse to a single sale (two tills sharing a queue)", async () => {
    const org = await store("fi-race");
    const s = sale("c1", 7500);
    /* Eight simultaneous deliveries of the same opId. The ops primary key is
       the only thing standing between this and eight bookings; the transaction
       boundary is what makes it hold under a real race rather than in theory. */
    const results = await Promise.all(Array.from({ length: 8 }, () => H.ops(org.token, [opFor("op-c1", s)])));
    for (const r of results) assert.equal(r.status, 200, "no replay may be rejected — the cashier already took the money");

    const sales = await salesOf(org, 1);
    assert.equal(sales.size, 1, "eight concurrent replays must leave one sale");
    assert.equal(moneyIn(sales), s.total, "and the money must be counted once");
  });

  test("a retry that regenerates its op id still books one sale (client-side id churn)", async () => {
    const org = await store("fi-newop");
    const s = sale("n1", 6250);
    /* A till that mints a fresh opId on every retry defeats op-level
       idempotency entirely. The entity primary key (org, kind, id) is the
       second line of defence, and it is the one that matters here. */
    assert.equal((await H.ops(org.token, [opFor("op-n1-a", s)])).status, 200);
    assert.equal((await H.ops(org.token, [opFor("op-n1-b", s)])).status, 200);

    const sales = await salesOf(org, 1);
    assert.equal(sales.size, 1, "same sale id under two op ids is still one sale");
    assert.equal(moneyIn(sales), s.total, "money must not double when the op id churns");
  });

  test("a request killed mid-flight is safe to replay (tablet died during settlement)", async () => {
    const org = await store("fi-abort");
    /* The genuinely dangerous window: the server commits, then the connection
       dies before the response is written. The till never sees an ack, so its
       outbox replays. Whether the commit landed before the abort is a race we
       cannot control — which is the point. Either way exactly one sale. */
    const totals = [];
    for (let i = 0; i < 6; i++) {
      const s = sale("k" + i, 4000 + i * 250);
      totals.push(s.total);
      const ac = new AbortController();
      const inflight = fetch(H.BASE + "/api/ops", {
        method: "POST", signal: ac.signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + org.token },
        body: JSON.stringify({ ops: [opFor("op-k" + i, s)] }),
      }).catch(() => null);                       // the abort surfaces here; a till would see "offline"
      setTimeout(() => ac.abort(), 3 + i * 4);    // walk the abort across the commit window
      await inflight;
      // …and the outbox replays it, exactly as OUTBOX_JS does.
      assert.equal((await H.ops(org.token, [opFor("op-k" + i, s)])).status, 200);
    }
    const sales = await salesOf(org, 6);
    assert.equal(sales.size, 6, "six interrupted-then-replayed sales must be six sales");
    assert.equal(moneyIn(sales), totals.reduce((a, b) => a + b, 0), "no sale lost, none doubled");
  });

  test("a partially-applied batch applies only what is new (outbox flushed twice)", async () => {
    const org = await store("fi-batch");
    const a = sale("b1", 3000), b = sale("b2", 3500), c = sale("b3", 4200);
    assert.equal((await H.ops(org.token, [opFor("op-b1", a), opFor("op-b2", b)])).status, 200);
    /* The same queue flushed again, now with one more sale on the end. */
    assert.equal((await H.ops(org.token, [opFor("op-b1", a), opFor("op-b2", b), opFor("op-b3", c)])).status, 200);

    const sales = await salesOf(org, 3);
    assert.equal(sales.size, 3);
    assert.equal(moneyIn(sales), a.total + b.total + c.total);
  });

  test("out-of-order delivery keeps both sales and their real times (queue drained backwards)", async () => {
    const org = await store("fi-order");
    const t = Date.now();
    const older = sale("o1", 2500, 1, t - 3600e3);
    const newer = sale("o2", 2500, 1, t);
    // newest first — an outbox retrying from the tail, or two tills reconnecting
    assert.equal((await H.ops(org.token, [opFor("op-o2", newer)])).status, 200);
    assert.equal((await H.ops(org.token, [opFor("op-o1", older)])).status, 200);

    const sales = await salesOf(org, 2);
    assert.equal(sales.size, 2, "arrival order must not drop a sale");
    assert.equal(sales.get("o1").at, older.at, "a late-arriving sale keeps the time it was rung, not the time it landed");
    assert.equal(sales.get("o2").at, newer.at);
  });

  test("a skewed device clock cannot lose a sale (tablet a day out)", async () => {
    const org = await store("fi-clock");
    const now = Date.now();
    const cases = [
      ["skew-past", now - 36 * 3600e3],
      ["skew-future", now + 36 * 3600e3],
      ["skew-now", now],
    ];
    for (const [id, at] of cases) {
      assert.equal((await H.ops(org.token, [opFor("op-" + id, sale(id, 5000, 1, at))])).status, 200);
    }
    const sales = await salesOf(org, 3);
    assert.equal(sales.size, 3, "a wrong clock must not exclude a sale from the ledger");
    for (const [id, at] of cases) assert.equal(sales.get(id).at, at, `${id} keeps its stamped time`);

    /* And the paged receipt history still reaches all three — the history pages
       on that timestamp, so a future-dated sale must not strand the cursor. */
    const page = await H.req("GET", "/api/app2/orders?limit=100", { cookie: org.cookie });
    assert.equal(page.status, 200);
    const nos = page.json.orders.map((o) => o.no);
    for (const [id] of cases) assert.ok(nos.includes("FI-" + id), `${id} must be reachable in receipt history`);
  });

  test("the sync cursor never skips a row while writes are in flight", async () => {
    const org = await store("fi-cursor");
    /* The property the whole offline model rests on: a till that keeps asking
       "what changed since N" must eventually see EVERYTHING, even when rows are
       committing concurrently. A rowver handed out before its transaction
       commits is exactly how a sale silently never reaches a device. */
    const N = 40;
    const written = [];
    const writer = (async () => {
      for (let i = 0; i < N; i++) {
        const s = sale("x" + i, 1000 + i * 25);
        written.push(s.id);
        await H.ops(org.token, [opFor("op-x" + i, s)]);
      }
    })();

    const seen = new Set();
    const reader = (async () => {
      let since = 0;
      for (let i = 0; i < 60; i++) {
        const j = (await H.pull(org.token, since)).json;
        for (const e of j.entities || []) if (e.kind === "sales") seen.add(e.id);
        since = j.rowver || since;                 // advance exactly as the till does
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    await Promise.all([writer, reader]);

    /* One final catch-up poll, because the reader may simply have stopped early
       — that is not a skip, and the test must not pretend it is. */
    const tail = (await H.pull(org.token, 0)).json;
    for (const e of tail.entities || []) if (e.kind === "sales") seen.add(e.id);

    const missing = written.filter((id) => !seen.has(id));
    assert.deepEqual(missing, [], "a cursor that advances past an uncommitted row loses these sales forever");
  });

  test("money is conserved across a storm of every fault at once", async () => {
    const org = await store("fi-storm");
    let expected = 0;
    const jobs = [];
    for (let i = 0; i < 12; i++) {
      const s = sale("z" + i, 2000 + i * 137, 1 + (i % 3));
      expected += s.total;
      const op = opFor("op-z" + i, s);
      jobs.push(H.ops(org.token, [op]));                       // first delivery
      if (i % 2 === 0) jobs.push(H.ops(org.token, [op]));       // concurrent replay
      if (i % 3 === 0) jobs.push(H.ops(org.token, [{ opId: "op-z" + i + "-alt", puts: op.puts }])); // op-id churn
    }
    const results = await Promise.all(jobs);
    for (const r of results) assert.equal(r.status, 200, "nothing may be refused under load — money is never rejected");

    const sales = await salesOf(org, 12);
    assert.equal(sales.size, 12, "12 distinct sales survive the storm");
    assert.equal(moneyIn(sales), expected, "and the ledger totals exactly what was rung");
  });

  /* ── the two gaps that kept this dimension at 9 ──────────────────────── */

  test("a SIGKILLed server loses nothing, and the replay after restart books once", async () => {
    const org = await store("fi-kill");
    /* The client-side abort earlier severs the CONNECTION. This severs the
       SERVER: SIGKILL, no graceful shutdown, no unwind, no flush — the crash a
       tablet's backend actually suffers. Anything Postgres had committed must
       survive it, and the till's replay afterwards must not double-book. */
    const settled = sale("kill-committed", 8800);
    assert.equal((await H.ops(org.token, [opFor("op-kill-committed", settled)])).status, 200,
      "this one is acknowledged before the crash — it is the sale that must survive");

    /* And one whose fate is genuinely undecided: fired, then the process is
       killed while it is in flight. Committed or not, the replay decides. */
    const inflight = sale("kill-inflight", 9100);
    const pending = fetch(H.BASE + "/api/ops", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + org.token },
      body: JSON.stringify({ ops: [opFor("op-kill-inflight", inflight)] }),
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 12));
    await H.killServer();
    await pending;

    await H.startServer();                       // the tablet comes back up

    const after = await salesOf(org, 1);
    assert.ok(after.has("kill-committed"), "an acknowledged sale must survive SIGKILL — it was money already taken");
    assert.equal(after.get("kill-committed").total, settled.total, "and survive it intact, to the laari");

    /* The outbox replays whatever it never saw acknowledged. */
    assert.equal((await H.ops(org.token, [opFor("op-kill-committed", settled)])).status, 200);
    assert.equal((await H.ops(org.token, [opFor("op-kill-inflight", inflight)])).status, 200);

    const finalSales = await salesOf(org, 2);
    assert.equal(finalSales.size, 2, "replaying both after a crash must leave exactly two sales");
    assert.equal(moneyIn(finalSales), settled.total + inflight.total, "no sale lost to the crash, none doubled by the replay");
  });

  test("the shipped outbox survives a full storage quota and a multi-day backlog", async () => {
    /* Runs the OUTBOX_JS the server actually injects into /app — sliced out of
       index.js rather than retyped, the same technique money.test.js uses — so
       this tests the shipped text, not a description of it.

       Two faults at once: localStorage refuses every write (quota exceeded, the
       classic iOS Safari failure), and the queue is three days old because the
       venue's line was down over a long weekend. Neither may lose a sale. */
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "index.js"), "utf8");
    const m = src.match(/const OUTBOX_JS = "((?:[^"\\]|\\.)*)";/);
    assert.ok(m, "OUTBOX_JS must still be sliceable out of index.js");
    const outboxJs = JSON.parse('"' + m[1] + '"');

    const posted = [];
    let quotaOn = true;
    const win = {
      __ksToken: "t",
      localStorage: {
        getItem: () => null,
        setItem: () => { if (quotaOn) { const e = new Error("QuotaExceededError"); e.name = "QuotaExceededError"; throw e; } },
      },
      addEventListener: () => {},
      fetch: async (url, init) => {
        posted.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
      setInterval: () => 0,
      clearTimeout,
    };
    win.window = win;
    require("node:vm").runInNewContext(outboxJs, win);
    assert.ok(typeof win.__ksPushSale === "function", "the outbox must expose its push entry point");

    const threeDaysAgo = Date.now() - 3 * 86400e3;
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const s = sale("q" + i, 3300 + i * 100, 1, threeDaysAgo + i * 60000);
      ids.push(s.id);
      /* Storage is refusing writes the whole time. A queue that only lives in
         localStorage would be silently empty here. */
      win.__ksPushSale(s);
    }
    await H.until(async () => posted.length >= 5, { timeout: 5000, step: 25 });

    const sentIds = posted.map((b) => b.ops[0].puts[0].data.id);
    assert.deepEqual(sentIds.sort(), ids.slice().sort(),
      "every sale rung while storage was full must still reach the server");
    for (const b of posted) {
      const d = b.ops[0].puts[0].data;
      assert.ok(d.at <= Date.now() - 2 * 86400e3, "a three-day-old sale keeps the time it was rung, not the time it flushed");
      assert.ok(d.total > 0 && d.payments[0].amount === d.total, "and arrives with its money intact");
    }
    quotaOn = false;
  });
});
