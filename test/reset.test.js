'use strict';
/* ═══ CLEARING WHAT A STORE TRADED, AND KEEPING WHAT IT IS ═══════════════════
   "Reset only data. Not menu. Reset to the state where a new outlet is
   created. Keep a record of the data and delete data."

   Two properties carry the whole feature and neither is visible by reading the
   handler:

   THE LINE IS DRAWN BY THE SCHEMA. Every table in an outlet schema is on
   exactly one side of it, and this file asserts that against the CATALOG — so
   a table a later migration adds, named on neither side, fails here rather
   than being silently kept (leaving a store's old sales behind) or silently
   dropped (taking a store's setup with it). That assertion is the reason the
   classifier can be a list at all.

   AND IT IS ONE OUTLET'S. A business may have several stores, and clearing one
   must not touch its sister — so a second outlet trades here, is never named,
   and is counted afterwards.

   Its own registry and its own business database, like test/backup.test.js,
   because a suite that resets a store cannot share one with a suite that
   expects that store's rows to still be there.
   ═══════════════════════════════════════════════════════════════════════════ */
const { test } = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const crypto = require('crypto');
const DB = require('./db');

DB.secrets();
process.env.BUSINESS_DB_PREFIX = 'krst_biz_';
const CONTROL = process.env.PGTESTCONTROL_RESET || 'kashikeyo_control_reset';
const opts = DB.configured() ? {}
  : { skip: 'no Postgres configured (set PGHOST or DATABASE_URL)' };

async function sql(database, text, params) {
  const c = new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: database
  });
  await c.connect();
  try { return (await c.query(text, params || [])).rows; } finally { await c.end(); }
}

const RST = require('../src/reset');
let dbmod, DBNAME, KEPT, GONE, ctx, before, out;

test('a business with two stores, both trading', opts, async () => {
  process.env.CONTROL_DB = await DB.freshControl(CONTROL);
  await DB.dropBusinessDatabases();
  const { migrateControl } = require('../src/scripts/migrate');
  await migrateControl(() => {});

  dbmod = require('../src/db');
  const { createBusiness } = require('../src/business');
  const { provisionOutlet } = require('../src/provision');
  const business = await createBusiness({ name: 'Reset Drill Pvt Ltd' });
  DBNAME = business.db_name;

  const stamp = String(Date.now()).slice(-6);
  const a = await provisionOutlet({ db: DBNAME, code: 'GONE', name: 'The one reset',
    slug: 'rstgone' + stamp, tz: 'Indian/Maldives' });
  const b = await provisionOutlet({ db: DBNAME, code: 'KEPT', name: 'Its sister',
    slug: 'rstkept' + stamp, tz: 'Indian/Maldives' });
  GONE = a.id || a;
  KEPT = b.id || b;
  assert.notStrictEqual(GONE, KEPT);

  const staff = await sql(DBNAME,
    "INSERT INTO chain.staff (name, rank, role_key, outlet_id, pin_hash, pin_salt)"
    + " VALUES ('Reset Owner', 5, 'SuperAdmin', $1, 'x', 'y') RETURNING id", [GONE]);
  ctx = { outletId: GONE, rank: 5, actor: staff[0].id, scope: 'outlet', db: DBNAME };

  // Setup: the shop itself, on both stores.
  for (const o of [GONE, KEPT]) {
    await sql(DBNAME, 'INSERT INTO outlet_' + o + '.menu_category (id, name, pos)'
      + " VALUES ('mains', 'Mains', 1)");
    await sql(DBNAME, 'INSERT INTO outlet_' + o + '.item (id, name, price, category_id)'
      + " VALUES ('d1', 'Mas Riha', 85, 'mains'), ('d2', 'Roshi', 5, 'mains')");
    await sql(DBNAME, 'INSERT INTO outlet_' + o + '.ingredient (id, name,'
      + ' base_unit, stock_unit, on_hand, avg_cost)'
      + " VALUES ('i1', 'Reef fish', 'kg', 'kg', 12.5, 90)");
    await sql(DBNAME, 'INSERT INTO outlet_' + o + '.table_def (id, label, seats)'
      + " VALUES ('t1', 'T01', 4)");
  }
  await sql(DBNAME, "INSERT INTO chain.member (name, phone, points, credit_used)"
    + " VALUES ('Aminath', '7771234', 420, 60)");

  // Trade: real rows through the op path, on both stores.
  const apply = require('../src/apply');
  const r2 = (n) => Math.round(n * 100) / 100;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Indian/Maldives' })
    .format(new Date());
  for (const o of [GONE, KEPT]) {
    const c = Object.assign({}, ctx, { outletId: o });
    for (let i = 1; i <= 4; i++) {
      const net = 100 * i, svc = r2(net * 0.1), tax = r2((net + svc) * 0.08);
      const g = r2(net + svc + tax), cash = Math.round(g * 2) / 2;
      await dbmod.withOutlet(c, (cl) => apply.applyOp(cl, {
        opId: crypto.randomUUID(), kind: 'sale', lamport: i,
        payload: { bizDate: day, covers: 2, sub: net, disc: 0, net: net, svc: svc,
          tax: tax, round: r2(cash - g), total: cash, taxCode: 'GGST',
          taxLabel: 'GST', taxRate: 8,
          sold: [{ id: 'd1', name: 'Mas Riha', qty: 1, price: net, amount: net }],
          payments: [{ method: 'cash', amt: cash }], stockMoves: [] } }, c));
    }
  }

  const s = await sql(DBNAME, 'SELECT (SELECT count(*)::int FROM outlet_' + GONE
    + '.sale) a, (SELECT count(*)::int FROM outlet_' + KEPT + '.sale) b');
  assert.strictEqual(s[0].a, 4, 'the store to be reset has traded');
  assert.strictEqual(s[0].b, 4, 'and so has its sister');
});

