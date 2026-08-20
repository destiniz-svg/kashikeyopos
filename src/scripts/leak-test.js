'use strict';
/* ═══ LEAK TEST ═════════════════════════════════════════════════════════════
   Ten crossing attempts, non-zero exit on any leak. This runs IN THE DEPLOY
   PIPELINE, not in a checklist: isolation you assert is isolation you hope
   for; isolation you attack is isolation you have.

   Every attempt is made as outlet 2's own login role — the credential a
   compromised or buggy request handler would actually be holding.
   ═══════════════════════════════════════════════════════════════════════ */

const { Pool } = require('pg');
const { owner, withOutlet, shutdown } = require('../db');
const { outletPassword } = require('../secrets');
const { provisionOutlet } = require('../provision');

function conn(user, password) {
  const base = process.env.DATABASE_URL
    ? (() => { const u = new URL(process.env.DATABASE_URL);
      return { host: u.hostname, port: Number(u.port || 5432),
        database: decodeURIComponent((u.pathname || '/postgres').slice(1)) }; })()
    : { host: process.env.PGHOST || '127.0.0.1',
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE || 'postgres' };
  return new Pool(Object.assign(base, { user, password, max: 2,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false }));
}

async function run(log) {
  const say = log || console.log;
  const results = [];
  const fail = (name, detail) => results.push({ name, leaked: true, detail });
  const pass = (name) => results.push({ name, leaked: false });

  // Two outlets, each with something worth stealing.
  const A = await ensureOutlet(1, 'KOCHA', 'Outlet A');
  const B = await ensureOutlet(2, 'KOHUL', 'Outlet B');
  await seed(A.id, 'A-SECRET-SALE');
  await seed(B.id, 'B-SECRET-SALE');

  const bPool = conn('outlet_' + B.id + '_app', outletPassword(B.id));
  const c = await bPool.connect();

  // Each attempt gets its own savepoint: a refusal aborts the transaction, and
  // the next attempt must still be able to run.
  let probe = 0;
  async function denied(name, sql, params) {
    const sp = 'probe_' + (++probe);
    await c.query('SAVEPOINT ' + sp);
    try {
      const q = await c.query(sql, params || []);
      if (q.rows && q.rows.length) fail(name, JSON.stringify(q.rows[0]).slice(0, 160));
      else pass(name);
    } catch (e) {
      // A refusal is the correct answer, whether it is "no such table",
      // "permission denied" or a policy returning nothing.
      pass(name);
    }
    await c.query('ROLLBACK TO SAVEPOINT ' + sp);
  }

  await c.query('BEGIN');
  await c.query("SELECT set_config('app.outlet_id','" + B.id + "',true),"
    + " set_config('app.user_rank','5',true), set_config('app.scope','outlet',true)");

  // 1-4 · reach straight into the other outlet's schema.
  await denied('1 · read outlet A sales by qualified name',
    'SELECT receipt_no FROM outlet_' + A.id + '.sale LIMIT 1');
  await denied('2 · read outlet A journal lines',
    'SELECT account_code, dr FROM outlet_' + A.id + '.journal_line LIMIT 1');
  await denied('3 · read outlet A supplier invoices',
    'SELECT invoice_no FROM outlet_' + A.id + '.vendor_invoice LIMIT 1');
  await denied('4 · read outlet A stock ledger',
    'SELECT ingredient_id, qty FROM outlet_' + A.id + '.stock_move LIMIT 1');

  // 5 · write into the other outlet.
  await denied('5 · insert into outlet A op log',
    "INSERT INTO outlet_" + A.id + ".op_log (op_id, kind, payload, client_at)"
    + " VALUES (gen_random_uuid(),'leak','{}'::jsonb, now()) RETURNING op_id");

  // 6-8 · the control plane, through RLS.
  await denied('6 · read outlet A staff rows',
    'SELECT name FROM chain.staff WHERE outlet_id = $1', [A.id]);
  await denied('7 · read outlet A audit trail',
    'SELECT action FROM chain.audit WHERE outlet_id = $1', [A.id]);
  await denied('8 · read outlet A document series',
    'SELECT prefix, next_no FROM chain.doc_series WHERE outlet_id = $1', [A.id]);

  // 9 · claim group scope without the rank that grants it. The scope setting
  //     is a request-level claim; app.group_scope() checks rank too.
  await c.query("SELECT set_config('app.scope','group',true),"
    + " set_config('app.user_rank','3',true)");
  await denied('9 · rank-3 session claiming group scope reads the estate',
    'SELECT id, name FROM chain.outlet WHERE id = $1', [A.id]);

  // 10 · escalate: try to become the other outlet's role, or the owner.
  await c.query("SELECT set_config('app.user_rank','5',true)");
  await denied('10 · switch to outlet A role',
    "SET ROLE outlet_" + A.id + "_app");
  await denied('10b · read another role’s password hash',
    "SELECT rolpassword FROM pg_authid WHERE rolname = 'outlet_" + A.id + "_app'");
  await denied('10c · create a schema of its own',
    'CREATE SCHEMA leak_probe');

  await c.query('ROLLBACK').catch(() => {});
  c.release();
  await bPool.end();

  // The one legitimate crossing, and only at rank 5 in group scope.
  let estateOk = false;
  try {
    const { withEstate } = require('../db');
    const rows = await withEstate({ outletId: B.id, rank: 5, actor: null },
      (cl) => cl.query('SELECT * FROM chain.estate_day(current_date)').then((q) => q.rows));
    estateOk = Array.isArray(rows) && rows.length >= 2;
  } catch (e) { estateOk = false; }
  results.push({ name: '11 · rank-5 group scope CAN read estate aggregates',
    leaked: !estateOk, detail: estateOk ? '' : 'estate_day() did not return both outlets' });

  const leaks = results.filter((r) => r.leaked);
  results.forEach((r) => say((r.leaked ? '  LEAK  ' : '  ok    ') + r.name
    + (r.detail ? '  ' + r.detail : '')));
  say(leaks.length ? '[leak-test] ' + leaks.length + ' LEAK(S)' : '[leak-test] no leaks');
  return { results, leaks: leaks.length };
}

