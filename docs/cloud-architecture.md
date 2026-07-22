# How modern cloud POS is built — and where KashikeyoPOS sits

A consolidated research note behind the prototype→production upgrade. It answers
one question honestly: *is KashikeyoPOS built the way a modern, cloud-native POS
is built in 2026, and where are the gaps?* It grounds every claim in this repo's
actual code (`index.js`, `inventory.js`, `schema.sql`, `web/dist`, the `docs/`)
and compares against how Toast, Square, Lightspeed, and the newer agentic POS
(AgenticPOS) are architected publicly.

The short version: the **hard parts are already right** — offline-first sync,
server-authoritative money, Postgres row-level-security multi-tenancy, and
pooler-safe scaling. The gaps are at the edges: HA/PITR posture, observability,
and pushing the AI layer from "assist" to "act."

---

## 1. The reference architecture of a modern cloud POS

Every serious cloud POS converges on the same five layers. They differ in
implementation, not in shape.

| Layer | What it must do | Industry pattern |
| --- | --- | --- |
| **Edge / device** | Keep selling with no internet; instant UI | Offline-first cache (IndexedDB/SQLite) + background sync |
| **Sync** | Reconcile many devices → one truth, idempotently | Append-only ops log + monotonic cursor; last-writer-wins or CRDT |
| **Tenant data** | Isolate thousands of merchants safely | Row-level security or schema-per-tenant on Postgres |
| **Money & tax** | Never trust the client for totals | Server-authoritative pricing; integer minor units; append-only ledger |
| **Intelligence** | Turn the data into decisions | Analytics → alerts → (increasingly) agentic actions |

The two failure modes that separate a real POS from a demo: (1) it **breaks when
the wifi drops** — fatal in a café, fatal on a Maldivian island; and (2) it
**trusts the browser for the price** — fatal for tax compliance and fraud. A
modern build treats both as non-negotiable. KashikeyoPOS does.

---

## 2. Offline-first sync — the core

**How the modern ones do it.** Toast and Square run the terminal as the source
of truth locally: the sale commits to on-device storage first, the UI updates
optimistically, and a background engine replays operations to the cloud with
idempotency keys so a retry never double-charges. Conflict handling is usually
last-writer-wins on a per-field basis, with money computed server-side so
conflicting edits can't corrupt a total. Square publishes this as its "offline
mode"; Toast's terminals are famously able to run a full dinner service with the
ISP down.

**How KashikeyoPOS does it** (`docs/offline-first-transaction-path.md`, `index.js`):

- **Entities table as a sync log.** `entities(org_id, kind, id, data JSONB,
  deleted, rowver BIGSERIAL)`. Every business object (products, sales, orders,
  customers, payments…) is a row. `rowver` is a global monotonic cursor per
  Postgres sequence.
- **Push:** `POST /api/ops` takes idempotent `opId` batches; the `ops` table
  records applied `opId`s so a replayed batch is a no-op (exactly-once effect
  over an at-least-once network).
- **Pull:** `GET /api/pull?since=<rowver>` returns every row with a higher
  rowver — **including tombstones** (`deleted=true`) so clients can remove
  locally. A device that was offline for a week catches up in one request.
- **Realtime nudge:** SSE `GET /api/events` over Postgres `LISTEN/NOTIFY` fans a
  `poke(orgId, rowver)` to every connected till across every app instance, so
  "new order" lands on the kitchen screen in ~a second without polling.
- **The offline safety net today:** because the till is a prebuilt minified
  bundle, `web/dist/offline-bridge.js` intercepts failed `POST /api/ops` /
  guest-order writes, queues them in IndexedDB, returns a synthetic success so
  the cashier keeps going, and replays on reconnect + every 15 s.

