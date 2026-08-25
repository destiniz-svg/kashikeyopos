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
