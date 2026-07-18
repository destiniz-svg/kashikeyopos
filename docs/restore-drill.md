# Restore drill — step-by-step walkthrough (audit §3.1)

This is the **guided, copy-paste version** of the quarterly restore drill in
`docs/disaster-recovery.md §7`. It proves — end to end — that a database backup
can actually be restored into a working KashikeyoPOS. *A backup you have never
restored is not a backup.*

You run the whole thing inside a **GitHub Codespace** against the **staging**
database (never production for a drill). It takes ~30–40 minutes, needs no local
install, and the Codespace is disposable so there's nothing to clean up on your
machine. **Zero risk to production or to staging** — you only *read* (dump) from
staging and restore into a throwaway database that lives inside the Codespace.

Do it once now to close §3.1, then repeat quarterly.

---

## Before you start — get the staging DB connection string

A Codespace is outside Railway's private network, so you need the **public**
connection URL (the internal `DATABASE_URL` only works inside Railway):

1. Railway → **loving-art** → switch environment to **`staging`**.
2. Click the **Postgres** service → **Variables** tab.
3. Copy the value of **`DATABASE_PUBLIC_URL`** (it looks like
   `postgresql://postgres:…@…proxy.rlwy.net:PORT/railway`). If you only see
   `DATABASE_URL`, use the **Connect** tab → the **public** connection URL.

> ⚠️ That URL contains a password. Only paste it inside the ephemeral Codespace
> terminal. Don't commit it, don't put it in a file that gets pushed.

Open a Codespace on the repo (any branch): GitHub → repo → **Code ▸ Codespaces ▸
Create codespace**. Then run the steps below in its terminal.

---

## Step 1 — install the Postgres tooling

```bash
sudo apt-get update -qq && sudo apt-get install -y -qq postgresql postgresql-client
sudo service postgresql start
# give the local postgres a known password so the connection strings below are simple
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"
psql --version    # confirm client is present
```

## Step 2 — take a backup from staging (note the time)

```bash
export STAGING_URL='PASTE_DATABASE_PUBLIC_URL_HERE'

date -u '+backup taken at: %Y-%m-%d %H:%M UTC'          # ← record this (dump age)
pg_dump "$STAGING_URL" --format=custom --no-owner --no-privileges \
  --file staging.dump
ls -lh staging.dump                                     # confirm it exists + size
```

This is exactly the Layer-B backup from the runbook — a portable snapshot you own.

## Step 3 — restore into a throwaway database (this is the timed part → RTO)

```bash
sudo -u postgres createdb kashrestore
export RESTORE_URL='postgresql://postgres:postgres@localhost:5432/kashrestore'

time pg_restore --no-owner --no-privileges --dbname "$RESTORE_URL" staging.dump
```

Write down the **`real`** time `time` prints — that's your restore duration, the
core input to the **RTO** target in the runbook §2.

## Step 4 — the strongest proof: run the test suite against the restored DB

The automated suite exercises schema, RLS/tenant isolation, the restricted role,
money integrity, credit limits, the stock ledger and sync idempotency **against
this restored database**. If it's green, the restore is sound.

```bash
npm install   # pulls the app deps (pg, express, …) so the suite can boot index.js
PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres \
  PGDATABASE=kashrestore npm test
```

Expect **all tests passing**. (The suite registers its own throwaway orgs, so it
runs safely alongside the restored staging data; the app self-applies `schema.sql`
and re-creates the `kashikeyo_app` role on connect — nothing to set up by hand.)

## Step 5 — spot-check that the real staging data came across

```bash
psql "$RESTORE_URL" <<'SQL'
-- core tables populated
SELECT 'entities' AS t, count(*) FROM entities
UNION ALL SELECT 'ops', count(*) FROM ops
UNION ALL SELECT 'stock_moves', count(*) FROM stock_moves
UNION ALL SELECT 'orgs', count(*) FROM orgs;

-- your staging test store's sales are present
SELECT org_id, count(*) AS sales FROM entities WHERE kind='sales' GROUP BY org_id;

-- RLS is FORCED on the tenant tables (isolation intact after restore)
SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class WHERE relname IN ('orgs','stores','entities','ops');  -- both flags 't'
SQL
```

Row counts should roughly match what's in staging, and the RLS flags must both be
`t`. (Optional bonus — boot the app against the restore and hit health:)

```bash
PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres \
  PGDATABASE=kashrestore SECRET=drill-secret JWT_SECRET=drill-secret \
  NODE_ENV=development PORT=4000 node index.js &
sleep 6
curl -fsS localhost:4000/api/health     # → {"ok":true,"db":true,...}
curl -fsS localhost:4000/version        # environment=development, your commit
kill %1
```

## Step 6 — record the result

Fill this in (paste it into your ops log / the runbook §7 history):

```
Restore drill — <date>
  dump age (from step 2):        __________
  restore duration (step 3 real): __________   → RTO input
  npm test:                       PASS / FAIL
  row counts vs staging:          entities ____  ops ____  stock_moves ____
  RLS flags both 't':             yes / no
  issues found:                   __________
  verdict:                        PASS / FAIL
```

## Step 7 — tear down

Nothing to clean up in production. Just **delete the Codespace** (GitHub → your
avatar → Codespaces → ⋯ → Delete) — the throwaway DB and the dump go with it.

---

## What a pass means

A drill that **restores cleanly, passes `npm test`, and shows the staging data +
FORCED RLS** is your evidence that recovery works and that the **RPO/RTO targets
in `disaster-recovery.md §2` are real, not theoretical.** That closes audit
finding §3.1.

While you're here, fill in the remaining `TODO(owner)` values in
`disaster-recovery.md` (§2 RPO/RTO from the numbers you just measured, §3 backup
schedule + retention, §6 where secrets live, §8 on-call). Then schedule the next
drill (recommend quarterly).

## Doing it for real (production incident)

Same steps, but restore into a **new Postgres** and repoint the service's
`DATABASE_URL` at it (keeping `SECRET`/`JWT_SECRET` unchanged) rather than a
Codespace-local DB — see `disaster-recovery.md §5a`. The drill is the rehearsal;
the runbook §5 is the live procedure.
