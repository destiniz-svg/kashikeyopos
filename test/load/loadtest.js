#!/usr/bin/env node
/* Capacity harness — answers the audit's "what happens at 2× / 5× / 10×?"
 *
 * WHY IT EXISTS
 * -------------
 * The audit set a floor of 100 transactions/hour and asked for the ceiling. That
 * floor is 0.03 writes/second, which no server notices; quoting it as a pass
 * says nothing. A restaurant's load is not an hourly average — it is a lunch
 * rush arriving on several tills at once, each flushing an offline outbox. So
 * this measures CONCURRENCY, ramping simultaneous tills until latency or errors
 * move, and reports the sustained ceiling that ramp finds.
 *
 * WHAT IT DRIVES — the three paths a real terminal actually uses:
 *   POST /api/ops        a settled sale (the write that must never be lost)
 *   GET  /api/pull       the 5s sync poll every till runs
 *   GET  /v2             the page inject — the heaviest read in the app
 *
 * Sales are priced through web3/proto/money.js, the same billTotals() the
 * terminal and the server use, so the server's money audit sees clean bills and
 * we measure the happy path rather than the flagging path.
 *
 * NEVER RUN THIS AGAINST PRODUCTION. It writes real sales into a real ledger.
 * Point it at a staging or local instance. It refuses hosts it can tell are
 * production; that check is a courtesy, not a guarantee — read the URL yourself.
 *
 * Usage:
 *   node test/load/loadtest.js --base http://127.0.0.1:4000
 *   node test/load/loadtest.js --base https://<staging-host> --levels 1,4,16,64 --seconds 20
 */
"use strict";
const M = require("../../web3/proto/money.js");

/* ── args ─────────────────────────────────────────────────────────────── */
const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
/* --base accepts a comma-separated list of CANDIDATES, tried in order; the first
   that answers a ready /api/health wins. That lets one command prefer Railway's
   private network (no edge hop, so the numbers describe the server rather than
   the proxy in front of it) and fall back to the public URL when private DNS or
   IPv6 is not available to the runtime. */
const CANDIDATES = arg("base", "http://127.0.0.1:4000").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
const LEVELS = arg("levels", "1,2,4,8,16,32").split(",").map(Number).filter((n) => n > 0);
const SECONDS = Number(arg("seconds", 15));
const GST_BP = 800, SVC_BP = 1000;
let BASE = CANDIDATES[0];

for (const c of CANDIDATES) {
  if (/kashikeyopos\.com/i.test(c) && !/staging/i.test(c)) {
    console.error("Refusing to run: " + c + " looks like production.\n" +
      "This harness writes real sales. Point it at staging or a local instance.");
    process.exit(2);
  }
}

/* ── stats ────────────────────────────────────────────────────────────── */
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}
class Track {
  constructor() { this.ms = []; this.ok = 0; this.err = 0; this.codes = {}; }
  add(ms, ok, code) {
    this.ms.push(ms);
    if (ok) this.ok++; else this.err++;
    this.codes[code] = (this.codes[code] || 0) + 1;
  }
  summary(wallMs) {
    const s = this.ms.slice().sort((a, b) => a - b);
    return {
      n: this.ms.length, ok: this.ok, err: this.err,
      rps: wallMs ? +(this.ms.length / (wallMs / 1000)).toFixed(2) : 0,
      p50: Math.round(quantile(s, 0.5)), p95: Math.round(quantile(s, 0.95)),
      p99: Math.round(quantile(s, 0.99)), max: Math.round(s[s.length - 1] || 0),
      codes: this.codes,
    };
  }
}

/* ── http ─────────────────────────────────────────────────────────────── */
async function timed(track, fn) {
  const t0 = Date.now();
  let code = 0, ok = false;
  try { const r = await fn(); code = r.status; ok = r.ok; }
  catch (e) { code = String((e && e.code) || "ERR"); }
  track.add(Date.now() - t0, ok, code);
  return ok;
}
const post = (path, body, headers) => fetch(BASE + path, {
  method: "POST", headers: { "Content-Type": "application/json", ...(headers || {}) },
  body: JSON.stringify(body),
});
const get = (path, headers) => fetch(BASE + path, { headers: headers || {} });

/* ── a realistic settled sale ─────────────────────────────────────────── */
let saleSeq = 0;
function makeSale(products, register) {
  const n = 1 + Math.floor(Math.random() * 4);          // 1-4 lines, like a real cheque
  const lines = [];
  for (let i = 0; i < n; i++) {
    const p = products[Math.floor(Math.random() * products.length)];
    lines.push({ unit: p.price, qty: 1 + Math.floor(Math.random() * 3), disc: 0, pid: p.id });
  }
  const dineIn = Math.random() < 0.6;
  const b = M.billTotals({
    lines, gstBp: GST_BP, svcBp: SVC_BP, serviceApplies: dineIn,
    billDiscPct: 0, feeLaari: 0,
  });
  const id = "lt-" + register + "-" + (++saleSeq) + "-" + Math.random().toString(36).slice(2, 8);
  const at = Date.now();
  return {
    id, no: "LT-" + saleSeq, at, t: at,
    channel: dineIn ? "dine_in" : "takeaway", table: dineIn ? 1 + Math.floor(Math.random() * 12) : null,
    tender: "cash", subtotal: b.items, billDisc: b.disc, svcCharge: b.svc, gst: b.gst, total: b.total,
    lines: lines.map((l, i) => ({ pid: l.pid, qty: l.qty, price: l.unit, amount: b.lines[i] })),
    payments: [{ method: "cash", amount: b.total }],
  };
}

