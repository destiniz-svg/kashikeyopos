'use strict';
// Proves isolation rather than asserting it. Connects AS one outlet's own role
// and tries, every way, to see another's. Every attempt must fail.
//
//   npm run leak-test -- 3 4
//
// WHY THIS WAS REWRITTEN. The first version reported "no leaks" while testing
// almost nothing, in three separate ways:
//
//   1. All ten probes shared ONE transaction. The first probe raises
//      "permission denied for schema outlet_4", which aborts the transaction,
//      so every later probe came back "current transaction is aborted" — and
//      the catch block counted that as a PASS. Nine of ten probes never ran.
//   2. A probe returning 0 rows counted as a PASS even when the other outlet
//      held nothing to leak. Against an empty database every RLS probe passes
//      whether or not RLS works at all. A test that cannot fail is not a test.
//   3. Two probes ended in `AND false` / `count(*) >= 0`, so their result was
//      fixed before the database was consulted.
//
// So this version: one transaction per probe, real data planted in the other
// outlet first, and the run ABORTS if there is nothing there to steal.

const { Client } = require('pg');
const { outletPassword } = require('../src/secrets');

const ssl = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;

/* SQLSTATEs that mean the thing the probe aimed at is not there: undefined
   table, schema, function, column. See the catch block below for why they are
   a broken suite rather than a pass. */
const MISSING = new Set(['42P01', '3F000', '42883', '42703']);

function outletClient(id) {
  return new Client({
    host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE, user: 'outlet_' + id + '_app',
    password: outletPassword(id), ssl,
  });
}

function ownerClient() {
  return new Client({ connectionString: process.env.DATABASE_URL, ssl });
}

/* Plant something in the victim outlet worth stealing, as the owner. Without
   this the whole suite is vacuous: "0 rows" proves isolation only when there
   were rows to return. Idempotent, and it stays behind — a leak test that
   cleans up after itself cannot be re-read when it fails. */
async function seedVictim(owner, victim) {
  const s = 'outlet_' + victim;
  await owner.query('BEGIN');
  await owner.query(
    "SELECT set_config('app.outlet_id',$1,true), set_config('app.user_rank','5',true),"
    + " set_config('app.actor',NULL,true), set_config('app.scope','outlet',true)", [String(victim)]);
  await owner.query(
    'INSERT INTO ' + s + ' .ticket (id, table_no, split, status, covers, opened_at)'
      .replace(' .', '.')
    + " VALUES ('11111111-1111-1111-1111-111111111111','LEAK',0,'held',2, now())"
    + ' ON CONFLICT (id) DO NOTHING');
  await owner.query(
    'INSERT INTO ' + s + ".sale (id, receipt_no, business_date, channel, covers, gross,"
    + ' discount, service, tax_code, tax_rate, tax, rounding, total, closed_by)'
    + " VALUES ('22222222-2222-2222-2222-222222222222','LEAK-SECRET-0001',current_date,"
    + "'dine_in',2, 1000, 0, 100, 'GGST', 8, 88, 0, 1188,"
    + " '33333333-3333-3333-3333-333333333333') ON CONFLICT (id) DO NOTHING");
  await owner.query(
    'INSERT INTO chain.staff (id, name, rank, outlet_id, pin_hash, pin_salt)'
    + " VALUES ('44444444-4444-4444-4444-444444444444','Leak Probe Victim',3,$1,'x','y')"
    + ' ON CONFLICT (id) DO NOTHING', [victim]);
  await owner.query(
    'INSERT INTO chain.audit (outlet_id, action, entity, entity_id, scope)'
    + " VALUES ($1,'leak_probe_seed','sale','LEAK-SECRET-0001','outlet')", [victim]);
  await owner.query('COMMIT');
}

/* Confirm the bait is actually there, read as the owner. If a schema change
   ever makes seedVictim a no-op, the suite must stop rather than pass. */