/* ═══ THE ASSERTION THE WHOLE CLASSIFIER RESTS ON ═══════════════════════════
   A list of table names is only safe while it is COMPLETE. Read from the
   catalog, not from the migrations: what matters is what the schema actually
   holds after every migration has run, which is what the TRUNCATE will meet. */
test('every table in an outlet schema is classified, exactly once', opts, async () => {
  const real = (await sql(DBNAME, 'SELECT tablename FROM pg_tables'
    + ' WHERE schemaname = $1 ORDER BY 1', ['outlet_' + GONE]))
    .map((r) => r.tablename);
  assert.ok(real.length > 40, 'the schema has tables to classify: ' + real.length);

  const named = RST.TRADE.concat(RST.SETUP);
  const unclassified = real.filter((t) => named.indexOf(t) < 0);
  assert.deepStrictEqual(unclassified, [],
    'a table in an outlet schema is on neither side of the line in src/reset.js.'
    + ' Decide: does a reset clear it (TRADE) or keep it (SETUP)? Leaving it'
    + ' unnamed means a store\'s old rows survive a reset that told the owner'
    + ' they were gone — ' + unclassified.join(', '));

  const phantom = named.filter((t) => real.indexOf(t) < 0);
  assert.deepStrictEqual(phantom, [],
    'src/reset.js names a table the schema does not have: ' + phantom.join(', '));

  const both = RST.TRADE.filter((t) => RST.SETUP.indexOf(t) >= 0);
  assert.deepStrictEqual(both, [], 'a table is on both sides: ' + both.join(', '));
});

/* AND POSTGRES CHECKS IT TOO. One TRUNCATE, no CASCADE — so if any table NOT
   on the trade list references one that is, the statement is refused and
   nothing is destroyed. CASCADE would follow that reference out into a setup
   table and empty it, which is the one mistake worth catching rather than
   papering over. Asserted by reading the source, because the behaviour only
   shows on the day somebody gets the classification wrong. */
