/* KashikeyoPOS Cloud
   Multi-store, Postgres-backed sync server with offline-safe op-log, SSE pokes,
   public guest endpoints, and static PWA hosting. */
const compression = require("compression");
const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { createRemoteJWKSet, jwtVerify } = require("jose");
const { DEFAULT_MENU, CAT_GROUPS, CAT_ORDER } = require("./default-menu");

const PORT = process.env.PORT || 4000;
const DEV_SECRET = "kashikeyo-dev-secret-change-me";
const SECRET = process.env.JWT_SECRET || DEV_SECRET;
const MIN_PASSWORD_LEN = Number(process.env.MIN_PASSWORD_LEN) || 8; // store-owner password floor (audit §3.5)
const DEFAULT_STORE_ID = "main";

/* "Sign in with Google/Apple" both hand back a signed OIDC ID token rather
   than a redirect-and-exchange flow, so login only needs the public client
   id (safe to expose to the browser) plus verifying that token's signature,
   issuer and audience against the provider's published keys - no client
   secret or server-to-server call required for identity alone. */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || "";
const APPLE_REDIRECT_URI = process.env.APPLE_REDIRECT_URI || "";
const googleJwks = GOOGLE_CLIENT_ID ? createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs")) : null;
const appleJwks = APPLE_CLIENT_ID ? createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys")) : null;
async function verifyGoogleIdToken(idToken) {
  const { payload } = await jwtVerify(idToken, googleJwks, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience: GOOGLE_CLIENT_ID });
  return payload;
}
async function verifyAppleIdToken(idToken) {
  const { payload } = await jwtVerify(idToken, appleJwks, { issuer: "https://appleid.apple.com", audience: APPLE_CLIENT_ID });
  return payload;
}
const SHARED_KINDS = new Set(["settings", "customers", "units", "categories", "vendors"]);
/* Kinds whose rows are reported on over a date range, so a missing timestamp
   would drop them out of every period (see the `data.t` normalisation in
   /api/ops). Anything else keeps whatever timestamp it arrived with. */
const TIMED_KINDS = new Set(["sales", "expenses", "pords", "waiterCalls", "shifts", "settlements"]);
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.RAILWAY_DATABASE_URL || "";
const hasPgEnv = !!(process.env.PGHOST || process.env.PGUSER || process.env.PGDATABASE);
/* AUDIT-S5/SEC-1: JWT_SECRET signs every session/elevation/dev token AND
   derives the restricted DB-role password. A boot on the public dev fallback
   (or a too-short secret) would let anyone forge tokens for any org, so
   refuse to start rather than run wide open. Originally gated on
   NODE_ENV==="production" alone — safe on the documented Dockerfile path
   (which hardcodes it), but a deploy that reaches this process any other way
   and forgets to export NODE_ENV would boot silently on the well-known
   default. A real Postgres target (a DATABASE_URL, or PGHOST pointed
   somewhere other than localhost) is a second, independent signal that this
   is not the local dev/test harness — trip the guard on either signal, not
   NODE_ENV alone. The local harness always uses 127.0.0.1 and no
   DATABASE_URL, so it is unaffected. */
const looksLikeRealDeploy = !!databaseUrl || (hasPgEnv && !/localhost|127\.0\.0\.1/.test(String(process.env.PGHOST || "")));
if ((process.env.NODE_ENV === "production" || looksLikeRealDeploy) && (SECRET === DEV_SECRET || SECRET.length < 16)) {
  console.error("FATAL: JWT_SECRET must be set to a strong value (≥16 chars) before this can boot against a real database. Refusing to boot.");
  process.exit(1);
}
const localDatabaseUrl = process.env.NODE_ENV === "production" ? "" : "postgres://kash:kash@127.0.0.1:5432/kash";
const connectionString = databaseUrl || (hasPgEnv ? "" : localDatabaseUrl);
const poolConfig = connectionString ? { connectionString } : {};
if (connectionString && !/localhost|127\.0\.0\.1/.test(connectionString)) poolConfig.ssl = { rejectUnauthorized: false };
if (process.env.NODE_ENV === "production" && !databaseUrl && !hasPgEnv) console.warn("No Postgres variables found. Attach DATABASE_URL.");

/* Connection pooling (P0 / cost + uptime). A transaction-mode pooler (Railway
   PgBouncer) lets one small instance multiplex many clients cheaply, and it is
   safe for request handling here BECAUSE every tenant query runs inside
   withScope()'s BEGIN…COMMIT with set_config(...,true) (transaction-local), so
   RLS + the org scope pin to a single backend for the whole transaction.
   Two things must NOT cross a transaction pooler, because it reassigns the
   server backend between statements: (1) the boot advisory lock (session-held
   across schema apply) and (2) the LISTEN/NOTIFY poke listener (a long-lived
   registration). Those use a DIRECT connection. Set DATABASE_URL to the pooled
   endpoint and DIRECT_DATABASE_URL to the direct :5432 endpoint; when the direct
   URL is unset we fall back to DATABASE_URL (correct for local/dev and any
   non-pooled deployment, so nothing changes until a pooler is actually added). */
const directUrl = process.env.DIRECT_DATABASE_URL || process.env.DIRECT_URL || process.env.PGBOUNCER_DIRECT_URL || "";
const directConnectionString = directUrl || connectionString;
const directPoolConfig = directConnectionString ? { connectionString: directConnectionString } : (hasPgEnv ? {} : poolConfig);
if (directConnectionString && !/localhost|127\.0\.0\.1/.test(directConnectionString)) directPoolConfig.ssl = { rejectUnauthorized: false };
const APP_POOL_MAX = Number(process.env.PG_POOL_MAX) > 0 ? Number(process.env.PG_POOL_MAX) : undefined;

/* Row Level Security only has teeth if the role running app queries is
   NOT the table owner and NOT a superuser — both bypass RLS regardless of
   policies (superusers unconditionally; owners unless FORCE is set, and
   Railway's default Postgres template grants a superuser role, which no
   FORCE setting can override). bootPool connects with whatever credentials
   were provided (owner-level, needed to create tables/roles/policies).
   pool — used for every request — connects as a separate, restricted
   kashikeyo_app role with only DML rights, so the tenant_isolation
   policies in schema.sql are actually enforced by Postgres itself. */
const bootPool = new Pool(directPoolConfig); // boot/migrations + the session advisory lock — always DIRECT (never through a transaction pooler)
const APP_DB_ROLE = "kashikeyo_app";
const appRolePassword = crypto.createHash("sha256").update(`${SECRET}:kashikeyo_app_role`).digest("hex");

/* Restricted app-role config over a given connection string (or PG* env).
   base = the pooled request endpoint by default; pass the direct endpoint for
   the LISTEN client. `max` (PG_POOL_MAX) caps the app pool so many app replicas
   behind a pooler don't each open a large fan of server connections. */
function appPoolConfigFrom(baseConnStr) {
  if (baseConnStr) {
    try {
      const u = new URL(baseConnStr);
      u.username = APP_DB_ROLE;
      u.password = appRolePassword;
      const cfg = { connectionString: u.toString() };
      if (!/localhost|127\.0\.0\.1/.test(baseConnStr)) cfg.ssl = { rejectUnauthorized: false };
      if (APP_POOL_MAX) cfg.max = APP_POOL_MAX;
      return cfg;
    } catch { /* fall through to PG* env / poolConfig below */ }
  }
  if (hasPgEnv) {
    const cfg = {
      host: process.env.PGHOST, port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
      database: process.env.PGDATABASE, user: APP_DB_ROLE, password: appRolePassword,
    };
    if (!/localhost|127\.0\.0\.1/.test(String(process.env.PGHOST || ""))) cfg.ssl = { rejectUnauthorized: false };
    if (APP_POOL_MAX) cfg.max = APP_POOL_MAX;
    return cfg;
  }
  return poolConfig;
}
/* Backpressure (audit C-H7). pg's pool waits forever for a connection by
   default and nothing set a statement timeout, so under load latency climbed
   linearly with ZERO errors — /admin p50 reached 2.05s at 32 concurrent and the
   till simply hung with no 503 to retry against. A counter tablet needs to be
   told "busy, try again", not left holding a spinner. */
const CONNECT_TIMEOUT_MS = Number(process.env.PG_CONNECT_TIMEOUT_MS) > 0 ? Number(process.env.PG_CONNECT_TIMEOUT_MS) : 4000;
const STATEMENT_TIMEOUT_MS = Number(process.env.PG_STATEMENT_TIMEOUT_MS) > 0 ? Number(process.env.PG_STATEMENT_TIMEOUT_MS) : 15000;
function withTimeouts(cfg) {
  cfg.connectionTimeoutMillis = CONNECT_TIMEOUT_MS;
  cfg.statement_timeout = STATEMENT_TIMEOUT_MS;
  cfg.query_timeout = STATEMENT_TIMEOUT_MS + 1000;
  cfg.idleTimeoutMillis = 30000;
  return cfg;
}
// request pool → pooled endpoint (DATABASE_URL); safe through a transaction pooler
function appPoolConfig() { return withTimeouts(appPoolConfigFrom(connectionString)); }
// background pool (PERF-1) → same endpoint, small cap so post-commit inventory
// work never starves the request pool. Override with PG_BG_POOL_MAX.
function bgPoolConfig() { const c = appPoolConfig(); c.max = Number(process.env.PG_BG_POOL_MAX) > 0 ? Number(process.env.PG_BG_POOL_MAX) : 4;
  /* Post-commit recipe deduction over a big batch legitimately runs longer
     than a request should, so the background pool gets its own ceiling. */
  c.statement_timeout = 60000; c.query_timeout = 61000; return c; }
// LISTEN client → DIRECT endpoint; a long-lived registration must not cross a pooler
function appDirectPoolConfig() { return appPoolConfigFrom(directConnectionString); }
let pool = bootPool; // until ensureAppRole() below swaps in the restricted-role pool

async function ensureAppRole() {
  await bootPool.query(`
    DO $do$
    DECLARE db text := current_database();
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_DB_ROLE}') THEN
        EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', '${APP_DB_ROLE}', '${appRolePassword}');
      ELSE
        EXECUTE format('ALTER ROLE %I PASSWORD %L', '${APP_DB_ROLE}', '${appRolePassword}');
      END IF;
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', db, '${APP_DB_ROLE}');
    END $do$;
  `);
  await bootPool.query(`GRANT USAGE ON SCHEMA public TO ${APP_DB_ROLE}`);
  await bootPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON orgs, stores, entities, ops, platform_admins, app_sessions, paired_devices, otp_codes, store_backups, receipt_seq TO ${APP_DB_ROLE}`);
  await bootPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ingredients, ingredient_units, recipe_lines, stock_moves,
    audit_sessions, audit_lines, suppliers, purchase_invoices, purchase_invoice_lines, ingredient_lots, stock_reservations TO ${APP_DB_ROLE}`);
  /* Append-only: INSERT + SELECT only, so the audit trail can't be rewritten or
     deleted even by the app role (FIN-03). */
  await bootPool.query(`GRANT SELECT, INSERT ON activity_log TO ${APP_DB_ROLE}`);
  await bootPool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_DB_ROLE}`);
}

/* platform_admins has no RLS (it holds no store data), so it's queried
   through the regular request pool once that's swapped in. Seeds the first
   developer-panel account from env vars, once — later password changes are
   expected to happen through the panel itself, not by re-running this. */
async function ensurePlatformAdmin() {
  const email = process.env.PLATFORM_ADMIN_EMAIL;
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!email || !password) return;
  await pool.query(
    "INSERT INTO platform_admins (id, email, pass_hash, name) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING",
    [uid(), email.toLowerCase(), bcrypt.hashSync(password, 10), process.env.PLATFORM_ADMIN_NAME || "Admin"]);
}

/* One-time repair: an earlier revision of this server stored store-scoped rows
   as "<storeId>:<id>" instead of tagging data.storeId on the original row, so
   every edit to a pre-existing product/table/zone forked a stale duplicate
   alongside the live one. Fold any such fork back into its canonical row. */
async function mergeForkedStoreRows() {
  const forked = await bootPool.query("SELECT org_id, kind, id, data, updated_at FROM entities WHERE id LIKE '%:%'");
  for (const row of forked.rows) {
    const rawId = row.id.split(":").pop();
    if (!rawId || rawId === row.id) continue;
    const canon = await bootPool.query(
      "SELECT data, updated_at FROM entities WHERE org_id=$1 AND kind=$2 AND id=$3",
      [row.org_id, row.kind, rawId]);
    const winner = canon.rowCount && new Date(canon.rows[0].updated_at) >= new Date(row.updated_at)
      ? canon.rows[0].data : row.data;
    await bootPool.query(
      `INSERT INTO entities (org_id, kind, id, data, deleted, updated_at)
       VALUES ($1,$2,$3,$4,false,now())
       ON CONFLICT (org_id, kind, id)
       DO UPDATE SET data=excluded.data, deleted=false, rowver=nextval('entities_rowver_seq'), updated_at=now()`,
      [row.org_id, row.kind, rawId, JSON.stringify(winner)]);
    await bootPool.query("DELETE FROM entities WHERE org_id=$1 AND kind=$2 AND id=$3", [row.org_id, row.kind, row.id]);
  }
  if (forked.rowCount) console.log(`merged ${forked.rowCount} forked store-prefixed row(s) back to their canonical id`);
}

/* Every request-handling query runs inside one of these two scopes so the
   tenant_isolation RLS policies (schema.sql) can do their job:
   - withOrg: ordinary tenant requests, scoped to exactly one org_id.
   - withSystem: trusted system-level lookups where no single org_id
     applies yet (login by email, guest boot by slug, new-org registration,
     the developer panel). Both run in a short transaction so the GUC set
     via set_config(..., true) is transaction-local and can never leak
     across pooled connection reuse. */
async function withScopeOn(poolRef, setup, fn) {
  const client = await poolRef.connect();
  try {
    await client.query("BEGIN");
    await setup(client);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}
const withScope = (setup, fn) => withScopeOn(pool, setup, fn);
const orgSetup = (orgId) => (client) => client.query("SELECT set_config('app.org_id',$1,true), set_config('app.is_superadmin','off',true)", [String(orgId)]);
const withOrg = (orgId, fn) => withScope(orgSetup(orgId), fn);
/* PERF-1: post-commit inventory work (recipe deduction, availability recompute)
   runs on a SEPARATE small pool so it never competes for a request-pool
   connection — that contention was the p95/p99 tail under burst. Falls back to
   the request pool until bgPool is created at boot. */
let bgPool = null;
const withOrgBg = (orgId, fn) => withScopeOn(bgPool || pool, orgSetup(orgId), fn);
const withSystem = (fn) => withScope(
  (client) => client.query("SELECT set_config('app.is_superadmin','on',true), set_config('app.org_id','',true)"),
  fn
);

const BOOT_LOCK = 918273645; // advisory-lock key that serialises boot init across instances
(async () => {
  /* Serialise the whole boot init across instances (ARCH-01): two nodes booting
     against one database used to race on catalog updates ("tuple concurrently
     updated") in schema apply, role/grant DDL and the seed steps. A session
     advisory lock held on a dedicated connection makes the second node wait
     until the first finishes; everything here is idempotent, so its run is a
     no-op. The lock auto-releases if a node dies mid-boot (no deadlock). */
  const bootClient = await bootPool.connect();
  const schemaSql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  try {
    /* The advisory lock serialises concurrent boots; the retry is the belt to
       its braces — idempotent DDL that still collides on a catalog tuple ("tuple
       concurrently updated" / deadlock) is simply retried, so a node never fails
       to boot because a sibling booted at the same instant. */
    for (let attempt = 1; ; attempt++) {
      try {
        await bootClient.query("SELECT pg_advisory_lock($1)", [BOOT_LOCK]);
        try { await bootPool.query(schemaSql); await ensureAppRole(); }
        finally { await bootClient.query("SELECT pg_advisory_unlock($1)", [BOOT_LOCK]).catch(() => {}); }
        break;
      } catch (e) {
        if (attempt < 6 && /concurrently updated|deadlock detected/i.test(String((e && e.message) || ""))) {
          await new Promise((r) => setTimeout(r, 250 * attempt));
          continue;
        }
        throw e;
      }
    }
    console.log("schema ready");
    pool = new Pool(appPoolConfig());
    pool.on("error", (e) => console.error("app pool error:", errDetail(e)));
    bgPool = new Pool(bgPoolConfig());
    bgPool.on("error", (e) => console.error("bg pool error:", errDetail(e)));
    console.log(`connected as restricted role ${APP_DB_ROLE} for request handling`);
    /* Seed/merge steps are best-effort (like the backfills below): a concurrency
       hiccup when two nodes boot together must not abort the whole boot before
       the SSE listener starts. */
    try { await mergeForkedStoreRows(); } catch (e) { console.warn("store-merge skipped:", e.message); }
    try { await ensurePlatformAdmin(); } catch (e) { console.warn("platform-admin seed skipped:", e.message); }
    /* Backfill: existing settings entities that pre-date multi-currency get
       currency:"MVR" and usdRate:1542 if those keys are absent. */
    try {
      const staleSettings = await bootPool.query(
        "SELECT org_id, id, data FROM entities WHERE kind='settings' AND deleted=false AND (data->>'usdRate' IS NULL OR data->>'currency' IS NULL)");
      for (const row of staleSettings.rows) {
        const d = row.data || {};
        if (!d.currency) d.currency = "MVR";
        if (!d.usdRate) d.usdRate = 1542;
        await bootPool.query(
          "UPDATE entities SET data=$1, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$2 AND kind='settings' AND id=$3",
          [JSON.stringify(d), row.org_id, row.id]);
      }
      if (staleSettings.rowCount) console.log(`backfilled multi-currency defaults for ${staleSettings.rowCount} settings entity(s)`);
    } catch (e) { console.warn("currency backfill skipped:", e.message); }
    /* Collapse duplicate settings rows onto the canonical id='settings' row.
       Early builds could leave an org with more than one settings row, and the
       /api/app2/config writer used to update "most recently updated" rather than
       id='settings'. With a duplicate present, a rename saved to id='settings'
       while the terminal's read path still read the other row — the classic
       "save succeeds, nothing shows" split-brain. The canonical row is where
       every post-fix write lands (and what the storefront already displays), so
       it wins every key it defines; the strays only backfill keys the canonical
       row is missing (a newer stray beats an older one for those). Write the
       merged blob to id='settings' and soft-delete the strays so clients drop
       them on the next pull. Guarded by HAVING count(*)>1, so it is a no-op once
       an org is clean. */
    try {
      const dupOrgs = await bootPool.query(
        `SELECT org_id FROM entities WHERE kind='settings' AND deleted=false
           GROUP BY org_id HAVING count(*) > 1`);
      let collapsed = 0;
      for (const { org_id } of dupOrgs.rows) {
        // Strays first (oldest→newest), canonical last, so a plain per-row
        // Object.assign lets the canonical row's keys win and newer strays beat
        // older strays for anything the canonical row doesn't define.
        const rows = (await bootPool.query(
          `SELECT id, data FROM entities WHERE org_id=$1 AND kind='settings' AND deleted=false
             ORDER BY (id='settings') ASC, updated_at ASC`, [org_id])).rows;
        const merged = {};
        for (const r of rows) Object.assign(merged, r.data || {});
        await bootPool.query(
          `INSERT INTO entities (org_id, kind, id, data, rowver) VALUES ($1,'settings','settings',$2,nextval('entities_rowver_seq'))
             ON CONFLICT (org_id, kind, id) DO UPDATE SET data=$2, deleted=false, rowver=nextval('entities_rowver_seq'), updated_at=now()`,
          [org_id, JSON.stringify(merged)]);
        for (const r of rows) {
          if (r.id === "settings") continue;
          await bootPool.query(
            `UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now()
               WHERE org_id=$1 AND kind='settings' AND id=$2`, [org_id, r.id]);
        }
        collapsed++;
      }
      if (collapsed) console.log(`collapsed duplicate settings rows for ${collapsed} org(s)`);
    } catch (e) { console.warn("settings-dedupe skipped:", e.message); }
    /* Waiter calls are ephemeral notifications, but nothing on the server
       ever expired them — every call ever raised sat deleted=false forever
       and re-appeared on the till whenever it reloaded. Soft-delete any
       older than 6 hours so a fresh till never shows a backlog of stale
       (or already-handled) calls. Runs on every boot; the till picks up the
       deletions on its next pull. Handled calls are also deleted live now
       (see guest-sync-patch #52). */
    try {
      const staleCalls = await bootPool.query(
        "UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE kind='waiterCalls' AND deleted=false AND COALESCE((data->>'t')::bigint, 0) < $1",
        [Date.now() - 6 * 3600 * 1000]);
      if (staleCalls.rowCount) console.log(`expired ${staleCalls.rowCount} stale waiter call(s)`);
    } catch (e) { console.warn("waiter-call cleanup skipped:", e.message); }
    /* The idempotency ledger is append-only and had no retention: ~365k rows a
       year for a 1,000-sale-a-day outlet, growing forever. An op_id only needs
       to be remembered for as long as a client might still retry it, and the
       outbox gives up long before 90 days. Runs at boot and daily after. */
    const pruneOps = async () => {
      try {
        const cutoff = Number(process.env.OPS_RETENTION_DAYS) > 0 ? Number(process.env.OPS_RETENTION_DAYS) : 90;
        const r = await bootPool.query("DELETE FROM ops WHERE applied_at < now() - ($1 || ' days')::interval", [String(cutoff)]);
        if (r.rowCount) console.log(`pruned ${r.rowCount} op ledger row(s) older than ${cutoff}d`);
      } catch (e) { console.warn("ops prune skipped:", e.message); }
    };
    await pruneOps();
    setInterval(pruneOps, 24 * 3600 * 1000).unref();
    /* Recipe deduction runs AFTER the sync commit so a till sale is never
       rejected for an inventory failure — but nothing retried it, so a crash
       between commit and deduction silently skipped the stock movement and the
       comment's promise that "the next audit reconciles" was never scheduled.
       It is idempotent (the ledger's (org_id, ref, ingredient_id) uniqueness),
       so a sweep can simply re-run it for recent sales with no ledger row. */
    const sweepDeductions = async () => {
      try {
        const since = Date.now() - 48 * 3600 * 1000;
        const rows = await bootPool.query(
          `SELECT e.org_id, e.data FROM entities e
             WHERE e.kind='sales' AND NOT e.deleted
               AND COALESCE((e.data->>'t')::numeric,(e.data->>'at')::numeric,(e.data->>'createdAt')::numeric,0) >= $1
               AND jsonb_array_length(COALESCE(e.data->'lines','[]'::jsonb)) > 0
               AND NOT EXISTS (
                 SELECT 1 FROM stock_moves m
                  WHERE m.org_id = e.org_id
                    AND m.ref = (CASE WHEN e.data->>'type'='refund' THEN 'refund:' ELSE 'sale:' END) || e.id)
             LIMIT 500`, [since]);
        if (!rows.rowCount) return;
        const byOrg = new Map();
        for (const r of rows.rows) {
          if (!byOrg.has(r.org_id)) byOrg.set(r.org_id, []);
          byOrg.get(r.org_id).push(r.data);
        }
        let n = 0;
        for (const [orgId, sales] of byOrg) {
          try { await inventory.processSales(orgId, sales); n += sales.length; } catch (e) { recordError("sweepDeductions " + orgId, e); }
        }
        /* Most of these are sales for products with no recipe, which legitimately
           never produce a ledger row; the sweep is idempotent either way. */
        if (n) console.log(`reconciled ${n} sale(s) with no ingredient ledger entry`);
      } catch (e) { console.warn("deduction sweep skipped:", e.message); }
    };
    setTimeout(sweepDeductions, 30000).unref();
    setInterval(sweepDeductions, 30 * 60 * 1000).unref();
    /* One-time cleanup: retire the previous starter menu (ids p1–p19 / ow01–ow69)
       so outlets that carried it don't end up with the old and new starter menus
       side by side. Soft-deletes only still-live copies, so it's a no-op once
       done and never touches an outlet's own custom products (which use random
       ids). The new starter menu is seeded by the backfill just below. */
    try {
      const legacyIds = ["p1", "p2", "p3", "p4", "p5", "p6", "p8", "p9", "p10", "p11", "p12", "p13", "p14", "p15", "p16", "p17", "p18", "p19"]
        .concat(Array.from({ length: 69 }, (_, i) => "ow" + String(i + 1).padStart(2, "0")));
      const r = await bootPool.query(
        "UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE kind='products' AND deleted=false AND id = ANY($1)",
        [legacyIds]);
      if (r.rowCount) console.log(`retired ${r.rowCount} legacy starter-menu item(s) across outlets`);
      // Outlets still on the previous starter category tree (its unmistakable
      // Main Dishes + Bakery + Grocery signature) get the new colour-coded
      // groups so the new items land in the right sections. A back office that
      // renamed/rebuilt its categories no longer matches, so it's left alone.
      const g = await bootPool.query(
        `UPDATE entities SET data = jsonb_set(jsonb_set(data,'{catGroups}',$1::jsonb),'{catOrder}',$2::jsonb),
             rowver=nextval('entities_rowver_seq'), updated_at=now()
         WHERE kind='settings' AND data->'catGroups' @> '[{"name":"Main Dishes"}]'
           AND data->'catGroups' @> '[{"name":"Bakery"}]' AND data->'catGroups' @> '[{"name":"Grocery"}]'`,
        [JSON.stringify(CAT_GROUPS), JSON.stringify(CAT_ORDER)]);
      if (g.rowCount) console.log(`migrated ${g.rowCount} outlet(s) to the new menu categories`);
    } catch (e) { console.warn("legacy starter-menu cleanup skipped:", e.message); }
    /* One-time platform reset (owner request, "every store including existing
       users"): clear EVERY store's dishes and lay down the sample category
       sections, so existing stores match the new default — a clean, empty,
       categorised menu — not only newly-onboarded ones. Guarded by a claim row
       in app_migrations so it runs EXACTLY ONCE across all instances and is never
       repeated (a store that later adds its own dishes is never re-wiped). The
       claim + the wipe + the seed share one transaction, so a crash mid-run rolls
       the claim back and a later boot retries cleanly rather than leaving stores
       half-cleared with the flag already set. Past orders keep their own line
       snapshots; only the live `products` menu is tombstoned. */
    try {
      await bootPool.query("CREATE TABLE IF NOT EXISTS app_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      const mc = await bootPool.connect();
      try {
        await mc.query("BEGIN");
        const claim = await mc.query("INSERT INTO app_migrations (id) VALUES ('menu_reset_all_v1') ON CONFLICT DO NOTHING RETURNING id");
        if (claim.rowCount) {
          const wiped = await mc.query("UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE kind='products' AND deleted=false");
          const catGroup = {};
          (CAT_GROUPS || []).forEach((grp) => (grp.subs || []).forEach((s) => { catGroup[s] = grp.name; }));
          const patch = JSON.stringify({ menuCats: (CAT_ORDER || []).slice(), catGroup, catGroups: CAT_GROUPS, catOrder: (CAT_ORDER || []).slice() });
          // One statement seeds/merges the sample categories onto every org's
          // settings — inserting the row where a store never had one, reviving a
          // tombstoned one, and overwriting catOrder/catGroups/menuCats/catGroup
          // where one exists (the reset intent: every store → sample categories).
          const seeded = await mc.query(
            "INSERT INTO entities (org_id, kind, id, data, rowver) " +
            "SELECT o.id, 'settings', 'settings', $1::jsonb, nextval('entities_rowver_seq') FROM orgs o " +
            "ON CONFLICT (org_id, kind, id) DO UPDATE " +
            "SET data = COALESCE(entities.data,'{}'::jsonb) || $1::jsonb, deleted=false, " +
            "rowver=nextval('entities_rowver_seq'), updated_at=now()", [patch]);
          await mc.query("COMMIT");
          console.log(`menu_reset_all_v1: cleared ${wiped.rowCount} dish(es), seeded sample categories on ${seeded.rowCount} store(s)`);
        } else {
          await mc.query("ROLLBACK");
        }
      } catch (e) { try { await mc.query("ROLLBACK"); } catch (_) { /* already unwound */ } throw e; }
      finally { mc.release(); }
    } catch (e) { console.warn("menu_reset_all_v1 migration skipped:", e.message); }
    /* One-time platform seed (owner request, follow-up to the reset): populate
       every store's now-empty sample categories with the 300-dish sample menu, so
       the till isn't blank — owners edit or delete what they don't want. Same
       once-only claim guard + single transaction as the reset. Each dish carries a
       stable id, so it lands as one row per store; a tombstoned copy from the
       reset is revived (deleted=false) rather than duplicated. Dish `cat` names
       match the seeded CAT_ORDER exactly, so every dish lands in an existing
       section. */
    try {
      const mc2 = await bootPool.connect();
      try {
        await mc2.query("BEGIN");
        const claim = await mc2.query("INSERT INTO app_migrations (id) VALUES ('menu_seed_all_v1') ON CONFLICT DO NOTHING RETURNING id");
        if (claim.rowCount) {
          // recipe:[] is guaranteed on every sample item; store each verbatim.
          const menuJson = JSON.stringify((DEFAULT_MENU || []).map((d) => Object.assign({ recipe: [] }, d)));
          const seeded = await mc2.query(
            "INSERT INTO entities (org_id, kind, id, data, rowver) " +
            "SELECT o.id, 'products', d->>'id', d, nextval('entities_rowver_seq') " +
            "FROM orgs o, jsonb_array_elements($1::jsonb) AS d " +
            "ON CONFLICT (org_id, kind, id) DO UPDATE " +
            "SET data=excluded.data, deleted=false, rowver=nextval('entities_rowver_seq'), updated_at=now()", [menuJson]);
          await mc2.query("COMMIT");
          console.log(`menu_seed_all_v1: loaded ${DEFAULT_MENU.length}-dish sample menu (${seeded.rowCount} row(s) across all stores)`);
        } else {
          await mc2.query("ROLLBACK");
        }
      } catch (e) { try { await mc2.query("ROLLBACK"); } catch (_) { /* already unwound */ } throw e; }
      finally { mc2.release(); }
    } catch (e) { console.warn("menu_seed_all_v1 migration skipped:", e.message); }
    /* Ensure every existing outlet carries the shared starter menu with its
       photos. Idempotent (ensureDefaultMenu only writes when an image is
       missing or changed), so this is a no-op on subsequent boots. New outlets
       get the same menu at registration. */
    /* The starter menu is now OPT-IN, not force-applied. New stores get it at
       registration (the sample-menu choice); an existing store adds or resets to
       it on demand from Menu Master → "Load default menu". We deliberately do NOT
       backfill every outlet on boot any more — that would inject the full
       300-dish catalogue into stores that run their own menu. */
  } catch (e) { console.error("schema init failed:", e.message); }
  finally { bootClient.release(); }
  /* Cross-instance SSE fan-out (ARCH-01). Started after boot init + lock release,
     and independent of it, so a node still relays pokes even if a backfill hiccups. */
  if (!pool) { pool = new Pool(appPoolConfig()); pool.on("error", (e) => console.error("app pool error:", errDetail(e))); }
  if (!bgPool) { bgPool = new Pool(bgPoolConfig()); bgPool.on("error", (e) => console.error("bg pool error:", errDetail(e))); }
  startPokeListener();
})();

const app = express();
/* Behind Railway's proxy the real client IP rides X-Forwarded-For; trust one
   hop so req.ip is the client (needed by the login throttle below), not the
   proxy. Locally, with no proxy, this falls back to the socket address. */
app.set("trust proxy", 1);
/* gzip/deflate every compressible response. The register/admin HTML ships a
   large inline shell plus injected menu + image data, and the JS bundles are
   hundreds of KB — compression cuts the transfer ~5-8x, the biggest single
   win for /app load time. SSE (text/event-stream on /api/events, /p/:slug/events)
   must NOT be buffered, so skip it explicitly; compressible's type list already
   excludes it, and honouring a Cache-Control:no-transform lets any handler opt
   out too. */
app.use(compression({
  filter: (req, res) => {
    const ct = String(res.getHeader("Content-Type") || "");
    if (ct.includes("text/event-stream")) return false;
    return compression.filter(req, res);
  },
}));

/* ── Security headers (audit SEC-01) ─────────────────────────────────────────
   The app had no CSP, framing, or MIME hardening. The script/connect/frame
   allow-lists are the exact third parties the app loads: Google + Apple sign-in
   SDKs and the till's tesseract.js OCR fallback. Inline scripts/styles still
   need 'unsafe-inline' because the till is a prebuilt minified bundle with many
   inline blocks; the remaining directives (frame-ancestors, object-src, base-uri,
   a locked-down connect-src) still meaningfully shrink the attack surface. */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' https://accounts.google.com https://appleid.cdn-apple.com https://cdn.jsdelivr.net",
  "connect-src 'self' https://accounts.google.com https://appleid.apple.com",
  "frame-src 'self' https://accounts.google.com https://appleid.apple.com",
  "form-action 'self' https://appleid.apple.com",
  "frame-ancestors 'none'",
].join("; ");
app.use((req, res, next) => {
  res.set("Content-Security-Policy", CSP);
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (process.env.NODE_ENV === "production") res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

/* ── Login throttle (audit SEC-02) ───────────────────────────────────────────
   In-memory, single-instance (same trade-off as the SSE hub). Counts FAILED
   attempts per client IP and per account; after RL_MAX failures inside the
   window the key is blocked for RL_BLOCK. A successful login clears the
   counters, so honest users are never throttled. Per-account keying (not just
   IP, which is proxy-spoofable) is what actually protects a specific login. */
const loginFails = new Map();
const RL_WINDOW = 15 * 60 * 1000, RL_MAX = 8, RL_BLOCK = 15 * 60 * 1000;
setInterval(() => { const now = Date.now(); for (const [k, v] of loginFails) if (now > v.until && now > v.reset) loginFails.delete(k); }, 5 * 60 * 1000).unref();
const rlKeys = (req, email) => ["ip:" + (req.ip || "?")].concat(email ? ["acct:" + String(email).toLowerCase()] : []);
const rlBlockedFor = (keys) => keys.reduce((mx, k) => { const e = loginFails.get(k); const now = Date.now(); return e && e.until > now ? Math.max(mx, Math.ceil((e.until - now) / 1000)) : mx; }, 0);
const rlFail = (keys) => { const now = Date.now(); for (const k of keys) { let e = loginFails.get(k); if (!e || now > e.reset) e = { n: 0, reset: now + RL_WINDOW, until: 0 }; e.n++; if (e.n >= RL_MAX) e.until = now + RL_BLOCK; loginFails.set(k, e); } };
const rlClear = (keys) => { for (const k of keys) loginFails.delete(k); };
const rlDeny = (res, secs) => { res.set("Retry-After", String(secs)); return res.status(429).json({ error: `Too many attempts — try again in ${Math.max(1, Math.ceil(secs / 60))} min.` }); };

/* ── Public-endpoint throttle (audit B1) ─────────────────────────────────────
   The guest order/waiter-call endpoints are unauthenticated, so an anonymous
   client could otherwise flood the kitchen queue and grow the DB without
   bound. Count EVERY hit per client IP + workspace slug + route in a rolling
   window and reject past a ceiling. In-memory / single-instance (same trade-off
   as the SSE hub and login throttle); a real multi-instance deploy would move
   this to the shared store already used for poke fan-out. Ceilings are set well
   above what a single venue's guests generate (even behind one NAT IP) but far
   below what a flood script does. */
const pubHits = new Map();
const PUB_WINDOW = 60 * 1000;
setInterval(() => { const now = Date.now(); for (const [k, v] of pubHits) if (now > v.reset) pubHits.delete(k); }, 5 * 60 * 1000).unref();
const pubThrottle = (max, label) => (req, res, next) => {
  const key = (req.ip || "?") + "|" + (req.params.slug || "?") + "|" + label;
  const now = Date.now();
  let e = pubHits.get(key);
  if (!e || now > e.reset) { e = { n: 0, reset: now + PUB_WINDOW }; pubHits.set(key, e); }
  e.n++;
  if (e.n > max) { res.set("Retry-After", String(Math.max(1, Math.ceil((e.reset - now) / 1000)))); return res.status(429).json({ error: "Too many requests — please slow down and try again in a minute." }); }
  next();
};

/* Correlation ID (audit OPS-02): every request gets a short id, echoed on the
   response and threaded into error logs + the audit trail, so an incident can be
   traced from a support report to the exact request. */
app.use((req, res, next) => {
  req.id = String(req.headers["x-request-id"] || crypto.randomBytes(6).toString("hex")).slice(0, 32);
  res.set("X-Request-Id", req.id);
  next();
});
/* Body-size limits (audit API-02): OCR ships a base64 photo and needs room; the
   sync and everything else are capped tightly to shrink the abuse surface. The
   per-path OCR parser runs first for its route, so the tight global one skips
   it (Express marks the body parsed). */
app.use("/api/inv/ocr", express.json({ limit: "25mb" }));
app.use(express.json({ limit: "4mb" }));
/* CORS is only for the cross-origin surface: the sync API and the public
   guest endpoints. A paired till PWA can be served from a different origin
   than the cloud it syncs to, and both authenticate with a Bearer token
   (cookies are never read cross-origin), so a wildcard is safe there. Set
   ALLOWED_ORIGINS to a comma-separated allow-list to lock it down to known
   origins instead. The cookie-gated pages (/app, /back, /dev, /login…) are
   navigated to directly and deliberately get no CORS headers at all. */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
/* AUDIT-S4: the "cookie-gated pages get no CORS headers" reasoning above
   describes /app, /back, /dev, /login (full-page navigations, never under
   /api) — it does NOT cover /api/app2/*, /api/back/*, /api/onboard/*, which
   ARE under /api and ARE cookie-authenticated (resolveAppSession reads
   APP_COOKIE). Those got the wildcard fallback too whenever ALLOWED_ORIGINS
   was unset, contradicting the stated "both authenticate with a Bearer
   token" safety claim for exactly that surface. Only same-origin sending the
   session cookie is safe today via SameSite=Lax, but the DEFAULT posture
   should not depend on that alone — never wildcard for the cookie-gated API
   prefixes, regardless of ALLOWED_ORIGINS. */
const COOKIE_AUTH_PREFIXES = ["/api/app2", "/api/back", "/api/onboard"];
app.use((req, res, next) => {
  if (!req.path.startsWith("/api") && !req.path.startsWith("/p/")) return next();
  const origin = req.headers.origin;
  const cookieGated = COOKIE_AUTH_PREFIXES.some((p) => req.path.startsWith(p));
  if (allowedOrigins.length) {
    if (origin && allowedOrigins.includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
    }
    /* origin absent or not on the list → no ACAO header, so a browser blocks
       the cross-origin read while same-origin calls are unaffected. */
  } else if (!cookieGated) {
    res.set("Access-Control-Allow-Origin", "*");
  }
  // else: ALLOWED_ORIGINS unset AND this is a cookie-authenticated API prefix
  // → no ACAO header at all, same as the cookie-gated pages already get.
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use((req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/p/")) res.set("Cache-Control", "no-store");
  next();
});

const uid = () => crypto.randomUUID();
const slugify = (s) => (s || "shop").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "shop";
// Handles (orgs.slug) that must stay the platform's own — the guest storefront's
// `?s=<handle>` / `<handle>.<domain>` address can't be one of these. Used both by
// the manual rename endpoint and when a handle is auto-derived from the store name.
const RESERVED_HANDLES = new Set(["www", "app", "admin", "api", "p", "v2", "back", "welcome", "signup", "login", "logout", "assets", "static", "vendor", "img", "mail", "smtp", "ftp", "ns", "cdn", "status", "help", "support", "docs", "blog", "store", "shop", "portal", "order", "kashikeyo", "kashikeyopos"]);
const errDetail = (e) => [e && e.message, e && e.code, e && e.address, e && e.port].filter(Boolean).join(" ") || String(e || "unknown error");
const idEq = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const cleanStoreId = (v) => slugify(v || DEFAULT_STORE_ID) || DEFAULT_STORE_ID;
const opStore = (req, op = {}) => cleanStoreId(op.storeId || req.body?.storeId || req.org?.s || DEFAULT_STORE_ID);
const entityStore = (data) => cleanStoreId(data && data.storeId ? data.storeId : "global");
const isVisibleInStore = (data, storeId) => {
  const s = entityStore(data || {});
  return s === "global" || s === cleanStoreId(storeId);
};
/* store-scoping lives entirely in data.storeId (see isVisibleInStore below) —
   the physical entities.id column always stays the raw entity id, otherwise
   every edit to a row written before store-scoping existed forks it into a
   second, stale copy instead of updating it in place. */
const publicId = (row) => String(row.data && row.data.id ? row.data.id : row.id).split(":").pop();

/* ── Server-side money integrity (audit FIN-01) ──────────────────────────────
   A settled sale is authored on the till, which is offline-first, so we must
   NEVER reject a completed sale at sync (that would lose money the cashier has
   already taken). Instead we independently re-check its arithmetic at ingestion
   and, on any inconsistency, stamp data.serverAudit so the record is accepted
   but flagged for manager review. The checks are false-positive-resistant:
   they reconcile the sale against ITS OWN declared components (no dependency on
   server settings) plus a catalogue price-floor and the server GST rate.
     lineTotal = round(price * qty * (1 - discPct/100))     (mirrors the till's Un)
     total     = subtotal - billDisc + gst + svcCharge      (mirrors the till's $n) */
/* A till that sends an explicit line amount is authoritative: it rounded the
   line once, where multiplying its rounded per-unit price back out drifts by a
   few laari (three items at MVR 45.00 de-gross to 41.666… each). Older sales
   carry only price/qty, so the multiply-back stays as the fallback. */
const saleLineTotal = (l) => (l && Number.isFinite(Number(l.amount))
  ? Math.round(Number(l.amount))
  : Math.round((Number(l && l.price) || 0) * (Number(l && l.qty) || 0) * (1 - (Number(l && l.discPct) || 0) / 100)));
/* Effective discount as a percent of the sale's own gross (line price × qty,
   before any discount), combining per-line discPct and the bill-level discount
   — used by the B3 large-discount backstop below. Reads only the sale's own
   declared components, so it's independent of server settings. */
const effectiveDiscountPct = (sale) => {
  const lines = Array.isArray(sale && sale.lines) ? sale.lines : [];
  const gross = lines.reduce((a, l) => a + (Number(l && l.price) || 0) * (Number(l && l.qty) || 0), 0);
  if (gross <= 0) return 0;
  const lineDisc = Math.max(0, gross - lines.reduce((a, l) => a + saleLineTotal(l), 0));
  const billDisc = Math.max(0, Number(sale.billDisc) || 0);
  return Math.round(((lineDisc + billDisc) / gross) * 100);
};
function auditSaleMoney(sale, ctx) {
  if (!sale || sale.foc) return null;                       // free-of-charge is legitimately 0
  if (sale.type && sale.type !== "sale") return null;       // refunds derive from their original; validated by linkage
  const lines = Array.isArray(sale.lines) ? sale.lines : [];
  if (!lines.length) return null;
  const num = (v) => Number(v) || 0;
  const fee = num(sale.fee), billDisc = num(sale.billDisc), gst = num(sale.gst), svc = num(sale.svcCharge);
  const subtotal = num(sale.subtotal), total = num(sale.total);
  const tol = (base) => Math.max(5, Math.round(Math.abs(base) * 0.01)); // 1% or 0.05 MVR, absorbs rounding
  const reasons = [];
  const linesSum = lines.reduce((a, l) => a + saleLineTotal(l), 0) + fee;
  if (Math.abs(linesSum - subtotal) > tol(linesSum)) reasons.push(`subtotal ${subtotal} != lines ${linesSum}`);
  const compTotal = subtotal - billDisc + gst + svc;
  if (Math.abs(compTotal - total) > tol(compTotal)) reasons.push(`total ${total} != components ${compTotal}`);
  if (ctx && ctx.gstBp) {
    const billDiscPct = num(sale.billDiscPct);
    const taxable = lines.reduce((a, l) => (l && l.taxable === false ? a : a + saleLineTotal(l)), 0) + fee;
    const rate = (t) => Math.round(Math.round(t * (1 - billDiscPct / 100)) * ctx.gstBp / 1e4);
    // Service charge is itself taxable under Maldives GGST/TGST, so a till that
    // taxes (goods + service) is as valid as one that taxes goods only. Accept
    // gst that matches either base; only a mismatch against both is flagged.
    const expGst = rate(taxable), expWithSvc = rate(taxable + svc);
    const gstTol = (e) => Math.max(5, Math.round(e * 0.02));
    if (Math.abs(expGst - gst) > gstTol(expGst) && Math.abs(expWithSvc - gst) > gstTol(expWithSvc)) {
      reasons.push(`gst ${gst} != rate-expected ${expGst}`);
    }
  }
  if (ctx && ctx.prices) {
    // A tax-inclusive till books line prices net of GST (catalogue ÷ (1+rate)),
    // so the legitimate floor is the tax-exclusive equivalent of the catalogue
    // price, not the catalogue price itself. Genuine underpricing below that
    // floor is still flagged.
    const floorOf = (p) => ctx.gstBp ? Math.round(p / (1 + ctx.gstBp / 1e4)) : p;
    for (const l of lines) {
      const prod = ctx.prices.get(String(l && l.pid || ""));
      if (prod && !prod.open && prod.price > 0 && (Number(l.price) || 0) < floorOf(prod.price) - 1) {
        reasons.push(`line ${l.pid} price ${l.price} below catalogue ${prod.price}`);
      }
    }
  }
  if (!reasons.length) return null;
  return { flagged: true, at: Date.now(), claimedTotal: total, computedTotal: compTotal, reasons };
}

const UIFIX_JS = '(function(){\n/* Two things the operator could not see.\n *\n * 1. Broken product images. The starter menu ships remote photo URLs, and the\n *    tile decides whether it has an image at render time with no error path —\n *    so on a metered or dropped connection the whole grid became the browser\'s\n *    broken-image glyph, on the register and on the diner\'s phone alike. The\n *    app already has a lettered fallback tile; it just never got used. On an\n *    image error we draw that fallback in place.\n *\n * 2. No loading state anywhere: not on boot, not while a modal action ran, not\n *    on Charge or Confirm or Close day. The only recourse was to tap again. A\n *    thin progress bar shows whenever a write is in flight. */\nvar PAL=[\'#C1492A\',\'#B07714\',\'#1FA65C\',\'#0E6EC6\',\'#C43A78\',\'#7A5AF8\',\'#0F766E\'];\nfunction initial(el){\n  var alt=el.getAttribute(\'alt\')||\'\';\n  var t=(alt||el.getAttribute(\'data-name\')||\'\').trim();\n  if(!t){var card=el.closest(\'div\');var txt=card?(card.textContent||\'\').trim():\'\';t=txt;}\n  return (t.charAt(0)||\'?\').toUpperCase();\n}\nfunction swap(el){\n  if(el.getAttribute(\'data-fellback\'))return;\n  /* An unresolved template binding ("{{ d.src }}") is not a missing photo — it\n     is a slot with no data yet. Hide it rather than invent a letter tile. */\n  var raw=el.getAttribute(\'src\')||\'\';\n  if(raw.indexOf(\'{{\')>=0||raw.indexOf(\'%7B%7B\')>=0){el.setAttribute(\'data-fellback\',\'1\');el.style.display=\'none\';return;}\n  el.setAttribute(\'data-fellback\',\'1\');\n  var ch=initial(el);\n  var code=0;for(var i=0;i<ch.length;i++)code+=ch.charCodeAt(i);\n  var bg=PAL[code%PAL.length];\n  var box=document.createElement(\'div\');\n  box.setAttribute(\'aria-hidden\',\'true\');\n  box.style.cssText=\'width:100%;height:100%;display:grid;place-items:center;background:\'+bg+\'22\';\n  var glyph=document.createElement(\'div\');\n  glyph.style.cssText=\'width:52px;height:52px;border-radius:15px;background:\'+bg+\';color:#fff;display:grid;place-items:center;font-weight:800;font-size:23px\';\n  glyph.textContent=ch;\n  box.appendChild(glyph);\n  el.style.display=\'none\';\n  if(el.parentNode)el.parentNode.insertBefore(box,el);\n}\ndocument.addEventListener(\'error\',function(ev){\n  var el=ev.target;\n  if(el&&el.tagName===\'IMG\')swap(el);\n},true);\n\nvar bar=null,inflight=0,hideT=0;\nfunction show(){\n  if(!bar){\n    bar=document.createElement(\'div\');\n    bar.setAttribute(\'aria-hidden\',\'true\');\n    bar.style.cssText=\'position:fixed;top:0;left:0;height:3px;width:0;z-index:99998;background:currentColor;color:#C1492A;transition:width .25s ease,opacity .3s;pointer-events:none\';\n    document.body.appendChild(bar);\n  }\n  clearTimeout(hideT);\n  bar.style.opacity=\'1\';\n  bar.style.width=\'72%\';\n}\nfunction done(){\n  if(!bar)return;\n  bar.style.width=\'100%\';\n  hideT=setTimeout(function(){if(bar){bar.style.opacity=\'0\';bar.style.width=\'0\';}},320);\n}\nvar of=window.fetch;\nif(typeof of===\'function\'){\n  window.fetch=function(input,init){\n    var url=\'\';try{url=(typeof input===\'string\')?input:((input&&input.url)||\'\');}catch(e){}\n    var method=\'GET\';try{method=String((init&&init.method)||(input&&input.method)||\'GET\').toUpperCase();}catch(e){}\n    var track=(method!==\'GET\'&&url.indexOf(\'/api/\')===0);\n    if(track){inflight++;show();}\n    var p=of.apply(this,arguments);\n    if(track){\n      var fin=function(){inflight=Math.max(0,inflight-1);if(!inflight)done();};\n      try{p.then(fin,fin);}catch(e){fin();}\n    }\n    return p;\n  };\n}\n})();\n';

const A11Y_JS = '(function(){\n/* Focus containment and Escape. The PIN lock and every modal were plain\n * overlays: pointer clicks were blocked by the backdrop, but Tab walked\n * straight past them into the locked till, so a counter tablet with a USB\n * barcode scanner or keyboard bypassed the PIN gate entirely. Nothing closed\n * on Escape either, and backdrop-dismiss was unsignposted.\n *\n * Implemented as a document-level shim rather than per-modal wiring so it\n * covers the overlays the design tool renders, present and future: anything\n * position:fixed with inset:0 and a high z-index is treated as modal, topmost\n * wins, and focus is kept inside it. */\nvar SEL=\'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])\';\nfunction overlays(){\n  var out=[];\n  var all=document.querySelectorAll(\'div\');\n  for(var i=0;i<all.length;i++){\n    var el=all[i];\n    /* React serialises inline styles WITH spaces ("position: fixed"), so match\n       on the computed style, not on the attribute text. */\n    var cs=null;try{cs=getComputedStyle(el);}catch(e){}\n    if(!cs)continue;\n    if(cs.position!==\'fixed\')continue;\n    if(cs.display===\'none\'||cs.visibility===\'hidden\')continue;\n    var r=el.getBoundingClientRect();\n    if(r.width<window.innerWidth*0.5||r.height<window.innerHeight*0.5)continue;\n    var z=parseInt(cs.zIndex,10)||0;\n    if(z<30)continue;\n    if(!el.querySelector(SEL))continue;\n    out.push({el:el,z:z});\n  }\n  out.sort(function(a,b){return a.z-b.z;});\n  return out;\n}\nfunction top(){var o=overlays();return o.length?o[o.length-1].el:null;}\ndocument.addEventListener(\'keydown\',function(ev){\n  var t=top();\n  if(!t)return;\n  if(ev.key===\'Escape\'){\n    /* The lock is not dismissible — that is the point of it. */\n    if(t.getAttribute(\'data-modal\')===\'lock\')return;\n    var close=t.querySelector(\'[aria-label="Close"],[data-close]\');\n    if(close){ev.preventDefault();close.click();}\n    return;\n  }\n  if(ev.key!==\'Tab\')return;\n  var f=[].slice.call(t.querySelectorAll(SEL)).filter(function(el){\n    return el.offsetWidth>0||el.offsetHeight>0||el===document.activeElement;});\n  if(!f.length)return;\n  var first=f[0],last=f[f.length-1];\n  if(!t.contains(document.activeElement)){ev.preventDefault();first.focus();return;}\n  if(ev.shiftKey&&document.activeElement===first){ev.preventDefault();last.focus();}\n  else if(!ev.shiftKey&&document.activeElement===last){ev.preventDefault();first.focus();}\n},true);\n/* When an overlay appears, move focus into it. */\nfunction claim(){\n  var t=top();\n  if(!t)return;\n  if(t.contains(document.activeElement))return;\n  var f=t.querySelector(SEL);\n  if(f){try{f.focus();}catch(e){}}\n}\ntry{new MutationObserver(function(){clearTimeout(claim._t);claim._t=setTimeout(claim,120);})\n  .observe(document.documentElement,{childList:true,subtree:true});}catch(e){}\nsetTimeout(claim,800);\n})();\n';

/* Failed writes used to vanish. Thirty-four fetches across the register and
   the back office were `.catch(function(){})` with no r.ok check — shift
   open/close, deliveries, waste, expenses, store config and every menu edit
   could fail (including on an HTTP 403 from the role gate) into a UI that
   reported success. A manager editing a product saw the row update and
   nothing was saved. Rather than trust 34 call sites to remember, this shim
   wraps fetch once and surfaces any non-GET /api/ failure to the operator.
   Paths that report their own errors inline (ops/elevate/unlock/seq/pull)
   are skipped so nothing is reported twice. */
/* Offline shell for the register (audit A-C1). /app was network-only: a
   reload during an ISP drop replaced the till with the browser's error
   page and there was no path back to selling until the link returned. The
   worker is network-first, so it can never pin a stale bundle across a
   fleet — it only serves the cached shell when the network actually fails.
   Registered on the register alone; /admin and the guest portal stay
   purely network-served. */
const SW_REG_JS = "try{if('serviceWorker' in navigator)window.addEventListener('load',function(){navigator.serviceWorker.register('/app/sw.js',{scope:'/app'}).catch(function(){});});}catch(e){}";

const NETERR_JS = "(function(){\nvar SKIP=/\\/api\\/(ops|elevate|app2\\/(unlock|seq|pull))/;\nvar box=null,timer=0;\nfunction show(msg){\n  try{\n    if(!box){\n      box=document.createElement('div');\n      box.setAttribute('role','alert');\n      box.style.cssText='position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:99999;max-width:min(560px,92vw);background:#8A2B12;color:#FFF;border-radius:13px;padding:13px 17px;font:700 13.5px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.28);cursor:pointer';\n      box.onclick=function(){if(box)box.style.display='none';};\n      document.body.appendChild(box);\n    }\n    box.textContent=msg;\n    box.style.display='block';\n    if(timer)clearTimeout(timer);\n    timer=setTimeout(function(){if(box)box.style.display='none';},9000);\n  }catch(e){}\n}\nwindow.__ksNetError=show;\nvar of=window.fetch;\nif(typeof of!=='function')return;\nwindow.fetch=function(input,init){\n  var url='';\n  try{url=(typeof input==='string')?input:((input&&input.url)||'');}catch(e){}\n  var method='GET';\n  try{method=String((init&&init.method)||(input&&input.method)||'GET').toUpperCase();}catch(e){}\n  var p=of.apply(this,arguments);\n  try{\n    if(method!=='GET'&&url.indexOf('/api/')===0&&!SKIP.test(url)){\n      p.then(function(r){\n        if(r&&!r.ok){\n          r.clone().json().then(function(j){show((j&&j.error)||('Not saved — the server refused this ('+r.status+')'));},\n                                function(){show('Not saved — the server refused this ('+r.status+')');});\n        }\n      },function(){show('No connection — that change was NOT saved. Try again.');});\n    }\n  }catch(e){}\n  return p;\n};\n})();\n";

/* The register's durable sale outbox, injected into /app. Kept as a plain
   string so it can be served inline under the page CSP (no external script).
   See the pushSaleJs comment below for why this exists. */
const OUTBOX_JS = "(function(){\nvar KEY='kashikeyo_outbox';\nvar q=[];try{var raw=localStorage.getItem(KEY);if(raw){var p=JSON.parse(raw);if(Array.isArray(p))q=p;}}catch(e){}\nvar subs=[],busy=false,timer=0,delay=2000,lastOk=Number(localStorage.getItem('kashikeyo_outbox_ok'))||0,lastErr='',lastDropped=[];\nfunction save(){try{localStorage.setItem(KEY,JSON.stringify(q.slice(0,500)));}catch(e){}}\nfunction notify(){for(var i=0;i<subs.length;i++){try{subs[i](status());}catch(e){}}}\nfunction status(){return {pending:q.length,lastOk:lastOk,lastErr:lastErr,oldest:q.length?q[0].at:0,dropped:lastDropped};}\nfunction pendingSales(){return q.map(function(it){try{return it.body.ops[0].puts[0].data;}catch(e){return null;}}).filter(Boolean);}\nfunction schedule(ms){if(timer)return;timer=setTimeout(function(){timer=0;flush();},ms);}\nfunction flush(){\n  if(busy||!q.length)return Promise.resolve(status());\n  busy=true;\n  var item=q[0];\n  var hdrs={'Content-Type':'application/json','Authorization':'Bearer '+window.__ksToken};\n  if(item.headers)for(var hk in item.headers)hdrs[hk]=item.headers[hk];\n  return fetch('/api/ops',{method:'POST',headers:hdrs,body:JSON.stringify(item.body)})\n    .then(function(r){\n      if(r.ok){q.shift();save();lastOk=Date.now();lastErr='';try{localStorage.setItem('kashikeyo_outbox_ok',String(lastOk));}catch(e){}delay=2000;\n        /* AUDIT-MED-CONFLICT: the server's staleness guard can keep the stored\n           (newer) copy over this device's push with no other signal — surface\n           that here instead of letting this device's local copy quietly\n           diverge until its next scheduled pull notices on its own. */\n        r.json().then(function(j){if(j&&Array.isArray(j.dropped)&&j.dropped.length)lastDropped=j.dropped;notify();if(q.length)schedule(150);}).catch(function(){notify();if(q.length)schedule(150);});\n        return;}\n      /* 4xx other than 401/408/429 means this batch will never be accepted as\n         written — keep it (money is never silently dropped) but stop hammering\n         and surface it, so the operator can be told the sale needs attention. */\n      lastErr='HTTP '+r.status;item.tries=(item.tries||0)+1;save();notify();\n      delay=Math.min(60000,Math.max(4000,delay*2));schedule(delay);\n    })\n    .catch(function(){lastErr='offline';item.tries=(item.tries||0)+1;save();notify();delay=Math.min(60000,delay*2);schedule(delay);})\n    .then(function(){busy=false;return status();});\n}\nwindow.__ksOutbox={\n  status:status,\n  pendingSales:pendingSales,\n  flush:function(){delay=2000;return flush();},\n  subscribe:function(fn){subs.push(fn);return function(){subs=subs.filter(function(x){return x!==fn;});};},\n  clearDropped:function(){lastDropped=[];notify();}\n};\n/* A completed sale is money the cashier has already taken. It goes into a\n   durable queue FIRST and is retried until the server acknowledges it — the old\n   implementation was a bare fetch().catch(function(){}), so a two-second WiFi\n   dropout destroyed the sale with no trace and no warning to anyone. */\nwindow.__ksPushSale=function(sale,deltas,headers){\n  try{\n    var op={opId:'app2-'+sale.id,puts:[{kind:'sales',id:sale.id,data:sale}]};\n    if(deltas)op.deltas=deltas;\n    q.push({at:Date.now(),tries:0,body:{ops:[op]},headers:headers||null});\n    save();notify();flush();\n  }catch(e){}\n  return status();\n};\n/* Also used for non-sale register writes that must survive a dropout. */\nwindow.__ksPushOp=function(opId,puts,dels){\n  try{var op={opId:opId};if(puts)op.puts=puts;if(dels)op.dels=dels;\n    q.push({at:Date.now(),tries:0,body:{ops:[op]}});save();notify();flush();}catch(e){}\n  return status();\n};\ntry{window.addEventListener('online',function(){delay=2000;flush();});}catch(e){}\nsetInterval(function(){if(q.length)flush();},15000);\nif(q.length)flush();\n})();\n";

/* Receipt numbering (FIN-C3 / MIRA sequential numbering).
   The old scheme was `nextSeq = COUNT(sales) + 1`, computed fresh on every page
   load. Two things went wrong with that: soft-deleting a sale made the count go
   DOWN, so the next receipt reused a number that had already been handed to a
   customer; and every terminal on the same register computed the identical
   number, so two tills printed the same receipt no. to two different people.
   A receipt number has to come from an allocation the database owns, per
   (org, store, register). Terminals draw a small block up front and never hand
   numbers back — so a number is issued at most once, ever, including offline.
   Gaps (an unfinished block, a reload) are acceptable and explicable; reuse is
   not. The seed on first allocation clears any numbers the old COUNT scheme
   already issued so we can't collide with history. */
async function allocReceiptBlock(c, orgId, storeId, register, count) {
  const n = Math.max(1, Math.min(200, Number(count) || 1));
  /* Seed past whatever the old COUNT(*) scheme already issued, per outlet — a
     new branch should start near 1, not inherit the head office's count. */
  const seedRow = await c.query(
    "SELECT count(*)::int AS n FROM entities WHERE org_id=$1 AND kind='sales' AND deleted=false AND COALESCE(data->>'storeId',$2)=$2", [orgId, storeId]);
  const seed = Number(seedRow.rows[0].n) || 0;
  const r = await c.query(
    `INSERT INTO receipt_seq (org_id, store_id, register, n) VALUES ($1,$2,$3,$4::bigint + $5::bigint)
     ON CONFLICT (org_id, store_id, register) DO UPDATE SET n = receipt_seq.n + $4::bigint, updated_at = now()
     RETURNING n`, [orgId, storeId, register, n, seed]);
  const end = Number(r.rows[0].n) || n;
  return { from: end - n + 1, to: end };
}
/* Read-only: what the next number WOULD be, for display before the register has
   drawn a block. Never advances the counter. */
async function peekReceiptSeq(c, orgId, storeId, register) {
  const r = await c.query(
    "SELECT n FROM receipt_seq WHERE org_id=$1 AND store_id=$2 AND register=$3", [orgId, storeId, register]);
  if (r.rowCount) return Number(r.rows[0].n) + 1;
  const s = await c.query(
    "SELECT count(*)::int AS n FROM entities WHERE org_id=$1 AND kind='sales' AND deleted=false AND COALESCE(data->>'storeId',$2)=$2", [orgId, storeId]);
  return (Number(s.rows[0].n) || 0) + 1;
}

/* Real-time fan-out (audit ARCH-01). SSE subscribers are held per-org in this
   in-memory Map, so a poke on one instance only reaches its own clients. To stay
   correct when the app is horizontally scaled, poke() delivers locally AND
   broadcasts over Postgres LISTEN/NOTIFY; every instance's listener relays the
   notification to its local subscribers. Each node tags its own broadcasts with
   INSTANCE_ID so it doesn't double-deliver the ones it already sent locally.
   Single-instance behaviour is unchanged (local delivery is immediate). */
const INSTANCE_ID = crypto.randomUUID();
const POKE_CHANNEL = "kashikeyo_poke";
const hubs = new Map();
const localPoke = (orgId, rowver) => {
  const set = hubs.get(orgId);
  if (!set) return;
  /* The rowver doubles as the event id, so a client that reconnects can tell
     the server where it left off via Last-Event-ID. */
  const frame = `id: ${Number(rowver) || 0}\ndata: ${JSON.stringify({ rowver })}\n\n`;
  /* Guest streams are unauthenticated — anyone holding a public store slug can
     open one. They get a bare nudge instead: the portal ignores the payload
     and just re-polls its own orders, so the rowver was pure leakage, a live
     read on how busy the store is to anyone who scanned a table QR once. */
  const guestFrame = "data: {\"poke\":1}\n\n";
  for (const res of set) { try { res.write(res.__guest ? guestFrame : frame); } catch {} }
};
const poke = (orgId, rowver) => {
  localPoke(orgId, rowver);
  /* Best-effort cross-instance broadcast; if the DB round-trip fails, local
     clients were already served and remote ones fall back to /api/pull. */
  pool.query("SELECT pg_notify($1,$2)", [POKE_CHANNEL, JSON.stringify({ o: String(orgId), r: Number(rowver), i: INSTANCE_ID })]).catch(() => {});
};
/* Dedicated long-lived LISTEN connection; relays other instances' pokes to our
   local subscribers, and self-heals on connection drop. */
async function startPokeListener() {
  const { Client } = require("pg");
  const c = new Client(appDirectPoolConfig());
  c.on("notification", (msg) => {
    if (msg.channel !== POKE_CHANNEL || !msg.payload) return;
    try { const p = JSON.parse(msg.payload); if (p.i !== INSTANCE_ID) localPoke(p.o, Number(p.r)); } catch {}
  });
  c.on("error", (e) => { recordError("poke listener", e); try { c.end(); } catch {} setTimeout(startPokeListener, 2000); });
  try {
    await c.connect();
    await c.query(`LISTEN ${POKE_CHANNEL}`);
    console.log("poke listener connected (LISTEN/NOTIFY cross-instance fan-out)");
  } catch (e) { console.warn("poke listener connect failed, retrying:", e.message); recordError("poke listener connect", e); setTimeout(startPokeListener, 2000); }
}

/* Small in-memory ring buffer the developer panel's health view reads from -
   resets on restart, which is fine for "what's gone wrong recently", not
   meant as a durable audit log. */
const bootedAt = Date.now();
const recentErrors = [];
const recordError = (where, e) => {
  recentErrors.unshift({ t: Date.now(), where, message: errDetail(e) });
  if (recentErrors.length > 50) recentErrors.length = 50;
};

/* Append-only audit trail (FIN-03). Best-effort and non-fatal: an audit write
   must never fail a business operation. Runs inside the caller's org scope. */
async function logActivity(orgId, { actor = "system", action, ref = "", requestId = "", detail = {} }) {
  if (!orgId || !action) return;
  try {
    await withOrg(orgId, (client) => client.query(
      "INSERT INTO activity_log (org_id, actor, action, ref, request_id, detail) VALUES ($1,$2,$3,$4,$5,$6)",
      [String(orgId), String(actor).slice(0, 80), String(action).slice(0, 60), String(ref).slice(0, 80), String(requestId).slice(0, 32), JSON.stringify(detail || {})]));
  } catch (e) { recordError("activity_log " + action, e); }
}

/* SEC-3: token lifetime is configurable and defaults to 90d (down from the old
   365d) — a balance for an offline-first till that may sync infrequently. The
   real teeth are the per-request revocation + org-status recheck on /api/ops
   (see below), which invalidates tokens instantly regardless of TTL. */
const TOKEN_TTL = process.env.TOKEN_TTL || "90d";
const sign = (orgId, register, storeId = DEFAULT_STORE_ID, extra = {}) => jwt.sign({ o: orgId, r: register, s: cleanStoreId(storeId), ...extra }, SECRET, { expiresIn: TOKEN_TTL });
/* Till PIN hash — djb2, byte-identical to the till bundle's Xo() so a staff
   member's existing PIN validates the same on the server. Per SEC-03 the PIN is
   not a hard security boundary (it's a shift selector), so back-office PIN login
   is rate-limited like password login to keep a 4-digit space impractical to
   brute-force. */
const pinHash = (pin) => { let e = 5381; for (const ch of String(pin)) e = (e * 33 ^ ch.charCodeAt(0)) >>> 0; return String(e); };
const auth = (req, res, next) => {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : req.query.token;
  try {
    req.org = jwt.verify(tok, SECRET);
    req.org.s = cleanStoreId(req.headers["x-store-id"] || req.query.storeId || req.org.s || DEFAULT_STORE_ID);
    next();
  } catch { res.status(401).json({ error: "unauthorized" }); }
};

const parseCookies = (req) => Object.fromEntries((req.headers.cookie || "").split(";").map((p) => p.trim()).filter(Boolean).map((p) => {
  const i = p.indexOf("=");
  return [decodeURIComponent(p.slice(0, i)), decodeURIComponent(p.slice(i + 1))];
}));

/* /app is the till itself - it must only ever load for someone who has
   actually signed in (password, Google or Apple), not fall back to a
   standalone/offline mode the way the underlying till bundle historically
   could. The session lives in an httpOnly cookie (checked server-side,
   before the bundle is even served) alongside the existing localStorage
   copy the bundle's own JS uses for its Authorization: Bearer calls. */
const APP_COOKIE = "kashikeyo_session";
const setAppCookie = (res, token) => res.cookie(APP_COOKIE, token, {
  httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 365 * 24 * 3600 * 1000, path: "/",
});
/* AUDIT-SEC-PIN: an opaque, unauthenticated device identifier — it carries no
   org or secret, just proves "this browser was here before". PIN login
   checks it against paired_devices (org-scoped); it means nothing on its
   own. Long-lived (2y) since re-pairing is a real interruption for staff. */
const DEVICE_COOKIE = "kashikeyo_device";
const setDeviceCookie = (res, deviceId) => res.cookie(DEVICE_COOKIE, deviceId, {
  httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 2 * 365 * 24 * 3600 * 1000, path: "/",
});
/* ── Member (registered-customer) sessions ───────────────────────────────────
   The customer-facing rewards portal signs a diner in by email OTP and rides a
   separate httpOnly cookie, distinct from staff `kashikeyo_session`. The token
   carries only the org and the customer id (k:"member") — a member can read
   their own card and post intent, never touch POS state. */
const MEMBER_COOKIE = "kashikeyo_member";
const signMember = (orgId, custId) => jwt.sign({ o: orgId, c: String(custId), k: "member" }, SECRET, { expiresIn: "60d" });
const setMemberCookie = (res, token) => res.cookie(MEMBER_COOKIE, token, {
  httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 60 * 24 * 3600 * 1000, path: "/",
});
const readMember = (req) => {
  const raw = parseCookies(req)[MEMBER_COOKIE];
  try { const p = jwt.verify(raw, SECRET); return (p && p.k === "member" && p.o && p.c) ? { orgId: p.o, custId: p.c } : null; }
  catch { return null; }
};
/* Mask an email for the "we sent a code to …" line: keep the first and last
   character of the local part, and the domain. `rifga@mailbox.mv` → `r•••a@mailbox.mv`. */
const maskEmail = (e) => {
  const s = String(e || "").trim(); const at = s.indexOf("@");
  if (at < 1) return s;
  const local = s.slice(0, at), dom = s.slice(at);
  if (local.length <= 2) return local[0] + "•••" + dom;
  return local[0] + "•••" + local[local.length - 1] + dom;
};
/* ── Session tracking ────────────────────────────────────────────────────────
   Each cookie session gets a row in app_sessions keyed by a hash of its token
   (sid), so the back office can list active sign-ins and revoke one. Deriving
   the sid from the token means no change to the JWT payload or sign(); an old
   cookie with no row is simply treated as "not revoked" (backward compatible).*/
const sidOf = (token) => crypto.createHash("sha256").update(String(token || "")).digest("hex").slice(0, 40);
const deviceOf = (req) => {
  const ua = String((req.get && req.get("user-agent")) || "");
  const os = /Windows/.test(ua) ? "Windows" : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "browser";
  return br + " · " + os;
};
async function recordSession(orgId, token, meta = {}) {
  try {
    await withOrg(orgId, (c) => c.query(
      `INSERT INTO app_sessions (org_id, sid, staff_id, name, role, register, device, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_id, sid) DO UPDATE SET revoked=false, last_seen=now(), device=EXCLUDED.device, ip=EXCLUDED.ip`,
      [orgId, sidOf(token), meta.staffId || null, meta.name || null, meta.role || null, meta.register || null, meta.device || null, meta.ip || null]));
  } catch (e) { recordError("session record", e); }
}
/* Set the cookie AND track the session (fire-and-forget so a tracking hiccup
   never blocks a login). Use in place of setAppCookie for real user logins. */
const setAppCookieTracked = (req, res, token, meta = {}) => {
  setAppCookie(res, token);
  recordSession(meta.orgId, token, Object.assign({ device: deviceOf(req), ip: (req.ip || "") }, meta));
};
/* Resolves the app-session cookie to a live, active org id, or null. The one
   place that decides "is this browser really signed in?" - both the /app gate
   and the /login,/signup "skip straight to the app" shortcut go through it, so
   they can never disagree and bounce the user back and forth (that mismatch -
   a stale localStorage token with no valid cookie - was an infinite
   /login<->/app redirect flash). */
async function resolveAppSession(req) {
  const raw = parseCookies(req)[APP_COOKIE];
  let payload;
  try { payload = jwt.verify(raw, SECRET); } catch { return null; }
  if (!payload.o) return null;
  const r = await withSystem(async (client) => {
    const org = await client.query("SELECT status, onboarded FROM orgs WHERE id=$1", [payload.o]);
    /* Per-session revocation: a matching, revoked row rejects this cookie.
       Absent row = an older/untracked session, treated as valid. Any DB error
       here fails OPEN (session stays valid) so a hiccup can never lock everyone
       out — the worst case is a revoked device lingers until the DB recovers. */
    let revoked = false;
    try {
      const s = await client.query("SELECT revoked FROM app_sessions WHERE org_id=$1 AND sid=$2", [payload.o, sidOf(raw)]);
      revoked = s.rowCount ? !!s.rows[0].revoked : false;
    } catch { revoked = false; }
    return { org, revoked };
  });
  if (!r.org.rowCount || (r.org.rows[0].status && r.org.rows[0].status !== "active")) return null;
  if (r.revoked) return null;
  r.rowCount = r.org.rowCount; r.rows = r.org.rows;
  /* Side-channel for requireAppSession so it can steer un-onboarded orgs to
     /welcome without a second lookup; API callers simply ignore it. */
  req.kOnboarded = r.rows[0].onboarded !== false;
  /* Role-carrying sessions (RBAC gaps 3-4): a staff PIN login stamps role +
     staff into the cookie; the owner/email login carries none, which we treat
     as full "owner" access for backward compatibility. Surfaced on req so the
     /api/inv role gate and back.html can enforce/branch on it. */
  req.appRole = payload.role || "owner";
  req.appStaff = payload.staff || null;
  /* The register is minted into the JWT as claim `r` (see sign()), not
     `register` — reading the wrong key made every terminal think it was R1,
     which collided receipt numbers across tills. Same for the store: claim
     `s`, needed so the ops token this session mints keeps its outlet. */
  req.appRegister = payload.r || "R1";
  req.appStoreId = payload.s || DEFAULT_STORE_ID;
  return payload.o;
}
/* App-session RBAC (audit B2): the /api/app2/* write endpoints previously
   checked only "is there a session", so a till-level staff cookie (cashier /
   waiter / kitchen) could accept orders, edit customers, settle receivables,
   change store config or manage staff purely because the UI hid the button.
   Rank the session's role and gate each write to the minimum it needs. An
   owner/email login carries no role and resolves to "owner" (full access),
   preserving backward compatibility. Ranks mirror inventory.js's model:
   manager = operational back office, admin/owner = settings + staff. */
/* Never let a staff PIN leave the server over the sync stream. `/api/pull` is
   Bearer-authenticated, so anyone holding a paired till's token could read every
   `users` row verbatim — and the PIN is a 4-digit value behind a fast unsalted
   hash, i.e. recoverable in microseconds, and it doubles as a back-office login.
   Clients that need to know whether a staff member has a PIN get a boolean. */
function scrubEntity(kind, data) {
  if (kind !== "users" || !data || typeof data !== "object") return data;
  const out = Object.assign({}, data);
  out.hasPin = !!out.pin;
  delete out.pin;
  return out;
}
const APP_ROLE_RANK = { owner: 5, admin: 4, manager: 3, cashier: 2, waiter: 2, kitchen: 1, rider: 1 };
const APP_RANK = { KITCHEN: 1, TILL: 2, MANAGER: 3, ADMIN: 4, OWNER: 5 };
const appRankOf = (r) => { const k = APP_ROLE_RANK[String(r || "owner").toLowerCase()]; return k == null ? 0 : k; };
/* Inline gate (not middleware) because each handler resolves the session itself
   — call right after resolveAppSession. Returns true (and has already sent 403)
   when the caller lacks the rank, so the handler can `if (denyAppRole(...)) return;`. */
const denyAppRole = (req, res, min, msg) => {
  if (appRankOf(req.appRole) >= min) return false;
  res.status(403).json({ error: msg || "You don't have permission for this." });
  return true;
};
const requireAppSession = (req, res, next) => {
  resolveAppSession(req)
    .then((orgId) => {
      if (!orgId) return res.redirect(302, "/login");
      if (!req.kOnboarded && req.path !== "/welcome" && !req.originalUrl.startsWith("/welcome")) return res.redirect(302, "/welcome");
      next();
    })
    .catch(() => res.redirect(302, "/login"));
};
const redirectIfAppSession = (req, res, next) => {
  resolveAppSession(req).then((orgId) => orgId ? res.redirect(302, "/v2") : next()).catch(() => next());
};

/* Developer-panel sessions are a separate credential namespace from store
   logins (payload.a instead of payload.o) so an org JWT can never be replayed
   here, carried in an httpOnly cookie since the panel is a plain server-
   rendered page rather than the SPA's bearer-token client. */
const DEV_COOKIE = "kdev_session";
const signAdmin = (adminId) => jwt.sign({ a: adminId }, SECRET, { expiresIn: "30d" });
const setDevCookie = (res, token) => res.cookie(DEV_COOKIE, token, {
  httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 30 * 24 * 3600 * 1000, path: "/",
});
const devAuth = (req, res, next) => {
  const tok = parseCookies(req)[DEV_COOKIE];
  let payload;
  try { payload = jwt.verify(tok, SECRET); } catch { return res.status(401).json({ error: "sign in required" }); }
  if (!payload.a) return res.status(401).json({ error: "sign in required" });
  pool.query("SELECT id, email, name FROM platform_admins WHERE id=$1", [payload.a])
    .then((r) => {
      if (!r.rowCount) return res.status(401).json({ error: "sign in required" });
      req.admin = r.rows[0];
      next();
    }).catch(next);
};

/* Inventory & Pricing (recipes, stock checks, procurement) lives in its own
   module — it plugs into the same withOrg/RLS scope and into /api/ops below,
   where settled sales trigger the real-time ingredient deductions. */
const inventory = require("./inventory")({ withOrg, withOrgBg, uid, wrap, recordError, resolveAppSession, bearerAuth: auth, poke, logActivity });
app.use("/api/inv", inventory.router);

async function ensureDefaultStore(orgId, storeName = "Main Store") {
  await withOrg(orgId, (client) => client.query(
    `INSERT INTO stores (org_id, id, code, name)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (org_id, id) DO NOTHING`,
    [orgId, DEFAULT_STORE_ID, "MAIN", storeName || "Main Store"]));
}

/* Seed the shared starter menu (default-menu.js) into an org as GLOBAL products
   so it is available across every store/outlet in the org, on the till and the
   guest portal. Idempotent and non-destructive:
   - a product that does not exist yet is inserted in full (with its photo),
   - a product that already exists (an outlet that has the menu but no photos,
     or whose line the owner has since edited) only has its `img` merged in,
     and only when it actually changed — so re-running is a true no-op and an
     owner's own name/price/category edits are never overwritten.
   Returns the highest rowver it touched (0 if nothing changed) so the caller
   can poke SSE. */
async function ensureDefaultMenu(orgId) {
  if (!DEFAULT_MENU.length) return 0;
  const maxRowver = await withOrg(orgId, async (client) => {
    let mx = 0;
    /* Seed / refresh the starter menu.
       - New item -> inserted in full.
       - Live item an outlet has edited -> only the photo is refreshed, so their
         price / add-ons / allergens / availability / category edits are kept.
       - A default item that had been retired (deleted) is restored in full,
         re-categorised to the current tree. */
    for (const item of DEFAULT_MENU) {
      const r = await client.query(
        `INSERT INTO entities (org_id, kind, id, data)
         VALUES ($1,'products',$2,$3::jsonb)
         ON CONFLICT (org_id, kind, id) DO UPDATE
           SET data = CASE WHEN entities.deleted
                            THEN EXCLUDED.data
                            ELSE entities.data
                                 || jsonb_build_object('img', EXCLUDED.data->'img')
                                 || CASE WHEN (EXCLUDED.data ? 'dv')
                                            AND (COALESCE(entities.data->>'dv','')=''
                                                 OR entities.data->>'dv' = entities.data->>'name')
                                         THEN jsonb_build_object('dv', EXCLUDED.data->'dv') ELSE '{}'::jsonb END
                                 || CASE WHEN (EXCLUDED.data ? 'descDv')
                                            AND (COALESCE(entities.data->>'descDv','')=''
                                                 OR entities.data->>'descDv' = entities.data->>'desc')
                                         THEN jsonb_build_object('descDv', EXCLUDED.data->'descDv') ELSE '{}'::jsonb END
                            END,
               deleted = false,
               rowver = nextval('entities_rowver_seq'), updated_at = now()
           WHERE entities.deleted = true
              OR (entities.data->>'img') IS DISTINCT FROM (EXCLUDED.data->>'img')
              OR ((EXCLUDED.data ? 'dv')
                  AND (COALESCE(entities.data->>'dv','')=''
                       OR entities.data->>'dv' = entities.data->>'name'))
              OR ((EXCLUDED.data ? 'descDv')
                  AND (COALESCE(entities.data->>'descDv','')=''
                       OR entities.data->>'descDv' = entities.data->>'desc'))
         RETURNING rowver`,
        [orgId, item.id, JSON.stringify(item)]);
      if (r.rows[0]) mx = Math.max(mx, Number(r.rows[0].rowver));
    }
    /* Seed the menu geography once, without overriding an outlet that has
       arranged its own. Only writes a field the settings entity is missing, so a
       back-office rearrangement (catGroups / catOrder already set) is untouched. */
    const seedSetting = async (key, value) => {
      if (!Array.isArray(value) || !value.length) return;
      const r = await client.query(
        `UPDATE entities
           SET data = jsonb_set(data, ARRAY[$3], $2::jsonb, true),
               rowver = nextval('entities_rowver_seq'), updated_at = now()
         WHERE org_id=$1 AND kind='settings' AND id='settings' AND deleted = false
           AND NOT (data ? $3)
         RETURNING rowver`,
        [orgId, JSON.stringify(value), key]);
      for (const row of r.rows) mx = Math.max(mx, Number(row.rowver));
    };
    await seedSetting("catGroups", CAT_GROUPS);
    await seedSetting("catOrder", CAT_ORDER);
    /* One-time repair (per org): earlier builds forced stock:0 onto untracked
       default menu items whenever the till re-synced them, flipping the whole
       menu to "sold out" and blanking the guest portal. Clear stock from the
       seeded items once so they return to always-available; the flag stops it
       re-running, so it never fights an owner who later tracks stock on an item.
       (Combined with the ops fix that no longer conjures stock:0, they stay
       untracked from here on.) */
    const repaired = await client.query(
      "SELECT 1 FROM entities WHERE org_id=$1 AND kind='settings' AND id='settings' AND deleted=false AND (data ? 'defaultsUntracked')", [orgId]);
    if (!repaired.rowCount) {
      const clr = await client.query(
        `UPDATE entities SET data = data - 'stock', rowver = nextval('entities_rowver_seq'), updated_at = now()
         WHERE org_id=$1 AND kind='products' AND deleted=false AND id = ANY($2::text[]) AND data ? 'stock'
         RETURNING rowver`,
        [orgId, DEFAULT_MENU.map((i) => i.id)]);
      for (const row of clr.rows) mx = Math.max(mx, Number(row.rowver));
      await client.query(
        `UPDATE entities SET data = jsonb_set(data, '{defaultsUntracked}', 'true', true),
           rowver = nextval('entities_rowver_seq'), updated_at = now()
         WHERE org_id=$1 AND kind='settings' AND id='settings' AND deleted=false`, [orgId]);
    }
    return mx;
  });
  if (maxRowver) poke(orgId, maxRowver);
  return maxRowver;
}

/* Seed just the SAMPLE CATEGORIES onto a store (no dishes) — the starter shape a
   new store begins with. Saved as settings.menuCats so the sections show on the
   till + QR menu even while empty; the full sample dish list is a separate,
   downloadable CSV the owner fills in and imports. */
async function seedSampleCategories(orgId) {
  const catGroup = {};
  (CAT_GROUPS || []).forEach((g) => (g.subs || []).forEach((s) => { catGroup[s] = g.name; }));
  const patch = { menuCats: (CAT_ORDER || []).slice(), catGroup, catGroups: CAT_GROUPS, catOrder: (CAT_ORDER || []).slice() };
  // UPSERT, not a bare UPDATE: a store whose settings entity was never created
  // (or was tombstoned) would silently keep zero categories on an UPDATE-only
  // path — the row simply isn't there to update. Insert it if missing, and merge
  // the sample categories onto whatever data already exists otherwise.
  const mx = await withOrg(orgId, async (c) => {
    const r = await c.query(
      "INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'settings','settings',$2) " +
      "ON CONFLICT (org_id, kind, id) DO UPDATE SET data = COALESCE(entities.data,'{}'::jsonb) || $2::jsonb, " +
      "deleted=false, rowver=nextval('entities_rowver_seq'), updated_at=now() RETURNING rowver",
      [orgId, JSON.stringify(patch)]);
    return r.rows[0] ? Number(r.rows[0].rowver) : 0;
  });
  if (mx) poke(orgId, mx);
  return (CAT_ORDER || []).length;
}

/* Apply a set of menu items (e.g. DEFAULT_MENU) to a store — the engine behind
   "Load default menu". replace=true wipes the current menu first so the store
   resets to exactly this menu; otherwise it merges (add/update). Items with no
   photo get category artwork, and on a replace the category order + groups are
   pinned, so it lands identically to a CSV import. */
async function applyMenuItems(orgId, items, catGroups, catOrder, opts = {}) {
  const replace = !!opts.replace;
  const out = await withOrg(orgId, async (c) => {
    let created = 0, purged = 0, mx = 0;
    if (replace) {
      const d = await c.query("UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='products' AND deleted=false", [orgId]);
      purged = d.rowCount || 0;
    }
    for (const it of (items || [])) {
      if (!it || !it.name) continue;
      const data = Object.assign({ recipe: [] }, it);
      if (!data.id) data.id = "m_" + Math.random().toString(36).slice(2, 9);
      const r = await c.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'products',$2,$3) ON CONFLICT (org_id, kind, id) DO UPDATE SET data=excluded.data, deleted=false, rowver=nextval('entities_rowver_seq'), updated_at=now() RETURNING rowver", [orgId, data.id, JSON.stringify(data)]);
      if (r.rows[0]) mx = Math.max(mx, Number(r.rows[0].rowver));
      created++;
    }
    if (replace && Array.isArray(catOrder) && catOrder.length) {
      await c.query("UPDATE entities SET data = COALESCE(data,'{}'::jsonb) || $2::jsonb, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='settings'",
        [orgId, JSON.stringify({ catOrder, catGroups: catGroups || [] })]);
    }
    return { created, purged, mx };
  });
  if (out.mx) poke(orgId, out.mx);
  return out;
}

/* Usage-based popularity: tally units sold per dish over a recent window and mark
   the top sellers `trending` (with a running `soldQty`), so the portals can rank
   and feature what people actually order — not just a hand-set flag. Throttled
   per org so a busy till doesn't recompute on every sale. */
const POP_WINDOW_MS = 45 * 86400000;   // 45 days
const _popAt = new Map();
async function recomputeMenuPopularity(orgId) {
  return await withOrg(orgId, async (c) => {
    const since = Date.now() - POP_WINDOW_MS;
    const sales = (await c.query("SELECT data FROM entities WHERE org_id=$1 AND kind='sales' AND deleted=false", [orgId])).rows.map((r) => r.data || {});
    const tally = {};
    for (const s of sales) {
      const at = Number(s.at || s.createdAt || s.t) || 0;
      if (at && at < since) continue;
      for (const l of (s.lines || [])) { const pid = String(l.pid || l.id || ""); if (!pid) continue; tally[pid] = (tally[pid] || 0) + (Number(l.qty != null ? l.qty : l.q) || 0); }
    }
    const ranked = Object.keys(tally).map((k) => [k, tally[k]]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
    // Featured = the top ~12% of sold dishes (at least 6, at most 24).
    const topN = Math.min(24, Math.max(6, Math.ceil(ranked.length * 0.12)));
    const top = new Set(ranked.slice(0, topN).map((x) => x[0]));
    const prods = (await c.query("SELECT id, data FROM entities WHERE org_id=$1 AND kind='products' AND deleted=false", [orgId])).rows;
    let mx = 0;
    for (const p of prods) {
      const pid = String(p.id), qty = tally[pid] || 0, trending = top.has(pid), d = p.data || {};
      if ((Number(d.soldQty) || 0) === qty && !!d.trending === trending) continue;   // no change
      d.soldQty = qty; if (trending) d.trending = true; else delete d.trending;
      const r = await c.query("UPDATE entities SET data=$3, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='products' AND id=$2 RETURNING rowver", [orgId, pid, JSON.stringify(d)]);
      if (r.rows[0]) mx = Math.max(mx, Number(r.rows[0].rowver));
    }
    return { ranked: ranked.length, featured: top.size, mx };
  });
}
// Fire-and-forget, throttled to once per 10 min per org. Safe to call from any
// hot path (a settle, a menu build) — it never blocks and never throws outward.
function maybeRecomputePopularity(orgId) {
  try {
    const now = Date.now(), last = _popAt.get(orgId) || 0;
    if (now - last < 600000) return;
    _popAt.set(orgId, now);
    recomputeMenuPopularity(orgId).then((r) => { if (r && r.mx) poke(orgId, r.mx); }).catch((e) => recordError("popularity " + orgId, e));
  } catch (e) { /* never let ranking break a sale */ }
}

/* Same DJB2-ish hash the till bundle itself uses for till-PIN staff entries
   (see Xo() in web/dist/index.html) - reimplemented here so a PIN chosen (or
   generated) at signup can be seeded server-side as a real "users" entity
   in the exact shape the till expects. Not a security boundary (the till PIN
   is just a fast per-shift operator switch) - the account itself is secured
   by the password/OAuth login below. */
function hashTillPin(pin) {
  let h = 5381;
  for (const ch of String(pin)) h = (h * 33 ^ ch.charCodeAt(0)) >>> 0;
  return String(h);
}

/* ── Store backup / reset / restore ───────────────────────────────────────────
   Every org-scoped table, snapshotted / wiped / restored as a whole. Runs on the
   normal request pool via withOrg(orgId) so it uses the healthy pooled connection
   (bootPool is a direct link only kept warm for boot) and RLS auto-scopes every
   statement to the authenticated org. activity_log is deliberately excluded — it
   is append-only (the app role can't delete it, and the audit trail should
   survive a reset). Table names come only from this fixed whitelist. */
const SNAPSHOT_TABLES = ["entities", "ingredients", "ingredient_units", "recipe_lines", "stock_moves",
  "suppliers", "purchase_invoices", "purchase_invoice_lines", "ingredient_lots",
  "audit_sessions", "audit_lines"];
/* FK-safe order (only ingredient_units/recipe_lines reference ingredients): delete
   ingredients LAST, insert it FIRST. */
const DELETE_ORDER = ["entities", "ingredient_units", "recipe_lines", "stock_moves",
  "purchase_invoice_lines", "purchase_invoices", "ingredient_lots", "audit_lines",
  "audit_sessions", "suppliers", "ingredients"];
const INSERT_ORDER = DELETE_ORDER.slice().reverse();

/* An in-database snapshot is one JSONB value that also has to survive being
   parsed into JS and re-stringified — several times its own size in RSS. A store
   with a couple of years of trading can run to hundreds of MB, which OOMs the
   whole process (every tenant on the instance, not just this one), and Postgres
   itself caps a jsonb container near 256 MB. Refuse early, with a number the
   owner can act on, rather than dying mid-write. */
const SNAPSHOT_MAX_ROWS = 400000;
const SNAPSHOT_MAX_BYTES = 60 * 1024 * 1024;
class SnapshotTooLarge extends Error {}

async function snapshotSize(c, orgId) {
  let rows = 0, bytes = 0;
  for (const t of SNAPSHOT_TABLES) {
    const r = await c.query(
      `SELECT count(*)::bigint AS n, COALESCE(sum(pg_column_size(x.*)),0)::bigint AS b FROM "${t}" x WHERE org_id=$1`, [orgId]);
    rows += Number(r.rows[0].n) || 0;
    bytes += Number(r.rows[0].b) || 0;
  }
  return { rows, bytes };
}

// Runs inside a caller-supplied transaction so a snapshot taken for /reset is
// consistent with the wipe that follows it (no sale can land in between).
async function snapshotStoreIn(c, orgId) {
  const size = await snapshotSize(c, orgId);
  if (size.rows > SNAPSHOT_MAX_ROWS || size.bytes > SNAPSHOT_MAX_BYTES) {
    throw new SnapshotTooLarge(
      "this store is too large for an in-app backup (" + size.rows.toLocaleString() + " rows, " +
      Math.round(size.bytes / 1048576) + " MB). Export your data instead, then reset.");
  }
  const tables = {};
  for (const t of SNAPSHOT_TABLES) {
    const r = await c.query(`SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) AS rows FROM "${t}" x WHERE org_id=$1`, [orgId]);
    tables[t] = r.rows[0].rows;
  }
  return { version: 1, at: Date.now(), tables };
}
const snapshotStore = (orgId) => withOrg(orgId, (c) => snapshotStoreIn(c, orgId));

function backupCounts(snap) {
  const ents = (snap.tables && snap.tables.entities) || [];
  const byKind = {};
  for (const e of ents) { if (e && !e.deleted) byKind[e.kind] = (byKind[e.kind] || 0) + 1; }
  return {
    products: byKind.products || 0, sales: byKind.sales || 0, customers: byKind.customers || 0,
    orders: byKind.orders || 0, ingredients: ((snap.tables && snap.tables.ingredients) || []).length,
    rows: SNAPSHOT_TABLES.reduce((a, t) => a + (((snap.tables && snap.tables[t]) || []).length), 0),
  };
}

// Reset a store to empty: soft-delete every content entity (so connected tills
// sync the removals) while keeping the store profile + staff, hard-delete the
// inventory/audit tables, and opt the outlet out of the starter-menu backfill so
// it stays empty until the owner adds a menu or restores. Returns the max rowver.
/* Which parts of the model are per-outlet, and which are shared across the whole
   account, decides what a single-outlet reset is allowed to touch:

     per-outlet   entities (via data->>'storeId'), stock_moves.store_id,
                  ingredient_lots.store_id, ops.store_id
     shared       the ingredient catalogue, recipes, units, suppliers, purchase
                  invoices, stock-check sessions — and any entity with no
                  storeId ("global" products are shared by every outlet)

   So resetting one outlet clears that outlet's trading history and its stock
   ledger, and deliberately leaves the shared catalogue and the other outlets
   untouched. Resetting ALL outlets additionally clears the shared tables — that
   is the "start the account over" case. */
const isAllOutlets = (storeId) => !storeId || storeId === "*";

async function resetStoreIn(c, orgId, storeId) {
  const keep = ["users", "settings"];
  const all = isAllOutlets(storeId);
  let maxRowver = 0;

  const r = all
    ? await c.query(
      "UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND deleted=false AND NOT (kind = ANY($2)) RETURNING rowver", [orgId, keep])
    : await c.query(
      "UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND deleted=false AND NOT (kind = ANY($2)) AND data->>'storeId' = $3 RETURNING rowver", [orgId, keep, String(storeId)]);
  for (const row of r.rows) maxRowver = Math.max(maxRowver, Number(row.rowver));

  if (all) {
    for (const t of DELETE_ORDER) { if (t !== "entities") await c.query(`DELETE FROM "${t}" WHERE org_id=$1`, [orgId]); }
    await c.query("DELETE FROM ops WHERE org_id=$1", [orgId]);
    // Nothing is left to sell from, so don't let the boot backfill re-seed a menu.
    await c.query("UPDATE orgs SET skip_default_menu=true WHERE id=$1", [orgId]);
  } else {
    await c.query("DELETE FROM stock_moves WHERE org_id=$1 AND store_id=$2", [orgId, String(storeId)]);
    await c.query("DELETE FROM ingredient_lots WHERE org_id=$1 AND store_id=$2", [orgId, String(storeId)]);
    await c.query("DELETE FROM ops WHERE org_id=$1 AND store_id=$2", [orgId, String(storeId)]);
    /* current_stock is a cache of SUM(stock_moves.qty); having just deleted one
       outlet's moves it would otherwise drift permanently. Rebuild it from what
       actually remains. */
    await c.query(
      `UPDATE ingredients i SET current_stock = COALESCE(m.total, 0), updated_at = now()
         FROM (SELECT id FROM ingredients WHERE org_id=$1) k
         LEFT JOIN (SELECT ingredient_id, SUM(qty) AS total FROM stock_moves WHERE org_id=$1 GROUP BY ingredient_id) m
           ON m.ingredient_id = k.id
        WHERE i.org_id=$1 AND i.id = k.id`, [orgId]);
  }

  if (!maxRowver) {
    const mx = await c.query("SELECT COALESCE(MAX(rowver),0) AS m FROM entities WHERE org_id=$1", [orgId]);
    maxRowver = Number(mx.rows[0].m) || 0;
  }
  return maxRowver;
}
const resetStore = (orgId, storeId) => withOrg(orgId, (c) => resetStoreIn(c, orgId, storeId));

class BadSnapshot extends Error {}

/* A restore deletes everything the org has before it writes anything back, so a
   snapshot that turns out to be empty, truncated or from a future version would
   destroy the store and report success. Check it BEFORE the first DELETE. */
function validateSnapshot(snap) {
  if (!snap || typeof snap !== "object") throw new BadSnapshot("this backup is unreadable.");
  if (Number(snap.version) !== 1) throw new BadSnapshot("this backup was written by a newer version of the app and can't be restored here.");
  if (!snap.tables || typeof snap.tables !== "object") throw new BadSnapshot("this backup has no data in it.");
  for (const t of SNAPSHOT_TABLES) {
    if (!Array.isArray(snap.tables[t])) throw new BadSnapshot("this backup is incomplete (missing " + t + ") — restoring it would lose data.");
  }
  /* Staff and store profile are the only way back in: `verifyOwnerPassword` and
     /api/back/login both read them. Restoring a snapshot without an owner/admin
     would lock the account out of its own reset/restore permanently. */
  const owner = snap.tables.entities.some((e) => e && e.kind === "users" && !e.deleted
    && e.data && (e.data.role === "owner" || e.data.role === "admin") && e.data.pin);
  if (!owner) throw new BadSnapshot("this backup contains no owner or admin with a PIN — restoring it would lock you out of your own store.");
}

/* Columns a table actually has right now. A snapshot taken before a migration
   won't carry newer columns; naming columns explicitly lets those take their
   DEFAULT instead of the NULL that `SELECT *` would force (which fails outright
   against the NOT NULL DEFAULT '' pattern this schema uses). */
async function tableColumns(c, t) {
  const r = await c.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [t]);
  return r.rows.map((x) => x.column_name);
}

/* Full point-in-time restore, in one transaction.

   Entities are NOT hard-deleted: clients sync by `rowver > since`, so a vanished
   row is simply absent from every future pull and the till keeps showing it for
   ever (and re-pushes it through /api/ops the moment anyone edits it). Instead
   every current entity is tombstoned with a fresh rowver, then the snapshot rows
   are written over the top — so a till learns both what came back and what went
   away. The inventory tables have no client-side mirror, so they stay a plain
   delete + insert. */
async function restoreStore(orgId, snap) {
  validateSnapshot(snap);
  return await withOrg(orgId, async (c) => {
    // Tombstone everything currently live, so removals propagate to clients.
    await c.query("UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND deleted=false", [orgId]);
    for (const t of DELETE_ORDER) { if (t !== "entities") await c.query(`DELETE FROM "${t}" WHERE org_id=$1`, [orgId]); }
    /* The till's idempotency ledger. Left in place, a queued op from after the
       backup would be discarded as a replay and its sale lost silently; cleared,
       an offline till can re-push and the sale is recreated. */
    await c.query("DELETE FROM ops WHERE org_id=$1", [orgId]);

    for (const t of INSERT_ORDER) {
      const rows = snap.tables[t] || [];
      if (!rows.length) continue;
      const live = new Set(await tableColumns(c, t));
      const cols = Object.keys(rows[0]).filter((k) => live.has(k));
      if (!cols.length) continue;
      const quoted = cols.map((k) => `"${k}"`).join(", ");
      // org_id is forced to the authenticated org: a snapshot never gets to say
      // which tenant it lands in (RLS would reject it, but don't rely on that).
      const sel = cols.map((k) => (k === "org_id" ? "$2" : `x."${k}"`)).join(", ");
      if (t === "entities") {
        await c.query(
          `INSERT INTO "${t}" (${quoted}) SELECT ${sel} FROM jsonb_populate_recordset(NULL::"${t}", $1::jsonb) x
           ON CONFLICT (org_id, kind, id) DO UPDATE SET data = EXCLUDED.data, deleted = EXCLUDED.deleted, updated_at = now()`,
          [JSON.stringify(rows), String(orgId)]);
      } else {
        await c.query(
          `INSERT INTO "${t}" (${quoted}) SELECT ${sel} FROM jsonb_populate_recordset(NULL::"${t}", $1::jsonb) x`,
          [JSON.stringify(rows), String(orgId)]);
      }
    }
    /* Re-stamp EVERY entity (restored and tombstoned alike) above the sequence
       high-water mark. Restored rows carry their old rowver, which sits below
       connected clients' cursors — without this they would never be pulled.
       Must stay unconditional and inside this transaction. */
    let maxRowver = 0;
    const r = await c.query("UPDATE entities SET rowver=nextval('entities_rowver_seq') WHERE org_id=$1 RETURNING rowver", [orgId]);
    for (const row of r.rows) maxRowver = Math.max(maxRowver, Number(row.rowver));
    // A restore brings a menu back, so undo the reset's opt-out of the backfill.
    const hadMenu = snap.tables.entities.some((e) => e && e.kind === "products" && !e.deleted);
    await c.query("UPDATE orgs SET skip_default_menu=$2 WHERE id=$1", [orgId, !hadMenu]);
    if (!maxRowver) {
      const mx = await c.query("SELECT COALESCE(MAX(rowver),0) AS m FROM entities WHERE org_id=$1", [orgId]);
      maxRowver = Number(mx.rows[0].m) || 0;
    }
    return maxRowver;
  });
}

/* Confirmation for the destructive store actions: the owner's ACCOUNT PASSWORD,
   checked with bcrypt against orgs.pass_hash — the same credential /api/elevate
   uses, and for the same reason. The till PIN is deliberately not accepted: it
   is four digits, it is a shift selector rather than a secret, and every member
   of staff holds one. Wiping a business should need the credential only the
   owner has. */
async function verifyOwnerPassword(orgId, password) {
  const pw = String(password || "");
  if (!pw) return false;
  const org = await withSystem(async (c) =>
    (await c.query("SELECT pass_hash FROM orgs WHERE id=$1", [orgId])).rows[0]);
  if (!org || !org.pass_hash) return false;
  try { return bcrypt.compareSync(pw, org.pass_hash); } catch (e) { return false; }
}

/* ── Transactional email (signup OTP + welcome) ───────────────────────────────
   Sent through the Resend HTTP API with native fetch — no extra dependency. Set
   RESEND_API_KEY (+ optional EMAIL_FROM) in Railway to turn it on. Degrades like
   the OCR/AI features: with no key it reports `configured:false`, and the signup
   flow surfaces the code in non-production so testing isn't blocked. */
const EMAIL_FROM = process.env.EMAIL_FROM || "KashikeyoPOS <onboarding@kashikeyopos.com>";
const emailConfigured = () => !!process.env.RESEND_API_KEY;
async function sendEmail({ to, subject, html, text }) {
  if (!emailConfigured()) return { ok: false, configured: false };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html, text }),
    });
    if (!r.ok) { recordError("sendEmail", new Error("resend " + r.status + " " + (await r.text().catch(() => "")).slice(0, 200))); return { ok: false, configured: true }; }
    return { ok: true, configured: true };
  } catch (e) { recordError("sendEmail", e); return { ok: false, configured: true }; }
}
/* One-time code helpers. Codes are stored only as a salted SHA-256 hash. */
const otpHash = (email, code) => crypto.createHash("sha256").update(String(email).toLowerCase() + "|" + String(code) + "|" + SECRET).digest("hex");
const genOtp = () => String(crypto.randomInt(100000, 1000000));
const otpEmailHtml = (code) => `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:440px;margin:0 auto;padding:28px 24px;color:#221a12">
  <div style="font-weight:800;font-size:18px;color:#C7431D;margin-bottom:14px">KashikeyoPOS</div>
  <p style="font-size:14px;line-height:1.5;margin:0 0 14px">Use this code to verify your email and finish creating your account:</p>
  <div style="font-size:30px;font-weight:800;letter-spacing:.28em;background:#F7F1E7;border-radius:12px;padding:16px;text-align:center;color:#221a12">${code}</div>
  <p style="font-size:12.5px;color:#6b6459;line-height:1.5;margin:14px 0 0">This code expires in 10 minutes. If you didn't request it, you can ignore this email.</p>
</div>`;
/* Invitation to the registered-customer (rewards) portal — emailed, not SMS.
   Carries the store's brand and the sign-in link; the member signs in with this
   same email address. `mode` shapes the copy: a first "invite", a "resend" for
   someone who never opened it, or a "reset" that walks an existing member back
   in (the portal itself does the email one-time-code — there is no password). */
const portalInviteEmailHtml = (brand, link, mode) => {
  const b = String(brand || "Kashikeyo").replace(/[<>&]/g, "");
  const copy = mode === "reset"
    ? { lead: `Here's the link back to your ${b} Rewards card. We'll email you a one-time code to sign in — no password to remember.`, cta: "Sign back in", foot: "You asked to get back into your rewards card (or the store did it for you). If it wasn't you, you can ignore this — nothing changes until the code is used." }
    : mode === "resend"
    ? { lead: `A quick reminder — your ${b} Rewards card is ready. Points on every visit, your house account, and ordering from your table.`, cta: "Open your rewards card", foot: "Sign in with this email address — we'll email you a one-time code, no password to remember. If this wasn't meant for you, you can ignore it." }
    : { lead: `You're invited to ${b} Rewards — points on every visit, your house account, and ordering from your table, all in one place.`, cta: "Open your rewards card", foot: "Sign in with this email address — we'll email you a one-time code, no password to remember. If this wasn't meant for you, you can ignore it." };
  return `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:460px;margin:0 auto;padding:28px 24px;color:#221a12">
  <div style="font-weight:800;font-size:18px;color:#f4553c;margin-bottom:14px">${b} Rewards</div>
  <p style="font-size:14.5px;line-height:1.6;margin:0 0 16px">${copy.lead}</p>
  <a href="${link}" style="display:inline-block;background:#f4553c;color:#fff;text-decoration:none;font-weight:700;font-size:14.5px;padding:13px 22px;border-radius:26px">${copy.cta}</a>
  <p style="font-size:12.5px;color:#6b6459;line-height:1.6;margin:18px 0 0">${copy.foot}</p>
</div>`;
};
/* Minimal signup-safe password + email validation, reused by the staged flow. */
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || "").trim());
const passwordProblem = (p) => (String(p || "").length < 8 ? "Password must be at least 8 characters." : null);

/* Without a seeded "users" entity, the till bundle falls back to its own
   hardcoded demo staff (Abdulla/Shifna/Ahmed) - every fresh signup would
   land on a PIN gate showing three fake employees that aren't theirs,
   with no way to know their secret demo PINs. This seeds the real admin
   as the till's "owner" user instead: with the PIN they chose at signup
   if they chose one, or - for OAuth signups and any pre-existing org that
   still has zero staff - a freshly generated one, returned so the caller
   can show it to the user (they have no other way to learn it). */
async function ensureOwnerSeed(org, explicitPin) {
  return withOrg(org.id, async (client) => {
    if (!explicitPin) {
      /* Serialize concurrent first-logins for this org: without the lock,
         two of them could both see zero staff and each seed an owner. The
         xact-scoped advisory lock releases automatically on commit/rollback. */
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["ownerseed:" + org.id]);
      const hit = await client.query("SELECT 1 FROM entities WHERE org_id=$1 AND kind='users' AND deleted=false LIMIT 1", [org.id]);
      if (hit.rowCount) return null;
    }
    const pin = explicitPin || String(Math.floor(1000 + Math.random() * 9000));
    const name = (org.owner_name && org.owner_name.trim()) || (org.email ? org.email.split("@")[0] : "Owner");
    const data = { id: uid(), name, role: "owner", pin: hashTillPin(pin) };
    await client.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'users',$2,$3)", [org.id, data.id, JSON.stringify(data)]);
    return explicitPin ? null : pin;
  });
}

async function orgBySlug(slug) {
  return withSystem(async (client) => (await client.query("SELECT * FROM orgs WHERE slug=$1", [slug])).rows[0]);
}

async function kindAll(orgId, kind, storeId = DEFAULT_STORE_ID) {
  const rows = await withOrg(orgId, async (client) =>
    (await client.query("SELECT id, data FROM entities WHERE org_id=$1 AND kind=$2 AND deleted=false", [orgId, kind])).rows);
  return rows.map((row) => row.data).filter((data) => isVisibleInStore(data, storeId));
}

/* The store's canonical settings row (id='settings') — the ONE row the config
   writer upserts and the terminal, storefront and receipt all display. Reading
   settings any other way (kindAll's arbitrary first row, "most recently
   updated", a bare LIMIT 1) can land on a stray duplicate row, which is how a
   rename "saved" but never showed. Returns the row's data, or null. Callers that
   want the array shape use `(await loadSettings(id)) ? [data] : []`. */
async function loadSettings(orgId) {
  return withOrg(orgId, async (client) =>
    ((await client.query(
      "SELECT data FROM entities WHERE org_id=$1 AND kind='settings' AND id='settings' AND deleted=false LIMIT 1",
      [orgId])).rows[0] || {}).data || null);
}
async function loadSettingsArr(orgId) {
  const d = await loadSettings(orgId);
  return d ? [d] : [];
}

const lineTotal = (l) => Math.round(Number(l.price || 0) * Number(l.qty || 1) * (1 - (Number(l.discPct || 0)) / 100));
const orderSubtotal = (o) => (o.items || []).reduce((x, l) => x + lineTotal(l), 0) + (Number(o.fee) || 0);
/* Two vocabularies grew up for the same three ideas: a sale carries
   orderType:'dine', an order carries otype:'dinein'. They only ever lined up
   because acceptOrder translated by hand on the till. Anything the server
   publishes under the name `otype` goes through here first, so a consumer
   testing otype==='dinein' can never silently miss a dine-in sale. Accepts
   either vocabulary, so rows already written in the old one still read right. */
const asOtype = (v) => {
  const s = String(v || "").toLowerCase();
  if (s === "dine" || s === "dinein" || s === "dine-in" || s === "dine_in" || s === "eatin") return "dinein";
  if (s === "delivery") return "delivery";
  return "takeaway";
};
/* Mirrors the till's $n checkout math exactly (see guest-sync-patch.js #3):
   GST only on taxable lines (products can be GST-exempt), service charge on
   the full subtotal — so what a guest sees for an open order matches what
   the cashier settles it for. */
/* Menu prices in this system are GST-INCLUSIVE (so is the delivery fee), which
   is what the register's own totals() assumes. This used to add GST on top of
   an already-inclusive price, so a guest who confirmed MVR 35.00 on their phone
   was charged MVR 37.80 seconds later — the same order, two totals, 8% apart.
   De-gross first, then apply service charge and GST to the exclusive base,
   exactly as the till does.

   Two further corrections, both to keep this identical to totals():
   - The delivery fee was added twice: orderSubtotal already includes it, and
     this added it again, so a guest confirming a delivery was quoted the fee
     twice over and the cashier settled a different number.
   - GST is extracted as the tax fraction of the inclusive amount rather than
     re-grossed off a rounded exclusive base, so the parts sum to the total
     exactly and a guest's quote equals the till's charge to the laari. */
const orderBreakdown = (o, settings = {}) => {
  const r = Number(settings.gstBp || 800) / 10000;
  const sp = String(o.otype || "dinein") === "dinein" ? Number(settings.svcChargeBp || 0) / 10000 : 0;
  /* AUDIT-F1: totals() (the till) supports a bill-level discount (discountPct)
     and folds it through every downstream figure BEFORE service/GST; this had
     no equivalent input at all, so the "must match totals() to the laari"
     invariant only held in the always-zero-discount subset of cases — a
     latent divergence, not currently reachable (nothing sets a discount on an
     order today) but real the moment one is wired up. Mirrors totals()'s
     dp/discIncl/goodsIncl shape exactly; with dp=0 every intermediate value
     below is algebraically identical to the previous implementation. */
  const dp = Math.max(0, Math.min(100, Number(o.discPct != null ? o.discPct : o.billDiscPct) || 0)) / 100;
  const TF = (v) => Math.round(v * r / (1 + r));
  const fee = Number(o.fee) || 0;
  const itemsIncl = orderSubtotal(o) - fee;
  const discIncl = Math.round(itemsIncl * dp);
  const goodsIncl = itemsIncl - discIncl;
  const svcIncl = Math.round(goodsIncl * sp);  // service is on the discounted goods, never the delivery fee
  const total = goodsIncl + fee + svcIncl;
  const gst = TF(total);
  const svc = svcIncl - TF(svcIncl);
  const disc = discIncl - TF(discIncl);
  return { excl: total - gst - svc, svc, gst, total, disc, discPct: dp * 100 };
};
const orderTotal = (o, settings = {}) => orderBreakdown(o, settings).total;
const normalizeOrder = (o, settings = {}) => ({
  ...o,
  status: String(o.status || "new"),
  table: o.table || (o.otype === "delivery" ? "Delivery" : "Pickup"),
  total: o.total != null ? Number(o.total) : orderTotal(o, settings),
  updatedAt: o.updatedAt || o.settledAt || o.completedAt || o.createdAt || Date.now(),
});
const finalStatuses = new Set(["completed", "settled", "paid", "closed"]);
/* Project raw `orders` entity data → the shape the /v2 terminal's KDS and
   Orders board read. Open orders only (still in the kitchen/service pipeline);
   completed/paid/cancelled drop off. Money laari→MVR. Shared by the page inject
   and the live-refresh poll so the two never disagree. */
const V2_CHAN = { v2: "dine_in", dine_in: "dine_in", dinein: "dine_in", dine: "dine_in", qr: "qr", takeaway: "takeaway", delivery: "delivery" };
function liveOrdersV2(dataRows) {
  const p2 = (n) => String(n).padStart(2, "0");
  return dataRows
    .filter((o) => o && o.id && !finalStatuses.has(String(o.status || "new").toLowerCase()) && String(o.status || "") !== "cancelled")
    .map((o) => {
      const at = Number(o.createdAt || o.at || o.t) || 0, dt = at ? new Date(at) : null;
      const items = (o.items || []).map((it, i) => ({ idx: i, pid: String(it.pid || it.id || ""), n: it.name || it.n || "Item",
        q: Number(it.qty || it.q) || 1, station: it.station || "", price: Math.round((Number(it.price) || 0) / 100), done: !!it.done }));
      const ot = V2_CHAN[o.otype] || "dine_in";
      const channel = ot === "delivery" ? "delivery" : ot === "takeaway" ? "takeaway" : (o.source === "qr" ? "qr" : "dine_in");
      return { id: o.id, no: o.no || o.id, status: String(o.status || "new"), otype: asOtype(o.otype),
        channel: channel, table: o.table || "", station: o.station || "hot",
        source: o.source || "qr", accepted: !!o.accepted, server: o.userName || o.server || "",
        customerId: o.customerId || null, customerName: o.customerName || "",
        billAck: !!o.billAck, billRequested: !!o.billRequested,
        items: items, at: at, time: dt ? p2(dt.getHours()) + ":" + p2(dt.getMinutes()) : "",
        total: Math.round((o.items || []).reduce((a, it) => a + (Number(it.price) || 0) * (Number(it.qty || it.q) || 1), 0) / 100) };
    })
    .sort((a, b) => b.at - a.at);
}
async function guestOrders(orgId, storeId, selector = {}, settings = {}) {
  const orders = await kindAll(orgId, "orders", storeId);
  const customerId = selector.customerId;
  const table = selector.table;
  // A table-less (takeaway/pickup) order has no table to key on, so the portal
  // tracks the order id(s) it placed and asks for them by id — that's how it
  // learns the till has settled/served the order and can close its own screen.
  const orderIds = Array.isArray(selector.orderIds) ? selector.orderIds : null;
  // A table QR deliberately shows the WHOLE table's shared bill — any phone at
  // the table sees every order on it, not just the one it placed itself. But a
  // table is reused all day, and orders are never purged, so an unbounded
  // `table` match hands the guest the LAST party's order the moment they scan
  // a table someone else already dealt with — settled, or (just as bad) simply
  // left "served" and never explicitly closed out at the till, which reappears
  // on every future guest's phone at that table forever. Once an order is
  // settled it stays visible only briefly (long enough to show the receipt
  // right after paying). A still-open order gets a much longer leash — a real
  // dine-in visit is never anywhere near this long, so past it an unsettled
  // order reads as forgotten, not live — but never so short it could cut off
  // an ordinary, unusually long sitting.
  // 15 min is generous for "check the receipt while paying and leaving" — the
  // one legitimate reason a settled order needs to stay visible at all — and
  // short enough that the next party (or a QA pass re-scanning the same table
  // minutes later) doesn't inherit someone else's already-closed bill.
  const SETTLED_RECENT_MS = 15 * 60 * 1000;
  const OPEN_MAX_MS = 6 * 60 * 60 * 1000;
  const now = Date.now();
  return orders
    .filter((o) => {
      if (orderIds && orderIds.length) return orderIds.some((id) => idEq(o.id, id));
      if (customerId) return idEq(o.customerId, customerId);
      if (!table || !idEq(o.table, table)) return false;
      const st = String(o.status || "new");
      const at = Number(o.updatedAt || o.settledAt || o.completedAt || o.createdAt) || 0;
      if (st === "settled" || st === "completed") return at > 0 && (now - at) < SETTLED_RECENT_MS;
      return at === 0 || (now - at) < OPEN_MAX_MS;
    })
    .map((o) => normalizeOrder(o, settings))
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
}

/* ── Loyalty / member-portal helpers ─────────────────────────────────────────
   The registered-customer portal reads these. Loyalty configuration is DATA,
   not code (handoff 08 §9): tier names, marks and lifetime-spend thresholds,
   the earn rate and the reward catalogue all live on the settings entity and
   default here only until a merchant sets them. The gradients and the four-tier
   visual language stay client-side design tokens. */
function loyaltyConfig(settings) {
  const s = settings || {};
  const L = s.loyalty || {};
  // MVR spent per point earned (handoff default 10). Falls back to the legacy
  // loyaltyBp (basis-points ×100) only if pointsPer was never set.
  const pointsPer = Number(s.pointsPer) > 0 ? Number(s.pointsPer)
    : (Number(s.loyaltyBp) > 0 ? Math.max(1, Math.round(Number(s.loyaltyBp) / 1000)) : 10);
  const tiers = (Array.isArray(L.tiers) && L.tiers.length) ? L.tiers : [
    { key: "bronze", name: "Bronze", mark: "III", from: 0 },
    { key: "silver", name: "Silver", mark: "II", from: 3000 },
    { key: "gold", name: "Gold", mark: "I", from: 7000 },
    { key: "platinum", name: "Platinum", mark: "★", from: 15000 },
  ];
  const rewards = Array.isArray(L.rewards) ? L.rewards : [];   // empty → empty state, never fabricated
  return { pointsPer, redeemPer: Number(L.redeemPer) > 0 ? Number(L.redeemPer) : 10, tiers, rewards };
}

async function findCustomerByEmail(orgId, storeId, email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || e.indexOf("@") < 1) return null;
  const custs = await kindAll(orgId, "customers", storeId);
  return custs.find((c) => String(c.email || "").trim().toLowerCase() === e) || null;
}

/* Build the member payload (handoff 07/A4) from the REAL customer row + loyalty
   config + real order history. Everything is server-computed; the app formats,
   it never derives. Absent data → empty arrays / null, never a fabricated value. */
function memberPayload(org, c, settings, orders, vouchers) {
  const cfg = loyaltyConfig(settings);
  const points = Math.max(0, Math.round(Number(c.points || c.loyaltyPoints || 0)));
  const spent = Math.round((Number(c.spent || c.totalSpent || 0)) / 100);
  const limit = Math.round((Number(c.creditLimit || c.credit || 0)) / 100);
  const used = Math.round((Number(c.balance || c.used || 0)) / 100);
  const code = c.memberNo || ("KM-" + String(c.id).replace(/[^a-zA-Z0-9]/g, "").slice(-8).toUpperCase().padStart(8, "0"));
  // Tier by lifetime spend against the configured thresholds.
  let ti = 0;
  for (let i = 0; i < cfg.tiers.length; i++) { if (spent >= Number(cfg.tiers[i].from || 0)) ti = i; }
  const tier = cfg.tiers[ti], upper = cfg.tiers[ti + 1] || null;
  const hist = Array.isArray(orders) ? orders : [];
  // Activity from real orders (visits). Rewards activity is layered in later.
  const activity = hist.map((o) => {
    const amt = Math.round((Number(o.total) || 0) / 100);
    return { kind: "visit", title: (asOtype(o.otype) === "dine" && o.table) ? ("Table " + o.table) : (org.store_name || "Visit"),
      meta: o.no ? ("Order " + o.no) : "", amount: amt, points: cfg.pointsPer ? Math.floor(amt / cfg.pointsPer) : 0,
      at: o.createdAt || o.at || null };
  });
  const lastVisit = c.lastOrderAt || (hist[0] && (hist[0].createdAt || hist[0].at)) || null;
  // Redeemed-but-not-yet-cleared vouchers subtract from the DISPLAYED balance now,
  // so the member never sees a flattering number (handoff 05). The till awards/
  // deducts the real points at settlement; the app only ever displays.
  const vlist = Array.isArray(vouchers) ? vouchers : [];
  const pending = vlist.filter((v) => String(v.state || "pending") === "pending");
  const pendingSpend = pending.reduce((a, v) => a + (Number(v.cost) || 0), 0);
  const availablePoints = Math.max(0, points - pendingSpend);
  // Tier rank for reward gating (higher index = higher tier).
  const tierRank = {}; cfg.tiers.forEach((t, i) => { tierRank[t.key] = i; });
  const myRank = tierRank[tier.key] || 0;
  const rewards = cfg.rewards.filter((r) => r.active !== false).map((r) => ({
    id: r.id, name: r.name, sub: r.sub || "", cost: Number(r.cost) || 0, img: r.img || "",
    tierRequired: r.tierRequired || "", locked: r.tierRequired ? ((tierRank[r.tierRequired] || 0) > myRank) : false }));
  return {
    id: c.id, name: c.name || "Member", email: c.email || "", phone: c.phone || "",
    memberSince: c.memberSince || c.since || (c.createdAt ? Number(c.createdAt) : null),
    code, barcode: code,
    points, availablePoints, pointsPending: 0, spentLifetime: spent, visits: Math.max(0, Math.round(Number(c.visits || 0))), lastVisit,
    credit: { limit, used },
    tier: { key: tier.key, name: tier.name, mark: tier.mark, from: Number(tier.from || 0), to: upper ? Number(upper.from) : null },
    nextTier: upper ? { name: upper.name, at: Number(upper.from) } : null,
    rewards,
    vouchers: vlist.map((v) => ({ id: v.id, name: v.name, cost: Number(v.cost) || 0, code: v.code || "", state: v.state || "pending", redeemedAt: Number(v.createdAt) || null })),
    activity,
    pointsPer: cfg.pointsPer, redeemPer: cfg.redeemPer,
    homeOutlet: org.store_name || "",
  };
}

async function uniqueSlug(client, base) {
  let slug = base;
  for (let i = 0; i < 5; i++) {
    const hit = await client.query("SELECT 1 FROM orgs WHERE slug=$1", [slug]);
    if (!hit.rowCount) break;
    slug = base + "-" + crypto.randomBytes(2).toString("hex");
  }
  return slug;
}

// Like uniqueSlug, but ignores the caller's own org row (so re-deriving a
// handle for an org that already holds `base` keeps it) and never lands on a
// reserved platform handle. Used when the handle is auto-generated from the
// store name during onboarding.
async function uniqueSlugFor(client, base, exceptOrgId) {
  let root = slugify(base);
  if (root.length < 3 || RESERVED_HANDLES.has(root)) root = (root + "-shop").slice(0, 24);
  let slug = root;
  for (let i = 0; i < 6; i++) {
    if (!RESERVED_HANDLES.has(slug)) {
      const hit = await client.query("SELECT 1 FROM orgs WHERE slug=$1 AND id<>$2", [slug, exceptOrgId]);
      if (!hit.rowCount) return slug;
    }
    slug = root + "-" + crypto.randomBytes(2).toString("hex");
  }
  return slug;
}

/* Google and Apple both hand back a verified email (and, once, a name) - not
   a password - so signing in and signing up are the same operation here:
   find the org already linked to this provider's subject id, else adopt an
   existing org with a matching email (letting someone who registered with a
   password later sign in with the same address via OAuth), else create a
   fresh one. auth_provider/google_sub/apple_sub are informational only;
   pass_hash still gets a random, never-disclosed value so the NOT NULL
   constraint holds even though this account has no password to check. */
async function findOrCreateOAuthOrg({ provider, sub, email, name }) {
  const subCol = provider === "google" ? "google_sub" : "apple_sub";
  return withSystem(async (client) => {
    let r = await client.query(`SELECT * FROM orgs WHERE ${subCol}=$1`, [sub]);
    if (r.rowCount) return r.rows[0];
    const cleanEmail = (email || "").toLowerCase();
    if (cleanEmail) {
      r = await client.query("SELECT * FROM orgs WHERE email=$1", [cleanEmail]);
      if (r.rowCount) {
        const upd = await client.query(`UPDATE orgs SET ${subCol}=$1 WHERE id=$2 RETURNING *`, [sub, r.rows[0].id]);
        return upd.rows[0];
      }
    }
    // Provisional handle only — the person's name is deliberately NOT used
    // (the store handle is the outlet's address, not the owner's). It is
    // re-derived from the store name at the /welcome onboarding step.
    const base = slugify(cleanEmail ? cleanEmail.split("@")[0] : provider + "-store");
    const slug = await uniqueSlug(client, base);
    const id = uid();
    const placeholderHash = bcrypt.hashSync(crypto.randomBytes(24).toString("hex"), 10);
    /* onboarded=false: a first-time social sign-in still owes the /welcome
       step (store name, currency, PIN) before the till makes sense. */
    const ins = await client.query(
      `INSERT INTO orgs (id, slug, email, pass_hash, store_name, owner_name, auth_provider, ${subCol}, registers, onboarded, setup_step)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,false,'welcome') RETURNING *`,
      [id, slug, cleanEmail || `${sub}@${provider}.oauth.kashikeyopos`, placeholderHash, "My Store", String(name || "").slice(0, 100), provider, sub]);
    return ins.rows[0];
  });
}

async function finishOAuthLogin(org) {
  if (org.status && org.status !== "active") return { error: "this workspace is " + org.status + " - contact support", status: 403 };
  await ensureDefaultStore(org.id, org.store_name);
  const upd = await withOrg(org.id, (client) => client.query("UPDATE orgs SET registers = registers + 1 WHERE id=$1 RETURNING registers", [org.id]));
  const register = "R" + upd.rows[0].registers;
  const pin = await ensureOwnerSeed(org);
  const result = { token: sign(org.id, register, DEFAULT_STORE_ID), slug: org.slug, register, storeId: DEFAULT_STORE_ID };
  if (pin) result.pin = pin;
  /* Tells oauth.js to route this sign-in through /welcome instead of /app —
     the org exists but the owner hasn't named the store or picked a PIN. */
  if (org.onboarded === false) result.needsSetup = true;
  return result;
}

app.get("/api/auth/config", (req, res) => {
  res.json({
    google: GOOGLE_CLIENT_ID ? { enabled: true, clientId: GOOGLE_CLIENT_ID } : { enabled: false },
    apple: APPLE_CLIENT_ID && APPLE_REDIRECT_URI ? { enabled: true, clientId: APPLE_CLIENT_ID, redirectUri: APPLE_REDIRECT_URI } : { enabled: false },
  });
});

app.post("/api/auth/google", wrap(async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: "Google sign-in is not configured" });
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: "missing credential" });
  let payload;
  try { payload = await verifyGoogleIdToken(credential); }
  catch { return res.status(401).json({ error: "Google sign-in failed - please try again" }); }
  const org = await findOrCreateOAuthOrg({ provider: "google", sub: payload.sub, email: payload.email, name: payload.name });
  const result = await finishOAuthLogin(org);
  if (result.error) return res.status(result.status).json({ error: result.error });
  setAppCookieTracked(req, res, result.token, { orgId: org.id, role: "owner", register: result.register, name: (org.owner_name || org.email || "Owner") });
  res.json(result);
}));

/* Apple's web flow POSTs the result to this exact registered Return URL as
   a top-level form submission from the popup Sign in with Apple opens (not
   a fetch call our JS could read the response of directly), so the response
   here is a tiny HTML page that hands the outcome back to the window that
   opened the popup via postMessage, then closes itself. */
app.post("/auth/apple/callback", express.urlencoded({ extended: false }), wrap(async (req, res) => {
  const respond = (payload) => {
    const safe = JSON.stringify(payload).replace(/</g, "\\u003c");
    res.set("Content-Type", "text/html").send(
      `<!doctype html><script>(function(){try{window.opener&&window.opener.postMessage(${safe},window.location.origin);}catch(e){}window.close();})();</script>`);
  };
  if (!APPLE_CLIENT_ID) return respond({ kashikeyoAppleAuth: true, error: "Apple sign-in is not configured" });
  const idToken = req.body && req.body.id_token;
  if (!idToken) return respond({ kashikeyoAppleAuth: true, error: "missing id_token" });
  let payload;
  try { payload = await verifyAppleIdToken(idToken); }
  catch { return respond({ kashikeyoAppleAuth: true, error: "Apple sign-in failed - please try again" }); }
  let name = "";
  try {
    if (req.body.user) { const u = JSON.parse(req.body.user); name = [u.name && u.name.firstName, u.name && u.name.lastName].filter(Boolean).join(" "); }
  } catch {}
  const org = await findOrCreateOAuthOrg({ provider: "apple", sub: payload.sub, email: payload.email, name });
  const result = await finishOAuthLogin(org);
  if (result.error) return respond({ kashikeyoAppleAuth: true, error: result.error });
  setAppCookieTracked(req, res, result.token, { orgId: org.id, role: "owner", register: result.register, name: (org.owner_name || org.email || "Owner") });
  respond(Object.assign({ kashikeyoAppleAuth: true }, result));
}));

app.post("/api/register", wrap(async (req, res) => {
  const { email, password, storeName, ownerName, phone, pin, currency } = req.body || {};
  /* Starter menu choice, matching the onboarding wizard: default 'sample' seeds
     the shared menu (back-compat for callers that omit it); 'empty'/'ai' start
     with no menu and opt out of the boot-time backfill so it stays empty. */
  const menuChoice = String((req.body || {}).menu || "sample").toLowerCase();
  const skipMenu = menuChoice === "empty" || menuChoice === "ai";
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  if (String(password).length < MIN_PASSWORD_LEN) return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LEN} characters` });
  const base = slugify(storeName || email.split("@")[0]);
  const slug = await withSystem((client) => uniqueSlug(client, base));
  const id = uid();
  const cleanOwnerName = String(ownerName || "").slice(0, 100);
  const cleanCurrency = currency === "USD" ? "USD" : "MVR";
  try {
    await withSystem((client) => client.query(
      "INSERT INTO orgs (id, slug, email, pass_hash, store_name, owner_name, phone, registers, skip_default_menu) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8)",
      [id, slug, email.toLowerCase(), bcrypt.hashSync(password, 10), storeName || "My Store", cleanOwnerName, String(phone || "").slice(0, 30), skipMenu]));
  } catch {
    return res.status(409).json({ error: "email already registered - use Sign in" });
  }
  await ensureDefaultStore(id, storeName || "Main Store");
  const initSettings = { storeName: storeName || "My Store", gstBp: 800, loyaltyBp: 10000, svcChargeBp: 0, usdRate: 1542, currency: cleanCurrency, footer: "" };
  await withOrg(id, (client) => client.query(
    "INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'settings','settings',$2) ON CONFLICT (org_id, kind, id) DO NOTHING",
    [id, JSON.stringify(initSettings)]));
  /* Unless the owner asked to start empty (or build with AI), seed the shared
     starter menu — BOTH the category sections AND the sample dishes that fill
     them — same items + photos as every other outlet, on the till and the guest
     portal. seedSampleCategories only lays down the empty sections; without the
     applyMenuItems call the store opened with 36 named-but-empty categories and
     no dishes. Non-fatal. */
  if (!skipMenu) {
    try { await seedSampleCategories(id); } catch (e) { console.warn("sample-categories seed on register skipped:", e.message); }
    try { await applyMenuItems(id, DEFAULT_MENU, CAT_GROUPS, CAT_ORDER, {}); } catch (e) { console.warn("sample-menu seed on register skipped:", e.message); }
  }
  const validPin = /^\d{4}$/.test(String(pin || "")) ? String(pin) : null;
  const seededPin = await ensureOwnerSeed({ id, owner_name: cleanOwnerName, email }, validPin);
  const token = sign(id, "R1", DEFAULT_STORE_ID);
  setAppCookieTracked(req, res, token, { orgId: id, role: "owner", register: "R1", name: (cleanOwnerName || email || "Owner") });
  const result = { token, slug, register: "R1", storeId: DEFAULT_STORE_ID };
  if (seededPin) result.pin = seededPin;
  res.json(result);
}));

/* ── Staged signup (email + password, verified by an email OTP) ───────────────
   Step 1 /api/signup/otp emails a 6-digit code; step 2 /api/signup/verify-otp
   checks it and creates the account with onboarded=false + setup_step='welcome'.
   The /welcome flow then collects the store profile (name, currency, tax), the
   admin till PIN, and any extra users. Social sign-ins skip OTP (the provider
   verified the email) and land on the same /welcome flow. The account is only
   ever created AFTER the code is verified. */
app.post("/api/signup/otp", pubThrottle(6, "otp"), wrap(async (req, res) => {
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  const pw = String((req.body || {}).password || "");
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  const pwErr = passwordProblem(pw); if (pwErr) return res.status(400).json({ error: pwErr });
  const taken = await withSystem((c) => c.query("SELECT 1 FROM orgs WHERE lower(email)=$1 LIMIT 1", [email]));
  if (taken.rowCount) return res.status(409).json({ error: "That email already has an account — sign in instead." });
  const cur = await withSystem((c) => c.query("SELECT last_sent FROM otp_codes WHERE email=$1 AND purpose='signup'", [email]));
  if (cur.rowCount && (Date.now() - new Date(cur.rows[0].last_sent).getTime()) < 45000) return res.status(429).json({ error: "Please wait a moment before requesting another code." });
  const code = genOtp();
  await withSystem((c) => c.query(
    `INSERT INTO otp_codes (email, purpose, code_hash, expires_at, attempts, verified, last_sent, created_at)
     VALUES ($1,'signup',$2, now() + interval '10 minutes', 0, false, now(), now())
     ON CONFLICT (email, purpose) DO UPDATE SET code_hash=$2, expires_at=now() + interval '10 minutes', attempts=0, verified=false, last_sent=now()`,
    [email, otpHash(email, code)]));
  const mail = await sendEmail({ to: email, subject: "Your KashikeyoPOS verification code", html: otpEmailHtml(code), text: "Your KashikeyoPOS verification code is " + code + " (valid for 10 minutes)." });
  const out = { ok: true, configured: mail.configured };
  if (!mail.ok && process.env.NODE_ENV !== "production") out.devCode = code; // lets testing proceed without a mail provider
  res.json(out);
}));

app.post("/api/signup/verify-otp", pubThrottle(12, "otpv"), wrap(async (req, res) => {
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  const code = String((req.body || {}).code || "").trim();
  const pw = String((req.body || {}).password || "");
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  const pwErr = passwordProblem(pw); if (pwErr) return res.status(400).json({ error: pwErr });
  const row = await withSystem((c) => c.query("SELECT code_hash, expires_at, attempts FROM otp_codes WHERE email=$1 AND purpose='signup'", [email]));
  if (!row.rowCount) return res.status(400).json({ error: "Request a code first." });
  const r = row.rows[0];
  if (new Date(r.expires_at).getTime() < Date.now()) return res.status(400).json({ error: "That code has expired — request a new one." });
  if (r.attempts >= 6) return res.status(429).json({ error: "Too many attempts — request a new code." });
  if (otpHash(email, code) !== r.code_hash) {
    await withSystem((c) => c.query("UPDATE otp_codes SET attempts=attempts+1 WHERE email=$1 AND purpose='signup'", [email]));
    return res.status(400).json({ error: "Incorrect code." });
  }
  const taken = await withSystem((c) => c.query("SELECT 1 FROM orgs WHERE lower(email)=$1 LIMIT 1", [email]));
  if (taken.rowCount) return res.status(409).json({ error: "That email already has an account — sign in instead." });
  const slug = await withSystem((c) => uniqueSlug(c, slugify(email.split("@")[0])));
  const id = uid();
  await withSystem((c) => c.query(
    `INSERT INTO orgs (id, slug, email, pass_hash, store_name, owner_name, phone, registers, onboarded, setup_step)
     VALUES ($1,$2,$3,$4,'My Store','','',1,false,'welcome')`,
    [id, slug, email, bcrypt.hashSync(pw, 10)]));
  await ensureDefaultStore(id, "My Store");
  await withOrg(id, (c) => c.query(
    "INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'settings','settings',$2) ON CONFLICT (org_id, kind, id) DO NOTHING",
    [id, JSON.stringify({ storeName: "My Store", gstBp: 800, loyaltyBp: 10000, svcChargeBp: 0, usdRate: 1542, currency: "MVR", footer: "" })]));
  /* The starter menu is NOT seeded here — the /welcome wizard lets the owner
     choose (sample menu / start empty / build with AI), and /api/onboard/finish
     seeds it only if they pick the sample. */
  await withSystem((c) => c.query("DELETE FROM otp_codes WHERE email=$1 AND purpose='signup'", [email]));
  const token = sign(id, "R1", DEFAULT_STORE_ID);
  setAppCookieTracked(req, res, token, { orgId: id, role: "owner", register: "R1", name: email });
  res.json({ ok: true, token, slug, next: "/welcome" });
}));

/* ── Password reset ───────────────────────────────────────────────────────────
   The owner's account password is now the only way into the back office (a till
   PIN no longer mints an owner session) and the only confirmation accepted for
   reset/restore, so forgetting it must not be terminal. Same one-time-code
   machinery as signup, with the differences that matter for a reset:
     - the response never reveals whether an email has an account;
     - a successful reset stamps sessions_invalid_before, so any session an
       attacker already holds dies with the old password;
     - it is written to the append-only activity log.
   Degrades like the rest of the email features: with no RESEND_API_KEY the
   caller is told delivery isn't configured rather than being left waiting. */
const resetEmailHtml = (code) => `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:440px;margin:0 auto;padding:28px 24px;color:#221a12">
  <div style="font-weight:800;font-size:18px;color:#C7431D;margin-bottom:14px">KashikeyoPOS</div>
  <p style="font-size:15px;line-height:1.6;margin:0 0 18px">Use this code to set a new password for your account:</p>
  <div style="font-size:30px;font-weight:800;letter-spacing:.22em;background:#F7F1E8;border-radius:12px;padding:16px;text-align:center">${code}</div>
  <p style="font-size:13px;color:#6b5c4a;line-height:1.6;margin:18px 0 0">It expires in 10 minutes. If you didn't ask to reset your password you can ignore this email — nothing has changed.</p>
</div>`;

app.post("/api/password/forgot", pubThrottle(6, "pwforgot"), wrap(async (req, res) => {
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  /* Answer identically whether or not the account exists, so this can't be used
     to enumerate customers. Everything below is best-effort behind that. */
  const generic = { ok: true, configured: emailConfigured() };
  const org = await withSystem((c) => c.query("SELECT id FROM orgs WHERE lower(email)=$1 LIMIT 1", [email]));
  if (!org.rowCount) return res.json(generic);
  const cur = await withSystem((c) => c.query("SELECT last_sent FROM otp_codes WHERE email=$1 AND purpose='reset'", [email]));
  if (cur.rowCount && (Date.now() - new Date(cur.rows[0].last_sent).getTime()) < 45000) return res.json(generic);
  const code = genOtp();
  await withSystem((c) => c.query(
    `INSERT INTO otp_codes (email, purpose, code_hash, expires_at, attempts, verified, last_sent, created_at)
     VALUES ($1,'reset',$2, now() + interval '10 minutes', 0, false, now(), now())
     ON CONFLICT (email, purpose) DO UPDATE SET code_hash=$2, expires_at=now() + interval '10 minutes', attempts=0, verified=false, last_sent=now()`,
    [email, otpHash(email, code)]));
  const mail = await sendEmail({ to: email, subject: "Reset your KashikeyoPOS password", html: resetEmailHtml(code),
    text: "Your KashikeyoPOS password reset code is " + code + " (valid for 10 minutes)." });
  logActivity(org.rows[0].id, { actor: "system", action: "password.reset_requested", requestId: req.id });
  const out = Object.assign({}, generic);
  if (!mail.ok && process.env.NODE_ENV !== "production") out.devCode = code; // lets testing proceed without a mail provider
  res.json(out);
}));

app.post("/api/password/reset", pubThrottle(12, "pwreset"), wrap(async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || "").trim().toLowerCase();
  const code = String(b.code || "").trim();
  const pw = String(b.password || "");
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  const pwErr = passwordProblem(pw); if (pwErr) return res.status(400).json({ error: pwErr });
  const bad = () => res.status(400).json({ error: "That code is wrong or has expired." });
  const r = (await withSystem((c) => c.query(
    "SELECT code_hash, attempts, expires_at FROM otp_codes WHERE email=$1 AND purpose='reset'", [email]))).rows[0];
  if (!r) return bad();
  if (new Date(r.expires_at).getTime() < Date.now()) return bad();
  if (Number(r.attempts) >= 6) return res.status(429).json({ error: "Too many attempts — request a new code." });
  if (otpHash(email, code) !== r.code_hash) {
    await withSystem((c) => c.query("UPDATE otp_codes SET attempts=attempts+1 WHERE email=$1 AND purpose='reset'", [email]));
    return bad();
  }
  const org = (await withSystem((c) => c.query("SELECT id FROM orgs WHERE lower(email)=$1 LIMIT 1", [email]))).rows[0];
  if (!org) return bad();
  /* New password, and every session issued under the old one is revoked — a
     reset is exactly the moment someone else's foothold should end. */
  await withSystem((c) => c.query(
    "UPDATE orgs SET pass_hash=$2, sessions_invalid_before = now() WHERE id=$1", [org.id, bcrypt.hashSync(pw, 10)]));
  await withSystem((c) => c.query("DELETE FROM otp_codes WHERE email=$1 AND purpose='reset'", [email]));
  logActivity(org.id, { actor: "system", action: "password.reset", requestId: req.id });
  res.json({ ok: true });
}));

/* Onboarding state for the /welcome wizard: which stage to show + prefills. */
app.get("/api/onboard/state", wrap(async (req, res) => {
  const orgId = await resolveAppSession(req);
  if (!orgId) return res.status(401).json({ error: "sign in required" });
  const o = (await withOrg(orgId, (c) => c.query("SELECT store_name, owner_name, email, phone, onboarded, setup_step FROM orgs WHERE id=$1", [orgId]))).rows[0] || {};
  const set = ((await withOrg(orgId, (c) => c.query("SELECT data FROM entities WHERE org_id=$1 AND kind='settings' AND id='settings' AND deleted=false", [orgId]))).rows[0] || {}).data || {};
  const gstBp = Number(set.gstBp);
  const taxStatus = gstBp === 1700 ? "tgst" : gstBp === 800 ? "ggst" : (set.gstBp != null ? "none" : "");
  const displayName = (o.store_name && o.store_name !== "My Store") ? o.store_name : "";
  // Business name prefills from the registered legalName; the trading/outlet name
  // is the display name only when it differs from the business name.
  const businessName = set.legalName || displayName;
  res.json({ ok: true,
    setupStep: o.onboarded ? "done" : (o.setup_step || "welcome"),
    email: o.email || "", storeName: businessName,
    tradeName: (displayName && displayName !== businessName) ? displayName : "",
    ownerName: o.owner_name || "", phone: o.phone || "",
    regNo: set.gstRegNo || "", tin: set.tin || "", address: set.address || "",
    businessActivity: set.businessActivity || "",
    currency: set.currency || "MVR", taxStatus, emailConfigured: emailConfigured() });
}));

/* Welcome stage 1: company details. Business name, mobile and business type are
   mandatory; the registered-entity fields (trading name, registry no., GST TIN,
   address, business activity) are optional and all editable later in Settings →
   Company details — they persist under the same settings keys that screen reads
   (legalName / gstRegNo / tin / address), so onboarding and the cockpit agree.
   Business type is the tax class (general = GGST, tourism = TGST). */
app.post("/api/onboard/profile", wrap(async (req, res) => {
  const orgId = await resolveAppSession(req);
  if (!orgId) return res.status(401).json({ error: "sign in required" });
  const b = req.body || {};
  const businessName = String(b.storeName || "").trim().slice(0, 80);
  const tradeName = String(b.tradeName || "").trim().slice(0, 80);
  const ownerName = String(b.ownerName || "").trim().slice(0, 100);
  const phone = String(b.phone || "").trim().slice(0, 30);
  const currency = b.currency === "USD" ? "USD" : "MVR";
  const taxMap = { none: 0, ggst: 800, tgst: 1700 };
  const taxStatus = String(b.taxStatus || "");
  const gstRegNo = String(b.regNo || "").trim().slice(0, 40);
  const tin = String(b.tin || "").trim().slice(0, 40);
  const address = String(b.address || "").trim().slice(0, 200);
  const ACTIVITIES = ["restaurant", "cafe", "bakery", "retail", "grocery", "salon", "services", "other"];
  const businessActivity = ACTIVITIES.indexOf(String(b.businessActivity || "")) >= 0 ? String(b.businessActivity) : "";
  if (!businessName) return res.status(400).json({ error: "Enter your business name." });
  if (!phone) return res.status(400).json({ error: "Enter a mobile number." });
  if (!Object.prototype.hasOwnProperty.call(taxMap, taxStatus)) return res.status(400).json({ error: "Choose your business type." });
  const gstBp = taxMap[taxStatus];
  const businessType = taxStatus === "tgst" ? "tourism" : taxStatus === "ggst" ? "general" : "unregistered";
  // The trading name the till and storefront show: the separate outlet name if
  // given, else the business name itself. legalName is always the business name.
  const displayName = tradeName || businessName;
  const patch = { storeName: displayName, currency, gstBp, legalName: businessName, businessType };
  if (phone) patch.phone = phone;
  if (gstRegNo) patch.gstRegNo = gstRegNo;
  if (tin) patch.tin = tin;
  if (address) patch.address = address;
  if (businessActivity) patch.businessActivity = businessActivity;
  // First time through the welcome wizard, the store handle is still the
  // provisional one minted at register/OAuth (from the email local part). Now
  // that we know the outlet name, derive the handle from IT — the handle is the
  // storefront's address, not the owner's. Only on the initial welcome step, so
  // a later handle the owner deliberately set is never clobbered. Uniqueness is
  // platform-wide, so it must run under withSystem (RLS hides other orgs).
  let handle = null;
  const firstSetup = await withOrg(orgId, async (c) =>
    (await c.query("SELECT setup_step FROM orgs WHERE id=$1", [orgId])).rows[0]?.setup_step === "welcome");
  if (firstSetup) {
    handle = await withSystem(async (c) => {
      for (let i = 0; i < 3; i++) {
        const slug = await uniqueSlugFor(c, displayName, orgId);
        try {
          const r = await c.query("UPDATE orgs SET slug=$1 WHERE id=$2 RETURNING slug", [slug, orgId]);
          return r.rows[0]?.slug || slug;
        } catch (e) {
          if (String(e && e.code) === "23505") continue; // lost a race for this slug; recompute
          throw e;
        }
      }
      return null;
    });
  }
  await withOrg(orgId, async (c) => {
    await c.query("UPDATE orgs SET store_name=$2, owner_name=COALESCE(NULLIF($3,''),owner_name), phone=COALESCE(NULLIF($4,''),phone), setup_step=CASE WHEN setup_step='welcome' THEN 'pin' ELSE setup_step END WHERE id=$1",
      [orgId, displayName, ownerName, phone]);
    await c.query("UPDATE stores SET name=$3 WHERE org_id=$1 AND id=$2", [orgId, DEFAULT_STORE_ID, displayName]);
    await c.query(
      `INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'settings','settings',$2)
       ON CONFLICT (org_id, kind, id) DO UPDATE SET data = entities.data || $3::jsonb, deleted=false, rowver=nextval('entities_rowver_seq'), updated_at=now()`,
      [orgId, JSON.stringify(Object.assign({ loyaltyBp: 10000, svcChargeBp: 0, usdRate: 1542, footer: "" }, patch)), JSON.stringify(patch)]);
  });
  res.json({ ok: true, next: "pin", handle });
}));

/* Welcome stage 2: the admin till PIN (mandatory) + any extra users (optional).
   Completes onboarding. PINs are validated 4-digit, non-trivial, and unique. */
app.post("/api/onboard/finish", wrap(async (req, res) => {
  const orgId = await resolveAppSession(req);
  if (!orgId) return res.status(401).json({ error: "sign in required" });
  const b = req.body || {};
  const pin = String(b.pin || "").trim();
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: "Set a 4-digit admin PIN." });
  if (/^(\d)\1{3}$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)) return res.status(400).json({ error: "Choose a less predictable PIN (avoid 1234, 0000, 1111…)." });
  const ROLES = { admin: 1, manager: 1, cashier: 1, waiter: 1, kitchen: 1, rider: 1 };
  const raw = Array.isArray(b.users) ? b.users.slice(0, 20) : [];
  const users = []; const pins = new Set([pin]);
  for (const u of raw) {
    const name = String((u && u.name) || "").trim().slice(0, 60);
    if (!name) continue;
    const role = String((u && u.role) || "cashier").toLowerCase();
    const upin = String((u && u.pin) || "").trim();
    if (!ROLES[role]) return res.status(400).json({ error: "Pick a valid role for " + name + "." });
    if (!/^\d{4}$/.test(upin)) return res.status(400).json({ error: "Give " + name + " a 4-digit PIN." });
    if (pins.has(upin)) return res.status(400).json({ error: "PINs must be unique — " + name + "'s PIN is already used." });
    pins.add(upin); users.push({ name, role, pin: upin });
  }
  /* Starter menu choice: 'sample' seeds the shared Maldivian starter menu;
     'empty'/'ai' seed nothing (the owner builds it by hand or with the AI Menu
     Builder in the admin panel). 'ai' lands them in the admin cockpit where the
     builder lives; the others open the till, ready to sell. */
  const menu = String(b.menu || "sample").toLowerCase();
  await withOrg(orgId, async (c) => {
    const org = (await c.query("SELECT owner_name, email FROM orgs WHERE id=$1", [orgId])).rows[0] || {};
    const ownerName = (org.owner_name && org.owner_name.trim()) || (org.email ? org.email.split("@")[0] : "Owner");
    const existing = await c.query("SELECT id, data FROM entities WHERE org_id=$1 AND kind='users' AND deleted=false AND data->>'role'='owner' ORDER BY updated_at ASC LIMIT 1", [orgId]);
    if (existing.rowCount) {
      const d = existing.rows[0].data || {}; d.pin = hashTillPin(pin); if (!d.name) d.name = ownerName; d.role = "owner";
      await c.query("UPDATE entities SET data=$3, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='users' AND id=$2", [orgId, existing.rows[0].id, JSON.stringify(d)]);
    } else {
      const d = { id: uid(), name: ownerName, role: "owner", pin: hashTillPin(pin) };
      await c.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'users',$2,$3)", [orgId, d.id, JSON.stringify(d)]);
    }
    for (const u of users) {
      const d = { id: uid(), name: u.name, role: u.role, pin: hashTillPin(u.pin) };
      await c.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'users',$2,$3)", [orgId, d.id, JSON.stringify(d)]);
    }
    /* Mark the org so the boot-time starter-menu backfill never re-seeds it when
       the owner chose an empty or AI-built menu — otherwise the sample menu
       reappears on the next deploy and their empty menu won't stay empty. */
    await c.query("UPDATE orgs SET onboarded=true, setup_step='done', skip_default_menu=$2 WHERE id=$1", [orgId, menu !== "sample"]);
  });
  if (menu === "sample") {
    try { await seedSampleCategories(orgId); } catch (e) { console.warn("sample-categories seed skipped:", e.message); }
    try { await applyMenuItems(orgId, DEFAULT_MENU, CAT_GROUPS, CAT_ORDER, {}); } catch (e) { console.warn("sample-menu seed skipped:", e.message); }
  }
  // Land a freshly-onboarded store on the v2 terminal — the current build —
  // rather than the legacy /app register. (/app stays reachable for installed
  // offline tills that fetch it directly.)
  res.json({ ok: true, next: "/v2" });
}));

app.post("/api/login", wrap(async (req, res) => {
  const { email, password, storeId } = req.body || {};
  const keys = rlKeys(req, email);
  const blocked = rlBlockedFor(keys);
  if (blocked) return rlDeny(res, blocked);
  const org = await withSystem(async (client) =>
    (await client.query("SELECT * FROM orgs WHERE email=$1", [(email || "").toLowerCase()])).rows[0]);
  if (!org || !bcrypt.compareSync(password || "", org.pass_hash)) { rlFail(keys); return res.status(401).json({ error: "wrong email or password" }); }
  rlClear(keys);
  if (org.status && org.status !== "active") return res.status(403).json({ error: "this workspace is " + org.status + " - contact support" });
  await ensureDefaultStore(org.id, org.store_name);
  const selectedStore = cleanStoreId(storeId || DEFAULT_STORE_ID);
  const storeHit = await withOrg(org.id, (client) => client.query("SELECT 1 FROM stores WHERE org_id=$1 AND id=$2 AND active=true", [org.id, selectedStore]));
  if (!storeHit.rowCount) return res.status(404).json({ error: "unknown store" });
  const upd = await withOrg(org.id, (client) => client.query("UPDATE orgs SET registers = registers + 1 WHERE id=$1 RETURNING registers", [org.id]));
  const register = "R" + upd.rows[0].registers;
  const seededPin = await ensureOwnerSeed(org);
  const token = sign(org.id, register, selectedStore);
  setAppCookieTracked(req, res, token, { orgId: org.id, role: "owner", register, name: (org.owner_name || org.email || "Owner") });
  const result = { token, slug: org.slug, register, storeId: selectedStore };
  if (seededPin) result.pin = seededPin;
  res.json(result);
}));

/* Back-office staff sign-in by store + till PIN (RBAC gaps 3-4). Reuses the
   existing staff `users` entities and their PINs — no new credential. Only
   manager/admin/owner may hold a back-office session; waiter/cashier/kitchen are
   turned away to the till. The session carries the role so /api/inv can enforce
   server-side (not just hide tabs). Throttled like password login; the error is
   deliberately identical for a bad store or a bad PIN so neither can be probed. */
app.post("/api/back/login", wrap(async (req, res) => {
  const { slug, pin } = req.body || {};
  const cleanSlug = String(slug || "").trim().toLowerCase();
  const keys = rlKeys(req, "back:" + cleanSlug);
  const blocked = rlBlockedFor(keys);
  if (blocked) return rlDeny(res, blocked);
  const bad = () => { rlFail(keys); return res.status(401).json({ error: "Unknown store or PIN." }); };
  const org = await orgBySlug(cleanSlug);
  if (!org) return bad();
  if (org.status && org.status !== "active") return res.status(403).json({ error: "This workspace is " + org.status + " — contact support." });
  /* AUDIT-SEC-PIN: PIN login now needs a second factor — this browser must
     already be paired (POST /api/back/pair, gated on the owner's email +
     password) — because the PIN alone is a 4-digit, djb2-hashed, offline-
     verifiable-by-design credential (see web2/proto/index.html's xo()), and
     doubles here as a real back-office session grant. Checked before the PIN
     lookup: it doesn't depend on the PIN, so failing fast here also skips a
     pointless users-table fetch. Doesn't count against the rate limiter — an
     unpaired device isn't a guessing attempt. */
  const deviceId = parseCookies(req)[DEVICE_COOKIE];
  const paired = deviceId && (await withOrg(org.id, (client) => client.query(
    "SELECT 1 FROM paired_devices WHERE org_id=$1 AND device_id=$2 AND revoked=false", [org.id, deviceId]))).rowCount;
  if (!paired) {
    return res.status(403).json({
      error: "This device isn't paired with " + (org.store_name || cleanSlug) + " yet. Sign in with the owner's email and password once to pair it.",
      needsPairing: true,
    });
  }
  const want = pinHash(String(pin || ""));
  const users = await withOrg(org.id, (client) =>
    client.query("SELECT data FROM entities WHERE org_id=$1 AND kind='users' AND deleted=false", [org.id]));
  const me = users.rows.map((r) => r.data).find((u) => u && String(u.pin) === want);
  if (!me) return bad();
  /* Who may hold a terminal (back-office) session. Managers/admins get the full
     cockpit; cashiers and waiters get a scoped session so they can run the POS
     AND receive deliveries / count / adjust stock on shift — the front-line jobs
     a cashier actually does — while the server still enforces every manager-only
     write per endpoint. Kitchen/rider stay on their own apps. Owner uses the
     email + password route below. */
  const TERMINAL_ROLES = { admin: 1, manager: 1, cashier: 1, waiter: 1 };
  if (me.role !== "owner" && !TERMINAL_ROLES[me.role]) { rlFail(keys); return res.status(403).json({ error: "This role signs in on the till app, not the terminal." }); }
  /* An owner session is the keys to the business, and this form asks only for a
     public slug plus a four-digit PIN that every shift-worker device knows. The
     owner already has a first-class route in (email + password, which is what
     the rest of this page does), so the PIN route is closed to them — it stays
     open for managers and admins, whose rank cannot reset, restore or delete a
     backup anyway. */
  if (me.role === "owner") {
    rlFail(keys);
    return res.status(403).json({ error: "That PIN belongs to the account owner. Sign in with your email and password instead.", ownerUsePassword: true });
  }
  rlClear(keys);
  await ensureDefaultStore(org.id, org.store_name);
  const storeId = cleanStoreId(me.storeId || DEFAULT_STORE_ID);
  { const btok = sign(org.id, "BACK", storeId, { role: me.role, staff: { id: me.id, name: me.name } }); setAppCookieTracked(req, res, btok, { orgId: org.id, role: me.role, register: "BACK", name: me.name, staffId: me.id }); }
  withOrg(org.id, (client) => client.query("UPDATE paired_devices SET last_seen=now() WHERE org_id=$1 AND device_id=$2", [org.id, deviceId])).catch(() => {});
  res.json({ ok: true, role: me.role, name: me.name, slug: org.slug });
}));

/* AUDIT-SEC-PIN: proves this browser to a store ONCE, with the owner's real
   credential (email + password — the same check /api/login makes), so a
   subsequent PIN login from it can be trusted with a real back-office
   session. Deliberately does NOT itself grant a session — pairing and
   signing in are separate actions, so a device can be pre-paired by the
   owner without that act alone letting the pairing browser into the books. */
app.post("/api/back/pair", wrap(async (req, res) => {
  const { slug, email, password } = req.body || {};
  const cleanSlug = String(slug || "").trim().toLowerCase();
  const keys = rlKeys(req, "pair:" + cleanSlug + ":" + String(email || "").toLowerCase());
  const blocked = rlBlockedFor(keys);
  if (blocked) return rlDeny(res, blocked);
  const org = await orgBySlug(cleanSlug);
  const bad = () => { rlFail(keys); return res.status(401).json({ error: "Wrong store, email or password." }); };
  if (!org) return bad();
  if (String(org.email || "").toLowerCase() !== String(email || "").toLowerCase() || !bcrypt.compareSync(password || "", org.pass_hash)) return bad();
  rlClear(keys);
  if (org.status && org.status !== "active") return res.status(403).json({ error: "This workspace is " + org.status + " — contact support." });
  let deviceId = parseCookies(req)[DEVICE_COOKIE];
  if (!deviceId) deviceId = crypto.randomUUID();
  setDeviceCookie(res, deviceId);
  await withOrg(org.id, (client) => client.query(
    `INSERT INTO paired_devices (org_id, device_id, name, ip) VALUES ($1,$2,$3,$4)
     ON CONFLICT (org_id, device_id) DO UPDATE SET revoked=false, last_seen=now(), name=EXCLUDED.name, ip=EXCLUDED.ip`,
    [org.id, deviceId, deviceOf(req), req.ip || ""]));
  logActivity(org.id, { actor: org.owner_name || "owner", action: "device.paired", requestId: req.id, detail: { device: deviceOf(req) } });
  res.json({ ok: true });
}));

/* A browser can hold a valid app-session cookie without ever having gone
   through /login on that device — e.g. the owner's phone that only opened
   /back. The till bundle reads its cloud pairing from localStorage, so on
   such a device /app boots into the bundle's baked-in standalone demo
   ("Nexus Café") instead of the user's store. This mints the pairing for
   the cookie's org (new register, same as a fresh login) so "Open the
   till" works from any signed-in device; the caller stores it in
   localStorage before navigating. */
/* SEC-03: exchange the store password for a short-lived (15 min) manager-
   elevation token. The till PIN is a shift selector, not a security boundary —
   manager-authorised actions (refunds) prove themselves with the server-
   verified store password instead. Throttled like login so a stolen device
   token can't brute-force the password. */
app.post("/api/elevate", auth, wrap(async (req, res) => {
  const keys = rlKeys(req, "elev:" + req.org.o);
  const blocked = rlBlockedFor(keys);
  if (blocked) return rlDeny(res, blocked);
  const org = await withSystem(async (client) =>
    (await client.query("SELECT pass_hash FROM orgs WHERE id=$1", [req.org.o])).rows[0]);
  if (!org || !bcrypt.compareSync((req.body && req.body.password) || "", org.pass_hash)) {
    rlFail(keys);
    return res.status(401).json({ error: "wrong password" });
  }
  rlClear(keys);
  await logActivity(req.org.o, { actor: "manager", action: "elevate.grant", ref: req.org.r || "", requestId: req.id, detail: {} });
  res.json({ elevation: jwt.sign({ o: req.org.o, e: true }, SECRET, { expiresIn: "15m" }), ttlSec: 900 });
}));

/* SEC-3: "sign out all devices" kill switch. Stamps orgs.sessions_invalid_before
   = now(), so every token issued before this moment is refused on the money path
   (/api/ops) — the remedy for a lost/stolen device or a departed employee.
   Manager-authorised (needs a fresh /api/elevate token) so a stolen till token
   can't lock the store out. The caller re-logs in afterwards to get a new token. */
app.post("/api/revoke-devices", auth, wrap(async (req, res) => {
  const elevTok = req.get("X-Elevation");
  let elevated = false;
  if (elevTok) { try { const e = jwt.verify(elevTok, SECRET); elevated = e.e === true && e.o === req.org.o; } catch { /* invalid */ } }
  if (!elevated) return res.status(403).json({ error: "Manager approval required — verify the store password first." });
  await withOrg(req.org.o, (client) => client.query("UPDATE orgs SET sessions_invalid_before = now() WHERE id=$1", [req.org.o]));
  await logActivity(req.org.o, { actor: "manager", action: "sessions.revoked", ref: req.org.r || "", requestId: req.id, detail: {} });
  res.json({ ok: true, message: "All devices signed out. Sign in again to continue." });
}));

app.post("/api/pair", wrap(async (req, res) => {
  const orgId = await resolveAppSession(req);
  if (!orgId) return res.status(401).json({ error: "sign in required" });
  const org = await withSystem(async (client) => (await client.query("SELECT * FROM orgs WHERE id=$1", [orgId])).rows[0]);
  if (!org) return res.status(401).json({ error: "sign in required" });
  const result = await finishOAuthLogin(org);
  if (result.error) return res.status(result.status).json({ error: result.error });
  setAppCookieTracked(req, res, result.token, { orgId: org.id, role: "owner", register: result.register, name: (org.owner_name || org.email || "Owner") });
  res.json(result);
}));

/* Completes onboarding for an org created by a first-time social sign-in:
   names the store, sets the currency, and (re)sets the owner's name and
   till PIN — the same facts the email signup wizard collects up front. */
app.post("/api/onboard", wrap(async (req, res) => {
  const orgId = await resolveAppSession(req);
  if (!orgId) return res.status(401).json({ error: "sign in required" });
  const { storeName, currency, ownerName, pin } = req.body || {};
  const cleanStore = String(storeName || "").trim().slice(0, 80);
  if (!cleanStore) return res.status(400).json({ error: "give your store a name" });
  const cleanCurrency = currency === "USD" ? "USD" : "MVR";
  const cleanOwner = String(ownerName || "").trim().slice(0, 100);
  const cleanPin = /^\d{4}$/.test(String(pin || "")) ? String(pin) : null;
  await withOrg(orgId, async (client) => {
    await client.query("UPDATE orgs SET store_name=$2, owner_name=COALESCE(NULLIF($3,''), owner_name), onboarded=true WHERE id=$1",
      [orgId, cleanStore, cleanOwner]);
    await client.query("UPDATE stores SET name=$3 WHERE org_id=$1 AND id=$2", [orgId, DEFAULT_STORE_ID, cleanStore]);
    const defaults = { storeName: cleanStore, gstBp: 800, loyaltyBp: 10000, svcChargeBp: 0, usdRate: 1542, currency: cleanCurrency, footer: "" };
    await client.query(
      `INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'settings','settings',$2)
       ON CONFLICT (org_id, kind, id) DO UPDATE SET
         data = entities.data || jsonb_build_object('storeName',$3::text,'currency',$4::text),
         deleted=false, rowver=nextval('entities_rowver_seq'), updated_at=now()`,
      [orgId, JSON.stringify(defaults), cleanStore, cleanCurrency]);
    if (cleanOwner || cleanPin) {
      /* the seeded owner from ensureOwnerSeed — first (usually only) owner-role user */
      const owner = await client.query(
        "SELECT id, data FROM entities WHERE org_id=$1 AND kind='users' AND deleted=false AND data->>'role'='owner' ORDER BY updated_at ASC LIMIT 1", [orgId]);
      if (owner.rowCount) {
        const d = owner.rows[0].data;
        if (cleanOwner) d.name = cleanOwner;
        if (cleanPin) d.pin = hashTillPin(cleanPin);
        await client.query(
          "UPDATE entities SET data=$3, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='users' AND id=$2",
          [orgId, owner.rows[0].id, JSON.stringify(d)]);
      }
    }
  });
  res.json({ ok: true });
}));

app.post("/api/logout", (req, res) => {
  res.clearCookie(APP_COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.post("/api/dev/login", wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const keys = rlKeys(req, "dev:" + (email || ""));
  const blocked = rlBlockedFor(keys);
  if (blocked) return rlDeny(res, blocked);
  const r = await pool.query("SELECT * FROM platform_admins WHERE email=$1", [(email || "").toLowerCase()]);
  const admin = r.rows[0];
  if (!admin || !bcrypt.compareSync(password || "", admin.pass_hash)) { rlFail(keys); return res.status(401).json({ error: "wrong email or password" }); }
  rlClear(keys);
  setDevCookie(res, signAdmin(admin.id));
  res.json({ ok: true, admin: { id: admin.id, email: admin.email, name: admin.name } });
}));

app.post("/api/dev/logout", wrap(async (req, res) => {
  res.clearCookie(DEV_COOKIE, { path: "/" });
  res.json({ ok: true });
}));

app.get("/api/dev/me", devAuth, wrap(async (req, res) => {
  res.json({ admin: req.admin });
}));

const DEV_PLANS = new Set(["trial", "starter", "pro", "enterprise"]);
const DEV_STATUSES = new Set(["active", "suspended", "cancelled"]);

app.get("/api/dev/orgs", devAuth, wrap(async (req, res) => {
  const [orgs, stores, usage] = await withSystem((client) => Promise.all([
    client.query("SELECT id, slug, store_name, owner_name, email, phone, plan, status, registers, trial_ends_at, created_at FROM orgs ORDER BY created_at DESC"),
    client.query("SELECT org_id, count(*)::int AS n FROM stores WHERE active=true GROUP BY org_id"),
    client.query("SELECT org_id, kind, count(*)::int AS n FROM entities WHERE deleted=false AND kind IN ('orders','products','customers') GROUP BY org_id, kind"),
  ]));
  const storeCount = new Map(stores.rows.map((r) => [r.org_id, r.n]));
  const usageByOrg = new Map();
  for (const row of usage.rows) {
    if (!usageByOrg.has(row.org_id)) usageByOrg.set(row.org_id, { orders: 0, products: 0, customers: 0 });
    usageByOrg.get(row.org_id)[row.kind] = row.n;
  }
  res.json({
    orgs: orgs.rows.map((o) => ({
      id: o.id, slug: o.slug, storeName: o.store_name, ownerName: o.owner_name, email: o.email, phone: o.phone,
      plan: o.plan, status: o.status, registers: o.registers, trialEndsAt: o.trial_ends_at, createdAt: o.created_at,
      stores: storeCount.get(o.id) || 0,
      usage: usageByOrg.get(o.id) || { orders: 0, products: 0, customers: 0 },
    })),
  });
}));

app.patch("/api/dev/orgs/:id", devAuth, wrap(async (req, res) => {
  const { plan, status } = req.body || {};
  if (plan !== undefined && !DEV_PLANS.has(plan)) return res.status(400).json({ error: "invalid plan" });
  if (status !== undefined && !DEV_STATUSES.has(status)) return res.status(400).json({ error: "invalid status" });
  if (plan === undefined && status === undefined) return res.status(400).json({ error: "nothing to update" });
  const r = await withSystem((client) => client.query(
    `UPDATE orgs SET plan=COALESCE($2,plan), status=COALESCE($3,status) WHERE id=$1
     RETURNING id, slug, plan, status`,
    [req.params.id, plan || null, status || null]));
  if (!r.rowCount) return res.status(404).json({ error: "unknown store" });
  res.json({ org: r.rows[0] });
}));

app.get("/api/dev/health", devAuth, wrap(async (req, res) => {
  const dbEnv = { databaseUrl: !!databaseUrl, pgEnv: hasPgEnv };
  const startedAt = Date.now();
  let dbOk = true, dbMs = null;
  try { await pool.query("SELECT 1"); dbMs = Date.now() - startedAt; }
  catch { dbOk = false; }
  const totals = await withSystem((client) => client.query(
    "SELECT (SELECT count(*)::int FROM orgs) AS orgs, (SELECT count(*)::int FROM stores WHERE active=true) AS stores, (SELECT count(*)::int FROM entities WHERE deleted=false) AS entities"));
  const mem = process.memoryUsage();
  res.json({
    db: { ok: dbOk, ms: dbMs, ...dbEnv },
    uptimeSec: Math.round((Date.now() - bootedAt) / 1000),
    node: process.version,
    memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
    totals: totals.rows[0],
    recentErrors,
  });
}));

app.get("/api/stores", auth, wrap(async (req, res) => {
  await ensureDefaultStore(req.org.o);
  const r = await withOrg(req.org.o, (client) => client.query("SELECT id, code, name, address, active, created_at FROM stores WHERE org_id=$1 ORDER BY created_at ASC", [req.org.o]));
  res.json({ stores: r.rows.map((s) => ({ id: s.id, code: s.code, name: s.name, address: s.address, active: s.active, createdAt: s.created_at })) });
}));

app.post("/api/stores", auth, wrap(async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "store name required" });
  const id = cleanStoreId(req.body?.id || name);
  const code = String(req.body?.code || id).toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 16) || "STORE";
  const address = String(req.body?.address || "").slice(0, 200);
  const r = await withOrg(req.org.o, (client) => client.query(
    `INSERT INTO stores (org_id, id, code, name, address) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (org_id, id) DO UPDATE SET code=excluded.code, name=excluded.name, address=excluded.address, active=true
     RETURNING id, code, name, address, active`,
    [req.org.o, id, code, name, address]));
  res.json({ store: r.rows[0] });
}));

app.post("/api/select-store", auth, wrap(async (req, res) => {
  const storeId = cleanStoreId(req.body?.storeId || req.query.storeId || DEFAULT_STORE_ID);
  const hit = await withOrg(req.org.o, (client) => client.query("SELECT * FROM stores WHERE org_id=$1 AND id=$2 AND active=true", [req.org.o, storeId]));
  if (!hit.rowCount) return res.status(404).json({ error: "unknown store" });
  res.json({ token: sign(req.org.o, req.org.r, storeId), register: req.org.r, storeId, store: hit.rows[0] });
}));

app.post("/api/ops", auth, wrap(async (req, res) => {
  const ops = (req.body && req.body.ops) || [];
  /* Request validation (audit API-01): reject grossly malformed or oversized
     batches up front rather than trusting the shape downstream. Individual
     missing fields are still tolerated (offline clients vary), but the outer
     shape and sizes are enforced. */
  if (!Array.isArray(ops)) return res.status(400).json({ error: "ops must be an array" });
  if (ops.length > 1000) return res.status(413).json({ error: "too many ops in one request (max 1000)" });
  for (const op of ops) {
    if (op && Array.isArray(op.puts) && op.puts.length > 2000) return res.status(413).json({ error: "too many puts in one op (max 2000)" });
    if (op && Array.isArray(op.dels) && op.dels.length > 2000) return res.status(413).json({ error: "too many dels in one op (max 2000)" });
  }
  /* SEC-03: a valid short-lived elevation token (store password verified via
     POST /api/elevate) marks this batch as manager-authorised; refund puts
     below use it. An invalid/expired token is simply ignored — the refund
     still syncs, just flagged for review. */
  let elevated = false;
  const elevTok = req.get("X-Elevation");
  if (elevTok) { try { const e = jwt.verify(elevTok, SECRET); elevated = e.e === true && e.o === req.org.o; } catch { /* not elevated */ } }
  const client = await pool.connect();
  let rowver = 0;
  const settledSales = [];
  const auditEvents = []; // written to activity_log after a successful commit (FIN-03)
  const droppedWrites = []; // AUDIT-MED-CONFLICT: pushes the staleness guard kept the stored copy over
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id',$1,true), set_config('app.is_superadmin','off',true)", [String(req.org.o)]);
    /* SEC-3: recheck the org on the money-writing path — a suspended/closed store,
       or a token issued before a "sign out all devices" cut-off, is refused here
       even though its long-lived JWT still verifies. Reads (pull/events) stay
       permissive; the risk is writes (fraudulent sales/refunds). */
    /* Floor the cut-off to whole seconds: JWT `iat` is integer seconds, so a
       token minted in the same second as a revoke must still count as issued
       "at" the cut-off (valid), while anything from an earlier second is killed. */
    const orgChk = await client.query("SELECT status, FLOOR(EXTRACT(EPOCH FROM sessions_invalid_before)) AS sib FROM orgs WHERE id=$1", [req.org.o]);
    if (!orgChk.rowCount || (orgChk.rows[0].status && orgChk.rows[0].status !== "active")) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "This store is not active — contact the owner.", requestId: req.id });
    }
    if (orgChk.rows[0].sib && req.org.iat && Number(req.org.iat) < Number(orgChk.rows[0].sib)) {
      await client.query("ROLLBACK");
      return res.status(401).json({ error: "Session ended — please sign in again.", requestId: req.id });
    }
    /* Money-integrity context (FIN-01): the catalogue prices + GST rate this org
       is authoritative for, fetched once per sync only when the batch actually
       carries a sale, so ordinary syncs pay nothing. */
    let moneyCtx = null;
    if (ops.some((o) => (o.puts || []).some((p) => p.kind === "sales"))) {
      const [setRes, prodRes] = await Promise.all([
        client.query("SELECT data FROM entities WHERE org_id=$1 AND kind='settings' AND id='settings' AND deleted=false LIMIT 1", [req.org.o]),
        client.query("SELECT data->>'id' AS id, data->>'price' AS price, data->>'openPrice' AS op FROM entities WHERE org_id=$1 AND kind='products' AND deleted=false", [req.org.o]),
      ]);
      const st = setRes.rows[0] ? setRes.rows[0].data : {};
      const prices = new Map();
      for (const r of prodRes.rows) prices.set(String(r.id), { price: Number(r.price) || 0, open: r.op === "true" });
      const discLim = Number(st.discountLimitPct);
      moneyCtx = { gstBp: Number(st.gstBp) || 0, svcBp: Number(st.svcChargeBp) || 0, prices, discLimitPct: (discLim > 0 && discLim <= 100) ? discLim : 50 };
    }
    for (const op of ops) {
      const storeId = opStore(req, op);
      await client.query("INSERT INTO stores (org_id, id, code, name) VALUES ($1,$2,$3,$4) ON CONFLICT (org_id, id) DO NOTHING", [req.org.o, storeId, storeId.toUpperCase().slice(0, 16), storeId === DEFAULT_STORE_ID ? "Main Store" : storeId]);
      const dup = await client.query(
        "INSERT INTO ops (org_id, op_id, register, store_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING 1",
        [req.org.o, op.opId || uid(), req.org.r, storeId]);
      if (!dup.rowCount) continue;
      for (const p of op.puts || []) {
        const shared = SHARED_KINDS.has(p.kind) && !p.storeId && !(p.data && p.data.storeId);
        const data = { ...(p.data || {}) };
        data.id = String(data.id || p.id);
        if (!shared) data.storeId = cleanStoreId(p.storeId || data.storeId || storeId);
        /* FIN-C1: every reporting query (accounting, GST return, P&L, top
           sellers) filters on `data->>'t'`, but the register stamps the sale
           time as `at`/`createdAt` and never writes `t` — and `NULL BETWEEN
           x AND y` is NULL, so those reports matched no rows and the owner's
           GST return drafted as a nil return on a full day of trade. Normalise
           the timestamp once here, on the way in, so there is a single field
           reports can rely on. Falls back to ingest time rather than leaving a
           money row outside every period. */
        if (data.t == null || !(Number(data.t) > 0)) {
          const ts = Number(data.at) || Number(data.createdAt) || Number(data.ts) || 0;
          if (ts > 0) data.t = ts;
          else if (TIMED_KINDS.has(p.kind)) data.t = Date.now();
        }
        /* FIN-01: re-check the sale's money against the catalogue + GST rate and
           flag (never reject) any inconsistency, so a tampered or mis-priced
           sale is accepted-but-quarantined for manager review rather than
           silently trusted. */
        if (p.kind === "sales" && data.lines) {
          const money = auditSaleMoney(data, moneyCtx);
          if (money) { data.serverAudit = money; recordError(`sale money-check ${data.no || data.id}`, new Error(money.reasons.join("; "))); auditEvents.push({ actor: data.userName || "", action: "sale.flagged", ref: data.no || data.id, detail: { claimedTotal: money.claimedTotal, computedTotal: money.computedTotal, reasons: money.reasons } }); }
        }
        /* SEC-03 (audit B3): a large discount / comp is a manager-authorised
           action just like a refund. The till gates it in the UI, but the
           server must not trust that. Past the store's discount ceiling (a
           settings %, default 50), require a manager elevation on the batch:
           without one the sale still syncs (offline-safe, money is never
           rejected) but is flagged into the Review tab and logged; with one it
           is stamped approved. Free-of-charge (foc) and refunds are exempt —
           foc is legitimately 0 and refunds have their own approval path. */
        if (p.kind === "sales" && data.type !== "refund" && !data.foc && Array.isArray(data.lines) && data.lines.length && moneyCtx) {
          const discPct = effectiveDiscountPct(data);
          /* Flag only a discount PAST the ceiling, not one exactly AT it: a store
             that sets a 50% limit means 50% is allowed. The reason text and the
             "past the ceiling" intent both read as strictly-greater; `>=` spuriously
             flagged every at-limit sale for manager review (FIN-01 boundary). */
          if (discPct > moneyCtx.discLimitPct) {
            if (elevated) { if (!data.managerApproved) data.managerApproved = { method: "password", at: Date.now(), for: "discount" }; }
            else {
              const sa = (data.serverAudit && data.serverAudit.flagged) ? data.serverAudit : { flagged: true, at: Date.now(), claimedTotal: Number(data.total) || 0, computedTotal: Number(data.total) || 0, reasons: [] };
              if (!(sa.reasons || []).some((r) => String(r).startsWith("discount"))) sa.reasons = (sa.reasons || []).concat(`discount ${discPct}% over ${moneyCtx.discLimitPct}% without manager approval`);
              data.serverAudit = sa;
              auditEvents.push({ actor: data.userName || "", action: "sale.discount_over_limit", ref: data.no || data.id, detail: { discPct, limit: moneyCtx.discLimitPct, total: data.total } });
            }
          }
        }
        /* SEC-03: refunds are manager-authorised money movements. Client-supplied
           approval is never trusted; the server carries forward its OWN earlier
           stamp, or grants a fresh one when the batch is elevated. Without
           approval the refund still syncs — money data from a till is never
           rejected (offline-safe) — but is flagged into the Review tab. */
        if (p.kind === "sales" && data.type === "refund") {
          delete data.managerApproved;
          const prev = await client.query(
            "SELECT data->'managerApproved' AS ma FROM entities WHERE org_id=$1 AND kind='sales' AND id=$2 AND deleted=false", [req.org.o, data.id]);
          if (prev.rowCount && prev.rows[0].ma) data.managerApproved = prev.rows[0].ma;
          else if (elevated) data.managerApproved = { method: "password", at: Date.now() };
          if (data.managerApproved) {
            /* a stale needs-approval flag from an earlier unapproved push clears once approved */
            if (data.serverAudit && Array.isArray(data.serverAudit.reasons)) {
              const left = data.serverAudit.reasons.filter((r) => r !== "refund without manager approval");
              if (!left.length) delete data.serverAudit; else data.serverAudit.reasons = left;
            }
          } else {
            const sa = (data.serverAudit && data.serverAudit.flagged) ? data.serverAudit : { flagged: true, at: Date.now(), claimedTotal: Number(data.total) || 0, computedTotal: Number(data.total) || 0, reasons: [] };
            if (!(sa.reasons || []).includes("refund without manager approval")) sa.reasons = (sa.reasons || []).concat("refund without manager approval");
            data.serverAudit = sa;
          }
          /* The cashier is required to type a reason and the till has always
             sent it, but the audit row dropped it — so the admin's promise of
             "reason tracking" was not kept by the record it pointed at. It is
             the one field that makes a refund reviewable months later. */
          auditEvents.push({ actor: data.userName || "", action: "sale.refund", ref: data.no || data.id, detail: { total: data.total, reason: String(data.reason || "").slice(0, 140), refundOf: data.refundOf || null, customerId: data.customerId || null, approved: !!data.managerApproved } });
        }
        const preserve = p.kind === "products"
          /* The till bundle is prebuilt and doesn't know about the back-office-
             managed menu meta (allergens, add-ons, spice levels, guest-note
             toggle, no-kitchen flag) or the photo — so its product pushes omit
             them. Keep whatever the DB already holds for those owner-set fields
             so a routine till re-sync can't wipe an owner's menu customisation.
             (Same protective intent as stock: the server/back office is the
             authority, the till is not.) A non-empty img in the push still wins
             so photos set on the till aren't ignored. */
          /* Preserve an existing stock count (server is authoritative), else take
             one the till sent, else leave the item stock-UNtracked. The old
             `COALESCE(..., '0')` fallback forced stock:0 onto every untracked
             menu item the till re-synced, which flipped the whole menu to
             "sold out" and hid it from the guest portal. Untracked items must
             stay always-available (no stock key). */
          ? " || CASE WHEN entities.data ? 'stock' THEN jsonb_build_object('stock', entities.data->'stock') WHEN excluded.data ? 'stock' THEN jsonb_build_object('stock', excluded.data->'stock') ELSE '{}'::jsonb END" +
            " || CASE WHEN entities.data ? 'allergens'   THEN jsonb_build_object('allergens',   entities.data->'allergens')   ELSE '{}'::jsonb END" +
            " || CASE WHEN entities.data ? 'addons'      THEN jsonb_build_object('addons',      entities.data->'addons')      ELSE '{}'::jsonb END" +
            " || CASE WHEN entities.data ? 'spiceLevels' THEN jsonb_build_object('spiceLevels', entities.data->'spiceLevels') ELSE '{}'::jsonb END" +
            " || CASE WHEN entities.data ? 'comments'    THEN jsonb_build_object('comments',    entities.data->'comments')    ELSE '{}'::jsonb END" +
            " || CASE WHEN entities.data ? 'noKitchen'   THEN jsonb_build_object('noKitchen',   entities.data->'noKitchen')   ELSE '{}'::jsonb END" +
            " || CASE WHEN entities.data ? 'hidden'      THEN jsonb_build_object('hidden',      entities.data->'hidden')      ELSE '{}'::jsonb END" +
            " || CASE WHEN COALESCE(excluded.data->>'img','')='' AND entities.data ? 'img' THEN jsonb_build_object('img', entities.data->'img') ELSE '{}'::jsonb END" +
            /* Dhivehi name is server/owner-authoritative like the photo: a till
               re-sync (whose local copy may predate the Dhivehi names) must not
               wipe it. A non-empty dv in the push still wins. This is why a few
               till-touched items (e.g. an 86'd or re-priced one) reverted to
               English while the rest stayed Dhivehi. */
            " || CASE WHEN COALESCE(excluded.data->>'dv','')='' AND entities.data ? 'dv' THEN jsonb_build_object('dv', entities.data->'dv') ELSE '{}'::jsonb END" +
            " || CASE WHEN COALESCE(excluded.data->>'descDv','')='' AND entities.data ? 'descDv' THEN jsonb_build_object('descDv', entities.data->'descDv') ELSE '{}'::jsonb END"
          : p.kind === "customers"
            ? " || jsonb_build_object('points', COALESCE(entities.data->'points', excluded.data->'points', '0'::jsonb), 'balance', COALESCE(entities.data->'balance', excluded.data->'balance', '0'::jsonb))"
            : p.kind === "pords"
              /* A PO received in the back office must never be re-opened by a
                 till pushing its stale local copy (same echo race the stock
                 and points fields have). Received is terminal either way. */
              ? " || CASE WHEN entities.data->>'status'='received' THEN jsonb_build_object('status','received','receivedAt',COALESCE(entities.data->'receivedAt',excluded.data->'receivedAt'),'receivedVia',COALESCE(entities.data->'receivedVia',excluded.data->'receivedVia')) ELSE '{}'::jsonb END"
              : p.kind === "settings"
                /* The owner's menu geography (category groups + flat order) lives
                   on settings; keep it if a till pushes a settings snapshot taken
                   before it learned it (same protective intent as product meta). */
                ? " || CASE WHEN NOT (excluded.data ? 'catOrder')  AND entities.data ? 'catOrder'  THEN jsonb_build_object('catOrder',  entities.data->'catOrder')  ELSE '{}'::jsonb END" +
                  " || CASE WHEN NOT (excluded.data ? 'catGroups') AND entities.data ? 'catGroups' THEN jsonb_build_object('catGroups', entities.data->'catGroups') ELSE '{}'::jsonb END" +
                  " || CASE WHEN NOT (excluded.data ? 'defaultsUntracked') AND entities.data ? 'defaultsUntracked' THEN jsonb_build_object('defaultsUntracked', entities.data->'defaultsUntracked') ELSE '{}'::jsonb END" +
                  " || CASE WHEN NOT (excluded.data ? 'outletPrefs') AND entities.data ? 'outletPrefs' THEN jsonb_build_object('outletPrefs', entities.data->'outletPrefs') ELSE '{}'::jsonb END"
                : p.kind === "sales"
                  /* AUDIT-C2: a settled sale's money must be immutable once
                     synced — nothing in this codebase legitimately rewrites
                     total/lines/payments/tender for an id that already has a
                     total (void goes through op.dels as a soft-delete; a
                     refund is its own new id; the discount/refund-approval
                     stamping above only adds managerApproved/serverAudit).
                     Without this, the staleness guard above is the ONLY
                     defense, and a client trivially wins it by declaring a
                     newer updatedAt — so a re-push of the same sale id with a
                     different total silently overwrote the original, with
                     auditSaleMoney only checking the incoming payload's own
                     internal math, never the record's prior state. Pin the
                     money fields to whatever is already stored once a total
                     exists; first-time inserts are untouched (this only
                     applies inside DO UPDATE, never the initial INSERT). */
                  ? " || CASE WHEN entities.data ? 'total' THEN jsonb_build_object('total', entities.data->'total', 'lines', entities.data->'lines', 'payments', entities.data->'payments', 'tender', entities.data->'tender') ELSE '{}'::jsonb END"
                  : "";
        /* Staleness guard (audit A-M1). The upsert was pure last-write-wins: an
           OLDER push overwrote a newer one. That is why the preserve-clause
           chain above exists at all — it is a per-field patch for the same
           underlying problem, added once for each time a stale terminal wiped a
           photo, a Dhivehi name, a stock count or a PO status. When BOTH sides
           carry an explicit numeric updatedAt and the incoming one is older, we
           keep what is stored. When either side lacks it we fall through to the
           old behaviour, so nothing that works today stops working. */
        const r = await client.query(
          `INSERT INTO entities (org_id, kind, id, data, deleted, updated_at)
           VALUES ($1,$2,$3,$4,false,now())
           ON CONFLICT (org_id, kind, id)
           DO UPDATE SET data = (CASE
               WHEN jsonb_exists(excluded.data,'updatedAt') AND jsonb_exists(entities.data,'updatedAt')
                    AND (excluded.data->>'updatedAt') ~ '^[0-9]+$' AND (entities.data->>'updatedAt') ~ '^[0-9]+$'
                    AND (excluded.data->>'updatedAt')::numeric < (entities.data->>'updatedAt')::numeric
               THEN entities.data ELSE excluded.data END)${preserve}, deleted=false, rowver=nextval('entities_rowver_seq'), updated_at=now()
           RETURNING rowver, data->>'updatedAt' AS "storedUpdatedAt"`,
          [req.org.o, p.kind, String(p.id), JSON.stringify(data)]);
        rowver = Math.max(rowver, Number(r.rows[0].rowver));
        if (p.kind === "sales" && data.lines) settledSales.push(data);
        /* AUDIT-MED-CONFLICT: the staleness guard above silently kept the
           stored (newer) copy with no signal back to the client that pushed
           the losing write — the device's own optimistic local copy then just
           got reverted on its next pull with no explanation. Detect that here
           (the final stored updatedAt doesn't match what we tried to write)
           and report it, so the client can tell the operator and refresh
           instead of quietly diverging from the server's truth. Only fires
           when this push actually carried a comparable updatedAt — the
           either-side-missing fallback still always applies the incoming
           write, so there is nothing to report there. */
        if (data.updatedAt != null && /^[0-9]+$/.test(String(data.updatedAt))
            && String(r.rows[0].storedUpdatedAt) !== String(data.updatedAt)) {
          droppedWrites.push({ kind: p.kind, id: String(p.id) });
        }
      }
      const dz = op.deltas || {};
      for (const s of dz.stock || []) {
        /* Only products that already carry a numeric stock value are stock-
           tracked; a sale must never conjure a stock field onto an untracked
           item (that used to drive it to -1 and lock it "sold out"). Clamp at
           zero so an oversell floors instead of going negative. */
        const r = await client.query(
          `UPDATE entities SET
             data = jsonb_set(data, '{stock}', to_jsonb(GREATEST(0, (data->>'stock')::numeric + $4)), true),
             rowver = nextval('entities_rowver_seq'), updated_at = now()
           WHERE org_id=$1 AND kind='products' AND id=$2 AND COALESCE(data->>'storeId',$3) IN ('global',$3)
             AND jsonb_typeof(data->'stock') = 'number'
           RETURNING rowver`, [req.org.o, String(s.id), storeId, Number(s.d) || 0]);
        for (const row of r.rows) rowver = Math.max(rowver, Number(row.rowver));
      }
      for (const c of dz.cust || []) {
        /* FIN-02: the balance still moves (money owed is real and the sale is
           already done — offline devices must never be silently rejected), but
           when the new balance breaks the customer's credit limit we stamp a
           server-side over-limit flag for manager review. This is the backstop
           the client-only limit check can't provide when two offline terminals
           each spend the "remaining" credit against a stale balance. */
        const r = await client.query(
          `UPDATE entities SET
             data = data
               || jsonb_build_object('points', COALESCE((data->>'points')::numeric, 0) + $3)
               || jsonb_build_object('balance', GREATEST(0, COALESCE((data->>'balance')::numeric, 0) + $4))
               || CASE WHEN COALESCE((data->>'creditLimit')::numeric, 0) > 0
                         AND GREATEST(0, COALESCE((data->>'balance')::numeric, 0) + $4) > COALESCE((data->>'creditLimit')::numeric, 0)
                       THEN jsonb_build_object('creditOverLimit', true,
                              'creditOverBy', GREATEST(0, COALESCE((data->>'balance')::numeric, 0) + $4) - COALESCE((data->>'creditLimit')::numeric, 0),
                              'creditOverAt', $5::bigint)
                       ELSE jsonb_build_object('creditOverLimit', false) END,
             rowver = nextval('entities_rowver_seq'), updated_at = now()
           WHERE org_id=$1 AND kind='customers' AND id=$2
           RETURNING rowver, (data->>'creditOverLimit')='true' AS over, data->>'name' AS name, data->>'creditOverBy' AS overby`,
          [req.org.o, String(c.id), Number(c.pts) || 0, Number(c.bal) || 0, Date.now()]);
        for (const row of r.rows) {
          rowver = Math.max(rowver, Number(row.rowver));
          if (row.over) { recordError("credit over-limit " + (row.name || c.id), new Error(`over by ${row.overby} laari`)); auditEvents.push({ action: "credit.over_limit", ref: String(c.id), detail: { name: row.name || "", overBy: Number(row.overby) || 0 } }); }
        }
      }
      for (const d of op.dels || []) {
        /* SEC-03 (audit B3): voiding a settled sale is a destructive, money-
           affecting action that previously left NO trace — the row was just
           soft-deleted. Capture its summary first and log a sale.void event
           (with the batch's manager-approval state), so voids surface in the
           Payments > authLog for review. Non-sale deletes are unaffected. */
        let voidInfo = null;
        if (d.kind === "sales") {
          const pre = await client.query("SELECT data FROM entities WHERE org_id=$1 AND kind='sales' AND id=$2 AND deleted=false", [req.org.o, String(d.id)]);
          if (pre.rowCount) { const sd = pre.rows[0].data || {}; voidInfo = { no: sd.no || String(d.id), total: Number(sd.total) || 0, userName: sd.userName || "" }; }
        }
        const r = await client.query(
          `UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now()
           WHERE org_id=$1 AND kind=$2 AND id=$3 RETURNING rowver`, [req.org.o, d.kind, String(d.id)]);
        for (const row of r.rows) rowver = Math.max(rowver, Number(row.rowver));
        if (voidInfo && r.rowCount) auditEvents.push({ actor: voidInfo.userName, action: "sale.void", ref: voidInfo.no, detail: { total: voidInfo.total, approved: elevated } });
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* connection may be gone; release still runs */ }
    recordError("ops[" + req.id + "]", e);
    return res.status(500).json({ error: "ops failed: " + errDetail(e), requestId: req.id });
  } finally {
    /* CRIT: the success path fell out of the try with no release, leaking one
       pooled connection per sync that wrote anything — the pool exhausted after
       `max` writes and every till hung on 503 until restart (regressed in
       8e416b9). A single finally guarantees release on every exit: success,
       error, or the early store-inactive / session-ended returns above. */
    client.release();
  }
  /* A batch every op of which was already applied writes nothing, so the
     accumulator above never moves and the reply used to be rowver:0. No
     shipped client reads it as a cursor, but 0 is the one value that means
     "start over" — a client that ever did would re-pull its entire history
     the first time the outbox retried a batch the server had already taken,
     which is exactly the situation a retry is supposed to be harmless in.
     Report where the org actually is instead. Cheap: it is a backwards index
     scan on entities_pull (org_id, rowver). */
  let deduplicated = false;
  if (!rowver) {
    deduplicated = true;
    try {
      const cur = await withOrg(req.org.o, (c) => c.query(
        "SELECT COALESCE(MAX(rowver),0)::bigint AS v FROM entities WHERE org_id=$1", [req.org.o]));
      rowver = Number(cur.rows[0].v) || 0;
    } catch (e) { recordError("ops rowver probe", e); }
  } else {
    poke(req.org.o, rowver);
  }
  /* Recipe-based ingredient deduction runs AFTER the sync commit, never
     inside it: a till sale must never be rejected because inventory math
     failed. The ledger's (org_id, ref, ingredient_id) uniqueness makes the
     deduction idempotent, so a crash between commit and here at worst skips
     a deduction the next audit reconciles — it can never double-deduct. */
  if (settledSales.length) inventory.processSales(req.org.o, settledSales).catch((e) => recordError("processSales", e));
  /* Persist the sensitive events observed above (post-commit, non-fatal). */
  for (const ev of auditEvents) logActivity(req.org.o, { ...ev, requestId: req.id });
  res.json({ ok: true, rowver, ...(deduplicated ? { deduplicated: true } : {}), ...(droppedWrites.length ? { dropped: droppedWrites } : {}) });
}));

app.get("/api/pull", auth, wrap(async (req, res) => {
  const since = Number(req.query.since) || 0;
  const storeId = cleanStoreId(req.query.storeId || req.org.s || DEFAULT_STORE_ID);
  const r = await withOrg(req.org.o, (client) => client.query(
    /* Only rows whose writing transaction is strictly older than the oldest
       still-running one. rowver is assigned at write time, not commit time, so
       without this a row that took a LOWER rowver but committed LATER would be
       skipped forever by a cursor that had already advanced past it. */
    `SELECT kind, id, data, deleted, rowver FROM entities
     WHERE org_id=$1 AND rowver>$2 AND COALESCE(data->>'storeId','global') IN ('global',$3)
       AND (txid IS NULL OR txid < pg_snapshot_xmin(pg_current_snapshot()))
     ORDER BY rowver ASC LIMIT 500`, [req.org.o, since, storeId]));
  const entities = r.rows.map((x) => ({ kind: x.kind, id: publicId(x), data: scrubEntity(x.kind, x.data), deleted: x.deleted, rowver: Number(x.rowver), storeId: entityStore(x.data) }));
  const rowver = entities.length ? entities[entities.length - 1].rowver : since;
  res.json({ rowver, storeId, entities, more: entities.length === 500 });
}));

/* One place that opens an SSE stream, so the register's feed and the guest's
   behave identically. Three things were missing:

   - No X-Accel-Buffering: no. A buffering reverse proxy holds the stream in
     its own buffer and forwards nothing until it fills, so the client sits on
     an open socket that never delivers an event. The header tells the proxy to
     pass bytes straight through, and it is ignored by proxies that don't need
     it.
   - No retry: hint, so every client used the browser's own default. After a
     deploy or a hub restart, a whole fleet of tablets reconnects in the same
     3-second window and stampedes the new instance. The hint is jittered per
     connection to spread the herd out.
   - No id:, so a client reconnecting after a gap had no way to say where it
     left off. Each poke now carries the rowver as its id, and a reconnect
     presenting Last-Event-ID is answered immediately with the current rowver
     so the client pulls the gap at once instead of waiting for its next poll.

   The heartbeat also drops from 25s to 20s: a 30-second idle timeout is common
   in front-end proxies, and 25s plus scheduling jitter sat close enough to it
   to be cut mid-shift. */
/* How many unauthenticated guest streams one store may hold open at once.
   Comfortably above a full house of diners, far below what an unmetered open
   socket per caller would allow. */
const GUEST_STREAM_CAP = 300;
const openEventStream = (orgId, req, res, guest) => {
  if (guest) {
    let open = 0;
    const cur = hubs.get(orgId);
    if (cur) for (const r of cur) if (r.__guest) open++;
    if (open >= GUEST_STREAM_CAP) {
      /* Shed rather than accumulate. The portal's 8s poll keeps working and
         its reconnect backoff will find a slot when the rush passes. */
      res.set("Retry-After", "30");
      return res.status(503).json({ error: "too many live connections, retrying shortly" });
    }
    res.__guest = true;
  }
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(`retry: ${4000 + Math.floor(Math.random() * 4000)}\n\n`);
  const last = Number(req.get("Last-Event-ID") || req.query.lastEventId || 0) || 0;
  res.write(`data: ${JSON.stringify({ hello: true, resumedFrom: last || undefined })}\n\n`);
  let set = hubs.get(orgId);
  if (!set) { set = new Set(); hubs.set(orgId, set); }
  set.add(res);
  const hb = setInterval(() => { try { res.write(": hb\n\n"); } catch {} }, 20000);
  req.on("close", () => {
    clearInterval(hb);
    set.delete(res);
    /* Don't leave an empty Set behind for every org that has ever connected. */
    if (!set.size) hubs.delete(orgId);
  });
};

app.get("/api/events", auth, (req, res) => openEventStream(req.org.o, req, res));

app.get("/p/:slug/events", pubThrottle(30, "events"), wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).end();
  openEventStream(org.id, req, res, true);
}));

/* Public product image for the guest storefront. A dish photo stored as a data:
   URI (uploaded or AI-drawn) is served here, scoped to the store's slug, so an
   ANONYMOUS guest browsing the QR menu can load it — the staff /api/img needs a
   session a guest doesn't have. Only the image bytes are exposed, nothing else. */
const PUB_DATA_URI_RE = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w.+=-]+)*?(;base64)?,([\s\S]*)$/;
app.get("/p/:slug/img/:id", pubThrottle(1200, "pimg"), wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).end();
  const row = await withOrg(org.id, (c) => c.query(
    "SELECT data FROM entities WHERE org_id=$1 AND kind='products' AND id=$2 AND deleted=false LIMIT 1",
    [org.id, String(req.params.id || "")]));
  const im = row.rows[0] && row.rows[0].data && row.rows[0].data.img;
  const m = im && String(im).match(PUB_DATA_URI_RE);
  if (!m) return res.status(404).end();
  const etag = '"' + crypto.createHash("sha1").update(String(im)).digest("hex").slice(0, 16) + '"';
  if (req.headers["if-none-match"] === etag) return res.status(304).end();
  const body = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
  res.set("Content-Type", m[1] || "application/octet-stream");
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.set("ETag", etag);
  res.send(body);
}));

app.get("/p/:slug/boot", wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const storeId = cleanStoreId(req.query.storeId || req.query.store || req.query.st || DEFAULT_STORE_ID);
  await ensureDefaultStore(org.id, org.store_name);
  const [settingsArr, products, zones, tables, stores, recipeRows] = await Promise.all([
    loadSettingsArr(org.id), kindAll(org.id, "products", storeId), kindAll(org.id, "zones", storeId), kindAll(org.id, "tables", storeId),
    withOrg(org.id, (client) => client.query("SELECT id, code, name, address FROM stores WHERE org_id=$1 AND active=true ORDER BY created_at ASC", [org.id])),
    /* Products tracked by the Inventory module carry their availability in
       ingredient stock, not the product-level `stock` field (which defaults
       to 0 on the product form). Without this, a fully-available recipe item
       would be filtered out of the guest menu below. */
    withOrg(org.id, (client) => client.query("SELECT DISTINCT product_id FROM recipe_lines WHERE org_id=$1", [org.id]))]);
  const hasRecipe = new Set(recipeRows.rows.map((r) => String(r.product_id)));
  const rawSettings = settingsArr[0] || {};
  const settings = settingsArr[0]
    ? { usdRate: 1542, ...rawSettings }
    : { storeName: org.store_name, gstBp: 800, loyaltyBp: 10000, svcChargeBp: 0, usdRate: 1542, currency: "MVR" };
  let cust = null;
  if (req.query.c) {
    const c = (await kindAll(org.id, "customers", storeId)).find((x) => idEq(x.id, req.query.c));
    if (c) {
      const orders = (await guestOrders(org.id, storeId, { customerId: c.id }, settings)).slice(0, 25);
      const completed = orders.filter((o) => finalStatuses.has(String(o.status || "").toLowerCase()));
      const spent = completed.reduce((a, o) => a + Number(o.total || 0), 0);
      cust = { id: c.id, name: c.name, points: c.points || 0, balance: c.balance || 0, address: c.address || "", visits: completed.length, spent, orders };
    }
  }
  res.json({ settings, storeId, stores: stores.rows, zones,
    tables: tables.map((t) => t.name),
    /* Recipe-tracked items stay on the menu even at zero servings so the guest
       sees them as "Sold out" (soldOut/soldOutReason from the availability
       engine) rather than silently vanishing; untracked items (no numeric
       stock) always show; only plain stock-tracked items counted down to zero
       are hidden. */
    products: products.filter((p) => !p.hidden && (hasRecipe.has(String(p.id)) || p.stock == null || Number(p.stock) > 0)).map((p) => ({ id: p.id, name: p.name, dv: p.dv || "", cat: p.cat, price: p.price, unit: p.unit, img: p.img || "", desc: p.desc || "", descDv: p.descDv || "", tags: Array.isArray(p.tags) ? p.tags : [], emoji: p.emoji, allergens: p.allergens || "", addons: Array.isArray(p.addons) ? p.addons : [], spiceLevels: Array.isArray(p.spiceLevels) ? p.spiceLevels : [], comments: !!p.comments, noKitchen: !!p.noKitchen, stock: p.stock, storeId: p.storeId || "global", soldOut: p.recipeAvail != null ? Number(p.recipeAvail) <= 0 : (p.stock != null && Number(p.stock) <= 0), soldOutReason: p.soldOutReason || null })),
    cust });
}));

/* Menu data version for a store: the max rowver across products + settings, so
   any menu change — a dish, a price, a category, branding — moves it. The guest
   and customer portals poll this and reload when it changes, so an edit at the
   till reaches an open QR/member page within one poll (the HTML is no-store, so
   the reload pulls the fresh menu). Deliberately tiny + generously throttled. */
app.get("/p/:slug/ver", pubThrottle(240, "ver"), wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const ver = Number(((await withOrg(org.id, (c) => c.query(
    "SELECT COALESCE(MAX(rowver),0) AS v FROM entities WHERE org_id=$1 AND kind IN ('products','settings')", [org.id]))).rows[0] || {}).v) || 0;
  res.set("Cache-Control", "no-store");
  res.json({ ver });
}));

app.post("/p/:slug/order", pubThrottle(40, "order"), wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const { items, table, custId, gtype, zoneId, note } = req.body || {};
  const storeId = cleanStoreId(req.body?.storeId || req.query.storeId || req.query.store || req.query.st || DEFAULT_STORE_ID);
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "cart is empty" });
  /* Per-order size caps (audit B1): a tampered/anonymous client posted a
     500-line-item order. Bound the distinct lines here (before the per-line
     work) and the total quantity after normalisation, so one order can't be
     used to bloat the kitchen ticket or the DB row. */
  if (items.length > 40) return res.status(400).json({ error: "That's too many different items for one order — please split it into more than one." });
  const [products, zones, customers, settingsArr] = await Promise.all([kindAll(org.id, "products", storeId), kindAll(org.id, "zones", storeId), kindAll(org.id, "customers", storeId), loadSettingsArr(org.id)]);
  /* The confirmation the guest sees has to be priced with THIS store's rates.
     It was normalised with no settings at all, so it quoted 0% service charge
     and the house rate on every order — a dine-in guest confirmed MVR 135.00
     and the cashier settled 148.50 for the same three items. Every later read
     of the order (guestOrders, the KDS) already passed the real settings, so
     the number even changed under them on the "My orders" tab. */
  const settings = settingsArr[0]
    ? { usdRate: 1542, ...settingsArr[0] }
    : { storeName: org.store_name, gstBp: 800, loyaltyBp: 10000, svcChargeBp: 0, usdRate: 1542, currency: "MVR" };
  const lines = items.map((ci) => {
    const pid = String(ci.pid || ci.id || ci.productId || "");
    const p = products.find((x) => String(x.id) === pid);
    /* Guests may only order catalogue items: drop any pid that isn't on this
       store's menu so a tampered cart can't inject an off-menu (or free) custom
       line. Identity, price, tax and cost always come from the server product,
       never from the client. */
    if (!p) return null;
    const src = p;
    /* Add-ons the guest chose: match each against the product's own defined
       add-ons and take the SERVER price, so a tampered cart can't set its own
       prices. Their cost rolls into the line price; their names ride on the
       line (and a note) for the kitchen ticket. */
    const defined = p && Array.isArray(p.addons) ? p.addons : [];
    const addons = (Array.isArray(ci.addons) ? ci.addons : [])
      .map((a) => defined.find((d) => String(d.name) === String(a && a.name)))
      .filter(Boolean).map((d) => ({ name: d.name, price: Number(d.price) || 0 }));
    const addOnSum = addons.reduce((s, a) => s + a.price, 0);
    /* Spice level: single choice, validated against the product's own list so a
       tampered cart can't inject a fake modifier. Comment: free special
       instruction, only if the item allows it. Both ride the kitchen note. */
    const spiceOpts = p && Array.isArray(p.spiceLevels) ? p.spiceLevels : [];
    const spice = spiceOpts.includes(String(ci.spice)) ? String(ci.spice) : null;
    const comment = (p && p.comments && typeof ci.comment === "string") ? ci.comment.trim().slice(0, 140) : "";
    const noKitchen = !!(p && p.noKitchen);
    /* A free-text modifier note — the same kind the till attaches to a line
       (e.g. "No onion · Extra spicy"). Unlike `comment` it is not gated on the
       product allowing comments, so the QR + member portals mirror the till's
       always-available modifier notes. Sanitised and capped; never priced. */
    const freeNote = (typeof ci.note === "string" ? ci.note : "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
    const noteBits = addons.map((a) => a.name);
    if (spice) noteBits.push(spice);
    if (comment) noteBits.push("“" + comment + "”");
    if (freeNote) noteBits.push(freeNote);
    return { pid: p ? p.id : pid || String(src.id || uid()), name: src.name || "Item", emoji: src.emoji || "", price: (Number(src.price) || 0) + addOnSum, cost: Number(src.cost) || 0, unit: src.unit || "pcs", vendor: !!src.vendor, qty: Math.max(1, Math.min(99, Number(ci.qty) || 1)), discPct: Number(src.discPct) || 0, taxable: src.taxable !== false, addons: addons.length ? addons : undefined, spice: spice || undefined, comment: comment || undefined, noKitchen: noKitchen || undefined, note: noteBits.length ? noteBits.join(" · ") : undefined };
  }).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: "those items are unavailable" });
  const totalQty = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  if (totalQty > 200) return res.status(400).json({ error: "That order is too large — please split it into more than one." });
  /* Enforce availability server-side: a guest must never place an order for an
     item that has just sold out (ingredient-driven recipeAvail<=0, or a
     stock-tracked item at zero), even if their menu was loaded moments ago. */
  const soldOut = lines.map((l) => products.find((p) => String(p.id) === String(l.pid)))
    .filter((p) => p && (p.recipeAvail != null ? Number(p.recipeAvail) <= 0 : (p.stock != null && Number(p.stock) <= 0)));
  if (soldOut.length) return res.status(409).json({ error: `${soldOut[0].name} just sold out — please remove it and try again.` });
  const otype = gtype === "delivery" ? "delivery" : gtype === "pickup" ? "takeaway" : "dinein";
  const requestedTable = String(table || "").trim().slice(0, 40);
  if (otype === "dinein" && !requestedTable) return res.status(400).json({ error: "select your table number before ordering" });
  const zone = otype === "delivery" ? zones.find((z) => idEq(z.id, zoneId)) || null : null;
  let cust = custId !== null && custId !== undefined && custId !== "" ? customers.find((c) => idEq(c.id, custId)) || null : null;
  /* A signed-in member's order attaches to THEIR membership, taken from the
     member cookie (trusted), never from a client-supplied custId — so points and
     history are the real member's and a phone can't order onto someone else. */
  const msess = readMember(req);
  if (msess && msess.orgId === org.id) { const mc = customers.find((c) => idEq(c.id, msess.custId)); if (mc) cust = mc; }
  const upd = await withOrg(org.id, (client) => client.query("UPDATE orgs SET oseq = oseq + 1 WHERE id=$1 RETURNING oseq", [org.id]));
  /* An order made up entirely of non-kitchen items (hedhikaa, cakes, pastries,
     packaged goods) has nothing to cook, so it skips the kitchen queue and is
     "ready" to hand over / settle straight away. Mixed orders stay "new" and
     the kitchen display just hides the non-kitchen lines. */
  const allNoKitchen = lines.length > 0 && lines.every((l) => l.noKitchen);
  const orderId = uid();
  /* Close the snapshot-vs-reservation race (issue #31): the soldOut check just
     above reads a menu snapshot that may be stale by the time this request
     lands, so two guests can both pass it for the last unit. Actually reserve
     the stock now, inside the DB, before the order is created — the till's
     own "never reject a sale for stock" behaviour is untouched; this only
     applies to the online guest QR path. */
  const resv = await inventory.reserveOrderStock(org.id, orderId, lines);
  if (!resv.ok) return res.status(409).json({ error: `${resv.itemName} just sold out — please remove it and try again.` });
  const order = { id: orderId, no: "ORD-" + upd.rows[0].oseq, storeId, table: requestedTable || (otype === "delivery" ? "Delivery" : "Pickup"), items: lines, status: allNoKitchen ? "ready" : "new", noKitchen: allNoKitchen || undefined, createdAt: Date.now(), updatedAt: Date.now(), call: false, source: "qr", otype, covers: 1, customerId: cust ? cust.id : null, customerName: cust ? cust.name : null, customerDv: cust ? (cust.dv || cust.name || null) : null, zone: zone ? zone.name : null, fee: zone ? zone.fee : 0, note: String(note || "").slice(0, 200) || (otype === "delivery" && cust ? cust.address || "" : "") };
  let r;
  try {
    r = await withOrg(org.id, (client) => client.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'orders',$2,$3) RETURNING rowver", [org.id, order.id, JSON.stringify(order)]));
  } catch (e) {
    inventory.releaseOrderReservations(org.id, orderId).catch(() => {});
    throw e;
  }
  poke(org.id, Number(r.rows[0].rowver));
  res.json({ ok: true, order: normalizeOrder(order, settings) });
}));

app.get("/p/:slug/orders", wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const storeId = cleanStoreId(req.query.storeId || req.query.store || req.query.st || DEFAULT_STORE_ID);
  const settingsArr = await loadSettingsArr(org.id);
  const settings = settingsArr[0]
    ? { usdRate: 1542, ...settingsArr[0] }
    : { storeName: org.store_name, gstBp: 800, loyaltyBp: 10000, svcChargeBp: 0, usdRate: 1542, currency: "MVR" };
  const oParam = String(req.query.o || "").trim();
  const orderIds = oParam ? oParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12) : null;
  const mine = (await guestOrders(org.id, storeId, { customerId: req.query.c, table: req.query.t, orderIds }, settings)).slice(0, 25);
  // Also surface this table's open floor calls (assist/bill) so the portal can
  // show "a server is on the way" once a cashier acknowledges one. Only the
  // fields the portal needs, only for this table — never the whole floor.
  const table = req.query.t;
  let calls = [];
  if (table) {
    const raw = await kindAll(org.id, "waiterCalls", storeId);
    calls = raw
      .filter((cl) => cl && (cl.kind === "assist" || cl.kind === "bill") && idEq(cl.table, table))
      .map((cl) => ({ id: cl.id, kind: cl.kind, acked: !!cl.acked, t: cl.t || 0 }))
      .sort((a, b) => Number(b.t) - Number(a.t))
      .slice(0, 8);
  }
  res.json({ storeId, orders: mine, calls });
}));

/* Guest customer account — look up a loyalty/credit account by phone (public,
   throttled, RLS-scoped by slug). Returns the real profile the QR portal's
   account tab renders: points, tier, credit limit/left, visits, spend. Match on
   the last 9 digits so a guest can enter the local number with or without the
   +960 prefix. Returns {found:false} rather than an error for an unknown number
   so the portal shows a clean "not a member yet" state. */
app.get("/p/:slug/account", pubThrottle(20, "acct"), wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const phone = String(req.query.phone || "").replace(/[^\d+]/g, "");
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 5) return res.status(400).json({ error: "Enter your phone number" });
  const storeId = cleanStoreId(req.query.storeId || req.query.store || req.query.st || DEFAULT_STORE_ID);
  const custs = await kindAll(org.id, "customers", storeId);
  // Compare local numbers: strip a leading Maldives country code (960) and
  // match on the last 7 digits (a local mobile number), so "+960 777 4821",
  // "777 4821" and "7774821" all resolve to the same account.
  const local = (p) => { let d = String(p || "").replace(/\D/g, ""); if (d.length > 7 && d.slice(0, 3) === "960") d = d.slice(3); return d.slice(-7); };
  const want = local(phone);
  const c = want.length >= 6 ? custs.find((x) => local(x.phone) && local(x.phone) === want) : null;
  if (!c) return res.json({ found: false });
  const pts = Number(c.points || c.loyaltyPoints || 0);
  const limit = Math.round((Number(c.creditLimit || c.credit || 0)) / 100);
  const bal = Math.round((Number(c.balance || c.used || 0)) / 100);
  // Real order history for the account's Receipts and Statement tabs — the
  // same source the terminal reads, priced by the store's own rates (money
  // laari→MVR). No fabricated ledger: the statement is built from these.
  const settingsArr = await loadSettingsArr(org.id);
  const settings = settingsArr[0] || { storeName: org.store_name, gstBp: 800, loyaltyBp: 10000, svcChargeBp: 0, usdRate: 1542, currency: "MVR" };
  const hist = (await guestOrders(org.id, storeId, { customerId: c.id }, settings)).slice(0, 25);
  const orders = hist.map((o) => ({
    no: o.no, total: Math.round((Number(o.total) || 0) / 100), status: o.status,
    when: o.createdAt || o.at || null, otype: asOtype(o.otype), table: o.table || "",
    items: (o.items || []).map((it) => ({ q: it.qty, n: it.name })),
    tender: o.tender || o.method || "", credit: /credit|tab|account/i.test(String(o.tender || o.method || "")),
  }));
  // A stable member number: the customer's own if set, else derived from the
  // account id so it never changes between sign-ins.
  const memberNo = c.memberNo || ("RL-" + String(c.id).replace(/[^a-zA-Z0-9]/g, "").slice(-8).toUpperCase().padStart(8, "0"));
  res.json({
    found: true,
    account: {
      id: c.id, name: c.name || "Guest", phone: c.phone || "", memberNo: memberNo,
      points: pts, tier: c.tier || (pts >= 7500 ? "Platinum" : pts >= 2500 ? "Gold" : "Silver"),
      creditLimit: limit, creditUsed: bal, creditLeft: Math.max(0, limit - bal),
      visits: Number(c.visits || 0), spent: Math.round((Number(c.spent || c.totalSpent || 0)) / 100),
      orders: orders,
    },
  });
}));

/* ── Registered-customer (member) portal auth ────────────────────────────────
   Email OTP only (handoff 08 §8) — no SMS. The OTP is scoped per org so one
   email can be a member of two stores without collision. We never disclose
   whether an address is registered beyond the generic {found:false} the client
   turns into "No membership on that address". Code is 6 digits (the security
   contract, 07/B1 + 08 §8, overrides the prototype's 4-box mock). */
app.post("/p/:slug/member/otp", pubThrottle(8, "motp"), wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  const storeId = cleanStoreId((req.body || {}).storeId || DEFAULT_STORE_ID);
  // `enroll` = the guest chose "Join rewards" after we told them there was no
  // membership. Then we DO email a code to the address they typed (it's theirs),
  // and the verify step creates a fresh member on success. Without enroll we
  // still never disclose whether an address is registered ({found:false}).
  const enroll = !!(req.body || {}).enroll;
  const c = await findCustomerByEmail(org.id, storeId, email);
  if (!c && !enroll) return res.json({ found: false });
  const purpose = "member:" + org.id;
  const cur = await withSystem((cl) => cl.query("SELECT last_sent FROM otp_codes WHERE email=$1 AND purpose=$2", [email, purpose]));
  if (cur.rowCount && (Date.now() - new Date(cur.rows[0].last_sent).getTime()) < 45000) return res.status(429).json({ error: "Please wait a moment before requesting another code." });
  const code = genOtp();
  await withSystem((cl) => cl.query(
    `INSERT INTO otp_codes (email, purpose, code_hash, expires_at, attempts, verified, last_sent, created_at)
     VALUES ($1,$2,$3, now() + interval '10 minutes', 0, false, now(), now())
     ON CONFLICT (email, purpose) DO UPDATE SET code_hash=$3, expires_at=now() + interval '10 minutes', attempts=0, verified=false, last_sent=now()`,
    [email, purpose, otpHash(email, code)]));
  const brand = org.store_name || "Kashikeyo";
  const subj = c ? (brand + " Rewards — your sign-in code") : (brand + " Rewards — confirm your email");
  const mail = await sendEmail({ to: email, subject: subj, html: otpEmailHtml(code), text: "Your " + brand + " Rewards code is " + code + " (valid for 10 minutes)." });
  const out = { found: !!c, enroll: !c, masked: maskEmail((c && c.email) || email), configured: mail.configured };
  if (!mail.ok && process.env.NODE_ENV !== "production") out.devCode = code;   // dev only, never in prod
  res.json(out);
}));

app.post("/p/:slug/member/verify", pubThrottle(12, "mver"), wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  const code = String((req.body || {}).code || "").trim();
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  const purpose = "member:" + org.id;
  const row = await withSystem((cl) => cl.query("SELECT code_hash, expires_at, attempts FROM otp_codes WHERE email=$1 AND purpose=$2", [email, purpose]));
  if (!row.rowCount) return res.status(400).json({ error: "Request a code first." });
  const r = row.rows[0];
  if (new Date(r.expires_at).getTime() < Date.now()) return res.status(400).json({ error: "That code has expired — request a new one." });
  if (r.attempts >= 6) return res.status(429).json({ error: "Too many attempts — request a new code." });
  if (otpHash(email, code) !== r.code_hash) {
    await withSystem((cl) => cl.query("UPDATE otp_codes SET attempts=attempts+1 WHERE email=$1 AND purpose=$2", [email, purpose]));
    return res.status(400).json({ error: "Incorrect code." });
  }
  const storeId = cleanStoreId((req.body || {}).storeId || DEFAULT_STORE_ID);
  let c = await findCustomerByEmail(org.id, storeId, email);
  if (!c) {
    // Enrollment: the email is now verified, so create a fresh rewards member.
    // A new record (not linked to any phone customer) — no account can be taken
    // over by knowing someone's number; staff link history on the till if asked.
    const name = String((req.body || {}).name || "").trim().slice(0, 60) || email.split("@")[0];
    const phone = String((req.body || {}).phone || "").replace(/[^\d+ ]/g, "").slice(0, 30);
    const id = "cm_" + crypto.randomBytes(6).toString("hex");
    const cust = { id, name, email, phone, points: 0, visits: 0, spent: 0, tier: "Bronze", credit: 0, used: 0, portal: true, storeId, source: "rewards-portal", createdAt: Date.now(), lastOrderAt: Date.now(), portalLoginAt: Date.now() };
    const r = await withOrg(org.id, (cl) => cl.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'customers',$2,$3) RETURNING rowver", [org.id, id, JSON.stringify(cust)]));
    poke(org.id, Number(r.rows[0].rowver));
    c = cust;
  } else {
    // Stamp the sign-in so the back office can tell an invited-but-dormant member
    // (never signed in) from an active one — the roster offers "resend link" vs
    // "reset access" accordingly. Marks portal=true too: signing in IS access.
    const rv = await withOrg(org.id, (cl) => cl.query(
      "UPDATE entities SET data = data || jsonb_build_object('portal',true,'portalLoginAt',$3::bigint), rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='customers' AND id=$2 RETURNING rowver",
      [org.id, String(c.id), Date.now()]));
    if (rv.rowCount) poke(org.id, Number(rv.rows[0].rowver));
  }
  await withSystem((cl) => cl.query("DELETE FROM otp_codes WHERE email=$1 AND purpose=$2", [email, purpose]));
  setMemberCookie(res, signMember(org.id, c.id));
  // Return the full member card inline so the client signs in from THIS response and
  // never depends on a second /member/me round-trip. That refetch reads the cookie we
  // just set, and a Set-Cookie-then-immediately-refetch race (notably iOS Safari, where
  // a cookie from a fetch() POST isn't always visible to the next fetch) would otherwise
  // strand a diner on the code screen after a *correct* code — they resend and resend.
  // Best-effort: on any hiccup we still return ok and the client falls back to fetchMe().
  let member = null;
  try {
    const settingsArr = await loadSettingsArr(org.id);
    const settings = settingsArr[0] || { storeName: org.store_name, gstBp: 800, svcChargeBp: 0, currency: "MVR" };
    const hist = (await guestOrders(org.id, storeId, { customerId: c.id }, settings)).slice(0, 25);
    const vouchers = (await kindAll(org.id, "rewardVouchers", storeId)).filter((v) => idEq(v.custId, c.id))
      .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    member = memberPayload(org, c, settings, hist, vouchers);
  } catch (e) { recordError("member/verify payload", e); }
  res.json({ ok: true, enrolled: !((req.body || {}).existing), member });
}));

app.get("/p/:slug/member/me", pubThrottle(60, "mme"), wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const sess = readMember(req);
  if (!sess || sess.orgId !== org.id) return res.status(401).json({ error: "sign in required" });
  const storeId = cleanStoreId(req.query.storeId || DEFAULT_STORE_ID);
  const custs = await kindAll(org.id, "customers", storeId);
  const c = custs.find((x) => idEq(x.id, sess.custId));
  if (!c) return res.status(401).json({ error: "membership not found" });
  const settingsArr = await loadSettingsArr(org.id);
  const settings = settingsArr[0] || { storeName: org.store_name, gstBp: 800, svcChargeBp: 0, currency: "MVR" };
  const hist = (await guestOrders(org.id, storeId, { customerId: c.id }, settings)).slice(0, 25);
  const vouchers = (await kindAll(org.id, "rewardVouchers", storeId)).filter((v) => idEq(v.custId, c.id))
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  res.json({ member: memberPayload(org, c, settings, hist, vouchers) });
}));

/* Redeem a reward. The app posts an intent; the till honours it (handoff CLAUDE
   brief). We write a `pending` voucher — which immediately subtracts from the
   member's displayed balance — and file a `reward` signal on the floor so a
   cashier can apply it. The till awards/deducts real points at settlement; a
   phone never moves a point balance itself. */
app.post("/p/:slug/member/redeem", pubThrottle(20, "mredeem"), wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const sess = readMember(req);
  if (!sess || sess.orgId !== org.id) return res.status(401).json({ error: "sign in required" });
  const storeId = cleanStoreId((req.body || {}).storeId || DEFAULT_STORE_ID);
  const [custs, settingsArr, vouchers] = await Promise.all([
    kindAll(org.id, "customers", storeId), loadSettingsArr(org.id), kindAll(org.id, "rewardVouchers", storeId)]);
  const c = custs.find((x) => idEq(x.id, sess.custId));
  if (!c) return res.status(401).json({ error: "membership not found" });
  const cfg = loyaltyConfig(settingsArr[0] || {});
  const reward = cfg.rewards.find((r) => String(r.id) === String((req.body || {}).rewardId) && r.active !== false);
  if (!reward) return res.status(404).json({ error: "That reward is not available." });
  // Tier gate.
  const spent = Math.round((Number(c.spent || c.totalSpent || 0)) / 100);
  let ti = 0; for (let i = 0; i < cfg.tiers.length; i++) { if (spent >= Number(cfg.tiers[i].from || 0)) ti = i; }
  if (reward.tierRequired) { const need = cfg.tiers.findIndex((t) => t.key === reward.tierRequired); if (need > ti) return res.status(403).json({ error: reward.tierRequired + " tier only." }); }
  // Affordability against points minus already-pending redemptions.
  const points = Math.max(0, Math.round(Number(c.points || c.loyaltyPoints || 0)));
  const pendingSpend = vouchers.filter((v) => idEq(v.custId, c.id) && String(v.state || "pending") === "pending").reduce((a, v) => a + (Number(v.cost) || 0), 0);
  const cost = Number(reward.cost) || 0;
  if ((points - pendingSpend) < cost) return res.status(400).json({ error: "You need " + (cost - (points - pendingSpend)).toLocaleString() + " more points" });
  const code = "RW-" + String(crypto.randomInt(1000, 10000));
  const voucher = { id: uid(), custId: c.id, rewardId: reward.id, name: reward.name, cost: cost, code: code, state: "pending", storeId, createdAt: Date.now() };
  await withOrg(org.id, (client) => client.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'rewardVouchers',$2,$3)", [org.id, voucher.id, JSON.stringify(voucher)]));
  // Floor signal: a member redeemed something, by name (handoff 08 §5).
  const call = { id: uid(), storeId, table: "Counter", name: c.name || "Member", custId: c.id, kind: "reward", reward: reward.name, code: code, voucherId: voucher.id, cost: cost, t: Date.now() };
  const r = await withOrg(org.id, (client) => client.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'waiterCalls',$2,$3) RETURNING rowver", [org.id, call.id, JSON.stringify(call)]));
  poke(org.id, Number(r.rows[0].rowver));
  res.json({ ok: true, voucher: { id: voucher.id, name: voucher.name, cost: voucher.cost, code: voucher.code, state: "pending" } });
}));

/* Order status derived from the real ticket, never guessed (handoff 09). This
   POS tracks status at the order (round) level plus a per-line `done`, so map:
   1 accepted at the till (new) · 2 in the kitchen (preparing / some line done) ·
   3 served (ready / completed / every line done). Stage 0 (still on the wire,
   not yet a ticket) does not occur here — a posted QR order is a ticket at once. */
function orderStage(o) {
  const st = String((o && o.status) || "new").toLowerCase();
  if (st === "completed" || st === "ready" || st === "settled" || st === "paid") return 3;
  const items = Array.isArray(o && o.items) ? o.items : [];
  if (items.length && items.every((it) => it && it.done)) return 3;
  if (st === "preparing" || items.some((it) => it && it.done)) return 2;
  return 1;
}
const MEMBER_OPEN = new Set(["new", "preparing", "ready"]);
app.get("/p/:slug/member/orders", pubThrottle(60, "morders"), wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const sess = readMember(req);
  if (!sess || sess.orgId !== org.id) return res.status(401).json({ error: "sign in required" });
  const storeId = cleanStoreId(req.query.storeId || DEFAULT_STORE_ID);
  const settings = (await loadSettingsArr(org.id))[0] || { storeName: org.store_name, gstBp: 800, svcChargeBp: 0, currency: "MVR" };
  const all = await guestOrders(org.id, storeId, { customerId: sess.custId }, settings);
  const orders = all.map((o) => ({
    no: o.no || o.id, at: Number(o.createdAt || o.at) || null, table: o.table || "", status: String(o.status || "new"),
    stage: orderStage(o), open: MEMBER_OPEN.has(String(o.status || "new").toLowerCase()),
    total: Math.round((Number(o.total) || 0) / 100),
    lines: (o.items || []).map((it) => ({ name: it.name || "Item", qty: Number(it.qty || it.q) || 1, done: !!it.done,
      amount: Math.round(((Number(it.price) || 0) * (Number(it.qty || it.q) || 1)) / 100), note: it.note || "" })),
  }));
  res.json({ orders, live: orders.find((o) => o.open) || null });
}));

app.post("/p/:slug/member/signout", (req, res) => { res.clearCookie(MEMBER_COOKIE, { path: "/" }); res.json({ ok: true }); });

/* Promotions the guest surfaces read (handoff 07/A3). `on` is the merchant's slot
   switch — off → the client renders nothing and collapses the space. Items are
   the active banners for this outlet (outlet "0" = chain-wide). Cacheable. */
app.get("/p/:slug/promos", pubThrottle(60, "promos"), wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const settings = (await loadSettingsArr(org.id))[0] || {};
  const on = !!settings.qrBanners;
  const outlet = String(req.query.outlet || "0");
  const items = on ? (Array.isArray(settings.banners) ? settings.banners : [])
    .filter((b) => b && b.active !== false && (String(b.outlet || "0") === "0" || String(b.outlet) === outlet))
    .map((b) => ({ id: b.id, outlet: b.outlet || "0", title: b.title || "", sub: b.sub || "", code: b.code || "", img: b.img || "" })) : [];
  res.json({ on, items });
}));

/* "Tell the till I'm here" (show-code sheet). A member announcing at the counter
   is a person, not a table (handoff 08 §5): file it under the floor's calls,
   titled by name, so a cashier can attach the next bill to the membership. */
app.post("/p/:slug/member/announce", pubThrottle(12, "mann"), wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const sess = readMember(req);
  if (!sess || sess.orgId !== org.id) return res.status(401).json({ error: "sign in required" });
  const storeId = cleanStoreId((req.body || {}).storeId || DEFAULT_STORE_ID);
  const c = (await kindAll(org.id, "customers", storeId)).find((x) => idEq(x.id, sess.custId));
  if (!c) return res.status(401).json({ error: "membership not found" });
  const table = String((req.body || {}).table || "").replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 20);
  const call = { id: uid(), storeId, table: table || "Counter", name: c.name || "Member", custId: c.id, kind: "member", t: Date.now() };
  const r = await withOrg(org.id, (client) => client.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'waiterCalls',$2,$3) RETURNING rowver", [org.id, call.id, JSON.stringify(call)]));
  poke(org.id, Number(r.rows[0].rowver));
  res.json({ ok: true });
}));

app.post("/p/:slug/call", pubThrottle(20, "call"), wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const { table, custId, kind } = req.body || {};
  const storeId = cleanStoreId(req.body?.storeId || req.query.storeId || req.query.store || req.query.st || DEFAULT_STORE_ID);
  let name = null;
  if (custId) name = ((await kindAll(org.id, "customers", storeId)).find((c) => idEq(c.id, custId)) || {}).name || null;
  // "bill" = the guest asked for their cheque; anything else is a waiter call.
  const ck = kind === "bill" ? "bill" : "assist";
  const call = { id: uid(), storeId, table: table || (name ? "Pickup" : "-"), name, kind: ck, t: Date.now() };
  const r = await withOrg(org.id, (client) => client.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'waiterCalls',$2,$3) RETURNING rowver", [org.id, call.id, JSON.stringify(call)]));
  poke(org.id, Number(r.rows[0].rowver));
  res.json({ ok: true });
}));

/* Guest table reservation. A customer books from the QR portal; the request
   lands as a `reservations` entity with status "pending" and pokes SSE, so it
   shows up on the till's Reservations inbox for a staff Approve/Decline exactly
   the way a waiter call does. No table is held until staff confirm. */
app.post("/p/:slug/reserve", pubThrottle(10, "reserve"), wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const b = req.body || {};
  const storeId = cleanStoreId(b.storeId || req.query.storeId || req.query.store || req.query.st || DEFAULT_STORE_ID);
  const name = String(b.name || "").trim().slice(0, 80);
  const phone = String(b.phone || "").trim().slice(0, 30);
  const party = Math.max(1, Math.min(50, Math.round(Number(b.party) || 0) || 2));
  const time = String(b.time || "").trim().slice(0, 20);   // "19:30"
  const date = String(b.date || "").trim().slice(0, 20);   // "2026-08-05" (blank = tonight)
  const note = String(b.note || "").trim().slice(0, 200);
  if (!name || !phone) return res.status(400).json({ error: "Name and phone are required" });
  if (!time) return res.status(400).json({ error: "Pick a time" });
  const custId = b.custId ? String(b.custId).slice(0, 60) : null;
  const resv = { id: uid(), storeId, status: "pending", source: "portal",
    name, phone, party, time, date, note, custId, table: "", t: Date.now() };
  const r = await withOrg(org.id, (client) => client.query(
    "INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'reservations',$2,$3) RETURNING rowver",
    [org.id, resv.id, JSON.stringify(resv)]));
  poke(org.id, Number(r.rows[0].rowver));
  res.json({ ok: true, id: resv.id });
}));

app.get("/api/health", wrap(async (req, res) => {
  const dbEnv = { databaseUrl: !!databaseUrl, pgEnv: hasPgEnv };
  try { await pool.query("SELECT 1"); res.json({ ok: true, service: "kashikeyo-cloud", db: true, dbEnv }); }
  catch (e) { res.status(500).json({ ok: false, service: "kashikeyo-cloud", db: false, dbEnv, error: errDetail(e) }); }
}));

app.get("/version", (req, res) => {
  const g = process.env; // Railway injects RAILWAY_* at build/deploy time
  const commit = g.RAILWAY_GIT_COMMIT_SHA || g.GIT_COMMIT_SHA || "";
  res.json({
    service: "kashikeyo-cloud",
    environment: g.RAILWAY_ENVIRONMENT_NAME || g.RAILWAY_ENVIRONMENT || (g.NODE_ENV === "production" ? "production" : "development"),
    branch: g.RAILWAY_GIT_BRANCH || "",
    commit,
    commitShort: commit ? commit.slice(0, 7) : "",
    commitMessage: g.RAILWAY_GIT_COMMIT_MESSAGE || "",
    deployedAt: g.RAILWAY_DEPLOYMENT_CREATED_AT || "",
    startedAt: new Date(bootedAt).toISOString(),
    uptimeSec: Math.round((Date.now() - bootedAt) / 1000),
  });
});

// ---- Store subdomains: the storefront on <handle>.<PORTAL_BASE_DOMAIN> ----
// Everything here is gated on PORTAL_BASE_DOMAIN (comma-separated apex domains,
// e.g. "kashikeyopos.com"). Until it is set every function is inert and routing
// is byte-for-byte what it was, so this ships safely ahead of the wildcard
// DNS + TLS being provisioned. The apex and www stay the platform app; a short
// reserved list (app/api/admin/…) never maps to a store.
const PORTAL_BASE_DOMAINS = String(process.env.PORTAL_BASE_DOMAIN || "").split(",")
  .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/:].*$/, "")).filter(Boolean);
const RESERVED_SUBDOMAINS = new Set(["www", "app", "api", "staging", "test", "admin", "portal", "dashboard", "assets", "static", "cdn", "mail", "kashikeyo", "kashikeyopos"]);
// The store slug a request's Host header implies, or null when the host is the
// platform apex/www, a reserved label, or subdomains aren't configured at all.
function portalSlugFromHost(req) {
  if (!PORTAL_BASE_DOMAINS.length) return null;
  const host = String((req.headers && req.headers.host) || "").toLowerCase().split(":")[0];
  if (!host) return null;
  for (const base of PORTAL_BASE_DOMAINS) {
    if (host === base || host === "www." + base) return null;          // the platform app
    if (host.length > base.length + 1 && host.endsWith("." + base)) {
      const label = host.slice(0, host.length - base.length - 1);
      if (!label || label.indexOf(".") >= 0) return null;              // single-label subdomains only
      if (RESERVED_SUBDOMAINS.has(label)) return null;
      return label;
    }
  }
  return null;
}
// The public origin a store's storefront links (QR codes, share links) should
// use: the branded subdomain when configured, else PUBLIC_ORIGIN or the request.
function portalOriginForSlug(slug, req) {
  if (PORTAL_BASE_DOMAINS.length && slug) {
    const xfp = req && req.headers && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const proto = xfp || (req && req.protocol) || "https";
    return proto + "://" + slug + "." + PORTAL_BASE_DOMAINS[0];
  }
  return process.env.PUBLIC_ORIGIN || (req.protocol + "://" + req.get("host"));
}

app.get("/", wrap(async (req, res, next) => {
  // A branded store subdomain (<handle>.<domain>) resolves to that store's guest
  // storefront: adopt its slug as ?s= so the guest-portal route below serves it.
  const subSlug = portalSlugFromHost(req);
  if (subSlug && !req.query.s) req.query.s = subSlug;
  if ((req.query.c || req.query.t) && !req.query.s) {
    const r = await withSystem((client) => client.query("SELECT slug FROM orgs"));
    if (r.rowCount === 1) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query)) q.set(k, String(v));
      q.set("s", r.rows[0].slug);
      return res.redirect(302, "/?" + q.toString());
    }
  }
  next();
}));

const siteDir = path.join(__dirname, "site");
app.use(express.static(siteDir, { index: false }));
app.get("/login", redirectIfAppSession, (req, res) => res.sendFile(path.join(siteDir, "login.html")));
app.get("/signup", redirectIfAppSession, (req, res) => res.sendFile(path.join(siteDir, "signup.html")));
app.get("/dev", (req, res) => res.sendFile(path.join(siteDir, "dev.html")));
/* Back office: recipes, stock checks, deliveries — owner/manager work that
   doesn't belong on the till. Same session cookie as /app. */
/* /back is retired — the back office is consolidated into the /admin cockpit.
   Old links, bookmarks, and the manager PIN sign-in all 301 to /admin. */
app.get(/^\/back(\/.*)?$/, (req, res) => res.redirect(301, "/admin"));
/* /app2 — the prototype's EXACT front-end (its own markup, styles, effects and
   register logic, unchanged) served on this backend, with our real menu injected
   into its `window.__ksMenu` seam. Coexists with the baked till at /app; session-
   gated. Real data + persistence + AI/back-panel wiring land progressively; the
   design stays 1:1 with the prototype. */
const protoFile = path.join(__dirname, "web2", "proto", "index.html");
const catSlug = (c) => {
  const s = String(c || "").toLowerCase();
  if (/coffee|tea|\bdrink|juice|water|cola|kurumba|\bsai\b|beverage|soda|shake|smoothie/.test(s)) return "drinks";
  if (/dessert|cake|sweet|ice.?cream|pudding|foni|bondi/.test(s)) return "sweets";
  if (/snack|bakery|hedhika|croissant|muffin|gulha|bajiya|roshi|cutlet|samosa|pastr/.test(s)) return "hedhikaa";
  return "mains";
};
// Menu category id that PRESERVES each distinct category name (a plain slug),
// so two real sections never collapse into one 4-bucket keyword group the way
// catSlug does. Used by the menu builders the v2 terminal + new QR read.
const menuCat = (c) => String(c || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "uncategorized";

/* ── Menu import/export (CSV) ─────────────────────────────────────────────────
   One template carries every field a dish holds, so a store can export its menu,
   edit it in a spreadsheet, and import it back — or start a new store from a
   filled-in template. csvCell/toCsv/parseCsv are a minimal RFC-4180 pair
   (quotes, embedded commas + newlines), and menuFields is the single normaliser
   both the single-item save and the bulk import run through, so they never
   drift. */
const csvCell = (v) => { v = v == null ? "" : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const toCsv = (rows) => rows.map((r) => (r || []).map(csvCell).join(",")).join("\r\n") + "\r\n";
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false; const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
// The template's columns, in order. Header names are human, not the raw keys.
const MENU_CSV_COLS = [
  ["id", "id"], ["name", "name"], ["name_dhivehi", "dv"], ["category", "cat"],
  ["price_mvr", "price"], ["description", "desc"], ["description_dhivehi", "descDv"],
  ["veg", "veg"], ["spice_level_0_3", "spice"], ["heat_choice", "heat"],
  ["best_seller", "bestSeller"], ["allow_comments", "comments"], ["no_kitchen", "noKitchen"],
  ["hidden_from_qr", "hidden"], ["sold_out", "soldOut"], ["tags", "tags"], ["add_ons", "addons"], ["photo_url", "img"],
];
const csvBool = (v) => /^(y|yes|true|1|x)$/i.test(String(v == null ? "" : v).trim());
// Add-ons in a cell, "|"- or ";"-separated. Each is a name with an optional
// price suffixed as " +15" or ":15" (MVR); no suffix = a free choice/size (e.g.
// "3 pcs"). Round-trips the "Name +Price | Name" style menus are written in.
const parseAddonsCell = (v) => String(v || "").split(/[;|]/).map((s) => s.trim()).filter(Boolean).map((s) => {
  const m = s.match(/\s*[:+]\s*(-?\d+(?:\.\d+)?)\s*$/);
  return m ? { name: s.slice(0, m.index).trim(), price: parseFloat(m[1]) || 0 } : { name: s, price: 0 };
}).filter((a) => a.name);
const fmtAddonsCell = (addons) => (Array.isArray(addons) ? addons : []).map((a) => {
  const n = String((a && a.name) || "").trim(), p = (Number(a && a.price) || 0) / 100;
  return n ? (p ? n + " +" + p : n) : "";
}).filter(Boolean).join(" | ");
const parseTagsCell = (v) => String(v || "").split(/[;|]/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
/* The one place a dish's editable fields are validated + coerced. Takes a loose
   input object (from the single-item form OR one CSV row already mapped to keys)
   and returns {fields} to merge onto the product, or {error}. */
function menuFields(b) {
  b = b || {};
  const name = String(b.name || "").trim().slice(0, 120);
  if (!name) return { error: "a name is required" };
  const priceLaari = Math.round((Number(b.price) || 0) * 100);
  if (!(priceLaari > 0)) return { error: "price must be greater than zero" };
  const f = { name, price: priceLaari };
  if (b.cat !== undefined) f.cat = String(b.cat || "").trim().slice(0, 60);
  if (b.dv !== undefined) f.dv = String(b.dv || "").trim().slice(0, 120);
  if (b.desc !== undefined) f.desc = String(b.desc || "").trim().slice(0, 400);
  if (b.descDv !== undefined) f.descDv = String(b.descDv || "").trim().slice(0, 400);
  if (b.veg !== undefined) f.veg = !!b.veg;
  if (b.spice !== undefined) f.spice = Math.max(0, Math.min(3, Math.round(Number(b.spice) || 0)));
  if (b.heat !== undefined) f.heat = !!b.heat;
  if (b.bestSeller !== undefined) f.bestSeller = !!b.bestSeller;
  if (b.comments !== undefined) f.comments = !!b.comments;
  if (b.noKitchen !== undefined) f.noKitchen = !!b.noKitchen;
  if (b.soldOut !== undefined || b.off !== undefined) f.soldOut = !!(b.soldOut !== undefined ? b.soldOut : b.off);
  if (b.hidden !== undefined) f.hidden = !!b.hidden;
  if (Array.isArray(b.tags)) f.tags = b.tags.map((t) => String(t || "").trim()).filter(Boolean).slice(0, 3);
  if (b.img !== undefined) {
    const raw = String(b.img || "").trim();
    if (!raw) f.img = "";
    else if (/^data:image\/(png|jpe?g|webp|gif|svg\+xml)[;,]/i.test(raw) && raw.length <= 500000) f.img = raw;
    else if (/^https?:\/\//i.test(raw)) f.img = raw.slice(0, 600);
    // a self-referential "/api/img/<id>" (from an export) is ignored → keep the stored photo
  }
  if (Array.isArray(b.addons)) {
    f.addons = b.addons.map((a) => ({ name: String((a && a.name) || "").trim().slice(0, 60), price: Math.round((Number(a && a.price) || 0) * 100) })).filter((a) => a.name);
  }
  return { fields: f };
}
// One product's stored data → a CSV row (values in the MENU_CSV_COLS order).
const menuCsvRow = (p) => [
  p.id || "", p.name || "", p.dv || "", p.cat || "", (Number(p.price) || 0) / 100,
  p.desc || "", p.descDv || "", p.veg ? "yes" : "no", Math.max(0, Math.min(3, Math.round(Number(p.spice) || 0))),
  p.heat ? "yes" : "no", p.bestSeller ? "yes" : "no", p.comments ? "yes" : "no", p.noKitchen ? "yes" : "no",
  p.hidden ? "yes" : "no", p.soldOut ? "yes" : "no", (Array.isArray(p.tags) ? p.tags : []).join("; "),
  fmtAddonsCell(p.addons),
  // Keep an external photo URL verbatim so it round-trips; a stored/generated
  // image exports as its /api/img reference (re-import redraws the placeholder).
  p.img ? (/^https?:/i.test(p.img) ? p.img : ("/api/img/" + (p.id || ""))) : "",
];
// One CSV row (mapped by header) → the loose input object menuFields expects.
function menuCsvRowToInput(rec) {
  const b = { name: rec.name, price: rec.price, cat: rec.cat, dv: rec.dv, desc: rec.desc, descDv: rec.descDv };
  if (rec.veg !== undefined) b.veg = csvBool(rec.veg);
  if (rec.spice !== undefined && String(rec.spice).trim() !== "") b.spice = rec.spice;
  if (rec.heat !== undefined) b.heat = csvBool(rec.heat);
  if (rec.bestSeller !== undefined) b.bestSeller = csvBool(rec.bestSeller);
  if (rec.comments !== undefined) b.comments = csvBool(rec.comments);
  if (rec.noKitchen !== undefined) b.noKitchen = csvBool(rec.noKitchen);
  if (rec.hidden !== undefined) b.hidden = csvBool(rec.hidden);
  if (rec.soldOut !== undefined) b.soldOut = csvBool(rec.soldOut);
  if (rec.tags !== undefined && String(rec.tags).trim() !== "") b.tags = parseTagsCell(rec.tags);
  if (rec.addons !== undefined && String(rec.addons).trim() !== "") b.addons = parseAddonsCell(rec.addons);
  // Only an embedded photo (data: URI) is kept; external URLs and /api/img
  // references are dropped — the portals draw a dish-coloured artwork tile.
  if (rec.img !== undefined && /^data:image\//i.test(String(rec.img).trim())) b.img = rec.img;
  return b;
}

/* ── Menu artwork (category-aware placeholder) ────────────────────────────────
   When a dish has no photo — on import, or a create with no upload — it still
   gets a branded tile instead of a blank square: an icon keyed to its category
   over a matching colour, with the dish name. It's a self-contained SVG data
   URI, so it needs no upload, no external host, and can never 404. Line icons
   are drawn on a 24×24 grid (lucide-style), centred + scaled on the tile. */
const ART_ICONS = {
  coffee: '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><path d="M6 2v2M10 2v2M14 2v2"/>',
  cup: '<path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4Z"/><path d="M6 1v3M10 1v3"/>',
  glass: '<path d="M5 3h14l-1.4 8a4 4 0 0 1-3.95 3.3h-3.3A4 4 0 0 1 6.4 11Z"/><path d="M12 14.3V21M8 21h8"/>',
  pizza: '<path d="m2 16 20 6-6-20A20 20 0 0 0 2 16"/><path d="M5.7 17.1a17 17 0 0 1 11.4-11.4"/><path d="M15 11h.01M11 15h.01"/>',
  burger: '<path d="M3 8a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M3 12h18M3 16h18"/><path d="M4 16a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4"/>',
  fish: '<path d="M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6Z"/><path d="M18 12v.01"/><path d="M2.5 6C4 8 4 16 2.5 18"/>',
  bowl: '<path d="M2 12h20a10 10 0 0 1-20 0Z"/><path d="M4 9c1.5-2 5-2 6.5 0M13 9c1.5-2 5-2 6.5 0"/>',
  egg: '<path d="M12 3c4.5 0 7 7 7 11a7 7 0 0 1-14 0c0-4 2.5-11 7-11Z"/>',
  cake: '<path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"/><path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1"/><path d="M2 21h20M12 4v7M12 4h.01"/>',
  utensils: '<path d="M3 2v7a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2V2M6 2v20"/><path d="M18 2a4 4 0 0 0-4 4v5a2 2 0 0 0 2 2h2Zm0 0v20"/>',
  plate: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
};
const menuArtTheme = (cat) => {
  const s = String(cat || "").toLowerCase();
  const t = (re) => re.test(s);
  if (t(/coffee|espresso|lavazza|illy|nescaf|crema|latte|cappucc|americano|macchiato|mocha/)) return { i: "coffee", a: "#3f2617", b: "#7a4a26" };
  if (t(/\btea\b/)) return { i: "cup", a: "#5a4a1e", b: "#94793a" };
  if (t(/juice|smoothie|shake|milkshake|mojito|mocktail|frappe|soft|soda|water|drink/)) return { i: "glass", a: "#155e50", b: "#2fa07f" };
  if (t(/pizza/)) return { i: "pizza", a: "#9a3d1a", b: "#cf6a2c" };
  if (t(/burger|sandwich|submarine|panini|wrap/)) return { i: "burger", a: "#6f4218", b: "#a86e2c" };
  if (t(/fish|seafood|grill/)) return { i: "fish", a: "#175066", b: "#2f86a8" };
  if (t(/rice|noodle|biryani|nasi|bami|kottu|pasta/)) return { i: "bowl", a: "#7a4e18", b: "#b3812c" };
  if (t(/curry|special/)) return { i: "bowl", a: "#8a3418", b: "#bf5e2c" };
  if (t(/breakfast/)) return { i: "egg", a: "#7a5c16", b: "#c19a2c" };
  if (t(/sweet|dessert|treat|cake|pastr|bakery/)) return { i: "cake", a: "#8a2450", b: "#c74a86" };
  if (t(/savory|savoury|baked|fried|snack|side|condiment/)) return { i: "utensils", a: "#6f5218", b: "#a8862c" };
  return { i: "plate", a: "#4a3a2a", b: "#836a4e" };
};
const menuArtifact = (cat, name) => {
  const th = menuArtTheme(cat);
  const icon = ART_ICONS[th.i] || ART_ICONS.plate;
  const label = String(name || "").replace(/[<>&"]/g, "").trim().slice(0, 30);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">'
    + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + th.a + '"/><stop offset="1" stop-color="' + th.b + '"/></linearGradient></defs>'
    + '<rect width="400" height="300" fill="url(#g)"/>'
    + '<g transform="translate(200 118) scale(4)" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><g transform="translate(-12 -12)">' + icon + '</g></g>'
    + (label ? '<text x="200" y="252" text-anchor="middle" font-family="Georgia, \'Times New Roman\', serif" font-size="21" fill="#fff" fill-opacity=".95">' + label + '</text>' : '')
    + '</svg>';
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
};
// True when a photo value is a real image we should keep (an uploaded data: image
// or an external URL) vs. a placeholder reference we should redraw as artwork.
const hasRealPhoto = (v) => { v = String(v || "").trim(); return /^data:image\//i.test(v) || /^https?:\/\//i.test(v); };
// Which top-level GROUP a category falls under, so 20+ sections collapse to a
// short top level (Drinks / Breakfast / Food / Desserts). A saved override
// (settings.catGroup[name]) wins; otherwise a keyword default. Order matters:
// breakfast + desserts are checked before the catch-all Food.
const GROUP_ORDER = ["Drinks", "Breakfast", "Food", "Desserts"];
const catGroupOf = (name) => {
  const s = String(name || "").toLowerCase();
  if (/coffee|espresso|latte|cappucc|mocha|americano|milk|cocoa|hot ?choc|\btea\b|chai|juice|\bdrink|frapp|smoothie|mocktail|shake|\bbrew\b|soda|soft ?drink|beverage|cooler|kurumba|water/.test(s)) return "Drinks";
  if (/breakfast|brunch|morning/.test(s)) return "Breakfast";
  if (/dessert|sweet|cake|ice.?cream|pastr|treat|pudding|foni|bondi|brownie|waffle|pancake/.test(s)) return "Desserts";
  return "Food";
};
// Category list for a store: the manager-ordered saved list first (so an empty
// or reordered section persists), then any category a product uses that isn't
// saved yet — nothing a dish points at ever disappears. Each carries its group
// (a saved override wins over the keyword default).
const mergeCategories = (catName, st) => {
  st = st || {};
  const stored = Array.isArray(st.menuCats) ? st.menuCats : [];
  const cg = (st.catGroup && typeof st.catGroup === "object") ? st.catGroup : {};
  const seen = new Set(), out = [];
  const add = (nm) => { const id = menuCat(nm); if (id && !seen.has(id)) { seen.add(id); out.push({ id, name: String(nm), group: String(cg[nm] || catGroupOf(nm)) }); } };
  stored.forEach(add);
  Object.keys(catName || {}).forEach((id) => { if (!seen.has(id)) add(catName[id]); });
  return out;
};
// Ordered top-level groups actually in use, canonical order first then custom.
const menuGroupsOf = (categories) => {
  const out = [];
  (categories || []).forEach((c) => { if (c.group && out.indexOf(c.group) < 0) out.push(c.group); });
  return out.sort((a, b) => { const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
};
// The full palette the category manager offers when assigning a group: the four
// canonical groups always, plus any custom group a category already uses — so a
// manager can move a section to Drinks even when nothing sits there yet.
const menuGroupPalette = (categories) => {
  const out = GROUP_ORDER.slice();
  (categories || []).forEach((c) => { if (c.group && out.indexOf(c.group) < 0) out.push(c.group); });
  return out;
};

// ── Guest storefront (the v2 QR page: web3/proto/guest.html) ────────────────
// Module scope so BOTH the /v2 route block and the web2 guest entry (which are
// in separate `if (fs.existsSync(...))` blocks) can render the SAME page. Uses
// catSlug (module) rather than the block-scoped liveMenu.
const buildGuestReal = async (orgId, slug) => withOrg(orgId, async (c) => {
  const prodRows = (await c.query(
    "SELECT id, data FROM entities WHERE org_id=$1 AND kind='products' AND deleted=false", [orgId])).rows;
  const photo = {};
  for (const r of prodRows) {
    const im = r.data && r.data.img; if (!im) continue;
    // A stored data: URI (uploaded photo / AI picture) is served by a PUBLIC,
    // slug-scoped route so an anonymous guest can load it; an external http(s)
    // URL is used verbatim. (The staff /api/img needs a session, which a guest
    // doesn't have — so the customer menu must use /p/:slug/img.)
    photo[r.id] = /^https?:\/\//i.test(String(im)) ? String(im)
      : (slug ? "/p/" + encodeURIComponent(slug) + "/img/" + encodeURIComponent(r.id) : "/api/img/" + encodeURIComponent(r.id))
        + "?v=" + crypto.createHash("sha1").update(String(im)).digest("hex").slice(0, 12);
  }
  const menu = prodRows.map((r) => ({ id: r.id, d: r.data || {} }))
    .filter((x) => x.d.name && !x.d.hidden)
    .map((x) => { const p = x.d;
      const soldOut = !!p.soldOut || (p.recipeAvail != null ? Number(p.recipeAvail) <= 0 : (p.stock != null && Number(p.stock) <= 0));
      const addons = (Array.isArray(p.addons) ? p.addons : [])
        .map((a) => ({ name: String((a && a.name) || "").trim(), price: (Number(a && a.price) || 0) / 100 }))
        .filter((a) => a.name);
      return { id: x.id, cat: menuCat(p.cat), sub: String(p.cat || ""), name: p.name, desc: p.desc || "",
        price: (Number(p.price) || 0) / 100, img: photo[x.id] || "", bestSeller: !!(p.bestSeller || p.trending), trending: !!p.trending, soldQty: Number(p.soldQty) || 0, soldOut: soldOut,
        // Item tags for the QR menu: vegetarian flag, the fixed spice level
        // (0-3, 0 = shown as nothing) and whether the pass can vary the heat.
        veg: !!p.veg, spice: Math.max(0, Math.min(3, Math.round(Number(p.spice) || 0))), heat: !!p.heat,
        addons: addons, comments: !!p.comments, recipe: [] }; });
  const catName = {};
  menu.forEach((it) => { if (!catName[it.cat]) catName[it.cat] = it.sub || it.cat; });
  const st = ((await c.query(
    "SELECT data FROM entities WHERE org_id=$1 AND kind='settings' AND id='settings' AND deleted=false LIMIT 1", [orgId])).rows[0] || {}).data || {};
  const categories = mergeCategories(catName, st);
  const gstBp = Number(st.gstBp) || 800, scBp = Number(st.svcChargeBp) || 0, tax = gstBp >= 1600 ? "TGST" : "GGST";
  const storeRows = (await c.query(
    "SELECT id, code, name, address FROM stores WHERE org_id=$1 AND active ORDER BY created_at", [orgId])).rows;
  const outlets = storeRows.map((sr, i) => ({ id: i === 0 ? 3 : 20 + i, storeId: sr.id, code: sr.code || ("OUT-" + (i + 1)),
    name: sr.name || st.storeName || "Outlet", type: "restaurant", loc: "restaurant", parent: 0, region: "",
    tax: tax, rate: Math.round(gstBp / 100), sc: Math.round(scBp / 100), addr: sr.address || "", mgr: "", pos: true, seats: 48, tables: 12 }));
  // The store's own identity — same brand block the v2 terminal edits, so the QR
  // page wears the store's brand, not the demo "KASHIKEYO" fascia.
  const brand = { name: st.storeName || "Store", logo: st.logo || "", tagline: st.tagline || "",
    accent: st.accent || "", footer: st.receiptFooter || st.footer || "", whiteLabel: !!st.whiteLabel };
  const fiscalAddr = [st.address, st.island, st.atoll].filter(Boolean).join(", ");
  // A single data version for the menu surface: the max rowver across products +
  // settings (dishes, categories, prices, branding all bump it). The page ships
  // it as KPOS_REAL.ver; the portal polls /p/:slug/ver and reloads when it moves,
  // so a menu edit reaches an open QR/customer page within one poll — no manual
  // refresh. The HTML is no-store, so the reload pulls the fresh menu.
  const ver = Number(((await c.query(
    "SELECT COALESCE(MAX(rowver),0) AS v FROM entities WHERE org_id=$1 AND kind IN ('products','settings')", [orgId])).rows[0] || {}).v) || 0;
  return {
    guest: true, ver, outlet: { name: st.storeName || "Store", tax: tax, rate: Math.round(gstBp / 100),
      sc: Math.round(scBp / 100), currency: st.currency === "USD" ? "USD" : "MVR" },
    outlets: outlets.length ? outlets : null, categories, groups: menuGroupsOf(categories), menu, brand,
    fiscal: { tin: st.tin || "", gstNo: st.gstRegNo || "", legalName: st.legalName || "", address: fiscalAddr, phone: st.phone || "" },
  };
});
const GUEST_V3_CSP = [
  "default-src 'self'", "base-uri 'self'", "object-src 'none'",
  "img-src 'self' data: blob: https:", "font-src 'self' data: https://fonts.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "connect-src 'self' blob: data:", "frame-ancestors 'none'",
].join("; ");
const guestV3File = path.join(__dirname, "web3", "proto", "guest.html");
const hasGuestV3 = () => { try { return fs.existsSync(guestV3File); } catch (e) { return false; } };
// Cache-bust the /v2 logic assets per deploy. The HTML is served no-cache, but
// /v2/*.js is cached (5m browser + longer at a CDN/Cloudflare edge), so after a
// deploy a browser could keep running an OLD kashikeyo-data.js — which ignores the
// freshly-injected KPOS_REAL.brand and renders the demo "KASHIKEYO". A per-deploy
// version query gives each release a fresh URL, so it self-heals on the next load.
const ASSET_VER = String(process.env.RAILWAY_GIT_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT || Date.now()).slice(0, 12);
const bustV2Assets = (html) => html.replace(
  /(<(?:script|link)\b[^>]*?\b(?:src|href)=")((?:\.\/)?[\w./-]+\.(?:js|css))(")/gi,
  (m, pre, url, post) => /^https?:/i.test(url) ? m : pre + url + (url.indexOf("?") >= 0 ? "&" : "?") + "v=" + ASSET_VER + post);
// Render the v2 storefront for a resolved org: real menu + branding, the slug
// (for /p/:slug/* on a subdomain with no ?s=), the table (?t=) and customer (?c=).
const serveGuestV3 = async (req, res, org, opts = {}) => {
  const storeId = cleanStoreId(opts.storeId || DEFAULT_STORE_ID);
  try { await ensureDefaultStore(org.id, org.store_name); } catch (e) { /* best effort */ }
  const real = await buildGuestReal(org.id, org.slug);
  real.slug = org.slug;
  const table = String(opts.table || "").replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 20);
  if (table) real.table = table;
  if (opts.custId) {
    try {
      const cust = (await kindAll(org.id, "customers", storeId)).find((x) => idEq(x.id, opts.custId));
      if (cust) real.customer = { id: cust.id, name: cust.name || "", points: Number(cust.points) || 0,
        balance: Number(cust.balance) || 0, memberNo: cust.memberNo || "", address: cust.address || "" };
    } catch (e) { /* the account tab is optional */ }
  }
  const safeTitle = String((real.brand && real.brand.name) || org.store_name || "Order online").replace(/[<>&"]/g, "") + " · Order online";
  let html = fs.readFileSync(guestV3File, "utf8");
  const inject = "\n<script>window.KPOS_REAL=" + JSON.stringify(real).replace(/</g, "\\u003c") + ";</script>";
  html = html.replace('<base href="/v2/">', '<base href="/v2/">' + inject)
    .replace(/<title>[^<]*<\/title>/i, "<title>" + safeTitle + "</title>");
  html = bustV2Assets(html);   // per-deploy ?v= so a cached kashikeyo-data.js can't strand the store on demo branding
  res.set("Content-Security-Policy", GUEST_V3_CSP);
  // The storefront HTML carries the store's live identity (name, brand, menu)
  // injected as KPOS_REAL. It MUST reflect a rename immediately, so never cache
  // it — not in the browser, not at the Railway/CDN edge. `no-cache` still let a
  // conditional request 304 against a stale copy (a rename would then not show
  // until the cache expired). `no-store` + a CDN directive stop every layer from
  // holding a copy, and with no-store the browser makes no conditional request,
  // so there is no 304-against-stale. Vary:Host keeps one store's page off
  // another store's slug at any shared cache.
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("CDN-Cache-Control", "no-store");
  res.set("Vary", "Host");
  res.set("Content-Type", "text/html; charset=utf-8").send(html);
};

/* ── Registered-customer (rewards) portal page ───────────────────────────────
   The member portal (web3/proto/member.html) is a separate surface from the QR
   storefront: a person with a history, not a table. The page needs only the
   store's brand + slug + earn rate injected; the member's own data is fetched
   live from /p/:slug/member/me once they sign in. Served at /m?s=<slug> (a
   dedicated rewards.<domain> host can point here later). */
const memberV3File = path.join(__dirname, "web3", "proto", "member.html");
const hasMemberV3 = () => { try { return fs.existsSync(memberV3File); } catch (e) { return false; } };
const serveMemberPortal = async (req, res, org) => {
  const real = await buildGuestReal(org.id, org.slug);
  const settings = (await loadSettingsArr(org.id))[0] || {};
  const cfg = loyaltyConfig(settings);
  // The Order tab reads the shared POS menu (inclusive MVR prices, sold-out
  // flags) + the outlet's table list. Cost/recipe never leave the POS.
  let tables = [];
  try { tables = (await kindAll(org.id, "tables", DEFAULT_STORE_ID)).map((t) => String(t.name || t.id)).filter(Boolean).slice(0, 60); } catch (e) { /* optional */ }
  const payload = { slug: org.slug, ver: real.ver || 0, brand: real.brand || {}, outlet: real.outlet || {}, fiscal: real.fiscal || {},
    pointsPer: cfg.pointsPer, redeemPer: cfg.redeemPer,
    menu: real.menu || [], categories: real.categories || [], tables: tables };
  const safeTitle = String((real.brand && real.brand.name) || org.store_name || "Rewards").replace(/[<>&"]/g, "") + " Rewards";
  let html = fs.readFileSync(memberV3File, "utf8");
  const inject = "\n<script>window.KPOS_REAL=" + JSON.stringify(payload).replace(/</g, "\\u003c") + ";</script>";
  html = html.replace('<base href="/v2/">', '<base href="/v2/">' + inject)
    .replace(/<title>[^<]*<\/title>/i, "<title>" + safeTitle + "</title>");
  html = bustV2Assets(html);
  res.set("Content-Security-Policy", GUEST_V3_CSP);
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("CDN-Cache-Control", "no-store");
  res.set("Vary", "Host");
  res.set("Content-Type", "text/html; charset=utf-8").send(html);
};
app.get("/m", wrap(async (req, res) => {
  const subSlug = portalSlugFromHost(req);
  const slug = String(req.query.s || subSlug || "").trim();
  const org = slug ? await orgBySlug(slug) : null;
  if (!org || !hasMemberV3()) return res.status(404).set("Content-Type", "text/html; charset=utf-8").set("Cache-Control", "no-store").send(STOREFRONT_NOT_FOUND_HTML);
  return serveMemberPortal(req, res, org);
}));
if (fs.existsSync(protoFile)) {
  const protoDir = path.join(__dirname, "web2", "proto");
  const protoCache = {};
  // The prototypes ship as their design-tool source: an .dc.html template that
  // loads ./support.js (its runtime), pulls artwork/*.png + fonts/*.ttf, and
  // (via support.js) fetches React from unpkg, overridable through
  // window.__resources. We serve all of those from the route's own path and
  // vendor React from our own origin, so each design renders 1:1 with no
  // third-party runtime dependency. support.js reconstructs assets as blob:
  // scripts, compiles its logic class with new Function, and loads Google
  // Fonts; the CSP permits exactly that, scoped to these routes only — the
  // strict global CSP still governs every other route.
  const PROTO_CSP = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "connect-src 'self' blob: data:",
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
  ].join("; ");
  const enc = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
  const readProto = (file) => {
    if (!protoCache[file] || process.env.NODE_ENV !== "production") {
      protoCache[file] = fs.readFileSync(path.join(protoDir, file), "utf8");
    }
    return protoCache[file];
  };
  // Map an org's live catalogue into the prototype's MENU shape ({id,cat,en,dv,
  // price,img}). Shared by the register (tiles) and the admin Menu section.
  // Map a product's stored add-ons ({name, price-in-laari}) into the till/guest
  // modifier-modal shape ({id, en, price-in-MVR}) the prototype expects.
  const liveMods = (addons) => (Array.isArray(addons) ? addons : [])
    .map((a, i) => ({ id: "a" + i, en: String((a && a.name) || ""), price: (Number(a && a.price) || 0) / 100 }))
    .filter((a) => a.en);
  // includeHidden: staff surfaces (the v2 terminal) pass true so a "hidden from
  // the customer menu" dish still lists for management + till sale, carrying the
  // `hidden` flag. Customer surfaces (guest QR, /p/:slug) never pass it and keep
  // filtering hidden out — the default is unchanged for every existing caller.
  const liveMenu = (rows, includeHidden) => rows
    .map((r) => ({ id: r.id, ...(r.data || {}) }))
    .filter((p) => p.name && (includeHidden || !p.hidden))
    // No `img` here: product photos ride once in window.__resources (art-<id>),
    // which is what the tiles' assetUrl(id) reads. Duplicating the base64 here
    // tripled the payload (this + menuAll + __resources) and made the cockpit
    // slow to load; the tiles never read this field.
    .map((p) => ({ id: p.id, cat: menuCat(p.cat), sub: String(p.cat || ""), en: p.name, dv: p.dv || "", price: (Number(p.price) || 0) / 100, desc: p.desc || "", descDv: p.descDv || "", tags: Array.isArray(p.tags) ? p.tags.filter(Boolean).slice(0, 3) : [], bestSeller: !!(p.bestSeller || p.trending), trending: !!p.trending, soldQty: Number(p.soldQty) || 0, hidden: !!p.hidden, mods: liveMods(p.addons), veg: !!p.veg, spice: Math.max(0, Math.min(3, Math.round(Number(p.spice) || 0))), heat: !!p.heat, soldOut: derivedSoldOut(p),
      // Why it is off, when the availability engine knows ("Out of Tuna").
      // Null for a manual off-switch or a plain stock-out; the register's 86
      // list falls back to the item name alone in that case.
      soldOutReason: p.soldOutReason || "" }));
  // Sold-out is real when the owner flagged it, an ingredient-driven recipe has
  // no servings left (recipeAvail<=0), or a stock-tracked item hit zero — the
  // same rule the guest boot mapper uses, so the register tile + admin menu
  // reflect live depletion, not just a manually-set flag.
  const derivedSoldOut = (p) => !!p.soldOut || (p.recipeAvail != null ? Number(p.recipeAvail) <= 0 : (p.stock != null && Number(p.stock) <= 0));
  // Full catalogue for the admin Menu manager — includes hidden items and
  // carries the hidden/soldOut flags so the admin can show/restore them.
  const liveMenuAll = (rows) => rows
    .map((r) => ({ id: r.id, ...(r.data || {}) }))
    .filter((p) => p.name)
    .map((p) => ({ id: p.id, cat: menuCat(p.cat), sub: String(p.cat || ""), en: p.name, dv: p.dv || "", desc: p.desc || "", descDv: p.descDv || "", price: (Number(p.price) || 0) / 100, hidden: !!p.hidden, soldOut: derivedSoldOut(p), custom: /^c_/.test(String(p.id)), stockable: !!p.stockIngredientId, mods: liveMods(p.addons) }));
  // Map live customer entities (+ order aggregation) into the admin cockpit's
  // custData shape. tier is derived from loyalty points; visits/spend come from
  // the customer's real orders.
  const liveCustData = (custRows, orderRows) => {
    const byCust = {};
    for (const r of orderRows) {
      const o = r.data || {}; const cid = String(o.customerId || o.custId || "");
      if (!cid) continue;
      const g = byCust[cid] || (byCust[cid] = { n: 0, s: 0 });
      g.n += 1; g.s += Number(o.total) || 0;
    }
    return custRows.map((r) => {
      const d = r.data || {}; const pts = Number(d.points) || 0;
      const agg = byCust[String(d.id || r.id)] || { n: 0, s: 0 };
      return {
        id: String(d.id || r.id), n: d.name || "", dv: d.dv || "", ph: d.phone || "",
        tier: pts >= 500 ? "Gold" : pts >= 200 ? "Silver" : "Bronze",
        visits: agg.n, spend: Math.round(agg.s / 100),
        joined: "", allergy: d.allergy || "—", diet: d.diet || "—", note: d.note || "",
      };
    }).filter((c) => c.n);
  };
  // Register read-path (window.__ksReg): map real entities onto the register's
  // own state shapes so its store identity, customers, sales History and live
  // Kitchen/Delivery queues reflect production data instead of seeds.
  const hhmm = (t) => new Date(Number(t) || Date.now()).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const chLabel = (s) => s.orderType === "dine" ? ("POS · T" + (s.tableNo || "")) : s.orderType === "delivery" ? "Delivery" : "Takeaway";
  const chKind = (s) => s.orderType === "dine" ? "dine" : s.orderType === "delivery" ? "deliv" : "reg";
  const payLabel = (s) => {
    const p = (Array.isArray(s.payments) && s.payments[0]) || {};
    const m = String(p.method || s.method || "cash").toLowerCase();
    return m === "cash" ? "Cash" : m === "card" ? "Card" : (m === "tab" || m === "credit") ? "On tab"
      : (m === "transfer" || m === "bml") ? "BML transfer" : (p.method || "Cash");
  };
  const liveStoreP = (settings) => ({
    name: (settings && settings.storeName) || "Kashikeyo",
    currency: (settings && settings.currency) || "MVR",
    usdRate: (settings && Number(settings.usdRate)) || 1542,
    tin: (settings && settings.tin) || "",
    /* MIRA particulars the back office collected and the receipt never saw. */
    gstRegNo: (settings && settings.gstRegNo) || "",
    legalName: (settings && settings.legalName) || "",
    phone: (settings && settings.phone) || "",
    island: (settings && settings.island) || "",
    atoll: (settings && settings.atoll) || "",
    /* Which MIRA rate this outlet files under — the guest portal has no other
       source for it, and used to charge a hardcoded 10%. */
    taxRate: (settings && settings.adminCfg && settings.adminCfg.taxRate) === "tgst" ? "tgst" : "ggst",
    /* The register used to carry the GST and service rates as hardcoded
       prototype props, so every store on the platform charged 8%/17% and
       exactly 10% service regardless of its own settings. These are the
       store's, and they are what the server audits sales against. */
    gstBp: (settings && Number(settings.gstBp) > 0) ? Number(settings.gstBp)
      : ((settings && settings.adminCfg && settings.adminCfg.taxRate) === "tgst" ? 1700 : 800),
    svcChargeBp: (settings && Number(settings.svcChargeBp) >= 0) ? Number(settings.svcChargeBp) : 0,
    /* The floor plan and the table picker were hardcoded to 12 tables, so a
       40-table outlet could not seat T13-T40 from the till at all — and a QR
       order from a higher table created a bill that never appeared in the grid
       while still counting toward "occupied". */
    tableCount: (settings && Number(settings.tableCount) > 0) ? Math.min(200, Math.round(Number(settings.tableCount))) : 12,
    /* Which categories go to the hot line. Two "stations" used to exist only as
       a label chosen by first-match over hardcoded slugs. */
    hotCats: Array.isArray(settings && settings.hotCats) ? settings.hotCats : ["hedhikaa", "mains"],
    address: (settings && settings.address) || "",
    footer: (settings && (settings.receiptFooter || settings.footer)) || "",
    logo: (settings && settings.logo) || "",
    /* Storefront branding — the trading tagline, the accent that repaints the
       guest portal, and the white-label switch. */
    tagline: (settings && settings.tagline) || "",
    accent: (settings && settings.accent) || "",
    whiteLabel: !!(settings && settings.whiteLabel),
  });
  const liveSalesLog = (saleRows, refundedIds) => saleRows.map((s) => ({
    id: String(s.id || ""), fullNo: String(s.no || ""), at: Number(s.at) || Number(s.t) || 0,
    type: s.type || "sale",
    /* Whether this sale already has a refund against it, so the register can
       show the state instead of letting a second refund be raised. */
    refunded: !!(refundedIds && refundedIds.has(String(s.id || ""))),
    total0: Math.round(Number(s.total) || 0),
    /* A refund is numbered as the original with a -R suffix; strip that
       before taking the last segment, or every refund row reads just "R". */
    no: (String(s.no || "").replace(/-R$/, "").replace(/^.*-/, "") + (s.type === "refund" ? "R" : "")) || String(s.id || "").slice(-4),
    ch: chLabel(s), chK: chKind(s), otype: asOtype(s.orderType),
    time: hhmm(s.at), items: (s.lines || []).reduce((a, l) => a + (Number(l.qty) || 0), 0),
    total: Math.round(Number(s.total) || 0) / 100, cust: s.customerName || "Walk-in", custDv: s.customerDv || s.customerName || "Walk-in", method: payLabel(s),
    methodKey: String(((s.payments || [])[0] || {}).method || "cash"),
  }));
  const liveRegRecv = (custRows) => custRows.map((r) => {
    /* Laari, not rounded rufiyaa. This used to Math.round(balance/100), so a
       debtor's balance was misstated by up to MVR 0.50 — and the till printed
       that figure on the customer's receipt as their new balance. */
    const d = r.data || {}; const bal = Math.round(Number(d.balance) || 0) / 100;
    const days = d.lastOrderAt ? Math.max(0, Math.round((Date.now() - Number(d.lastOrderAt)) / 86400000)) : 0;
    return { id: r.id, name: d.name || "", dv: d.dv || d.name || "", bal, days, addr: d.address || d.addr || "",
      pts: Math.round(Number(d.points) || 0), visits: Number(d.visits) || 0, spend: Math.round((Number(d.spend) || 0) / 100),
      memberNo: d.memberNo || d.code || "", usuals: Array.isArray(d.usuals) ? d.usuals : [] };
  });
  const liveTickets = (ordRows) => ordRows
    .filter((o) => !finalStatuses.has(String(o.status || "new")) && String(o.status) !== "ready" && !o.noKitchen)
    .slice(0, 12)
    .map((o) => ({ oid: o.id, no: String(o.no || "").replace(/^ORD-/, ""), at: Number(o.createdAt) || Date.now(),
      src: o.source === "qr" ? ("QR" + (o.table && o.table !== "Pickup" && o.table !== "Delivery" ? " · " + o.table : "")) : ("POS" + (o.table && o.table !== "Pickup" && o.table !== "Delivery" ? " · " + o.table : "")),
      billId: o.billId || "", table: o.table || "",
      /* The station used to be hardcoded "hot" for every server-sourced
         ticket, so six juices and a curry all printed HOT KITCHEN. It comes
         from the order now, routed off the store's category map. */
      station: o.station || "hot", items: (o.items || []).map((li) => ({ q: Number(li.qty || li.q) || 1, n: li.name || li.n || "" })) }));
  const liveDeliv = (ordRows) => ordRows
    .filter((o) => o.otype === "delivery" && !finalStatuses.has(String(o.status || "new")))
    .slice(0, 12)
    .map((o) => ({ oid: o.id, no: String(o.no || "").replace(/^ORD-/, "D-"), cust: o.customerName || "Guest", custDv: o.customerDv || o.customerName || "Guest", zone: o.zone || "Malé",
      items: (o.items || []).map((li) => (Number(li.qty || li.q) || 1) + "× " + (li.name || li.n || "")).join(" · "),
      rider: (o.rider && String(o.rider).trim()) || "—", st: String(o.status) === "ready" ? 1 : 0 }));
  // Per-range real analytics for the admin dashboard + Reports, computed from
  // real sales (+ expenses for a rough COGS). Overlaid onto the prototype's
  // DATA[range] so the stat cards, trend chart, GST, payment mix and top items
  // reflect production figures.
  const liveReports = (saleRows, expRows) => {
    const now = Date.now(), day = 86400000;
    const sod = new Date(); sod.setHours(0, 0, 0, 0); const st = sod.getTime();
    const specs = { today: [st, now, 24, 3600000, st], yest: [st - day, st, 24, 3600000, st - day],
      week: [now - 7 * day, now, 7, day, now - 7 * day], month: [now - 30 * day, now, 30, day, now - 30 * day],
      quarter: [now - 90 * day, now, 13, 7 * day, now - 90 * day], year: [now - 365 * day, now, 12, 30 * day, now - 365 * day] };
    const qtyOf = (s) => (s.lines || []).reduce((a, l) => a + (Number(l.qty) || 0), 0);
    // Sum revenue/orders/items/GP over an arbitrary [since,until) window — used
    // for the current window and the immediately-preceding one (for deltas).
    const windowAgg = (since, until) => {
      const rows = saleRows.filter((s) => { const t = Number(s.at) || 0; return t >= since && t < until; });
      const rev = rows.reduce((a, s) => a + (Number(s.total) || 0), 0) / 100;
      const orders = rows.length, items = rows.reduce((a, s) => a + qtyOf(s), 0);
      const purchases = expRows.filter((e) => { const t = Number(e.t) || 0; return t >= since && t < until && e.cat === "Purchases"; }).reduce((a, e) => a + (Number(e.amount) || 0), 0) / 100;
      return { rev, orders, items, gpVal: Math.max(0, rev - purchases), rows };
    };
    // A signed percentage-change string ("+8.2%", "−4.0%", or "—" when there's
    // no prior baseline) in the exact shape the dashboard's arrow/colour helpers
    // parse (leading "−" = down/red).
    const pctDelta = (cur, prev) => {
      if (!(prev > 0)) return cur > 0 ? "New" : "—";
      const p = (cur - prev) / prev * 100;
      return (p >= 0 ? "+" : "−") + Math.abs(p).toFixed(1) + "%";
    };
    const out = {};
    for (const k in specs) {
      const [since, until, nb, bk, bs] = specs[k];
      const cur = windowAgg(since, until);
      const prev = windowAgg(since - (until - since), since);
      const rows = cur.rows;
      const orders = cur.orders, items = cur.items;
      const aov = (w) => (w.orders ? w.rev / w.orders : 0);
      const gst = Math.round(rows.reduce((a, s) => a + (Number(s.gst) || 0), 0)) / 100;
      const rc = new Array(nb).fill(0);
      for (const s of rows) { let i = Math.floor(((Number(s.at) || since) - bs) / bk); if (i < 0) i = 0; if (i >= nb) i = nb - 1; rc[i] += (Number(s.total) || 0) / 100; }
      const pm = { cash: 0, card: 0, transfer: 0, tab: 0 };
      for (const s of rows) for (const p of (s.payments || [])) { const m = String(p.method || "").toLowerCase(), a = (Number(p.amount) || 0) / 100; if (m === "cash") pm.cash += a; else if (m === "card") pm.card += a; else if (m === "tab" || m === "credit") pm.tab += a; else pm.transfer += a; }
      const byItem = {};
      for (const s of rows) for (const l of (s.lines || [])) { const n = l.name || l.pid; if (!n) continue; const g = byItem[n] || (byItem[n] = { qty: 0, rev: 0 }); g.qty += Number(l.qty) || 0; g.rev += saleLineTotal(l) / 100; }
      const topItems = Object.keys(byItem).map((n) => ({ n, qty: byItem[n].qty, rev: Math.round(byItem[n].rev) })).sort((a, b) => b.qty - a.qty).slice(0, 6);
      const gpVal = cur.gpVal;
      // Busiest bucket, only for the hour-resolution ranges (today/yest).
      let peakN = "";
      if ((k === "today" || k === "yest") && rc.some((x) => x > 0)) {
        let pi = 0; for (let i = 1; i < rc.length; i++) if (rc[i] > rc[pi]) pi = i;
        const h = (n) => (n % 12 || 12) + (n < 12 || n === 24 ? "am" : "pm");
        peakN = "Busiest " + h(pi) + "–" + h((pi + 1) % 24);
      }
      out[k] = { rev: Math.round(cur.rev), orders, items, aov: orders ? Math.round(cur.rev / orders * 100) / 100 : 0,
        gpVal: Math.round(gpVal), gpPct: cur.rev ? ((gpVal / cur.rev * 100).toFixed(1) + "%") : "0%",
        basket: orders ? (items / orders).toFixed(1) : "0", rc: rc.map((x) => Math.round(x)),
        d: [pctDelta(cur.rev, prev.rev), pctDelta(orders, prev.orders), pctDelta(gpVal, prev.gpVal), pctDelta(aov(cur), aov(prev))],
        peakN,
        gst, payMix: { cash: Math.round(pm.cash), card: Math.round(pm.card), transfer: Math.round(pm.transfer), tab: Math.round(pm.tab) }, topItems };
    }
    return out;
  };
  // Collect the register read-path payload (window.__ksReg) for an org. Shared
  // by the page inject (serveProto) and the live-refresh poll (/api/app2/pull).
  const collectRegData = async (c, orgId, register, storeId) => {
    const out = {};
    const setRow = (await c.query(
      "SELECT data FROM entities WHERE org_id=$1 AND kind='settings' AND id='settings' AND deleted=false LIMIT 1", [orgId])).rows[0];
    out.storeP = Object.assign(liveStoreP(setRow ? setRow.data : {}), {
      // The till printed a hardcoded "R1" on receipts and a hardcoded "Malé"
      // chip in its header; both now come from the session's real register and
      // the outlet's own address.
      register: register || "R1",
    });
    out.recv = liveRegRecv((await c.query(
      "SELECT id, data FROM entities WHERE org_id=$1 AND kind='customers' AND deleted=false ORDER BY (data->>'balance')::numeric DESC NULLS LAST, (data->>'lastOrderAt')::numeric DESC NULLS LAST LIMIT 1000", [orgId])).rows);
    {
      const saleRows = (await c.query(
        "SELECT data FROM entities WHERE org_id=$1 AND kind='sales' AND deleted=false ORDER BY COALESCE((data->>'t')::numeric,(data->>'at')::numeric,(data->>'createdAt')::numeric,0) DESC LIMIT 60", [orgId]))
        .rows.map((r) => r.data || {});
      const refunded = new Set(saleRows.filter((x) => x.type === "refund" && x.refundOf).map((x) => String(x.refundOf)));
      out.salesLog = liveSalesLog(saleRows.filter((x) => !x.type || x.type === "sale" || x.type === "refund").slice(0, 40), refunded);
    }
    const ordRows = (await c.query(
      "SELECT data FROM entities WHERE org_id=$1 AND kind='orders' AND deleted=false ORDER BY COALESCE((data->>'t')::numeric,(data->>'at')::numeric,(data->>'createdAt')::numeric,0) DESC LIMIT 40", [orgId]))
      .rows.map((r) => r.data || {});
    out.tickets = liveTickets(ordRows);
    out.deliv = liveDeliv(ordRows);
    /* Live customer/QR orders for the register's Orders → tracking panel. Only
       the still-open ones (not yet charged/settled or cancelled); each carries
       the type, table, customer and accepted flag the register renders. */
    out.orders = ordRows
      .filter((o) => o && o.id && !finalStatuses.has(String(o.status || "new").toLowerCase()) && String(o.status || "") !== "cancelled")
      .map((o) => ({
        id: o.id, no: o.no || "", status: String(o.status || "new"), otype: asOtype(o.otype),
        table: o.table || "", accepted: !!o.accepted, source: o.source || "qr",
        customerId: o.customerId || null, customerName: o.customerName || "", customerDv: o.customerDv || "",
        zone: o.zone || "", note: o.note || "", createdAt: o.createdAt || Date.now(),
        items: (o.items || []).map((it) => ({ q: Number(it.qty) || 1, n: it.name || "Item", pid: it.pid || it.id || "", price: (Number(it.price) || 0) / 100 })),
        total: Math.round(((o.items || []).reduce((a, it) => a + (Number(it.price) || 0) * (Number(it.qty) || 1), 0) + (Number(o.fee) || 0))) / 100,
      }));
    const sd = (setRow && setRow.data) || {};
    /* Delivery zones the outlet actually configured. The register used to carry a
       hardcoded Malé/Hulhumalé/Villimalé table and add ITS fee to the bill, so
       every store in the country charged Malé-area delivery. No zones configured
       means no zone list and no fee — never an invented one. */
    /* Open (held) bills. These used to live only in one browser tab's RAM:
       a waiter's tablet refreshing at 8pm lost every occupied table's bill, and
       two waiters on the same floor each held a private, disjoint set of tables
       — both could open T6, neither saw the other's items, and whoever charged
       first billed half the table. They are entities now, so every terminal
       sees the same floor. */
    out.openBills = (await c.query(
      "SELECT id, data FROM entities WHERE org_id=$1 AND kind='openBills' AND deleted=false AND COALESCE(data->>'storeId',$2)=$2 ORDER BY COALESCE((data->>'t')::numeric,(data->>'at')::numeric,(data->>'createdAt')::numeric,0) DESC LIMIT 60",
      [orgId, storeId || DEFAULT_STORE_ID])).rows.map((r) => Object.assign({}, r.data || {}, { id: String(r.id) }));
    out.zones = (await c.query(
      "SELECT data FROM entities WHERE org_id=$1 AND kind='zones' AND deleted=false", [orgId])).rows
      .map((r) => r.data || {})
      .filter((z) => z.name)
      .map((z) => ({ id: z.id || "", name: String(z.name), dv: z.dv || "", fee: (Number(z.fee) || 0) / 100, eta: z.eta || "" }));
    /* Next receipt number for this register — display only. The real number is
       drawn from a database-owned block via /api/app2/seq (see
       allocReceiptBlock); deriving it from COUNT(sales) let a soft-delete
       rewind the counter onto a number a customer already held. */
    out.nextSeq = await peekReceiptSeq(c, orgId, storeId, register);
    out.catGroups = Array.isArray(sd.catGroups) ? sd.catGroups : [];
    out.catOrder = Array.isArray(sd.catOrder) ? sd.catOrder : [];
    /* Staff for the register's PIN lock (name, role, djb2-hashed pin) — the
       same client-side check the baked till uses, so /app2 can gate on a
       per-staff PIN and carry that staff's role into its permission checks. */
    out.users = (await c.query(
      "SELECT id, data FROM entities WHERE org_id=$1 AND kind='users' AND deleted=false", [orgId])).rows
      /* The PIN hash is deliberately NOT sent. It is djb2 over a 4-digit
         space — the whole keyspace is brute-forceable in milliseconds from the
         page source — and the same PIN logs into the back office. /api/pull
         already scrubs it (see scrubEntity); this payload used to hand it
         over verbatim. The till gets a boolean and asks the server to check
         the PIN (POST /api/app2/unlock). */
      .map((r) => ({ id: r.id, name: ((r.data && r.data.name) || "").toString().slice(0, 60) || "Staff", role: (r.data && r.data.role) || "cashier", hasPin: !!(r.data && r.data.pin) }));
    /* Real Day-End / Z-report aggregate for the till (audit B4): the register's
       Day-End used to render hardcoded demo takings. Sum TODAY's completed
       sales by payment method + GST/service so a cashier's end-of-day reflects
       actual money taken. Money is laari → major units. Day boundary is the
       server-local midnight, matching the /admin Reports convention. */
    const sodz = new Date(); sodz.setHours(0, 0, 0, 0);
    const zrows = (await c.query(
      "SELECT data FROM entities WHERE org_id=$1 AND kind='sales' AND deleted=false AND COALESCE((data->>'t')::numeric,(data->>'at')::numeric,(data->>'createdAt')::numeric,0) >= $2", [orgId, sodz.getTime()]))
      .rows.map((r) => r.data || {}).filter((s) => !s.type || s.type === "sale" || s.type === "refund");
    /* Refunds used to be filtered OUT of the Z-report entirely. On a day with
       MVR 496.50 of sales and a MVR 110 cash refund the report read gross
       496.50 / cash 447.00 instead of 386.50 / 337.00 — revenue overstated by
       the whole refund, GST over-accrued, and the drawer expected to hold MVR
       110 that had been paid out. A refund carries negative amounts, so it nets
       correctly simply by being counted. */
    /* `net` is the sales' OWN revenue component (subtotal less the bill
       discount), summed independently of gross. The day-end journal used to
       derive revenue by subtracting GST and service charge from gross, which
       made it a plug: the entry balanced by construction and could never
       report an error, however wrong the underlying figures were. Measured
       separately, the two sides can genuinely disagree — and say so. */
    const zag = { gross: 0, net: 0, cash: 0, card: 0, transfer: 0, tab: 0, gst: 0, svc: 0, orders: 0, refunds: 0, refundCount: 0, cashFx: {}, cashFxHome: 0, fxChange: 0 };
    for (const s of zrows) {
      const isRefund = s.type === "refund";
      if (isRefund) { zag.refunds += Math.abs(Number(s.total) || 0); zag.refundCount++; }
      else zag.orders++;
      zag.gross += Number(s.total) || 0;
      zag.net += (Number(s.subtotal) || 0) - (Number(s.billDisc) || 0) - (Number(s.fee) || 0);
      zag.gst += Number(s.gst) || 0;
      zag.svc += Number(s.svcCharge) || 0;
      const pays = (Array.isArray(s.payments) && s.payments.length) ? s.payments : [{ method: s.method || "cash", amount: Number(s.total) || 0 }];
      for (const p of pays) {
        const amt = Number(p.amount) || 0, m = String(p.method || "cash").toLowerCase();
        if (m === "cash") {
          zag.cash += amt;
          /* A tender taken in a foreign note is still cash, and still counts
             towards the day's takings in home currency — but it is a different
             pile in the drawer. A manager cannot add dollar notes to a rufiyaa
             total, so the face value is tracked per currency alongside the
             home-currency amount, and the change given back (always in home
             currency) is netted off the home cash the drawer should hold. */
          const cur = String(p.curr || "").toUpperCase();
          if (cur && Number(p.fxAmount)) {
            zag.cashFx[cur] = (zag.cashFx[cur] || 0) + Number(p.fxAmount);
            zag.cashFxHome += amt;
            zag.fxChange += Number(p.fxChange) || 0;
          }
        }
        else if (m === "card") zag.card += amt;
        else if (m === "tab" || m === "ontab") zag.tab += amt;
        else zag.transfer += amt; // transfer, bml/gateway
      }
    }
    /* Cash taken against a customer tab is cash in the drawer that no sale
       accounts for, so a drawer count without it always reads "over". */
    const zsettle = (await c.query(
      "SELECT data FROM entities WHERE org_id=$1 AND kind='settlements' AND deleted=false AND COALESCE((data->>'t')::numeric,(data->>'at')::numeric,(data->>'createdAt')::numeric,0) >= $2",
      [orgId, sodz.getTime()])).rows.map((r) => r.data || {});
    let zCashSettled = 0, zSettled = 0;
    for (const st of zsettle) { zSettled += Number(st.amount) || 0; if (/^cash$/i.test(String(st.method || "cash"))) zCashSettled += Number(st.amount) || 0; }
    const zM = (v) => Math.round(v) / 100;
    out.zday = { gross: zM(zag.gross), net: zM(zag.net), cash: zM(zag.cash), card: zM(zag.card), transfer: zM(zag.transfer), tab: zM(zag.tab), gst: zM(zag.gst), svc: zM(zag.svc), orders: zag.orders,
      refunds: zM(zag.refunds), refundCount: zag.refundCount, cashSettled: zM(zCashSettled), settled: zM(zSettled),
      cashFx: Object.keys(zag.cashFx).map((c) => ({ curr: c, amount: zM(zag.cashFx[c]) })),
      cashFxHome: zM(zag.cashFxHome), fxChange: zM(zag.fxChange) };
    return out;
  };
  // Serve one design-tool prototype under `base` (e.g. /app2, /admin2). index/
  // redirect:false so `base` and `base/` reach the dynamic handler while
  // support.js / artwork / fonts / vendor are served statically. `withMenu`
  // injects the live catalogue into window.__ksMenu (register tiles + admin Menu
  // section); `withAdmin` injects real customers into window.__ksAdmin. Sections
  // without injected data fall back to the prototype's own demo data.
  const serveProto = ({ base, file, withMenu, withAdmin, minRank }) => {
    app.use(base, express.static(protoDir, { index: false, redirect: false, maxAge: "1h",
      /* The worker script itself must never be served from cache, or a
         fleet can be stuck on an old worker with no way to replace it. */
      setHeaders: (res, file) => { if (file.endsWith("sw.js")) {
        res.set("Cache-Control", "no-cache");
        /* The register is served at /app as well as /app/..., and a worker's
           default scope is its own directory — /app/ — which does NOT cover
           /app. Without this header the worker installs and then never
           controls the page anyone actually loads. */
        res.set("Service-Worker-Allowed", base);
      } } }));
    const vendor = {
      "https://unpkg.com/react@18.3.1/umd/react.production.min.js": base + "/vendor/react.production.min.js",
      "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js": base + "/vendor/react-dom.production.min.js",
    };
    app.get(new RegExp("^" + base.replace(/[/]/g, "\\$&") + "(\\/.*)?$"), requireAppSession, async (req, res) => {
      /* The back office's WRITE endpoints were gated, but the page itself was
         not: any session got the whole cockpit — every customer's name and
         phone, the staff list, receivables and all revenue reports — because
         only requireAppSession stood in front of it. On a shared tablet left
         signed in, any staff member could simply navigate there. */
      if (minRank && appRankOf(req.appRole) < minRank) return res.redirect(302, "/app");
      /* Not every request under this prefix wants the page. Five unresolved
         template bindings ship in the markup as img src values ("{{ d.src }}"
         and friends); the browser dutifully requests them, this catch-all
         matched, and each one returned ~460 KB of register HTML AND re-ran the
         whole data collection — two sequential scans of the sales table apiece.
         3.0 MB transferred for a 0.6 MB page and six times the database work
         per boot. A sub-resource request gets a 404, which is what it is.

         This tests for what a sub-resource POSITIVELY IS, not for what a
         document positively is. The first version demanded a Sec-Fetch-Dest of
         "", "document" or "iframe" — but the register's own offline shell
         (web2/proto/sw.js) re-issues every navigation through fetch(), and a
         service-worker-issued navigation arrives as Sec-Fetch-Dest: empty in
         WebKit. So on any iOS till that had installed the shell, /app answered
         "not found" as text/plain, which Safari rendered bare and offered to
         save as app.txt. The offline shell and this guard were each correct
         alone and took the till down together; an allow-list of document
         destinations cannot be kept in step with what engines actually send,
         so only a known sub-resource destination is rejected here. The five
         unresolved "{{ d.src }}" bindings are still caught — they arrive as
         dest "image" and their paths still carry the braces. */
      const dest = String(req.get("Sec-Fetch-Dest") || "");
      const SUB_RESOURCE = new Set([
        "image", "style", "script", "font", "audio", "video", "track",
        "object", "embed", "manifest", "worker", "serviceworker",
        "sharedworker", "paintworklet", "audioworklet", "xslt", "report",
      ]);
      const wantsPage = req.method === "GET" && !SUB_RESOURCE.has(dest);
      if (!wantsPage || /\.[a-z0-9]{2,5}$/i.test(req.path) || /[{}]/.test(decodeURIComponent(req.path))) {
        return res.status(404).type("text/plain").send("not found");
      }
      let menu = []; const adminData = {}; const regData = {}; let token = null;
      const menuImg = {}; // art-<id> → product photo, only for photo-rendering surfaces
      const isRegister = file === "index.html";
      if (withMenu || withAdmin) {
        try {
          const orgId = await resolveAppSession(req);
          // A short-lived-enough ops bearer token so the register can persist
          // completed sales to /api/ops from the browser (same credential the
          // baked till uses). Only minted for the register route.
          if (withMenu) token = sign(orgId, req.appRegister, req.appStoreId);
          await withOrg(orgId, async (c) => {
            if (withMenu) {
              const prodRows = (await c.query(
                "SELECT id, data FROM entities WHERE org_id=$1 AND kind='products' AND deleted=false", [orgId])).rows;
              menu = liveMenu(prodRows);
              // Product photos go into window.__resources (art-<id>) ONCE, and
              // only for surfaces that actually render tiles (the register/guest,
              // not the admin cockpit, which shows no product photos). This is the
              // single copy the tiles' assetUrl(id) reads.
              // Map each product photo to its own cacheable, versioned URL instead
              // of inlining the base64 into this (no-cache) HTML. ?v=<hash> makes the
              // URL immutable, so the browser downloads each image once and reuses it
              // across every later load — the register HTML drops from ~850KB to ~360KB.
              if (!withAdmin) for (const r of prodRows) {
                const im = r.data && r.data.img;
                if (!im) continue;
                // A remote (https) photo is handed straight to the tile; a stored
                // data-URI is served from /api/img/<id> so its base64 doesn't ride
                // in this no-cache HTML.
                menuImg["art-" + (r.id)] = /^https?:\/\//i.test(String(im))
                  ? String(im)
                  : "/api/img/" + encodeURIComponent(r.id) + "?v=" + crypto.createHash("sha1").update(String(im)).digest("hex").slice(0, 12);
              }
            }
            if (isRegister) Object.assign(regData, await collectRegData(c, orgId, req.appRegister, req.appStoreId));
            if (withAdmin) {
              /* Bounded: /admin used to pull every customer and every order the
                 store had ever taken on each page load and parse them all into
                 JS. Ninety days of QR trading is ~90k rows for a panel that
                 shows recent history. */
              const custRows = (await c.query(
                "SELECT id, data FROM entities WHERE org_id=$1 AND kind='customers' AND deleted=false ORDER BY (data->>'lastOrderAt')::numeric DESC NULLS LAST LIMIT 2000", [orgId])).rows;
              const orderRows = (await c.query(
                "SELECT data FROM entities WHERE org_id=$1 AND kind='orders' AND deleted=false ORDER BY COALESCE((data->>'t')::numeric,(data->>'at')::numeric,(data->>'createdAt')::numeric,0) DESC LIMIT 4000", [orgId])).rows;
              adminData.custData = liveCustData(custRows, orderRows);
              adminData.menuAll = liveMenuAll((await c.query(
                "SELECT id, data FROM entities WHERE org_id=$1 AND kind='products' AND deleted=false", [orgId])).rows);
              // Inventory stock levels from the real ingredients ledger.
              const ingRows = (await c.query(
                "SELECT id, name, current_stock, base_unit, min_stock, avg_cost, producible FROM ingredients WHERE org_id=$1 AND active ORDER BY name", [orgId])).rows;
              adminData.stock = ingRows.map((i) => ({
                id: i.id, n: i.name, oh: Number(i.current_stock) || 0, unit: i.base_unit || "",
                par: Number(i.min_stock) || 0, cost: Math.round((Number(i.avg_cost) || 0) / 100),
                prep: i.producible === true,
              }));
              // Dashboard: today's headline KPIs + recent orders from real sales.
              // One wide fetch of recent sales (incl. refunds) feeds the dashboard,
              // reports, top-staff, refunds and split lists. 200 rows silently
              // capped a busy day's totals (a 1000-cover day showed only the last
              // 200 orders); 3000 covers a full day of even a high-volume outlet.
              const rawSaleRows = (await c.query(
                "SELECT data FROM entities WHERE org_id=$1 AND kind='sales' AND deleted=false ORDER BY COALESCE((data->>'t')::numeric,(data->>'at')::numeric,(data->>'createdAt')::numeric,0) DESC LIMIT 3000", [orgId]))
                .rows.map((r) => r.data || {});
              const saleRows = rawSaleRows.filter((s) => !s.type || s.type === "sale");
              /* The cap is real: at 3000 rows a high-volume outlet's quarter and
                 year figures are the most recent 3000 sales, not the period.
                 The disk-spilling sort behind this is gone (the ordering is
                 index-backed now), but the truncation is not — so say so rather
                 than quietly under-report. Aggregating the long ranges in SQL is
                 the proper fix and a larger change than this. */
              adminData.salesTruncated = rawSaleRows.length >= 3000;
              adminData.salesWindowFrom = rawSaleRows.length ? Number(
                rawSaleRows[rawSaleRows.length - 1].t || rawSaleRows[rawSaleRows.length - 1].at || 0) : 0;
              const qtyOf = (s) => (s.lines || []).reduce((a, l) => a + (Number(l.qty) || 0), 0);
              const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
              const today = saleRows.filter((s) => (Number(s.at) || 0) >= startOfDay.getTime());
              const rev = today.reduce((a, s) => a + (Number(s.total) || 0), 0) / 100;
              const orders = today.length;
              const items = today.reduce((a, s) => a + qtyOf(s), 0);
              adminData.dash = { rev: Math.round(rev * 100) / 100, orders, items, aov: orders ? Math.round(rev / orders * 100) / 100 : 0 };
              adminData.orders = saleRows.slice(0, 12).map((s) => ({
                no: String(s.no || "").replace(/^.*-/, "") || String(s.id || "").slice(-4),
                ch: s.orderType === "dine" ? ("Dine-in · T" + (s.tableNo || "")) : s.orderType === "delivery" ? "Delivery" : "Takeaway",
                chK: s.orderType === "delivery" ? "deliv" : "reg",
                time: new Date(Number(s.at) || Date.now()).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
                items: qtyOf(s), staff: "", total: Math.round((Number(s.total) || 0) / 100), st: "Paid",
              }));
              // Dashboard LIVE ORDERS pulse (used when no live cross-tab bridge).
              const ago = (t) => {
                const m = Math.max(0, Math.round((Date.now() - (Number(t) || 0)) / 60000));
                return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.round(m / 60) + "h ago";
              };
              adminData.pulse = saleRows.slice(0, 3).map((s) => ({
                ch: s.orderType === "delivery" ? "DELIV" : s.orderType === "dine" ? "POS" : "POS",
                no: String(s.no || "").replace(/^.*-/, "") || String(s.id || "").slice(-4),
                ago: ago(s.at), amt: "MVR " + Math.round((Number(s.total) || 0) / 100),
              }));
              // Receivables: customers carrying an outstanding balance.
              const dfmt = (t) => t ? new Date(Number(t)).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "—";
              adminData.recv = custRows.map((r) => Object.assign({ _id: String((r.data && r.data.id) || r.id) }, r.data || {})).filter((d) => (Number(d.balance) || 0) > 0)
                .sort((a, b) => (Number(b.balance) || 0) - (Number(a.balance) || 0))
                .map((d) => {
                  const bal = Math.round((Number(d.balance) || 0) / 100);
                  return { id: d._id, n: d.name || "", c: d.phone || "Account", bal, age: "—", last: dfmt(d.lastOrderAt), stk: bal >= 1000 ? "bad" : bal >= 300 ? "warn" : "ok" };
                });
              // Procurement > Expenses from the real expense ledger.
              const expRows = (await c.query(
                "SELECT data FROM entities WHERE org_id=$1 AND kind='expenses' AND deleted=false ORDER BY COALESCE((data->>'t')::numeric,(data->>'at')::numeric,(data->>'createdAt')::numeric,0) DESC LIMIT 40", [orgId])).rows.map((r) => r.data || {});
              adminData.expenses = expRows.map((e) => ({
                d: dfmt(e.t), cat: e.cat || "Purchases", v: e.supplier || e.userName || "—",
                m: e.paidFrom === "cash" ? "Cash" : e.paidFrom === "card" ? "Card" : "Transfer",
                amt: Math.round((Number(e.amount) || 0) / 100), ap: "Approved",
              }));
              adminData.reports = liveReports(saleRows, expRows);
              // Procurement > Suppliers from the real suppliers table.
              const supRows = (await c.query(
                "SELECT id, name, phone, email, notes FROM suppliers WHERE org_id=$1 AND active ORDER BY name", [orgId])).rows;
              adminData.suppliers = supRows.map((v) => ({
                id: v.id, n: v.name, cat: v.notes || "General", c: v.phone || v.email || "—",
                terms: "—", out: 0, k: "ok",
              }));
              // Procurement > Purchase Orders from the till's pords sync stream.
              const poRows = (await c.query(
                "SELECT id, data FROM entities WHERE org_id=$1 AND kind='pords' AND deleted=false ORDER BY COALESCE((data->>'t')::numeric,(data->>'at')::numeric,(data->>'createdAt')::numeric,0) DESC LIMIT 40", [orgId])).rows;
              adminData.pos = poRows.map((x) => {
                const d = x.data || {}; const st = d.status === "received" ? "Received" : d.status === "draft" ? "Draft" : "Open";
                const lineItems = (d.items || []).map((it) => ({
                  desc: String(it.desc || ""), qty: Number(it.qty) || 0,
                  unit: String(it.unit || ""), cost: Number(it.cost) || 0,
                }));
                return { id: String(d.id || x.id), no: d.no || String(x.id).slice(-6), v: d.supplier || "Unassigned",
                  items: lineItems.length, lineItems, total: Math.round((Number(d.total) || 0) / 100),
                  open: st === "Open", st, stk: st === "Received" ? "ok" : st === "Draft" ? "mut" : "info" };
              });
              // Persisted cockpit config (Configurations / Payments / Notifications
              // / System / Store / Kitchen toggles) + the store profile it lives on.
              const setRow = (await c.query(
                "SELECT data FROM entities WHERE org_id=$1 AND kind='settings' AND id='settings' AND deleted=false LIMIT 1", [orgId])).rows[0];
              const setData = setRow ? (setRow.data || {}) : {};
              adminData.cfg = setData.adminCfg || {};
              adminData.catGroups = Array.isArray(setData.catGroups) ? setData.catGroups : [];
              adminData.catOrder = Array.isArray(setData.catOrder) ? setData.catOrder : [];
              const storeName = setData.storeName || setData.name || "";
              adminData.store = {
                name: storeName, currency: setData.currency || "MVR",
                usdRate: Number(setData.usdRate) || 1542,
                tin: setData.tin || "", address: setData.address || "", footer: setData.receiptFooter || setData.footer || "",
                phone: setData.phone || "", email: setData.email || "",
                gst: Number(setData.gst != null ? setData.gst : setData.gstRate) || 0, svc: Number(setData.svcCharge) || 0,
              };
              // Store slug (for real per-table QR deep-links) + effective SEO
              // (persisted overrides, else sensible defaults from the store name).
              try {
                const org = (await c.query("SELECT slug FROM orgs WHERE id=$1", [orgId])).rows[0];
                adminData.slug = org ? org.slug : "";
              } catch (e) { adminData.slug = ""; }
              const seoCfg = (setData.adminCfg && setData.adminCfg.seo) || {};
              adminData.seo = {
                title: seoCfg.title || ((storeName || "Kashikeyo") + " · Order online"),
                desc: seoCfg.desc || ("Order from " + (storeName || "our store") + " — fresh, fast, local."),
              };
              // Outlets from the real stores table (multi-store), enriched with
              // today's real performance per store: sales carry data.storeId, so
              // group today's sales by store for revenue / orders / items / the
              // set of staff who rang a sale there, plus a 12-slot hourly spark.
              const storeRows = (await c.query(
                "SELECT id, code, name, address, active FROM stores WHERE org_id=$1 ORDER BY created_at", [orgId])).rows;
              const perStore = new Map();
              for (const s of today) {
                const sid = cleanStoreId(s.storeId || DEFAULT_STORE_ID);
                const a = perStore.get(sid) || { rev: 0, ord: 0, items: 0, staff: new Set(), spark: new Array(12).fill(0) };
                a.rev += (Number(s.total) || 0); a.ord += 1; a.items += qtyOf(s);
                const who = (s.userName || "").trim(); if (who) a.staff.add(who);
                const hr = new Date(Number(s.at) || Date.now()).getHours();
                a.spark[Math.min(11, Math.floor(hr / 2))] += (Number(s.total) || 0) / 100;
                perStore.set(sid, a);
              }
              adminData.outlets = storeRows.map((o) => {
                const a = perStore.get(cleanStoreId(o.id)) || { rev: 0, ord: 0, items: 0, staff: new Set(), spark: new Array(12).fill(0) };
                return {
                  id: o.id, n: o.name, code: o.code, addr: o.address || "", active: !!o.active,
                  rev: Math.round(a.rev / 100), ord: a.ord, items: a.items, staff: a.staff.size, spark: a.spark,
                };
              });
              // Payment-method volumes from today's real sales (payMix on reports).
              adminData.payMix = (adminData.reports && adminData.reports.today && adminData.reports.today.payMix) || { cash: 0, card: 0, transfer: 0, tab: 0 };
              // ── Tier 1: sub-lists derived from real sales / users / activity_log ──
              const hhmm = (t) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
              const allSaleRows = rawSaleRows;
              // Reports > Performance: top staff by real sales (sales carry userName).
              const staffAgg = new Map();
              for (const s of saleRows) {
                const who = (s.userName || "").trim(); if (!who) continue;
                const cur = staffAgg.get(who) || { rev: 0, orders: 0 };
                cur.rev += (Number(s.total) || 0) / 100; cur.orders += 1; staffAgg.set(who, cur);
              }
              adminData.topStaff = Array.from(staffAgg.entries())
                .map(([n, v]) => ({ n, rev: Math.round(v.rev), orders: v.orders }))
                .sort((a, b) => b.rev - a.rev).slice(0, 5);
              // Payments > Refunds: real refund-type sales.
              adminData.refunds = allSaleRows.filter((s) => s.type === "refund")
                .slice(0, 12).map((s) => ({
                  ref: "#" + (String(s.no || s.id || "").replace(/^.*-/, "")), amt: Math.round((Number(s.total) || 0) / 100),
                  reason: s.reason || s.refundReason || "Refund", staff: s.userName || "—",
                  st: s.managerApproved ? "Approved" : "Pending", k: s.managerApproved ? "ok" : "warn",
                  when: s.at ? hhmm(s.at) : "—",
                }));
              // Payments > Split bills: sales settled with more than one payment.
              adminData.splits = allSaleRows.filter((s) => (s.payments || []).length > 1)
                .slice(0, 8).map((s) => ({
                  ref: "#" + (String(s.no || s.id || "").replace(/^.*-/, "")), total: Math.round((Number(s.total) || 0) / 100),
                  parts: (s.payments || []).map((p) => (p.method || "pay") + " " + Math.round((Number(p.amount) || 0) / 100)).join(" · "),
                  n: (s.payments || []).length,
                }));
              // Reports > Z-Report: persisted cashier shift cash-ups (drawer
              // reconciliation + variance), newest first, for manager review.
              const shiftRaw = (await c.query(
                "SELECT data FROM entities WHERE org_id=$1 AND kind='shifts' AND deleted=false AND data->>'status'='closed' ORDER BY (data->>'closedAt')::numeric DESC NULLS LAST LIMIT 200", [orgId]))
                .rows.map((r) => r.data || {});
              adminData.shifts = shiftRaw.slice(0, 30).map((d) => ({
                staff: d.closedBy || d.staffName || "—",
                open: d.openedAt ? hhmm(d.openedAt) : "—", close: d.closedAt ? hhmm(d.closedAt) : "—",
                float: Math.round((Number(d.float) || 0)) / 100, counted: Math.round((Number(d.counted) || 0)) / 100,
                expected: Math.round((Number(d.expected) || 0)) / 100, cashSales: Math.round((Number(d.cashSales) || 0)) / 100,
                variance: Math.round((Number(d.variance) || 0)) / 100, gross: Math.round((Number(d.grossSales) || 0)) / 100,
              }));
              // Per-staff hours worked, summed from closed-shift durations.
              const staffHrs = new Map();
              for (const d of shiftRaw) {
                const nm = (d.closedBy || d.staffName || "").trim();
                const ms = (Number(d.closedAt) || 0) - (Number(d.openedAt) || 0);
                if (!nm || !(ms > 0)) continue;
                const cur = staffHrs.get(nm) || { ms: 0, shifts: 0 };
                cur.ms += ms; cur.shifts += 1; staffHrs.set(nm, cur);
              }
              // Staff + System Admin: real users entities.
              const userRows = (await c.query(
                "SELECT id, data FROM entities WHERE org_id=$1 AND kind='users' AND deleted=false ORDER BY updated_at", [orgId]))
                .rows.map((r) => r.data || {});
              const roleLabel = (r) => r === "owner" ? "Master Admin" : r ? (r.charAt(0).toUpperCase() + r.slice(1)) : "Cashier";
              adminData.staffTeam = userRows.map((u) => {
                const ag = staffAgg.get((u.name || "").trim()) || { rev: 0, orders: 0 };
                const hr = staffHrs.get((u.name || "").trim()) || { ms: 0, shifts: 0 };
                return { id: u.id, n: u.name || "—", role: roleLabel(u.role), roleKey: (u.role || "").toLowerCase(), owner: u.role === "owner", sales: Math.round(ag.rev), orders: ag.orders, hours: Math.round(hr.ms / 3600000 * 10) / 10, shifts: hr.shifts };
              });
              adminData.sysUsers = userRows.map((u) => ({ n: u.email || u.name || "—", role: roleLabel(u.role) }));
              // Activity feeds (Staff > Activity, Auth codes; Notifications > alerts;
              // System Admin > audit) all from the real activity_log.
              const actRows = (await c.query(
                "SELECT at, actor, action, ref, detail FROM activity_log WHERE org_id=$1 ORDER BY at DESC LIMIT 40", [orgId])).rows;
              const prettyAct = (a) => (a.action || "").replace(/[._]/g, " ") + (a.ref ? " · " + a.ref : "");
              adminData.audit = actRows.slice(0, 12).map((a) => ({ t: hhmm(a.at), a: prettyAct(a), u: a.actor || "system" }));
              adminData.activity = actRows.slice(0, 8).map((a) => ({ t: hhmm(a.at), u: a.actor || "system", a: prettyAct(a) }));
              adminData.authLog = actRows.filter((a) => /refund|void|elevate|discount|over_limit/.test(a.action || ""))
                .slice(0, 6).map((a) => ({ t: hhmm(a.at), a: prettyAct(a), by: a.actor ? ("by " + a.actor) : "system",
                  st: /flag|over_limit|declin/.test(a.action || "") ? "Flagged" : "Approved",
                  k: /flag|over_limit|declin/.test(a.action || "") ? "bad" : "ok" }));
              adminData.alerts = actRows.slice(0, 6).map((a) => ({ a: prettyAct(a), time: hhmm(a.at),
                k: /flag|over_limit|declin|void/.test(a.action || "") ? "warn" : /refund/.test(a.action || "") ? "info" : "reg" }));
              // System Admin > Integrations: real state where we can detect it.
              const aiOn = !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
              const notifCfg = (setData.adminCfg && setData.adminCfg.channels) || {};
              adminData.integrations = [
                { name: "Cloud sync", detail: "Connected", on: true },
                { name: "AI features", detail: aiOn ? "Connected" : "Not configured", on: aiOn },
                { name: "MIRA GST portal", detail: "Not connected", on: false },
                { name: "BML payment gateway", detail: (setData.adminCfg && setData.adminCfg.bmlMerchant) ? "Connected" : "Not connected", on: !!(setData.adminCfg && setData.adminCfg.bmlMerchant) },
                { name: "Telegram alerts", detail: notifCfg.telegramChatId ? "Connected" : "Not connected", on: !!notifCfg.telegramChatId },
              ];
              // The signed-in admin's own identity for the account menu (no demo
              // user switcher). Falls back to the org owner when the session
              // carries no staff profile (e.g. the owner's first login).
              const ownerRow = userRows.find((u) => u.role === "owner");
              adminData.me = {
                name: (req.appStaff && req.appStaff.name) || (ownerRow && ownerRow.name) || "Admin",
                role: roleLabel(req.appRole || (ownerRow && ownerRow.role) || "owner"),
                // Machine-readable, for gating owner-only actions in the UI.
                isOwner: appRankOf(req.appRole || (ownerRow && ownerRow.role) || "owner") >= APP_RANK.OWNER,
                // Machine-readable role key so the terminal can scope a cashier's
                // view to what they may do (owner/manager keep the full cockpit).
                roleKey: String(req.appRole || (ownerRow && ownerRow.role) || "owner").toLowerCase(),
              };
            }
          });
        } catch (e) { recordError(base + " data inject", e); }
      }
      // window.__resources drives both React vendoring (cdnScriptFor) and the
      // prototype's assetUrl(id) = __resources['art-'+id] image lookup, so we
      // map each real product's image onto its tile; items without an image
      // fall back to the prototype's glyph tiles.
      const resources = Object.assign({}, vendor, menuImg);
      // <base href="base/"> so the template's relative ./support.js, artwork/*
      // and fonts/* resolve under the route even though the page URL has no
      // trailing slash. Injected right after <head> so it governs every later ref.
      /* Sale persistence (audit A-C2). This used to be a bare
         fetch('/api/ops', …).catch(function(){}) — no response check, no retry,
         no queue. A momentary dropout between the tablet and the router
         destroyed a completed, paid-for sale in silence: not in the Z-report,
         not in the GST return, not in the stock deduction, and cash in the
         drawer with no matching record. It is now a durable localStorage-backed
         outbox that retries with backoff until the server acknowledges, keyed
         on an opId minted once at enqueue so a replay is idempotent against the
         `ops` table. window.__ksOutbox exposes the real pending count so the
         register can show the truth instead of an animation. */
      const pushSaleJs = token
        ? `window.__ksToken=${JSON.stringify(token)};\n` + OUTBOX_JS + (isRegister ? SW_REG_JS : "")
        : "";
      // Corrective CSS: hide the scrollbar on horizontally-scrollable pill/tab
      // rows (they scroll instead of clipping on narrow screens) — Firefox uses
      // the inline scrollbar-width:none, this covers Chrome/Safari/WebKit.
      // Also neutralise the design-tool runtime's shimmer skeleton
      // (.sc-placeholder): our data resolves synchronously, so the skeleton only
      // ever flashes as a "loading" glitch when popups/menus stream in. Making
      // it invisible lets content appear cleanly with no loading artefact.
      const fixCss = `\n<style>[style*="overflow-x:auto"]::-webkit-scrollbar{height:0;width:0;display:none}` +
        `.sc-placeholder{animation:none!important;background:transparent!important;opacity:0!important}` +
        // Every pop-up dims the page with a full-viewport overlay that also
        // backdrop-blurs it. Blurring a snapshot of a heavy screen (dozens of
        // image tiles) each animation frame is the main reason pop-ups open
        // with a stutter on tablets. Drop the blur on the full-screen overlays
        // (inset:0) — the dark translucent dim stays, so they still read as
        // modal — and shorten the card entrance so it snaps in. The frosted
        // header (not inset:0) is untouched.
        `[style*="inset:0"][style*="backdrop-filter"]{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}` +
        /* Minimum tap target. 61 of 63 register controls measured under the 44px
           floor — a 22px destructive "remove" sitting beside a 24px "−" on a
           cart line, 20px-tall Clear and Hold, 30px category chips. On a
           counter tablet during a rush that is a mis-tap machine. Enforced as a
           floor on the interactive elements rather than by hand-editing dozens
           of inline styles, so it also covers controls added later. Elements
           that opt out (`data-tap="tight"`) keep their own size. */
        `button:not([data-tap="tight"]),[role="button"]:not([data-tap="tight"]){min-height:44px}` +
        `input:not([type=checkbox]):not([type=radio]):not([data-tap="tight"]),select:not([data-tap="tight"]){min-height:44px}` +
        /* Named font families fall back to real system faces rather than to
           the browser's default serif when the remote stylesheet has not
           arrived (or never will). */
        `@font-face{font-family:'Bricolage Grotesque';src:local('Bricolage Grotesque'),local('Montserrat'),local('Inter'),local('Segoe UI'),local('Roboto'),local('Helvetica Neue');font-display:swap}` +
        `@font-face{font-family:'Inter';src:local('Inter'),local('Segoe UI'),local('Roboto'),local('Helvetica Neue'),local('Arial');font-display:swap}</style>`;
      // The prototype's top-nav icons are injected via dangerouslySetInnerHTML,
      // which the design-tool runtime doesn't populate in this served setup, so
      // the bar shows labels with empty icon slots. This self-healing script
      // fills each nav button's icon slot with the matching line icon and
      // re-applies after every re-render (currentColor inherits the button's
      // active/idle colour). Register only.
      const navIconsJs = file === "index.html"
        ? `(function(){var IC={register:'<path d="M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5"/><path d="M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244"/><path d="M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05"/>',orders:'<path d="M12 17V7"/><path d="M16 8h-6a2 2 0 0 0 0 4h4a2 2 0 0 1 0 4H8"/><path d="M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z"/>',qr:'<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',tabs:'<path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M15 2v20"/><path d="M15 7h5"/><path d="M15 12h5"/><path d="M15 17h5"/>',dayend:'<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>'};var ORDER=['register','orders','qr','tabs','dayend'];function fill(){var nav=document.querySelector('nav');if(!nav)return;var b=nav.querySelectorAll('button');if(b.length<3||b.length>7)return;for(var i=0;i<b.length&&i<ORDER.length;i++){var w=b[i].querySelector('span');if(!w)continue;var bg=w.style.background||'';if(bg.indexOf('coral')<0){w.style.background='var(--sur2)';}w.style.borderRadius='11px';var inner=w.querySelector('span')||w;if(!inner.querySelector('svg')){var g=IC[ORDER[i]];if(g)inner.innerHTML='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+g+'</svg>';}}}var raf=0;function sched(){if(raf)return;raf=requestAnimationFrame(function(){raf=0;fill();});}function start(){fill();try{new MutationObserver(sched).observe(document.body,{childList:true,subtree:true});}catch(e){}}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){setTimeout(start,600);});else setTimeout(start,600);})();`
        : "";
      /* Below admin rank, withhold the owner-tier blocks. The back office's
         WRITE endpoints are gated at ADMIN, but the page shipped the whole
         payload to anyone who could load it: every customer's name and phone,
         the staff list with per-person sales, and the system audit. A manager
         needs the operational screens, not the personnel file. */
      if (withAdmin && appRankOf(req.appRole) < APP_RANK.ADMIN) {
        if (Array.isArray(adminData.custData)) {
          adminData.custData = adminData.custData.map((c2) => Object.assign({}, c2, { phone: "", email: "", addr: "" }));
        }
        adminData.sysUsers = [];
        adminData.audit = [];
        adminData.staffTeam = (adminData.staffTeam || []).map((u) => ({ id: u.id, n: u.n, role: u.role, roleKey: u.roleKey, owner: u.owner }));
      }
      const adminIconsJs = file === "admin.html"
        ? `(function(){var IC={"Dashboard":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>',"Sales":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>',"Outlets":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5"/><path d="M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244"/><path d="M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05"/></svg>',"Kitchen Display":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21a1 1 0 0 0 1-1v-5.35c0-.457.316-.844.727-1.041a4 4 0 0 0-2.134-7.589 5 5 0 0 0-9.186 0 4 4 0 0 0-2.134 7.588c.411.198.727.585.727 1.041V20a1 1 0 0 0 1 1Z"/><path d="M6 17h12"/></svg>',"Online Store":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>',"Menu":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>',"Inventory":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/></svg>',"Procurement":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>',"Receivables":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 15h2a2 2 0 1 0 0-4h-3c-.6 0-1.1.2-1.4.6L3 17"/><path d="m7 21 1.6-1.4c.3-.4.8-.6 1.4-.6h4c1.1 0 2.1-.4 2.8-1.2l4.6-4.4a2 2 0 0 0-2.75-2.91l-4.2 3.9"/><path d="m2 16 6 6"/><circle cx="16" cy="9" r="2.9"/><circle cx="6" cy="5" r="3"/></svg>',"Customers":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/></svg>',"Payments":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>',"Reports":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>',"Staff & Roles":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15H6a4 4 0 0 0-4 4v2"/><path d="m14.305 16.53.923-.382"/><path d="m15.228 13.852-.923-.383"/><path d="m16.852 12.228-.383-.923"/><path d="m16.852 17.772-.383.924"/><path d="m19.148 12.228.383-.923"/><path d="m19.53 18.696-.382-.924"/><path d="m20.772 13.852.924-.383"/><path d="m20.772 16.148.924.383"/><circle cx="18" cy="15" r="3"/><circle cx="9" cy="7" r="4"/></svg>',"Hardware & Offline":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/></svg>',"Notifications":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/></svg>',"Configurations":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/></svg>',"System Admin":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>'};function fill(){var nav=document.querySelector('aside nav');if(!nav)return;var kids=nav.children;for(var i=0;i<kids.length;i++){var btn=kids[i];if(!btn||btn.tagName!=='BUTTON')continue;var direct=btn.querySelectorAll(':scope > span');if(direct.length<2)continue;var iconSpan=direct[0],labelSpan=direct[1];var label=(labelSpan.textContent||'').trim();if(iconSpan.querySelector('svg'))continue;var g=IC[label];if(g)iconSpan.innerHTML=g;}}var raf=0;function sched(){if(raf)return;raf=requestAnimationFrame(function(){raf=0;fill();});}function start(){fill();try{new MutationObserver(sched).observe(document.body,{childList:true,subtree:true});}catch(e){}}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){setTimeout(start,600);});else setTimeout(start,600);})();`
        : "";
      const ordTabIconsJs = file === "index.html"
        ? `(function(){var IC={"Tracking":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/></svg>',"Kitchen":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21a1 1 0 0 0 1-1v-5.35c0-.457.316-.844.727-1.041a4 4 0 0 0-2.134-7.589 5 5 0 0 0-9.186 0 4 4 0 0 0-2.134 7.588c.411.198.727.585.727 1.041V20a1 1 0 0 0 1 1Z"/><path d="M6 17h12"/></svg>',"Delivery":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>',"Tables":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/><path d="M3 16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z"/><path d="M5 18v2"/><path d="M19 18v2"/></svg>',"History":'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>'};function fill(){var btns=document.querySelectorAll('button');for(var i=0;i<btns.length;i++){var btn=btns[i];var direct=btn.querySelectorAll(':scope > span');if(direct.length<2)continue;var wrap=direct[0];var st=wrap.getAttribute('style')||'';if(st.indexOf('position:relative')<0&&st.indexOf('position: relative')<0)continue;var label=(direct[direct.length-1].textContent||'').trim();var g=IC[label];if(!g)continue;var slot=wrap.querySelector('span')||wrap;var active=false;try{active=getComputedStyle(btn).boxShadow!=='none';}catch(e){}slot.style.width='30px';slot.style.height='30px';slot.style.borderRadius='10px';slot.style.display='grid';slot.style.placeItems='center';slot.style.background=active?'var(--coralsoft)':'var(--sur)';if(!slot.querySelector('svg'))slot.innerHTML=g;}}var raf=0;function sched(){if(raf)return;raf=requestAnimationFrame(function(){raf=0;fill();});}function start(){fill();try{new MutationObserver(sched).observe(document.body,{childList:true,subtree:true});}catch(e){}}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){setTimeout(start,600);});else setTimeout(start,600);})();`
        : "";
      const inject = `\n<base href="${base}/">`
        /* Installable on a counter tablet, so the till has its own home-screen
           icon and standalone window instead of living in a browser tab that
           can be closed mid-service. Register only. */
        + (isRegister ? `\n<link rel="manifest" href="/app/app.webmanifest">` : "")
        + `${fixCss}\n<script>` +
        (withMenu ? `window.__ksMenu=${enc(menu)};` + pushSaleJs : "") +
        (isRegister ? `window.__ksReg=${enc(regData)};` : "") +
        (withAdmin ? `window.__ksAdmin=${enc(adminData)};` : "") +
        `window.__resources=Object.assign(window.__resources||{},${enc(resources)});` + NETERR_JS + A11Y_JS + UIFIX_JS + `${navIconsJs}${ordTabIconsJs}${adminIconsJs}</script>\n`;
      const html = readProto(file).replace(/<head([^>]*)>/i, (m) => m + inject);
      res.set("Content-Security-Policy", PROTO_CSP);
      res.set("Cache-Control", "no-cache");
      res.set("Content-Type", "text/html; charset=utf-8").send(html);
    });
  };
  /* /v2 — the ground-up rebuild, served ALONGSIDE the live /app (nothing here
     touches /app, /admin or the guest portal). Plain static, no injection: the
     new build is self-contained and reuses the already-served /app fonts. It is
     viewable on staging without disturbing anything in production use. */
  const proto3Dir = path.join(__dirname, "web3", "proto");
  if (fs.existsSync(path.join(proto3Dir, "index.html"))) {
    /* /v2 adopts the reference terminal UI (React), vendored locally — no CDN.
       It needs its own CSP: 'unsafe-eval' for the in-browser JSX compile
       (babel-standalone, no build step), inline scripts/styles for the dc
       template, blob/data images, and the self-hosted webfonts. This overrides
       the strict global CSP for the /v2 subtree only; /app, /admin and the
       guest portal are untouched. */
    const V2_CSP = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data: https://fonts.gstatic.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
      "connect-src 'self' blob: data:",
      "frame-ancestors 'none'",
    ].join("; ");
    app.use("/v2", (req, res, next) => { res.set("Content-Security-Policy", V2_CSP); next(); });
    app.use("/v2", express.static(proto3Dir, { index: false, redirect: false, maxAge: "5m" }));
    /* When a back-office/till cookie session is present, hydrate the reference
       terminal with the store's REAL data instead of the seeded demo set:
       window.KPOS_REAL carries the live menu, its categories, the outlet's real
       tax + service-charge + name, and an ops bearer token so the till can
       persist sales to /api/ops. kashikeyo-data.js consumes it (and falls back
       to seeds when absent, so the page still previews without a session). */
    const buildV2Real = async (req) => {
      const orgId = await resolveAppSession(req);
      if (!orgId) return null;
      const token = sign(orgId, req.appRegister || "R1", req.appStoreId || DEFAULT_STORE_ID);
      return buildV2RealForOrg(orgId, token, { role: req.appRole, name: req.appStaff && req.appStaff.name, id: req.appStaff && req.appStaff.id });
    };
    const buildV2RealForOrg = async (orgId, token, viewer) => {
      viewer = viewer || {};
      return await withOrg(orgId, async (c) => {
        const prodRows = (await c.query(
          "SELECT id, data FROM entities WHERE org_id=$1 AND kind='products' AND deleted=false", [orgId])).rows;
        const items = liveMenu(prodRows, true);   // include hidden dishes so Menu Master can manage + restore them
        const photo = {};
        for (const r of prodRows) {
          const im = r.data && r.data.img; if (!im) continue;
          photo[r.id] = /^https?:\/\//i.test(String(im)) ? String(im)
            : "/api/img/" + encodeURIComponent(r.id) + "?v=" + crypto.createHash("sha1").update(String(im)).digest("hex").slice(0, 12);
        }
        const catName = {};
        items.forEach((it) => { if (!catName[it.cat]) catName[it.cat] = it.sub || it.cat; });
        const menu = items.map((it) => ({ id: it.id, cat: it.cat, name: it.en, desc: it.desc || "",
          price: it.price, img: photo[it.id] || "", bestSeller: !!it.bestSeller, soldOut: !!it.soldOut, hidden: !!it.hidden,
          veg: !!it.veg, spice: Math.max(0, Math.min(3, Math.round(Number(it.spice) || 0))), heat: !!it.heat,
          addons: (it.mods || []).map((m) => ({ name: m.en, price: m.price })), recipe: [] }));
        const st = ((await c.query(
          "SELECT data FROM entities WHERE org_id=$1 AND kind='settings' AND id='settings' AND deleted=false LIMIT 1", [orgId])).rows[0] || {}).data || {};
        const categories = mergeCategories(catName, st);
        const gstBp = Number(st.gstBp) || 800, scBp = Number(st.svcChargeBp) || 0;
        // The store handle (orgs.slug) is the QR-portal address; the Branding
        // panel shows and edits it. orgs is system-scoped, so read it with withSystem.
        const orgRow = (await withSystem((sc) => sc.query("SELECT slug, email FROM orgs WHERE id=$1", [orgId]))).rows[0] || {};
        const slug = orgRow.slug || "";
        // Today's real trading, for the POS stats strip (net sales + covers).
        // Empty for a store that hasn't sold yet — the honest zero, not a seed.
        const salesRows = (await c.query(
          "SELECT data FROM entities WHERE org_id=$1 AND kind='sales' AND deleted=false", [orgId])).rows;
        const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
        const t0 = startOfDay.getTime();
        let net = 0, covers = 0;
        const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
        const m0 = monthStart.getTime();
        let netMonth = 0, gstMonth = 0, txMonth = 0;
        const pad2 = (n) => String(n).padStart(2, "0");
        // 14-day net-sales history for the analytics trend chart + week-on-week.
        // Bucketed by local calendar day; each bucket starts at 0 so a day with
        // no sales is an honest zero, not a gap.
        const DAYS = 14;
        const dayKeys = [], dayNet = {};
        for (let i = DAYS - 1; i >= 0; i--) {
          const dd = new Date(startOfDay.getTime() - i * 86400000);
          const key = dd.getFullYear() + "-" + pad2(dd.getMonth() + 1) + "-" + pad2(dd.getDate());
          dayKeys.push({ key, at: dd.getTime() }); dayNet[key] = 0;
        }
        const dayKeyOf = (ts) => { const dd = new Date(ts); return dd.getFullYear() + "-" + pad2(dd.getMonth() + 1) + "-" + pad2(dd.getDate()); };
        const chanMap = { v2: "dine_in", dine_in: "dine_in", qr: "qr", takeaway: "takeaway", delivery: "delivery" };
        // pid → display name, so a real sale's stored line items can carry the
        // dish name the receipt and menu-engineering report need.
        const nameById = {};
        menu.forEach((mm) => { nameById[String(mm.id)] = mm.name; });
        // Which sales already have a refund against them, and for how much. The
        // terminal reads this so a refunded ticket shows "Refunded" — and its
        // refund button is disabled — even after a reload, when the till's own
        // local refunds map is empty. A refund links by refundOf; the register
        // (/app) stores the original id there, the terminal stores the order no,
        // so we key the set on both and match an order by either.
        const refundedRefs = {};
        for (const r of salesRows) {
          const d = r.data || {};
          if (d.type === "refund" && d.refundOf) {
            const k = String(d.refundOf);
            refundedRefs[k] = (refundedRefs[k] || 0) + Math.abs(Number(d.total) || 0);
          }
        }
        const orders = [];
        for (const r of salesRows) {
          const d = r.data || {};
          if ((d.type && d.type !== "sale") || d.void) continue;
          const at = Number(d.at) || 0;
          if (at >= t0) { net += Number(d.total) || 0; covers += 1; }
          if (at >= m0) { netMonth += Number(d.total) || 0; gstMonth += Number(d.gst) || 0; txMonth += 1; }
          if (at) { const dk = dayKeyOf(at); if (dayNet[dk] != null) dayNet[dk] += Number(d.total) || 0; }
          const dt = at ? new Date(at) : null;
          // Real line detail: the sale entity persists lines[{pid,qty,price,amount}]
          // (all laari). Project them with the dish name so the terminal receipt
          // and analytics read real items instead of a header-only total.
          const lineItems = Array.isArray(d.lines) ? d.lines.map((l) => ({
            pid: l.pid != null ? l.pid : l.id, q: Number(l.qty) || 0,
            n: nameById[String(l.pid != null ? l.pid : l.id)] || l.name || "Item",
            price: Math.round((Number(l.price) || 0) / 100),
            amount: Math.round((Number(l.amount != null ? l.amount : (Number(l.price) || 0) * (Number(l.qty) || 0))) / 100),
          })) : [];
          orders.push({
            no: d.no || r.id, table: d.table != null ? "T" + pad2(d.table) : "—",
            channel: chanMap[d.channel] || "dine_in", total: Math.round((Number(d.total) || 0) / 100),
            tender: d.tender || "cash", status: d.open ? "open" : "closed", server: d.server || "",
            time: dt ? pad2(dt.getHours()) + ":" + pad2(dt.getMinutes()) : "", at: at,
            items: lineItems, subtotal: Math.round((Number(d.subtotal) || 0) / 100),
            svc: Math.round((Number(d.svcCharge) || 0) / 100), gst: Math.round((Number(d.gst) || 0) / 100),
            customerId: d.customerId || null, customerName: d.customerName || "",
            buyerName: d.buyerName || "", buyerTin: d.buyerTin || "", docType: d.docType || "",
            refunded: (refundedRefs[String(d.no || "")] || refundedRefs[String(r.id)] || 0) > 0,
            refundAmt: Math.round((refundedRefs[String(d.no || "")] || refundedRefs[String(r.id)] || 0) / 100),
          });
        }
        orders.sort((a, b) => b.at - a.at);
        // Live open orders (POS KOTs fired to the kitchen + QR/guest orders),
        // so the terminal's KDS and Orders board show real tickets across every
        // device instead of one screen's memory. Closed/paid/cancelled drop off.
        const ordEntRows = (await c.query(
          "SELECT data FROM entities WHERE org_id=$1 AND kind='orders' AND deleted=false ORDER BY COALESCE((data->>'createdAt')::numeric,(data->>'at')::numeric,0) DESC LIMIT 120", [orgId])).rows;
        const liveOrders = liveOrdersV2(ordEntRows.map((r) => r.data || {}));
        // Open guest calls (waiter / bill) so the floor shows them from load,
        // not only after the first live poll. A real guest posts these to the
        // server (/p/:slug/call); the demo localStorage bridge never reaches here.
        const liveCalls = (await c.query(
          "SELECT data FROM entities WHERE org_id=$1 AND kind='waiterCalls' AND deleted=false ORDER BY (data->>'t')::numeric DESC LIMIT 40", [orgId])).rows.map((r) => r.data || {});
        // Real customers → the reference CUSTOMERS shape (money laari→MVR).
        const custRows = (await c.query(
          "SELECT id, data FROM entities WHERE org_id=$1 AND kind='customers' AND deleted=false ORDER BY (data->>'lastOrderAt')::numeric DESC NULLS LAST LIMIT 500", [orgId])).rows;
        // Per-customer footprint the roster needs to gate deletion (three cheap
        // GROUP BYs, not a query per row): how many sales/orders reference them,
        // how many orders are still open, how many rewards are still pending.
        // customerId (guest/portal orders) and custId (till/reward links) both
        // point at a customer, so coalesce them.
        const custKey = "COALESCE(NULLIF(data->>'customerId',''),NULLIF(data->>'custId',''))";
        const rowsToMap = (rows) => { const m = {}; rows.forEach((r) => { if (r.cid) m[r.cid] = Number(r.n); }); return m; };
        const txnByCust = rowsToMap((await c.query(
          `SELECT ${custKey} AS cid, count(*)::int n FROM entities WHERE org_id=$1 AND kind IN ('sales','orders') AND deleted=false AND ${custKey} IS NOT NULL GROUP BY 1`, [orgId])).rows);
        const openByCust = rowsToMap((await c.query(
          `SELECT ${custKey} AS cid, count(*)::int n FROM entities WHERE org_id=$1 AND kind='orders' AND deleted=false AND ${custKey} IS NOT NULL AND lower(COALESCE(data->>'status','new')) NOT IN ('completed','settled','paid','closed','cancelled','void','refunded','declined') GROUP BY 1`, [orgId])).rows);
        const pendRwdByCust = rowsToMap((await c.query(
          `SELECT NULLIF(data->>'custId','') AS cid, count(*)::int n FROM entities WHERE org_id=$1 AND kind='rewardVouchers' AND deleted=false AND lower(COALESCE(data->>'state','pending'))='pending' AND NULLIF(data->>'custId','') IS NOT NULL GROUP BY 1`, [orgId])).rows);
        const tierOf = (pts) => pts >= 2000 ? "Platinum" : pts >= 1000 ? "Gold" : pts >= 300 ? "Silver" : "Bronze";
        const customers = custRows.map((r) => {
          const d = r.data || {}, pts = Number(d.points || d.loyaltyPoints || 0);
          const lastAt = Number(d.lastOrderAt || 0);
          const usedLaari = Number(d.balance || d.used || 0);
          const txns = txnByCust[r.id] || 0, openOrders = openByCust[r.id] || 0, pendingRewards = pendRwdByCust[r.id] || 0;
          return {
            id: r.id, name: d.name || "Guest", phone: d.phone || "", email: d.email || "",
            visits: Number(d.visits || d.orders || 0), spent: Math.round((Number(d.spent || d.totalSpent || 0)) / 100),
            points: pts, tier: d.tier || tierOf(pts),
            credit: Math.round((Number(d.creditLimit || d.credit || 0)) / 100),
            used: Math.round(usedLaari / 100),
            last: lastAt ? new Date(lastAt).toISOString().slice(0, 10) : "",
            portal: d.portal === true, hasEmail: !!(d.email && String(d.email).indexOf("@") > 0),
            // Deletion controls: whether the customer has any transaction history
            // (roster warns before removing), whether something is still pending
            // (roster keeps the record), and whether they've ever signed in to the
            // portal (resend-invite vs reset-access).
            txns, openOrders, pendingRewards,
            hasTxn: txns > 0 || Number(d.visits || 0) > 0 || Number(d.spent || 0) > 0,
            pending: usedLaari > 0 || openOrders > 0 || pendingRewards > 0,
            loggedIn: !!(d.portalLoginAt || d.portalLastLoginAt || d.lastLoginAt),
          };
        });
        // Real staff roster for the sign-in lock. The PIN itself NEVER leaves the
        // server — the terminal shows who works here and posts a typed PIN to
        // /api/app2/unlock, which verifies the hash server-side. (A 4-digit PIN
        // has only 10k pre-images, so shipping it — even hashed — would hand every
        // PIN to anyone who reads the page; the roster carries no `pin` field.)
        const userRows = (await c.query(
          "SELECT id, data FROM entities WHERE org_id=$1 AND kind='users' AND deleted=false", [orgId])).rows;
        const roleMap = { owner: "SuperAdmin", admin: "ChainAdmin", manager: "OutletManager",
          cashier: "Cashier", waiter: "Cashier", kitchen: "KitchenManager", kitchenmanager: "KitchenManager",
          storekeeper: "StoreKeeper", accountant: "Accountant" };
        const seenUser = {};
        const staff = userRows.map((r) => {
          const d = r.data || {}, nm = d.name || "Staff";
          let user = nm.toLowerCase().replace(/[^a-z0-9]+/g, "") || "staff";
          if (seenUser[user] != null) { seenUser[user]++; user += seenUser[user]; } else seenUser[user] = 0;
          return { id: r.id, name: nm, user: user, role: roleMap[String(d.role || "").toLowerCase()] || "Cashier",
            realRole: String(d.role || "").toLowerCase(), owner: String(d.role || "").toLowerCase() === "owner",
            outlet: null, outlets: [], status: d.suspended ? "Suspended" : "Active", last: "" };
        });
        // Real ingredient stock → the terminal's inventory views. The v2 uses a
        // positional demo schema (numeric ids, MVR-per-stock-unit); the real
        // ingredients table uses uuid ids and laari-per-base-unit weighted cost.
        // Bridge them: a stable 1-based id per ingredient, base→stock unit and
        // conversion factor by base_unit, and item[4] = avg_cost×factor/100 so
        // that item[4]×stockQty === avg_cost×current_stock/100 (the true value).
        const ingRows = (await c.query(
          "SELECT id, name, sku, base_unit, current_stock, min_stock, avg_cost, location FROM ingredients WHERE org_id=$1 AND active ORDER BY name", [orgId])).rows;
        const uMap = { g: ["GRM", "KG", 1000], gram: ["GRM", "KG", 1000], grm: ["GRM", "KG", 1000],
          kg: ["GRM", "KG", 1000], ml: ["ML", "LTR", 1000], l: ["ML", "LTR", 1000], ltr: ["ML", "LTR", 1000],
          pcs: ["PCS", "PCS", 1], pc: ["PCS", "PCS", 1], each: ["PCS", "PCS", 1] };
        const invItems = [], invRows = [], ingNumId = {};
        ingRows.forEach((g, i) => {
          const id = i + 1;
          ingNumId[g.id] = id;                                   // uuid → numeric id, reused by the ledger
          const u = uMap[String(g.base_unit || "").toLowerCase()] || ["PCS", "PCS", 1];
          const baseU = u[0], stockU = u[1], cf = u[2];
          const costPerStock = Math.round((Number(g.avg_cost) || 0) * cf / 100 * 100) / 100; // MVR/stock unit
          invItems.push([id, 1, g.name || "Item", stockU, costPerStock, "raw",
            g.sku || ("IT-" + String(id).padStart(4, "0")), baseU, stockU,
            Number(g.min_stock) || 0, 100, 0, 0, g.id]);   // [13] = the real ingredient uuid, for recipe writes
          invRows.push([3, id, Number(g.current_stock) || 0]);   // location = primary outlet, base units
        });
        const invCats = invItems.length ? [{ id: 1, name: "Ingredients", icon: "dry", storage: "daily", freq: "" }] : [];
        // Stock ledger: the immutable stock_moves, oldest→newest so each row's
        // running balance is correct, then reversed for a newest-first view. In
        // and out are base-unit magnitudes (the terminal converts for display).
        const moveRows = (await c.query(
          "SELECT ingredient_id, kind, qty, created_at FROM stock_moves WHERE org_id=$1 ORDER BY created_at ASC, id ASC", [orgId])).rows;
        const runBal = {}, ledgerAsc = [];
        for (const mv of moveRows) {
          const nid = ingNumId[mv.ingredient_id]; if (!nid) continue;
          const q = Number(mv.qty) || 0;
          runBal[mv.ingredient_id] = (runBal[mv.ingredient_id] || 0) + q;
          // [loc, item, kind, in, out, balance, tsMs] — ts is an extra trailing
          // field the ledger view ignores but analytics uses to scope waste.
          ledgerAsc.push([3, nid, mv.kind, q > 0 ? q : 0, q < 0 ? -q : 0, runBal[mv.ingredient_id],
            mv.created_at ? new Date(mv.created_at).getTime() : 0]);
        }
        const invLedger = ledgerAsc.reverse().slice(0, 140);
        // Recipes: recipe_lines(product_id → ingredient_id, qty per sold unit,
        // in base units). Map the component to its numeric inventory id and
        // attach [ingId, qty] lines to the matching menu item, so the terminal's
        // foodCost() and the Recipes & Costing view read real component cost.
        const recRows = (await c.query(
          "SELECT product_id, ingredient_id, qty FROM recipe_lines WHERE org_id=$1", [orgId])).rows;
        const recByProduct = {};
        for (const rl of recRows) {
          const nid = ingNumId[rl.ingredient_id]; if (!nid) continue;   // only real ingredient components
          (recByProduct[String(rl.product_id)] = recByProduct[String(rl.product_id)] || []).push([nid, Number(rl.qty) || 0]);
        }
        menu.forEach((it) => { it.recipe = recByProduct[String(it.id)] || []; });
        // Vendors (suppliers) and received GRNs (purchase_invoices). A stable
        // numeric vendor id links the two, matching the terminal's shape; money
        // is laari→MVR and every GRN attributes to the primary outlet (id 3).
        const supRows = (await c.query(
          "SELECT id, name, phone, email, notes, tin, terms, contact, address, lead_days FROM suppliers WHERE org_id=$1 AND active ORDER BY name", [orgId])).rows;
        const vendNumId = {};
        const invVendors = supRows.map((sup, i) => { vendNumId[sup.id] = i + 1; return {
          id: i + 1, sid: sup.id, name: sup.name || "Vendor", phone: sup.phone || "", email: sup.email || "",
          tin: sup.tin || "", terms: sup.terms || "", contact: sup.contact || "", address: sup.address || "",
          leadDays: Number(sup.lead_days) || 0, notes: sup.notes || "" }; });
        const grnRows = (await c.query(
          "SELECT id, supplier_id, invoice_no, total, received_at FROM purchase_invoices WHERE org_id=$1 ORDER BY received_at DESC LIMIT 200", [orgId])).rows;
        const invPurch = grnRows.map((g, i) => ({
          no: g.invoice_no || ("GRN-" + String(g.id).slice(-6).toUpperCase()),
          vendor: vendNumId[g.supplier_id] || 0, branch: 3,
          inv: g.invoice_no || "", total: Math.round((Number(g.total) || 0) / 100),
          status: "posted", by: "", notes: "",
        }));
        // Stock counts: real audit sessions with a line count and how many lines
        // flagged for review. The terminal renders one card per session.
        const auditRows = (await c.query(
          `SELECT s.id, s.label, s.status, s.started_at, s.closed_at, s.closing_value, s.cogs,
             (SELECT COUNT(*) FROM audit_lines l WHERE l.org_id=s.org_id AND l.session_id=s.id) AS lines,
             (SELECT COUNT(*) FROM audit_lines l WHERE l.org_id=s.org_id AND l.session_id=s.id AND l.flag='review') AS flagged
           FROM audit_sessions s WHERE s.org_id=$1 ORDER BY s.started_at DESC LIMIT 12`, [orgId])).rows;
        const invAudits = auditRows.map((a) => ({
          id: a.id, label: a.label || "Stock count", status: a.status,
          startedAt: a.started_at ? new Date(a.started_at).getTime() : 0,
          closedAt: a.closed_at ? new Date(a.closed_at).getTime() : 0,
          lines: Number(a.lines) || 0, flagged: Number(a.flagged) || 0,
          closing: Math.round((Number(a.closing_value) || 0) / 100),
          cogs: Math.round((Number(a.cogs) || 0) / 100),
        }));
        // Today's clock punches (time_entries) → the terminal's labour engine.
        // Persisted by clockIn/clockOut on the till; only today's shifts feed
        // the labour cost and prime-cost figures.
        const teRows = (await c.query(
          "SELECT id, data FROM entities WHERE org_id=$1 AND kind='time_entries' AND deleted=false", [orgId])).rows;
        const clock = teRows.map((r) => ({ ...(r.data || {}), id: r.id }))
          .filter((d) => (Number(d.in) || 0) >= t0)
          .map((d) => ({ id: d.id, staff: d.staffId, outlet: Number(d.outlet) || 3,
            in: Number(d.in) || 0, out: Number(d.out) || 0, late: Number(d.late) || 0 }));
        // Fixed-asset register — real equipment, money laari→MVR, dates as ISO
        // so the terminal's depreciation + service maths read them directly.
        const assetRows = (await c.query(
          "SELECT id, data FROM entities WHERE org_id=$1 AND kind='assets' AND deleted=false ORDER BY (data->>'bought')::numeric DESC NULLS LAST", [orgId])).rows;
        const assets = assetRows.filter((r) => !(r.data && r.data.disposedAt)).map((r) => { const d = r.data || {};
          const boughtIso = new Date(Number(d.bought) || Date.now()).toISOString().slice(0, 10);
          return { id: r.id, name: d.name || "Asset", kind: d.kind || "Cooking", outlet: Number(d.outlet) || 3,
            cost: Math.round((Number(d.cost) || 0) / 100), life: Number(d.life) || 8, bought: boughtIso,
            lastSvc: d.lastSvc || boughtIso, svcDays: Number(d.svcDays) || 90, status: d.status || "ok", ytd: Math.round((Number(d.ytd) || 0) / 100) }; });
        // Credit settlements (payments received against a customer tab) — for
        // the customer's credit statement on the till. Money laari→MVR.
        const setlRows = (await c.query(
          "SELECT id, data FROM entities WHERE org_id=$1 AND kind='settlements' AND deleted=false ORDER BY (data->>'t')::numeric DESC NULLS LAST LIMIT 300", [orgId])).rows;
        const settlements = setlRows.map((r) => { const d = r.data || {}; return {
          id: r.id, customerId: d.customerId || "", customerName: d.customerName || "",
          amount: Math.round((Number(d.amount) || 0) / 100), method: d.method || "cash",
          balanceAfter: Math.round((Number(d.balanceAfter) || 0) / 100), at: Number(d.t) || Number(d.at) || 0 }; });
        // Operating costs / expenses — real 'expenses' entities mapped to the
        // terminal's opex row shape (money laari→MVR). Recurring metadata
        // (freq/due/acct/outlet) rides on the entity when the cost form set it;
        // a plain spend defaults to a one-off monthly line on the general
        // expense account.
        const expRows = (await c.query(
          "SELECT id, data FROM entities WHERE org_id=$1 AND kind='expenses' AND deleted=false ORDER BY (data->>'t')::numeric DESC NULLS LAST LIMIT 200", [orgId])).rows;
        const expenses = expRows.map((r) => {
          const d = r.data || {}; const at = Number(d.t) || 0; const dd = at ? new Date(at) : null;
          return { id: r.id, cat: d.cat || "General", vendor: d.supplier || d.vendor || "—",
            outlet: Number(d.outlet) || 0, amt: Math.round((Number(d.amount) || 0) / 100),
            freq: d.freq === "annual" ? "annual" : "monthly", due: Number(d.due) || (dd ? dd.getDate() : 1),
            acct: d.acct || "6300", note: d.note || "", paidFrom: d.paidFrom || "other", at: at };
        });
        // Reservations booked from the guest portal (or the till) — the store's
        // real reservation entities, newest first. The till's Reservations inbox
        // approves/declines these and the floor reflects confirmed ones. Cancelled
        // and past declined rows are dropped from the projection.
        const resvRows = (await c.query(
          "SELECT id, data FROM entities WHERE org_id=$1 AND kind='reservations' AND deleted=false ORDER BY (data->>'t')::numeric DESC NULLS LAST LIMIT 100", [orgId])).rows;
        const reservations = resvRows.map((r) => {
          const d = r.data || {};
          return { id: r.id, status: d.status || "pending", source: d.source || "portal",
            name: d.name || "Guest", phone: d.phone || "", party: Number(d.party) || 2,
            time: d.time || "", date: d.date || "", note: d.note || "", table: d.table || "",
            custId: d.custId || null, at: Number(d.t) || 0 };
        }).filter((r) => r.status !== "declined" && r.status !== "cancelled");
        // Real outlets — the org's own stores (a company can run several).
        // The primary/first store keeps outlet id 3, which is the terminal's
        // default outletId and the id the POS stat couplings key off, so the
        // whole ticket/floor engine works unchanged; further stores get their
        // own ids. Tax/service-charge come from settings; seats/tables are a
        // sensible default until per-store layout config exists.
        const storeRows = (await c.query(
          "SELECT id, code, name, address FROM stores WHERE org_id=$1 AND active ORDER BY created_at", [orgId])).rows;
        const tax = gstBp >= 1600 ? "TGST" : "GGST", rate = Math.round(gstBp / 100), sc = Math.round(scBp / 100);
        const outlets = storeRows.map((sr, i) => ({
          id: i === 0 ? 3 : 20 + i, storeId: sr.id, code: sr.code || ("OUT-" + (i + 1)),
          name: sr.name || st.storeName || "Outlet", type: "restaurant", loc: "restaurant", parent: 0,
          region: "", tax: tax, rate: rate, sc: sc, addr: sr.address || "", mgr: "",
          pos: true, seats: 48, tables: 12,
        }));
        // Fiscal identity for a MIRA-compliant tax invoice — the registered
        // taxpayer's TIN, GST registration number, legal name and address, from
        // the store's own settings. Empty strings until the owner fills them in
        // (in Settings), never a demo placeholder, so the receipt never prints a
        // fake TIN.
        const fiscalAddr = [st.address, st.island, st.atoll].filter(Boolean).join(", ");
        // The store's branded portal address — the same link the QR encodes, so
        // the terminal shows a URL that carries the store's own handle
        // (<handle>.<domain> once subdomains are live, else <origin>/?s=<handle>),
        // never a generic "order.*" demo host. `base` empty = use the page origin.
        const portalSubBase = PORTAL_BASE_DOMAINS.length && slug ? ("https://" + slug + "." + PORTAL_BASE_DOMAINS[0]) : "";
        const portalBase = portalSubBase || process.env.PUBLIC_ORIGIN || "";
        return {
          hasSession: true, token, slug,
          // The signed-in operator, so the terminal can scope a cashier/waiter to
          // their permission set. Absent role = the owner's own (password) login.
          me: { id: viewer.id || "", roleKey: String(viewer.role || "owner").toLowerCase(), name: viewer.name || "", isOwner: !viewer.role || viewer.role === "owner" },
          portal: { slug, base: portalBase, sub: !!portalSubBase },
          outlet: { name: st.storeName || "My Store", tax: tax, rate: rate, sc: sc,
            currency: st.currency === "USD" ? "USD" : "MVR", addr: fiscalAddr },
          fiscal: { tin: st.tin || "", gstNo: st.gstRegNo || "", legalName: st.legalName || "",
            address: fiscalAddr, storeName: st.storeName || "", phone: st.phone || "" },
          // Storefront branding the terminal's Branding panel edits and the guest
          // portal renders — logo, tagline, accent, footer, white-label + the
          // store handle (the QR-portal slug).
          brand: { name: st.storeName || "", logo: st.logo || "", tagline: st.tagline || "",
            accent: st.accent || "", footer: st.receiptFooter || st.footer || "",
            whiteLabel: !!st.whiteLabel, handle: slug },
          // Business profile chosen at onboarding (editable in Settings). Drives
          // which modules the terminal shows: a non-F&B activity hides the
          // kitchen/menu screens that would only ever be empty for it.
          profile: { businessType: st.businessType || "", businessActivity: st.businessActivity || "" },
          email: orgRow.email || "",
          // Loyalty config the rewards-portal reads (earn rate, tiers, reward
          // catalogue), so the terminal's Loyalty editor shows and edits the live
          // values. loyaltyConfig() supplies documented defaults until a merchant sets them.
          loyalty: (function (L) { return { pointsPer: L.pointsPer, redeemPer: L.redeemPer, tiers: L.tiers, rewards: L.rewards }; })(loyaltyConfig(st)),
          // Promotions the merchant edits + the guest surfaces show (handoff 08 §1).
          promos: { on: !!st.qrBanners, items: Array.isArray(st.banners) ? st.banners : [] },
          outlets: outlets.length ? outlets : null,
          categories, groups: menuGroupsOf(categories), groupPalette: menuGroupPalette(categories), menu, stats: { net: net, covers: covers, netMonth: netMonth, gstMonth: gstMonth, txMonth: txMonth,
            daily: dayKeys.map((dk) => ({ at: dk.at, net: Math.round(dayNet[dk.key] / 100) })) },
          orders: orders.slice(0, 200), liveOrders, calls: liveCalls, customers, staff, clock, reservations, expenses, settlements, assets,
          inventory: { items: invItems, inv: invRows, cats: invCats, ledger: invLedger, vendors: invVendors, purch: invPurch, audits: invAudits },
        };
      });
    };
    app.get(/^\/v2(\/.*)?$/, async (req, res) => {
      res.set("Content-Security-Policy", V2_CSP);
      // The terminal HTML is per-session (it carries this store's injected
      // KPOS_REAL) and references the per-deploy ?v= asset bundle. A bare
      // `no-cache` lets Cloudflare hold a copy and serve it without revalidating
      // to origin, so after a deploy a till kept running the OLD bundle ("nothing
      // changed") — and one store's injected data could be served to another at a
      // shared edge. Match the guest/member pages: no-store at every layer, and a
      // CDN directive + Vary:Host so the edge never caches or cross-serves it.
      res.set("Cache-Control", "no-store, no-cache, must-revalidate");
      res.set("CDN-Cache-Control", "no-store");
      res.set("Vary", "Cookie, Host");
      let inject = "";
      try {
        const real = await buildV2Real(req);
        if (real) inject = "\n<script>window.KPOS_REAL=" +
          JSON.stringify(real).replace(/</g, "\\u003c") + ";window.KPOS_BUILD=" +
          JSON.stringify(ASSET_VER) + ";</script>";
      } catch (e) { recordError("v2 hydrate", e); }
      let html = fs.readFileSync(path.join(proto3Dir, "index.html"), "utf8");
      if (inject) html = html.replace('<base href="/v2/">', '<base href="/v2/">' + inject);
      html = bustV2Assets(html);   // per-deploy ?v= so the terminal never runs a stale cached bundle
      res.set("Content-Type", "text/html; charset=utf-8").send(html);
    });

    /* Fresh inventory block for the v2 terminal's Supply-chain panel, so a write
       (new item, GRN, count, adjustment, transfer, produce, recipe) can re-pull
       real data without a full page reload. Returns the SAME shape the page
       inject ships as window.KPOS_REAL.inventory. */
    app.get("/api/app2/inventory", async (req, res) => {
      try {
        const real = await buildV2Real(req);
        if (!real) return res.status(401).json({ error: "no session" });
        res.json({ ok: true, inventory: real.inventory || {} });
      } catch (e) { recordError("app2 inventory", e); res.status(500).json({ error: "inventory unavailable" }); }
    });

    /* The customer-facing guest/QR storefront (web3/proto/guest.html) is served
       by serveGuestV3 at the live /?s= + subdomain entry (see serveGuestPortal).
       The old /vg preview route is retired now that those render the same page. */

    /* V2_SELFTEST=1 — a boot-time verification that the /v2 real-data injection
       works against the deployment's OWN Postgres, logged to the deploy log
       (the environment can't be reached over HTTP from every network). Builds
       KPOS_REAL for the first org that has a store, using the exact route code,
       and logs COUNTS only — never PINs or customer detail. */
    if (process.env.V2_SELFTEST) {
      setTimeout(async () => {
        try {
          const org = await withSystem((c) => c.query(
            "SELECT o.id, o.store_name FROM orgs o WHERE EXISTS (SELECT 1 FROM stores s WHERE s.org_id=o.id) ORDER BY o.created_at LIMIT 1").then((r) => r.rows[0]));
          if (!org) { console.log("V2 self-test: no org with a store"); return; }
          const r = await buildV2RealForOrg(org.id, "selftest");
          console.log("V2 self-test:", JSON.stringify({
            org: org.store_name || String(org.id).slice(0, 8),
            outlets: (r.outlets || []).length, outletNames: (r.outlets || []).map((o) => o.name),
            menuItems: (r.menu || []).length, categories: (r.categories || []).map((c) => c.name),
            customers: (r.customers || []).length, staff: (r.staff || []).length,
            ordersLoaded: (r.orders || []).length, stats: r.stats,
            tax: r.outlet ? r.outlet.tax + " " + r.outlet.rate + "%" : null,
          }));
        } catch (e) { console.log("V2 self-test error:", (e && e.message) || e); }
      }, 5000);
    }
  }
  serveProto({ base: "/app", file: "index.html", withMenu: true });   // Register / till (canonical URL)
  // Legacy /app2 links (old redirects, bookmarks, installed PWAs) → the /app URL.
  app.get(/^\/app2(\/.*)?$/, (req, res) => res.redirect(301, "/app"));
  if (fs.existsSync(path.join(protoDir, "admin.html"))) {
    serveProto({ base: "/admin", file: "admin.html", withMenu: true, withAdmin: true, minRank: APP_RANK.MANAGER }); // Back-office cockpit (canonical URL)
    // Legacy /admin2 links (old redirects, bookmarks) → the /admin URL.
    app.get(/^\/admin2(\/.*)?$/, (req, res) => res.redirect(301, "/admin"));
  }
  /* Product tile images served as their own cacheable responses (see menuImg
     above). The register HTML references /api/img/<id>?v=<hash>; each hit decodes
     the product's stored data-URI once and serves it immutable, so photos download
     a single time and are reused on every later load instead of re-shipping ~450KB
     of base64 in the page. Cookie-scoped to the caller's org via RLS. */
  // Accept optional media-type parameters (e.g. `;utf8`, `;charset=utf-8`) before
  // the base64 flag — the AI menu builder stores its SVG art as
  // `data:image/svg+xml;utf8,…`, which the stricter form rejected (blank tile).
  const DATA_URI_RE = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w.+=-]+)*?(;base64)?,([\s\S]*)$/;
  app.get("/api/img/:id", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).end();
    const row = await withOrg(orgId, (c) => c.query(
      "SELECT data FROM entities WHERE org_id=$1 AND kind='products' AND id=$2 AND deleted=false LIMIT 1",
      [orgId, String(req.params.id || "")]));
    const im = row.rows[0] && row.rows[0].data && row.rows[0].data.img;
    const m = im && String(im).match(DATA_URI_RE);
    if (!m) return res.status(404).end();
    const etag = '"' + crypto.createHash("sha1").update(String(im)).digest("hex").slice(0, 16) + '"';
    if (req.headers["if-none-match"] === etag) return res.status(304).end();
    const body = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
    res.set("Content-Type", m[1] || "application/octet-stream");
    res.set("Cache-Control", "private, max-age=31536000, immutable");
    res.set("ETag", etag);
    res.send(body);
  }));
  // Live refresh for the register: the same window.__ksReg payload as a JSON
  // poll, so /app2's Kitchen/Delivery/History reflect new orders without a full
  // reload. Cookie-authed (same session as the page); no ops token needed.
  app.get("/api/app2/pull", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    const data = await withOrg(orgId, async (c) => {
      const d = await collectRegData(c, orgId, req.appRegister, req.appStoreId);
      // Live menu so add-on/price/hide/86/item edits from /admin2 reach an
      // already-open register without a reload.
      d.menu = liveMenu((await c.query(
        "SELECT id, data FROM entities WHERE org_id=$1 AND kind='products' AND deleted=false", [orgId])).rows, true);
      return d;
    });
    /* Every terminal pulled the FULL snapshot every five seconds — 186 KB of
       it, most of it the unchanged catalogue — and then JSON.stringify'd the
       whole thing twice to decide nothing had changed. At six terminals that is
       roughly 1.4 MB a minute per outlet, often on mobile data. The payload is
       still computed (cheap now that it is indexed), but an unchanged one goes
       back as a bodiless 304. */
    const body = JSON.stringify(data);
    const etag = '"' + crypto.createHash("sha1").update(body).digest("base64").slice(0, 22) + '"';
    res.set("Cache-Control", "no-store");
    res.set("ETag", etag);
    if (String(req.get("If-None-Match") || "") === etag) return res.status(304).end();
    res.type("application/json").send(body);
  }));
  /* Till lock: verify a staff PIN server-side.
     The register used to compare the typed PIN against a hash embedded in the
     page, which meant every device carried every staff member's (and the
     owner's) recoverable PIN. Now the PIN is checked here, throttled like any
     other credential, and the caller gets back a short-lived signed handle it
     can present on reload instead of storing anything secret. */
  app.post("/api/app2/unlock", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    const body = req.body || {};
    /* Restore path: a previously issued handle, no PIN re-entry. */
    if (body.token) {
      try {
        const p = jwt.verify(String(body.token), SECRET);
        if (p && p.k === "till" && p.o === orgId) {
          const row = await withOrg(orgId, (c) => c.query(
            "SELECT id, data FROM entities WHERE org_id=$1 AND kind='users' AND id=$2 AND deleted=false", [orgId, String(p.u)]));
          if (row.rowCount) {
            const d = row.rows[0].data || {};
            return res.json({ ok: true, user: { id: row.rows[0].id, name: d.name || "Staff", role: d.role || "cashier" }, token: String(body.token) });
          }
        }
      } catch { /* fall through to a plain rejection */ }
      return res.status(401).json({ error: "session expired — enter your PIN" });
    }
    const keys = rlKeys(req, "till:" + orgId + ":" + String(body.userId || ""));
    const blocked = rlBlockedFor(keys);
    if (blocked) return rlDeny(res, blocked);
    const row = await withOrg(orgId, (c) => c.query(
      "SELECT id, data FROM entities WHERE org_id=$1 AND kind='users' AND id=$2 AND deleted=false", [orgId, String(body.userId || "")]));
    const d = row.rowCount ? (row.rows[0].data || {}) : null;
    if (!d || !d.pin || hashTillPin(String(body.pin || "")) !== String(d.pin)) {
      rlFail(keys);
      return res.status(401).json({ error: "wrong PIN" });
    }
    rlClear(keys);
    const token = jwt.sign({ k: "till", o: orgId, u: row.rows[0].id }, SECRET, { expiresIn: "30d" });
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, user: { id: row.rows[0].id, name: d.name || "Staff", role: d.role || "cashier" }, token });
  }));

  /* Live open orders for the /v2 terminal's KDS and Orders board — polled a few
     seconds apart so a KOT fired on the till appears on the kitchen screen (a
     different device) and status changes propagate both ways. Same projection
     the page inject uses, so the poll and the first paint agree. */
  app.get("/api/app2/live", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    maybeRecomputePopularity(orgId);   // keep usage ranking fresh for open terminals (throttled)
    const { rows, calls } = await withOrg(orgId, async (c) => {
      const rows = (await c.query(
        "SELECT data FROM entities WHERE org_id=$1 AND kind='orders' AND deleted=false ORDER BY COALESCE((data->>'createdAt')::numeric,(data->>'at')::numeric,0) DESC LIMIT 120", [orgId])).rows;
      const calls = (await c.query(
        "SELECT data FROM entities WHERE org_id=$1 AND kind='waiterCalls' AND deleted=false ORDER BY (data->>'t')::numeric DESC LIMIT 40", [orgId])).rows.map((r) => r.data || {});
      return { rows, calls };
    });
    res.set("Cache-Control", "no-store");
    // Stamp the running build so an already-open terminal notices a new deploy
    // and refreshes itself (see maybeReloadForUpdate on the client).
    res.json({ ok: true, build: ASSET_VER, orders: liveOrdersV2(rows.map((r) => r.data || {})), calls });
  }));
  // Acknowledge a guest call (waiter / bill): clears it from the floor on every
  // device by soft-deleting the waiterCalls entity. (Stale calls also auto-expire
  // via the timed-kinds sweep.)
  /* Invite customers to the rewards portal — by EMAIL (there is no SMS gateway).
     Emails a branded sign-in link to each selected customer that has an email,
     and marks portal=true. Reports how many were emailed and how many were
     skipped for having no email on file, so the till can tell the operator to add
     one. Members sign in / self-join with that same address. */
  app.post("/api/app2/portal/invite", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    const ids = Array.isArray((req.body || {}).ids) ? (req.body.ids).map(String).slice(0, 500) : [];
    if (!ids.length) return res.status(400).json({ error: "no customers selected" });
    // invite (default) = first send · resend = nudge someone who never opened it ·
    // reset = walk an existing member back in (both re-use the same OTP door).
    const mode = ["invite", "resend", "reset"].indexOf(String((req.body || {}).mode || "")) >= 0 ? String(req.body.mode) : "invite";
    const o = (await withSystem((c) => c.query("SELECT slug, store_name FROM orgs WHERE id=$1", [orgId]))).rows[0] || {};
    const base = portalOriginForSlug(o.slug, req);
    const link = PORTAL_BASE_DOMAINS.length ? (base + "/m") : (base + "/m?s=" + encodeURIComponent(o.slug || ""));
    const storeId = cleanStoreId((req.body || {}).storeId || DEFAULT_STORE_ID);
    const custs = await kindAll(orgId, "customers", storeId);
    const targets = custs.filter((c) => ids.indexOf(String(c.id)) >= 0 && c.email && String(c.email).indexOf("@") > 0);
    const brand = o.store_name || "Kashikeyo";
    const subject = mode === "reset" ? (brand + " Rewards — sign back in")
      : mode === "resend" ? (brand + " Rewards — your card is waiting")
      : (brand + " Rewards — you're invited");
    let invited = 0;
    for (const c of targets) {
      const mail = await sendEmail({ to: c.email, subject,
        html: portalInviteEmailHtml(brand, link, mode), text: "Open your " + brand + " Rewards card: " + link });
      // Only mark them invited (portal=true) when the email actually went out, so
      // the flag never claims an invitation the customer never received.
      if (mail.ok) {
        invited++;
        const rv = await withOrg(orgId, (cl) => cl.query("UPDATE entities SET data = data || jsonb_build_object('portal',true), rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='customers' AND id=$2 RETURNING rowver", [orgId, String(c.id)]));
        if (rv.rowCount) poke(orgId, Number(rv.rows[0].rowver));
      }
    }
    res.json({ ok: true, requested: ids.length, invited, skippedNoEmail: ids.length - targets.length, configured: emailConfigured() });
  }));

  app.post("/api/app2/call/:id/ack", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    /* AUDIT-S2: this can redeem a pending reward voucher and deduct real
       customer loyalty points — the sibling /call/:id/coming gates on rank,
       this one didn't. */
    if (denyAppRole(req, res, APP_RANK.TILL, "Only till staff can acknowledge a call.")) return;
    const id = String(req.params.id || "");
    const rowver = await withOrg(orgId, async (c) => {
      // Clearing a `reward` signal is the cashier honouring the voucher: mark it
      // redeemed and deduct the real points now (the phone only posted intent;
      // the till moves the balance). Idempotent — a voucher already redeemed is
      // left alone, so a double-tap can't deduct twice.
      const cr = await c.query("SELECT data FROM entities WHERE org_id=$1 AND kind='waiterCalls' AND id=$2 AND deleted=false", [orgId, id]);
      if (!cr.rowCount) return null;
      const call = cr.rows[0].data || {};
      let rv = 0;
      if (call.kind === "reward" && call.voucherId && call.custId) {
        const vr = await c.query("SELECT data FROM entities WHERE org_id=$1 AND kind='rewardVouchers' AND id=$2 AND deleted=false", [orgId, String(call.voucherId)]);
        if (vr.rowCount && String((vr.rows[0].data || {}).state) === "pending") {
          const cost = Math.max(0, Number((vr.rows[0].data || {}).cost) || 0);
          const uv = await c.query("UPDATE entities SET data = data || jsonb_build_object('state','redeemed','redeemedAt',$3::bigint), rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='rewardVouchers' AND id=$2 AND (data->>'state')='pending' RETURNING rowver", [orgId, String(call.voucherId), Date.now()]);
          if (uv.rowCount) {
            rv = Math.max(rv, Number(uv.rows[0].rowver));
            const uc = await c.query("UPDATE entities SET data = data || jsonb_build_object('points', GREATEST(0, COALESCE((data->>'points')::numeric,0) - $3)), rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='customers' AND id=$2 RETURNING rowver", [orgId, String(call.custId), cost]);
            if (uc.rowCount) rv = Math.max(rv, Number(uc.rows[0].rowver));
          }
        }
      }
      const r = await c.query(
        "UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='waiterCalls' AND id=$2 AND deleted=false RETURNING rowver", [orgId, id]);
      if (r.rowCount) rv = Math.max(rv, Number(r.rows[0].rowver));
      return rv || null;
    });
    if (rowver == null) return res.status(404).json({ error: "call not found" });
    poke(orgId, rowver);
    res.json({ ok: true });
  }));

  // Acknowledge a floor call WITHOUT clearing it — the cashier taps "On my way"
  // so the guest's portal shows a server is coming. Unlike /ack (which redeems +
  // soft-deletes), this leaves the call on the floor until it's actually served,
  // and just stamps `acked`/`ackedAt` so the flag can reach the portal feed.
  app.post("/api/app2/call/:id/coming", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.TILL, "Only till staff can respond to a call.")) return;
    const id = String(req.params.id || "");
    const on = (req.body || {}).ack !== false;
    const rowver = await withOrg(orgId, async (c) => {
      const r = await c.query(
        "UPDATE entities SET data = data || jsonb_build_object('acked',$3::boolean,'ackedAt',$4::bigint), rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='waiterCalls' AND id=$2 AND deleted=false RETURNING rowver",
        [orgId, id, on, on ? Date.now() : null]);
      return r.rowCount ? Number(r.rows[0].rowver) : null;
    });
    if (rowver == null) return res.status(404).json({ error: "call not found" });
    poke(orgId, rowver);
    res.json({ ok: true });
  }));

  /* Kitchen tickets from the register (audit C-H5). sendKot wrote LOCAL STATE
     ONLY: a POS kitchen ticket never reached the server, so a second kitchen
     display never saw it, a refresh lost it, and bumping it on screen A did not
     clear it on screen B. Only QR orders drove real state. A POS ticket is now
     an order like any other, and bumping it uses the same status endpoint. */
  app.post("/api/app2/kot", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    const b = req.body || {};
    const items = Array.isArray(b.items) ? b.items.slice(0, 200) : [];
    if (!items.length) return res.status(400).json({ error: "no items" });
    const id = "kot-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const data = {
      id, no: "KOT-" + String(b.billNo || "").padStart(4, "0"), source: "pos",
      billId: String(b.billId || "").slice(0, 60),
      status: "new", otype: asOtype(b.otype).slice(0, 12),
      table: String(b.table || "").slice(0, 20),
      station: String(b.station || "hot").slice(0, 20),
      createdAt: Date.now(), t: Date.now(), at: Date.now(),
      storeId: req.appStoreId || DEFAULT_STORE_ID, register: req.appRegister,
      userName: String(b.userName || "").slice(0, 60),
      items: items.map((it) => ({ pid: String(it.pid || "").slice(0, 60), name: String(it.name || it.n || "Item").slice(0, 80),
        qty: Number(it.qty || it.q) || 1, price: Math.round(Number(it.price) || 0), station: String(it.station || "").slice(0, 20) })),
    };
    const rowver = await withOrg(orgId, async (c) => {
      const r = await c.query(
        "INSERT INTO entities (org_id, kind, id, data, deleted, updated_at) VALUES ($1,'orders',$2,$3,false,now()) RETURNING rowver",
        [orgId, id, JSON.stringify(data)]);
      return Number(r.rows[0].rowver);
    });
    poke(orgId, rowver);
    res.json({ ok: true, id, no: data.no });
  }));

  /* Outlet selection for the register (audit A-H2). The register never chose a
     store: the ops token defaulted to 'main' and every op stamped storeId
     'main', so a two-outlet owner's Hulhumale branch booked its sales under
     Male. The per-outlet dashboard showed the new branch at MVR 0 forever while
     Male's numbers were inflated. /api/select-store existed and re-issued a
     bearer token, but the page is cookie-authed and nothing called it — the
     multi-store architecture was complete on the server and unreachable from
     the client. Switching re-mints the session cookie for the chosen outlet,
     which is what every later op, receipt block and report keys off. */
  app.get("/api/app2/outlets", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    const rows = await withOrg(orgId, (c) => c.query(
      "SELECT id, name, code FROM stores WHERE org_id=$1 AND active=true ORDER BY created_at ASC", [orgId]));
    res.set("Cache-Control", "no-store");
    res.json({ current: req.appStoreId || DEFAULT_STORE_ID, outlets: rows.rows.map((r) => ({ id: r.id, name: r.name || r.id, code: r.code || "" })) });
  }));
  /* AUDIT-Q4: none of the three UIs reported a client-side exception anywhere
     — a crash mid-shift on an unattended till was invisible to the operator
     AND to the business until someone noticed the register frozen. This is
     the landing spot the till/admin/v2 error handlers below POST to;
     best-effort only (an error report is not money — losing one during an
     outage is fine, unlike a sale) and folds into the SAME bounded
     recentErrors buffer /api/dev/health already surfaces, so this adds no
     new state or storage. */
  app.post("/api/app2/client-error", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).end();
    const b = req.body || {};
    const where = String(b.where || "client").slice(0, 60);
    const message = String(b.message || "").slice(0, 500);
    recordError(`client:${where} · org ${orgId} · ${(req.appStaff && req.appStaff.name) || req.appRole || ""}`, new Error(message || "(no message)"));
    res.status(204).end();
  }));
  app.post("/api/app2/outlet", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    const want = cleanStoreId((req.body || {}).storeId || DEFAULT_STORE_ID);
    const hit = await withOrg(orgId, (c) => c.query(
      "SELECT id, name FROM stores WHERE org_id=$1 AND id=$2 AND active=true", [orgId, want]));
    if (!hit.rowCount) return res.status(404).json({ error: "unknown outlet" });
    const token = sign(orgId, req.appRegister, want, { role: req.appRole, staff: req.appStaff || undefined });
    setAppCookieTracked(req, res, token, { orgId, role: req.appRole, register: req.appRegister,
      name: (req.appStaff && req.appStaff.name) || "", staffId: (req.appStaff && req.appStaff.id) || "" });
    logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "", action: "outlet.switch", ref: want, requestId: req.id, detail: {} });
    res.json({ ok: true, storeId: want, name: hit.rows[0].name || want });
  }));

  /* Day End (audit B-H5). "Close day & post journal" set a local flag and
     toasted "Posted · JE-2026-0189" — a hardcoded reference presented to the
     operator as a real journal number. Nothing was posted, no Z-report was
     stored, and the drawer variance was computed, displayed, shared, and then
     discarded, so yesterday's Z could never be reproduced and a cash
     over/short had no home. The day is now closed on the server, which
     recomputes the figures itself rather than trusting the screen, and issues
     a real sequential journal reference. */
  app.post("/api/app2/dayend", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.MANAGER, "Closing the day needs a manager or the owner.")) return;
    const counted = Math.max(0, Math.round(Number((req.body || {}).counted) || 0));
    const float = Math.max(0, Math.round(Number((req.body || {}).float) || 0));
    const storeId = req.appStoreId || DEFAULT_STORE_ID;
    const sod = new Date(); sod.setHours(0, 0, 0, 0);
    const out = await withOrg(orgId, async (c) => {
      const already = await c.query(
        "SELECT id FROM entities WHERE org_id=$1 AND kind='dayend' AND deleted=false AND COALESCE(data->>'storeId',$2)=$2 AND (data->>'sod')::numeric = $3",
        [orgId, storeId, sod.getTime()]);
      if (already.rowCount) return { dup: true, id: already.rows[0].id };
      const rows = (await c.query(
        `SELECT data FROM entities WHERE org_id=$1 AND kind='sales' AND deleted=false
           AND COALESCE(data->>'storeId',$2)=$2
           AND COALESCE((data->>'t')::numeric,(data->>'at')::numeric,(data->>'createdAt')::numeric,0) >= $3`,
        [orgId, storeId, sod.getTime()])).rows.map((r) => r.data || {});
      const z = { gross: 0, gst: 0, svc: 0, cash: 0, card: 0, transfer: 0, tab: 0, orders: 0, refunds: 0, refundCount: 0 };
      for (const s2 of rows) {
        if (s2.foc) continue;
        if (s2.type === "refund") { z.refunds += Math.abs(Number(s2.total) || 0); z.refundCount++; } else z.orders++;
        z.gross += Number(s2.total) || 0; z.gst += Number(s2.gst) || 0; z.svc += Number(s2.svcCharge) || 0;
        const pays = (Array.isArray(s2.payments) && s2.payments.length) ? s2.payments : [{ method: s2.method || "cash", amount: Number(s2.total) || 0 }];
        for (const p of pays) {
          const amt = Number(p.amount) || 0, m = String(p.method || "cash").toLowerCase();
          if (m === "cash") z.cash += amt; else if (m === "card") z.card += amt;
          else if (m === "tab" || m === "ontab") z.tab += amt; else z.transfer += amt;
        }
      }
      /* Real cost of sales, from the stock ledger (audit B-J3). The day-end
         journal has always been short a COGS line and its inventory credit,
         and a previous sweep removed a FABRICATED one — rightly. But the real
         figure is right there: inventory.processSales writes a signed
         stock_moves row per sale with the weighted unit_cost. Sum it. */
      const cogsR = (await c.query(
        `SELECT COALESCE(-SUM(qty*unit_cost),0) AS c FROM stock_moves
           WHERE org_id=$1 AND kind='sale' AND (EXTRACT(EPOCH FROM created_at)*1000) >= $2`,
        [orgId, sod.getTime()])).rows[0];
      const cogs = Math.round(Number(cogsR.c) || 0);
      const settles = (await c.query(
        `SELECT data FROM entities WHERE org_id=$1 AND kind='settlements' AND deleted=false
           AND COALESCE(data->>'storeId',$2)=$2
           AND COALESCE((data->>'t')::numeric,(data->>'at')::numeric,(data->>'createdAt')::numeric,0) >= $3`,
        [orgId, storeId, sod.getTime()])).rows.map((r) => r.data || {});
      let cashSettled = 0, settled = 0;
      for (const st of settles) { settled += Number(st.amount) || 0; if (/^cash$/i.test(String(st.method || "cash"))) cashSettled += Number(st.amount) || 0; }
      const expected = float + z.cash + cashSettled;
      const variance = counted - expected;
      /* A real, sequential journal reference — the old one was a string
         literal. Numbered per calendar year, per org. */
      const yr = new Date().getFullYear();
      const nseq = await c.query(
        "SELECT count(*)::int AS n FROM entities WHERE org_id=$1 AND kind='dayend' AND deleted=false AND (data->>'year')::int = $2", [orgId, yr]);
      const jref = "JE-" + yr + "-" + String((Number(nseq.rows[0].n) || 0) + 1).padStart(4, "0");
      const id = "de-" + sod.getTime() + "-" + storeId;
      const data = {
        id, storeId, sod: sod.getTime(), year: yr, journalRef: jref, closedAt: Date.now(),
        closedBy: String((req.body || {}).staffName || (req.appStaff && req.appStaff.name) || "").slice(0, 60),
        float, counted, expected, variance, cashSettled, settled,
        gross: Math.round(z.gross), gst: Math.round(z.gst), svc: Math.round(z.svc),
        cash: Math.round(z.cash), card: Math.round(z.card), transfer: Math.round(z.transfer), tab: Math.round(z.tab),
        orders: z.orders, refunds: Math.round(z.refunds), refundCount: z.refundCount,
        revenue: Math.round(z.gross - z.gst - z.svc), cogs,
        t: Date.now(), at: Date.now(),
      };
      const r = await c.query(
        "INSERT INTO entities (org_id, kind, id, data, deleted, updated_at) VALUES ($1,'dayend',$2,$3,false,now()) RETURNING rowver",
        [orgId, id, JSON.stringify(data)]);
      return { rowver: Number(r.rows[0].rowver), data };
    });
    if (out.dup) return res.status(409).json({ error: "The day is already closed.", id: out.id });
    poke(orgId, out.rowver);
    logActivity(orgId, { actor: out.data.closedBy || "manager", action: "day.close", ref: out.data.journalRef, requestId: req.id,
      detail: { gross: out.data.gross, expected: out.data.expected, counted: out.data.counted, variance: out.data.variance, refunds: out.data.refunds } });
    res.json({ ok: true, dayend: out.data });
  }));

  /* Voids and line removals (audit B-H6). Voiding an open bill and pulling a
     line off a ticket already sent to the kitchen are the two easiest ways to
     make money disappear from a restaurant, and both used to filter local state
     and toast a reason that was stored NOWHERE — no entity, no log, no actor.
     The server's own sale.void control only ever fired on `dels` of a SETTLED
     sale, which this UI never sends, so it was dead code for the register.
     Recorded as an entity (so it reaches reports and the sync stream) and as an
     activity_log event (so it surfaces in the back office's review list). */
  const VOID_KINDS = new Set(["bill", "line"]);
  app.post("/api/app2/void", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    /* AUDIT-S1: this writes the one record meant to help a manager investigate
       a cash discrepancy — it must not be forgeable by the person being
       investigated. Every sibling privileged mutation in this file gates on
       rank; this one didn't, so any authenticated staff (down to kitchen)
       could POST an arbitrary reason/amount straight into the audit trail. */
    if (denyAppRole(req, res, APP_RANK.TILL, "Voiding needs a till sign-in or above.")) return;
    const b = req.body || {};
    const kind = VOID_KINDS.has(String(b.kind)) ? String(b.kind) : "bill";
    const id = "vd-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const data = {
      id, kind, t: Date.now(), at: Date.now(),
      ref: String(b.ref || "").slice(0, 40),
      reason: String(b.reason || "").slice(0, 60),
      item: String(b.item || "").slice(0, 80),
      qty: Number(b.qty) || 0,
      amount: Math.round(Number(b.amount) || 0),
      userName: String(b.userName || (req.appStaff && req.appStaff.name) || "").slice(0, 60),
      staffRole: String(req.appRole || "").slice(0, 20),
      register: req.appRegister, storeId: req.appStoreId || DEFAULT_STORE_ID,
      kotSent: !!b.kotSent,
    };
    const rowver = await withOrg(orgId, async (c) => {
      const r = await c.query(
        "INSERT INTO entities (org_id, kind, id, data, deleted, updated_at) VALUES ($1,'voids',$2,$3,false,now()) RETURNING rowver",
        [orgId, id, JSON.stringify(data)]);
      return Number(r.rows[0].rowver);
    });
    poke(orgId, rowver);
    logActivity(orgId, { actor: data.userName, action: kind === "line" ? "bill.line_removed" : "bill.void",
      ref: data.ref, requestId: req.id, detail: { reason: data.reason, item: data.item, qty: data.qty, amount: data.amount, kotSent: data.kotSent } });
    res.json({ ok: true, id });
  }));

  /* Draw a block of receipt numbers for this terminal's register. The register
     calls this at boot and again when its block runs low, so it always holds
     numbers it can print offline without any chance of another terminal
     printing the same one. Numbers are never handed back — an unused block is a
     gap in the series, which is fine; a reissued number is not. */
  app.post("/api/app2/seq", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    const count = Math.max(1, Math.min(100, Number((req.body || {}).count) || 20));
    const block = await withOrg(orgId, (c) =>
      allocReceiptBlock(c, orgId, req.appStoreId, req.appRegister, count));
    res.set("Cache-Control", "no-store");
    res.json({ register: req.appRegister, storeId: req.appStoreId, from: block.from, to: block.to });
  }));
  // Register write-path: advance a live order's status (KDS bump, delivery
  // advance). Server-side read-modify-write preserves every other order field,
  // bumps rowver and pokes SSE so the till, back office and other /app2 polls
  // all see it. Cookie-authed (same session as the page).
  // Fulfilment: new → preparing → ready → served (served is NOT final — the bill
  // stays open on the till, floor and guest portal). Settlement is a separate,
  // money step (/settle) that stamps `settled` and records the sale. `completed`
  // is kept for older rows and treated as final. `cancelled` voids.
  const ORDER_STATUSES = new Set(["new", "preparing", "ready", "served", "completed", "settled", "cancelled"]);
  /* Kitchen work (preparing/ready) is kitchen-rank; closing or cancelling an
     order is money, so it needs till rank. This was the one app2 write endpoint
     with no rank check at all, and it accepts "completed" — which stamps
     settledAt and drops the order off the register's open list. An unpaid order
     could be closed from a kitchen screen. */
  const ORDER_STATUS_RANK = { preparing: APP_RANK.KITCHEN, ready: APP_RANK.KITCHEN, new: APP_RANK.KITCHEN, served: APP_RANK.KITCHEN, completed: APP_RANK.TILL, settled: APP_RANK.TILL, cancelled: APP_RANK.TILL };
  app.post("/api/app2/order/:id/status", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    const id = String(req.params.id || "");
    const status = String((req.body || {}).status || "");
    if (!ORDER_STATUSES.has(status)) return res.status(400).json({ error: "bad status" });
    if (denyAppRole(req, res, ORDER_STATUS_RANK[status] || APP_RANK.TILL, "You don't have permission to change this order.")) return;
    const rowver = await withOrg(orgId, async (c) => {
      /* FOR UPDATE: this is a read-modify-write, and READ COMMITTED lets two
         concurrent writers both read the pre-image — a waiter accepting an
         order at the same moment the kitchen bumps it loses one of the two. */
      const cur = await c.query(
        "SELECT data FROM entities WHERE org_id=$1 AND kind='orders' AND id=$2 AND deleted=false FOR UPDATE", [orgId, id]);
      if (!cur.rowCount) return null;
      const data = cur.rows[0].data || {};
      data.status = status;
      data.updatedAt = Date.now();
      if (status === "ready") data.readyAt = Date.now();
      if (status === "served") data.servedAt = Date.now();     // fulfilled — bill still open, not final
      if (status === "completed") { data.completedAt = Date.now(); data.settledAt = Date.now(); }
      const r = await c.query(
        "UPDATE entities SET data=$3, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='orders' AND id=$2 RETURNING rowver",
        [orgId, id, JSON.stringify(data)]);
      return Number(r.rows[0].rowver);
    });
    if (rowver == null) return res.status(404).json({ error: "order not found" });
    poke(orgId, rowver);
    // A guest QR order's stock hold (issue #31) is done once the order is off
    // the open board — release it here too, not just at /settle, so a
    // kitchen/till cancel or an old-style "completed" close frees the hold
    // immediately instead of waiting for it to expire. A no-op for orders that
    // were never reserved (till-originated orders, or none of these statuses).
    if (status === "completed" || status === "settled" || status === "cancelled") {
      inventory.releaseOrderReservations(orgId, id).catch(() => {});
    }
    res.json({ ok: true });
  }));
  // Acknowledge a bill request: the cashier taps "On my way" so the guest's
  // portal shows a server is coming to settle. A flag, not a status change —
  // the order stays open until it is actually settled.
  app.post("/api/app2/order/:id/billack", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.TILL, "Only till staff can respond to a bill request.")) return;
    const id = String(req.params.id || "");
    const on = (req.body || {}).ack !== false;
    const rowver = await withOrg(orgId, async (c) => {
      const cur = await c.query("SELECT data FROM entities WHERE org_id=$1 AND kind='orders' AND id=$2 AND deleted=false FOR UPDATE", [orgId, id]);
      if (!cur.rowCount) return null;
      const data = cur.rows[0].data || {};
      data.billAck = on; data.billAckAt = on ? Date.now() : null; data.updatedAt = Date.now();
      const r = await c.query("UPDATE entities SET data=$3, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='orders' AND id=$2 RETURNING rowver", [orgId, id, JSON.stringify(data)]);
      return Number(r.rows[0].rowver);
    });
    if (rowver == null) return res.status(404).json({ error: "order not found" });
    poke(orgId, rowver);
    res.json({ ok: true });
  }));
  // Settle a served/open order: the money step that closes it. Records the sale
  // (so QR revenue lands in the Z-report + books) and stamps `settled` — the
  // guest portal reads that as paid and shows a receipt. Idempotent: a second
  // settle is refused rather than double-booking.
  //
  // A QR/portal settle must land in the books exactly like a till sale. The
  // `sales` entity already feeds revenue/GST/service/tenders/AR and the Orders
  // & Tickets closed row (all derived from it at read time). This handler also
  // does what the /api/ops sale path does around that entity, so the settle is
  // not a second-class sale: it stamps a money-integrity audit, decrements
  // product-level stock, accrues the member's loyalty points, and (post-commit)
  // runs the recipe/ingredient COGS ledger so gross margin is right immediately
  // instead of waiting up to 30 min for the reconcile sweep.
  app.post("/api/app2/order/:id/settle", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.TILL, "Settling a bill needs a cashier, waiter or manager.")) return;
    const id = String(req.params.id || "");
    const tender = ["cash", "card", "wallet", "transfer", "credit"].includes(String((req.body || {}).tender)) ? String(req.body.tender) : "cash";
    // Transaction/reference number for a non-cash tender — the terminal's auth
    // code, a bank transfer's reference, a QR payment's receipt number. Purely
    // for reconciliation: never required, never validated against a gateway
    // (there isn't one wired up), just carried onto the sale for the books.
    const ref = String((req.body || {}).ref || "").trim().slice(0, 64);
    const settings = (await loadSettingsArr(orgId))[0] || {};
    // Catalogue prices + GST rate for the money-integrity check (same ctx the
    // /api/ops path builds), so a mispriced/tampered QR line gets flagged too.
    let moneyCtx = null;
    try {
      const prods = await kindAll(orgId, "products", cleanStoreId(DEFAULT_STORE_ID));
      const prices = new Map();
      for (const p of prods) prices.set(String(p.id), { price: Number(p.price) || 0, open: !!p.open });
      moneyCtx = { gstBp: Number(settings.gstBp || 800), prices };
    } catch (e) { moneyCtx = { gstBp: Number(settings.gstBp || 800) }; }
    const cfg = loyaltyConfig(settings);
    const out = await withOrg(orgId, async (c) => {
      const cur = await c.query("SELECT data FROM entities WHERE org_id=$1 AND kind='orders' AND id=$2 AND deleted=false FOR UPDATE", [orgId, id]);
      if (!cur.rowCount) return { code: 404 };
      const data = cur.rows[0].data || {};
      if (["settled", "completed", "cancelled"].includes(String(data.status || ""))) return { code: 409 };
      const bd = orderBreakdown(data, settings);
      data.status = "settled"; data.settledAt = Date.now(); data.paidAt = Date.now(); data.tender = tender; data.tenderRef = ref; data.billAck = false; data.updatedAt = Date.now();
      const r = await c.query("UPDATE entities SET data=$3, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='orders' AND id=$2 RETURNING rowver", [orgId, id, JSON.stringify(data)]);
      // A `sales` entity keyed off the order id, so the QR sale reaches the
      // Z-report / GST return / P&L and a replay can't book it twice. `id` on
      // the DATA (not just the entity key) is what processSales + the reconcile
      // sweep key their COGS ledger ref off — without it, COGS never posts.
      const saleId = "s_ord_" + id;
      const sale = {
        id: saleId, type: "sale", no: data.no || saleId, table: data.table || null, tender: tender, at: Date.now(),
        otype: asOtype(data.otype), storeId: cleanStoreId(data.storeId || DEFAULT_STORE_ID),
        channel: data.otype === "delivery" ? "delivery" : data.otype === "takeaway" ? "takeaway" : "qr",
        lines: (data.items || []).map((it) => ({ pid: it.pid, name: it.name, qty: Number(it.qty) || 1, price: Number(it.price) || 0, amount: (Number(it.price) || 0) * (Number(it.qty) || 1), discPct: 0, taxable: it.taxable !== false, addons: it.addons })),
        subtotal: bd.excl, svcCharge: bd.svc, gst: bd.gst, billDisc: bd.disc, billDiscPct: bd.discPct, total: bd.total,
        payments: [{ method: tender, amount: bd.total, given: bd.total, change: 0, ref: ref || undefined }],
        orderId: id, source: "qr", userName: "QR portal",
      };
      if (data.customerId) { sale.customerId = data.customerId; sale.customerName = data.customerName || ""; }
      // Money integrity: re-derive and stamp a flag on a mismatch (never reject —
      // the guest has paid). Surfaces in the Payments > Review tab like any sale.
      const money = auditSaleMoney(sale, moneyCtx);
      if (money) sale.serverAudit = money;
      const ins = await c.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'sales',$2,$3) ON CONFLICT (org_id, kind, id) DO NOTHING RETURNING rowver", [orgId, saleId, JSON.stringify(sale)]);
      const firstBooking = ins.rowCount > 0;   // ON CONFLICT → 0 rows means it was already booked
      // Product-level stock: decrement stock-counted menu items (the /api/ops
      // path does this from client deltas; a QR settle has no client, so do it
      // here). Recipe-tracked items are handled by processSales post-commit.
      // Only on the first booking, so a retried settle can't double-deduct.
      if (firstBooking) {
        for (const it of (data.items || [])) {
          const q = Number(it.qty) || 1; if (!it.pid || q <= 0) continue;
          await c.query(
            `UPDATE entities SET data = jsonb_set(data, '{stock}', to_jsonb(GREATEST(0, (data->>'stock')::numeric - $4)), true),
               rowver = nextval('entities_rowver_seq'), updated_at = now()
             WHERE org_id=$1 AND kind='products' AND id=$2 AND COALESCE(data->>'storeId',$3) IN ('global',$3)
               AND jsonb_typeof(data->'stock') = 'number'`, [orgId, String(it.pid), sale.storeId, q]);
        }
        // Loyalty: award points to a member-attributed order (spend/visits are
        // derived from the sales entity, so only stored points need moving).
        const pts = data.customerId && cfg.pointsPer > 0 ? Math.floor((bd.total / 100) / cfg.pointsPer) : 0;
        if (pts > 0) {
          await c.query(
            `UPDATE entities SET data = data || jsonb_build_object('points', COALESCE((data->>'points')::numeric,0) + $3),
               rowver = nextval('entities_rowver_seq'), updated_at = now()
             WHERE org_id=$1 AND kind='customers' AND id=$2`, [orgId, String(data.customerId), pts]);
        }
      }
      return { code: 200, rowver: Number(r.rows[0].rowver), total: bd.total, sale, firstBooking, flagged: !!money };
    });
    if (out.code === 404) return res.status(404).json({ error: "order not found" });
    if (out.code === 409) return res.status(409).json({ error: "this order is already closed" });
    poke(orgId, out.rowver);
    // Real stock deduction has now taken over from the reservation (issue #31).
    inventory.releaseOrderReservations(orgId, id).catch(() => {});
    // Post-commit (never blocks the settle): recipe/ingredient COGS ledger +
    // availability recompute, and an activity-log entry. Idempotent by sale id.
    if (out.firstBooking && out.sale) {
      inventory.processSales(orgId, [out.sale]).catch((e) => recordError("settle processSales", e));
      logActivity(orgId, { action: out.flagged ? "sale.flagged" : "sale.qr_settled", ref: out.sale.no, detail: { total: out.total, tender, source: "qr" }, requestId: req.id });
      maybeRecomputePopularity(orgId);   // a fresh sale can change what's trending
    }
    res.json({ ok: true, total: out.total });
  }));
  // Per-line KDS bump: a cook marks one dish on a ticket done (or un-done). The
  // line is addressed by its stable index in the order's items array. When every
  // line is bumped the whole ticket becomes ready; the first bump moves a 'new'
  // ticket to 'preparing', so the status reflects real kitchen progress.
  app.post("/api/app2/order/:id/line", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.KITCHEN, "You don't have permission to bump this ticket.")) return;
    const id = String(req.params.id || "");
    const b = req.body || {};
    const idx = Math.trunc(Number(b.index));
    if (!Number.isFinite(idx) || idx < 0) return res.status(400).json({ error: "bad line index" });
    const done = b.done !== false;
    const out = await withOrg(orgId, async (c) => {
      const cur = await c.query(
        "SELECT data FROM entities WHERE org_id=$1 AND kind='orders' AND id=$2 AND deleted=false FOR UPDATE", [orgId, id]);
      if (!cur.rowCount) return { code: 404 };
      const data = cur.rows[0].data || {};
      const items = Array.isArray(data.items) ? data.items.slice() : [];
      if (idx >= items.length) return { code: 400 };
      items[idx] = Object.assign({}, items[idx], { done: done, doneAt: done ? Date.now() : null });
      data.items = items;
      data.updatedAt = Date.now();
      const allDone = items.length > 0 && items.every((it) => it.done);
      if (allDone) { if (data.status === "new" || data.status === "preparing") { data.status = "ready"; data.readyAt = Date.now(); } }
      else if (data.status === "new") { data.status = "preparing"; }
      const r = await c.query(
        "UPDATE entities SET data=$3, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='orders' AND id=$2 RETURNING rowver",
        [orgId, id, JSON.stringify(data)]);
      return { code: 200, rowver: Number(r.rows[0].rowver), status: data.status, allDone };
    });
    if (out.code === 404) return res.status(404).json({ error: "order not found" });
    if (out.code === 400) return res.status(400).json({ error: "line index out of range" });
    poke(orgId, out.rowver);
    res.json({ ok: true, status: out.status, allDone: out.allDone });
  }));
  // Register write-path: a cashier/waiter/admin accepts a live customer order,
  // which opens a bill for it on the till. Marks the order accepted (and, if it
  // still has kitchen work, moves it to 'preparing' so the guest sees progress).
  app.post("/api/app2/order/:id/accept", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.TILL, "Kitchen staff can't accept orders — ask a cashier, waiter or manager.")) return;
    const id = String(req.params.id || "");
    const rowver = await withOrg(orgId, async (c) => {
      const cur = await c.query(
        "SELECT data FROM entities WHERE org_id=$1 AND kind='orders' AND id=$2 AND deleted=false FOR UPDATE", [orgId, id]);
      if (!cur.rowCount) return null;
      const data = cur.rows[0].data || {};
      data.accepted = true;
      data.acceptedAt = Date.now();
      data.updatedAt = Date.now();
      if (String(data.status || "new") === "new" && !data.noKitchen) data.status = "preparing";
      const r = await c.query(
        "UPDATE entities SET data=$3, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='orders' AND id=$2 RETURNING rowver",
        [orgId, id, JSON.stringify(data)]);
      return Number(r.rows[0].rowver);
    });
    if (rowver == null) return res.status(404).json({ error: "order not found" });
    poke(orgId, rowver);
    res.json({ ok: true });
  }));
  // Delivery ops: assign (or clear) the rider on a delivery order. Free-text
  // name — riders aren't a login role. Any till staff may assign; kitchen can't.
  app.post("/api/app2/order/:id/rider", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.TILL, "Kitchen staff can't assign riders.")) return;
    const id = String(req.params.id || "");
    const rider = String((req.body || {}).rider || "").trim().slice(0, 60);
    const rowver = await withOrg(orgId, async (c) => {
      const cur = await c.query("SELECT data FROM entities WHERE org_id=$1 AND kind='orders' AND id=$2 AND deleted=false FOR UPDATE", [orgId, id]);
      if (!cur.rowCount) return null;
      const data = cur.rows[0].data || {};
      data.rider = rider; data.updatedAt = Date.now();
      const r = await c.query("UPDATE entities SET data=$3, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='orders' AND id=$2 RETURNING rowver", [orgId, id, JSON.stringify(data)]);
      return Number(r.rows[0].rowver);
    });
    if (rowver == null) return res.status(404).json({ error: "order not found" });
    poke(orgId, rowver);
    res.json({ ok: true, rider });
  }));
  // Customer profile upsert (name/phone/tier/notes) — never touches balance or
  // points (server-authoritative). Cookie-authed; used by the /admin2 editor.
  app.post("/api/app2/customer", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.MANAGER, "Editing customers needs a manager or the owner.")) return;
    const b = req.body || {};
    const name = String(b.name || "").trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: "name required" });
    const fields = { name, phone: String(b.phone || "").trim().slice(0, 30) };
    if (b.dv !== undefined) fields.dv = String(b.dv).trim().slice(0, 80);
    if (b.tier !== undefined) fields.tier = String(b.tier).slice(0, 20);
    if (b.allergy !== undefined) fields.allergy = String(b.allergy).slice(0, 120);
    if (b.diet !== undefined) fields.diet = String(b.diet).slice(0, 120);
    if (b.note !== undefined) fields.note = String(b.note).slice(0, 300);
    // Email is what links a customer to the rewards portal — persist it (lower-
    // cased, validated when non-empty) so "Invite to portal" and member sign-in
    // can find them. An empty string clears it.
    if (b.email !== undefined) {
      const email = String(b.email || "").trim().toLowerCase().slice(0, 120);
      if (email && !validEmail(email)) return res.status(400).json({ error: "That email doesn't look right." });
      fields.email = email;
    }
    // Credit limit in laari (creditLimit is the field the projection reads); the
    // terminal sends laari. `credit` (MVR) is accepted as a fallback for callers
    // that still send rupees.
    if (b.creditLimit !== undefined) fields.creditLimit = Math.max(0, Math.round(Number(b.creditLimit) || 0));
    else if (b.credit !== undefined) fields.creditLimit = Math.max(0, Math.round((Number(b.credit) || 0) * 100));
    let id = String(b.id || "").trim();
    const out = await withOrg(orgId, async (c) => {
      if (id) {
        const cur = await c.query("SELECT data FROM entities WHERE org_id=$1 AND kind='customers' AND id=$2 AND deleted=false", [orgId, id]);
        if (cur.rowCount) {
          const data = Object.assign({}, cur.rows[0].data || {}, fields);
          const r = await c.query("UPDATE entities SET data=$3, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='customers' AND id=$2 RETURNING rowver", [orgId, id, JSON.stringify(data)]);
          return { id, rowver: Number(r.rows[0].rowver), email: data.email || "" };
        }
      }
      if (!id) id = "c_" + Math.random().toString(36).slice(2, 9);
      const data = Object.assign({ id, points: 0, balance: 0 }, fields);
      const r = await c.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'customers',$2,$3) ON CONFLICT (org_id, kind, id) DO UPDATE SET data=excluded.data, deleted=false, rowver=nextval('entities_rowver_seq'), updated_at=now() RETURNING rowver", [orgId, id, JSON.stringify(data)]);
      return { id, rowver: Number(r.rows[0].rowver), email: data.email || "" };
    });
    poke(orgId, out.rowver);
    res.json({ ok: true, id: out.id, email: out.email, hasEmail: !!(out.email && out.email.indexOf("@") > 0) });
  }));
  /* Create or edit a menu item (dish). The terminal talks in MVR; the entity
     stores laari, so price + add-on prices are ×100 here. An update MERGES onto
     the existing product row so recipe lines, stock and any field the form
     doesn't touch survive. `soldOut` is the canonical 86 flag (derivedSoldOut
     reads it); `off` is accepted as an alias for older callers. */
  app.post("/api/app2/product", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.MANAGER, "Editing the menu needs a manager or the owner.")) return;
    const b = req.body || {};
    // menuFields is the shared normaliser (single-item save + CSV import) — it
    // validates name/price and coerces every dish field the same way for both.
    const nf = menuFields(b);
    if (nf.error) return res.status(400).json({ error: nf.error === "a name is required" ? "Give the dish a name." : nf.error === "price must be greater than zero" ? "Price must be greater than zero." : nf.error });
    const fields = nf.fields, name = fields.name, priceLaari = fields.price;
    let id = String(b.id || "").trim();
    const out = await withOrg(orgId, async (c) => {
      if (id) {
        const cur = await c.query("SELECT data FROM entities WHERE org_id=$1 AND kind='products' AND id=$2 AND deleted=false", [orgId, id]);
        if (cur.rowCount) {
          const data = Object.assign({}, cur.rows[0].data || {}, fields);
          const r = await c.query("UPDATE entities SET data=$3, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='products' AND id=$2 RETURNING rowver", [orgId, id, JSON.stringify(data)]);
          return { id, rowver: Number(r.rows[0].rowver), created: false };
        }
      }
      if (!id) id = "m_" + Math.random().toString(36).slice(2, 9);
      const data = Object.assign({ id, recipe: [] }, fields);
      // A new dish with no photo gets a category-keyed placeholder tile, so it
      // never shows a blank square on the till or the QR menu.
      const r = await c.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'products',$2,$3) ON CONFLICT (org_id, kind, id) DO UPDATE SET data=excluded.data, deleted=false, rowver=nextval('entities_rowver_seq'), updated_at=now() RETURNING rowver", [orgId, id, JSON.stringify(data)]);
      return { id, rowver: Number(r.rows[0].rowver), created: true };
    });
    poke(orgId, out.rowver);
    logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "", action: out.created ? "menu.create" : "menu.update", ref: out.id,
      detail: { name, price: priceLaari } });
    res.json({ ok: true, id: out.id, created: out.created });
  }));

  /* ── Menu import / export (CSV template) ────────────────────────────────────
     Export the whole menu as one spreadsheet carrying every editable field, or
     import that same shape back — so a store can bulk-edit in Excel/Sheets, seed
     a brand-new store, or move a menu between stores. The `id` column round-trips:
     keep it to UPDATE a dish, blank it to CREATE one. Manager+ (same gate as a
     single edit). */
  app.get("/api/app2/menu/export", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.MANAGER, "Exporting the menu needs a manager or the owner.")) return;
    const storeId = cleanStoreId(req.appStoreId || DEFAULT_STORE_ID);
    const prods = (await kindAll(orgId, "products", storeId)).filter((p) => p && p.name);
    prods.sort((a, b) => String(a.cat || "").localeCompare(String(b.cat || "")) || String(a.name || "").localeCompare(String(b.name || "")));
    const header = MENU_CSV_COLS.map((c) => c[0]);
    let rows = prods.map(menuCsvRow);
    // An empty menu still returns a usable template: the header plus one example
    // row (marked EXAMPLE) that shows the format, so a new store can fill it in.
    if (!rows.length) rows = [["", "EXAMPLE — Margherita Pizza", "", "Pizza", 120, "Tomato, mozzarella, basil", "", "yes", 0, "no", "yes", "yes", "no", "no", "no", "Extra cheese:15; Mushrooms:10", ""]];
    const csv = toCsv([header].concat(rows));
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", 'attachment; filename="kashikeyo-menu.csv"');
    res.set("Cache-Control", "no-store");
    res.send("﻿" + csv);   // BOM so Excel opens UTF-8 (Dhivehi) correctly
  }));
  app.post("/api/app2/menu/import", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.MANAGER, "Importing the menu needs a manager or the owner.")) return;
    const text = String((req.body || {}).csv || "").replace(/^﻿/, "");
    const grid = parseCsv(text).filter((r) => r.some((c) => String(c || "").trim() !== ""));
    if (grid.length < 2) return res.status(400).json({ error: "That file has no dish rows. Export the template first, fill it in, then import." });
    // Map the header to our keys by fuzzy name, so column order / minor renames
    // (spaces, case, "price" vs "price_mvr") still line up.
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const head = grid[0].map(norm);
    const colIndex = {};
    MENU_CSV_COLS.forEach(([label, key]) => {
      let i = head.indexOf(norm(label));
      if (i < 0 && key === "price") i = head.findIndex((h) => h.indexOf("price") >= 0);
      if (i < 0 && key === "hidden") i = head.findIndex((h) => h.indexOf("hidden") >= 0);
      if (i < 0 && key === "spice") i = head.findIndex((h) => h.indexOf("spice") >= 0);
      if (i < 0) i = head.indexOf(norm(key));
      colIndex[key] = i;
    });
    if (colIndex.name < 0 || colIndex.price < 0) return res.status(400).json({ error: "Couldn't find the name and price columns. Use the exported template's header row." });
    const dataRows = grid.slice(1).slice(0, 2000);   // cap a single import
    const cell = (row, key) => { const i = colIndex[key]; return i >= 0 && i < row.length ? row[i] : undefined; };
    // "Replace" wipes the current menu first, so an import is the whole menu, not
    // an add-on to it. Categories/order are re-derived from what's imported.
    const replace = !!(req.body || {}).replace;
    let created = 0, updated = 0, purged = 0; const skipped = []; const catSeen = [];
    await withOrg(orgId, async (c) => {
      if (replace) {
        const del = await c.query("UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='products' AND deleted=false", [orgId]);
        purged = del.rowCount || 0;
      }
      for (let r = 0; r < dataRows.length; r++) {
        const row = dataRows[r];
        const rec = {}; MENU_CSV_COLS.forEach(([, key]) => { rec[key] = cell(row, key); });
        // EXAMPLE rows from the blank template are guidance, not data — skip them.
        if (/^example\b/i.test(String(rec.name || "").trim())) continue;
        const nf = menuFields(menuCsvRowToInput(rec));
        if (nf.error) { skipped.push({ row: r + 2, name: String(rec.name || "").trim(), reason: nf.error }); continue; }
        const f = nf.fields;
        // Tags default to the dish's own facts when the column is blank, so the
        // menu tiles carry a chip or two without hand-tagging 300 dishes.
        if (!Array.isArray(f.tags) || !f.tags.length) {
          const dt = []; if (f.bestSeller) dt.push("Popular"); if (f.veg) dt.push("Veg"); if (Number(f.spice) >= 2) dt.push("Spicy");
          if (dt.length) f.tags = dt.slice(0, 3);
        }
        if (f.cat && catSeen.indexOf(f.cat) < 0) catSeen.push(f.cat);
        const wantId = String(rec.id || "").trim();
        let existing = null;
        if (wantId && !replace) {
          const cur = await c.query("SELECT id FROM entities WHERE org_id=$1 AND kind='products' AND id=$2 AND deleted=false", [orgId, wantId]);
          if (cur.rowCount) existing = wantId;
        }
        if (existing) {
          const cur = await c.query("SELECT data FROM entities WHERE org_id=$1 AND kind='products' AND id=$2", [orgId, existing]);
          const data = Object.assign({}, cur.rows[0].data || {}, f);
          await c.query("UPDATE entities SET data=$3, deleted=false, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='products' AND id=$2", [orgId, existing, JSON.stringify(data)]);
          updated++;
        } else {
          const id = wantId || ("m_" + Math.random().toString(36).slice(2, 9));
          const data = Object.assign({ id, recipe: [] }, f);
          await c.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'products',$2,$3) ON CONFLICT (org_id, kind, id) DO UPDATE SET data=excluded.data, deleted=false, rowver=nextval('entities_rowver_seq'), updated_at=now()", [orgId, id, JSON.stringify(data)]);
          created++;
        }
      }
      // On a full replace, pin the category order + a sensible top-level group
      // for each, so every portal reads the menu in the order it was imported.
      if (replace && catSeen.length) {
        const catGroups = catSeen.map((nm) => ({ name: nm, group: catGroupOf(nm) }));
        await c.query(
          "UPDATE entities SET data = COALESCE(data,'{}'::jsonb) || $2::jsonb, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='settings'",
          [orgId, JSON.stringify({ catOrder: catSeen, catGroups })]);
      }
    });
    poke(orgId, Date.now());
    logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "", action: "menu.import", ref: "", detail: { created, updated, purged, skipped: skipped.length } });
    res.json({ ok: true, created, updated, purged, categories: catSeen.length, skipped });
  }));

  /* Download the bundled starter menu as a ready-to-edit CSV — a fully worked
     example (every column filled) a store can download, tweak and re-import. */
  app.get("/api/app2/menu/sample", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.MANAGER, "The sample menu is for a manager or the owner.")) return;
    const header = MENU_CSV_COLS.map((c) => c[0]);
    const rows = (DEFAULT_MENU || []).map(menuCsvRow);
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", 'attachment; filename="kashikeyo-sample-menu.csv"');
    res.set("Cache-Control", "no-store");
    res.send("﻿" + toCsv([header].concat(rows)));
  }));
  /* Load the bundled starter menu into this store. replace=true resets the store
     to exactly the starter menu; otherwise it adds/updates the starter dishes and
     keeps the rest. Same result as importing the sample CSV, one click. */
  app.post("/api/app2/menu/default", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.MANAGER, "Loading the starter menu needs a manager or the owner.")) return;
    const replace = !!(req.body || {}).replace;
    const r = await applyMenuItems(orgId, DEFAULT_MENU, CAT_GROUPS, CAT_ORDER, { replace });
    logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "", action: "menu.default", ref: "", detail: { created: r.created, purged: r.purged, replace } });
    res.json({ ok: true, created: r.created, purged: r.purged, categories: (CAT_ORDER || []).length });
  }));
  /* Remove a dish from the menu (tombstone). It stops showing on the till and
     the QR portal; past orders that referenced it are unaffected. */
  app.post("/api/app2/product/:id/delete", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.MANAGER, "Removing a dish needs a manager or the owner.")) return;
    const id = String(req.params.id || "");
    const out = await withOrg(orgId, async (c) => {
      const r = await c.query("UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='products' AND id=$2 AND deleted=false RETURNING rowver", [orgId, id]);
      return r.rowCount ? { rowver: Number(r.rows[0].rowver) } : null;
    });
    if (!out) return res.status(404).json({ error: "dish not found" });
    poke(orgId, out.rowver);
    logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "", action: "menu.delete", ref: id, detail: {} });
    res.json({ ok: true });
  }));
  /* Availability only — 86 (soldOut) or hide a dish. Allowed at TILL rank so a
     cashier/waiter can pull a dish that's run out or take it off the customer
     menu, WITHOUT the manager-only power to edit prices, names or delete. Only
     soldOut/hidden are ever written here. */
  app.post("/api/app2/product/:id/availability", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.TILL, "Changing availability needs a till sign-in or above.")) return;
    const id = String(req.params.id || "");
    const b = req.body || {};
    const set = {};
    if (b.soldOut !== undefined) set.soldOut = !!b.soldOut;
    if (b.hidden !== undefined) set.hidden = !!b.hidden;
    if (!Object.keys(set).length) return res.status(400).json({ error: "nothing to change" });
    const out = await withOrg(orgId, async (c) => {
      const cur = await c.query("SELECT data FROM entities WHERE org_id=$1 AND kind='products' AND id=$2 AND deleted=false", [orgId, id]);
      if (!cur.rowCount) return null;
      const data = Object.assign({}, cur.rows[0].data || {}, set);
      const r = await c.query("UPDATE entities SET data=$3, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='products' AND id=$2 RETURNING rowver", [orgId, id, JSON.stringify(data)]);
      return { rowver: Number(r.rows[0].rowver) };
    });
    if (!out) return res.status(404).json({ error: "dish not found" });
    poke(orgId, out.rowver);
    logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "", action: "menu.availability", ref: id, detail: set });
    res.json({ ok: true });
  }));
  /* ── Menu categories ──────────────────────────────────────────────────────
     Categories are persisted as an ordered name list on the settings row
     (data.menuCats) so an empty, renamed or reordered section sticks; products
     still key on the category NAME, so rename/delete bulk-rewrite the dishes.
     Manager/owner only. */
  const updateMenuCats = (orgId, mutate) => withOrg(orgId, async (c) => {
    const rows = (await c.query("SELECT id, data FROM entities WHERE org_id=$1 AND kind='settings' AND deleted=false ORDER BY (id='settings') DESC, updated_at DESC", [orgId])).rows;
    const cur = rows[0] || null;
    const data = Object.assign({}, cur ? cur.data : {});
    const cats = Array.isArray(data.menuCats) ? data.menuCats.slice() : [];
    data.menuCats = await mutate(cats, c);
    const sid = cur ? cur.id : "settings";
    const r = await c.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'settings',$2,$3) ON CONFLICT (org_id, kind, id) DO UPDATE SET data=excluded.data, deleted=false, rowver=nextval('entities_rowver_seq'), updated_at=now() RETURNING rowver", [orgId, sid, JSON.stringify(data)]);
    return Number(r.rows[0].rowver);
  });
  const renameProdCat = (c, orgId, from, to) => c.query(
    "UPDATE entities SET data=jsonb_set(data,'{cat}',to_jsonb($3::text)), rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='products' AND deleted=false AND data->>'cat'=$2", [orgId, from, to]);
  app.post("/api/app2/category", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.MANAGER, "Editing the menu needs a manager or the owner.")) return;
    const name = String((req.body || {}).name || "").trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: "Give the category a name." });
    const rowver = await updateMenuCats(orgId, (cats) => {
      if (!cats.some((x) => menuCat(x) === menuCat(name))) cats.push(name);
      return cats;
    });
    poke(orgId, rowver);
    logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "", action: "menu.category.create", ref: name, detail: {} });
    res.json({ ok: true, name });
  }));
  app.post("/api/app2/category/rename", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.MANAGER, "Editing the menu needs a manager or the owner.")) return;
    const b = req.body || {};
    const from = String(b.from || "").trim(), to = String(b.to || "").trim().slice(0, 60);
    if (!from || !to) return res.status(400).json({ error: "from and to are required" });
    const rowver = await updateMenuCats(orgId, async (cats, c) => {
      const next = cats.map((x) => (menuCat(x) === menuCat(from) ? to : x));
      if (!next.some((x) => menuCat(x) === menuCat(to))) next.push(to);
      await renameProdCat(c, orgId, from, to);
      return next;
    });
    poke(orgId, rowver);
    logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "", action: "menu.category.rename", ref: from, detail: { to } });
    res.json({ ok: true });
  }));
  app.post("/api/app2/category/delete", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.MANAGER, "Editing the menu needs a manager or the owner.")) return;
    const b = req.body || {};
    const name = String(b.name || "").trim();
    const moveTo = String(b.moveTo || "").trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: "name required" });
    const rowver = await updateMenuCats(orgId, async (cats, c) => {
      await renameProdCat(c, orgId, name, moveTo);   // reassign its dishes (moveTo may be "")
      return cats.filter((x) => menuCat(x) !== menuCat(name));
    });
    poke(orgId, rowver);
    logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "", action: "menu.category.delete", ref: name, detail: { moveTo } });
    res.json({ ok: true });
  }));
  app.post("/api/app2/category/reorder", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.MANAGER, "Editing the menu needs a manager or the owner.")) return;
    const order = Array.isArray((req.body || {}).order) ? req.body.order.map((x) => String(x).trim().slice(0, 60)).filter(Boolean) : null;
    if (!order) return res.status(400).json({ error: "order[] required" });
    const rowver = await updateMenuCats(orgId, (cats) => {
      // Keep the given order, then append any saved category the client omitted.
      const out = order.slice(), have = new Set(order.map(menuCat));
      cats.forEach((x) => { if (!have.has(menuCat(x))) out.push(x); });
      return out;
    });
    poke(orgId, rowver);
    res.json({ ok: true });
  }));
  /* Assign a category to a top-level group (settings.catGroup[name] = group),
     which is how the 20+ sections collapse to a short top level. */
  app.post("/api/app2/category/group", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.MANAGER, "Editing the menu needs a manager or the owner.")) return;
    const b = req.body || {};
    const name = String(b.name || "").trim();
    const group = String(b.group || "").trim().slice(0, 40);
    if (!name || !group) return res.status(400).json({ error: "name and group are required" });
    const rowver = await withOrg(orgId, async (c) => {
      const rows = (await c.query("SELECT id, data FROM entities WHERE org_id=$1 AND kind='settings' AND deleted=false ORDER BY (id='settings') DESC, updated_at DESC", [orgId])).rows;
      const cur = rows[0] || null;
      const data = Object.assign({}, cur ? cur.data : {});
      data.catGroup = Object.assign({}, data.catGroup || {}, { [name]: group });
      const sid = cur ? cur.id : "settings";
      const r = await c.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'settings',$2,$3) ON CONFLICT (org_id, kind, id) DO UPDATE SET data=excluded.data, deleted=false, rowver=nextval('entities_rowver_seq'), updated_at=now() RETURNING rowver", [orgId, sid, JSON.stringify(data)]);
      return Number(r.rows[0].rowver);
    });
    poke(orgId, rowver);
    logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "", action: "menu.category.group", ref: name, detail: { group } });
    res.json({ ok: true });
  }));
  // Settle a receivable: reduce the customer's outstanding balance by an amount
  // (laari), clamped at zero, and stamp the settlement.
  app.post("/api/app2/customer/:id/settle", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.MANAGER, "Settling a balance needs a manager or the owner.")) return;
    const id = String(req.params.id || "");
    const amount = Math.max(0, Math.round(Number((req.body || {}).amount) || 0));
    if (!(amount > 0)) return res.status(400).json({ error: "enter an amount" });
    const out = await withOrg(orgId, async (c) => {
      const cur = await c.query("SELECT data FROM entities WHERE org_id=$1 AND kind='customers' AND id=$2 AND deleted=false", [orgId, id]);
      if (!cur.rowCount) return null;
      const data = Object.assign({}, cur.rows[0].data || {});
      const before = Number(data.balance) || 0;
      data.balance = Math.max(0, before - amount);
      data.lastSettledAt = Date.now();
      /* A settlement is cash physically received against a debt. It used to
         leave no record at all — no entity, no ledger line, no activity log —
         so the drawer moved with nothing to reconcile it against. Book it. */
      const stId = "stl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      const method = String((req.body || {}).method || "cash").slice(0, 16);
      await c.query(
        "INSERT INTO entities (org_id, kind, id, data, deleted, updated_at) VALUES ($1,'settlements',$2,$3,false,now())",
        [orgId, stId, JSON.stringify({ id: stId, customerId: id, customerName: data.name || "", amount, method,
          balanceBefore: before, balanceAfter: data.balance, t: Date.now(), at: Date.now(),
          userName: (req.appStaff && req.appStaff.name) || "", storeId: req.appStoreId || DEFAULT_STORE_ID })]);
      const r = await c.query("UPDATE entities SET data=$3, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='customers' AND id=$2 RETURNING rowver", [orgId, id, JSON.stringify(data)]);
      return { rowver: Number(r.rows[0].rowver), balance: data.balance, settlementId: stId };
    });
    if (out == null) return res.status(404).json({ error: "customer not found" });
    poke(orgId, out.rowver);
    logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "", action: "customer.settle", ref: id,
      detail: { amount, method: String((req.body || {}).method || "cash").slice(0, 16), balance: out.balance, settlementId: out.settlementId } });
    res.json({ ok: true, balance: out.balance, settlementId: out.settlementId });
  }));
  /* Delete (tombstone) a customer. Three guards, all re-checked server-side so
     the terminal's flags can't be trusted into a bad delete:
       1. A manager+ PIN must be entered (the same till PIN staff already hold),
          on top of the manager-rank session — a destructive, confirmable action.
       2. If anything is still pending — an unsettled credit balance, an open
          order, or an unredeemed reward voucher — the record STAYS and we say so.
       3. If the customer has transaction history but nothing pending, we ask the
          caller to confirm (`force`) before removing; with no history it deletes
          straight away.
     Delete is a soft tombstone (deleted=true), never a hard row removal: past
     sales and receipts reference this id and must stay intact for the accounts,
     and the sync protocol propagates the tombstone so clients drop the row. */
  app.post("/api/app2/customer/:id/delete", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.MANAGER, "Deleting a customer needs a manager or the owner.")) return;
    const id = String(req.params.id || "");
    const force = !!(req.body || {}).force;
    const want = hashTillPin(String((req.body || {}).pin || ""));
    // The PIN must belong to a manager-or-above staff member of THIS org.
    const okPin = await withOrg(orgId, async (c) => {
      const us = await c.query("SELECT data FROM entities WHERE org_id=$1 AND kind='users' AND deleted=false", [orgId]);
      const RANK = { owner: 3, admin: 2, manager: 1 };
      return us.rows.map((r) => r.data).some((u) => u && u.pin && String(u.pin) === want && RANK[String(u.role || "").toLowerCase()]);
    });
    if (!okPin) return res.status(403).json({ error: "That PIN doesn't match a manager or owner. Deleting a customer needs a manager PIN." });
    const out = await withOrg(orgId, async (c) => {
      const cur = await c.query("SELECT data FROM entities WHERE org_id=$1 AND kind='customers' AND id=$2 AND deleted=false", [orgId, id]);
      if (!cur.rowCount) return { notFound: true };
      const d = cur.rows[0].data || {};
      const bal = Number(d.balance || d.used || 0);
      const custKey = "COALESCE(NULLIF(data->>'customerId',''),NULLIF(data->>'custId',''))";
      const openO = Number((await c.query(
        `SELECT count(*)::int n FROM entities WHERE org_id=$1 AND kind='orders' AND deleted=false AND ${custKey}=$2 AND lower(COALESCE(data->>'status','new')) NOT IN ('completed','settled','paid','closed','cancelled','void','refunded','declined')`, [orgId, id])).rows[0].n);
      const openV = Number((await c.query(
        `SELECT count(*)::int n FROM entities WHERE org_id=$1 AND kind='rewardVouchers' AND deleted=false AND NULLIF(data->>'custId','')=$2 AND lower(COALESCE(data->>'state','pending'))='pending'`, [orgId, id])).rows[0].n);
      if (bal > 0 || openO > 0 || openV > 0) {
        const bits = [];
        if (bal > 0) bits.push("an unsettled balance of MVR " + (bal / 100).toFixed(2));
        if (openO > 0) bits.push(openO + " open order" + (openO > 1 ? "s" : ""));
        if (openV > 0) bits.push(openV + " unredeemed reward" + (openV > 1 ? "s" : ""));
        return { pending: true, reason: bits.join(", ") };
      }
      const txns = Number((await c.query(
        `SELECT count(*)::int n FROM entities WHERE org_id=$1 AND kind IN ('sales','orders') AND deleted=false AND ${custKey}=$2`, [orgId, id])).rows[0].n);
      const hasTxn = txns > 0 || Number(d.visits || 0) > 0 || Number(d.spent || 0) > 0;
      if (hasTxn && !force) return { needsConfirm: true, txns };
      const r = await c.query("UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='customers' AND id=$2 RETURNING rowver", [orgId, id]);
      return { ok: true, rowver: Number(r.rows[0].rowver), hadTxn: hasTxn, name: d.name || "" };
    });
    if (out.notFound) return res.status(404).json({ error: "customer not found" });
    if (out.pending) return res.status(409).json({ pending: true, error: "This customer has " + out.reason + " — settle or clear it first. The record stays." });
    if (out.needsConfirm) return res.status(409).json({ needsConfirm: true, txns: out.txns, error: "This customer has " + out.txns + " transaction" + (out.txns > 1 ? "s" : "") + " on file." });
    poke(orgId, out.rowver);
    logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "", action: "customer.delete", ref: id, detail: { name: out.name, hadTransactions: !!out.hadTxn } });
    res.json({ ok: true });
  }));
  /* Cashier shift + drawer cash-up (persisted). The till had an open/close
     drawer flow that only lived in localStorage; persist it as a `shifts`
     entity so managers can review cash-ups and variances in /admin. On close
     the server itself computes the cash takings since the shift opened, the
     expected drawer (float + cash) and the variance — the counted amount is the
     only figure trusted from the client. Any till staff may run the drawer;
     kitchen can't. Money is laari throughout. */
  app.post("/api/app2/shift", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.TILL, "Kitchen staff don't run the drawer.")) return;
    const b = req.body || {};
    const action = String(b.action || "");
    const storeId = cleanStoreId(b.storeId || (req.appStaff && req.appStaff.storeId) || DEFAULT_STORE_ID);
    const staff = req.appStaff || {};
    const staffName = String(b.staffName || staff.name || "").slice(0, 80);
    if (action === "open") {
      const float = Math.max(0, Math.round(Number(b.float) || 0));
      const id = "sh_" + Math.random().toString(36).slice(2, 9);
      const data = { id, storeId, staffId: staff.id || null, staffName, openedAt: Date.now(), float, status: "open" };
      const r = await withOrg(orgId, (c) => c.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'shifts',$2,$3) RETURNING rowver", [orgId, id, JSON.stringify(data)]));
      poke(orgId, Number(r.rows[0].rowver));
      logActivity(orgId, { actor: staffName || "cashier", action: "shift.open", ref: id, requestId: req.id, detail: { float } });
      return res.json({ ok: true, id, openedAt: data.openedAt });
    }
    if (action === "close") {
      const counted = Math.max(0, Math.round(Number(b.counted) || 0));
      const out = await withOrg(orgId, async (c) => {
        let cur;
        /* AUDIT-C1: the id-supplied lookup used to skip the status check the
           fallback lookup enforces, so re-posting action:"close" against an
           already-closed shift's id re-ran the whole computation and silently
           overwrote its counted/expected/variance — a cashier could close once
           honestly (recording a real shortage) then "close" again with a
           friendlier counted figure and the true variance was gone with no
           trace beyond a second activity_log line nobody reviews by default.
           Require status='open' on both lookup paths so only a genuinely open
           shift can be closed; a second close attempt now 404s. */
        if (b.id) cur = (await c.query("SELECT data FROM entities WHERE org_id=$1 AND kind='shifts' AND id=$2 AND deleted=false AND data->>'status'='open'", [orgId, String(b.id)])).rows[0];
        if (!cur) cur = (await c.query("SELECT data FROM entities WHERE org_id=$1 AND kind='shifts' AND deleted=false AND data->>'status'='open' AND COALESCE(data->>'storeId',$2)=$2 ORDER BY (data->>'openedAt')::numeric DESC LIMIT 1", [orgId, storeId])).rows[0];
        if (!cur) return null;
        const data = Object.assign({}, cur.data || {});
        const sinceOpen = Number(data.openedAt) || 0;
        const sales = (await c.query("SELECT data FROM entities WHERE org_id=$1 AND kind='sales' AND deleted=false AND COALESCE((data->>'t')::numeric,(data->>'at')::numeric,(data->>'createdAt')::numeric,0) >= $2 AND COALESCE(data->>'storeId',$3)=$3", [orgId, sinceOpen, data.storeId || storeId]))
          .rows.map((r) => r.data || {}).filter((s) => !s.type || s.type === "sale" || s.type === "refund");
        /* Refunds were excluded here too, so a shift that paid out MVR 110 in
           cash refunds closed expecting MVR 110 more in the drawer than could
           possibly be there — and the cashier wore the shortage. They carry
           negative amounts, so counting them nets the drawer correctly. Cash
           settlements of customer tabs are cash INTO the drawer for the same
           reason, and were missing entirely. */
        let cashSales = 0, gross = 0, refunds = 0, cashRefunds = 0;
        for (const s of sales) {
          const isRefund = s.type === "refund";
          if (isRefund) refunds += Math.abs(Number(s.total) || 0);
          gross += Number(s.total) || 0;
          const pays = (Array.isArray(s.payments) && s.payments.length) ? s.payments : [{ method: s.method || "cash", amount: Number(s.total) || 0 }];
          for (const p of pays) if (String(p.method || "cash").toLowerCase() === "cash") {
            cashSales += Number(p.amount) || 0;
            if (isRefund) cashRefunds += Math.abs(Number(p.amount) || 0);
          }
        }
        const settleRows = (await c.query(
          "SELECT data FROM entities WHERE org_id=$1 AND kind='settlements' AND deleted=false AND COALESCE((data->>'t')::numeric,(data->>'at')::numeric,(data->>'createdAt')::numeric,0) >= $2 AND COALESCE(data->>'storeId',$3)=$3",
          [orgId, sinceOpen, data.storeId || storeId])).rows.map((r) => r.data || {});
        let cashSettled = 0;
        for (const st of settleRows) if (/^cash$/i.test(String(st.method || "cash"))) cashSettled += Number(st.amount) || 0;
        /* AUDIT-C3: cash pulled from the drawer mid-shift (a petty-cash spend,
           a till-to-safe drop — an `expenses` row with type:'paidout') never
           left the drawer through a sale, so it must come off expected the
           same way a cash refund does — otherwise every payout manufactures a
           "shortage" the cashier is blamed for. */
        const payoutRows = (await c.query(
          "SELECT data FROM entities WHERE org_id=$1 AND kind='expenses' AND deleted=false AND data->>'type'='paidout' AND COALESCE((data->>'t')::numeric,(data->>'at')::numeric,(data->>'createdAt')::numeric,0) >= $2 AND COALESCE(data->>'storeId',$3)=$3",
          [orgId, sinceOpen, data.storeId || storeId])).rows.map((r) => r.data || {});
        let cashPaidOut = 0;
        for (const po of payoutRows) cashPaidOut += Number(po.amount) || 0;
        const float = Number(data.float) || 0;
        const expected = float + cashSales + cashSettled - cashPaidOut, variance = counted - expected;
        Object.assign(data, { status: "closed", closedAt: Date.now(), counted, cashSales, cashSettled, cashPaidOut, cashRefunds, refunds, expected, variance, grossSales: gross, closedBy: staffName || data.staffName || "" });
        const r = await c.query("UPDATE entities SET data=$3, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='shifts' AND id=$2 RETURNING rowver", [orgId, data.id, JSON.stringify(data)]);
        return { rowver: Number(r.rows[0].rowver), data };
      });
      if (!out) return res.status(404).json({ error: "no open shift" });
      poke(orgId, out.rowver);
      logActivity(orgId, { actor: staffName || "cashier", action: "shift.close", ref: out.data.id, requestId: req.id, detail: { counted: out.data.counted, expected: out.data.expected, variance: out.data.variance } });
      return res.json({ ok: true, shift: { id: out.data.id, counted: out.data.counted / 100, expected: out.data.expected / 100, variance: out.data.variance / 100, cashSales: out.data.cashSales / 100 } });
    }
    return res.status(400).json({ error: "bad action" });
  }));
  // Back-office cockpit config store: Configurations, Payments, Notifications,
  // System Admin, Online Store and Kitchen-routing toggles all persist here as
  // a single `adminCfg` blob on the settings entity, kept apart from the till's
  // own settings keys (currency/gst/pin…). Accepts a partial patch and shallow-
  // merges it, so each section can save just its own slice.
  app.post("/api/app2/config", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.ADMIN, "Changing store settings needs an admin or the owner.")) return;
    const patch = (req.body && req.body.cfg && typeof req.body.cfg === "object") ? req.body.cfg : null;
    if (!patch) return res.status(400).json({ error: "no config" });
    const out = await withOrg(orgId, async (c) => {
      // Read the CANONICAL settings row (id='settings') — the one every reader
      // uses (buildV2Real, buildGuestReal, liveStoreP). The old path took "most
      // recently updated", which could diverge from 'settings' if a second
      // settings row ever existed, sending a rename to a row nobody displays.
      const allSet = (await c.query(
        "SELECT id, data FROM entities WHERE org_id=$1 AND kind='settings' AND deleted=false ORDER BY (id='settings') DESC, updated_at DESC", [orgId])).rows;
      const cur = allSet[0];
      const data = Object.assign({}, cur ? cur.data : {});
      data.adminCfg = Object.assign({}, data.adminCfg || {}, patch);
      /* The sector selector used to change a LABEL only. data.gstBp stayed at
         800 while the till charged 17%, so every tourism sale failed the
         server's money-integrity check and landed in the review tab — and the
         guest portal, the order totals and the reports all disagreed with the
         receipt. The rate is the setting; the label follows it. */
      if (patch.taxRate === "tgst" || patch.taxRate === "ggst") {
        data.gstBp = patch.taxRate === "tgst" ? 1700 : 800;
      }
      /* Same for the service charge: the only control was a toggle published
         through localStorage, so a manager switching it on a laptop never
         reached the tablet at the counter. It is a store setting in basis
         points now, and the register reads it from the server. */
      if (patch.svc10 !== undefined) data.svcChargeBp = patch.svc10 === false ? 0 : 1000;
      if (patch.tableCount !== undefined) {
        const n = Math.round(Number(patch.tableCount));
        if (n > 0 && n <= 200) data.tableCount = n;
      }
      if (Array.isArray(patch.hotCats)) data.hotCats = patch.hotCats.map((x) => String(x).slice(0, 40)).slice(0, 40);
      if (patch.svcChargeBp !== undefined) {
        const bp = Math.round(Number(patch.svcChargeBp));
        if (bp >= 0 && bp <= 5000) data.svcChargeBp = bp;
      }
      /* Loyalty configuration for the registered-customer portal: the earn rate,
         tier thresholds/marks and the reward catalogue are DATA, not code
         (handoff 08 §9). Stored on the settings entity so /member/me + the portal
         rewards read them; the gradients and the four-tier visual language stay
         client-side design tokens. */
      if (patch.pointsPer !== undefined) { const n = Math.round(Number(patch.pointsPer)); if (n >= 1 && n <= 1000) data.pointsPer = n; }
      if (patch.loyalty && typeof patch.loyalty === "object") {
        const L = Object.assign({}, data.loyalty || {});
        if (Array.isArray(patch.loyalty.tiers)) {
          L.tiers = patch.loyalty.tiers.slice(0, 8).map((t) => ({ key: String((t && t.key) || "tier").slice(0, 24), name: String((t && t.name) || "Tier").slice(0, 40), mark: String((t && t.mark) || "").slice(0, 4), from: Math.max(0, Math.round(Number(t && t.from) || 0)) })).sort((a, b) => a.from - b.from);
        }
        if (Array.isArray(patch.loyalty.rewards)) {
          L.rewards = patch.loyalty.rewards.slice(0, 40).map((r) => ({ id: String((r && r.id) || uid()).slice(0, 40), name: String((r && r.name) || "Reward").slice(0, 80), sub: String((r && r.sub) || "").slice(0, 120), cost: Math.max(0, Math.round(Number(r && r.cost) || 0)), img: String((r && r.img) || "").slice(0, 400), tierRequired: (r && r.tierRequired) ? String(r.tierRequired).slice(0, 24) : "", active: !(r && r.active === false) }));
        }
        if (patch.loyalty.redeemPer !== undefined) { const n = Math.round(Number(patch.loyalty.redeemPer)); if (n >= 1 && n <= 1000) L.redeemPer = n; }
        data.loyalty = L;
      }
      /* Promotions & banners (handoff 08 §1). qrBanners is the merchant's slot
         switch (default off — a QR menu that opens with an advert nobody asked
         for is worse than one that opens with food). The banners array is the
         drafts; turning the slot off empties every phone without deleting them. */
      if (patch.qrBanners !== undefined) data.qrBanners = !!patch.qrBanners;
      if (Array.isArray(patch.banners)) {
        data.banners = patch.banners.slice(0, 40).map((b) => ({ id: String((b && b.id) || uid()).slice(0, 40), title: String((b && b.title) || "").slice(0, 80), sub: String((b && b.sub) || "").slice(0, 140), code: String((b && b.code) || "").slice(0, 24), img: String((b && b.img) || "").slice(0, 400), outlet: String((b && b.outlet) || "0").slice(0, 40), active: !(b && b.active === false) }));
      }
      // Promote store identity to the top-level settings fields the register
      // (liveStoreP) and the admin store card actually read, so a rename in the
      // cockpit is reflected on the till instead of only living inside adminCfg.
      if (patch.store && typeof patch.store === "object") {
        const st = patch.store;
        const nm = String(st.name || "").trim();
        if (nm) {
          data.storeName = nm.slice(0, 80);
          // Keep the PRIMARY store's row in step with the trading name. The guest
          // storefront maps stores → outlets (outlet line, picker, receipt outlet)
          // and /admin + reports read stores.name too, so without this a rename in
          // Merchant branding updated the header brand but stranded the outlet name
          // on the old value. Only the default store follows the brand; named
          // branches in a chain keep their own names.
          await c.query("UPDATE stores SET name=$3 WHERE org_id=$1 AND id=$2", [orgId, DEFAULT_STORE_ID, data.storeName]);
        }
        /* Changing the store currency used to relabel every price without
           converting it: a MVR 100 dish silently became a USD 100 dish, a
           15.42x overcharge, because the stored value is just an integer in the
           store's own minor unit. Convert the catalogue at the store's recorded
           rate so the numbers keep meaning the same thing, and record that we
           did it. Prices are the only thing converted — historic sales are
           left exactly as they were charged. */
        const cur3 = String(st.currency || "").trim();
        if (cur3) {
          const want = cur3.toUpperCase() === "USD" ? "USD" : "MVR";
          const have = data.currency || "MVR";
          if (want !== have) {
            const rate = Number(data.usdRate) || 1542;   // MVR per USD, x100
            const factor = want === "USD" ? (100 / rate) : (rate / 100);
            const prods = (await c.query(
              "SELECT id, data FROM entities WHERE org_id=$1 AND kind='products' AND deleted=false", [orgId])).rows;
            for (const pr of prods) {
              const pd = Object.assign({}, pr.data || {});
              let touched = false;
              for (const k of ["price", "cost"]) {
                const v = Number(pd[k]);
                if (v > 0) { pd[k] = Math.max(1, Math.round(v * factor)); touched = true; }
              }
              if (Array.isArray(pd.addons)) {
                pd.addons = pd.addons.map((ad) => {
                  const v = Number(ad && ad.price);
                  return (v > 0) ? Object.assign({}, ad, { price: Math.round(v * factor) }) : ad;
                });
                touched = true;
              }
              if (touched) await c.query(
                "UPDATE entities SET data=$3, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='products' AND id=$2",
                [orgId, pr.id, JSON.stringify(pd)]);
            }
            data.currencyChangedAt = Date.now();
            data.currencyChangedFrom = have;
            data.currencyChangeRate = rate;
          }
          data.currency = want;
        }
        // Promote the rest of the store profile to the top-level settings fields the
        // register (liveStoreP) + receipt + inv/settings read, so /admin's config
        // persists identically to /back's Settings — the two are now one source.
        if (st.tin != null) data.tin = String(st.tin).slice(0, 40);
        if (st.greg != null) data.gstRegNo = String(st.greg).slice(0, 40);
        if (st.legal != null) data.legalName = String(st.legal).slice(0, 120);
        // Business activity chosen at onboarding, editable in Company details —
        // drives which modules the terminal shows. Whitelisted; "" clears it.
        if (st.activity != null) {
          const ACT = ["", "restaurant", "cafe", "bakery", "retail", "grocery", "salon", "services", "other"];
          const a = String(st.activity);
          if (ACT.indexOf(a) >= 0) data.businessActivity = a;
        }
        if (st.phone != null) data.phone = String(st.phone).slice(0, 40);
        if (st.island != null) data.island = String(st.island).slice(0, 60);
        if (st.atoll != null) data.atoll = String(st.atoll).slice(0, 60);
        if (st.addr != null) data.address = String(st.addr).slice(0, 200);
        if (st.footer != null) data.receiptFooter = String(st.footer).slice(0, 200);
        if (st.logo !== undefined) data.logo = st.logo || "";
        // Storefront branding the guest/QR portal renders in the store's own
        // identity: tagline under the name, an accent that repaints the portal
        // (a named palette key OR a #rrggbb the client resolves), and a
        // white-label switch that drops the "Powered by KashikeyoPOS" line.
        if (st.tagline != null) data.tagline = String(st.tagline).slice(0, 120);
        if (st.accent != null) data.accent = String(st.accent).slice(0, 24);
        if (st.whiteLabel !== undefined) data.whiteLabel = !!st.whiteLabel;
        if (st.usdRate != null && st.usdRate !== "") {
          const r = Math.round(parseFloat(st.usdRate) * 100);
          if (r > 0) data.usdRate = Math.min(1000000, r);
        }
      }
      // Always persist to the canonical id='settings' row (upsert) — never to a
      // stray duplicate — so a rename lands exactly where the storefront, terminal
      // and admin read it back.
      const r = await c.query(
        `INSERT INTO entities (org_id, kind, id, data, rowver) VALUES ($1,'settings','settings',$2,nextval('entities_rowver_seq'))
         ON CONFLICT (org_id, kind, id) DO UPDATE SET data=$2, deleted=false, rowver=nextval('entities_rowver_seq'), updated_at=now() RETURNING rowver`,
        [orgId, JSON.stringify(data)]);
      // Diagnostic (no secrets): reveals a settings-row split, confirms the name
      // actually written, and prints the org's current handle (slug) so its live
      // storefront link — kashikeyopos.com/?s=<slug> — is answerable from logs.
      if (patch.store) {
        let slug = null;
        try { slug = ((await withSystem((sc) => sc.query("SELECT slug FROM orgs WHERE id=$1", [orgId]))).rows[0] || {}).slug || null; } catch (e) { /* non-fatal */ }
        try { console.log("app2/config store", JSON.stringify({ org: orgId, slug: slug, settingsRows: allSet.length, curId: (cur && cur.id) || null, nameIn: (patch.store.name != null ? String(patch.store.name) : null), storeName: data.storeName || null })); } catch (e) { /* non-fatal */ }
      }
      return { rowver: Number(r.rows[0].rowver), adminCfg: data.adminCfg };
    });
    poke(orgId, out.rowver);
    res.json({ ok: true, adminCfg: out.adminCfg });
  }));
  // Store handle (orgs.slug): the address of the QR/guest storefront — the
  // `?s=<handle>` param today and the `<handle>.<domain>` subdomain later. An
  // admin can rename it; it is slugified, length- and reserved-word checked,
  // and unique per platform (the DB UNIQUE constraint is the real guard).
  // Changing it re-points the storefront, so printed QR codes with the old
  // handle stop resolving — the client warns before saving. RESERVED_HANDLES is
  // defined at module scope (shared with the auto-derive-from-store-name path).
  app.post("/api/app2/handle", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.ADMIN, "Changing the store handle needs an admin or the owner.")) return;
    const handle = String((req.body && req.body.handle) || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
    if (handle.length < 3) return res.status(400).json({ error: "A handle needs at least 3 characters — letters, digits and hyphens." });
    if (RESERVED_HANDLES.has(handle)) return res.status(400).json({ error: "That handle is reserved — pick another." });
    const result = await withSystem(async (c) => {
      try {
        const r = await c.query("UPDATE orgs SET slug=$1 WHERE id=$2 RETURNING slug", [handle, orgId]);
        return { ok: true, handle: r.rows[0] && r.rows[0].slug };
      } catch (e) {
        if (String(e && e.code) === "23505") return { taken: true };
        throw e;
      }
    });
    if (result.taken) return res.status(409).json({ error: "That handle is already taken — try another." });
    logActivity(orgId, { actor: "admin", action: "store.handle", ref: handle, requestId: req.id, detail: {} });
    res.json({ ok: true, handle: result.handle });
  }));
  // Telegram alert test-send. Mirrors the AI features' graceful-degrade
  // contract: with no TELEGRAM_BOT_TOKEN in the environment it reports
  // configured:false (the cockpit shows "not set up yet"); once the token is
  // added it sends a real message to the chat id the owner connected, so the
  // notifications channel works without any further code change.
  app.post("/api/app2/notify/test", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.ADMIN, "Managing notifications needs an admin or the owner.")) return;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = String((req.body && req.body.chatId) || "").trim();
    if (!token) return res.json({ ok: true, configured: false, message: "Telegram alerts aren't set up yet. Add TELEGRAM_BOT_TOKEN to switch them on." });
    if (!chatId) return res.status(400).json({ error: "enter a chat id or @channel" });
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: "✅ KashikeyoPOS test alert — notifications are connected." }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) return res.json({ ok: false, configured: true, message: (j && j.description) || "Telegram rejected the message. Check the chat id." });
      return res.json({ ok: true, configured: true, message: "Test message sent." });
    } catch (e) { recordError("telegram test", e); return res.json({ ok: false, configured: true, message: "Couldn't reach Telegram. Try again." }); }
  }));
  // ── Staff & Roles: real user management ──────────────────────────────────
  // The cockpit is already gated to owner/admin/manager (via /login or
  // /api/back/login), so a valid app session may manage team members. This
  // creates/updates a real `users` entity — the same record the till PIN login
  // and back-office login read — so a member added here can actually sign in,
  // and their role is the control (owner/admin/manager reach the back office;
  // cashier/waiter/kitchen are till-only). The owner role is never assignable
  // here (there is exactly one owner, seeded at registration).
  const ASSIGNABLE_ROLES = new Set(["manager", "cashier", "waiter", "kitchen", "rider"]);
  app.post("/api/app2/staff", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.ADMIN, "Managing team members needs an admin or the owner.")) return;
    const b = req.body || {};
    const name = String(b.name || "").trim().slice(0, 80);
    const role = String(b.role || "").toLowerCase();
    const pin = String(b.pin || "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });
    if (!ASSIGNABLE_ROLES.has(role)) return res.status(400).json({ error: "pick a role: manager, cashier, waiter, kitchen or rider" });
    if (pin && !/^\d{4}$/.test(pin)) return res.status(400).json({ error: "PIN must be 4 digits" });
    const out = await withOrg(orgId, async (c) => {
      const id = String(b.id || "").trim();
      let existing = null;
      if (id) existing = (await c.query("SELECT data FROM entities WHERE org_id=$1 AND kind='users' AND id=$2 AND deleted=false", [orgId, id])).rows[0];
      if (existing && existing.data && existing.data.role === "owner") throw Object.assign(new Error("the owner account can't be edited here"), { status: 400 });
      // A PIN must be unique within the org so login can't be ambiguous.
      if (pin) {
        const want = hashTillPin(pin);
        const clash = (await c.query("SELECT id FROM entities WHERE org_id=$1 AND kind='users' AND deleted=false AND data->>'pin'=$2", [orgId, want])).rows[0];
        if (clash && clash.id !== id) throw Object.assign(new Error("that PIN is already used by another member"), { status: 409 });
      }
      if (existing) {
        const data = Object.assign({}, existing.data, { name, role });
        if (pin) data.pin = hashTillPin(pin);
        const r = await c.query("UPDATE entities SET data=$3, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='users' AND id=$2 RETURNING rowver", [orgId, id, JSON.stringify(data)]);
        return { rowver: Number(r.rows[0].rowver), id, created: false };
      }
      if (!pin) throw Object.assign(new Error("set a 4-digit PIN for the new member"), { status: 400 });
      const nid = uid();
      const data = { id: nid, name, role, pin: hashTillPin(pin) };
      const r = await c.query("INSERT INTO entities (org_id, kind, id, data, rowver) VALUES ($1,'users',$2,$3,nextval('entities_rowver_seq')) RETURNING rowver", [orgId, nid, JSON.stringify(data)]);
      return { rowver: Number(r.rows[0].rowver), id: nid, created: true };
    });
    poke(orgId, out.rowver);
    res.json({ ok: true, id: out.id, created: out.created });
  }));
  app.post("/api/app2/staff/:id/delete", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.ADMIN, "Managing team members needs an admin or the owner.")) return;
    const id = String(req.params.id || "");
    const out = await withOrg(orgId, async (c) => {
      const cur = (await c.query("SELECT data FROM entities WHERE org_id=$1 AND kind='users' AND id=$2 AND deleted=false", [orgId, id])).rows[0];
      if (!cur) return null;
      if (cur.data && cur.data.role === "owner") throw Object.assign(new Error("the owner account can't be removed"), { status: 400 });
      const r = await c.query("UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='users' AND id=$2 RETURNING rowver", [orgId, id]);
      return { rowver: Number(r.rows[0].rowver) };
    });
    if (out == null) return res.status(404).json({ error: "member not found" });
    poke(orgId, out.rowver);
    res.json({ ok: true });
  }));

  /* ── Store backup / reset / restore (admin/owner only) ──────────────────────
     These are the only endpoints that can destroy a merchant's business in one
     call, so they carry more than the admin-role check:
       - the confirmation PIN is rate-limited like a password (it is only four
         digits, so an unthrottled
         endpoint is ~10k guesses from a wipe);
       - snapshots are size-capped, because materialising one is several times
         its own size in RSS and an OOM takes down every tenant on the instance;
       - every destructive action, including deleting a backup, is written to the
         append-only activity log. */
  const destructiveGuard = async (req, res, orgId, what) => {
    const keys = rlKeys(req, "storepw:" + orgId);
    const blocked = rlBlockedFor(keys);
    if (blocked) { res.status(429).json({ error: "Too many failed attempts. Try again in " + blocked + "s." }); return false; }
    if (!(await verifyOwnerPassword(orgId, (req.body || {}).password))) {
      rlFail(keys);
      logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "admin", action: "store." + what + ".denied", requestId: req.id });
      res.status(403).json({ error: "That isn\u2019t the owner\u2019s account password." });
      return false;
    }
    rlClear(keys);
    return true;
  };
  const backupFailed = (res, verb, e) => {
    recordError("store." + verb, e);
    const clean = (e instanceof SnapshotTooLarge) || (e instanceof BadSnapshot);
    res.status(clean ? 400 : 500).json({ error: (clean ? "" : verb[0].toUpperCase() + verb.slice(1) + " failed: ") + ((e && e.message) || "error") });
  };
  // Newest 20 per org, so repeated resets can't grow the table without bound.
  const pruneBackups = (c, orgId) => c.query(
    "DELETE FROM store_backups WHERE org_id=$1 AND id NOT IN (SELECT id FROM store_backups WHERE org_id=$1 ORDER BY created_at DESC LIMIT 20)", [orgId]);

  app.get("/api/app2/backups", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.ADMIN, "Backups need an admin or the owner.")) return;
    const r = await withOrg(orgId, (c) => c.query(
      "SELECT id, label, reason, counts, created_at FROM store_backups WHERE org_id=$1 ORDER BY created_at DESC LIMIT 50", [orgId]));
    res.json({ backups: r.rows.map((b) => ({ id: b.id, label: b.label, reason: b.reason, counts: b.counts, createdAt: new Date(b.created_at).getTime() })) });
  }));

  app.post("/api/app2/backup", pubThrottle(6, "backup"), wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.ADMIN, "Backups need an admin or the owner.")) return;
    const label = String((req.body || {}).label || "").trim().slice(0, 80) || ("Backup · " + new Date().toLocaleString("en-GB"));
    const reason = String((req.body || {}).reason || "manual").slice(0, 20);
    const id = uid();
    try {
      const counts = await withOrg(orgId, async (c) => {
        const snap = await snapshotStoreIn(c, orgId);
        const n = backupCounts(snap);
        await c.query("INSERT INTO store_backups (id, org_id, label, reason, counts, data) VALUES ($1,$2,$3,$4,$5,$6)",
          [id, orgId, label, reason, JSON.stringify(n), JSON.stringify(snap)]);
        await pruneBackups(c, orgId);
        return n;
      });
      logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "admin", action: "store.backup", ref: label, requestId: req.id });
      res.json({ ok: true, id, label, counts });
    } catch (e) { backupFailed(res, "backup", e); }
  }));

  /* Deleting a backup is irreversible and can strip away the pre-reset copy that
     is the only route back, so it takes the same PIN as a reset and is logged. */
  app.post("/api/app2/backup/:id/delete", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.OWNER, "Only the account owner can delete a backup.")) return;
    if (!(await destructiveGuard(req, res, orgId, "backup.delete"))) return;
    const id = String(req.params.id || "");
    try {
      const r = await withOrg(orgId, (c) => c.query("DELETE FROM store_backups WHERE org_id=$1 AND id=$2 RETURNING label", [orgId, id]));
      if (!r.rowCount) return res.status(404).json({ error: "Backup not found." });
      logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "admin", action: "store.backup.deleted", ref: r.rows[0].label || id, requestId: req.id });
      res.json({ ok: true });
    } catch (e) { backupFailed(res, "delete", e); }
  }));

  app.post("/api/app2/restore", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.OWNER, "Only the account owner can restore a backup.")) return;
    if (!(await destructiveGuard(req, res, orgId, "restore"))) return;
    const b = req.body || {};
    const row = (await withOrg(orgId, (c) => c.query("SELECT data FROM store_backups WHERE org_id=$1 AND id=$2", [orgId, String(b.id || "")]))).rows[0];
    if (!row) return res.status(404).json({ error: "Backup not found." });
    try {
      const maxRowver = await restoreStore(orgId, row.data);
      poke(orgId, maxRowver);
      logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "admin", action: "store.restore", ref: String(b.id || ""), requestId: req.id });
      res.json({ ok: true });
    } catch (e) { backupFailed(res, "restore", e); }
  }));

  app.post("/api/app2/reset", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.OWNER, "Only the account owner can reset the store.")) return;
    if (!(await destructiveGuard(req, res, orgId, "reset"))) return;
    const b = req.body || {};
    /* Scope: omitted (or "*") wipes the whole account; otherwise one outlet, which
       must actually belong to this org — never trust an id off the wire. */
    const wanted = String(b.storeId || "").trim();
    let scope = "*", scopeName = "all outlets";
    if (wanted && wanted !== "*") {
      const st = (await withOrg(orgId, (c) => c.query("SELECT id, name FROM stores WHERE org_id=$1 AND id=$2", [orgId, wanted]))).rows[0];
      if (!st) return res.status(400).json({ error: "That outlet doesn't exist." });
      scope = st.id; scopeName = st.name || st.id;
    }
    try {
      /* Snapshot and wipe share one transaction: taken separately, anything that
         synced in between would be destroyed WITHOUT being in the safety copy.
         The snapshot is always account-wide, even for a single-outlet reset —
         restoring is all-or-nothing, so a partial copy would be a trap. */
      const out = await withOrg(orgId, async (c) => {
        let backupId = null;
        if (b.backup) {
          const snap = await snapshotStoreIn(c, orgId);
          backupId = uid();
          await c.query("INSERT INTO store_backups (id, org_id, label, reason, counts, data) VALUES ($1,$2,$3,'pre-reset',$4,$5)",
            [backupId, orgId, "Before reset · " + scopeName + " · " + new Date().toLocaleString("en-GB"), JSON.stringify(backupCounts(snap)), JSON.stringify(snap)]);
          await pruneBackups(c, orgId);
        }
        return { backupId, maxRowver: await resetStoreIn(c, orgId, scope) };
      });
      poke(orgId, out.maxRowver);
      /* A scoped reset leaves the shared ingredient catalogue in place but has
         just changed how much stock backs it, so the sold-out state computed onto
         each product entity has to be recalculated. */
      if (!isAllOutlets(scope) && inventory && typeof inventory.recomputeAvailability === "function") {
        try {
          const ids = (await withOrg(orgId, (c) => c.query("SELECT id FROM ingredients WHERE org_id=$1", [orgId]))).rows.map((x) => x.id);
          if (ids.length) await inventory.recomputeAvailability(orgId, ids);
        } catch (e) { recordError("store.reset.availability", e); }
      }
      logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "admin", action: "store.reset",
        ref: scopeName + (out.backupId ? " · backup kept" : " · no backup"), requestId: req.id });
      res.json({ ok: true, backupId: out.backupId, scope, scopeName });
    } catch (e) { backupFailed(res, "reset", e); }
  }));

  /* Real scannable table QR codes. The admin used to render one decorative SVG
     for every table — it encoded nothing, so an owner who printed them handed
     guests images that don't scan. Generated from the outlet's actual portal
     link. Degrades like the other optional integrations: without the `qrcode`
     package the endpoint 503s and the UI shows the link instead of a dead
     image. */
  app.get("/api/app2/qr.svg", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    let QR = null;
    try { QR = require("qrcode"); } catch (e) { return res.status(503).json({ error: "QR generation isn't available on this server." }); }
    const org = (await withOrg(orgId, (c) => c.query("SELECT slug FROM orgs WHERE id=$1", [orgId]))).rows[0];
    if (!org || !org.slug) return res.status(404).json({ error: "no portal link yet" });
    const table = String(req.query.t || "").replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 12);
    // On a branded subdomain the host itself carries the store, so the QR needs
    // no ?s= — just the table. Off it, keep the ?s=<slug> query link.
    const base = portalOriginForSlug(org.slug, req);
    const link = PORTAL_BASE_DOMAINS.length
      ? base + "/" + (table ? "?t=" + encodeURIComponent(table) : "")
      : base + "/?s=" + encodeURIComponent(org.slug) + (table ? "&t=" + encodeURIComponent(table) : "");
    try {
      // A 4-module quiet zone is what the QR spec requires; the old margin:1
      // rendered a code many phone cameras refused to lock onto.
      const svg = await QR.toString(link, { type: "svg", margin: 4, errorCorrectionLevel: "M" });
      res.set("Content-Type", "image/svg+xml").set("Cache-Control", "private, max-age=300").send(svg);
    } catch (e) { recordError("qr.svg", e); res.status(500).json({ error: "Couldn't build that QR code." }); }
  }));

  // Add the starter menu on demand (the post-reset "add a menu" action). Clears
  // the skip flag and seeds the shared default menu + categories.
  app.post("/api/app2/seed-menu", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.ADMIN, "Adding the menu needs an admin or the owner.")) return;
    try {
      await withOrg(orgId, (c) => c.query("UPDATE orgs SET skip_default_menu=false WHERE id=$1", [orgId]));
      await seedSampleCategories(orgId);
      const mx = (await withOrg(orgId, (c) => c.query("SELECT COALESCE(MAX(rowver),0) AS m FROM entities WHERE org_id=$1", [orgId]))).rows[0].m;
      poke(orgId, Number(mx));
      res.json({ ok: true });
    } catch (e) { recordError("store.seed-menu", e); res.status(500).json({ error: "Add menu failed: " + ((e && e.message) || "error") }); }
  }));

  /* Start fresh: clear EVERY dish (tombstone) and lay down the sample category
     sections, so a store that was seeded with the old starter dishes lands on a
     clean, empty, categorised menu — the same state a brand-new store onboards
     into. Destructive (removes all products), so it's owner/admin only. Past
     orders keep their line snapshots; only the live menu is cleared. */
  app.post("/api/app2/menu/reset", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.ADMIN, "Resetting the menu needs an admin or the owner.")) return;
    try {
      const purged = await withOrg(orgId, async (c) => {
        const d = await c.query("UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now() WHERE org_id=$1 AND kind='products' AND deleted=false", [orgId]);
        return d.rowCount || 0;
      });
      await withOrg(orgId, (c) => c.query("UPDATE orgs SET skip_default_menu=false WHERE id=$1", [orgId]));
      const cats = await seedSampleCategories(orgId);
      logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "", action: "menu.reset", ref: "", detail: { purged, cats } });
      const mx = (await withOrg(orgId, (c) => c.query("SELECT COALESCE(MAX(rowver),0) AS m FROM entities WHERE org_id=$1", [orgId]))).rows[0].m;
      poke(orgId, Number(mx));
      res.json({ ok: true, purged, categories: cats });
    } catch (e) { recordError("store.menu-reset", e); res.status(500).json({ error: "Reset failed: " + ((e && e.message) || "error") }); }
  }));

  // Sessions: list active cookie sessions for this org, and revoke one (or all
  // but the current). Admin+; the current device is flagged and can't be
  // revoked here (use Sign out for that).
  app.get("/api/app2/sessions", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.ADMIN, "Managing sessions needs an admin or the owner.")) return;
    const curSid = sidOf(parseCookies(req)[APP_COOKIE]);
    const rows = (await withOrg(orgId, (c) => c.query(
      "SELECT sid, name, role, register, device, ip, created_at, last_seen FROM app_sessions WHERE org_id=$1 AND revoked=false ORDER BY last_seen DESC LIMIT 50", [orgId]))).rows;
    res.json({ sessions: rows.map((r) => ({
      sid: r.sid, current: r.sid === curSid, name: r.name || "—", role: r.role || "", register: r.register || "",
      device: r.device || "—", ip: r.ip || "", since: Number(new Date(r.created_at)), lastSeen: Number(new Date(r.last_seen)) })) });
  }));
  app.post("/api/app2/sessions/revoke", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.ADMIN, "Managing sessions needs an admin or the owner.")) return;
    const b = req.body || {};
    const curSid = sidOf(parseCookies(req)[APP_COOKIE]);
    const actor = (req.appStaff && req.appStaff.name) || "admin";
    if (b.all) {
      await withOrg(orgId, (c) => c.query("UPDATE app_sessions SET revoked=true WHERE org_id=$1 AND sid<>$2", [orgId, curSid]));
      logActivity(orgId, { actor, action: "sessions.revoked_all", requestId: req.id, detail: {} });
      return res.json({ ok: true });
    }
    const sid = String(b.sid || "");
    if (!sid) return res.status(400).json({ error: "which session?" });
    if (sid === curSid) return res.status(400).json({ error: "That's this device — use Sign out instead." });
    await withOrg(orgId, (c) => c.query("UPDATE app_sessions SET revoked=true WHERE org_id=$1 AND sid=$2", [orgId, sid]));
    logActivity(orgId, { actor, action: "session.revoked", ref: sid.slice(0, 8), requestId: req.id, detail: {} });
    res.json({ ok: true });
  }));
  /* AUDIT-SEC-PIN: the flip side of pairing — an admin/owner needs to see
     which devices can reach the back office on a PIN alone, and revoke one
     that's lost or no longer trusted (a permanent grant with no revoke path
     would be a one-way ratchet). Same shape as /api/app2/sessions. */
  app.get("/api/app2/devices", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.ADMIN, "Managing paired devices needs an admin or the owner.")) return;
    const curDeviceId = parseCookies(req)[DEVICE_COOKIE] || "";
    const rows = (await withOrg(orgId, (c) => c.query(
      "SELECT device_id, name, ip, paired_at, last_seen FROM paired_devices WHERE org_id=$1 AND revoked=false ORDER BY last_seen DESC LIMIT 50", [orgId]))).rows;
    res.json({ devices: rows.map((r) => ({
      deviceId: r.device_id, current: r.device_id === curDeviceId, name: r.name || "—", ip: r.ip || "",
      pairedAt: Number(new Date(r.paired_at)), lastSeen: Number(new Date(r.last_seen)) })) });
  }));
  app.post("/api/app2/devices/revoke", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.ADMIN, "Managing paired devices needs an admin or the owner.")) return;
    const deviceId = String((req.body || {}).deviceId || "");
    if (!deviceId) return res.status(400).json({ error: "which device?" });
    const actor = (req.appStaff && req.appStaff.name) || "admin";
    await withOrg(orgId, (c) => c.query("UPDATE paired_devices SET revoked=true WHERE org_id=$1 AND device_id=$2", [orgId, deviceId]));
    logActivity(orgId, { actor, action: "device.revoked", ref: deviceId.slice(0, 8), requestId: req.id, detail: {} });
    res.json({ ok: true });
  }));
  // Outlets: CRUD on the real stores table (multi-store). Admin+. The default
  // "main" store can be renamed but never deactivated — login, the till and the
  // guest portal all fall back to it — and the org must always keep one active
  // outlet. adminData.outlets (injected into /admin) is the read side.
  app.post("/api/app2/outlets", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.ADMIN, "Adding an outlet needs an admin or the owner.")) return;
    const b = req.body || {};
    const name = String(b.name || "").trim();
    if (!name) return res.status(400).json({ error: "Outlet name is required." });
    let code = String(b.code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
    if (!code) code = (name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12)) || ("OUT" + Date.now().toString().slice(-5));
    const id = cleanStoreId(code.toLowerCase());
    const address = String(b.address || "").trim();
    try {
      await withOrg(orgId, (c) => c.query(
        "INSERT INTO stores (org_id, id, code, name, address) VALUES ($1,$2,$3,$4,$5)",
        [orgId, id, code, name, address]));
    } catch (e) {
      if (/duplicate|unique/i.test(String(e && e.message))) return res.status(409).json({ error: "An outlet with that code already exists." });
      recordError("outlet create", e); return res.status(500).json({ error: "Could not add outlet." });
    }
    logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "admin", action: "outlet.created", ref: code, requestId: req.id, detail: { name } });
    res.json({ ok: true, outlet: { id, code, name, address, active: true } });
  }));
  app.patch("/api/app2/outlets/:id", wrap(async (req, res) => {
    const orgId = await resolveAppSession(req);
    if (!orgId) return res.status(401).json({ error: "no session" });
    if (denyAppRole(req, res, APP_RANK.ADMIN, "Editing an outlet needs an admin or the owner.")) return;
    const id = cleanStoreId(req.params.id);
    const b = req.body || {};
    const sets = []; const vals = [orgId, id]; let i = 3;
    if (b.name != null) { const nm = String(b.name).trim(); if (!nm) return res.status(400).json({ error: "Outlet name can't be empty." }); sets.push(`name=$${i++}`); vals.push(nm); }
    if (b.address != null) { sets.push(`address=$${i++}`); vals.push(String(b.address).trim()); }
    if (b.active != null) {
      const active = !!b.active;
      if (!active && id === cleanStoreId(DEFAULT_STORE_ID)) return res.status(400).json({ error: "The main outlet can't be deactivated." });
      if (!active) {
        const act = await withOrg(orgId, (c) => c.query("SELECT count(*)::int AS n FROM stores WHERE org_id=$1 AND active=true", [orgId]));
        if ((act.rows[0].n || 0) <= 1) return res.status(400).json({ error: "At least one outlet must stay active." });
      }
      sets.push(`active=$${i++}`); vals.push(active);
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update." });
    const r = await withOrg(orgId, (c) => c.query(`UPDATE stores SET ${sets.join(", ")} WHERE org_id=$1 AND id=$2`, vals));
    if (!r.rowCount) return res.status(404).json({ error: "Outlet not found." });
    logActivity(orgId, { actor: (req.appStaff && req.appStaff.name) || "admin", action: "outlet.updated", ref: id, requestId: req.id, detail: b });
    res.json({ ok: true });
  }));
}
/* Post-social-login onboarding: name the store, pick currency + PIN. Only
   meaningful while the org is un-onboarded; afterwards it's just /app. */
app.get("/welcome", (req, res) => {
  resolveAppSession(req).then((orgId) => {
    if (!orgId) return res.redirect(302, "/login");
    if (req.kOnboarded) return res.redirect(302, "/v2");
    res.sendFile(path.join(siteDir, "welcome.html"));
  }).catch(() => res.redirect(302, "/login"));
});
/* Clean URLs for the marketing content pages (footer links). The files also
   sit in siteDir so /docs.html etc. resolve via express.static above; these
   just give them the extensionless paths used across the site. */
for (const p of ["docs", "api", "status", "privacy", "terms"]) {
  app.get("/" + p, (req, res) => res.sendFile(path.join(siteDir, p + ".html")));
}

/* Shown when a storefront URL (…/?s=<handle> or <handle>.<domain>) matches no
   live store — a stale QR or a handle that was changed. Deliberately plain and
   self-contained (no external assets) so it can never be mistaken for a real
   store the way the old demo-till fallback was. */
const STOREFRONT_NOT_FOUND_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Storefront not found</title>
<style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;
font-family:'Inter',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f4f1;color:#1c1917;padding:24px}
@media(prefers-color-scheme:dark){body{background:#14110f;color:#f5f3f0}.card{background:#1e1a17;border-color:#2c2622}}
.card{max-width:420px;width:100%;background:#fff;border:1px solid #eee7e0;border-radius:18px;padding:34px 28px;text-align:center;
box-shadow:0 12px 40px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 10px}p{font-size:14.5px;line-height:1.6;color:#78716c;margin:0 0 6px}
.mark{width:52px;height:52px;border-radius:14px;background:#C7431D;color:#fff;display:grid;place-items:center;margin:0 auto 18px;
font-weight:800;font-size:22px}</style></head><body><div class="card"><div class="mark">K</div>
<h1>This storefront isn't available</h1><p>The ordering link you opened doesn't match a store — it may have been changed, or the QR code is out of date.</p>
<p>Please ask the store for their current ordering link.</p></div></body></html>`;

const webDir = path.join(__dirname, "web", "dist");
if (fs.existsSync(webDir)) {
  const noCacheShell = { setHeaders: (res, file) => { if (file.endsWith(".html") || file.endsWith("sw.js")) res.set("Cache-Control", "no-cache"); } };
  const sendTill = (req, res) => res.sendFile(path.join(webDir, "index.html"), { headers: { "Cache-Control": "no-cache" } });

  /* Guest-portal SEO: the portal is the baked bundle, so per-store meta is
     injected server-side into its <head> when a QR/link opens it (?s=slug).
     Owners set the title/description in /admin2 › Online Store › SEO; absent
     that, sensible defaults derive from the store name. Search engines and
     link-unfurlers read these tags without the SPA having to hydrate. */
  const seoEsc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  async function portalSeoFor(slug) {
    const org = await orgBySlug(slug);
    if (!org) return null;
    const row = await withOrg(org.id, (c) => c.query(
      "SELECT data FROM entities WHERE org_id=$1 AND kind='settings' AND id='settings' AND deleted=false LIMIT 1", [org.id]));
    const d = (row.rows[0] && row.rows[0].data) || {};
    const seo = (d.adminCfg && d.adminCfg.seo) || {};
    const name = d.storeName || d.name || org.name || "Kashikeyo";
    return {
      title: seo.title || (name + " · Order online"),
      desc: seo.desc || ("Order from " + name + " — fresh, fast, local."),
    };
  }

  /* Already-printed guest QR codes and shared links point at bare "/" with
     ?s=slug&t=table / &c=custId (see the SPA's own client-side urlMode
     detection) - keep serving the till bundle there so they keep working.
     The till itself now lives at /app; bare "/" with none of those params
     falls through to the marketing page below. */
  /* Guest QR ordering portal — the current register bundle (web2/proto) run in
     a locked-down customer mode. A customer link (?s=slug&c=custId) or a table
     QR (?s=slug&t=table) boots the same design the till uses: real store, live
     menu, the customer's member card + orders, and real order submission via
     /p/:slug/order. Injected window.__ksGuest flips the SPA into guest mode
     (no PIN, no staff chrome, QR screen only). Falls back to the legacy baked
     bundle when the slug is unknown or the new proto isn't present. */
  const gProtoDir = path.join(__dirname, "web2", "proto");
  const gEnc = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
  const gCSP = [
    "default-src 'self'", "base-uri 'self'", "object-src 'none'",
    "img-src 'self' data: blob: https:", "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:", "connect-src 'self' blob: data:",
    "frame-src 'self' blob:", "worker-src 'self' blob:", "frame-ancestors 'none'",
  ].join("; ");
  const gMods = (addons) => (Array.isArray(addons) ? addons : [])
    .map((a, i) => ({ id: "a" + i, en: String((a && a.name) || ""), price: (Number(a && a.price) || 0) / 100 })).filter((a) => a.en);
  // Map flattened product rows (kindAll) into the register/guest MENU shape.
  const gMenu = (prods) => prods.filter((p) => p.name && !p.hidden).map((p) => ({
    id: p.id, cat: menuCat(p.cat), sub: String(p.cat || ""), en: p.name, dv: p.dv || "", price: (Number(p.price) || 0) / 100,
    desc: p.desc || "", descDv: p.descDv || "", tags: Array.isArray(p.tags) ? p.tags.filter(Boolean).slice(0, 3) : [],
    mods: gMods(p.addons),
    soldOut: !!p.soldOut || (p.recipeAvail != null ? Number(p.recipeAvail) <= 0 : (p.stock != null && Number(p.stock) <= 0)) }));
  const serveGuestPortal = async (req, res) => {
    const slugReq = String(req.query.s || "");
    const org = await orgBySlug(slugReq);
    /* No-secret diagnostic: which storefront slug was asked for, on which host,
       and whether it resolved (plus the org id + its registered name). Answers
       "my storefront shows the demo / the wrong name" straight from the logs —
       the slug and host are public and the org id is opaque. */
    try { console.log("guest portal", JSON.stringify({ slug: slugReq, host: (req.headers && req.headers.host) || "", resolved: !!org, org: org ? org.id : null, storeName: org ? (org.store_name || "") : null })); } catch (e) { /* non-fatal */ }
    if (!org) {
      /* A storefront address that matches no live store must NOT fall back to the
         demo till — that renders the placeholder "Kashikeyo Cafe" and reads as a
         real (wrong) store, so an owner whose handle changed thinks their rename
         failed. Show an unmistakable "storefront not found" instead. */
      return res.status(404).set("Content-Type", "text/html; charset=utf-8")
        .set("Cache-Control", "no-store").send(STOREFRONT_NOT_FOUND_HTML);
    }
    // The storefront now renders the v2 design (web3/proto/guest.html) through the
    // shared serveGuestV3. The legacy web2 guest render below stays only as a
    // fallback if that page is ever missing.
    if (hasGuestV3()) {
      try { return await serveGuestV3(req, res, org, { table: req.query.t, custId: req.query.c, storeId: req.query.storeId || req.query.store || req.query.st }); }
      catch (e) { recordError("guest v3 serve", e); /* fall through to legacy render */ }
    }
    if (!fs.existsSync(path.join(gProtoDir, "index.html"))) return sendTill(req, res);
    const storeId = cleanStoreId(req.query.storeId || req.query.store || req.query.st || DEFAULT_STORE_ID);
    await ensureDefaultStore(org.id, org.store_name);
    const [settingsArr, products] = await Promise.all([
      loadSettingsArr(org.id), kindAll(org.id, "products", storeId)]);
    const recipeRows = await withOrg(org.id, (c) => c.query("SELECT DISTINCT product_id FROM recipe_lines WHERE org_id=$1", [org.id]));
    const hasRecipe = new Set(recipeRows.rows.map((r) => String(r.product_id)));
    const st = settingsArr[0] || { storeName: org.store_name, currency: "MVR", usdRate: 1542 };
    /* Mirrors liveStoreP (which lives in another closure). `taxRate` matters: without
       it the guest portal has no way to know the outlet's MIRA rate, and used to
       charge a hardcoded 10%. Keep the two in step. */
    const storeP = { name: st.storeName || org.store_name, currency: st.currency || "MVR", usdRate: Number(st.usdRate) || 1542,
      tin: st.tin || "", address: st.address || "", footer: st.receiptFooter || st.footer || "", logo: st.logo || "",
      // Storefront branding: the guest portal repaints to the store's accent,
      // prints its tagline, and drops the vendor line when white-labelled.
      tagline: st.tagline || "", accent: st.accent || "", whiteLabel: !!st.whiteLabel,
      taxRate: (st.adminCfg && st.adminCfg.taxRate) === "tgst" ? "tgst" : "ggst",
      tableCount: Number(st.tableCount) > 0 ? Number(st.tableCount) : 12 };
    const catGroups = Array.isArray(st.catGroups) ? st.catGroups : [];
    const catOrder = Array.isArray(st.catOrder) ? st.catOrder : [];
    const visible = products.filter((p) => !p.hidden && (hasRecipe.has(String(p.id)) || p.stock == null || Number(p.stock) > 0));
    const menu = gMenu(visible);
    let customer = null;
    if (req.query.c) {
      const c = (await kindAll(org.id, "customers", storeId)).find((x) => idEq(x.id, req.query.c));
      if (c) {
        const orders = (await guestOrders(org.id, storeId, { customerId: c.id }, st)).slice(0, 25);
        const completed = orders.filter((o) => finalStatuses.has(String(o.status || "").toLowerCase()));
        customer = { id: c.id, name: c.name || "", dv: c.dv || "", points: Number(c.points) || 0, balance: Number(c.balance) || 0,
          address: c.address || "", memberNo: c.memberNo || "", visits: completed.length,
          spent: completed.reduce((a, o) => a + Number(o.total || 0), 0),
          orders: orders.map((o) => ({ no: o.no, total: Number(o.total || 0) / 100, status: o.status, when: o.createdAt || o.at || Date.now(),
            otype: asOtype(o.otype), table: o.table || "", zone: o.zone || "", items: (o.items || []).map((it) => ({ q: it.qty, n: it.name })) })) };
      }
    }
    const guest = { slug: org.slug, storeId, table: req.query.t ? String(req.query.t) : "", customer };
    let seoTitle = storeP.name + " · Order online";
    try { const seo = await portalSeoFor(String(req.query.s)); if (seo && seo.title) seoTitle = seo.title; } catch (e) { /* default */ }
    // Vendored React (the bundle otherwise fetches it from unpkg, which the CSP
    // blocks) served from the public /app/vendor path, same as the register.
    const gVendor = {
      "https://unpkg.com/react@18.3.1/umd/react.production.min.js": "/app/vendor/react.production.min.js",
      "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js": "/app/vendor/react-dom.production.min.js",
    };
    /* Product photos, keyed art-<id>, exactly as the register gets them (see the
       menuImg map in serveProto). Without this the guest portal resolved every
       tile through assetUrl()'s artwork/<id>.png fallback, which does not exist —
       so the diner scanning a table QR saw a grid of letter placeholders while
       staff on the till saw the photos. Remote URLs pass straight through; a
       stored data-URI is served from /api/img/<id> so its base64 doesn't ride in
       this no-cache HTML. */
    const gArt = {};
    for (const pr of visible) {
      const im = pr && pr.img;
      if (!im) continue;
      gArt["art-" + pr.id] = /^https?:\/\//i.test(String(im))
        ? String(im)
        : "/api/img/" + encodeURIComponent(pr.id) + "?v=" + crypto.createHash("sha1").update(String(im)).digest("hex").slice(0, 12);
    }
    /* The diner's screen gets the same floors the register does: a real tap
       target on every control, and a fallback when a product photo fails to
       load (this menu's art is remote, so on a metered or dropped connection
       the whole grid was the browser's broken-image glyph). */
    const gFixCss = `\n<style>button:not([data-tap="tight"]),[role="button"]:not([data-tap="tight"]){min-height:44px}` +
      `input:not([type=checkbox]):not([type=radio]):not([data-tap="tight"]){min-height:44px}</style>`;
    const inject = `\n<base href="/app/">\n<title>${seoEsc(seoTitle)}</title>${gFixCss}\n<script>` +
      `window.__ksMenu=${gEnc(menu)};window.__ksReg=${gEnc({ storeP, catGroups, catOrder })};window.__ksGuest=${gEnc(guest)};` +
      `window.__resources=Object.assign(window.__resources||{},${gEnc(Object.assign({}, gVendor, gArt))});` + UIFIX_JS + `</script>\n`;
    const html = fs.readFileSync(path.join(gProtoDir, "index.html"), "utf8")
      .replace(/<title>[\s\S]*?<\/title>/i, "")
      .replace(/<head([^>]*)>/i, (m) => m + inject);
    res.set("Content-Security-Policy", gCSP);
    res.set("Cache-Control", "no-cache");
    res.set("Content-Type", "text/html; charset=utf-8").send(html);
  };

  app.get("/", wrap(async (req, res, next) => {
    if (!(req.query.s || req.query.t || req.query.c)) return next();
    // A slug-scoped link (customer profile or table QR) → the current guest UI.
    if (req.query.s) {
      try { return await serveGuestPortal(req, res); }
      catch (e) { recordError("guest portal serve", e); return sendTill(req, res); }
    }
    return sendTill(req, res);
  }));

  /* The register (new /app front-end) is served earlier via serveProto({base:"/app"}).
     The legacy baked till bundle is retired from /app; it stays reachable only as
     the guest portal at "/?s=slug" (sendTill above) and its root-relative assets
     below. */

  /* Assets the bundle references with root-relative paths (offline-bridge.js,
     manifest, icons, sw.js) stay reachable at "/" too, for already-installed
     PWAs and their service workers - index disabled so it never shadows the
     "/" routes above. */
  app.use(express.static(webDir, { ...noCacheShell, index: false }));
}

app.get("/", (req, res) => res.sendFile(path.join(siteDir, "landing.html")));

app.use((err, req, res, next) => {
  console.error("request failed:", req.method, req.originalUrl, errDetail(err));
  recordError(req.method + " " + req.originalUrl, err);
  if (res.headersSent) return res.end();
  /* Handlers throw Object.assign(new Error(msg), { status: 4xx }) for
     client-facing validation/conflict errors — pass those through so the
     UI can show the real message instead of a generic 500. */
  /* Saturation is temporary, not a bug: a pool-connect timeout or a statement
     timeout means the database is busy. Answer 503 + Retry-After so the till
     backs off and retries instead of hanging on a request that will never
     arrive (the outbox already knows how to retry a 5xx). */
  const msg = String((err && err.message) || "");
  const busy = /timeout exceeded when trying to connect|Connection terminated due to connection timeout|canceling statement due to statement timeout|Query read timeout/i.test(msg);
  if (busy) { res.set("Retry-After", "2"); return res.status(503).json({ error: "Busy right now — try again in a moment." }); }
  const code = err && Number(err.status) >= 400 && Number(err.status) < 500 ? Number(err.status) : 500;
  res.status(code).json({ error: code === 500 ? "something went wrong on our side - please try again" : err.message });
});
process.on("unhandledRejection", (e) => { console.error("unhandled rejection:", errDetail(e)); recordError("unhandledRejection", e); });
app.listen(PORT, () => console.log("KashikeyoPOS Cloud on :" + PORT));