async function assertBait(owner, victim) {
  const s = 'outlet_' + victim;
  const checks = [
    ['sale', 'SELECT count(*)::int AS n FROM ' + s + '.sale', []],
    ['ticket', 'SELECT count(*)::int AS n FROM ' + s + '.ticket', []],
    ['staff', 'SELECT count(*)::int AS n FROM chain.staff WHERE outlet_id = $1', [victim]],
    ['doc_series', 'SELECT count(*)::int AS n FROM chain.doc_series WHERE outlet_id = $1', [victim]],
    ['audit', 'SELECT count(*)::int AS n FROM chain.audit WHERE outlet_id = $1', [victim]],
  ];
  for (const [what, sql, params] of checks) {
    const q = await owner.query(sql, params);
    if (!q.rows[0].n) {
      throw new Error('nothing to steal in outlet ' + victim + '.' + what
        + ' — the probes would pass vacuously, so refusing to report a result');
    }
  }
}

(async function () {
  const [mine, theirs] = process.argv.slice(2).map(Number);
  if (!mine || !theirs || mine === theirs) {
    console.error('usage: leak-test <myOutlet> <otherOutlet>');
    process.exit(2);
  }

  const owner = ownerClient();
  await owner.connect();
  await seedVictim(owner, theirs);
  await assertBait(owner, theirs);

  const c = outletClient(mine);
  await c.connect();
  let leaks = 0, ran = 0;

  /* One transaction PER PROBE. A failed probe aborts only its own, so the next
     one starts clean and is actually executed — the bug that made this suite
     report nine phantom passes. */
  async function probe(label, sql, params, opts) {
    ran++;
    const claimOutlet = (opts && opts.claimOutlet) || mine;
    const scope = (opts && opts.scope) || 'outlet';
    try {
      await c.query('BEGIN');
      await c.query(
        "SELECT set_config('app.outlet_id',$1,true), set_config('app.user_rank','5',true),"
        + " set_config('app.actor',NULL,true), set_config('app.scope',$2,true)",
        [String(claimOutlet), scope]);
      const q = await c.query(sql, params || []);
      const rows = q.rows || [];
      if (!rows.length) { console.log('PASS  ' + label + ' → 0 rows (filtered)'); }
      else {
        console.log('LEAK  ' + label + ' → ' + rows.length + ' row(s): '
          + JSON.stringify(rows[0]).slice(0, 120));
        leaks++;
      }
    } catch (e) {
      const msg = e.message.split('\n')[0];
      /* An aborted-transaction message means the probe never reached the
         database. That is the exact false pass this rewrite exists to kill, so
         it counts as a failure of the SUITE, not a pass for the probe. */
      if (/current transaction is aborted/i.test(msg)) {
        console.log('BROKEN ' + label + ' → probe did not run (' + msg + ')');
        leaks++;
      } else if (MISSING.has(e.code)) {
        /* "relation outlet_4.ticket does not exist" is not isolation working —
           it is the object not being there, which is how the suite reported
           "no leaks" against a database where the outlets had never been
           provisioned. A role that lacks USAGE is told "permission denied",
           never "does not exist", so this can only mean the probe had nothing
           to prove. Same family of false pass as the aborted transaction. */
        console.log('BROKEN ' + label + ' → nothing there to protect (' + msg + ')');
        leaks++;
      } else {
        console.log('PASS  ' + label + ' → ' + msg);
      }
    } finally {
      await c.query('ROLLBACK').catch(function () {});
    }
  }

  const S = 'outlet_' + theirs;

  // ── belt one: the schema is not reachable at all ────────────────────────
  await probe("read another outlet's sales directly",
    'SELECT receipt_no, total FROM ' + S + '.sale LIMIT 5');
  await probe("read another outlet's tickets",
    'SELECT id, table_no FROM ' + S + '.ticket LIMIT 5');
  await probe("read another outlet's ledger",
    'SELECT jv_no FROM ' + S + '.journal LIMIT 5');
  await probe("read another outlet's stock",
    'SELECT id, on_hand FROM ' + S + '.ingredient LIMIT 5');
  await probe("read another outlet's payments",
    'SELECT method, amount FROM ' + S + '.payment LIMIT 5');
  await probe('list another outlet\'s tables and find one it may read',
    "SELECT tablename FROM pg_tables WHERE schemaname = $1"
    + " AND has_table_privilege(current_user, schemaname||'.'||tablename, 'SELECT')", [S]);
  await probe('escalate by creating an object in another schema',
    'CREATE TABLE ' + S + '.leak_probe (x int)');
  await probe('reach the owner connection\'s tables',
    'SELECT rolname FROM pg_authid LIMIT 5');

  // ── belt two: RLS on the shared control plane ───────────────────────────
  await probe("see another outlet's staff through RLS",
    'SELECT id, name, rank FROM chain.staff WHERE outlet_id = $1', [theirs]);
  await probe("see another outlet's document series",
    'SELECT kind, prefix, next_no FROM chain.doc_series WHERE outlet_id = $1', [theirs]);
  await probe("see another outlet's audit trail",
    'SELECT action, entity_id FROM chain.audit WHERE outlet_id = $1', [theirs]);
  await probe("see another outlet's registration in the outlet registry",
    'SELECT id, code, name, db_role FROM chain.outlet WHERE id = $1', [theirs]);
  await probe("see another outlet's devices",
    'SELECT id, label FROM chain.device WHERE outlet_id = $1', [theirs]);
  await probe("see another outlet's sessions",
    'SELECT id, staff_id FROM chain.session WHERE outlet_id = $1', [theirs]);

  // ── forging the request context ─────────────────────────────────────────
  // These are the ones the old suite faked with `AND false`. Each now really
  // sets the context it is not entitled to and really reads.
  /* `id <> mine`, not a bare SELECT: reading your OWN outlet row back is the
     correct answer, and a probe that counted it as a leak would cry wolf on
     every run until someone stopped reading the output. What must return
     nothing is any row belonging to somebody else. */
  await probe('forge group scope, then read the estate registry',
    'SELECT id, code, name, db_role FROM chain.outlet WHERE id <> $1', [mine],
    { scope: 'group' });
  await probe('forge group scope, then read every outlet\'s staff',
    'SELECT id, name, outlet_id FROM chain.staff'
    + ' WHERE outlet_id IS DISTINCT FROM $1', [mine], { scope: 'group' });
  await probe('claim to BE the other outlet, then read its staff',
    'SELECT id, name FROM chain.staff WHERE outlet_id = $1', [theirs],
    { claimOutlet: theirs });
  await probe('claim to BE the other outlet, then read its sales',
    'SELECT receipt_no FROM ' + S + '.sale LIMIT 5', [], { claimOutlet: theirs });
  await probe('claim to BE the other outlet, then read its audit trail',
    'SELECT action FROM chain.audit WHERE outlet_id = $1', [theirs],
    { claimOutlet: theirs });
  await probe('call the estate aggregate without group scope',
    'SELECT * FROM chain.estate_day(current_date)');
  await probe('call the estate aggregate WITH forged group scope',
    'SELECT * FROM chain.estate_day(current_date)', [], { scope: 'group' });

  // ── the audit trail is append-only ──────────────────────────────────────
  await probe('rewrite the audit trail',
    "UPDATE chain.audit SET action = 'tampered' WHERE outlet_id = $1 RETURNING id", [mine]);
  await probe('delete from the audit trail',
    'DELETE FROM chain.audit WHERE outlet_id = $1 RETURNING id', [mine]);
  await probe('erase a closed sale in my OWN outlet',
    'DELETE FROM outlet_' + mine + '.sale RETURNING id');

  await c.end();
  await owner.end();
  console.log('\n' + ran + ' probes run');
  console.log(leaks ? leaks + ' LEAK(S) — do not ship' : 'no leaks');
  process.exit(leaks ? 1 : 0);
})().catch(function (e) { console.error(e.message); process.exit(1); });
