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
const fs = require('fs');
const path = require('path');

DB.secrets();
/* Its own database-name prefix. Suites share a cluster and each registry
   allocates business ids from 1, so without this they all reach for
   kashikeyo_biz_1 and clobber each other. */
process.env.BUSINESS_DB_PREFIX = 'kt_biz_';

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

/* AND THE REGISTRY CANNOT BE REGISTERED AS ONE OF ITS OWN CUSTOMERS.

   `control()` has always refused to GUESS which database is the registry.
   Nothing refused to WRITE the registry's own name into `chain.business`, and
   `businessForDb()` registers whatever name it is handed — so an ordinary
   path (a single-database install claiming itself, a provision resolving the
   process's own database) could file the registry as customer N. The fleet
   then migrates it with the BUSINESS set, whose migration 011 is a tombstone
   that DROPS `chain.account` and `chain.account_identity`: every account on
   the install gone, the record of who owns each business with them.

   Found in exactly that state on this project's own local registry — business
   149, `db_name = kashikeyo_local_control`, at 4 of 49, `chain.company` and
   `chain.staff` sitting in the registry, the account tables missing, and
   `/api/account/signup` answering "server error" to every new customer. It is
   refused by name at both doors now, so nobody has to notice it later. */
test('the registry cannot be filed as a business, at either door', opts, async () => {
  const reg = db.CONTROL_DB();
  assert.ok(reg, 'the suite runs against a named registry');

  await assert.rejects(() => BIZ.businessForDb(reg), (e) => {
    assert.match(String(e.message), /registry/i, 'the refusal names what it is');
    assert.match(String(e.message), /chain\.account/,
      'and what would be lost, so the reason survives the stack trace');
    return true;
  }, 'businessForDb registers any name it is handed — except this one');

  const rows = await db.control().query(
    'SELECT count(*)::int AS n FROM chain.business WHERE db_name = $1', [reg]);
  assert.strictEqual(rows.rows[0].n, 0,
    'and nothing was written on the way to refusing');

  // The other door is a CLI, so it is held to the same refusal statically —
  // a dry run that prints this plan is a plan somebody then runs with --apply.
  const cli = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'scripts', 'adopt-install.js'), 'utf8');
  assert.ok(/dbName === CONTROL_DB\(\)/.test(cli),
    'adopt refuses the registry too');
  assert.ok(cli.indexOf('dbName === CONTROL_DB()') < cli.indexOf('=== DRY RUN'),
    'and refuses BEFORE it describes the plan');
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

    /* The same role, pointed at ANOTHER customer's database.

       REFUSED AT THE DOOR, not merely at the table. Postgres grants CONNECT on
       every database to PUBLIC, so until migration 039 this connection OPENED
       and only the reads were denied. Nothing leaked — every schema said
       "permission denied" — but the session existed, and inside it the
       world-readable catalogs gave up the schema names and object counts of
       somebody else's install. This build's stated guarantee is refusal at the
       database, so that is what is asserted. */
    const crossing = at(other.db_name);
    let crossed = null;
    let opened = false;
    try {
      await crossing.connect();
      opened = true;
      await crossing.query('SELECT count(*) FROM chain.member');
      crossed = 'it read another business\'s members';
    } catch (e) {
      assert.match(e.message, /permission denied|does not exist|not permitted|authentication/i,
        'refused, and the reason names a privilege: ' + e.message);
    } finally { await crossing.end().catch(() => {}); }
    assert.strictEqual(crossed, null, crossed || 'refused');
    assert.strictEqual(opened, false,
      'and the session never opened at all — a role that cannot connect cannot'
      + ' read the catalogs either, which is the half that was reachable');

    // And it cannot reach the registry either — that is where accounts live,
    // and control/003 shuts that door the same way.
    const atControl = at(CONTROL);
    let reached = null;
    let openedControl = false;
    try {
      await atControl.connect();
      openedControl = true;
      await atControl.query('SELECT email FROM chain.account');
      reached = 'an outlet role read the account plane';
    } catch (e) {
      assert.match(e.message, /permission denied|does not exist|not permitted|authentication/i,
        'refused: ' + e.message);
    } finally { await atControl.end().catch(() => {}); }
    assert.strictEqual(reached, null, reached || 'refused');
    assert.strictEqual(openedControl, false,
      'and the registry refuses the session itself — no outlet role has ever'
      + ' had a reason to open one there');
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

