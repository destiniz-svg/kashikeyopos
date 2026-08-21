'use strict';
/* ═══ REMOVE THE PREVIOUS APP'S DATA ════════════════════════════════════════
   This build keeps everything it owns in `chain`, `app` and `outlet_<id>`. It
   never reads or writes `public`, which is where the app that ran on this
   database before it kept everything. That is why the new app could be
   deployed without deleting anything: the two occupy the same database and
   share no object.

   This script clears out the tenant that moved out. THERE IS NO UNDO. It is
   run once, by hand, after somebody has confirmed the new site works.

   Four guards, because this destroys data nothing in this repository created:

     1. DROP_LEGACY_PUBLIC must be exactly "yes-i-mean-it". A flag that can be
        set by accident is not a guard.
     2. It REFUSES unless `chain.outlet` exists. That is the proof that this
        database belongs to THIS app and that `public` is somebody else's
        leftovers — pointed at a database the new app has never migrated, it
        would be deleting the only thing there.
     3. It names every table and its row count BEFORE dropping anything, so
        the log is the record of what was destroyed.
     4. It drops OBJECTS, not the schema. An extension installed into `public`
        — pgcrypto, uuid-ossp, postgis — is not the old app's data and is
        quite possibly load-bearing for the new one; `DROP SCHEMA public
        CASCADE` would take it with everything else. Objects that belong to an
        extension are skipped and named.

   Run it as a one-shot (a pre-deploy command), never on the start path, and
   disarm it afterwards.
   ═══════════════════════════════════════════════════════════════════════ */

const { owner, shutdown } = require('../db');

const CONFIRM = 'yes-i-mean-it';
const MINE = ['chain', 'app'];

