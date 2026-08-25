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
/* `dir` exists because the fleet has to be testable without writing a file
   into the directory every other suite is reading at the same time. It
   defaults to the real set and nothing in the application passes it. */
function migrateBusiness(dbName, log, opts) {
  const o = Object.assign({ reportRole: true }, opts || {});
  return applyTo(ownerFor(dbName), o.dir || DIR, log, o);
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
  if (opts && opts.reportRole) await ensureReportRole(db, say, opts);
  return applied;
}

/* A ROLE IS CLUSTER-WIDE AND AN ADVISORY LOCK IS NOT. pg_advisory_lock is
   scoped to a database, which is right for serialising two boots against one
   business and no help at all when the fleet migrates four businesses at once:
   check-then-CREATE ROLE then races across four different databases on the
   same cluster, and so does ALTER ROLE, which fails with "tuple concurrently
   updated". It is the CREATE EXTENSION defect from one level down, reappearing
   the moment there was more than one database to migrate.

   So the fleet does this ONCE, before any worker starts, and the workers do
   only the per-database grants. Removing the race beats tolerating it. The
   create is still forgiving, because a concurrent creator got the outcome we
   wanted anyway. */
/* Did a peer already do exactly this? Three shapes of the same answer: the
   role existed by the time we created it, or somebody was mid-ALTER on the
   same catalog row. "tuple concurrently updated" has no dedicated SQLSTATE, so
   it is matched by message as well as code — narrowly, and only around
   statements that are idempotent by construction. */
function peerDidIt(e) {
  if (!e) return false;
  if (e.code === '42710' || e.code === '23505' || e.code === '40001') return true;
  return /tuple concurrently updated/i.test(String(e.message || ''));
}

async function ensureReportRoleExists(db, say) {
  const pw = process.env.REPORT_ROLE_PASSWORD
    || require('../secrets').outletPassword('report');
  const exists = await db.query("SELECT 1 FROM pg_roles WHERE rolname = 'kashikeyo_report'");
  if (!exists.rows.length) {
    try {
      await db.query("CREATE ROLE kashikeyo_report LOGIN PASSWORD " + lit(pw) + " NOINHERIT");
      (say || console.log)('[migrate] created role kashikeyo_report');
      return;
    } catch (e) {
      if (!peerDidIt(e)) throw e;
    }
  }
  /* And the ALTER collides too, between PROCESSES rather than between fleet
     workers: two app containers booting against one cluster both reach here.
     Postgres answers the loser "tuple concurrently updated". The statement is
     idempotent — the password is derived, so both are writing the same value —
     so a peer having just done it is the outcome we wanted, not an error. */
  try {
    await db.query("ALTER ROLE kashikeyo_report PASSWORD " + lit(pw));
  } catch (e) {
    if (!peerDidIt(e)) throw e;
  }
}

async function ensureReportRole(db, say, opts) {
  const pw = process.env.REPORT_ROLE_PASSWORD
    || require('../secrets').outletPassword('report');
  /* A ROLE IS CLUSTER-WIDE AND THE ADVISORY LOCK IS NOT. pg_advisory_lock is
     scoped to a database, which is exactly right for serialising two boots
     against one business — and no help at all when the fleet migrates four
     businesses at once, because check-then-CREATE ROLE then races across four
     different databases on the same cluster. It is the CREATE EXTENSION defect
     from one level down, reappearing the moment there was more than one
     database to migrate.

     So the create is attempted and a loser is treated as a winner: 42710 is
     "somebody else created it a millisecond ago", which is the outcome we
     wanted. The ALTER and the GRANTs below are idempotent and run either way. */
  if (!opts || !opts.roleAlreadyDone) await ensureReportRoleExists(db, say);
  await db.query('REVOKE ALL ON SCHEMA public FROM kashikeyo_report');
  await db.query('GRANT USAGE ON SCHEMA chain, app TO kashikeyo_report');
  await db.query('GRANT SELECT ON chain.outlet, chain.company TO kashikeyo_report');
  await db.query('GRANT EXECUTE ON FUNCTION chain.estate_day(date) TO kashikeyo_report');
}