test('a verified account creates its own business, and an unverified one cannot',
  opts, async () => {
    /* Self-serve, end to end at the seam that matters: the only thing between
       the internet and CREATE DATABASE. */
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/account', require('../src/routes/account.js'));
    app.use((e, rq, rs, nx) => rs.status(e.status || 500).json({ error: e.message })); // eslint-disable-line
    const srv = app.listen(0);
    const base = 'http://127.0.0.1:' + srv.address().port;
    const post = (p, body, tok) => fetch(base + p, { method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' },
        tok ? { authorization: 'Bearer ' + tok } : {}),
      body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() }));

    try {
      const email = 'self-' + Date.now() + '@example.mv';
      process.env.ACCOUNT_CODE_ECHO = '1';
      const up = await post('/api/account/signup', { email: email, password: 'a-long-password' });
      assert.strictEqual(up.status, 200, JSON.stringify(up.body));

      // Unverified: refused, and told what to do rather than given a 500.
      const acct = await db.control().query(
        'SELECT id FROM chain.account WHERE lower(email) = lower($1)', [email]);
      const signedIn = await post('/api/account/signin',
        { email: email, password: 'a-long-password' });
      assert.strictEqual(signedIn.status, 200, JSON.stringify(signedIn.body));
      const token = signedIn.body.token;

      const tooSoon = await post('/api/account/business', { name: 'Too Soon' }, token);
      assert.strictEqual(tooSoon.status, 403,
        'an unverified address must not mint infrastructure');
      assert.match(tooSoon.body.error, /confirm your email/);

      // Verify the way a customer does, then create.
      await db.control().query(
        'UPDATE chain.account SET verified_at = now() WHERE id = $1', [acct.rows[0].id]);
      const made = await post('/api/account/business', { name: 'Self Serve Cafe' }, token);
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      assert.strictEqual(made.body.next, 'onboarding');

      const row = await db.control().query(
        'SELECT * FROM chain.business WHERE id = $1', [made.body.businessId]);
      assert.strictEqual(row.rows[0].status, 'live');
      assert.strictEqual(row.rows[0].db_name, db.businessDb(made.body.businessId));

      // Owned, and the trail says who and when.
      const owns = await db.control().query(
        "SELECT role FROM chain.account_business WHERE account_id = $1 AND business_id = $2",
        [acct.rows[0].id, made.body.businessId]);
      assert.strictEqual(owns.rows[0].role, 'owner');
      const trail = await db.control().query(
        "SELECT count(*)::int AS n FROM chain.audit WHERE action = 'business_created'");
      assert.ok(trail.rows[0].n >= 1);

      // No outlet is invented — onboarding asks for its name, zone and currency.
      const outlets = await db.control().query(
        'SELECT count(*)::int AS n FROM chain.outlet_directory WHERE business_id = $1',
        [made.body.businessId]);
      assert.strictEqual(outlets.rows[0].n, 0, 'nothing is guessed on their behalf');

      // A ceiling, because a verified address is still one address.
      process.env.MAX_BUSINESSES_PER_ACCOUNT = '1';
      const second = await post('/api/account/business', { name: 'One Too Many' }, token);
      assert.strictEqual(second.status, 429);
      assert.match(second.body.error, /already has 1 businesses/);
      delete process.env.MAX_BUSINESSES_PER_ACCOUNT;
    } finally {
      delete process.env.ACCOUNT_CODE_ECHO;
      if (srv.closeAllConnections) srv.closeAllConnections();
      await new Promise((res) => srv.close(res));
    }
  });

