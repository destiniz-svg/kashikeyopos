/* Regression suite for the OPERATIONAL METRICS surface (D-04).

   Why this file exists: the audit asked "how would you know this instance is
   degraded?" and the only answer was /api/health, which says up-or-down. A
   store whose sales were taking four seconds each, or whose connection pool was
   saturated, looked exactly like a healthy one until a merchant phoned.

   The rules these tests lock in:
     1. /api/metrics is platform-admin only — the numbers are cross-tenant, and
        an open metrics endpoint leaks traffic and customer counts.
     2. It reports the signals a monitor alerts on: pool saturation, latency
        quantiles, HTTP status classes, error rate, and the POS-specific
        counters (sales written, money-flagged, sync batches rejected).
     3. The counters actually move with traffic — a metric that is always zero
        is worse than none, because it reads as "healthy". */
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers");

before(async () => { await H.startServer(); });
after(() => { H.stopServer(); });

describe("operational metrics", () => {
  test("reports the signals a monitor alerts on, and they move with traffic", async () => {
    const admin = await H.platformAdminCookie();
    const before = await H.req("GET", "/api/metrics", { cookie: admin });
    assert.equal(before.status, 200, JSON.stringify(before.json));
    const m = before.json;

    assert.equal(m.ready, true);
    assert.ok(m.bootMs >= 0, "boot duration answers 'how long is a deploy blind?'");
    assert.equal(m.db.ok, true);
    assert.ok(m.db.ms >= 0, "a database that answers slowly is not 'up'");
    /* Pool saturation — waiting > 0 sustained is the shape the /api/ops
       connection leak took, and nothing else in the app would have shown it. */
    assert.ok(typeof m.pool.waiting === "number");
    assert.ok(m.pool.total >= 0 && m.pool.idle >= 0);
    assert.ok(m.memoryMb.rss > 0);
    assert.ok(m.http.requests > 0, "requests must be counted, or the rate is unknowable");
    assert.ok(m.http.status["2xx"] > 0);
    assert.ok(Array.isArray(m.http.buckets) && m.http.buckets.length > 1, "a latency histogram, not a single average");
    assert.ok(typeof m.errors.last15m === "number", "a RATE is what separates a blip from an incident");

    /* Now generate known traffic and confirm the counters actually move. A
       metric that is always zero is worse than none: it reads as healthy. */
    const org = await H.registerOrg({ tag: "metrics-move" });
    await H.ops(org.token, [{ opId: "m-sale", puts: [{ kind: "sales", id: "ms1",
      data: { id: "ms1", no: "M-1", at: Date.now(), t: Date.now(), total: 4500, subtotal: 4167, gst: 333,
        tender: "cash", lines: [{ pid: "p1", qty: 1, price: 4500, amount: 4500 }], payments: [{ method: "cash", amount: 4500 }] } }] }]);
    await H.req("POST", "/api/ops", { token: org.token, body: { ops: "not an array" } });   // a rejected batch
    await H.req("GET", "/api/does-not-exist");                                              // a 4xx

    const after = (await H.req("GET", "/api/metrics", { cookie: admin })).json;
    assert.ok(after.http.requests > m.http.requests, "request counter must advance");
    assert.ok(after.ops.sales > m.ops.sales, "a written sale must be counted — it is the transaction the business runs on");
    assert.ok(after.ops.opsRejected > m.ops.opsRejected, "a refused sync batch is the failure a merchant calls about");
    assert.ok(after.http.status["4xx"] > m.http.status["4xx"]);
    assert.equal(after.http.inFlight >= 0, true, "in-flight must not drift negative or leak upward");
  });


  test("the scrape endpoint is closed to everyone but a platform admin", async () => {
    const anon = await H.req("GET", "/api/metrics");
    assert.equal(anon.status, 401, "an open metrics endpoint leaks traffic and customer counts");

    const org = await H.registerOrg({ tag: "metrics" });
    const asMerchant = await H.req("GET", "/api/metrics", { cookie: org.cookie });
    assert.equal(asMerchant.status, 401, "a merchant session is not a platform-admin session");

    const asTill = await H.req("GET", "/api/metrics", { token: org.token });
    assert.equal(asTill.status, 401, "a till bearer token must not reach cross-tenant metrics");
  });

  test("liveness and readiness stay separable and unauthenticated", async () => {
    /* A monitor needs these two without credentials: readiness gates traffic,
       liveness must never be gated on the database — a restart cannot fix an
       unreachable Postgres, it only removes capacity. */
    const live = await H.req("GET", "/api/live");
    assert.equal(live.status, 200);
    assert.equal(live.json.ok, true);
    assert.ok(live.json.uptimeSec >= 0);

    const health = await H.req("GET", "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.ready, true);
    assert.equal(health.json.db, true);
  });

  test("a rejected sync batch is refused with a reason the till can act on", async () => {
    /* The counter behind ops.opsRejected. It is exercised here through the
       behaviour it counts, because the metrics numbers themselves are only
       readable by a platform admin. */
    const org = await H.registerOrg({ tag: "metrics-ops" });
    const bad = await H.req("POST", "/api/ops", { token: org.token, body: { ops: "not an array" } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /array/);

    const tooMany = await H.req("POST", "/api/ops", { token: org.token,
      body: { ops: [{ opId: "big", puts: new Array(2001).fill({ kind: "products", id: "x", data: {} }) }] } });
    assert.equal(tooMany.status, 413);

    /* And a good batch still goes through, so the guard above is a guard and
       not an outage. */
    const ok = await H.ops(org.token, [{ opId: "fine", puts: [{ kind: "products", id: "p1", data: { id: "p1", name: "Mas Huni", price: 4500 } }] }]);
    assert.equal(ok.status, 200);
  });

  test("every response carries a correlation id an incident can be traced by", async () => {
    const r = await H.req("GET", "/api/live");
    assert.ok(r.headers.get("x-request-id"), "without this a support report cannot be tied to a request");
    const mine = await H.req("GET", "/api/live", { headers: { "X-Request-Id": "trace-me-123" } });
    assert.equal(mine.headers.get("x-request-id"), "trace-me-123", "a caller-supplied id must be echoed, not replaced");
  });
});
