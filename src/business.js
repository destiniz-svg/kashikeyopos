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
  const { dbPrefix } = require('./db');
  const shape = new RegExp('^' + dbPrefix().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + '[0-9]+$');
  if (!shape.test(String(name || ''))) {
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
    /* THE MOST CONSEQUENTIAL ACT THIS INSTALL PERFORMS, AND IT WAS SILENT.
       Boot says "[migrate] N business database(s) at head 38"; creating one
       said nothing at all — CREATE DATABASE and thirty-eight migrations, no
       line in the log. The progress IS recorded, in chain.business.build_state,
       which is the right place for a half-built row to be visible; but the
       process log is where somebody looks when a customer says the signup hung,
       and it had nothing to show them. Same reason the watchdog logs before it
       emails: the log is the channel of last resort. */
    await step(id, 'creating the database');
    console.log('[business] ' + id + ' "' + name + '" · creating ' + db);
    await owner().query('CREATE DATABASE ' + db);

    await step(id, 'migrating');
    await migrateBusiness(db, (line) => console.log('[business] ' + id + ' · ' + line));
    /* How far the database IS, read from its own ledger — not how many files
       this run happened to apply. A re-run applies none, and recording that as
       the version would say a migrated database was at zero. */
    const at = await ownerFor(db).query(
      'SELECT count(*)::int AS n FROM chain.migration');

    await control().query(
      'UPDATE chain.business SET status = $2, build_state = NULL,'
      + ' schema_version = $3, live_at = now() WHERE id = $1',
      [id, 'live', Number(at.rows[0].n)]);
    console.log('[business] ' + id + ' "' + name + '" · live · ' + db
      + ' at ' + Number(at.rows[0].n));
  } catch (e) {
    /* Named, never rounded up. The row carries which step failed in the
       database's own words, and the database — if one was made — is left where
       a person can see it. Dropping it here would destroy the only evidence of
       what went wrong. */
    console.error('[business] ' + id + ' "' + name + '" · FAILED · '
      + String(e.message || e));
    await control().query(
      "UPDATE chain.business SET status = 'failed', build_state = $2 WHERE id = $1",
      [id, String(e.message || e)]).catch(() => {});
    throw e;
  }

  const row = await control().query('SELECT * FROM chain.business WHERE id = $1', [id]);
  return row.rows[0];
}

/* Register an outlet the caller already has an id for. provisionOutlet is
   given one by the leak test, by a restore and by any path replaying a known
   estate, and an outlet with no directory row has no route home — its handle
   cannot even be claimed, because the registry's foreign key points here. The
   sequence is nudged past a hand-picked id so the next allocation cannot
   collide with it. */
async function registerOutlet(outletId, businessId) {
  const id = Number(outletId);
  /* AN OUTLET NEVER CHANGES HANDS SILENTLY. This upsert used to end
     `DO UPDATE SET business_id = excluded.business_id`, so provisioning an
     outlet with an id already registered to somebody else RE-POINTED it — and
     this table is the routing table for tenancy: every session token naming
     that outlet would open the other customer's database from the next cache
     refresh on.

     Found in the audit, and honestly: by running leak-test, which provisions
     outlets 1 and 2 into whatever database it is aimed at, against a registry
     shared with two real businesses. It moved outlet 1 from one business to
     the other without a word, and the only symptom was a lock screen with an
     empty roster. The isolation belts held — the other database has no such
     staff — so nothing leaked. What failed was the ROUTE, and a boundary an
     ordinary provisioning call can move is not a boundary.

     Re-registering the SAME business stays idempotent: a caller that supplies
     an id needs a route home whether or not one exists. A different business
     is refused by name, which is the choice adopt-install.js already makes
     when it finds an id taken — it remaps rather than steals. The two paths
     now agree. */
  const held = await control().query(
    'SELECT business_id FROM chain.outlet_directory WHERE outlet_id = $1', [id]);
  if (held.rows.length && Number(held.rows[0].business_id) !== Number(businessId)) {
    throw Object.assign(new Error('outlet ' + id + ' is already registered to'
      + ' business ' + held.rows[0].business_id + ' — allocate a free id or'
      + ' remap it (npm run adopt) rather than re-pointing a live route'),
    { status: 409 });
  }
  await control().query(
    'INSERT INTO chain.outlet_directory (outlet_id, business_id) VALUES ($1,$2)'
    + ' ON CONFLICT (outlet_id) DO UPDATE SET business_id = excluded.business_id'
    + ' WHERE chain.outlet_directory.business_id = excluded.business_id',
    [id, businessId]);
  await control().query(
    "SELECT setval('chain.outlet_id_seq', greatest(nextval('chain.outlet_id_seq'), $1))",
    [id]);
  return id;
}

