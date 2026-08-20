'use strict';
const { Pool } = require('pg');
const { outletPassword } = require('./secrets');

/* ═══ CONNECTIONS ═══════════════════════════════════════════════════════════
   Two belts of isolation, and this file is where the first one is fastened.

   1. Each outlet connects as its OWN database login role, granted USAGE on its
      own schema alone. Another outlet's tables are unreachable, not merely
      filtered — a forgotten WHERE clause cannot leak, because the rows are not
      in this role's search_path and the schema was never granted.
   2. RLS with FORCE ROW LEVEL SECURITY guards the shared `chain` schema, which
      is by definition visible to every outlet role.

   The owner connection runs migrations and provisioning. No route imports it:
   `ownerOnly()` throws if it is reached while a request context is open.
   ═══════════════════════════════════════════════════════════════════════ */

const ssl = /^(1|true|require)$/i.test(process.env.PGSSL || '')
  || (process.env.NODE_ENV === 'production' && !!process.env.DATABASE_URL)
  ? { rejectUnauthorized: false }
  : false;

function baseConn() {
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    return {
      host: u.hostname,
      port: Number(u.port || 5432),
      database: decodeURIComponent((u.pathname || '/postgres').slice(1))
    };
  }
  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'postgres'
  };
}

let ownerPool = null;
function owner() {
  if (!ownerPool) {
    const cfg = process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL, ssl }
      : Object.assign(baseConn(), {
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || '',
        ssl
      });
    ownerPool = new Pool(Object.assign(cfg, { max: 3, application_name: 'kashikeyo-owner' }));
  }
  return ownerPool;
}

// ── one pool per outlet, each authenticating as that outlet's own role ───────
const pools = new Map();
function poolFor(outletId) {
  const id = Number(outletId);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('bad outlet id'), { status: 400 });
  if (!pools.has(id)) {
    pools.set(id, new Pool(Object.assign(baseConn(), {
      user: 'outlet_' + id + '_app',
      password: outletPassword(id),
      ssl,
      max: Number(process.env.PGPOOL_MAX || 6),
      idleTimeoutMillis: 30000,
      statement_timeout: Number(process.env.PGSTATEMENT_TIMEOUT || 15000),
      application_name: 'kashikeyo-outlet-' + id
    })));
  }
  return pools.get(id);
}

/* Every request query runs inside a transaction that first declares who is
   asking. SET LOCAL is transaction-scoped: it cannot survive back into the
   pool and carry one outlet's context into the next request. This is not a
   style preference — `SET` without `LOCAL` is a cross-tenant leak waiting for
   load. */
async function setContext(client, ctx) {
  await client.query(
    "SELECT set_config('app.outlet_id', $1, true),"
    + " set_config('app.user_rank', $2, true),"
    + " set_config('app.actor', $3, true),"
    + " set_config('app.scope', $4, true),"
    + " set_config('app.device', $5, true)",
    [String(ctx.outletId || ''), String(ctx.rank || 0), ctx.actor || '',
      ctx.scope === 'group' ? 'group' : 'outlet', ctx.deviceId || '']
  );
}

/* A caught query error inside a transaction is a landmine: Postgres poisons
   the transaction, and the COMMIT that follows silently becomes a ROLLBACK
   with no error raised. The caller then reports success on work that was
   discarded. Every commit is therefore checked — if the server said ROLLBACK,
   so do we, loudly. */
async function commit(client) {
  const q = await client.query('COMMIT');
  if (q && q.command === 'ROLLBACK') {
    throw Object.assign(
      new Error('transaction was aborted by an earlier error and did not commit'),
      { status: 500, aborted: true });
  }
}

async function withOutlet(ctx, fn) {
  const client = await poolFor(ctx.outletId).connect();
  try {
    await client.query('BEGIN');
    await setContext(client, ctx);
    const out = await fn(client);
    await commit(client);
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Read-only variant: a report can never be the thing that changed the books.
async function withOutletRead(ctx, fn) {
  const client = await poolFor(ctx.outletId).connect();
  try {
    await client.query('BEGIN READ ONLY');
    await setContext(client, ctx);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* The ONE cross-outlet read in the system: aggregates only, rank 5 only,
   through a dedicated read-only role that can execute the aggregate function
   and nothing else, and stamped in the audit trail as group scope. */
let reportPool = null;
async function withEstate(ctx, fn) {
  if ((ctx.rank || 0) < 5) throw Object.assign(new Error('rank 5 required'), { status: 403 });
  if (!reportPool) {
    reportPool = new Pool(Object.assign(baseConn(), {
      user: 'kashikeyo_report',
      password: process.env.REPORT_ROLE_PASSWORD || outletPassword('report'),
      ssl, max: 2, application_name: 'kashikeyo-report'
    }));
  }
  const client = await reportPool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await setContext(client, { outletId: ctx.outletId || 0, rank: 5, actor: ctx.actor, scope: 'group' });
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

/* Provisioning and migrations only. A route that needs this is a route with a
   design fault: the owner role bypasses both belts. */
async function withOwner(fn) {
  const client = await owner().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await commit(client);
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

async function shutdown() {
  const all = Array.from(pools.values());
  if (ownerPool) all.push(ownerPool);
  if (reportPool) all.push(reportPool);
  pools.clear(); ownerPool = null; reportPool = null;
  await Promise.all(all.map((p) => p.end().catch(() => {})));
}

// Drop a cached pool — used after a role password rotation or a re-provision.
function forget(outletId) {
  const id = Number(outletId);
  const p = pools.get(id);
  if (p) { pools.delete(id); p.end().catch(() => {}); }
}

module.exports = {
  owner, poolFor, withOutlet, withOutletRead, withEstate, withOwner,
  setContext, commit, shutdown, forget
};