test('the truncate is one statement and never CASCADE', opts, () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'reset.js'), 'utf8');
  const stmt = src.match(/'TRUNCATE '[^;]*/);
  assert.ok(stmt, 'there is a TRUNCATE');
  assert.ok(!/CASCADE/i.test(stmt[0]),
    'CASCADE would empty a setup table that happens to reference a trade one,'
    + ' which is exactly the misclassification the single statement exists to'
    + ' refuse: ' + stmt[0]);
  assert.match(stmt[0], /RESTART IDENTITY/, 'and sequences start again');

  /* THE RECORD IS WRITTEN BEFORE THE DELETE, and after it there is nothing
     left to count. Source order is the only place this is visible. */
  assert.ok(src.indexOf("chain.log('store_trade_reset'") < src.indexOf("'TRUNCATE '"),
    'the census reaches the trail before the rows go');

  /* NEVER owner(): in a registry install that is the database this process
     happens to sit on, which is one nobody trades in. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.match(code, /ownerForOutlet\(/, 'the address is resolved through the registry');
  assert.ok(!/\bowner\(\)/.test(code), 'and never the process\'s own database');
});

test('clearing the trade keeps the shop', opts, async () => {
  const count = async (o, t) => Number((await sql(DBNAME,
    'SELECT count(*)::int n FROM outlet_' + o + '."' + t + '"'))[0].n);
  before = {};
  for (const t of RST.SETUP) before[t] = await count(GONE, t);
  const seriesBefore = await sql(DBNAME, 'SELECT kind, next_no FROM chain.doc_series'
    + ' WHERE outlet_id = $1 AND next_no > 1', [GONE]);
  assert.ok(seriesBefore.length > 0, 'documents have been issued');

  out = await RST.resetTrade(ctx, { why: 'the training fortnight is over' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.bills, 4, 'and it reports what it cleared');
  assert.ok(out.rows > 20, 'across every trade table: ' + out.rows + ' rows');

  for (const t of RST.TRADE) {
    assert.strictEqual(await count(GONE, t), 0, t + ' still holds rows');
  }
  for (const t of RST.SETUP) {
    assert.strictEqual(await count(GONE, t), before[t],
      t + ' was touched, and it is the shop rather than the trading');
  }

  /* THE SHELF IS A TRADED FIGURE and the moves that made it have just gone. */
  const shelf = await sql(DBNAME, 'SELECT count(*)::int n FROM outlet_' + GONE
    + '.ingredient WHERE on_hand <> 0 OR avg_cost <> 0');
  assert.strictEqual(Number(shelf[0].n), 0, 'the shelf is empty, like a new outlet\'s');
  const kept = await sql(DBNAME, 'SELECT on_hand::text h FROM outlet_' + KEPT
    + ".ingredient WHERE id = 'i1'");
  assert.strictEqual(Number(kept[0].h), 12.5, 'and the sister store\'s is not');

  const series = await sql(DBNAME, 'SELECT kind, next_no::int n, used FROM chain.doc_series'
    + ' WHERE outlet_id = $1', [GONE]);
  series.forEach((s) => {
    assert.strictEqual(s.n, 1, s.kind + ' did not start again');
    assert.strictEqual(s.used, false);
  });
});

/* ONE OUTLET'S RESET IS ONE OUTLET'S. The business boundary is a database and
   the store boundary is a schema; a reset that reached across the second would
   take a sister store's takings with it and nothing on either screen would
   say so. */
test('the sister store never noticed', opts, async () => {
  const s = await sql(DBNAME, 'SELECT (SELECT count(*)::int FROM outlet_' + KEPT
    + '.sale) sales, (SELECT count(*)::int FROM outlet_' + KEPT
    + '.journal_line) jl, (SELECT count(*)::int FROM outlet_' + KEPT
    + '.payment) pay');
  assert.strictEqual(s[0].sales, 4, 'its bills are still there');
  assert.ok(s[0].jl > 0 && s[0].pay > 0, 'and so is its ledger');
  const doc = await sql(DBNAME, 'SELECT count(*)::int n FROM chain.doc_series'
    + ' WHERE outlet_id = $1 AND next_no > 1', [KEPT]);
  assert.ok(Number(doc[0].n) > 0, 'and its document numbering was not rewound');
});

/* POINTS AND CREDIT ARE CHAIN-WIDE, so zeroing them is conditional rather than
   tidy: the sales that built the balance at THIS store are gone, but a sister
   store is still trading against the same figure. Where the reset cannot
   honestly clear it, it SAYS so rather than leaving the discrepancy to be
   discovered. */
