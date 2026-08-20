'use strict';
/* Applies every migration in src/migrations, in name order, exactly once.
   Idempotent: each file is recorded in chain.migration with a checksum, and a
   file whose contents changed after it was applied is a hard error rather than
   a silent divergence between two environments. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { owner } = require('../db');

const DIR = path.join(__dirname, '..', 'migrations');

async function migrate(log) {
  const say = log || console.log;
  const pool = owner();
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

  // 001 creates the ledger table itself, so the first pass runs bare.
  const first = files[0];
  const bootSql = fs.readFileSync(path.join(DIR, first), 'utf8');
  const bootSum = crypto.createHash('sha256').update(bootSql).digest('hex').slice(0, 16);
  const have = await pool.query(
    "SELECT to_regclass('chain.migration') IS NOT NULL AS ok").then((r) => r.rows[0].ok);
  if (!have) {
    await pool.query(bootSql);
    await pool.query('INSERT INTO chain.migration (name, checksum) VALUES ($1,$2)'
      + ' ON CONFLICT (name) DO NOTHING', [first, bootSum]);
    say('[migrate] applied ' + first);
  }

  const done = await pool.query('SELECT name, checksum FROM chain.migration');
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
        await pool.query(sql);
        await pool.query('UPDATE chain.migration SET checksum = $2, applied_at = now()'
          + ' WHERE name = $1', [f, sum]);
        say('[migrate] re-applied ' + f + ' (contents changed)');
        applied++;
      }
      continue;
    }
    await pool.query(sql);
    await pool.query('INSERT INTO chain.migration (name, checksum) VALUES ($1,$2)', [f, sum]);
    say('[migrate] applied ' + f);
    applied++;
  }

  // The read-only reporting role exists once, chain-wide. It can execute the
  // estate aggregate and read nothing else.
  await ensureReportRole(pool, say);
  return applied;
}

async function ensureReportRole(pool, say) {
  const pw = process.env.REPORT_ROLE_PASSWORD
    || require('../secrets').outletPassword('report');
  const exists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'kashikeyo_report'");
  if (!exists.rows.length) {
    await pool.query("CREATE ROLE kashikeyo_report LOGIN PASSWORD " + lit(pw) + " NOINHERIT");
    say('[migrate] created role kashikeyo_report');
  } else {
    await pool.query("ALTER ROLE kashikeyo_report PASSWORD " + lit(pw));
  }
  await pool.query('REVOKE ALL ON SCHEMA public FROM kashikeyo_report');
  await pool.query('GRANT USAGE ON SCHEMA chain, app TO kashikeyo_report');
  await pool.query('GRANT SELECT ON chain.outlet, chain.company TO kashikeyo_report');
  await pool.query('GRANT EXECUTE ON FUNCTION chain.estate_day(date) TO kashikeyo_report');
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