function lit(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

/* ── the fleet ──────────────────────────────────────────────────────────────
   "Per outlet and also all at once" is the whole point of a database per
   business: one customer can be moved on its own, and everybody can be moved
   together. Both go through here so there is one definition of what "at head"
   means.

   Bounded concurrency, because a fleet migration opens a connection per
   business and a hundred at once is a thundering herd against the same
   Postgres the shops are trading on. Four is slow enough to be polite and fast
   enough that a deploy is not measured in minutes.

   A business that FAILS does not stop the others. Its row keeps its old
   schema_version and carries the reason, and the request path refuses it —
   which is the honest outcome: one customer down and named beats a deploy that
   stopped halfway with nobody knowing which half. */
const FLEET_CONCURRENCY = Number(process.env.MIGRATE_CONCURRENCY || 4);

async function listBusinesses(only) {
  const { control } = require('../db');
  const q = await control().query(
    'SELECT id, name, db_name, status, schema_version FROM chain.business'
    + (only ? ' WHERE id = $1' : " WHERE status IN ('live','building')")
    + ' ORDER BY id', only ? [Number(only)] : []);
  return q.rows;
}

async function fleet(opts) {
  const o = opts || {};
  const say = o.log || console.log;
  const { control } = require('../db');
  const head = headCount(o.dir);
  const rows = await listBusinesses(o.business);

  if (o.business && !rows.length) {
    throw Object.assign(new Error('no business ' + o.business + ' in the registry'),
      { status: 404 });
  }

  if (o.dryRun) {
    rows.forEach((b) => say('[migrate] ' + b.db_name + '  at ' + b.schema_version
      + ' of ' + head + (b.schema_version >= head ? '' : '  BEHIND')));
    return { head: head, checked: rows.length, moved: 0, failed: [] };
  }

  // Once, before any worker: see ensureReportRoleExists.
  await ensureReportRoleExists(control(), say);

  const queue = rows.slice();
  const failed = [];
  let moved = 0;

  async function worker() {
    for (;;) {
      const b = queue.shift();
      if (!b) return;
      try {
        const n = await migrateBusiness(b.db_name, () => {},
          { roleAlreadyDone: true, dir: o.dir });
        const at = await require('../db').ownerFor(b.db_name)
          .query('SELECT count(*)::int AS n FROM chain.migration');
        await control().query(
          'UPDATE chain.business SET schema_version = $2 WHERE id = $1',
          [b.id, Number(at.rows[0].n)]);
        if (n) { moved++; say('[migrate] ' + b.db_name + ' +' + n); }
      } catch (e) {
        failed.push({ id: b.id, db: b.db_name, why: e.message });
        await control().query(
          'UPDATE chain.business SET build_state = $2 WHERE id = $1',
          [b.id, 'migration failed: ' + e.message]).catch(() => {});
        console.error('[migrate] ' + b.db_name + ' FAILED: ' + e.message);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(FLEET_CONCURRENCY, queue.length || 1) },
    worker));
  return { head: head, checked: rows.length, moved: moved, failed: failed };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf('--' + name);
    return i < 0 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
  };
  const only = arg('business');
  const dryRun = !!arg('dry-run');

  (async () => {
    /* The registry first, always: it is where the fleet is listed, so a run
       that migrated businesses before it could be reading yesterday's list. */
    await migrateControl();
    const out = await fleet({ business: only === true ? null : only, dryRun: dryRun });
    console.log('[migrate] ' + out.checked + ' business database(s) at head '
      + out.head + ', ' + out.moved + ' moved, ' + out.failed.length + ' failed');
    await require('../db').shutdown();
    process.exit(out.failed.length ? 1 : 0);
  })().catch((e) => {
    console.error('[migrate] failed:', e.message);
    process.exit(1);
  });
}

module.exports = { migrate, migrateControl, migrateBusiness, headCount, fleet,
  _DIR: DIR, _CONTROL_DIR: CONTROL_DIR };
