'use strict';
/* ═══ REBUILD THIS ENVIRONMENT'S DATABASE FROM NOTHING ══════════════════════
   The documented reset in DEPLOYMENT.md, as a script, so it can be run by a
   platform that gives you a DATABASE_URL but no shell.

   It drops every outlet's data plane, the control plane, and the per-outlet
   login roles. The next boot migrates from nothing and the app lands on
   /onboarding. THERE IS NO UNDO. Restore from a backup or it is gone.

   Three guards, because this is the most dangerous file in the repository:

     1. RESET_DATABASE must be set to exactly "yes-i-mean-it". A flag that can
        be set by accident is not a guard.
     2. It REFUSES to run when RAILWAY_ENVIRONMENT_NAME is "production".
        Railway injects that itself, so it cannot be forgotten or spoofed by a
        copied variable set.
     3. It names the database, the host and every schema it is about to drop
        BEFORE dropping anything, so the log says what was destroyed.

   Run it as a one-shot (a pre-deploy command, or `npm run reset:database`),
   never as part of the start path.

   WHICH DATABASE — and this predated one-database-per-business, which made the
   default the dangerous one. It reset whatever DATABASE_URL points at, with no
   way to name a customer. On a registry install the process's own database is
   one NOBODY TRADES IN: resetting it drops the registry's `chain` schema, which
   is where every account, every business row and the whole handle registry
   live. The store the operator meant to clear would not be touched, and the
   install would lose the record of who owns what.

   So: `--business <id>` resolves the customer's own database through the
   registry and resets that. With a registry configured and no `--business`,
   the run is REFUSED BY NAME rather than falling back to the process's own
   database — the same doctrine `control()` keeps about never guessing which
   database is the registry, and `refuseRegistry()` about never filing it as a
   customer. Without a registry there is one database and it is the business's,
   which is the single-install case this was written for.
   ═══════════════════════════════════════════════════════════════════════ */

const { owner, ownerFor, control, CONTROL_DB, shutdown } = require('../db');

const CONFIRM = 'yes-i-mean-it';

/* Where the reset is aimed. Returns a pool and the name it belongs to, or
   throws with the remedy. */
async function target(businessId, log) {
  const reg = CONTROL_DB();
  if (!reg) {
    if (businessId) {
      throw new Error('refusing: --business needs a registry — CONTROL_DB is not set');
    }
    return { pool: owner(), named: null };
  }
  if (!businessId) {
    throw new Error('refusing: this install has a registry (' + reg + '), so the'
      + ' database this process dialled is not any business\'s. Name the customer:'
      + ' npm run reset:database -- --business <id>   (npm run migrate -- --dry-run'
      + ' lists them)');
  }
  const q = await control().query(
    'SELECT id, name, db_name FROM chain.business WHERE id = $1', [Number(businessId)]);
  if (!q.rows.length) throw new Error('refusing: no business ' + businessId + ' in the registry');
  const b = q.rows[0];
  /* The registry is not one of its own customers, and a row that says otherwise
     is the defect refuseRegistry() exists to stop. Refused here too, because
     this is the one script that would act on it destructively. */
  if (String(b.db_name) === String(reg)) {
    throw new Error('refusing: business ' + b.id + ' names the REGISTRY (' + reg
      + '). Resetting it would drop every account on this install.');
  }
  log('[reset] business : ' + b.id + ' "' + b.name + '"');
  return { pool: ownerFor(b.db_name), named: b.db_name };
}

