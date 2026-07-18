# Disaster recovery & database restore runbook

Closes audit finding **OPS-01**. This is the operational procedure for backing
up and restoring KashikeyoPOS, and the drill that proves the backup actually
works — *a backup that has never been restored is not evidence of recoverability.*

> **Owner action required.** Lines marked **`TODO(owner)`** need a real value
> filled in from your Railway plan / on-call setup. Don't leave them blank in
> production.

---

## 1. What is at risk, and where it lives

| Asset | Store | Recovery source |
| --- | --- | --- |
| Business data — sales, orders, customers, products, stock, shifts | PostgreSQL (`entities` JSONB, `ops`, `stock_moves`, `ingredients`, `recipe_lines`, `orgs`, `stores`, `suppliers`, `purchase_invoices…`, `platform_admins`) | **DB backup** (this runbook) |
| Application code + the baked till bundle (`web/dist`) | Git (`main`) | `git` + Railway redeploy |
| Secrets & config (`DATABASE_URL`, `JWT_SECRET`/`SECRET`, `ALLOWED_ORIGINS`, `GOOGLE_CLIENT_ID`, `PLATFORM_ADMIN_*`, `ANTHROPIC_API_KEY`) | Railway → service → Variables | **Railway variables** (back these up separately — see §6) |
| Unsynced sales on a till | Browser `localStorage` (`kashikeyo-outbox`) on each device | The device itself (re-syncs after recovery) |

The **only** component whose loss is unrecoverable from git is the PostgreSQL
data. Everything else is rebuildable from the repo. So DR = protecting Postgres.

### Resilience properties that make restore safe

These are built into the app and matter during a restore:

- **Schema self-applies.** On every boot `index.js` runs `schema.sql` (idempotent
  `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE … ADD COLUMN IF NOT EXISTS`). A
  restored-but-empty or older-schema DB is brought current automatically.
- **The restricted DB role self-heals.** The app connects for request handling
  as `kashikeyo_app`, whose password is `sha256("<SECRET>:kashikeyo_app_role")`.
  On boot `ensureAppRole()` `CREATE`s or `ALTER`s the role to match. So after a
  restore you do **not** need to recreate or re-password that role — just keep
  `SECRET`/`JWT_SECRET` the same as before. (Change `SECRET` and every existing
  JWT/session is also invalidated — avoid it during recovery.)
- **The op-log is idempotent.** `ops(org_id, op_id)` is unique and
  `stock_moves(org_id, ref, ingredient_id)` is unique. Any till that re-pushes
  its outbox after a restore **cannot create duplicate sales or double-deduct
  stock** — replays are dropped. This is what makes "restore, then let tills
  reconnect" safe.

---

## 2. Objectives (RPO / RTO)

| Target | Value | Notes |
| --- | --- | --- |
| **RPO** (max data loss) | **`TODO(owner)`** — recommend ≤ 24 h with daily backups, ≤ 5 min if PITR is enabled | Data committed to the DB after the last backup point is lost from the server. See §5 for how the offline outbox reduces real-world loss. |
| **RTO** (max downtime) | **`TODO(owner)`** — recommend ≤ 1 h | Time to stand up a healthy DB + app and confirm §4 verification passes. |
| **Max offline backlog** | One full trading day per till | Tills keep unsynced sales in `localStorage`; beyond ~500 queued ops the oldest are trimmed on persist (`rd()` slices to the last 500). Sync tills at least daily. |

---

## 3. Backup strategy

Run **both** layers. Layer A is Railway's safety net; Layer B is the portable,
testable backup you actually own and can restore anywhere.

### Layer A — Railway managed backups
- Confirm on the Postgres service: **Settings → Backups**. Record the schedule,
  retention, and whether **Point-in-Time Recovery (PITR)** is available on your
  plan. `TODO(owner): document schedule + retention here.`
- Railway volume backups are encrypted at rest.

### Layer B — logical backup you control (recommended baseline)
A nightly `pg_dump` gives a portable, plan-independent snapshot you can restore
onto any Postgres and, crucially, **test** (§7).

```bash
# One snapshot (custom format = compressed, selective-restore capable).
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges \
  --file "kashikeyo-$(date +%Y%m%d-%H%M).dump"
```

- `--no-owner --no-privileges` keeps the dump portable: on restore the app's
  `ensureAppRole()` re-creates the role and `schema.sql` re-grants — you don't
  need the original role grants baked into the dump.
- **Store copies off-site and encrypted.** e.g. push to object storage:
  `gpg --encrypt --recipient <key> kashikeyo-*.dump` then upload. Never keep the
  only copy on the same provider as the primary DB.
- Schedule it: a Railway **cron service**, a GitHub Actions scheduled job with
  `DATABASE_URL` as a secret, or an external backup runner. `TODO(owner): wire
  the schedule and record where dumps land + retention.`

---

## 4. Post-restore verification checklist

Run **after every** restore (and every drill). A restore is not "done" until all
pass.

```bash
# 0. App is up and the DB is reachable (schema applied, restricted role swapped in).
curl -fsS https://<app-host>/api/health         # → {"ok":true,"db":true,...}

# In a psql shell against the restored DB:
# 1. Core tables and the immutable ledger exist and are populated.
SELECT count(*) FROM entities;
SELECT count(*) FROM ops;
SELECT count(*) FROM stock_moves;

# 2. RLS is FORCED and the restricted role exists (tenant isolation intact).
SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class WHERE relname IN ('orgs','stores','entities','ops');   -- both flags true
SELECT 1 FROM pg_roles WHERE rolname = 'kashikeyo_app';                -- one row

# 3. Per-tenant sanity: org count + a spot count of a known org's sales.
SELECT count(*) FROM orgs;
SELECT org_id, count(*) FROM entities WHERE kind='sales' GROUP BY org_id LIMIT 5;

# 4. Ledger reconciles to the cache for a sampled ingredient
#    (Σ stock_moves.qty should equal ingredients.current_stock).
SELECT i.id, i.current_stock,
       COALESCE((SELECT sum(qty) FROM stock_moves m
                 WHERE m.org_id=i.org_id AND m.ingredient_id=i.id),0) AS ledger_sum
  FROM ingredients i LIMIT 20;   -- current_stock ≈ ledger_sum per row
```