async function run(say) {
  const log = say || console.log;                       // eslint-disable-line no-console

  if (process.env.DROP_LEGACY_PUBLIC !== CONFIRM) {
    throw new Error('refusing: set DROP_LEGACY_PUBLIC="' + CONFIRM + '" to confirm');
  }

  const pool = owner();
  const who = await pool.query('SELECT current_database() AS db, current_user AS usr,'
    + ' inet_server_addr()::text AS host');
  log('[legacy] database : ' + who.rows[0].db);
  log('[legacy] user     : ' + who.rows[0].usr);
  log('[legacy] host     : ' + (who.rows[0].host || 'local socket'));

  // Guard 2. Without this the script is "delete everything in the database".
  const mine = await pool.query(
    "SELECT to_regclass('chain.outlet') IS NOT NULL AS ok");
  if (!mine.rows[0].ok) {
    throw new Error('refusing: chain.outlet does not exist — this database has'
      + ' not been migrated by this app, so `public` is not somebody else\'s');
  }
  const outlets = await pool.query('SELECT count(*)::int AS n FROM chain.outlet');
  log('[legacy] this app owns chain/app and ' + outlets.rows[0].n + ' outlet(s) — public is not ours');

  /* ── what is about to go ───────────────────────────────────────────────── */
  const tables = await pool.query(
    "SELECT c.relname AS name, c.relkind AS kind,"
    + "       (SELECT count(*) FROM pg_depend d"
    + "         WHERE d.objid = c.oid AND d.deptype = 'e') > 0 AS from_extension"
    + "  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
    + " WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')"
    + " ORDER BY c.relkind, c.relname");

  const ext = await pool.query(
    "SELECT e.extname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace"
    + " WHERE n.nspname = 'public' ORDER BY 1");
  if (ext.rows.length) {
    log('[legacy] KEEPING extension(s) in public: ' + ext.rows.map((r) => r.extname).join(', '));
  }

  const KIND = { r: 'table', p: 'table', v: 'view', m: 'materialized view',
    S: 'sequence', f: 'foreign table' };
  const drop = tables.rows.filter((r) => !r.from_extension);
  const kept = tables.rows.filter((r) => r.from_extension);
  kept.forEach((r) => log('[legacy] keeping  ' + KIND[r.kind] + ' public.' + r.name
    + ' (belongs to an extension)'));

  if (!drop.rows && !drop.length) log('[legacy] public is already empty');
  let rows = 0;
  for (const t of drop) {
    let n = null;
    if (t.kind === 'r' || t.kind === 'p' || t.kind === 'm') {
      // A count is the only honest record of what was destroyed. A table that
      // refuses to be counted is still named and still dropped.
      try {
        const q = await pool.query('SELECT count(*)::bigint AS n FROM public.'
          + quote(t.name));
        n = Number(q.rows[0].n);
        rows += n;
      } catch (e) { n = null; }
    }
    log('[legacy] dropping ' + KIND[t.kind] + ' public.' + t.name
      + (n === null ? '' : ' (' + n + ' rows)'));
  }
  log('[legacy] ' + drop.length + ' object(s), ' + rows + ' row(s) in total');

  /* ── and it goes ───────────────────────────────────────────────────────── */
  for (const t of drop) {
    const what = t.kind === 'v' ? 'VIEW'
      : t.kind === 'm' ? 'MATERIALIZED VIEW'
        : t.kind === 'S' ? 'SEQUENCE'
          : t.kind === 'f' ? 'FOREIGN TABLE' : 'TABLE';
    await pool.query('DROP ' + what + ' IF EXISTS public.' + quote(t.name) + ' CASCADE');
  }

  // Routines the old app left behind. Extension-owned ones are skipped for the
  // same reason their tables are.
  const fns = await pool.query(
    "SELECT p.oid::regprocedure::text AS sig, p.prokind AS kind"
    + "  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace"
    + " WHERE n.nspname = 'public'"
    + "   AND NOT EXISTS (SELECT 1 FROM pg_depend d"
    + "                    WHERE d.objid = p.oid AND d.deptype = 'e')");
  for (const f of fns.rows) {
    const what = f.kind === 'a' ? 'AGGREGATE' : f.kind === 'p' ? 'PROCEDURE' : 'FUNCTION';
    log('[legacy] dropping ' + what.toLowerCase() + ' ' + f.sig);
    await pool.query('DROP ' + what + ' IF EXISTS ' + f.sig + ' CASCADE');
  }

  const types = await pool.query(
    "SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace"
    + " WHERE n.nspname = 'public' AND t.typtype IN ('e','c','d')"
    + "   AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid"
    + "                     AND c.relkind <> 'c')"
    + "   AND NOT EXISTS (SELECT 1 FROM pg_depend d"
    + "                    WHERE d.objid = t.oid AND d.deptype = 'e')");
  for (const t of types.rows) {
    log('[legacy] dropping type public.' + t.typname);
    await pool.query('DROP TYPE IF EXISTS public.' + quote(t.typname) + ' CASCADE');
  }

  /* ── say what is true now ──────────────────────────────────────────────── */
  const left = await pool.query(
    "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
    + " WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')"
    + "   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')");
  if (left.rows[0].n !== 0) {
    throw new Error('public still holds ' + left.rows[0].n + ' object(s) after the drop');
  }
  // And the thing that matters: this app is untouched.
  const still = await pool.query('SELECT count(*)::int AS n FROM chain.outlet');
  const schemas = await pool.query(
    'SELECT nspname FROM pg_namespace WHERE nspname = ANY($1) ORDER BY 1', [MINE]);
  if (schemas.rows.length !== MINE.length) {
    throw new Error('this app\'s schemas are not all present after the drop');
  }
  log('[legacy] public is clear; chain/app intact with '
    + still.rows[0].n + ' outlet(s)');
  return { dropped: drop.length, rows: rows };
}

// An identifier from the catalogue, quoted for the statement it is going into.
function quote(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

if (require.main === module) {
  run().then(function () { return shutdown(); })
    .then(function () { process.exit(0); })
    .catch(function (e) {
      console.error('[legacy] ' + e.message);            // eslint-disable-line no-console
      process.exit(1);
    });
}

module.exports = { run };