async function run(say, opts) {
  const log = say || console.log;                       // eslint-disable-line no-console
  const businessId = (opts && opts.business) || null;

  if (process.env.RESET_DATABASE !== CONFIRM) {
    throw new Error('refusing: set RESET_DATABASE="' + CONFIRM + '" to confirm');
  }
  const env = (process.env.RAILWAY_ENVIRONMENT_NAME || '').toLowerCase();
  if (env === 'production') {
    throw new Error('refusing: RAILWAY_ENVIRONMENT_NAME is "production"');
  }

  const aimed = await target(businessId, log);
  const pool = aimed.pool;
  const who = await pool.query('SELECT current_database() AS db, current_user AS usr,'
    + ' inet_server_addr()::text AS host, version() AS v');
  const db = who.rows[0].db;
  log('[reset] database : ' + db);
  log('[reset] user     : ' + who.rows[0].usr);
  log('[reset] host     : ' + (who.rows[0].host || 'local socket'));
  log('[reset] environ  : ' + (env || '(unset)'));

  // What is about to be destroyed, named before it goes.
  const before = await pool.query(
    "SELECT nspname FROM pg_namespace WHERE nspname = 'public'"
    + " OR nspname IN ('chain','app') OR nspname ~ '^outlet_[0-9]+$' ORDER BY nspname");
  /* THE ROLES OF *THIS* BUSINESS, DERIVED FROM ITS OWN SCHEMAS — never from
     pg_roles, which is CLUSTER-WIDE.

     `pg_roles ~ '^outlet_[0-9]+_app$'` returns every outlet role belonging to
     every customer on the cluster, and the loop below runs DROP OWNED BY on
     each. DROP OWNED BY revokes privileges on SHARED objects — databases and
     tablespaces — from whichever database it is run in, so resetting ONE
     customer stripped every other customer's CONNECT on their own database.
     Found by running it: one scratch business reset, and `/readyz` went to
     "10 of 10 outlet(s) cannot be reached with their own login role", with
     `has_database_privilege('outlet_39_app','kashikeyo_biz_68','CONNECT')`
     false on a business the reset had never been aimed at. Every till on the
     cluster, off the air, from a reset of somebody else's store.

     Migration 039 already settled the right rule for the same question:
     discover the roles from the `outlet_%` SCHEMAS actually present, rather
     than from a list — here, the schemas of the database being reset. A role
     that serves no schema in this database is not this reset's to touch. */
  const roles = await pool.query(
    "SELECT DISTINCT nspname || '_app' AS rolname FROM pg_namespace"
    + " WHERE nspname ~ '^outlet_[0-9]+$'"
    + " AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = nspname || '_app')"
    + ' ORDER BY 1');
  log('[reset] schemas  : ' + (before.rows.map((r) => r.nspname).join(', ') || 'none'));
  log('[reset] roles    : ' + (roles.rows.map((r) => r.rolname).join(', ') || 'none'));

  // Other backends hold locks on what we are about to drop — the outgoing
  // container is still serving while a pre-deploy runs.
  await pool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity'
    + ' WHERE datname = current_database() AND pid <> pg_backend_pid()')
    .catch(() => {});

  const c = await pool.connect();
  try {
    await c.query("SET lock_timeout = '30s'");
    for (const r of before.rows) {
      if (r.nspname === 'public') continue;             // handled below
      await c.query('DROP SCHEMA IF EXISTS ' + ident(r.nspname) + ' CASCADE');
      log('[reset] dropped schema ' + r.nspname);
    }
    await c.query('DROP SCHEMA IF EXISTS public CASCADE');
    await c.query('CREATE SCHEMA public');
    await c.query('GRANT ALL ON SCHEMA public TO ' + ident(who.rows[0].usr));
    await c.query('GRANT ALL ON SCHEMA public TO public');
    log('[reset] public schema recreated empty');

    /* Roles are CLUSTER-wide, but DROP OWNED BY only reaches the current
       database. A role that also owns objects in another database on the same
       cluster cannot be dropped from here — and that is not a failure of THIS
       database's reset: its grants here are already gone, and provision_outlet
       re-uses an existing role and re-sets its derived password. So this is
       best-effort, and says so. */
    for (const r of roles.rows) {
      await c.query('DROP OWNED BY ' + ident(r.rolname)).catch(() => {});
      try {
        await c.query('DROP ROLE IF EXISTS ' + ident(r.rolname));
        log('[reset] dropped role ' + r.rolname);
      } catch (e) {
        log('[reset] kept role ' + r.rolname + ' (' + e.message.split('\n')[0]
          + ') — its grants in this database are gone and provisioning re-uses it');
      }
    }
  } finally {
    c.release();
  }

  const left = await pool.query(
    "SELECT count(*)::int AS n FROM pg_namespace"
    + " WHERE nspname IN ('chain','app') OR nspname ~ '^outlet_[0-9]+$'");
  const tables = await pool.query(
    "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");
  log('[reset] remaining app schemas: ' + left.rows[0].n
    + ' · tables in public: ' + tables.rows[0].n);
  if (left.rows[0].n || tables.rows[0].n) {
    throw new Error('reset did not finish clean — something was left behind');
  }
  log('[reset] ' + db + ' is empty. The next boot migrates from nothing.');
  return { database: db, schemas: before.rows.length, roles: roles.rows.length };
}

function ident(s) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) throw new Error('bad identifier: ' + s);
  return '"' + s + '"';
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (k) => {
    const i = argv.indexOf('--' + k);
    return i >= 0 ? (argv[i + 1] && argv[i + 1].indexOf('--') !== 0 ? argv[i + 1] : true) : null;
  };
  run(null, { business: flag('business') }).then(() => shutdown()).then(() => process.exit(0))
    .catch((e) => {
      console.error('[reset] ' + e.message);            // eslint-disable-line no-console
      process.exit(1);
    });
}

module.exports = { run };
