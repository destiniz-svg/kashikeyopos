# Deploying KashikeyoPOS

Everything here is the deploy path a real change takes. Nothing in it is
optional, and the order matters in two places, which are marked.

## What runs

One service and one Postgres. The service builds from `Dockerfile` (no build
step — the app is hand-written HTML served from disk), starts with `npm start`,
and Railway health-checks `/readyz`.

- `/healthz` — the process is up. Returns **503** naming the fault if a
  migration did not finish.
- `/readyz` — the process is up **and the control plane answers**. This is the
  health check, so a container that cannot see its database never takes
  traffic.

## Environment

Copy `.env.example`. Every variable there is required except the ones marked
optional. Three of them deserve saying twice:

| Variable | What breaks without it |
|---|---|
| `OUTLET_ROLE_SECRET` | Every outlet's database password is derived from it. Nothing can connect. |
| `SESSION_SECRET` | No staff session can be minted or verified. |
| `PORTAL_SECRET` | No QR table token and no member token. |

They are **three separate values on purpose**: a leak of one must not mint the
others. In particular a stolen session secret can forge a session but cannot
open a database connection, because the database password is derived from a
secret the web tier holds and never sends anywhere.

They must also be **different values per environment**. Staging and production
sharing a secret means a staging token opens production.

### TLS to the database

| Variable | What it does |
|---|---|
| `PGSSL` | `1`/`true`/`require` turns TLS on (it is on anyway in production when `DATABASE_URL` is set). `verify` REFUSES to boot unless a CA is pinned. |
| `PGSSL_CA` | The database CA certificate, as PEM, pasted into the variable. When set, the server's certificate is **verified** — a man-in-the-middle gets a refusal, not the books. |
| `PGSSLROOTCERT` | The same CA, as a file path, for platforms that mount certificates. |

With TLS on and **no** CA pinned, the link is encrypted but the server is
unauthenticated (`rejectUnauthorized: false`) and the boot log says so.
Railway's managed Postgres signs with its own self-signed CA — copy the
certificate from the database service's Connect tab into `PGSSL_CA`, then set
`PGSSL=verify` so losing the variable later fails loudly instead of quietly
degrading back to unauthenticated.

### The domain stores hang off

| Variable | What it does |
|---|---|
| `PORTAL_BASE_DOMAIN` | The domain every store's subdomain hangs off — `kashikeyopos.com`. A leading `*.` is accepted and stripped. |
| `PUBLIC_URL` | The apex, used for OAuth callbacks — and as the fallback base domain, so a normal deploy sets one variable rather than two. |

Every store answers on `https://<handle>.<base>`, so the DNS record and the
platform's own certificate have to cover `*.<base>` as well as the apex. On
Railway that is a second custom domain (`*.kashikeyopos.com`) on the same
service; the app needs no per-store configuration and provisioning a store
creates no DNS.

Set `PORTAL_BASE_DOMAIN` **empty** to turn store subdomains off deliberately —
which is not the same as leaving it unset. An environment whose apex has no
wildcard record (a staging box on a vendor domain) would otherwise inherit that
apex from `PUBLIC_URL` and start printing `https://<handle>.<cannot-resolve>` on
QR cards.

Off — empty, or unset with no `PUBLIC_URL`, as in local development — host
routing switches off and every store link falls back to its path form
(`/g/<handle>`). A link that is merely long is followable; a link on a hostname
that does not resolve is not.

## First deploy, onto an empty cluster

This is the ordinary path, and the one to take unless an existing install holds
customer data. **An install with no company holds nothing worth adopting** —
its own boot log says `[install] no company yet — onboarding is open` — so
starting clean is simpler and skips the one irreversible step in this document.

1. **Set the environment variables**, including `CONTROL_DB=kashikeyo_control`.
   Do this **before** the first boot: the service refuses to migrate without
   the secrets, and in production it exits rather than serving on a half-built
   schema. The database user needs `CREATEDB` — signing up creates a database.
