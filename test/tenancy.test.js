'use strict';
/* ═══ ONE DATABASE PER BUSINESS ══════════════════════════════════════════════
   The product used to be sold one INSTALL per customer — a whole Railway
   project each. Everything painful about onboarding came from that, and two
   live provisioning runs failed on races that only exist because a project is
   built per customer.

   Now: one app, one cluster, a database per business, and a registry that says
   which is which. This file is the gate. It proves the boundary holds where it
   has to — between two customers — and that the belt inside a business is the
   one that was already there.
   ═══════════════════════════════════════════════════════════════════════════ */
const { test } = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const DB = require('./db');

DB.secrets();

/* Its own registry database. Sharing one with test/api.test.js left business
   rows pointing at databases the other suite had already dropped — which is a
   real state (it is what a restore-into-a-fresh-cluster looks like) and is
   asserted deliberately below, not stumbled into across files. */
const CONTROL = process.env.PGTESTCONTROL2 || 'kashikeyo_control_tenancy';
const opts = DB.configured() ? {}
  : { skip: 'no Postgres configured (set PGHOST or DATABASE_URL)' };

let db, BIZ, business, other;

function admin(database) {
  return new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: database
  });
}

test('the registry is a database of its own, and it is named', opts, async () => {
  await DB.dropBusinessDatabases();
  await DB.freshDatabase(process.env.PGTESTDB3 || 'kashikeyo_tenancy_test');
  await DB.dropOutletRoles();
  // Cleared by freshDatabase; the registry lives somewhere else on purpose.
  const a = admin(process.env.PGADMINDB || 'postgres');
  await a.connect();
  await a.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity'
    + ' WHERE datname = $1 AND pid <> pg_backend_pid()', [CONTROL]).catch(() => {});
  await a.query('DROP DATABASE IF EXISTS "' + CONTROL + '"');
  await a.query('CREATE DATABASE "' + CONTROL + '"');
  await a.end();

  db = require('../src/db');
  /* Guessing the registry would silently make a business database its own —
     the tables would create, the accounts would land in the wrong place, and
     nothing would say so until two customers had signed up. */
  assert.throws(() => db.control(), /CONTROL_DB is not set/,
    'the registry is named, never inferred from the current connection');

  process.env.CONTROL_DB = CONTROL;
  const { migrateControl } = require('../src/scripts/migrate');
  await migrateControl(() => {});
  const at = await db.control().query('SELECT count(*)::int AS n FROM chain.migration');
  assert.ok(at.rows[0].n >= 2, 'the registry migrated from nothing');

  const q = await db.control().query(
    "SELECT count(*)::int AS n FROM chain.reserved_handle");
  assert.ok(q.rows[0].n > 100, 'and it carries the reserved names');
});

test('signing up makes a database, migrated to head', opts, async () => {
  BIZ = require('../src/business');
  const { headCount } = require('../src/scripts/migrate');
  business = await BIZ.createBusiness({ name: 'Seaside Cafe' });

  assert.strictEqual(business.status, 'live');
  assert.strictEqual(business.build_state, null, 'nothing half-built left behind');
  assert.strictEqual(business.db_name, db.businessDb(business.id));
  assert.strictEqual(business.schema_version, headCount(),
    'every business migration applied, counted rather than guessed');

  const a = admin(process.env.PGADMINDB || 'postgres');
  await a.connect();
  const got = await a.query('SELECT 1 FROM pg_database WHERE datname = $1',
    [business.db_name]);
  await a.end();
  assert.strictEqual(got.rows.length, 1, 'the database is really there');

  // The schema a till reads is the one this repo has always had.
  const biz = db.ownerFor(business.db_name);
  const t = await biz.query("SELECT to_regclass('chain.company') IS NOT NULL AS a,"
    + " to_regclass('chain.member') IS NOT NULL AS b,"
    + " to_regclass('chain.staff') IS NOT NULL AS c");
  assert.deepStrictEqual([t.rows[0].a, t.rows[0].b, t.rows[0].c], [true, true, true]);
});

test('the account plane is in the registry, not in a business', opts, async () => {
  const inControl = await db.control().query(
    "SELECT to_regclass('chain.account') IS NOT NULL AS ok");
  assert.strictEqual(inControl.rows[0].ok, true, 'accounts are global');

  /* One account may own several businesses, so sign-in cannot live in a
     business database — it would have to search every database in the cluster
     to answer whether an address is known. */
  const inBiz = await db.ownerFor(business.db_name).query(
    "SELECT to_regclass('chain.account') IS NOT NULL AS ok");
  assert.strictEqual(inBiz.rows[0].ok, false,
    'and a business database holds no copy of them');
});

test('outlet ids are allocated globally, so a token names one store', opts, async () => {
  other = await BIZ.createBusiness({ name: 'Reef Grill' });
  assert.notStrictEqual(other.id, business.id);

  const a = await BIZ.nextOutletId(business.id);
  const b = await BIZ.nextOutletId(other.id);
  assert.notStrictEqual(a, b,
    'provision.js used max(id)+1 per install, so every install had an outlet 1');

  const r = await BIZ.routeFor(a);
  assert.strictEqual(r.db, business.db_name, 'and the registry routes it home');
  const r2 = await BIZ.routeFor(b);
  assert.strictEqual(r2.db, other.db_name);
  assert.strictEqual(await BIZ.routeFor(999999), null, 'an unknown outlet routes nowhere');
});