/* Which business a database IS. A business database does not carry its own
   registry id — that would be a second source of truth for the thing routing
   depends on — so it is looked up by name. A database the registry has never
   heard of registers itself: a local run, the test suite, an install being
   adopted.

   THIS NEEDS A REGISTRY, and that is not the caveat it reads as. control()
   throws when CONTROL_DB is unset, so on an install without one this raises
   four calls deep inside provisionOutlet and the onboarding panel's second
   step comes back a bare 500 — an install that can record a company and never
   an outlet. server.js names that at boot now rather than letting it surface
   here; see registryNamed(). */
async function businessForDb(dbName) {
  const found = await control().query(
    'SELECT id FROM chain.business WHERE db_name = $1', [dbName]);
  if (found.rows.length) return Number(found.rows[0].id);
  /* Recorded at the version it ACTUALLY is, read from its own ledger. A
     database being adopted has usually been migrated already — the default of
     0 would say it was at nothing, and requireAtHead would then refuse every
     request to a store that is perfectly up to date. */
  let at = 0;
  try {
    const q = await ownerFor(dbName).query(
      "SELECT count(*)::int AS n FROM chain.migration");
    at = Number(q.rows[0].n);
  } catch (e) { at = 0; }      // no ledger yet: it is about to be migrated

  const made = await control().query(
    "INSERT INTO chain.business (name, db_name, status, schema_version, live_at)"
    + " VALUES ($1,$2,'live',$3,now()) ON CONFLICT (db_name) DO UPDATE"
    + ' SET schema_version = greatest(chain.business.schema_version, excluded.schema_version)'
    + ' RETURNING id', [dbName, dbName, at]);
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
      'SELECT d.business_id, b.db_name, b.status, b.schema_version'
      + ' FROM chain.outlet_directory d'
      + ' JOIN chain.business b ON b.id = d.business_id'
      + ' WHERE d.outlet_id = $1 AND d.active', [id]);
    if (!q.rows.length) { routes.delete(id); return null; }
    const r = { db: q.rows[0].db_name, businessId: Number(q.rows[0].business_id),
      status: q.rows[0].status, version: Number(q.rows[0].schema_version),
      at: Date.now() };
    routes.set(id, r);
    return r;
  } catch (e) {
    if (hit) return hit;            // stale beats dark
    throw e;
  }
}

/* A BUSINESS BEHIND HEAD IS REFUSED, NOT SERVED. One app now serves many
   databases, so a deploy that moved the code but not every schema leaves
   somebody's till talking to a database that does not have the columns the
   code just started using. Serving it means wrong answers about money;
   refusing it means a shop is down for the length of a migration and knows
   why. Named, with the remedy, because "service unavailable" leaves whoever
   is holding the phone exactly where silence would.

   Deliberately NOT cached separately: routeFor's 30s TTL is the window, and it
   is short enough that a finished migration is picked up without a restart. */
async function requireAtHead(outletId) {
  const r = await routeFor(outletId);
  if (!r) {
    throw Object.assign(new Error('that outlet is not in the registry'),
      { status: 404 });
  }
  if (r.status !== 'live') {
    throw Object.assign(new Error('this store is still being set up'),
      { status: 503, retryable: true });
  }
  const head = require('./scripts/migrate').headCount();
  if (r.version < head) {
    throw Object.assign(new Error('this store is being updated (schema '
      + r.version + ' of ' + head + ') — it will answer again in a moment'),
    { status: 503, retryable: true });
  }
  return r;
}

function forgetRoute(outletId) {
  if (outletId == null) routes.clear(); else routes.delete(Number(outletId));
}

module.exports = { createBusiness, nextOutletId, registerOutlet, businessForDb,
  routeFor, requireAtHead, forgetRoute,
  _safeDbName: safeDbName };