2. **Deploy.** Boot creates the registry if it is not there — the name is
   given, never guessed, so it can only make the one you asked for — migrates
   it, then migrates every business database it lists, of which there are none
   on a first deploy. Migrations run in name order, exactly once each
   (`chain.migration` is the ledger, per database). A migration whose contents
   changed is re-applied, which is why every one here is idempotent.
3. **Sign up on the website.** Confirm the email, and a database is created for
   that business. No seller is in the loop and no infrastructure is provisioned
   per customer.
4. **Work the fourteen steps.** The last one hands you the floor, signed in as
   the owner, with a PIN you set. **Write that PIN down before you close the
   tab.**

There is no seed data and no demo. A new business has no outlets, no dishes, no
staff and no PIN until onboarding writes them.

### There is no "without a registry"

This section used to say that leaving `CONTROL_DB` unset gave you the app as it
always was — one database, one business, onboarding on first boot. **That has
not been true since outlet ids and store addresses moved to the registry**, and
nothing caught it because every test suite names a registry of its own.

What actually happened was worse than a refusal: the app booted, answered
`/readyz` 200, served the onboarding panel and accepted step 1, then threw
`CONTROL_DB is not set` four calls deep inside `provisionOutlet()` and returned
a bare 500. The same throw sits behind `handle_points_at()`, so a store that
somehow existed would have a dead guest portal, and behind the handle check and
rename on the outlet route. An install that can record a company and never an
outlet is not a single-database install; it is a half-configured one that looks
fine until somebody tries to trade.

So the app now **says so at boot** and, in production, exits. The cost is one
variable — the database itself need not exist, because the next boot creates
it:

```
CONTROL_DB=kashikeyo_control
```

No default is picked. `control()` refuses to guess for the same reason it
always did: a guess would make a business's own database its registry on a
misconfigured deploy, with the accounts landing in the wrong place and nothing
saying so until two customers had signed up.

## Moving a live install onto the registry

**Only for an install that has data.** If its boot log says `no company yet`,
there is nothing here for it — delete it, or point it at a registry and let
somebody sign up. Adoption rewrites primary keys on live data, and running it
for nothing is all risk and no gain.

**Do this BEFORE the new code reaches that install.** Migration 011 is now a
tombstone: it drops `chain.account`, `chain.account_identity` and
`chain.account_outlet`, because the account plane moved to the registry. If the
app boots there first, those tables are gone and with them the only record of
who owns the business. `npm run adopt` copies them out while they are still
there, and refuses to pretend otherwise if it arrives too late.

```bash
# 1 · the registry, once for the whole estate
createdb kashikeyo_control
CONTROL_DB=kashikeyo_control npm run migrate        # migrates the registry, then the fleet

# 2 · look at what adoption WOULD do. This is the default; it writes nothing.
CONTROL_DB=kashikeyo_control npm run adopt -- --db kashikeyo_prod --name "Seaside Cafe"

# 3 · do it
CONTROL_DB=kashikeyo_control npm run adopt -- --db kashikeyo_prod --name "Seaside Cafe" --apply

# 4 · NOW set CONTROL_DB on the service and deploy. Its next boot migrates the
#     business set, and 011 drops the account tables step 3 already carried out.
```

Read the dry run before running step 3. Three things in it are worth stopping
for:

- **`REMAP outlet N -> M`.** Every install allocated outlets from 1, so two
  installs both have an outlet 1 and a session token would name two stores. The
  first install adopted keeps its ids; a later collision moves — the row, every
  reference to it, the schema and the login role, in one transaction. Nothing
  about the store changes except the number, but its terminals hold tokens
  naming the old one and will have to sign in again.
- **`! handle "x" cannot be claimed`.** Somebody else holds that address. It is
  never quietly changed, because the customer printed it on their table cards;
  settle it before that store goes live or its QR codes point at the wrong menu.
- **`accounts: GONE from this install`.** Step 4 happened before step 3. The
  owner will have to sign up again and be linked to the business by hand.

`npm run adopt` is idempotent: running it twice reports what is already
registered and changes nothing.

## Every deploy after that

