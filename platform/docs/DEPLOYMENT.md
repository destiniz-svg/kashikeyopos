# KashikeyoPOS — hosting and data isolation

## What isolation means here

You asked for two things that are usually alternatives, so this build does both
and treats them as separate belts.

**Belt one — an outlet's data is in its own database schema, reached by its own
database login.** Outlet 3 lives in schema `outlet_3` and the server connects to
it as role `outlet_3_app`. That role was granted `USAGE` on `outlet_3` and
nothing else. Outlet 4's tables are not merely filtered out for that connection;
they are unreachable objects. There is no query, no forgotten `WHERE` clause and
no injected string that reaches them, because the privilege was never granted.

**Belt two — row-level security on the shared control plane.** Identity, the
outlet registry, devices, tax versions, document series and the audit trail have
to be shared to be useful. Those tables have RLS enabled *and* `FORCE ROW LEVEL
SECURITY`, so even a table owner obeys the policies. Every policy resolves
against `app.current_outlet()` and `app.current_rank()`, which are read from
transaction-local settings.

Request context is set with `set_config(..., true)` — transaction-local. It dies
at `COMMIT`. A pooled connection physically cannot carry one outlet's context
into the next request, which is the classic RLS leak in a Node app.

### Why per-outlet roles and not one app role

One app role plus RLS is a single mistake away from a leak: a policy that was
never added to a new table, a `SECURITY DEFINER` function that forgot its check,
a superuser connection string in the wrong variable. Per-outlet roles make the
blast radius of any such mistake one outlet.

### Credentials are derived, never stored

A per-outlet role's password is `hmac_sha256(OUTLET_ROLE_SECRET, "outlet:" + id)`.
Nothing in the database holds it, so reading every row of every table in outlet
3 still yields no way to authenticate as outlet 4. Rotate by changing
`OUTLET_ROLE_SECRET` and re-running provisioning for each outlet.

### The one deliberate exception

An owner needs an estate view. `chain.estate_day()` is `SECURITY DEFINER`, runs
only when `app.group_scope()` is true — which itself requires rank 5 — returns
aggregates only (never rows), is reached through a read-only role
(`kashikeyo_report`) that has `EXECUTE` on that function and no table grants at
all, and is stamped in `chain.audit` with `scope = 'group'`. Cross-outlet access
is one function, auditable, and cannot return a receipt.

## Deploy on Railway

1. **New project → Provision Postgres.** Railway sets `DATABASE_URL` on the
   service. That connection is the owner: migrations and provisioning only, and
   `src/routes.js` never imports it.

2. **New service from this repo**, root directory `platform` — NOT `backend`.
   `platform/railway.json` selects `platform/Dockerfile`, which sets `/readyz`
   as the healthcheck, so a deploy that cannot see its database never goes live.

   The root directory matters and is not a preference. `backend/src/sale.js`
   requires `../../packages/money/money`, because there is exactly ONE bill
   calculation in this system and both the browser and the server load the same
   file. A build context of `backend/` alone cannot see it and the container
   dies on the first require. `backend/test/deployable.test.js` builds the tree
   the Dockerfile builds and loads the server out of it, so this cannot regress
   quietly again.

3. **Variables** — copy from `.env.example`:

   | Variable | Notes |
   |---|---|
   | `DATABASE_URL` | referenced from the Postgres plugin |
   | `PGHOST` `PGPORT` `PGDATABASE` | same instance; the server rewrites user + password per outlet |
   | `OUTLET_ROLE_SECRET` | 32+ chars. Derives every outlet role password. |
   | `SESSION_SECRET` | 32+ chars, separate from the above |
   | `REPORT_ROLE_PASSWORD` | the read-only consolidation role |
   | `ALLOWED_ORIGINS` | the POS and guest portal origins, comma separated |
   | `SESSION_TTL_HOURS` | 12 suits a double shift |

4. **Migrate — before the first deploy can pass its healthcheck.** The server
   does **not** migrate on boot: `/readyz` asks `chain.outlet` a question and
   answers 503 until the schema is there, so a service deployed against an
   un-migrated database starts, listens, and never goes healthy. That is
   deliberate — a deploy that cannot see its data should not take traffic — but
   it means this step is a step, not a side effect of booting.

   It is idempotent (the whole directory runs every time; `deployable.test.js`
   proves running it twice is safe), so run it again on every release:
   ```
   railway run npm run migrate
   ```

