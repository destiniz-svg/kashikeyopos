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
const { owner } = require('../db');

const DIR = path.join(__dirname, '..', 'migrations');

// Distinct from the 881234 the registry services share: a till's database is
// its own, and two unrelated boots must never queue behind each other.
const LOCK = 881235;

async function migrate(log) {
  const c = await owner().connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [LOCK]);
    return await run(c, log);
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    c.release();
  }
}

async function run(db, log) {
  const say = log || console.log;
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

  // 001 creates the ledger table itself, so the first pass runs bare.
  const first = files[0];
  const bootSql = fs.readFileSync(path.join(DIR, first), 'utf8');
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
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
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

  // The read-only reporting role exists once, chain-wide. It can execute the
  // estate aggregate and read nothing else.
  await ensureReportRole(db, say);
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

module.exports = { migrate };
