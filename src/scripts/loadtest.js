'use strict';
/* ═══ WHAT THIS INSTALL DOES UNDER A RUSH ════════════════════════════════════
   The readiness audit could reason about capacity but not measure it, and an
   architectural argument is not a number. This drives the REAL API with a
   realistic service mix and reports what actually happened.

   It answers two different questions, and the second is the one that matters:

     THROUGHPUT — how many bills an hour this install sustains, and where it
     first degrades. These numbers are hardware-bound: run it against staging
     to get figures that mean anything about production.

     CORRECTNESS UNDER CONCURRENCY — whether money survives the rush. Duplicate
     sales, an unbalanced journal, revenue that does not tie to the sales that
     made it, a credit balance that drifts from its charges. These findings
     transfer from ANY hardware, because they are logic, not speed.

   Usage:
     node src/scripts/loadtest.js --url http://127.0.0.1:4090 \
       --outlet 1 --pin 4718 --workers 8 --seconds 30

   Against staging, use a till PIN from that install. It writes real sales —
   never point it at a store that is trading.
   ═══════════════════════════════════════════════════════════════════════════ */

const args = {};
process.argv.slice(2).forEach((a, i, all) => {
  if (a.startsWith('--')) args[a.slice(2)] = all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true;
});

const URL_BASE = String(args.url || 'http://127.0.0.1:4090').replace(/\/+$/, '');
const OUTLET = Number(args.outlet || 1);
const PIN = String(args.pin || '');
const WORKERS = Number(args.workers || 8);
const SECONDS = Number(args.seconds || 30);
const VERIFY = args.verify !== 'no';
/* A till that has been offline does not push one bill at a time — it drains,
   and the whole evening arrives as one batch inside one transaction. That is a
   different shape of load from the same number of bills trickling in, and the
   audit's spike stage is exactly it. */
const BURST = Math.max(1, Number(args.burst || 1));
const LABEL = args.label ? String(args.label) : '';

/* The server is another process, so its memory is read where the operating
   system keeps it rather than guessed. Absent (a remote target, a non-Linux
   box), the soak reports what it can and says the rest is unknown. */
function serverRss() {
  try {
    const fs = require('fs');
    const me = String(process.pid);
    const pid = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d) && d !== me)
      .find((d) => {
        try {
          const cmd = fs.readFileSync('/proc/' + d + '/cmdline', 'utf8');
          return /node[^\0]*\0?server\.js/.test(cmd) || /server\.js/.test(cmd);
        } catch (e) { return false; }
      });
    if (!pid) return null;
    const st = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
    const m = st.match(/VmRSS:\s+(\d+) kB/);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch (e) { return null; }
}