test('onboarding refuses an account with no business, rather than using the shared one',
  opts, async () => {
    /* THE ONE THAT SHIPPED. /account sent a verified account straight to
       /onboarding, nothing had created a business, and the route fell back to
       the connection's own database — so the first customer to sign up would
       have written their company, outlets and staff into the database every
       business shares. The tenancy boundary failing open at the front door,
       on the very first screen a customer sees.

       Falling back is right where there is no registry and wrong the moment
       there is one, so it fails closed and says what to do. */
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/onboarding', require('../src/routes/onboarding.js'));
    app.use((e, rq, rs, nx) => rs.status(e.status || 500).json({ error: e.message })); // eslint-disable-line
    const srv = app.listen(0);
    const base = 'http://127.0.0.1:' + srv.address().port;
    try {
      const acct = await db.control().query(
        "INSERT INTO chain.account (email, verified_at) VALUES ($1, now()) RETURNING id",
        ['nobiz-' + Date.now() + '@example.mv']);
      const token = require('../src/secrets').signAccount(
        { a: acct.rows[0].id, exp: Date.now() + 60000 });

      const r = await fetch(base + '/api/onboarding/company', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-account-token': token },
        body: JSON.stringify({ legalName: 'Nowhere Ltd', regNo: 'C-1/2026',
          address: 'Somewhere', gstRegistered: 'no' })
      }).then(async (x) => ({ status: x.status, body: await x.json() }));

      assert.strictEqual(r.status, 409, JSON.stringify(r.body));
      assert.match(r.body.error, /no business yet/);

      /* And nothing reached the database it would have fallen back to. In
         this suite that database was never even migrated, so the absence of
         the table is a stronger answer than an empty one — either way, no
         company was written where every business would have shared it.
         Checked in two steps, because Postgres resolves the relation when it
         plans the query, guard or no guard. */
      const has = await db.owner().query(
        "SELECT to_regclass('chain.company') IS NOT NULL AS ok");
      if (has.rows[0].ok) {
        const stray = await db.owner().query(
          "SELECT count(*)::int AS n FROM chain.company WHERE legal_name = 'Nowhere Ltd'");
        assert.strictEqual(stray.rows[0].n, 0, 'the shared database is untouched');
      }
    } finally {
      // Node's fetch keeps the socket alive, so close() alone never resolves
      // and the runner waits out its whole timeout.
      if (srv.closeAllConnections) srv.closeAllConnections();
      await new Promise((res) => srv.close(res));
    }
  });

/* ── A RESET IS ONE CUSTOMER'S, AND IT IS NAMED ──────────────────────────────
   `npm run reset:database` predated one-database-per-business: it reset
   whatever DATABASE_URL pointed at, with no way to name a customer. On a
   registry install the process's own database is one NOBODY TRADES IN, so the
   default was the dangerous one — it would drop the registry's `chain` schema,
   where every account and the whole business directory live, while leaving the
   store the operator meant to clear untouched.

   AND IT REACHED ACROSS THE WHOLE CLUSTER. The role loop was
   `pg_roles ~ '^outlet_[0-9]+_app$'`, which is every outlet role belonging to
   every customer, and `DROP OWNED BY` revokes privileges on SHARED objects —
   databases — from whichever database it runs in. Found by running it: one
   scratch business reset, and `/readyz` answered "10 of 10 outlet(s) cannot be
   reached with their own login role", with
   `has_database_privilege('outlet_39_app', <another business>, 'CONNECT')`
   false on businesses the reset had never been aimed at. Every till on the
   estate, off the air, from a reset of somebody else's store. Migration 039
   settled the right rule for the same question: derive the roles from the
   `outlet_%` SCHEMAS actually present — here, of the database being reset. */
