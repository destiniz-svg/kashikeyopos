#!/usr/bin/env node
/*
 * KashikeyoPOS load test  (audit §3.2)  —  zero dependencies, Node 18+ (native fetch).
 *
 * Drives the REAL sync write path: it registers a throwaway store, seeds a few
 * products, then pushes internally-consistent "honest" sales through
 * POST /api/ops (unique opId + sale id each time, so every one is a real insert
 * exercising the entities upsert + poke + money-audit path), interleaving
 * GET /api/pull reads. It reports latency percentiles, throughput and an error
 * breakdown per stage.
 *
 * SAFETY: by default it REGISTERS ITS OWN STORE, so it never touches existing
 * data — run it against your STAGING url. It prints the store slug so you can
 * find/remove it afterwards. Point it at production only deliberately (--token
 * of a throwaway store) — it writes real sales.
 *
 * Usage:
 *   node scripts/loadtest.mjs --url https://kashikeyopos-staging.up.railway.app
 *   node scripts/loadtest.mjs --url <staging> --stages 100,250,500,1000 --stage-secs 300
 *   node scripts/loadtest.mjs --url <staging> --soak-hours 24 --rate 400
 *   node scripts/loadtest.mjs --url <staging> --stress 50 --stress-secs 60   # find the ceiling
 *
 * Flags:
 *   --url <base>          target base URL (required)
 *   --token <jwt>         use an existing store's Bearer token instead of registering
 *   --stages a,b,c        ramp through these tx/hr rates (default 100,250,500,1000)
 *   --stage-secs N        seconds per stage (default 120)
 *   --rate R              single sustained rate for a soak (tx/hr); overrides --stages
 *   --soak-hours H        run --rate for H hours (default: one stage-secs window)
 *   --stress C            closed-loop mode: C concurrent workers, fire as fast as possible
 *   --stress-secs N       stress duration (default 60)
 *   --pull-ratio P        do a /api/pull after roughly every 1/P sales (default 0.15)
 *   --credit-ratio P      fraction of sales charged to a customer's credit (default 0.2)
 *   --products N          seed N products (default 12)
 *   --customers N         seed N credit customers (default 6)
 *   --concurrency-cap M   max in-flight requests in rate mode (default 200)
 */

import crypto from "node:crypto";

// ── args ─────────────────────────────────────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = (process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) ? process.argv[++i] : true;
}
const URL = (args.url || "").replace(/\/$/, "");
if (!URL) { console.error("ERROR: --url <base> is required"); process.exit(2); }
const STAGES = (args.rate ? [Number(args.rate)] : String(args.stages || "100,250,500,1000").split(",").map(Number));
const STAGE_SECS = args.rate ? Math.round((Number(args["soak-hours"] || 0) * 3600) || Number(args["stage-secs"] || 120)) : Number(args["stage-secs"] || 120);
const PULL_RATIO = Number(args["pull-ratio"] || 0.15);
const CREDIT_RATIO = Number(args["credit-ratio"] || 0.2);
const N_PRODUCTS = Number(args.products || 12);
const N_CUSTOMERS = Number(args.customers || 6);
const CAP = Number(args["concurrency-cap"] || 200);
const STRESS = args.stress ? Number(args.stress) : 0;
const STRESS_SECS = Number(args["stress-secs"] || 60);
const GST_RATE = 0.08;