async function ensureOutlet(id, code, name) {
  const q = await owner().query('SELECT id, code FROM chain.outlet WHERE id = $1', [id]);
  if (q.rows.length) return q.rows[0];
  return provisionOutlet({ id, code, name });
}

// Something worth stealing at each outlet, written through that outlet's own
// role so the row really does belong to it.
async function seed(outletId, marker) {
  await withOutlet({ outletId, rank: 5, actor: null }, async (c) => {
    const has = await c.query('SELECT 1 FROM sale LIMIT 1');
    if (has.rows.length) return;
    await c.query("INSERT INTO ticket (id, table_no, status, covers, closed_at, closed_by)"
      + " VALUES (gen_random_uuid(),'L1','closed',1, now(), NULL)");
    await c.query(
      'INSERT INTO sale (receipt_no, business_date, channel, covers, subtotal,'
      + ' discount, net, service, tax_code, tax_label, tax_rate, tax, rounding,'
      + " total, closed_by) VALUES ($1, current_date,'dine_in',1,100,0,100,0,"
      + "'GGST','GGST 8%',8,8,0,108, '00000000-0000-0000-0000-000000000000')",
      [marker]);
    await c.query("INSERT INTO chain.audit (outlet_id, action, entity, entity_id)"
      + " VALUES ($1,'leak_seed','sale',$2)", [outletId, marker]);
  });
}

if (require.main === module) {
  run().then((r) => shutdown().then(() => process.exit(r.leaks ? 1 : 0)))
    .catch((e) => { console.error('[leak-test] failed:', e.message); process.exit(1); });
}

module.exports = { run };
