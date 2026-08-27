# 02 · System architecture — as built, verified 2026-08-27

Audited from the source at commit `02371c7`, not from documentation. Where
CLAUDE.md disagrees with the code, the code is reported here.

## Stack

| Layer | What it actually is |
| --- | --- |
| Runtime | Node 22 (image `node:22-alpine`), CommonJS, **no build step** |
| Dependencies | `express` 4.21, `pg` 8.13 — **two**, `npm ci --omit=dev`, lockfile-pinned |
| Database | PostgreSQL 16 (harness) / 18 (production, Railway) |
| Frontend | Hand-written HTML served from disk; React UMD + a small DC template runtime (`new Function`-compiled), no bundler |
| Offline store | IndexedDB via `app/kashikeyo-api.js` — durable outbox keyed by client v4 `opId` |
| Hosting | Railway, Dockerfile build, `/readyz` healthcheck, restart ON_FAILURE ×3 |

## Three services, one image

```
node server.js        the till, guest portal, member card, doc pages, API
node panel/server.js  Mission Control (seller panel) — own service, own port
node site/server.js   public website: landing, docs, legal, signup
```

Same Dockerfile; the start command selects the program. The panel and site each
hold an advisory lock over their own DDL because they boot against the shared
registry.

## Tenancy: one cluster, a database per business

```
kashikeyo_control            the registry (CONTROL_DB, named, never guessed)
  chain.account / account_identity / account_business
  chain.business (db_name, schema_version)  chain.outlet_directory
  chain.handle_* / reserved_handle          chain.licence-adjacent panel.* tables
  chain.backup (control/004)                chain.audit (registry's own trail)
kashikeyo_biz_<id>           one per customer, migrations 001–044
  chain.*  (company, outlet, staff, member, device, session, setting,
            tax_version, doc_series, supplier, audit, licence)
  outlet_<id>.*  one schema + one LOGIN ROLE per outlet
```

- Boot **refuses** an install that does not name `CONTROL_DB` (`registryNamed()`);
  the registry self-creates when named-but-absent.
- Outlet ids allocate globally from the registry; every outlet is registered in
  `chain.outlet_directory`.
- Handles (store subdomains) are owned by the registry: shape rules, reserved
  names (`www api mail send track demo app panel …`), rename + 301 history.

## Isolation — two belts plus a door policy

1. **Schema + login role per outlet.** Password derived
   `hmac(OUTLET_ROLE_SECRET, "outlet:"+id)`, never stored. `search_path` pinned,
   PUBLIC revoked. Migration 039 / control 003 revoke PUBLIC `CONNECT` on every
   database ("a database is not a lobby").
2. **FORCE ROW LEVEL SECURITY** on `chain.*`, policies reading transaction-scoped
   `SET LOCAL app.outlet_id/user_rank/actor/scope/device`.
3. **Owner-connection exceptions are a pinned list of six** (+ platform door),
   asserted in `test/wiring.test.js`. `ownerForOutlet()` resolves the *database*
   through the registry; `owner()` alone is never an address.

`src/scripts/leak-test.js` makes 13 cross-outlet + cross-business attempts and
runs inside `test/api.test.js` every CI run.

## Request path

```
server.js  → security headers (CSP hash-allowlisted inline, HSTS, nosniff…)
           → host routing (handle subdomain → guest portal; app host → till)
           → src/limit.js token buckets on the open doors
           → routers: auth · account · onboarding · outlet · sync · guest ·
                      estate · doc · pages · platform
           → src/revoked.js (session/device revocation, 30 s positive cache)
           → withOutlet()/withOutletRead(): pool keyed <db>#<outlet>, SET LOCAL
             context incl. outlet TZ, checked COMMIT
```

~127 HTTP endpoints total (route-file counts: auth 16, outlet 15, guest 13,
account 14, onboarding 19, pages 16, sync 3, platform 3, doc 2, estate 1,
server 6, panel 15, site 4).

## The write path (offline-first)

Every terminal mutation goes through **one seam** `queue(kind, label, entity,
payload)` → durable IndexedDB outbox → `POST /sync/push`. Server applies each op
in its own savepoint, chunked 25/transaction; `op_log.op_id` PK +
`ON CONFLICT DO NOTHING` makes replay a no-op. **118 handled kinds + 35 named
audit-only = 153**; the wiring test asserts queued ∪ handled ∪ audit-only match.
Lamport clock is monotonic, persisted, and *received* (`seen()`); tiebreak is
batch order. Install uuid fences one install's outbox from another. Eighth
refusal parks the op (dead-letter lane with human-readable reason, resend or
discard-with-audit).

Reads: bootstrap (`buildState`) on sign-in / material push / 5-min timer;
`buildLive` slice every 5 s (whole floor + today's takings incrementally,
clock_timestamp window with 5 s overlap, merge by id).

## Money

`applySale()` writes sale, lines, tenders, WAC stock moves, and the full
journal in ONE transaction. Deferred constraint trigger refuses unbalanced
journals (collapsed per-op in sync). Server recomputes tax (vs the outlet's own
effective-dated `chain.tax_version`), re-values sale stock moves at WAC,
re-derives consumed quantities from the outlet's own recipes/yields
(12-level bounded recursion), repairs-and-flags rather than rejects
(`server_audit.*`). Points are a liability (2350), tips held on 2450, credit
outstanding on `chain.member.credit_used`. Eleven till-owned accounts refuse
manual journals. GST is exclusive; registration is a company fact with DB-level
invariants (`company_tin_iff_registered`, outlet/tax-version guards).

## Ops surface

- `/healthz`, `/readyz` (per-outlet login-role probe, fail-slow/recover-fast),
  `/metrics` (Prometheus, gated by `METRICS_KEY`)
- `src/watch.js`: 4 alert conditions (readiness, schema drift, quiet writing
  devices, stale backups), transition-edge alerts via `src/email.js`
- `src/backup.js`: pg_dump per business → file or S3 (SigV4 hand-signed),
  registry-recorded, restore-beside with `--adopt`; drill in `test/backup.test.js`
- Migrations at boot under a session advisory lock; fleet runner
  `npm run migrate` (registry then businesses, 4-way concurrency);
  `requireAtHead()` 503s a business behind head
- Retention: `chain.prune_history` daily (op_log 90 d, guest_request 30 d,
  audit never pruned)

## Dangerous scripts and their fences

`reset:database` and `seed:demo` both require the literal
`yes-i-mean-it` env confirm AND refuse when `RAILWAY_ENVIRONMENT_NAME` is
`production`; seed additionally refuses a non-empty install. Verified by
reading the guards, and seed writes through the real handlers only.

## Known documented drift

CLAUDE.md says "115 op kinds" and "the fourteen-step panel"; the code has 118
handlers/153 kinds and 13 onboarding steps. The handoff package's
`03-THE-CHAIN.md` describes tax-inclusive pricing; shipped arithmetic is
exclusive (tests pin it). The tests, not the prose, are authoritative.
