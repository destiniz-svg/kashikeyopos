# Scaling & connection pooling (Railway) — cost + uptime

This is the P0 foundation for the prototype→production upgrade. It makes one
small, cheap Railway instance carry many tills, and keeps the app correct when a
**transaction-mode connection pooler (PgBouncer)** is put in front of Postgres.
Nothing here changes behaviour until you actually add the pooler — the code
falls back to the single `DATABASE_URL` when the direct URL is unset.

## Why a pooler, and why it's safe here

A transaction-mode pooler multiplexes thousands of client connections onto a
small pool of real Postgres connections — so you pay for one right-sized
instance instead of scaling the database to your client count. Railway sizes one
PgBouncer replica to ~1,000 clients on ~20 server connections.

Request handling is **safe through a transaction pooler** because every tenant
query runs inside `withScope()`'s `BEGIN … COMMIT` and sets the org scope with
`set_config('app.org_id', …, true)` — the `true` makes it **transaction-local**.
A transaction pins to one backend for its whole life, so RLS and the org scope
never leak or get lost between statements.

Two things must **not** cross a transaction pooler, because it reassigns the
backend between statements:

1. **The boot advisory lock** — held across schema apply / role DDL (session-scoped).
2. **The `LISTEN` poke listener** — a long-lived registration for SSE fan-out.

Both now use a **direct** connection; `NOTIFY` (a single auto-committed
statement) still goes through the normal pool.

## The three connection roles (in `index.js`)

| Role | Endpoint | Used for |
| --- | --- | --- |
| `bootPool` | **direct** (`directPoolConfig`) | schema apply, role/grant DDL, boot advisory lock |
| request `pool` | **pooled** (`appPoolConfig`, app role) | every `/api/*` request — safe through PgBouncer |
| poke `Client` | **direct** (`appDirectPoolConfig`, app role) | the `LISTEN` connection for SSE cross-instance pokes |

## Environment variables

| Variable | Set to | Notes |
| --- | --- | --- |
| `DATABASE_URL` | the **pooled** endpoint (PgBouncer) | request pool. |
| `DIRECT_DATABASE_URL` | the **direct** `:5432` endpoint | boot + LISTEN. Aliases: `DIRECT_URL`, `PGBOUNCER_DIRECT_URL`. **If unset, falls back to `DATABASE_URL`** — so local/dev and non-pooled deploys are unaffected. |
| `PG_POOL_MAX` | e.g. `8`–`12` | caps the app pool per instance so many replicas behind the pooler don't each open a large fan of server connections. Optional. |

## Turning it on in Railway (owner steps)

1. Postgres service → **Database → Config → Connection Pooling → Add PgBouncer**,
   pool mode **Transaction** (default), deploy the staged change.
2. Copy the **pooled** connection string into the app service's `DATABASE_URL`,
   and the **direct** connection string into `DIRECT_DATABASE_URL`.
3. (Optional) set `PG_POOL_MAX=10`.
4. Redeploy the app. Boot log must show, in order: `schema ready` →
   `connected as restricted role kashikeyo_app …` → `poke listener connected …`.
   Health `GET /api/health` → `{ ok:true, db:true }`.

## High availability (uptime)

For real uptime, move Postgres to Railway's **one-click HA (Patroni)**: in-region
replicas, point-in-time recovery, and built-in `pgvector` (useful later for
semantic search / the assistant). PgBouncer sits in front of the HA primary the
same way. Prefer **staggered/rolling** app deploys so nodes don't cold-boot the
schema at the same instant (the boot advisory lock already serialises them, but
rolling avoids the contention entirely).

## Verified

- 37/37 `npm test` green with `DIRECT_DATABASE_URL` unset (fallback path — no
  behaviour change).
- Boot with `DATABASE_URL` + `DIRECT_DATABASE_URL` both set: schema applied via
  the direct pool, requests served via the app pool, and the `LISTEN` poke
  listener connected via the direct pool — all confirmed in the boot log, plus a
  store registered end-to-end through the request pool.