- **Application-level:** sign in to `/back` for one tenant and confirm the
  Review, Ingredients, and Overview tabs load with expected numbers; open `/app`
  and confirm the sync-status tray reads **Synced** once tills reconnect.
- **Tenant isolation:** log in as two different orgs and confirm neither sees the
  other's data (this is also covered by the automated suite,
  `npm test` → `auth & tenancy`).

---

## 5. Restore procedures

### 5a. Full restore from a logical dump (Layer B — portable, primary path)

1. Provision a fresh empty Postgres (new Railway Postgres, or any PG 16).
2. Restore the dump:
   ```bash
   pg_restore --no-owner --no-privileges --clean --if-exists \
     --dbname "$NEW_DATABASE_URL" kashikeyo-<stamp>.dump
   ```
3. Point the app at it: set the service's `DATABASE_URL` to the new DB. **Keep
   `SECRET`/`JWT_SECRET` unchanged.**
4. Redeploy / restart the service. On boot the app applies `schema.sql`,
   `ensureAppRole()` re-creates `kashikeyo_app`, and it swaps to the restricted
   pool (`connected as restricted role kashikeyo_app…` in the logs).
5. Run the §4 verification checklist.
6. Tell staff to reopen the till on each device; queued offline sales re-sync and
   dedup automatically (§1). Watch the sync tray go to **Synced**.

### 5b. Point-in-time / Railway managed restore

Use when the loss window must be tighter than the last logical dump and your plan
has PITR/managed backups.

1. Railway → Postgres service → **Backups** → restore the target snapshot / PITR
   timestamp (this typically creates a new database instance).
2. Repoint `DATABASE_URL` to the restored instance, keep `SECRET` unchanged,
   redeploy.
3. Run §4 verification.

### 5c. Accidental deletion of one tenant / a few records

Business objects are **soft-deleted** (`entities.deleted=true`), so most
"deletions" are recoverable without a full restore:

```sql
-- Inspect first, then undelete a specific org's rows deleted in the last hour.
UPDATE entities
   SET deleted=false, rowver=nextval('entities_rowver_seq'), updated_at=now()
 WHERE org_id = '<org-uuid>' AND kind='<kind>' AND deleted=true
   AND updated_at > now() - interval '1 hour';
```

For hard loss (row truly gone, or `stock_moves`/`ops` which are append-only and
not soft-deleted), restore a Layer-B dump into a **scratch** database and copy
only the affected rows across — never restore the whole primary over good data.

### 5d. Bad deployment or bad migration

`schema.sql` is **additive only** (no destructive `DROP`/rename in the
incremental section), so a code rollback needs no schema rollback:

1. `git revert <bad commit>` (or redeploy the previous green commit) and push;
   Railway rebuilds and redeploys.
2. No DB restore is required unless the bad deploy wrote bad *data* — in which
   case treat it as §5c (targeted) or §5a/5b (broad).
3. A bad **till bundle** release: re-bake from a known-good commit and bump the
   service-worker version (see `CLAUDE.md` → "Patching the till bundle") so PWAs
   pick up the fix.

### 5e. Total service / region loss (rebuild from scratch)

1. New Railway project → deploy the repo (`main`) → attach a Postgres.
2. Restore data via §5a (or §5b if the managed backup survived).
3. Recreate the service **Variables** from your secrets backup (§6), keeping
   `SECRET`/`JWT_SECRET` identical to the lost environment so sessions and the
   `kashikeyo_app` role line up.
4. Point DNS at the new service; run §4 verification.

---

## 6. Secrets & config recovery

The DB dump does **not** contain env vars. Keep an encrypted copy of the service
Variables (at minimum `JWT_SECRET`/`SECRET`, `DATABASE_URL`, `ALLOWED_ORIGINS`,
`GOOGLE_CLIENT_ID`, `PLATFORM_ADMIN_*`, `ANTHROPIC_API_KEY`) in your password
manager / secrets vault. `TODO(owner): record where the secrets backup lives.`
Losing `SECRET` means every session/JWT is invalidated and the `kashikeyo_app`
role password no longer matches the restored role until the app re-`ALTER`s it —
recoverable, but avoidable by backing it up.

---

## 7. The quarterly restore drill (do this — it's the whole point)

Schedule: **`TODO(owner)` — recommend quarterly.** Owner: `TODO(owner)`.

1. Take (or take the latest) Layer-B dump.
2. Restore it into a **throwaway** database (§5a) — never production.
3. Boot a temporary app instance against it (locally is fine; see `CLAUDE.md` →
   "Local test harness").
4. Run the §4 checklist **and** the automated suite against it:
   ```bash
   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=<restored> npm test   # 27 tests, all green
   ```
5. Record: dump age, restore duration (→ validates RTO), row counts vs
   production, and any failure. File anything that failed as a bug.
6. Tear down the throwaway DB.

A drill that restores cleanly and passes §4 + `npm test` is your evidence that
the RPO/RTO targets in §2 are real.

---

## 8. Escalation

- On-call / DB owner: `TODO(owner)`
- Railway project + Postgres service IDs: `TODO(owner)`
- Where backups + secrets live: `TODO(owner)`
