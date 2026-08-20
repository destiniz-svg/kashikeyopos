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
   ═══════════════════════════════════════════════════════════════════════ */

const { owner, shutdown } = require('../db');

const CONFIRM = 'yes-i-mean-it';

async function run(say) {
  const log = say || console.log;                       // eslint-disable-line no-console

  if (process.env.RESET_DATABASE !== CONFIRM) {
    throw new Error('refusing: set RESET_DATABASE="' + CONFIRM + '" to confirm');
  }
  const env = (process.env.RAILWAY_ENVIRONMENT_NAME || '').toLowerCase();
  if (env === 'production') {
    throw new Error('refusing: RAILWAY_ENVIRONMENT_NAME is "production"');
  }

  const pool = owner();
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
  const roles = await pool.query(
    "SELECT rolname FROM pg_roles WHERE rolname ~ '^outlet_[0-9]+_app$' ORDER BY rolname");
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
  run().then(() => shutdown()).then(() => process.exit(0))
    .catch((e) => {
      console.error('[reset] ' + e.message);            // eslint-disable-line no-console
      process.exit(1);
    });
}

module.exports = { run };