// ── tiny http ────────────────────────────────────────────────────────────
async function http(method, path, { body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const t0 = performance.now();
  try {
    const r = await fetch(URL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const ms = performance.now() - t0;
    // drain body so the socket frees
    await r.text().catch(() => {});
    return { ok: r.ok, status: r.status, ms };
  } catch (e) {
    return { ok: false, status: 0, ms: performance.now() - t0, err: String(e.message || e) };
  }
}

function pctl(arr, p) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const round = (n) => Math.round(n * 10) / 10;

// ── setup: store + products ───────────────────────────────────────────────
let TOKEN = args.token && args.token !== true ? args.token : null;
let PRODUCTS = [];
let CUSTOMERS = [];
async function setup() {
  if (!TOKEN) {
    const email = `loadtest-${Date.now()}-${crypto.randomBytes(3).toString("hex")}@test.mv`;
    const r = await fetch(URL + "/api/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "pass1234", storeName: "LOADTEST (safe to delete)", currency: "MVR", pin: "1234" }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.token) { console.error("register failed:", r.status, JSON.stringify(j)); process.exit(1); }
    TOKEN = j.token;
    console.log(`registered throwaway store  slug=${j.slug}  email=${email}`);
  } else {
    console.log("using supplied --token");
  }
  // seed products + credit customers via ops
  const puts = [];
  for (let i = 0; i < N_PRODUCTS; i++) {
    const id = "lt-p" + i;
    const price = 1500 + i * 500; // 15.00 .. laari
    PRODUCTS.push({ id, price });
    puts.push({ kind: "products", id, data: { id, name: "LoadTest Item " + i, price } });
  }
  for (let i = 0; i < N_CUSTOMERS; i++) {
    const id = "lt-c" + i;
    // mixed limits: some small (breach quickly → exercises over-limit flagging),
    // some large, one unlimited (0) — a realistic spread
    const creditLimit = i % 3 === 0 ? 0 : (i % 3 === 1 ? 30000 : 200000);
    CUSTOMERS.push({ id, creditLimit });
    puts.push({ kind: "customers", id, data: { id, name: "LoadTest Customer " + i, balance: 0, creditLimit } });
  }
  const r = await http("POST", "/api/ops", { token: TOKEN, body: { ops: [{ opId: "lt-seed-" + crypto.randomUUID(), puts }] } });
  if (!r.ok) { console.error("seeding failed:", r.status); process.exit(1); }
  console.log(`seeded ${N_PRODUCTS} products + ${N_CUSTOMERS} credit customers\n`);
}

// build one internally-consistent (audit-passing) sale op. If `cust` is given it's
// a CREDIT sale: paid on the customer's account + a balance delta of the total,
// which the server checks against the credit limit (FIN-02).
function saleOp(cust) {
  const n = 1 + Math.floor(Math.random() * 4);
  const lines = [];
  let subtotal = 0;
  for (let i = 0; i < n; i++) {
    const p = PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)];
    const qty = 1 + Math.floor(Math.random() * 3);
    lines.push({ pid: p.id, qty, price: p.price, taxable: true });
    subtotal += qty * p.price;
  }
  const gst = Math.round(subtotal * GST_RATE);
  const total = subtotal + gst;
  const id = "lt-s-" + crypto.randomUUID();
  const data = {
    id, no: "INV-LT-" + id.slice(-6), type: "sale", lines,
    subtotal, billDisc: 0, billDiscPct: 0, gst, svcCharge: 0, fee: 0, total,
    payments: [{ method: cust ? "Credit" : "Cash", amount: total }],
  };
  const op = { opId: "lt-op-" + crypto.randomUUID(), puts: [{ kind: "sales", id, data }] };
  if (cust) {
    data.custId = cust.id;
    op.deltas = { cust: [{ id: cust.id, pts: 0, bal: total }] }; // balance += total
  }
  return op;
}

// pick the next transaction: cash, or a credit sale to a random customer
function nextTx() {
  const useCredit = CUSTOMERS.length && Math.random() < CREDIT_RATIO;
  const cust = useCredit ? CUSTOMERS[Math.floor(Math.random() * CUSTOMERS.length)] : null;
  return { op: saleOp(cust), credit: !!cust };
}

// ── metrics ────────────────────────────────────────────────────────────────
function newM() { return { sale: [], pull: [], ok: 0, err: 0, status: {}, credit: 0 }; }
function record(m, kind, r) {
  m[kind].push(r.ms);
  if (r.ok) m.ok++; else { m.err++; m.status[r.status] = (m.status[r.status] || 0) + 1; }
}
function report(label, m, secs) {
  const all = m.sale.concat(m.pull);
  const n = all.length;
  const errPct = n ? round((m.err / n) * 100) : 0;
  console.log(`\n── ${label} ──`);
  console.log(`  requests ${n}   sales ${m.sale.length}   pulls ${m.pull.length}   over ${round(secs)}s`);
  console.log(`  throughput ${round(n / secs)} req/s   (${round(m.sale.length / secs * 3600)} sales/hr achieved)`);
  console.log(`  errors ${m.err} (${errPct}%)${Object.keys(m.status).length ? "  " + JSON.stringify(m.status) : ""}`);
  if (m.sale.length) console.log(`  mix  ${m.sale.length - m.credit} cash / ${m.credit} credit sales`);
  if (m.sale.length) console.log(`  sale  latency ms  p50 ${round(pctl(m.sale, 50))}  p95 ${round(pctl(m.sale, 95))}  p99 ${round(pctl(m.sale, 99))}  max ${round(Math.max(...m.sale))}`);
  if (m.pull.length) console.log(`  pull  latency ms  p50 ${round(pctl(m.pull, 50))}  p95 ${round(pctl(m.pull, 95))}  p99 ${round(pctl(m.pull, 99))}`);
  return { n, errPct, p95: round(pctl(m.sale, 95)), p99: round(pctl(m.sale, 99)) };
}

// ── rate (open-loop) stage ──────────────────────────────────────────────────
let sinceCursor = 0;
async function runStage(rate, secs) {
  const m = newM();
  const interval = 3600000 / rate; // ms between sale launches
  let inflight = 0, launched = 0;
  const start = performance.now();
  const end = start + secs * 1000;
  const tick = setInterval(() => {
    const pct = round((m.sale.length + m.pull.length) / secs);
    process.stdout.write(`\r  running ${rate} tx/hr … ${m.sale.length} sales, ${m.err} errs, ${inflight} in-flight   `);
  }, 2000);
  await new Promise((resolve) => {
    const timer = setInterval(async () => {
      if (performance.now() >= end) { clearInterval(timer); return; }
      if (inflight >= CAP) return; // backpressure
      launched++;
      inflight++;
      const doPull = Math.random() < PULL_RATIO;
      const tx = nextTx();
      const r = await http("POST", "/api/ops", { token: TOKEN, body: { ops: [tx.op] } });
      record(m, "sale", r); if (tx.credit) m.credit++;
      if (doPull) { const pr = await http("GET", "/api/pull?since=" + sinceCursor, { token: TOKEN }); record(m, "pull", pr); }
      inflight--;
    }, interval);
    // resolve once time is up and everything drains
    const waiter = setInterval(() => {
      if (performance.now() >= end && inflight === 0) { clearInterval(waiter); resolve(); }
    }, 200);
  });
  clearInterval(tick);
  process.stdout.write("\r" + " ".repeat(70) + "\r");
  return report(`stage ${rate} tx/hr`, m, (performance.now() - start) / 1000);
}

// ── stress (closed-loop) mode ────────────────────────────────────────────────
async function runStress(conc, secs) {
  const m = newM();
  const start = performance.now();
  const end = start + secs * 1000;
  const tick = setInterval(() => process.stdout.write(`\r  stress x${conc} … ${m.sale.length} sales, ${m.err} errs   `), 1000);
  async function worker() {
    while (performance.now() < end) {
      const tx = nextTx();
      const r = await http("POST", "/api/ops", { token: TOKEN, body: { ops: [tx.op] } });
      record(m, "sale", r); if (tx.credit) m.credit++;
      if (Math.random() < PULL_RATIO) record(m, "pull", await http("GET", "/api/pull?since=0", { token: TOKEN }));
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  clearInterval(tick);
  process.stdout.write("\r" + " ".repeat(60) + "\r");
  return report(`stress x${conc}`, m, (performance.now() - start) / 1000);
}

// ── main ─────────────────────────────────────────────────────────────────
(async () => {
  console.log(`KashikeyoPOS load test → ${URL}`);
  const h = await http("GET", "/api/health");
  console.log(`health: ${h.status} (${round(h.ms)}ms)`);
  const v = await fetch(URL + "/version").then((r) => r.json()).catch(() => null);
  if (v) console.log(`target: environment=${v.environment} commit=${v.commitShort}`);
  console.log("");
  await setup();

  const summary = [];
  if (STRESS) {
    summary.push(["stress x" + STRESS, await runStress(STRESS, STRESS_SECS)]);
  } else {
    for (const rate of STAGES) {
      const res = await runStage(rate, STAGE_SECS);
      summary.push(["stage " + rate + "/hr", res]);
    }
  }

  // confirm the credit path actually fired: over-limit customers get flagged (FIN-02)
  const flags = await fetch(URL + "/api/inv/flags", { headers: { Authorization: "Bearer " + TOKEN } }).then((r) => r.json()).catch(() => null);
  if (flags) console.log(`\ncredit path check → over-limit customers flagged: ${(flags.credit || []).length}   money-flagged sales: ${(flags.sales || []).length}`);

  console.log("\n════════ SUMMARY ════════");
  for (const [label, s] of summary) {
    const verdict = s.errPct <= 0.5 && s.p95 <= 500 ? "OK" : (s.errPct <= 2 && s.p95 <= 1500 ? "WATCH" : "FAIL");
    console.log(`  ${label.padEnd(16)} reqs ${String(s.n).padStart(6)}  err ${String(s.errPct).padStart(5)}%  p95 ${String(s.p95).padStart(6)}ms  p99 ${String(s.p99).padStart(6)}ms  → ${verdict}`);
  }
  console.log("\nGuide: OK = err ≤0.5% & p95 ≤500ms · WATCH = err ≤2% & p95 ≤1.5s · FAIL otherwise.");
  console.log("Also watch Railway metrics during the run: CPU, memory, and Postgres connections.");
  console.log("Zero duplicate/lost sales is guaranteed by the idempotent op-log (covered by npm test).");
})();