/* ── run ──────────────────────────────────────────────────────────────── */
(async () => {
  console.log("KashikeyoPOS capacity harness");
  console.log("  candidates  " + CANDIDATES.join("  ·  "));

  let health = null;
  for (const c of CANDIDATES) {
    BASE = c;
    health = await get("/api/health").then((r) => r.json()).catch((e) => ({ _err: String((e && e.message) || e) }));
    if (health && health.ready) { console.log("  reachable   " + BASE); break; }
    console.log("  unreachable " + c + "  (" + JSON.stringify(health) + ")");
    health = null;
  }
  if (!health) { console.error("\nNo candidate answered a ready /api/health."); process.exit(1); }
  console.log("  levels      " + LEVELS.join(", ") + " concurrent tills");
  console.log("  per level   " + SECONDS + "s\n");

  /* One org, many registers — a chain of tills against one store's data, which
     is the shape that actually contends (same RLS scope, same rowver sequence). */
  const email = `load-${Date.now()}@loadtest.invalid`;
  const reg = await post("/api/register", { email, password: "loadtest1234", storeName: "Load Test", currency: "MVR", pin: "1234" })
    .then((r) => r.json());
  if (!reg || !reg.token) { console.error("register failed: " + JSON.stringify(reg)); process.exit(1); }
  const token = reg.token;
  const cookie = "";
  const auth = { Authorization: "Bearer " + token };

  const products = [];
  const puts = [];
  for (let i = 1; i <= 12; i++) {
    const p = { id: "lp" + i, name: "Load dish " + i, price: 2500 + i * 500, cat: 1 };
    products.push(p);
    puts.push({ kind: "products", id: p.id, data: p });
  }
  const seed = await post("/api/ops", { ops: [{ opId: "load-seed", puts }] }, auth);
  if (!seed.ok) { console.error("seed failed: " + seed.status); process.exit(1); }
  console.log("seeded " + products.length + " products as " + email + "\n");

  const rows = [];
  for (const level of LEVELS) {
    const ops = new Track(), pull = new Track(), boot = new Track();
    const stop = Date.now() + SECONDS * 1000;
    const t0 = Date.now();

    /* Each worker is one till: it settles sales back to back, and every fifth
       iteration also runs the sync poll the real client runs every 5 seconds. */
    const worker = async (w) => {
      let since = 0, i = 0;
      while (Date.now() < stop) {
        i++;
        const sale = makeSale(products, w);
        await timed(ops, () => post("/api/ops", {
          ops: [{ opId: "lt-" + w + "-" + i + "-" + sale.id, puts: [{ kind: "sales", id: sale.id, data: sale }] }],
        }, auth));
        if (i % 5 === 0) {
          await timed(pull, async () => {
            const r = await get("/api/pull?since=" + since, auth);
            if (r.ok) { const j = await r.json(); since = j.rowver || since; }
            return r;
          });
        }
      }
    };
    /* One terminal reload in flight throughout — the heaviest read in the app,
       so its latency under write pressure is the number that matters for a
       cashier opening the till mid-rush. */
    const reader = async () => {
      while (Date.now() < stop) {
        await timed(boot, () => get("/api/app2/live", auth));
        await new Promise((r) => setTimeout(r, 250));
      }
    };

    await Promise.all([...Array.from({ length: level }, (_, w) => worker(w)), reader()]);
    const wall = Date.now() - t0;
    const o = ops.summary(wall), p = pull.summary(wall), l = boot.summary(wall);
    rows.push({ level, o, p, l });
    console.log(
      `${String(level).padStart(3)} tills │ sales ${String(o.rps).padStart(7)}/s  ` +
      `p50 ${String(o.p50).padStart(5)}ms  p95 ${String(o.p95).padStart(5)}ms  p99 ${String(o.p99).padStart(5)}ms  ` +
      `err ${o.err}` + (Object.keys(o.codes).filter((c) => c !== "200").length ? "  codes " + JSON.stringify(o.codes) : ""));
  }

  console.log("\n─── sustained throughput ──────────────────────────────────────");
  console.log("tills │  sales/s │ sales/hr │  p95 ms │  p99 ms │ errors │ pull p95 │ live p95");
  for (const r of rows) {
    console.log(
      String(r.level).padStart(5) + " │ " +
      String(r.o.rps).padStart(8) + " │ " +
      String(Math.round(r.o.rps * 3600)).padStart(8) + " │ " +
      String(r.o.p95).padStart(7) + " │ " +
      String(r.o.p99).padStart(7) + " │ " +
      String(r.o.err).padStart(6) + " │ " +
      String(r.p.p95).padStart(8) + " │ " +
      String(r.l.p95).padStart(8));
  }
  const best = rows.reduce((a, b) => (b.o.rps > a.o.rps ? b : a), rows[0]);
  const floor = 100;                                    // the audit's stated floor, tx/hour
  console.log("\npeak sustained: " + Math.round(best.o.rps * 3600).toLocaleString() +
    " sales/hour at " + best.level + " concurrent tills (p95 " + best.o.p95 + "ms)");
  console.log("that is " + Math.round((best.o.rps * 3600) / floor) + "x the audit's " + floor + "/hour floor");
  const errs = rows.reduce((n, r) => n + r.o.err, 0);
  console.log(errs ? "\n*** " + errs + " request(s) errored — see codes above" : "\nno errors at any level");
})().catch((e) => { console.error("harness failed:", e); process.exit(1); });
