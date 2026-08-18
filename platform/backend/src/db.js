'use strict';
const { Pool } = require('pg');
const { outletPassword, rolePassword } = require('./secrets');

const ssl = process.env.NODE_ENV === 'production'
  ? { rejectUnauthorized: false }   // Railway's Postgres terminates TLS at the proxy
  : false;

// ── owner pool: migrations and provisioning only. Never reachable from a
//    request handler; routes.js has no import of it.
let ownerPool = null;
function owner() {
  if (!ownerPool) {
    ownerPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 3 });
  }
  return ownerPool;
}

// ── one pool per outlet, each authenticating as that outlet's own role.
//    Two outlets never share a connection, so there is no path by which a
//    forgotten WHERE clause reaches another outlet's rows: the tables are not
//    in this role's search_path and USAGE was never granted on that schema.
const pools = new Map();
function poolFor(outletId) {
  const id = Number(outletId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('bad outlet id');
  if (!pools.has(id)) {
    pools.set(id, new Pool({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE,
      user: 'outlet_' + id + '_app',
      password: outletPassword(id),
      ssl,
      max: Number(process.env.PGPOOL_MAX || 6),
      idleTimeoutMillis: 30000,
      statement_timeout: 15000
    }));
  }
  return pools.get(id);
}

// ── every query runs inside a transaction that first declares who is asking.
//    SET LOCAL is transaction-scoped: it cannot survive back into the pool and
//    leak context into the next request.
async function withOutlet(ctx, fn) {
  const client = await poolFor(ctx.outletId).connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.outlet_id', $1, true),"
      + " set_config('app.user_rank', $2, true),"
      + " set_config('app.actor', $3, true),"
      + " set_config('app.scope', $4, true)",
      [String(ctx.outletId), String(ctx.rank || 0), ctx.actor || '',
       ctx.scope === 'group' ? 'group' : 'outlet']
    );
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(function () {});
    throw e;
  } finally {
    client.release();
  }
}

// Read-only estate reporting. Uses a dedicated role that can execute the
// aggregate function and nothing else.
let reportPool = null;
function reporting() {
  if (!reportPool) {
    reportPool = new Pool({
      host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE, user: 'kashikeyo_report',
      password: process.env.REPORT_ROLE_PASSWORD, ssl, max: 2
    });
  }
  return reportPool;
}

async function withEstate(ctx, fn) {
  if ((ctx.rank || 0) < 5) throw Object.assign(new Error('rank 5 required'), { status: 403 });
  const client = await reporting().connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(
      "SELECT set_config('app.outlet_id', $1, true),"
      + " set_config('app.user_rank', '5', true),"
      + " set_config('app.actor', $2, true),"
      + " set_config('app.scope', 'group', true)",
      [String(ctx.outletId || 0), ctx.actor || '']);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } finally { client.release(); }
}

/**
 * Record a group-scope read in the audit trail — BEFORE the read, in its own
 * short read-write transaction on the same pool and as the same role.
 *
 * It cannot go inside `withEstate`: that transaction is `BEGIN READ ONLY`, and
 * that is not incidental. Read-only is what makes it structurally impossible
 * for the one connection that can see across outlets to change anything in any
 * of them, and giving it up to save a round trip would be trading the property
 * for the paperwork about the property.
 *
 * It cannot go on the owner's own outlet connection either. `chain.log()`
 * stamps the scope from `app.group_scope()`, which is false there, so the
 * entry would read `scope = 'outlet'` — a trail recording the single
 * cross-outlet read in the system as an ordinary local one, which is worse
 * than no trail because it would be believed.
 *
 * Written first, so a read that then fails still leaves the attempt on record.
 * An audit trail of successful reads only is an audit trail with the
 * interesting half missing.
 */
async function noteGroupRead(ctx, entityId) {
  if ((ctx.rank || 0) < 5) throw Object.assign(new Error('rank 5 required'), { status: 403 });
  const client = await reporting().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.outlet_id', $1, true),"
      + " set_config('app.user_rank', '5', true),"
      + " set_config('app.actor', $2, true),"
      + " set_config('app.scope', 'group', true)",
      [String(ctx.outletId || 0), ctx.actor || '']);
    await client.query('SELECT chain.log_estate_read($1)', [entityId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(function () {});
    throw e;
  } finally { client.release(); }
}

/**
 * A member's own session. Chain-wide, and narrower than any outlet's.
 *
 * A member belongs to no outlet — they earn at one branch and spend at another
 * — so there is no `outlet_<id>_app` role that fits them. This is the third
 * role: it holds USAGE on `chain` and `app` and a SELECT on six tables, no
 * grant of any kind on any outlet schema, and every policy it meets requires
 * `current_user = 'kashikeyo_member'` as well as the id in `app.member_id`. So
 * an outlet connection that sets that variable gains nothing, exactly as one
 * that asks for group scope gains nothing.
 *
 * READ ONLY at the transaction level, with the two writes a member legitimately
 * makes — issuing a voucher, offering points — going through the outlet's own
 * connection or a SECURITY DEFINER function that does the whole thing at once.
 */
let memberPool = null;

/**
 * The same role, with NOBODY signed in.
 *
 * Signing in is the one operation that cannot name a member — it is trying to
 * find out whether there is one. So this connection sets no `app.member_id`,
 * which means every policy keyed on `app.member_self()` matches nothing: it can
 * read no member, no visit and no voucher. All it can do is call the three
 * SECURITY DEFINER functions the sign-in path needs, which enforce the
 * cooldown and the attempt limit themselves.
 */
async function withMemberAnon(fn) {
  return withMember(null, fn, true);
}

async function withMember(memberId, fn, anonymous) {
  if (!memberId && !anonymous) {
    throw Object.assign(new Error('member session required'), { status: 401 });
  }
  if (!memberPool) {
    memberPool = new Pool({
      host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE, user: 'kashikeyo_member',
      password: rolePassword('member'), ssl,
      max: Number(process.env.PGPOOL_MAX || 6),
      idleTimeoutMillis: 30000, statement_timeout: 15000,
    });
  }
  const client = await memberPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.member_id', $1, true)",
      [memberId ? String(memberId) : '']);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(function () {});
    throw e;
  } finally { client.release(); }
}

async function shutdown() {
  const all = Array.from(pools.values());
  if (ownerPool) all.push(ownerPool);
  if (reportPool) all.push(reportPool);
  if (memberPool) all.push(memberPool);
  await Promise.all(all.map(function (p) { return p.end().catch(function () {}); }));
}

module.exports = {
  owner, poolFor, withOutlet, withEstate, noteGroupRead,
  withMember, withMemberAnon, shutdown,
};
