'use strict';
/* ═══ ONE BUSINESS, OR ALL OF THEM ═══════════════════════════════════════════
   A database per business only pays for itself if a schema change can reach
   one customer or every customer, deliberately, and if a customer the change
   did NOT reach is refused rather than served.

   That last half is the one worth a test. One app now serves many databases,
   so a deploy that moved the code but not every schema leaves somebody's till
   talking to a database without the columns the code just started using —
   which is wrong answers about money, silently. Refusing is a shop down for
   the length of a migration; serving is a shop trading on a lie.
   ═══════════════════════════════════════════════════════════════════════════ */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const DB = require('./db');

DB.secrets();
/* Its own database-name prefix. Suites share a cluster and each registry
   allocates business ids from 1, so without this they all reach for
   kashikeyo_biz_1 and clobber each other. */
process.env.BUSINESS_DB_PREFIX = 'kf_biz_';
const opts = DB.configured() ? {}
  : { skip: 'no Postgres configured (set PGHOST or DATABASE_URL)' };

const CONTROL = process.env.PGTESTCONTROL3 || 'kashikeyo_control_fleet';

/* A COPY of the migration set, not the real one. The first version of this
   file wrote its probe straight into src/migrations — which every other suite
   reads, concurrently, so it changed what "head" meant underneath them and
   failed two unrelated tests. A temp directory is the honest way to add a file
   to a set nobody else is looking at. */
const SET = fs.mkdtempSync(path.join(require('os').tmpdir(), 'kfleet-'));
const REAL = path.join(__dirname, '..', 'src', 'migrations');
fs.readdirSync(REAL).filter((f) => f.endsWith('.sql'))
  .forEach((f) => fs.copyFileSync(path.join(REAL, f), path.join(SET, f)));
const EXTRA = path.join(SET, '999_fleet_probe.sql');

let db, M, BIZ, a, b;

test('two businesses, both at head', opts, async () => {
  await DB.dropBusinessDatabases();
  await DB.freshDatabase(process.env.PGTESTDB4 || 'kashikeyo_fleet_test');
  await DB.freshControl(CONTROL);
  await DB.dropOutletRoles();
  db = require('../src/db');
  M = require('../src/scripts/migrate');
  BIZ = require('../src/business');

  await M.migrateControl(() => {});
  a = await BIZ.createBusiness({ name: 'One' });
  b = await BIZ.createBusiness({ name: 'Two' });

  const out = await M.fleet({ dryRun: true, log: () => {} });
  assert.strictEqual(out.head, M.headCount());
  assert.strictEqual(out.checked, 2, 'both businesses are in the fleet');
  assert.strictEqual(a.schema_version, out.head);
  assert.strictEqual(b.schema_version, out.head);
});

test('a new migration moves one business, then the rest', opts, async () => {
  /* A real file, because the runner reads the directory — a stub would test
     the stub. Removed in the last test whatever happens. */
  fs.writeFileSync(EXTRA, '-- a probe, removed by the test that wrote it\n'
    + 'CREATE TABLE IF NOT EXISTS chain.fleet_probe (id int PRIMARY KEY);\n');

  const head = M.headCount(SET);
  assert.strictEqual(head, a.schema_version + 1, 'head moved by exactly one file');

  // One customer, by id.
  const one = await M.fleet({ business: a.id, dir: SET, log: () => {} });
  assert.strictEqual(one.checked, 1);
  assert.strictEqual(one.moved, 1);
  assert.deepStrictEqual(one.failed, []);

  const at = async (biz) => Number((await db.control().query(
    'SELECT schema_version FROM chain.business WHERE id = $1', [biz.id]))
    .rows[0].schema_version);
  assert.strictEqual(await at(a), head, 'the one named moved');
  assert.strictEqual(await at(b), head - 1, 'and only the one named');

  // Then everybody.
  const all = await M.fleet({ dir: SET, log: () => {} });
  assert.deepStrictEqual(all.failed, [], 'nothing failed on the way');
  assert.strictEqual(all.moved, 1, 'the one already at head did no work');
  assert.strictEqual(await at(b), head, 'and the other caught up');

  const probe = await db.ownerFor(b.db_name).query(
    "SELECT to_regclass('chain.fleet_probe') IS NOT NULL AS ok");
  assert.strictEqual(probe.rows[0].ok, true, 'the file really ran');
});

test('a business behind head is refused, and told why', opts, async () => {
  /* Put one business behind the REAL head — the set the running app compares
     against. The temp set above is one file ahead of it, so "minus one" would
     have landed exactly ON the real head and refused nothing. */
  await db.control().query(
    'UPDATE chain.business SET schema_version = $2 WHERE id = $1',
    [b.id, M.headCount() - 1]);
  BIZ.forgetRoute();

  const outlet = await BIZ.nextOutletId(b.id);
  await assert.rejects(() => BIZ.requireAtHead(outlet), (e) => {
    assert.strictEqual(e.status, 503, 'unavailable, not a 500 and not a 200');
    assert.ok(e.retryable, 'and the caller is told it is worth going again');
    assert.match(e.message, /being updated/);
    assert.match(e.message, /of \d+/, 'the message carries how far behind it is');
    return true;
  });

  // The other customer is untouched: one shop down is not every shop down.
  const mine = await BIZ.nextOutletId(a.id);
  const ok = await BIZ.requireAtHead(mine);
  assert.strictEqual(ok.db, a.db_name);

  await db.control().query(
    'UPDATE chain.business SET schema_version = $2 WHERE id = $1',
    [b.id, M.headCount(SET)]);
  BIZ.forgetRoute();
});

test('a business that cannot be migrated does not stop the others', opts, async () => {
  const gone = await db.control().query(
    "INSERT INTO chain.business (name, db_name, status, schema_version)"
    + " VALUES ('Vanished','kashikeyo_biz_404','live',0) RETURNING id");
  fs.writeFileSync(EXTRA, fs.readFileSync(EXTRA, 'utf8')
    + 'CREATE TABLE IF NOT EXISTS chain.fleet_probe2 (id int PRIMARY KEY);\n');

  const out = await M.fleet({ dir: SET, log: () => {} });
  assert.strictEqual(out.failed.length, 1, 'the missing one failed');
  assert.strictEqual(out.failed[0].db, 'kashikeyo_biz_404');
  assert.strictEqual(out.moved, 2, 'and both real businesses still moved');

  /* Named on its own row, so the dashboard can say which customer is behind —
     a deploy that stopped halfway with nobody knowing which half is the
     failure mode this replaces. */
  const row = await db.control().query(
    'SELECT build_state FROM chain.business WHERE id = $1', [gone.rows[0].id]);
  assert.match(row.rows[0].build_state, /migration failed/);
});

test('the probe is removed and the cluster left clean', opts, async () => {
  fs.rmSync(SET, { recursive: true, force: true });
  assert.ok(!fs.existsSync(EXTRA), 'the suite does not leave a migration behind');
  assert.ok(!fs.existsSync(path.join(REAL, '999_fleet_probe.sql')),
    'and never wrote one into the real set, which other suites read');
  await db.shutdown();
  await DB.dropBusinessDatabases();
});
