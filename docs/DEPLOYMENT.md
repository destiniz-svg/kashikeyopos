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

   Railway's Postgres template currently ships **Postgres 18**. The suite runs
   against 16, and the staging deploy migrates and runs clean on 18, but those
   are not the same statement — if you are ever chasing a database-level oddity
   that will not reproduce locally, check the version before anything else.

2. **New service from this repo**, root directory left at the **repository
   root** (the default) — NOT `backend`.

   **Check which branch the first build actually used.** Creating the service
   from a branch pushed minutes earlier silently built the repository's DEFAULT
   branch instead: the service config said the right branch, and the build was
   of something else entirely. The giveaway is in the deploy log — the wrong
   branch boots a different application with a different package name. Railway's
   own deployment record names the branch and commit, so check it there rather
   than trusting the service config, and redeploy once the integration has seen
   the branch. `railway.json` selects the root
   `Dockerfile`, which sets `/readyz` as the healthcheck, so a deploy that
   cannot see its database never goes live.

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
   | `ANTHROPIC_API_KEY` | **optional, and unset in this build.** One thing needs it: writing menu copy on the AI Menu Builder. Everything else on that screen is arithmetic over your own menu and your own sales, so the module is fully usable without a key and says by name what is missing. `AIMENU_MODEL` overrides the model. |

   Setting `ANTHROPIC_API_KEY` turns on the only call this application makes to
   an outside service, and it is billed per call. The request path exists and is
   reviewed but has never run against the live API here, because no key has ever
   been configured — so the day you set one, ask for a description on one real
   dish before telling anybody the feature is on. The not-configured path is the
   one the test suite covers.

4. **Migrating is automatic, and this step is a fallback.** The image's command
   is `npm run migrate && node server.js`, so every container migrates before it
   serves. The *server* does not migrate — `server.js` never touches the
   migration directory — which is what makes the distinction worth stating: run
   `node server.js` directly, as the edge box and a local checkout do, and you
   get an un-migrated database.

   The first deploy of this build showed it working: all 36 migrations logged
   `ok` and `migrations complete` before `kashikeyo-server listening on 8080`,
   and the healthcheck passed first try.

   That leaves `/readyz` as the guard rather than the mechanism. It asks
   `chain.outlet` a question and answers 503 until the schema is there, so a
   container whose migration failed never goes healthy and never takes traffic.

   Migrating is idempotent — the whole directory runs on every boot and
   `deployable.test.js` proves running it twice is safe — so you rarely need to
   run it by hand. When you do (a migration that failed and needs re-running
   without a redeploy, or a database restored from backup):
   ```
   railway run npm run migrate
   ```

   > This step used to say the opposite — that the server does not migrate on
   > boot and that migrating was a required manual step. It was written before
   > the Dockerfile took the job and was never corrected, so anyone following it
   > would have gone looking for a broken deploy that was in fact fine.

5. **Provision each outlet.** Every command in this step and the next assumes a
   shell against the running environment. A deploy driven from a browser has no
   shell, and without one the system comes up correct, healthy and impossible to
   sign into — which is exactly what happened on this build's first deploy. For
   that case set two variables instead and redeploy; `scripts/bootstrap.js` runs
   from the image's start command, after migrations:

   ```
   BOOTSTRAP_OUTLET="1:SEP-01:Sephora Café"
   BOOTSTRAP_OWNER="Owner:4821"
   ```

   It is safe on every boot: provisioning is idempotent, and the owner is seeded
   ONLY into an outlet with no staff at all, so a redeploy cannot duplicate a PIN
   or add a second sign-in beside a real one. That same condition is the way back
   in if every account with access is ever lost — empty the outlet's staff and
   redeploy. It bootstraps ONE outlet; a second site uses the commands below, and
   the leak test needs two.

   With a shell, one command per site:
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
   is aborted" counts against the suite rather than passing as a refusal, and so
   does "relation … does not exist" — a probe aimed at an outlet that was never
   provisioned proves nothing, and reporting "no leaks" for it is exactly the
   false green this suite exists to avoid. So run step 5 for BOTH outlet ids
   first. Any `LEAK` or `BROKEN` line and the run exits non-zero. Put it in the
   deploy pipeline.

8. **Host the front-ends.** They are Vite apps that build to static files —
   `apps/pos` (the till and the back office), `apps/guest` (the QR portal) and
   `apps/member` (the loyalty portal). Deploy each as its own Railway static
   site, or to any CDN.

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

   **Keep all three on different origins**, and list each in `ALLOWED_ORIGINS`,
   so a guest phone's origin is never allowed to call a till endpoint. The
   member portal is a third one: it is reached by a link rather than a QR card,
   it holds an identified session, and it belongs to no outlet — its API is
   `/api/member/*`, which no outlet token opens and which opens no outlet
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