5. **Provision each outlet.** One command per site:
   ```
   railway run npm run provision:outlet -- 3 MAL-01 "Kashikeyo Malé"
   railway run npm run provision:outlet -- 4 HUL-01 "Kashikeyo Hulhumalé"
   ```
   Each creates the schema, the login role, the document series and the chart of
   accounts.

6. **Seed the ladder** (ranks: 1 Kitchen, 2 Till, 3 Manager, 4 Admin, 5 Owner):
   ```
   railway run node scripts/seed-staff.js 3 "Aishath" 4 4821
   ```

7. **Prove isolation before you take a real order:**
   ```
   railway run npm run leak-test -- 3 4
   ```
   Twenty-four attempts to cross the boundary — direct reads of another outlet's
   sales, tickets and ledger, catalogue probing, RLS on staff and audit, forged
   group scope, a claimed outlet id in the context, attempts to rewrite or
   delete the audit trail, erasing a closed sale, and a DDL escalation. Each
   probe runs in its OWN transaction against planted bait; "current transaction
   is aborted" counts against the suite rather than passing as a refusal. Any
   `LEAK` line and the run exits non-zero. Put it in the deploy pipeline.

8. **Host the front-ends.** They are Vite apps that build to static files —
   `apps/pos` (the till and the back office) and `apps/guest` (the QR portal).
   Deploy each as its own Railway static site, or to any CDN.

   Build each one with the API's public origin baked in:

   ```
   VITE_API_ORIGIN=https://api.kashikeyo.mv npm -w @kashikeyo/pos run build
   ```

   `VITE_API_ORIGIN` is read in exactly one place — `apps/pos/src/api.ts` — and
   every screen calls the API through `api.authed(session)`. A screen that
   writes its own `fetch('/api/...')` works on a laptop and only on a laptop:
   the Vite dev and preview servers proxy `/api`, so the absolute path resolves
   there and 404s the moment the app is served from its own origin. Eleven
   screens did exactly that. `deployable.test.js` now fails the build if the
   literal `/api/` appears anywhere in `apps/pos/src` outside `api.ts`.

   **Keep the till and the guest portal on different origins**, and list both in
   `ALLOWED_ORIGINS`, so a guest phone's origin is never allowed to call a till
   endpoint. With `ALLOWED_ORIGINS` unset the server allows any origin, which is
   right for local development and wrong everywhere else — set it.

   A terminal names its outlet at install time, not at sign-in: `?o=3` on the
   URL, or `VITE_OUTLET_ID` baked into that terminal's build. A till that can be
   pointed at another branch is a till that can ring a sale into the wrong books.

## Things the server refuses

- A receipt number minted anywhere but `chain.next_doc_no()`, under a row lock.
- A journal that does not balance — a deferred constraint trigger rejects it at
  `COMMIT`, so the two legs may be inserted in either order but never survive
  alone.
- `DELETE` on `sale`, `sale_line`, `payment`, `journal`, `journal_line` or
  `op_log`. A closed sale is corrected with a credit note, never erased.
- Reopening a closed ticket on replay: the update is guarded by
  `status <> 'closed'`.
- Two open tickets on the same table and split — a partial unique index.
- A sale whose parts do not add up to its total — a check constraint.
- A request naming an outlet other than the one in its session token.
- A database error message reaching a client: they name schemas and roles.

## Operating notes

- **Backups.** Railway's Postgres backups cover the instance. Because outlets are
  schemas, a single-outlet restore is `pg_dump -n outlet_3`, which is the
  restore you will actually be asked for.
- **When one outlet outgrows the instance,** move its schema to its own Railway
  Postgres and give that outlet's entry in `chain.outlet` a different host. The
  application already opens a separate pool per outlet, so nothing else changes.
- **Edge box.** The same Dockerfile runs on the in-restaurant machine so service
  survives an internet outage; it replays through `/sync/push` on reconnect.
- **Scaling replicas.** Pools are per replica; raise `PGPOOL_MAX` only alongside
  Postgres `max_connections`. Two replicas × six pools × outlets adds up fast.
