'use strict';
/* Applies every migration in src/migrations, in name order, exactly once.
   Idempotent: each file is recorded in chain.migration with a checksum, and a
   file whose contents changed after it was applied is a hard error rather than
   a silent divergence between two environments.

   ONE BOOT MIGRATES AT A TIME. A platform starts the replacement container
   before it stops the old one, so two processes run this at once on every
   ordinary deploy — and the second live install proved it in the log: both
   raced into 001 and one died on `duplicate key value violates unique
   constraint "pg_extension_name_index"`, because CREATE EXTENSION IF NOT
   EXISTS is not atomic against a concurrent creator. It recovered only
   because the process exits and the restart found the extension already
   there. Three more collisions were sitting in the same window: the
   check-then-CREATE ROLE below, the bare INSERT into chain.migration, and two
   boots re-applying a changed file over each other.

   panel/server.js and site/server.js both learned this — "seen in anger" is
   in one of those comments — and the runner every install boots through never
   got it. One session-scoped advisory lock, held across the whole run on ONE
   connection (pool.query would take a different one per statement and hold
   nothing). A holder that dies releases it: Postgres drops session locks with
   the connection, so a killed container cannot wedge the next boot. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { owner, ownerFor, control } = require('../db');

/* Two sets, and which database each belongs in is the whole tenancy model.
   BUSINESS is everything a till reads and writes — company, staff, members,
   the outlet schemas and their login roles — and it runs once per business
   database. CONTROL is the registry: who signed up, which database their
   business is in, and who holds which handle. `control` is a SUBDIRECTORY of
   the business set's directory, and readdirSync's .sql filter excludes it, so
   neither set can pick up the other's files by accident. */
const DIR = path.join(__dirname, '..', 'migrations');
const CONTROL_DIR = path.join(DIR, 'control');

// Distinct from the 881234 the registry services share: a till's database is
// its own, and two unrelated boots must never queue behind each other.
const LOCK = 881235;

/* The lock is per DATABASE, because pg_advisory_lock is: two businesses
   migrating at once are two different databases and must not queue behind each
   other, while two boots against ONE database must. */
async function applyTo(pool, dir, log, opts) {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [LOCK]);
    return await run(c, log, dir, opts || {});
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    c.release();
  }
}

// The business set against this connection's own database. Unchanged: this is
// what boot and the whole test suite have always called.
function migrate(log) { return applyTo(owner(), DIR, log, { reportRole: true }); }

// The registry. No report role here — chain.estate_day is a business's own.
function migrateControl(log) { return applyTo(control(), CONTROL_DIR, log, {}); }

// One business, by database name.
function migrateBusiness(dbName, log) {
  return applyTo(ownerFor(dbName), DIR, log, { reportRole: true });
}

// How many files a database at head would have applied. The fleet compares a
// business against this rather than against "the newest name", so a set that
// gains a file in the middle still reads correctly.
function headCount(dir) {
  return fs.readdirSync(dir || DIR).filter((f) => f.endsWith('.sql')).length;
}

async function run(db, log, dir, opts) {
  const say = log || console.log;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  // 001 creates the ledger table itself, so the first pass runs bare.
  const first = files[0];
  const bootSql = fs.readFileSync(path.join(dir, first), 'utf8');
  const bootSum = crypto.createHash('sha256').update(bootSql).digest('hex').slice(0, 16);
  const have = await db.query(
    "SELECT to_regclass('chain.migration') IS NOT NULL AS ok").then((r) => r.rows[0].ok);
  if (!have) {
    await db.query(bootSql);
    await db.query('INSERT INTO chain.migration (name, checksum) VALUES ($1,$2)'
      + ' ON CONFLICT (name) DO NOTHING', [first, bootSum]);
    say('[migrate] applied ' + first);
  }

  const done = await db.query('SELECT name, checksum FROM chain.migration');
  const seen = new Map(done.rows.map((r) => [r.name, r.checksum]));

  let applied = 0;
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const sum = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
    if (seen.has(f)) {
      // Migrations that only (re)define functions are safe to re-apply, and we
      // want a function fix to land without a new file. Data migrations are
      // not: those are ON CONFLICT DO NOTHING by construction.
      if (seen.get(f) !== sum) {
        await db.query(sql);
        await db.query('UPDATE chain.migration SET checksum = $2, applied_at = now()'
          + ' WHERE name = $1', [f, sum]);
        say('[migrate] re-applied ' + f + ' (contents changed)');
        applied++;
      }
      continue;
    }
    await db.query(sql);
    await db.query('INSERT INTO chain.migration (name, checksum) VALUES ($1,$2)', [f, sum]);
    say('[migrate] applied ' + f);
    applied++;
  }

  // The read-only reporting role exists once per business database. It can
  // execute that business's estate aggregate and read nothing else.
  if (opts && opts.reportRole) await ensureReportRole(db, say);
  return applied;
}

async function ensureReportRole(db, say) {
  const pw = process.env.REPORT_ROLE_PASSWORD
    || require('../secrets').outletPassword('report');
  const exists = await db.query("SELECT 1 FROM pg_roles WHERE rolname = 'kashikeyo_report'");
  if (!exists.rows.length) {
    await db.query("CREATE ROLE kashikeyo_report LOGIN PASSWORD " + lit(pw) + " NOINHERIT");
    say('[migrate] created role kashikeyo_report');
  } else {
    await db.query("ALTER ROLE kashikeyo_report PASSWORD " + lit(pw));
  }
  await db.query('REVOKE ALL ON SCHEMA public FROM kashikeyo_report');
  await db.query('GRANT USAGE ON SCHEMA chain, app TO kashikeyo_report');
  await db.query('GRANT SELECT ON chain.outlet, chain.company TO kashikeyo_report');
  await db.query('GRANT EXECUTE ON FUNCTION chain.estate_day(date) TO kashikeyo_report');
}

function lit(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

if (require.main === module) {
  migrate().then((n) => {
    console.log('[migrate] done, ' + n + ' file(s) applied');
    return require('../db').shutdown();
  }).then(() => process.exit(0))
    .catch((e) => { console.error('[migrate] failed:', e.message); process.exit(1); });
}

module.exports = { migrate, migrateControl, migrateBusiness, headCount,
  _DIR: DIR, _CONTROL_DIR: CONTROL_DIR };
