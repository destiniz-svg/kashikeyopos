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

---

## Multi-terminal load, soak & keyboard-a11y verification (audit "device/rig residuals")

Software stand-ins for the residuals that were marked "needs a device/rig".
Run on the sandbox (single Node + local Postgres) — indicative, not Railway prod.

### Multi-terminal concurrency (the load rig)
- **Correctness (in CI):** `test/audit.test.js → describe("multi-terminal concurrency (LOAD)")` — 8 terminals × 15 sales fired concurrently at one org: every sale lands exactly once, stock deducts exactly once (no lost updates); and the **last-unit conflict** (two terminals sell the final unit at once) records both offline-safe sales and **floors stock at 0, never negative**.
- **Throughput (2 × 60 s runs, 10 concurrent terminals):**
  | run | sales | sales/s | p50 | p95 | p99 |
  | --- | --- | --- | --- | --- | --- |
  | 1 (cold) | 14,254 | 237 | 21 ms | 38 ms | 921 ms |
  | 2 (warm) | 21,104 | 352 | 27 ms | 43 ms | **64 ms** |
  - **p95 ≈ 38–43 ms at 10 terminals — well inside the 750 ms checkout SLO.** (The cold run's p99 tail settles once the process warms.)
  - **Zero data loss:** direct DB count = **14,246** sales for the run (the load client's lower number was just `/api/pull` pagination, not loss). **Zero negative stock** across 35k+ concurrent deductions.

### Soak (leak proxy)
Two back-to-back 60 s bursts (~35k sales) on the same process: no crash, no OOM,
throughput stable/improving. Node RSS grew to ~351 MB during the bursts (heap
growth, not conclusively a leak). **Residual:** a real multi-hour soak with
heap snapshots is still worth running to confirm no slow unbounded growth.

### Keyboard / screen-reader (automated pass on the editable surfaces)
axe + a Playwright keyboard sweep of `/admin2`, `/back`, `/app2`:
- **0 interactive elements missing an accessible name** (all buttons/links/inputs named).
- **0 custom controls that are keyboard-unreachable.**
- `:focus` outline is reset **but paired with a `:focus-visible` rule** — the
  correct pattern, so keyboard focus stays visible; Tab moves focus through the page.
- **Residual:** a human screen-reader pass (announcement quality, focus-order
  logic) and the brand-colour contrast shade decision still want a person.

### True device-only residual (cannot be done headless)
The till bundle stalls on the PIN splash under headless Chromium, so
IndexedDB/localStorage-outbox survival across a real crash, service-worker
update-during-sync, and the 15 min–72 h offline soak must be driven on a tablet
with DevTools. The offline **wire contract** is already covered — see
`docs/offline-first-transaction-path.md`.