`npm test` must pass **against a cold database**. CI does exactly this
(`.github/workflows/test.yml`: a fresh Postgres 16 service, `npm ci --omit=dev`,
`npm audit --omit=dev --audit-level=high`, `npm test`) because a suite that only
passes against a database somebody warmed up by hand is a suite that will pass
right up until the deploy.

Then: land the change, watch the deploy log for `[migrate]` lines, and confirm
`/readyz` is 200. If a migration failed, both health endpoints say so by name.

## Google and Apple sign-in

Both are wired. Neither is offered until its credentials are set — a provider
with nothing configured is not shown on the front door, because a button that
cannot work is worse than no button. `GET /api/account/providers` reports which
are on and, for the ones that are off, **which variable names are missing**
(never values). That is the only thing a half-configured install cannot tell you
from the outside.

The callback URLs are fixed:

```
https://kashikeyopos.com/api/account/oauth/google/callback
https://kashikeyopos.com/api/account/oauth/apple/callback
```

### Google

1. Google Cloud Console → **APIs & Services → Credentials → Create OAuth client
   ID → Web application**.
2. Add the Google callback URL above under **Authorised redirect URIs**. It must
   match byte for byte, including the scheme and no trailing slash.
3. Fill in the **OAuth consent screen** (External). Scopes are `openid email
   profile` — nothing sensitive, so no Google review is needed.
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### Apple

Apple is the fiddly one, and it is fiddly in a way that fails silently months
later. Read the whole list before starting.

1. **App ID** — Certificates, Identifiers & Profiles → Identifiers → App IDs.
   Create one if the business has none, and tick **Sign in with Apple**.
2. **Services ID** — Identifiers → Services IDs. This is what
   `APPLE_CLIENT_ID` must be (e.g. `com.kashikeyo.pos.web`). **The App ID will
   not work here** — the web flow rejects it. Tick Sign in with Apple, then
   **Configure**:
   - Primary App ID: the App ID from step 1
   - Domains: `kashikeyopos.com`
   - Return URLs: the Apple callback URL above
3. **Verify the domain.** Apple gives you
   `apple-developer-domain-association.txt` on that same screen and will not
   enable the Services ID until it can fetch it. Put it in **`app/well-known/`**
   and it answers at `/.well-known/apple-developer-domain-association.txt`
   (`express.static` ignores dotfiles, so `server.js` routes that path
   explicitly — see the note in that directory).
4. **Key** — Keys → new key → tick Sign in with Apple → download the `.p8`.
   **You can download it exactly once.** Note the Key ID beside it.
