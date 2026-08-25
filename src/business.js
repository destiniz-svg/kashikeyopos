'use strict';
/* ═══ CREATING A BUSINESS ════════════════════════════════════════════════════
   A customer signs up on the website and gets a DATABASE of their own. Not a
   Railway project, not a schema — a database on the cluster this app is
   already connected to.

   Why a database and not a schema: `applySale()` moves chain.member.points and
   chain.member.credit_used in the SAME transaction as the sale, its tenders,
   its stock moves and its journal. Postgres has no cross-database transaction,
   so everything one sale touches has to live in one database or a crash can
   take the money without the balance. Why not one database per OUTLET: for the
   same reason — a chain's points and credit are one figure across its outlets,
   and outlets are already isolated from each other by schema and login role
   inside the business, which is the belt leak-test exists to prove.

   PROGRESS IS RECORDED BEFORE IT IS MADE. Every step writes the registry row
   first, so a process that dies mid-run leaves a row saying how far it got.
   The expensive failure here is not an error, it is an ORPHAN: a database
   nobody knows about, which is invisible until somebody reads the cluster by
   hand. The same rule panel/railway.js follows, for the same reason.
   ═══════════════════════════════════════════════════════════════════════════ */

const { control, ownerFor, owner, businessDb } = require('./db');
const { migrateBusiness } = require('./scripts/migrate');

/* A database name is an identifier, not a value, so it can never be
   parameterised — which is exactly why it is never taken from a caller.
   businessDb() derives it from the registry's own integer id, and this refuses
   anything that did not come from there. Belt and braces on the one statement
   in this file that interpolates. */
function safeDbName(name) {
  if (!/^kashikeyo_biz_[0-9]+$/.test(String(name || ''))) {
    throw Object.assign(new Error('refusing a database name this module did'
      + ' not derive: ' + name), { status: 500 });
  }
  return name;
}

async function step(id, state) {
  await control().query('UPDATE chain.business SET build_state = $2 WHERE id = $1',
    [id, state]);
}

/* Allocate the next outlet id from the REGISTRY, never from inside a business
   database. provision.js took max(id)+1 within one install, so every install
   had an outlet 1 — and under one cluster a session token naming outlet 7 has
   to resolve to exactly one store anywhere in the estate. Same class as the
   install-uuid fence in migration 026. */
async function nextOutletId(businessId) {
  const q = await control().query(
    "SELECT nextval('chain.outlet_id_seq')::int AS id");
  const id = Number(q.rows[0].id);
  await control().query(
    'INSERT INTO chain.outlet_directory (outlet_id, business_id) VALUES ($1,$2)',
    [id, businessId]);
  return id;
}

/* Create the business: register it, make its database, migrate it. Returns the
   registry row. The FIRST OUTLET is deliberately not created here — onboarding
   creates it, because the outlet's name, timezone, currency and handle are all
   things the customer is about to type, and inventing them so they can be
   overwritten is how a store ends up trading under "Outlet 1" in UTC. */
async function createBusiness(opts) {
  const name = String((opts && opts.name) || '').trim();
  if (!name) throw Object.assign(new Error('a business needs a name'), { status: 400 });

  const reg = await control().query(
    "INSERT INTO chain.business (name, db_name, status, build_state)"
    + " VALUES ($1, 'pending', 'building', 'registering') RETURNING id", [name]);
  const id = Number(reg.rows[0].id);
  const db = safeDbName(businessDb(id));
  await control().query('UPDATE chain.business SET db_name = $2 WHERE id = $1', [id, db]);

  try {
    /* CREATE DATABASE cannot run inside a transaction block, and the pg driver
       opens none for a bare query — but it also cannot be parameterised, hence
       safeDbName above. The owner connection is the only one with the right to
       do this, and this file is the only caller. */
    await step(id, 'creating the database');
    await owner().query('CREATE DATABASE ' + db);

    await step(id, 'migrating');
    await migrateBusiness(db, () => {});
    /* How far the database IS, read from its own ledger — not how many files
       this run happened to apply. A re-run applies none, and recording that as
       the version would say a migrated database was at zero. */
    const at = await ownerFor(db).query(
      'SELECT count(*)::int AS n FROM chain.migration');

    await control().query(
      'UPDATE chain.business SET status = $2, build_state = NULL,'
      + ' schema_version = $3, live_at = now() WHERE id = $1',
      [id, 'live', Number(at.rows[0].n)]);
  } catch (e) {
    /* Named, never rounded up. The row carries which step failed in the
       database's own words, and the database — if one was made — is left where
       a person can see it. Dropping it here would destroy the only evidence of
       what went wrong. */
    await control().query(
      "UPDATE chain.business SET status = 'failed', build_state = $2 WHERE id = $1",
      [id, String(e.message || e)]).catch(() => {});
    throw e;
  }

  const row = await control().query('SELECT * FROM chain.business WHERE id = $1', [id]);
  return row.rows[0];
}

/* Which business a database IS. A business database does not carry its own
   registry id — that would be a second source of truth for the thing routing
   depends on — so it is looked up by name. A database the registry has never
   heard of registers itself: that is the single-database case (a local run, the
   test suite, an install that predates the registry), and refusing it would
   mean the ordinary path could not create an outlet at all. */
async function businessForDb(dbName) {
  const found = await control().query(
    'SELECT id FROM chain.business WHERE db_name = $1', [dbName]);
  if (found.rows.length) return Number(found.rows[0].id);
  const made = await control().query(
    "INSERT INTO chain.business (name, db_name, status, live_at)"
    + " VALUES ($1,$2,'live',now()) ON CONFLICT (db_name) DO UPDATE"
    + ' SET db_name = excluded.db_name RETURNING id', [dbName, dbName]);
  return Number(made.rows[0].id);
}

/* Where a request goes. A token names an outlet; this says which database to
   open. Cached, because it is on the hot path of every authenticated request —
   the same shape src/directory.js uses for handles, including the rule that
   matters most: a failed refresh keeps serving the last answer, because a
   registry blip must not take every till offline. */
const TTL_MS = 30000;
const routes = new Map();          // outletId -> { db, businessId, at }

async function routeFor(outletId) {
  const id = Number(outletId);
  const hit = routes.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  try {
    const q = await control().query(
      'SELECT d.business_id, b.db_name, b.status FROM chain.outlet_directory d'
      + ' JOIN chain.business b ON b.id = d.business_id'
      + ' WHERE d.outlet_id = $1 AND d.active', [id]);
    if (!q.rows.length) { routes.delete(id); return null; }
    const r = { db: q.rows[0].db_name, businessId: Number(q.rows[0].business_id),
      status: q.rows[0].status, at: Date.now() };
    routes.set(id, r);
    return r;
  } catch (e) {
    if (hit) return hit;            // stale beats dark
    throw e;
  }
}

function forgetRoute(outletId) {
  if (outletId == null) routes.clear(); else routes.delete(Number(outletId));
}

module.exports = { createBusiness, nextOutletId, businessForDb,
  routeFor, forgetRoute,
  _safeDbName: safeDbName };
