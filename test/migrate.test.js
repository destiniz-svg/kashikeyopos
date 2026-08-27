'use strict';
/* ═══ TWO BOOTS, ONE DATABASE ═══════════════════════════════════════════════
   A platform starts the replacement container before it stops the old one, so
   two processes run the migration at boot on every ordinary deploy. The second
   live install proved it in its own log: both raced into 001 and one died on

     duplicate key value violates unique constraint "pg_extension_name_index"

   because CREATE EXTENSION IF NOT EXISTS is not atomic against a concurrent
   creator. It recovered only because the process exits and the restart found
   the extension already there — luck, not design, and production exits on a
   migration failure.

   This runs the real runner twice at once against a genuinely cold database.
   Without the advisory lock it fails the way the install did.
   ═══════════════════════════════════════════════════════════════════════ */
const { test } = require('node:test');
const assert = require('node:assert');
const DB = require('./db');

DB.secrets();

const opts = DB.configured() ? {}
  : { skip: 'no Postgres configured (set PGHOST or DATABASE_URL)' };

test('two boots migrating one cold database do not collide', opts, async () => {
  await DB.freshDatabase(process.env.PGTESTDB2 || 'kashikeyo_migrate_test');
  await DB.dropOutletRoles();
  const db = require('../src/db');
  const { migrate } = require('../src/scripts/migrate');

  // Started together, on two connections, so they are two sessions — which is
  // what makes the advisory lock the thing under test rather than a formality.
  const [a, b] = await Promise.all([migrate(() => {}), migrate(() => {})]);

  // One of them did the work; the other found it done. Which one is a race and
  // is not the assertion — that neither threw, and that exactly one applied
  // the files, is.
  assert.ok(a >= 5 || b >= 5, 'one boot applied every migration');
  assert.ok(Math.min(a, b) === 0, 'and the other applied nothing, having waited');

  // The schema is whole, not half-built by two writers.
  const files = require('fs').readdirSync(require('path')
    .join(__dirname, '..', 'src', 'migrations')).filter((f) => f.endsWith('.sql'));
  const n = await db.owner().query('SELECT count(*)::int AS n FROM chain.migration');
  assert.strictEqual(n.rows[0].n, files.length, 'every migration recorded exactly once');

  const ext = await db.owner().query(
    "SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pgcrypto'");
  assert.strictEqual(ext.rows[0].n, 1, 'and the extension neither doubled nor blew up');

  await db.shutdown();
});

/* ═══ A ROLE IS CLUSTER-WIDE, AND AN ADVISORY LOCK IS NOT ═══════════════════
   `chain.provision_outlet()` creates and alters a LOGIN ROLE. A role lives in
   pg_authid, which every database on the cluster shares — so two callers
   provisioning from two different business databases touch the same catalog
   rows, and Postgres answers the loser

     tuple concurrently updated

   Measured on this suite before the fix: two runs in five, always in
   `reprovision()` — which is the RESTORE path, so it fired in the one piece of
   code somebody runs after losing a database.

   `pg_advisory_xact_lock` alone does not close it: the lock is scoped to the
   database the session is connected to, so two callers take the same key in
   two different databases and do not conflict at all. THE SCOPE IS THE FIX,
   and this asserts it — the lock is taken in the maintenance database, which
   every caller on the cluster can reach and none of them owns.

   Not the registry, which was the first answer and is wrong for the same
   reason: `dbPrefix()` exists because a cluster may host more than one estate,
   and two estates have two registries.

   Deliberately does not create databases of its own. An earlier version did,
   and creating and dropping databases beside five suites that are mid-run
   disturbed them — trading one intermittent failure for another is not a fix,
   and the thing under test is the lock's SCOPE and its EXCLUSION, both of
   which are answerable without touching the cluster. */
test('the role lock is cluster-wide, and it excludes', opts, async () => {
  const db = require('../src/db');

  // ── the scope. Taken where every caller can agree, whatever database each
  //    of them happens to be connected to.
  const maint = process.env.PG_MAINT_DB || 'postgres';
  const where = await db.withRoleLock(async () => {
    const c = await db.owner().connect();
    try {
      const r = await c.query("SELECT count(*)::int AS n FROM pg_stat_activity"
        + " WHERE application_name = 'kashikeyo-role-lock' AND datname = $1", [maint]);
      return r.rows[0].n;
    } finally { c.release(); }
  });
  assert.ok(where >= 1, 'the lock is held in ' + maint + ', not in this database');

  // ── the exclusion. Two holders, started together; the second cannot be
  //    inside while the first is, or it is not a mutex.
  const log = [];
  const hold = (tag) => db.withRoleLock(async () => {
    log.push('in:' + tag);
    await new Promise((r) => setTimeout(r, 120));
    log.push('out:' + tag);
  });
  await Promise.all([hold('a'), hold('b')]);
  assert.strictEqual(log.length, 4);
  assert.strictEqual(log[1], 'out:' + log[0].slice(3),
    'the first holder left before the second entered: ' + log.join(' '));

  // ── and a peer that got there first is not an error. A rolling deploy runs
  //    an older container that holds no lock at all, so the DDL is retried
  //    rather than refused; both statements are idempotent by construction.
  let tries = 0;
  const out = await db.withRoleLock(async () => {
    if (++tries < 3) {
      throw Object.assign(new Error('tuple concurrently updated'), { code: 'XX000' });
    }
    return 'done';
  }, { retry: true });
  assert.strictEqual(out, 'done');
  assert.strictEqual(tries, 3, 'a peer collision is retried, not thrown back');

  // But a real fault still is one.
  await assert.rejects(() => db.withRoleLock(async () => {
    throw Object.assign(new Error('relation "nope" does not exist'), { code: '42P01' });
  }, { retry: true }), /does not exist/, 'and anything else is reported, not swallowed');

  /* AND A CALLER INSIDE A TRANSACTION IS NEVER RETRIED. provisionOutlet opens
     one so the schema, the role and the directory row land together; the first
     failure aborts it, so a retry can only answer "current transaction is
     aborted" — which is how one recoverable collision became five dead tests
     before this was made opt-in. */
  let once = 0;
  await assert.rejects(() => db.withRoleLock(async () => {
    once++;
    throw Object.assign(new Error('tuple concurrently updated'), { code: 'XX000' });
  }), /tuple concurrently updated/, 'no retry unless the caller asked for one');
  assert.strictEqual(once, 1, 'and it was tried exactly once: ' + once);

  await db.shutdown();
});