5. **Team ID** — top right of the developer portal, ten characters.
6. Set `APPLE_CLIENT_ID` (the *Services* ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID`
   and `APPLE_PRIVATE_KEY` (the whole contents of the `.p8`, `BEGIN`/`END`
   lines included — mangled newlines are repaired for you).

**Apple's "client secret" is not a secret.** It is a JWT signed ES256 with that
`.p8`, and Apple caps its lifetime at six months. `src/apple.js` mints it and
re-mints it before it ages out, so there is nothing to diarise. If you already
hold a pre-minted one, `APPLE_CLIENT_SECRET` still overrides — but then its
expiry is yours to remember, and the failure looks like `invalid_client` from
Apple's own page with nothing in the deploy log.

### What the app does with what comes back

An identity is matched on the provider's **subject**, never on the email: people
change their address at a provider, and matching on it would either lock them
out or hand them somebody else's business.

The address is still used to JOIN an existing account the first time — somebody
who signed up with a password and later taps *Continue with Google* means to
reach the same business — **but only when the provider says it verified that
address**. Unverified, the sign-in is refused by name and the person is told to
sign in the ordinary way, because an unverified address is a claim rather than a
fact and treating it as proof would walk a stranger into somebody's books.

## Removing the app that was here before

This build keeps everything it owns in `chain`, `app` and `outlet_<id>`, and
never reads or writes `public`. So it can be deployed onto a database that still
holds a previous app without deleting anything — the two share a database and
share no object, and the old data stays put as a free rollback until somebody
has confirmed the new site works.

Clearing it out afterwards is a separate, deliberate act:

```bash
DROP_LEGACY_PUBLIC=yes-i-mean-it npm run drop:legacy
```

There is no undo. Four guards stand in front of it:

1. `DROP_LEGACY_PUBLIC` must be exactly `yes-i-mean-it`.
2. It refuses unless `chain.outlet` exists — the proof that this database is
   this app's and `public` is somebody else's leftovers. Pointed at a database
   this app has never migrated, it would be deleting the only thing there.
3. It names every object and its row count **before** dropping anything, so the
   deploy log is the record of what was destroyed.
4. It drops **objects, not the schema**. An extension installed into `public` —
   `pgcrypto`, `uuid-ossp`, PostGIS — is not the old app's data and may well be
   holding this one up; `DROP SCHEMA public CASCADE` would take it too.
   Extension-owned objects are skipped and named in the log.

On a platform with no shell, run it as a one-shot pre-deploy command and
**disarm it afterwards** — both the command and the variable.

## Rotating `OUTLET_ROLE_SECRET`

**This order is not optional.** Changing the secret changes every outlet's
derived password, and until each role is told its new one, no outlet can be
reached.

```
1. set the new OUTLET_ROLE_SECRET on the service
2. deploy (the service comes up; outlet connections fail — expected)
3. npm run provision:outlet -- --all
4. confirm /readyz and open one outlet
```

Step 3 re-runs `chain.provision_outlet()` for every outlet, which ALTERs each
role's password to the freshly derived value and re-applies its grants. It is
idempotent, so it is also how you repair an outlet whose grants have drifted,
and how a new migration's function grants reach outlets provisioned before it.

Rotating `SESSION_SECRET` signs every staff session out. Rotating
`PORTAL_SECRET` invalidates every open QR table token and every member card
session; guests re-scan and members sign in again.

## Adding an outlet

From the cockpit — **Chain & Outlets**, rank 5 — so that it happens inside the
audit trail with a person's name on it. It creates the schema, the login role,
the document series, the chart of accounts and the outlet's own effective-dated
tax version in one transaction.

`npm run provision:outlet` deliberately cannot create one.

## Backups and restore

The database is the only state. The app writes nothing to disk at runtime;
the browser's own IndexedDB holds an outlet's un-replayed operations, which is
why a till keeps selling through an outage but is not a backup.

Take Postgres backups at the platform level and **restore-test them**, because
a backup nobody has restored is a hypothesis. A restore is:

```
1. restore the dump into a fresh database
2. point DATABASE_URL at it and boot with the SAME OUTLET_ROLE_SECRET
   (the roles are cluster-wide; a restore into a new cluster needs
    `npm run provision:outlet -- --all` to recreate them)
3. /readyz, then sign in and read a receipt you know the number of
```

**Step 3 is not optional.** Drilled: a `pg_dump` of one database carries no
roles, so restoring into a fresh cluster leaves `pg_restore` reporting a
non-zero exit and over a hundred failed GRANTs, and the app then boots, serves
the lock screen, and fails every outlet request with
`role "outlet_1_app" does not exist`. Sign in and read a receipt.

**`/readyz` now catches that**, which it did not when the drill was run — it
asked the OWNER connection whether the control plane answered, and the owner
connection bypasses both isolation belts, so it returned 200 on an install that
could not serve a single request. It checks out **each active outlet's own
login role** and reads a table in that outlet's own schema, which is the whole
path a real request takes: the derived password, the login, the pinned
`search_path` and the grants. An outlet it cannot reach is named in the 503,
with the command that fixes it. An install with **no outlets** stays ready —
that is a fresh install on its way to onboarding. A healthy answer is cached
for ten seconds (`READY_TTL_MS`); a failing one never is, so an install goes
green the moment `provision:outlet -- --all` is run, with no restart.

`npm run provision:outlet -- --all` closes it: the role password is derived
from `OUTLET_ROLE_SECRET`, so the same secret rebuilds the same credential and
re-applies the grants. Verified on a restored copy of a real store — sign-in,
bootstrap, `chain.licence`, 12 forced-RLS tables, 20 policies, no grant on the
account plane, `npm run leak-test` 13/13.

**The app takes no backups of its own and can restore none.** That is
deliberate and the Settings screens say so; the copies are the platform's.

## Rebuilding from nothing

To wipe an environment and start over — which is a real operation, not a
disaster-only one, because it is how a demo environment is reset:

```sql
-- every outlet's data plane, then the control plane, then the roles
DO $$ DECLARE s text; BEGIN
  FOR s IN SELECT schema_name FROM chain.outlet LOOP
    EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', s);
  END LOOP;
END $$;
DROP SCHEMA IF EXISTS chain CASCADE;
DROP SCHEMA IF EXISTS app CASCADE;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname ~ '^outlet_[0-9]+_app$' LOOP
    EXECUTE format('DROP OWNED BY %I', r.rolname);
    EXECUTE format('DROP ROLE IF EXISTS %I', r.rolname);
  END LOOP;
END $$;
```

Then redeploy. The service migrates from nothing and lands on `/onboarding`
again. `test/db.js` does the same thing on every test run, which is why the
path stays working.

### On a platform with no shell

`npm run reset:database` does exactly the above against `DATABASE_URL`, for a
host that hands you a connection string and no psql. It is the most dangerous
file in the repository, so it is guarded three ways:

- `RESET_DATABASE` must be exactly `yes-i-mean-it` — a flag that can be set by
  accident is not a guard;
- it REFUSES when `RAILWAY_ENVIRONMENT_NAME` is `production`, which the platform
  injects itself and a copied variable set cannot forge;
- it names the database, the host and every schema before dropping anything, so
  the log is a record of what was destroyed.

Run it as a **one-shot pre-deploy command**, never in the start path, and
REMOVE both the command and the variable the moment it has run — otherwise
every future deploy wipes the environment. The pre-deploy runs before the new
container starts, so the sequence in a single deploy is: wipe, then migrate
from nothing, then serve.

## The address map

```
kashikeyopos.com            the website — landing, docs, signup   (site/)
www.kashikeyopos.com        301 → kashikeyopos.com
app.kashikeyopos.com        the till, back office, /account       (PUBLIC_URL)
<handle>.kashikeyopos.com   one store's QR portal + member card   (wildcard)
panel.kashikeyopos.com      Mission Control                       (panel/)
```

The POS service sets `PUBLIC_URL=https://app.kashikeyopos.com` and
`PORTAL_BASE_DOMAIN=kashikeyopos.com` — the till's own host and the domain
stores hang off are different names now, so both are stated. The website
service sets `APP_URL=https://app.kashikeyopos.com` (where it forwards the
till's old apex paths) and `CANONICAL_HOST=kashikeyopos.com`.

## What limits throughput, and which knob moves it

One install is one Node process against one Postgres. A request holds a
connection for the whole of its transaction, so the concurrent-request ceiling
for an outlet is its pool size — `PGPOOL_MAX`, 12 by default. Past it,
`checkout()` refuses in `PGCHECKOUT_TIMEOUT` (8s) with a retryable 503 rather
than queueing for ever; the till treats that as a dead link, so nothing is
parked and the ops simply go again.

The other ceiling is deliberate. Receipt and journal numbers are allocated
under a row lock on the outlet's document series and held to COMMIT, which
serialises concurrent pushes to the same outlet. That is the price of gapless,
ordered document numbers — a tax return keyed on a sequence with holes in it is
worse than a slower push — so the mitigation is smaller batches (the till
already caps at 100 ops), not a redesign.

### Measured, on a development box

`node src/scripts/loadtest.js --url … --outlet 1 --pin … --workers 16 --seconds 60`
drives the real API with the audit's own service mix (simple bills, modifiers,
table service, split tenders) and replays every tenth op deliberately, then
checks the books. Against a local install:

| Concurrent terminals | Bills / hour | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|
| 4 | 610,000 | 20 ms | 47 ms | 63 ms | 0 |
| 16 | 610,000 | 73 ms | 206 ms | 313 ms | 0 |
| 64 | 640,000 | 313 ms | 450 ms | 537 ms | 0 |
| 200 | 590,000 | 1,091 ms | 1,266 ms | 1,378 ms | 0 |

Throughput plateaus around **170 bills a second** and stays there; past that,
latency grows linearly with concurrency instead of collapsing, because the
excess queues on the pool and drains well inside the checkout timeout. A
three-minute soak settled 31,086 bills with no errors, connections flat at 12,
and resident memory plateauing at 172 MB (28 kB of drift across a further
30,000 bills — warm-up, not a leak). No deadlocks. Across 78,292 sales and
317,114 journal lines the trial balance came out **exact**: debits
25,468,736.04, credits 25,468,736.04, gap 0.00.

**Read these numbers for their shape, not their size.** They come from a
development box with Postgres on loopback: no internet round trip, no TLS
handshake, a bigger machine than a small Railway container. Production will be
materially slower per request. What transfers is the shape — a flat throughput
ceiling with graceful queueing, no leak, no deadlock — and the correctness,
which is logic and not hardware: no duplicate op, one sale per bill, every
journal balanced, revenue tying to the sales that made it.

Run the same harness against staging before a multi-terminal rollout to get
figures that describe production. Watch p95 on `/sync/push`, pool checkout
failures, and lock waits on `doc_series`.

## Mission Control — the seller's panel

The product is sold one install per customer: each customer gets their own app
service and their own Postgres, provisioned exactly as above. Mission Control
is the seller's view across those installs. It ships in the same image and is
selected by the start command — a separate Railway service from the same repo:

```
start command   node panel/server.js
healthcheck     /readyz
DATABASE_URL    its OWN small Postgres (the registry), never a customer's
PANEL_SECRET    ≥32 chars — signs the admin session tokens
PANEL_SETUP_TOKEN  gates the one-time first-run admin creation; spend it,
                   then clear or rotate it
```

Each customer install sets `PLATFORM_KEY` (≥32 chars, unique per customer).
Unset, `/api/platform/summary` is a 404 — an install that was never sold has
no platform. The panel holds each key in its registry and probes server-side;
the browser gets figures, never keys.

### Provision, automatically

Set the two variables below on the **panel** service and **Provision** builds
the whole install: the project, the Postgres and its disk, the app service, its
address and its health check; it mints every secret; it waits for the first
deploy; then it records the install and emails the customer their address and
setup code.

| Variable | |
|---|---|
| `RAILWAY_API_TOKEN` | **Required.** An account or workspace token from railway.com/account/tokens. It can create and destroy infrastructure, so it is held by the panel and never rendered — same discipline as `PLATFORM_KEY`. |
| `INSTALL_REPO` | **Required.** What a new install deploys, as `owner/name`. |
| `INSTALL_BRANCH` | Optional, default `main`. |
| `INSTALL_REGION` | Optional, e.g. `asia-southeast1-eqsg3a`. Applied to the app and the database volume. |
| `INSTALL_PG_IMAGE` | Optional, default `ghcr.io/railwayapp-templates/postgres-ssl:18` — read off a running Railway Postgres rather than guessed. An image tag moves; this is why it is a variable. |
| `RAILWAY_WORKSPACE_ID` | Optional. Which workspace new projects belong to; the account default otherwise. |
| `RESEND_API_KEY` · `EMAIL_FROM` | **Passed on to every install.** Without them the install has no transport, so the account plane writes the verification code to the audit trail and says so — and a customer who cannot verify their address cannot claim their install. Override per install with `INSTALL_RESEND_API_KEY` / `INSTALL_EMAIL_FROM`. |
| `INSTALL_PORTAL_BASE_DOMAIN` | Optional. The wildcard domain a store's guests are sent to. **Left unset it is passed on EMPTY, which is correct**: a Railway-generated hostname has no wildcard, so `<handle>.<that host>` resolves nowhere, and empty turns store subdomains off in favour of the path forms, which do. Set it once a real wildcard domain exists. |
| `RAILWAY_API_URL` | Optional. For rehearsing the whole path against a stub. |

**Leave `RAILWAY_API_TOKEN` unset and nothing changes** — the panel reports
which variable is missing, by name, and the manual sheet below is still the
whole feature. That matters for an install built on somebody else's
infrastructure, which stays registrable for ever.

What it does NOT do, on purpose:

- **The database password is minted and never read back.** The app's
  `DATABASE_URL` is the reference `${{Postgres.DATABASE_URL}}`, resolved by
  Railway at deploy time, so the app's own configuration holds no credential.
  The panel does set the Postgres service's own wiring, because the image does
  not carry it — see the note below.
- **It never rounds a partial run up to a failure.** Each step is written to
  the install row *before* it runs, so a panel that dies mid-run leaves a row
  saying how far it got and every id it made. An orphaned service costs money
  quietly for months; a half-finished row is on the dashboard in thirty
  seconds.
- **It never cleans up silently.** Rollback deletes only a project *that run*
  created, and only when a person asked for it on a screen that said what would
  be destroyed.

**What the rehearsal already found.** Railway's Postgres image does NOT
publish `DATABASE_URL` on its own: a service created bare from it comes up with
only Railway's injected `RAILWAY_*` variables, because `DATABASE_URL`,
`POSTGRES_USER`, `POSTGRES_PASSWORD` and `PGDATA` belong to the template rather
than the image. Verified on a disposable project against the real API. The
panel sets that wiring itself now (`pgVariables()` in `panel/railway.js`), with
`PGDATA` pointed at a subdirectory of the mount — initdb refuses a data
directory that is not empty, and a mounted volume already has a `lost+found`.

**Still worth one live run before a customer is waiting.**
`test/provision.test.js` covers composition, ordering and every failure branch
against a stubbed transport, and the whole sequence has been driven end to end
against a stand-in API. That proves what is sent and what is decided, never
that Railway accepts all of it. Two calls remain unexercised against the real
platform — `serviceCreate` from a GitHub repo carrying inline variables, and
`volumeCreate` — so make the first real run a disposable one. Both are
exercised now: two live runs, and the second one is why the app is not built
until the database's deployment reports live.

### Provision, by hand

Still supported and unchanged: create the app + database, set their
`PLATFORM_KEY` **and `ONBOARDING_CLAIM_TOKEN`**, then register the install in
the panel with its base URL, that key and that code.

### `ONBOARDING_CLAIM_TOKEN` — who gets to claim a fresh install

`chain.claim_first_owner()` succeeds exactly **once** in the life of an
installation, and the three steps before it — company, first outlet, first
owner — cannot be behind a staff session, because the staff session is what
step 3 creates. Left open, whoever POSTs first owns the business, and the
starting gun is public: a new install's hostname reaches the certificate
transparency logs within minutes of its first TLS handshake, which is well
inside the gap between provisioning it and the customer sitting down to type
their company name.

| Variable | What it does |
|---|---|
| `ONBOARDING_CLAIM_TOKEN` | ≥8 chars. Set, the three open onboarding steps require it as `x-claim-token`, compared in constant time; the panel asks for it once, up front. **Unset, they stay open** — an install onboarding itself on a counter has no seller to get a code from — and the boot log says which of the two this install is, by name. |

Generate one per install and never reuse it:

```bash
node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))"
```

Record it in Mission Control's **Setup code** field when you register the
install, and hand it to the customer with their address. It is stored so you
can read it back — a customer who has lost their code rings the seller, not
Railway — through **Show setup code** on the install sheet. It is deliberately
not in the dashboard poll: a credential that grants ownership of an unclaimed
install should be asked for, not delivered every thirty seconds into a browser
left open on a desk.

The code stops mattering the moment the install has an owner: `/state` stops
advertising it and `claim_first_owner()` refuses regardless. Rotating or
clearing it afterwards changes nothing.

## What is not automated, and needs a console

Two things in this build cannot be verified from the repository and have to be
set up in the platform:

- **Managed backups** — retention, schedule, and one restore drill.
- **An external monitor** pointed at `/readyz`. The endpoint is there and
  answers honestly; nothing is watching it until something is told to.