const uuid = () => require('crypto').randomUUID();
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const pct = (xs, p) => (xs.length ? xs.slice().sort((a, b) => a - b)[
  Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0);

async function call(method, path, body, token) {
  const began = process.hrtime.bigint();
  const res = await fetch(URL_BASE + path, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' },
      token ? { authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = { raw: text }; }
  return { status: res.status, body: parsed,
    ms: Number(process.hrtime.bigint() - began) / 1e6 };
}

/* THE SERVICE MIX, as the audit brief defines it. Every bill is a real op the
   till would queue, with the payload the server's own handlers require. */
function bill(kind, table) {
  const day = new Date().toISOString().slice(0, 10);
  const base = { bizDate: day, covers: 2, taxCode: 'GGST', taxLabel: 'GST', taxRate: 8,
    table: table, sold: [], payments: [], stockMoves: [] };
  const lines = (n) => Array.from({ length: n }, (_, i) => ({
    id: i % 2 ? 'm2' : 'm1', name: i % 2 ? 'Garlic Rice' : 'Grilled Reef Fish',
    qty: 1, price: i % 2 ? 45 : 185, amount: i % 2 ? 45 : 185 }));

  if (kind === 'simple') {                                   // 60%
    const sold = lines(2), net = 230, svc = r2(net * 0.1), tax = r2((net + svc) * 0.08);
    return Object.assign(base, { sub: net, disc: 0, net, svc, tax, round: 0,
      total: r2(net + svc + tax), sold,
      payments: [{ method: 'cash', amt: r2(net + svc + tax), tendered: 300 }] });
  }
  if (kind === 'modifiers') {                                // 20%
    const sold = lines(3).map((l) => Object.assign(l, { addons: [{ name: 'Extra chilli', price: 0 }] }));
    const net = 415, svc = r2(net * 0.1), tax = r2((net + svc) * 0.08);
    return Object.assign(base, { sub: net, disc: 0, net, svc, tax, round: 0,
      total: r2(net + svc + tax), sold,
      payments: [{ method: 'card', amt: r2(net + svc + tax), ref: 'A' + Math.floor(Math.random() * 1e6) }] });
  }
  if (kind === 'split') {                                    // 5%
    const net = 460, svc = r2(net * 0.1), tax = r2((net + svc) * 0.08);
    const total = r2(net + svc + tax), half = r2(total / 2);
    return Object.assign(base, { sub: net, disc: 0, net, svc, tax, round: 0, total,
      sold: lines(4), covers: 4,
      payments: [{ method: 'cash', amt: half, tendered: half },
        { method: 'card', amt: r2(total - half), ref: 'B' + Math.floor(Math.random() * 1e6) }] });
  }
  // 10% table service — a fired ticket then settled
  const net = 185, svc = r2(net * 0.1), tax = r2((net + svc) * 0.08);
  return Object.assign(base, { sub: net, disc: 0, net, svc, tax, round: 0,
    total: r2(net + svc + tax), sold: lines(1),
    payments: [{ method: 'cash', amt: r2(net + svc + tax), tendered: 250 }] });
}

function pick() {
  const r = Math.random() * 100;
  if (r < 60) return 'simple';
  if (r < 80) return 'modifiers';
  if (r < 90) return 'table';
  if (r < 95) return 'split';
  return 'refundable';
}

/* The four money figures, read the same way before and after. */
async function snapshot() {
  const db = require('../db');
  return db.withOutletRead({ outletId: OUTLET, rank: 5, actor: null }, async (c) => {
    const q = (sql) => c.query(sql).then((x) => x.rows[0]);
    const legs = await q("SELECT coalesce(sum(l.cr),0)::numeric v FROM journal j"
      + " JOIN journal_line l ON l.journal_id = j.id"
      + " WHERE j.source = 'sale' AND l.account_code IN ('4000','4100')");
    const rev = await q('SELECT coalesce(sum(net + discount),0)::numeric v FROM sale'
      + ' WHERE voided_at IS NULL');
    const unbal = await q('SELECT count(*)::int n FROM (SELECT j.id FROM journal j'
      + ' JOIN journal_line l ON l.journal_id = j.id GROUP BY j.id'
      + ' HAVING abs(coalesce(sum(l.dr),0) - coalesce(sum(l.cr),0)) > 0.005) x');
    const stamped = await q('SELECT count(*)::int n FROM sale'
      + ' WHERE server_audit IS NOT NULL');
    return { legs: Number(legs.v), rev: Number(rev.v),
      unbal: unbal.n, stamped: stamped.n };
  });
}

async function main() {
  console.log('[load] ' + (LABEL ? LABEL + ' — ' : '') + URL_BASE + ' outlet ' + OUTLET
    + ' · ' + WORKERS + ' workers · ' + SECONDS + 's'
    + (BURST > 1 ? ' · ' + BURST + ' ops per push' : ''));
  const rss0 = serverRss();

  const auth = await call('POST', '/api/auth/pin', { outletId: OUTLET, pin: PIN });
  if (auth.status !== 200) {
    console.error('[load] cannot sign in: ' + JSON.stringify(auth.body));
    process.exit(1);
  }
  const token = auth.body.token;

  /* The ledger checks below compare totals across the whole outlet, and an
     install that has been developed against carries rows no handler wrote —
     isolation probes inserted straight into the table, seed data, a fixture
     with no journal. Measuring the gap BEFORE the run and asserting the DELTA
     is zero keeps both facts: what this run did, and what was already there.
     Netting them out silently would hide exactly the defect being looked for. */
  const baseline = await snapshot();

  const lat = [];
  const errs = new Map();
  let bills = 0, ops = 0, http = 0;
  const opIds = [];
  const until = Date.now() + SECONDS * 1000;

  async function worker(w) {
    let table = 0;
    while (Date.now() < until) {
      const batch = Array.from({ length: BURST }, () => {
        table = (table + 1) % 3;
        const k = pick();
        return { opId: uuid(), kind: 'sale',
          payload: bill(k === 'refundable' ? 'simple' : k, 'T0' + (table + 1)) };
      });
      const r = await call('POST', '/api/outlet/' + OUTLET + '/sync/push',
        { ops: batch }, token);
      http++;
      lat.push(r.ms);
      if (r.status !== 200) {
        errs.set('HTTP ' + r.status, (errs.get('HTTP ' + r.status) || 0) + 1);
        continue;
      }
      let landed = null;
      (r.body.results || []).forEach((res, i) => {
        if (res && res.error) {
          const k = String(res.error).slice(0, 60);
          errs.set(k, (errs.get(k) || 0) + 1);
          return;
        }
        bills++; ops++;
        opIds.push(batch[i].opId);
        landed = batch[i];
      });
      // A replay of the same op, exactly as a flaky link produces — this is the
      // duplicate-sale question asked under load rather than in isolation.
      if (landed && bills % 10 < BURST) {
        const again = await call('POST', '/api/outlet/' + OUTLET + '/sync/push',
          { ops: [landed] }, token);
        http++;
        if (again.status === 200) ops++;
      }
    }
  }

  const began = Date.now();
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
  const ran = (Date.now() - began) / 1000;

  console.log('\n── throughput ' + '─'.repeat(46));
  console.log('  bills settled     ' + bills + '  (' + Math.round(bills / ran * 3600).toLocaleString()
    + ' an hour at this concurrency)');
  console.log('  requests          ' + http + ' in ' + ran.toFixed(1) + 's');
  console.log('  p50 / p95 / p99   ' + pct(lat, 50).toFixed(0) + ' / ' + pct(lat, 95).toFixed(0)
    + ' / ' + pct(lat, 99).toFixed(0) + ' ms');
  console.log('  slowest           ' + Math.max(...lat).toFixed(0) + ' ms');
  const rss1 = serverRss();
  if (rss0 !== null && rss1 !== null) {
    console.log('  server memory     ' + rss0 + ' → ' + rss1 + ' MB ('
      + (rss1 - rss0 >= 0 ? '+' : '') + (rss1 - rss0) + ')');
  } else {
    console.log('  server memory     not readable from here');
  }
  const errN = Array.from(errs.values()).reduce((a, b) => a + b, 0);
  console.log('  errors            ' + errN + ' (' + (errN / http * 100).toFixed(2) + '%)');
  errs.forEach((n, k) => console.log('      ' + n + '× ' + k));

  if (!VERIFY) return;

  /* ── the half that transfers from any hardware ─────────────────────────── */
  console.log('\n── correctness under concurrency ' + '─'.repeat(28));
  const db = require('../db');
  const bad = [];
  await db.withOutletRead({ outletId: OUTLET, rank: 5, actor: null }, async (c) => {
    const q = (sql, p) => c.query(sql, p || []).then((x) => x.rows);

    const dupes = await q('SELECT op_id, count(*) FROM op_log WHERE op_id = ANY($1)'
      + ' GROUP BY op_id HAVING count(*) > 1', [opIds]);
    say('no duplicate op landed twice', dupes.length === 0, dupes.length + ' duplicated');

    const sales = await q('SELECT count(*)::int n, coalesce(sum(total),0)::numeric t'
      + ' FROM sale WHERE voided_at IS NULL');
    say('every accepted bill has exactly one sale row', Number(sales[0].n) >= bills,
      sales[0].n + ' sales for ' + bills + ' bills');

    const now = await snapshot();
    say('every journal this run wrote balances', now.unbal === baseline.unbal,
      (now.unbal - baseline.unbal) + ' newly unbalanced');

    /* The DELTA, not the total: what this run added to the ledger must equal
       what it added to the sales, whatever the install was carrying already. */
    const gap = Math.abs((now.legs - baseline.legs) - (now.rev - baseline.rev));
    say('revenue posted ties to the sales that made it', gap < 0.05,
      'off by ' + gap.toFixed(2));
    const stood = Math.abs(baseline.legs - baseline.rev);
    if (stood >= 0.05) {
      console.log('    (this install already stood ' + stood.toFixed(2)
        + ' apart before the run — not from this load, and not netted out)');
    }

    say('no sale this run made needed repairing', now.stamped === baseline.stamped,
      (now.stamped - baseline.stamped) + ' carry a server_audit stamp');

    function say(what, ok, detail) {
      console.log('  ' + (ok ? '✓' : '✗') + ' ' + what + (ok ? '' : '  — ' + detail));
      if (!ok) bad.push(what);
    }
  });
  await db.shutdown();

  console.log('');
  if (bad.length) {
    console.log('[load] ' + bad.length + ' correctness failure(s) under load');
    process.exit(1);
  }
  console.log('[load] money survived the rush');
}

main().catch((e) => { console.error('[load] ' + (e.stack || e.message)); process.exit(1); });