**Verdict.** This is the same shape as Square/Toast: local-first, idempotent
replay, monotonic pull cursor, tombstones, realtime fan-out. The one honest
caveat is conflict semantics — KashikeyoPOS is **last-writer-wins at the entity
level**, not per-field or CRDT. For a POS this is the right trade (two cashiers
rarely edit the same open bill field simultaneously, and money is server-owned
so it can't be corrupted), but it's the place a future "proper frontend rebuild"
(`frontend/offline/*` modules are already stubbed for it) would tighten.

---

## 3. Multi-tenancy & security — Postgres RLS

**The industry split.** Two dominant patterns: *schema/database-per-tenant*
(strong isolation, operationally heavy at thousands of tenants) and
*shared-schema with row-level security* (one schema, a policy on every table).
Modern SaaS on Postgres (including Supabase's whole model) leans on **RLS** — it
pushes the tenant boundary *into the database engine* so a missing `WHERE
org_id=` in application code can't leak data.

**How KashikeyoPOS does it** (`schema.sql`, `index.js`):

- **FORCE RLS on every tenant table.** `tenant_isolation` policies gate reads and
  writes on `org_id = current_setting('app.org_id')`.
- **The teeth:** RLS is bypassed by table owners and superusers. So request
  handling runs as a **separate restricted role** (`kashikeyo_app`) with only
  `SELECT/INSERT/UPDATE/DELETE` — never the owner — so Postgres itself enforces
  isolation. `bootPool` (owner) is used *only* for migrations/DDL.
- **Transaction-scoped scope:** `withScope()` wraps `BEGIN … set_config('app.org_id',
  $1, true) … COMMIT`. The `true` makes the setting **transaction-local**, which
  is what makes it safe behind a connection pooler (see §4).
- **Append-only audit:** `activity_log` is granted `INSERT + SELECT` only — even
  the app role can't rewrite or delete the trail (FIN-03). The money endpoints
  are server-authoritative (FIN-01–04): the client proposes a cart, the server
  computes GST-inclusive totals, service charge, and loyalty in **laari**
  (MVR×100 integer) so there's no float drift and no client-set price.

**Verdict.** This is a textbook-correct RLS multi-tenant design — arguably
stronger than many funded startups, which enforce tenancy only in application
code. The restricted-role-plus-FORCE-RLS combination is the detail most teams
miss.

---

## 4. Scaling & cost — pooling, Railway, HA

**The pattern.** Serverless/pooled Postgres is how you serve many tenants
cheaply: a **transaction-mode pooler (PgBouncer)** multiplexes thousands of
client connections onto ~20 real server connections. The catch that bites
everyone: session-scoped state (advisory locks, `LISTEN`, prepared statements)
breaks in transaction mode because the pooler reassigns the backend between
statements.

**How KashikeyoPOS does it** (`docs/scaling-and-pooling.md`, P0):

- Three connection roles, correctly separated: `bootPool` (**direct** — schema,
  DDL, boot advisory lock), request `pool` (**pooled** — every `/api/*`, safe
  because queries are transaction-local), poke `Client` (**direct** — the
  long-lived `LISTEN`).
- `DATABASE_URL` = pooled endpoint, `DIRECT_DATABASE_URL` = direct `:5432`;
  **falls back to the single URL when unset**, so nothing changes until a pooler
  is actually added. `PG_POOL_MAX` caps per-instance fan-out.
- Deploy is a Dockerfile on Railway → `npm start`; one small instance can carry
  many tills, and the design scales *out* (more app replicas behind the pooler)
  rather than *up*.

**Gaps to close (honest).** This is cost-efficient but not yet
high-availability. The doc already prescribes the next step: Railway one-click HA
(Patroni) with in-region replicas + point-in-time recovery, PgBouncer in front of
the HA primary, and rolling app deploys. Until that's on, a Postgres node loss is
downtime, not a failover. That's the single biggest production-readiness gap and
it's a config/ops change, not a code rewrite.

---

## 5. The intelligence layer — from analytics to agentic

This is where the market moved in 2024–2026, and where the upgrade deliberately
aimed.

- **Lightspeed** ships *menu engineering* (the Kasavana-Smith "Magic Quadrant":
  popularity × contribution margin → Stars / Plowhorses / Puzzles / Dogs) and
  live food-cost / price-fluctuation alerts. → KashikeyoPOS **P6** implements the
  same quadrant deterministically from `stock_moves`, plus KPIs-vs-previous and a
  guided plain-language read, all AI-key-free.
- **AgenticPOS** pitches "run your restaurant in plain English" — the model takes
  an instruction and *acts*. → KashikeyoPOS **P7** does this with a **two-phase
  guarded** pattern: `/agent/interpret` (Claude structured-output → one concrete
  action resolved against *this store's own* catalogue — the model never writes),
  a confirm-diff, then `/agent/execute` (86/hide/reprice; RLS-scoped;
  audit-logged). This is the safety posture serious agentic systems need and many
  demos skip.
- **Autonomous procurement.** Modern inventory systems learn velocity and draft
  purchase orders. → **P4** turns the velocity reorder list into draft POs grouped
  by each ingredient's *learned* usual supplier (from purchase history, zero data
  entry).
- **Grounded assistant + structured vision.** The Menu Builder (**P2**) and OCR
  delivery-notes (**§13**) use Claude with JSON-schema structured outputs and
  **degrade gracefully** without a key (`configured:false`) — the deterministic
  insights, reorder, and accounting all work with no model at all.

**Design principle that matters:** the model **proposes**, the server
**disposes**. Targets are resolved server-side, actions are diffed and confirmed,
everything lands in the append-only log. That's the difference between an agent
you can put in front of real money and a party trick.

---

## 6. The Maldives context (why some choices differ)

A generic cloud POS is tuned for always-on urban connectivity. KashikeyoPOS is
tuned for a different reality and it shows in the architecture:

- **Connectivity is intermittent** across atolls → offline-first isn't a feature,
  it's the baseline; the sync engine and the IndexedDB bridge are load-bearing.
- **Tax is MIRA GST**, tax-inclusive, sector-specific (GGST 8% / TGST 16%) + 10%
  dine-in service charge → computed server-side in integer laari, never client-set.
- **Bilingual EN + Dhivehi (RTL)** is a first-class data concern → `dv`,
  `descDv`, `tags[]` already flow through boot + pull (P1 data layer).
- **Multi-store across islands** → per-`store_id` scoping on entities and
  stock_moves, one org spanning outlets (`docs/multi-store-architecture.md`).

---

## 7. Scorecard

| Capability | Modern-cloud bar | KashikeyoPOS | Gap |
| --- | --- | --- | --- |
| Offline-first selling | Required | ✅ ops/pull/rowver + IndexedDB bridge | Per-field/CRDT conflict merge (has entity-level LWW) |
| Idempotent sync | Required | ✅ `opId` + `ops` table | — |
| Realtime multi-device | Expected | ✅ SSE over LISTEN/NOTIFY | — |
| Tenant isolation | RLS or schema/tenant | ✅ FORCE RLS + restricted role | — |
| Server-authoritative money | Required | ✅ laari, GST, append-only ledger | — |
| Cost-efficient scale | Pooler | ✅ transaction-pooler-safe | Turn PgBouncer on in Railway |
| High availability | Replicas + PITR | ⚠️ single primary | HA/Patroni (config, not code) |
| Observability | Metrics/traces/alerts | ⚠️ health + activity_log | Add metrics + error tracking |
| Menu engineering | Table-stakes (Lightspeed) | ✅ P6 quadrant | — |
| Agentic actions | Emerging (AgenticPOS) | ✅ P7 guarded two-phase | Broaden action catalogue |
| Autonomous procurement | Emerging | ✅ P4 auto-PO | — |

**Bottom line.** The foundation is built the way a modern cloud POS should be
built — the offline, tenancy, money, and scaling cores are correct and, in the
tenancy/agent-safety details, ahead of typical. The remaining work is
**operational hardening** (HA + PITR + observability) and **breadth** (wider
agent actions, per-field conflict merge if a native frontend is rebuilt), not a
re-architecture.

---

## 8. Recommended next investments (priority order)

1. **HA + PITR** — Railway Patroni + PgBouncer in front; rolling deploys. Removes
   the one true single-point-of-failure. *(ops/config)*
2. **Observability** — request metrics, error tracking (e.g. Sentry), and alerts
   on sync backlog / boot failures. You can't operate what you can't see.
3. **Turn the pooler on** — the code is ready; flip `DATABASE_URL` /
   `DIRECT_DATABASE_URL` and cap `PG_POOL_MAX`. Immediate cost/scale win.
4. **Push AI from assist → act** — widen P7's action catalogue (bulk 86 by
   ingredient shortage, scheduled price changes) on the same guarded rails.
5. **Native frontend rebuild (long-term)** — replace the minified till so
   offline logic, per-field conflict merge, and bilingual tile rendering live in
   clean source instead of bundle patches.