test('a reset names its customer, and never reaches another', opts, async () => {
  const RESET = require('../src/scripts/reset-database');
  const prev = process.env.RESET_DATABASE;
  process.env.RESET_DATABASE = 'yes-i-mean-it';
  const quiet = () => {};
  const said = (e) => String((e && e.message) || e);
  try {
    // With a registry and no --business, it refuses rather than falling back to
    // the database this process dialled.
    await assert.rejects(() => RESET.run(quiet, {}), (e) => {
      assert.match(said(e), /--business/, 'and names the remedy: ' + said(e));
      return true;
    });
    const acct = await db.control().query(
      "SELECT to_regclass('chain.account') IS NOT NULL AS ok");
    assert.strictEqual(acct.rows[0].ok, true, 'nothing was dropped on the way to refusing');

    // A row naming the REGISTRY is refused by name — the destructive twin of
    // refuseRegistry() above.
    const bogus = await db.control().query(
      "INSERT INTO chain.business (name, db_name, status) VALUES ($1,$2,'live')"
      + ' RETURNING id', ['Bogus', db.CONTROL_DB()]);
    await assert.rejects(() => RESET.run(quiet, { business: bogus.rows[0].id }),
      (e) => { assert.match(said(e), /REGISTRY/i); return true; });
    await db.control().query('DELETE FROM chain.business WHERE id = $1', [bogus.rows[0].id]);

    await assert.rejects(() => RESET.run(quiet, { business: 999999 }),
      (e) => { assert.match(said(e), /no business 999999/); return true; });

    /* And the real thing, on two businesses this test makes itself — the ones
       above are mutated by earlier tests, and a destructive check must own
       what it destroys. `keep` is the bystander: its outlet role has to open
       its own database after `wipe` has been reset. */
    const keep = await BIZ.createBusiness({ name: 'Bystander Cafe' });
    const wipe = await BIZ.createBusiness({ name: 'Reset Me' });
    const oid = await BIZ.nextOutletId(keep.id);
    // The database rides in opts.db — provisionOutlet takes ONE argument.
    await require('../src/provision').provisionOutlet(
      { id: oid, name: 'Bystander', code: 'BYS', db: keep.db_name });
    const can = () => db.owner().query("SELECT has_database_privilege($1,$2,'CONNECT') AS ok",
      ['outlet_' + oid + '_app', keep.db_name]).then((r) => r.rows[0].ok);
    assert.strictEqual(await can(), true, 'the bystander can reach its database before');

    const out = await RESET.run(quiet, { business: wipe.id });
    assert.strictEqual(out.database, wipe.db_name, 'the reset lands on the named customer');
    const left = await db.ownerFor(wipe.db_name).query(
      "SELECT count(*)::int AS n FROM pg_namespace WHERE nspname IN ('chain','app')");
    assert.strictEqual(left.rows[0].n, 0, 'that store is gone');

    assert.strictEqual(await can(), true,
      "AND THE BYSTANDER STILL CAN — one customer's reset never touches another's roles");
    const acct2 = await db.control().query(
      "SELECT to_regclass('chain.account') IS NOT NULL AS ok");
    assert.strictEqual(acct2.rows[0].ok, true, 'and the registry keeps every account');
  } finally {
    if (prev === undefined) delete process.env.RESET_DATABASE;
    else process.env.RESET_DATABASE = prev;
  }
});

test('the cluster is left clean', opts, async () => {
  await db.shutdown();
  const n = await DB.dropBusinessDatabases();
  assert.ok(n >= 2, 'both business databases existed and were swept');
});

/* A ROUTE IS NOT REASSIGNABLE BY AN ORDINARY PROVISIONING CALL.

   chain.outlet_directory is the routing table for tenancy: it says which
   database a session token's outlet opens. registerOutlet() upserted with
   `DO UPDATE SET business_id = excluded.business_id`, so provisioning an
   outlet with an id already registered to another business RE-POINTED it, and
   every request for that outlet went to the other customer's database from
   the next cache refresh on.

   Found by running leak-test — which provisions outlets 1 and 2 into whatever
   database it is aimed at — against a registry shared with two real
   businesses. It moved outlet 1 across without a word. The isolation belts
   held, because the other database has no such staff, so nothing leaked; what
   failed was the ROUTE, and a boundary that an ordinary call can move is not
   one. adopt-install.js already refused this and remapped instead; the live
   path now agrees with it. */
test('an outlet id cannot be re-pointed at another business', opts, async () => {
  const BIZ = require('../src/business');
  const a = await BIZ.createBusiness({ name: 'Route A' });
  const b = await BIZ.createBusiness({ name: 'Route B' });

  const id = await BIZ.nextOutletId(a.id);
  assert.ok(id > 0);

  // Re-registering to the SAME business is idempotent: a caller supplying an
  // id still needs a route home whether or not one already exists.
  await BIZ.registerOutlet(id, a.id);
  await BIZ.registerOutlet(id, a.id);
  const still = await db.control().query(
    'SELECT business_id FROM chain.outlet_directory WHERE outlet_id = $1', [id]);
  assert.strictEqual(Number(still.rows[0].business_id), Number(a.id));

  await assert.rejects(() => BIZ.registerOutlet(id, b.id),
    /already registered to business/,
    'and another business is refused BY NAME rather than taking the route');

  const after = await db.control().query(
    'SELECT business_id FROM chain.outlet_directory WHERE outlet_id = $1', [id]);
  assert.strictEqual(Number(after.rows[0].business_id), Number(a.id),
    'the route did not move');
});