test('a handle is one name across every business', opts, async () => {
  const a = await BIZ.nextOutletId(business.id);
  const b = await BIZ.nextOutletId(other.id);
  await db.control().query('SELECT chain.claim_handle($1,$2,$3)',
    [a, business.id, 'seaside']);

  await assert.rejects(
    () => db.control().query('SELECT chain.claim_handle($1,$2,$3)',
      [b, other.id, 'seaside']),
    /already another store/,
    'two customers cannot both print the same address on their table cards');

  await assert.rejects(
    () => db.control().query('SELECT chain.claim_handle($1,$2,$3)',
      [b, other.id, 'admin']),
    /reserved/, 'and a reserved name is refused by name');

  // Renaming retires the old address rather than freeing it.
  await db.control().query('SELECT chain.rename_handle($1,$2)', [a, 'seaside-cafe']);
  const points = await db.control().query(
    'SELECT * FROM chain.handle_points_at($1)', ['seaside']);
  assert.strictEqual(Number(points.rows[0].outlet_id), a);
  assert.strictEqual(points.rows[0].current, false, 'the old card still lands');
  await assert.rejects(
    () => db.control().query('SELECT chain.claim_handle($1,$2,$3)',
      [b, other.id, 'seaside']),
    /still points at it/, 'and a competitor cannot take it');
});

test('one business cannot reach another, and the outlet belt is unchanged',
  opts, async () => {
    /* THE GATE. Everything above is plumbing; this is the property the whole
       change is answerable for. leak-test proves the belt between OUTLETS
       inside a business — this proves the wall between customers. */
    const { outletPassword } = require('../src/secrets');
    const bizA = db.ownerFor(business.db_name);
    const id = await BIZ.nextOutletId(business.id);
    await bizA.query('SELECT chain.provision_outlet($1,$2,$3,$4)',
      [id, 'KO' + id, 'A Store', outletPassword(id)]);

    const role = 'outlet_' + id + '_app';
    const at = (database) => new Client({
      host: process.env.PGHOST || '127.0.0.1',
      port: Number(process.env.PGPORT || 5432),
      user: role, password: outletPassword(id), database: database
    });

    // Its own business, with the context every real request opens with. RLS
    // reads app.outlet_id, so without it the role correctly sees nothing —
    // which is belt two doing its job, not a failure.
    const mine = at(business.db_name);
    try {
      await mine.connect();
      await mine.query('BEGIN');
      await mine.query("SELECT set_config('app.outlet_id',$1,true),"
        + " set_config('app.user_rank','5',true), set_config('app.scope','outlet',true)",
      [String(id)]);
      const own = await mine.query('SELECT count(*)::int AS n FROM chain.outlet');
      assert.strictEqual(own.rows[0].n, 1, 'it reads its own outlet and no other');
      await mine.query('COMMIT');
    } finally { await mine.end().catch(() => {}); }

    // The same role, pointed at ANOTHER customer's database.
    const crossing = at(other.db_name);
    let crossed = null;
    try {
      await crossing.connect();
      await crossing.query('SELECT count(*) FROM chain.member');
      crossed = 'it read another business\'s members';
    } catch (e) {
      assert.match(e.message, /permission denied|does not exist|not permitted|authentication/i,
        'refused, and the reason names a privilege: ' + e.message);
    } finally { await crossing.end().catch(() => {}); }
    assert.strictEqual(crossed, null, crossed || 'refused');

    // And it cannot reach the registry either — that is where accounts live.
    const atControl = at(CONTROL);
    let reached = null;
    try {
      await atControl.connect();
      await atControl.query('SELECT email FROM chain.account');
      reached = 'an outlet role read the account plane';
    } catch (e) {
      assert.match(e.message, /permission denied|does not exist|not permitted|authentication/i,
        'refused: ' + e.message);
    } finally { await atControl.end().catch(() => {}); }
    assert.strictEqual(reached, null, reached || 'refused');
  });

test('an owner whose business cannot be read is told so, not sent to onboarding',
  opts, async () => {
    /* A registry row can outlive its database — a restore into a fresh
       cluster, a half-finished build, a database dropped by hand. The account
       session used to answer that by returning no outlets at all, which the
       browser renders as "you have not set up a store yet" and whose first
       action is to create one. Telling an owner they own nothing is the worst
       available answer, and it is the one an empty list gives. */
    const acct = await db.control().query(
      "INSERT INTO chain.account (email, verified_at) VALUES ($1, now()) RETURNING id",
      ['ghost-' + Date.now() + '@example.mv']);
    const id = acct.rows[0].id;
    const ghost = await db.control().query(
      "INSERT INTO chain.business (name, db_name, status, live_at)"
      + " VALUES ('Gone Away','kashikeyo_biz_999999','live',now()) RETURNING id");
    await db.control().query(
      "INSERT INTO chain.account_business (account_id, business_id, role)"
      + " VALUES ($1,$2,'owner')", [id, ghost.rows[0].id]);

    const out = await require('../src/routes/account.js').accountSession(id);
    assert.deepStrictEqual(out.outlets, [], 'there is nothing to show');
    assert.strictEqual(out.next, 'unavailable',
      'and "unavailable" is not "onboarding" — the wizard would create a second one');
    assert.strictEqual(out.unreachable.length, 1, 'the business is named');
    assert.match(out.unreachable[0].why, /could not be reached/);

    const trail = await db.control().query(
      "SELECT count(*)::int AS n FROM chain.audit WHERE action = 'account_business_unreadable'");
    assert.ok(trail.rows[0].n >= 1, 'and it reached the trail rather than a .catch');
  });

test('the cluster is left clean', opts, async () => {
  await db.shutdown();
  const n = await DB.dropBusinessDatabases();
  assert.ok(n >= 2, 'both business databases existed and were swept');
});
