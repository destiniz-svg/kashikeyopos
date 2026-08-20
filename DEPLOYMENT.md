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

## First deploy, into an empty database

1. Set the environment variables. Do this **before** the first boot: the
   service refuses to migrate without the secrets, and in production it exits
   rather than serving on a half-built schema.
2. Deploy. Migrations run at boot, inside the process, in name order, exactly
   once each (`chain.migration` is the ledger). A migration whose contents
   changed is re-applied — which is why every migration in this repo is
   idempotent.
3. Open the service URL. An empty install lands on `/onboarding`, not on a
   sign-in screen it cannot answer.
4. Work the fourteen steps. The last one hands you the floor, signed in as the
   owner, with a PIN you set. **Write that PIN down before you close the tab.**

There is no seed data and no demo. A new install has no outlets, no dishes, no
staff and no PIN until onboarding writes them.

## Every deploy after that

`npm test` must pass **against a cold database**. CI does exactly this
(`.github/workflows/test.yml`: a fresh Postgres 16 service, `npm ci --omit=dev`,
`npm audit --omit=dev --audit-level=high`, `npm test`) because a suite that only
passes against a database somebody warmed up by hand is a suite that will pass
right up until the deploy.

Then: land the change, watch the deploy log for `[migrate]` lines, and confirm
`/readyz` is 200. If a migration failed, both health endpoints say so by name.

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

## What is not automated, and needs a console

Two things in this build cannot be verified from the repository and have to be
set up in the platform:

- **Managed backups** — retention, schedule, and one restore drill.
- **An external monitor** pointed at `/readyz`. The endpoint is there and
  answers honestly; nothing is watching it until something is told to.