test('a member balance a sister store still trades against is kept, and named',
  opts, async () => {
    assert.strictEqual(out.loyaltyKept, true,
      'this business has two outlets, so the balance is not this reset\'s to clear');
    assert.strictEqual(out.membersCleared, 0);
    const m = await sql(DBNAME, 'SELECT points, credit_used::text c FROM chain.member');
    assert.strictEqual(Number(m[0].points), 420, 'the points a guest earned are still theirs');
    assert.strictEqual(Number(m[0].c), 60, 'and what they owe is still owed');
  });

/* KEEP A RECORD OF THE DATA AND DELETE DATA — the second half is only honest
   if the first half survives, and chain.audit is the one table this build
   never prunes. */
test('what was deleted is on the trail, counted while it still existed',
  opts, async () => {
    const rec = await sql(DBNAME, "SELECT actor, rank, before, after, outlet_id"
      + " FROM chain.audit WHERE action = 'store_trade_reset' ORDER BY at DESC LIMIT 1");
    assert.strictEqual(rec.length, 1, 'the act is on the trail');
    assert.strictEqual(Number(rec[0].outlet_id), GONE, 'filed under the store it cleared');
    assert.ok(rec[0].actor, 'and who did it');
    assert.strictEqual(Number(rec[0].rank), 5, 'at the rank that may');
    assert.strictEqual(rec[0].after.why, 'the training fortnight is over', 'and why');

    const b = rec[0].before;
    assert.strictEqual(Number(b.bills), 4, 'what was taken, over how many bills');
    assert.ok(Number(b.gross) > 0, 'and what it came to: ' + b.gross);
    assert.ok(b.from && b.to, 'between which business dates');
    assert.ok(b.rows && b.rows.sale === 4,
      'and every table\'s own count, taken before the rows went: '
      + JSON.stringify(b.rows));
    assert.ok(Object.keys(b.rows).length > 3,
      'not just the sales — everything that held rows');
  });

/* A RESET IS AN UPSERT'S OPPOSITE AND STILL HAS TO BE SAFE TO REPEAT. An owner
   who presses it twice, or whose connection dropped on the first press, must
   get a second no-op rather than an error — and a record saying nothing was
   there, which is the honest answer. */
test('clearing a cleared store is a no-op that still says so', opts, async () => {
  const again = await RST.resetTrade(ctx, { why: 'again' });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.rows, 0, 'there was nothing left to clear');
  assert.strictEqual(again.bills, 0);
  const n = await sql(DBNAME, "SELECT count(*)::int n FROM chain.audit"
    + " WHERE action = 'store_trade_reset'");
  assert.strictEqual(Number(n[0].n), 2, 'and the second press is on the trail too');
});

/* THE PROTECTION IS THE ABSENT GRANT. The reset runs on the owner connection
   for one reason and it is worth an assertion of its own: an outlet's own
   login role holds no DELETE and no TRUNCATE on its trade tables, so a
   compromised terminal cannot destroy a store's sales. Granting either to make
   the handler convenient would spend that property on every outlet on the
   estate to serve one act an owner performs once. */
test('a till cannot empty its own sales, which is why the reset is not a till write',
  opts, async () => {
    const grants = await sql(DBNAME,
      "SELECT privilege_type p FROM information_schema.role_table_grants"
      + " WHERE grantee = $1 AND table_schema = $2 AND table_name = 'sale'",
      ['outlet_' + GONE + '_app', 'outlet_' + GONE]);
    const held = grants.map((g) => g.p).sort();
    assert.ok(held.indexOf('SELECT') >= 0 && held.indexOf('INSERT') >= 0
      && held.indexOf('UPDATE') >= 0, 'the till reads and writes its own sales: ' + held);
    assert.strictEqual(held.indexOf('DELETE'), -1,
      'and it must never be able to delete one — a void is an UPDATE');
    assert.strictEqual(held.indexOf('TRUNCATE'), -1,
      'nor empty the table. If this ever passes, src/reset.js could run under'
      + ' the outlet role — and every terminal on the estate could wipe its'
      + ' own store\'s takings. The privilege is the point, not the handler.');
  });

test.after(async () => {
  if (dbmod) await dbmod.shutdown().catch(() => {});
});
