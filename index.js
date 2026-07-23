/* KashikeyoPOS Cloud
   Multi-store, Postgres-backed sync server with offline-safe op-log, SSE pokes,
   public guest endpoints, and static PWA hosting. */
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
const SECRET = process.env.JWT_SECRET || "kashikeyo-dev-secret-change-me";
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
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.RAILWAY_DATABASE_URL || "";
const hasPgEnv = !!(process.env.PGHOST || process.env.PGUSER || process.env.PGDATABASE);
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
// request pool → pooled endpoint (DATABASE_URL); safe through a transaction pooler
function appPoolConfig() { return appPoolConfigFrom(connectionString); }
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
  await bootPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON orgs, stores, entities, ops, platform_admins TO ${APP_DB_ROLE}`);
  await bootPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ingredients, ingredient_units, recipe_lines, stock_moves,
    audit_sessions, audit_lines, suppliers, purchase_invoices, purchase_invoice_lines, ingredient_lots TO ${APP_DB_ROLE}`);
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
async function withScope(setup, fn) {
  const client = await pool.connect();
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
const withOrg = (orgId, fn) => withScope(
  (client) => client.query("SELECT set_config('app.org_id',$1,true), set_config('app.is_superadmin','off',true)", [String(orgId)]),
  fn
);
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
    /* Ensure every existing outlet carries the shared starter menu with its
       photos. Idempotent (ensureDefaultMenu only writes when an image is
       missing or changed), so this is a no-op on subsequent boots. New outlets
       get the same menu at registration. */
    try {
      const orgs = (await bootPool.query("SELECT id FROM orgs")).rows;
      let touched = 0;
      for (const o of orgs) { if (await ensureDefaultMenu(o.id)) touched++; }
      if (touched) console.log(`default menu applied/refreshed for ${touched} of ${orgs.length} outlet(s)`);
    } catch (e) { console.warn("default-menu backfill skipped:", e.message); }
  } catch (e) { console.error("schema init failed:", e.message); }
  finally { bootClient.release(); }
  /* Cross-instance SSE fan-out (ARCH-01). Started after boot init + lock release,
     and independent of it, so a node still relays pokes even if a backfill hiccups. */
  if (!pool) { pool = new Pool(appPoolConfig()); pool.on("error", (e) => console.error("app pool error:", errDetail(e))); }
  startPokeListener();
})();

const app = express();
/* Behind Railway's proxy the real client IP rides X-Forwarded-For; trust one
   hop so req.ip is the client (needed by the login throttle below), not the
   proxy. Locally, with no proxy, this falls back to the socket address. */
app.set("trust proxy", 1);

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
app.use((req, res, next) => {
  if (!req.path.startsWith("/api") && !req.path.startsWith("/p/")) return next();
  const origin = req.headers.origin;
  if (allowedOrigins.length) {
    if (origin && allowedOrigins.includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
    }
    /* origin absent or not on the list → no ACAO header, so a browser blocks
       the cross-origin read while same-origin calls are unaffected. */
  } else {
    res.set("Access-Control-Allow-Origin", "*");
  }
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
const saleLineTotal = (l) => Math.round((Number(l && l.price) || 0) * (Number(l && l.qty) || 0) * (1 - (Number(l && l.discPct) || 0) / 100));
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
  for (const res of set) { try { res.write(`data: ${JSON.stringify({ rowver })}\n\n`); } catch {} }
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

const sign = (orgId, register, storeId = DEFAULT_STORE_ID, extra = {}) => jwt.sign({ o: orgId, r: register, s: cleanStoreId(storeId), ...extra }, SECRET, { expiresIn: "365d" });
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
/* Resolves the app-session cookie to a live, active org id, or null. The one
   place that decides "is this browser really signed in?" - both the /app gate
   and the /login,/signup "skip straight to the app" shortcut go through it, so
   they can never disagree and bounce the user back and forth (that mismatch -
   a stale localStorage token with no valid cookie - was an infinite
   /login<->/app redirect flash). */
async function resolveAppSession(req) {
  let payload;
  try { payload = jwt.verify(parseCookies(req)[APP_COOKIE], SECRET); } catch { return null; }
  if (!payload.o) return null;
  const r = await withSystem((client) => client.query("SELECT status, onboarded FROM orgs WHERE id=$1", [payload.o]));
  if (!r.rowCount || (r.rows[0].status && r.rows[0].status !== "active")) return null;
  /* Side-channel for requireAppSession so it can steer un-onboarded orgs to
     /welcome without a second lookup; API callers simply ignore it. */
  req.kOnboarded = r.rows[0].onboarded !== false;
  /* Role-carrying sessions (RBAC gaps 3-4): a staff PIN login stamps role +
     staff into the cookie; the owner/email login carries none, which we treat
     as full "owner" access for backward compatibility. Surfaced on req so the
     /api/inv role gate and back.html can enforce/branch on it. */
  req.appRole = payload.role || "owner";
  req.appStaff = payload.staff || null;
  return payload.o;
}
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
  resolveAppSession(req).then((orgId) => orgId ? res.redirect(302, "/app") : next()).catch(() => next());
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
const inventory = require("./inventory")({ withOrg, uid, wrap, recordError, resolveAppSession, bearerAuth: auth, poke, logActivity });
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
                            ELSE entities.data || jsonb_build_object('img', EXCLUDED.data->'img') END,
               deleted = false,
               rowver = nextval('entities_rowver_seq'), updated_at = now()
           WHERE entities.deleted = true
              OR (entities.data->>'img') IS DISTINCT FROM (EXCLUDED.data->>'img')
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

const lineTotal = (l) => Math.round(Number(l.price || 0) * Number(l.qty || 1) * (1 - (Number(l.discPct || 0)) / 100));
const orderSubtotal = (o) => (o.items || []).reduce((x, l) => x + lineTotal(l), 0) + (Number(o.fee) || 0);
/* Mirrors the till's $n checkout math exactly (see guest-sync-patch.js #3):
   GST only on taxable lines (products can be GST-exempt), service charge on
   the full subtotal — so what a guest sees for an open order matches what
   the cashier settles it for. */
const orderTotal = (o, settings = {}) => {
  const sub = orderSubtotal(o);
  const taxBase = (o.items || []).reduce((x, l) => l.taxable === false ? x : x + lineTotal(l), 0) + (Number(o.fee) || 0);
  const gst = Math.round(taxBase * (Number(settings.gstBp || 800)) / 10000);
  const svc = Math.round(sub * (Number(settings.svcChargeBp || 0)) / 10000);
  return sub + gst + svc;
};
const normalizeOrder = (o, settings = {}) => ({
  ...o,
  status: String(o.status || "new"),
  table: o.table || (o.otype === "delivery" ? "Delivery" : "Pickup"),
  total: o.total != null ? Number(o.total) : orderTotal(o, settings),
  updatedAt: o.updatedAt || o.settledAt || o.completedAt || o.createdAt || Date.now(),
});
const finalStatuses = new Set(["completed", "settled", "paid", "closed"]);
async function guestOrders(orgId, storeId, selector = {}, settings = {}) {
  const orders = await kindAll(orgId, "orders", storeId);
  const customerId = selector.customerId;
  const table = selector.table;
  return orders
    .filter((o) => customerId ? idEq(o.customerId, customerId) : table ? idEq(o.table, table) : false)
    .map((o) => normalizeOrder(o, settings))
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
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
    const base = slugify(name || (cleanEmail ? cleanEmail.split("@")[0] : provider + "-store"));
    const slug = await uniqueSlug(client, base);
    const id = uid();
    const placeholderHash = bcrypt.hashSync(crypto.randomBytes(24).toString("hex"), 10);
    /* onboarded=false: a first-time social sign-in still owes the /welcome
       step (store name, currency, PIN) before the till makes sense. */
    const ins = await client.query(
      `INSERT INTO orgs (id, slug, email, pass_hash, store_name, owner_name, auth_provider, ${subCol}, registers, onboarded)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,false) RETURNING *`,
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
  setAppCookie(res, result.token);
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
  setAppCookie(res, result.token);
  respond(Object.assign({ kashikeyoAppleAuth: true }, result));
}));

app.post("/api/register", wrap(async (req, res) => {
  const { email, password, storeName, ownerName, phone, pin, currency } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  if (String(password).length < MIN_PASSWORD_LEN) return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LEN} characters` });
  const base = slugify(storeName || email.split("@")[0]);
  const slug = await withSystem((client) => uniqueSlug(client, base));
  const id = uid();
  const cleanOwnerName = String(ownerName || "").slice(0, 100);
  const cleanCurrency = currency === "USD" ? "USD" : "MVR";
  try {
    await withSystem((client) => client.query(
      "INSERT INTO orgs (id, slug, email, pass_hash, store_name, owner_name, phone, registers) VALUES ($1,$2,$3,$4,$5,$6,$7,1)",
      [id, slug, email.toLowerCase(), bcrypt.hashSync(password, 10), storeName || "My Store", cleanOwnerName, String(phone || "").slice(0, 30)]));
  } catch {
    return res.status(409).json({ error: "email already registered - use Sign in" });
  }
  await ensureDefaultStore(id, storeName || "Main Store");
  const initSettings = { storeName: storeName || "My Store", gstBp: 800, loyaltyBp: 10000, svcChargeBp: 0, usdRate: 1542, currency: cleanCurrency, footer: "" };
  await withOrg(id, (client) => client.query(
    "INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'settings','settings',$2) ON CONFLICT (org_id, kind, id) DO NOTHING",
    [id, JSON.stringify(initSettings)]));
  /* Every new outlet starts with the shared starter menu (same items + photos
     as every other outlet), on the till and the guest portal. Non-fatal. */
  try { await ensureDefaultMenu(id); } catch (e) { console.warn("default-menu seed on register skipped:", e.message); }
  const validPin = /^\d{4}$/.test(String(pin || "")) ? String(pin) : null;
  const seededPin = await ensureOwnerSeed({ id, owner_name: cleanOwnerName, email }, validPin);
  const token = sign(id, "R1", DEFAULT_STORE_ID);
  setAppCookie(res, token);
  const result = { token, slug, register: "R1", storeId: DEFAULT_STORE_ID };
  if (seededPin) result.pin = seededPin;
  res.json(result);
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
  setAppCookie(res, token);
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
  const want = pinHash(String(pin || ""));
  const users = await withOrg(org.id, (client) =>
    client.query("SELECT data FROM entities WHERE org_id=$1 AND kind='users' AND deleted=false", [org.id]));
  const me = users.rows.map((r) => r.data).find((u) => u && String(u.pin) === want);
  if (!me) return bad();
  const RANK = { owner: 3, admin: 2, manager: 1 };
  if (!RANK[me.role]) { rlFail(keys); return res.status(403).json({ error: "The back office is for managers and above — use the till app for your role." }); }
  rlClear(keys);
  await ensureDefaultStore(org.id, org.store_name);
  const storeId = cleanStoreId(me.storeId || DEFAULT_STORE_ID);
  setAppCookie(res, sign(org.id, "BACK", storeId, { role: me.role, staff: { id: me.id, name: me.name } }));
  res.json({ ok: true, role: me.role, name: me.name, slug: org.slug });
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

app.post("/api/pair", wrap(async (req, res) => {
  const orgId = await resolveAppSession(req);
  if (!orgId) return res.status(401).json({ error: "sign in required" });
  const org = await withSystem(async (client) => (await client.query("SELECT * FROM orgs WHERE id=$1", [orgId])).rows[0]);
  if (!org) return res.status(401).json({ error: "sign in required" });
  const result = await finishOAuthLogin(org);
  if (result.error) return res.status(result.status).json({ error: result.error });
  setAppCookie(res, result.token);
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
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id',$1,true), set_config('app.is_superadmin','off',true)", [String(req.org.o)]);
    /* Money-integrity context (FIN-01): the catalogue prices + GST rate this org
       is authoritative for, fetched once per sync only when the batch actually
       carries a sale, so ordinary syncs pay nothing. */
    let moneyCtx = null;
    if (ops.some((o) => (o.puts || []).some((p) => p.kind === "sales"))) {
      const [setRes, prodRes] = await Promise.all([
        client.query("SELECT data FROM entities WHERE org_id=$1 AND kind='settings' AND deleted=false ORDER BY updated_at DESC LIMIT 1", [req.org.o]),
        client.query("SELECT data->>'id' AS id, data->>'price' AS price, data->>'openPrice' AS op FROM entities WHERE org_id=$1 AND kind='products' AND deleted=false", [req.org.o]),
      ]);
      const st = setRes.rows[0] ? setRes.rows[0].data : {};
      const prices = new Map();
      for (const r of prodRes.rows) prices.set(String(r.id), { price: Number(r.price) || 0, open: r.op === "true" });
      moneyCtx = { gstBp: Number(st.gstBp) || 0, svcBp: Number(st.svcChargeBp) || 0, prices };
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
        /* FIN-01: re-check the sale's money against the catalogue + GST rate and
           flag (never reject) any inconsistency, so a tampered or mis-priced
           sale is accepted-but-quarantined for manager review rather than
           silently trusted. */
        if (p.kind === "sales" && data.lines) {
          const money = auditSaleMoney(data, moneyCtx);
          if (money) { data.serverAudit = money; recordError(`sale money-check ${data.no || data.id}`, new Error(money.reasons.join("; "))); auditEvents.push({ actor: data.userName || "", action: "sale.flagged", ref: data.no || data.id, detail: { claimedTotal: money.claimedTotal, computedTotal: money.computedTotal, reasons: money.reasons } }); }
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
          auditEvents.push({ actor: data.userName || "", action: "sale.refund", ref: data.no || data.id, detail: { total: data.total, customerId: data.customerId || null, approved: !!data.managerApproved } });
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
            " || CASE WHEN COALESCE(excluded.data->>'img','')='' AND entities.data ? 'img' THEN jsonb_build_object('img', entities.data->'img') ELSE '{}'::jsonb END"
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
                : "";
        const r = await client.query(
          `INSERT INTO entities (org_id, kind, id, data, deleted, updated_at)
           VALUES ($1,$2,$3,$4,false,now())
           ON CONFLICT (org_id, kind, id)
           DO UPDATE SET data = excluded.data${preserve}, deleted=false, rowver=nextval('entities_rowver_seq'), updated_at=now()
           RETURNING rowver`,
          [req.org.o, p.kind, String(p.id), JSON.stringify(data)]);
        rowver = Math.max(rowver, Number(r.rows[0].rowver));
        if (p.kind === "sales" && data.lines) settledSales.push(data);
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
        const r = await client.query(
          `UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now()
           WHERE org_id=$1 AND kind=$2 AND id=$3 RETURNING rowver`, [req.org.o, d.kind, String(d.id)]);
        for (const row of r.rows) rowver = Math.max(rowver, Number(row.rowver));
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    client.release();
    recordError("ops[" + req.id + "]", e);
    return res.status(500).json({ error: "ops failed: " + errDetail(e), requestId: req.id });
  }
  client.release();
  if (rowver) poke(req.org.o, rowver);
  /* Recipe-based ingredient deduction runs AFTER the sync commit, never
     inside it: a till sale must never be rejected because inventory math
     failed. The ledger's (org_id, ref, ingredient_id) uniqueness makes the
     deduction idempotent, so a crash between commit and here at worst skips
     a deduction the next audit reconciles — it can never double-deduct. */
  if (settledSales.length) inventory.processSales(req.org.o, settledSales);
  /* Persist the sensitive events observed above (post-commit, non-fatal). */
  for (const ev of auditEvents) logActivity(req.org.o, { ...ev, requestId: req.id });
  res.json({ ok: true, rowver });
}));

app.get("/api/pull", auth, wrap(async (req, res) => {
  const since = Number(req.query.since) || 0;
  const storeId = cleanStoreId(req.query.storeId || req.org.s || DEFAULT_STORE_ID);
  const r = await withOrg(req.org.o, (client) => client.query(
    `SELECT kind, id, data, deleted, rowver FROM entities
     WHERE org_id=$1 AND rowver>$2 AND COALESCE(data->>'storeId','global') IN ('global',$3)
     ORDER BY rowver ASC LIMIT 500`, [req.org.o, since, storeId]));
  const entities = r.rows.map((x) => ({ kind: x.kind, id: publicId(x), data: x.data, deleted: x.deleted, rowver: Number(x.rowver), storeId: entityStore(x.data) }));
  const rowver = entities.length ? entities[entities.length - 1].rowver : since;
  res.json({ rowver, storeId, entities, more: entities.length === 500 });
}));

app.get("/api/events", auth, (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  res.write("data: {\"hello\":true}\n\n");
  let set = hubs.get(req.org.o);
  if (!set) { set = new Set(); hubs.set(req.org.o, set); }
  set.add(res);
  const hb = setInterval(() => { try { res.write(": hb\n\n"); } catch {} }, 25000);
  req.on("close", () => { clearInterval(hb); set.delete(res); });
});

app.get("/p/:slug/events", wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).end();
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  res.write("data: {\"hello\":true}\n\n");
  let set = hubs.get(org.id);
  if (!set) { set = new Set(); hubs.set(org.id, set); }
  set.add(res);
  const hb = setInterval(() => { try { res.write(": hb\n\n"); } catch {} }, 25000);
  req.on("close", () => { clearInterval(hb); set.delete(res); });
}));

app.get("/p/:slug/boot", wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const storeId = cleanStoreId(req.query.storeId || req.query.store || req.query.st || DEFAULT_STORE_ID);
  await ensureDefaultStore(org.id, org.store_name);
  const [settingsArr, products, zones, tables, stores, recipeRows] = await Promise.all([
    kindAll(org.id, "settings", storeId), kindAll(org.id, "products", storeId), kindAll(org.id, "zones", storeId), kindAll(org.id, "tables", storeId),
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

app.post("/p/:slug/order", wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const { items, table, custId, gtype, zoneId, note, payOnline } = req.body || {};
  const storeId = cleanStoreId(req.body?.storeId || req.query.storeId || req.query.store || req.query.st || DEFAULT_STORE_ID);
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "cart is empty" });
  const [products, zones, customers] = await Promise.all([kindAll(org.id, "products", storeId), kindAll(org.id, "zones", storeId), kindAll(org.id, "customers", storeId)]);
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
    const noteBits = addons.map((a) => a.name);
    if (spice) noteBits.push(spice);
    if (comment) noteBits.push("“" + comment + "”");
    return { pid: p ? p.id : pid || String(src.id || uid()), name: src.name || "Item", emoji: src.emoji || "", price: (Number(src.price) || 0) + addOnSum, cost: Number(src.cost) || 0, unit: src.unit || "pcs", vendor: !!src.vendor, qty: Math.max(1, Math.min(99, Number(ci.qty) || 1)), discPct: Number(src.discPct) || 0, taxable: src.taxable !== false, addons: addons.length ? addons : undefined, spice: spice || undefined, comment: comment || undefined, noKitchen: noKitchen || undefined, note: noteBits.length ? noteBits.join(" · ") : undefined };
  }).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: "those items are unavailable" });
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
  const cust = custId !== null && custId !== undefined && custId !== "" ? customers.find((c) => idEq(c.id, custId)) || null : null;
  const upd = await withOrg(org.id, (client) => client.query("UPDATE orgs SET oseq = oseq + 1 WHERE id=$1 RETURNING oseq", [org.id]));
  /* An order made up entirely of non-kitchen items (hedhikaa, cakes, pastries,
     packaged goods) has nothing to cook, so it skips the kitchen queue and is
     "ready" to hand over / settle straight away. Mixed orders stay "new" and
     the kitchen display just hides the non-kitchen lines. */
  const allNoKitchen = lines.length > 0 && lines.every((l) => l.noKitchen);
  const order = { id: uid(), no: "ORD-" + upd.rows[0].oseq, storeId, table: requestedTable || (otype === "delivery" ? "Delivery" : "Pickup"), items: lines, status: allNoKitchen ? "ready" : "new", noKitchen: allNoKitchen || undefined, createdAt: Date.now(), updatedAt: Date.now(), paidOnline: !!payOnline, call: false, source: "qr", otype, covers: 1, customerId: cust ? cust.id : null, customerName: cust ? cust.name : null, zone: zone ? zone.name : null, fee: zone ? zone.fee : 0, note: String(note || "").slice(0, 200) || (otype === "delivery" && cust ? cust.address || "" : "") };
  const r = await withOrg(org.id, (client) => client.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'orders',$2,$3) RETURNING rowver", [org.id, order.id, JSON.stringify(order)]));
  poke(org.id, Number(r.rows[0].rowver));
  res.json({ ok: true, order: normalizeOrder(order) });
}));

app.get("/p/:slug/orders", wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const storeId = cleanStoreId(req.query.storeId || req.query.store || req.query.st || DEFAULT_STORE_ID);
  const settingsArr = await kindAll(org.id, "settings", storeId);
  const settings = settingsArr[0]
    ? { usdRate: 1542, ...settingsArr[0] }
    : { storeName: org.store_name, gstBp: 800, loyaltyBp: 10000, svcChargeBp: 0, usdRate: 1542, currency: "MVR" };
  const mine = (await guestOrders(org.id, storeId, { customerId: req.query.c, table: req.query.t }, settings)).slice(0, 25);
  res.json({ storeId, orders: mine });
}));

app.post("/p/:slug/call", wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const { table, custId } = req.body || {};
  const storeId = cleanStoreId(req.body?.storeId || req.query.storeId || req.query.store || req.query.st || DEFAULT_STORE_ID);
  let name = null;
  if (custId) name = ((await kindAll(org.id, "customers", storeId)).find((c) => idEq(c.id, custId)) || {}).name || null;
  const call = { id: uid(), storeId, table: table || (name ? "Pickup" : "-"), name, t: Date.now() };
  const r = await withOrg(org.id, (client) => client.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'waiterCalls',$2,$3) RETURNING rowver", [org.id, call.id, JSON.stringify(call)]));
  poke(org.id, Number(r.rows[0].rowver));
  res.json({ ok: true });
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

app.get("/", wrap(async (req, res, next) => {
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
app.get("/back", requireAppSession, (req, res) => res.sendFile(path.join(siteDir, "back.html")));
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
    "font-src 'self' data: https://fonts.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
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
  const liveMenu = (rows) => rows
    .map((r) => ({ id: r.id, ...(r.data || {}) }))
    .filter((p) => p.name && !p.hidden)
    .map((p) => ({ id: p.id, cat: catSlug(p.cat), en: p.name, dv: p.dv || "", price: (Number(p.price) || 0) / 100, img: p.img || "", desc: p.desc || "" }));
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
        n: d.name || "", ph: d.phone || "",
        tier: pts >= 500 ? "Gold" : pts >= 200 ? "Silver" : "Bronze",
        visits: agg.n, spend: Math.round(agg.s / 100),
        joined: "", allergy: "—", diet: "—", note: "",
      };
    }).filter((c) => c.n);
  };
  // Serve one design-tool prototype under `base` (e.g. /app2, /admin2). index/
  // redirect:false so `base` and `base/` reach the dynamic handler while
  // support.js / artwork / fonts / vendor are served statically. `withMenu`
  // injects the live catalogue into window.__ksMenu (register tiles + admin Menu
  // section); `withAdmin` injects real customers into window.__ksAdmin. Sections
  // without injected data fall back to the prototype's own demo data.
  const serveProto = ({ base, file, withMenu, withAdmin }) => {
    app.use(base, express.static(protoDir, { index: false, redirect: false, maxAge: "1h" }));
    const vendor = {
      "https://unpkg.com/react@18.3.1/umd/react.production.min.js": base + "/vendor/react.production.min.js",
      "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js": base + "/vendor/react-dom.production.min.js",
    };
    app.get(new RegExp("^" + base.replace(/[/]/g, "\\$&") + "(\\/.*)?$"), requireAppSession, async (req, res) => {
      let menu = []; const adminData = {}; let token = null;
      if (withMenu || withAdmin) {
        try {
          const orgId = await resolveAppSession(req);
          // A short-lived-enough ops bearer token so the register can persist
          // completed sales to /api/ops from the browser (same credential the
          // baked till uses). Only minted for the register route.
          if (withMenu) token = sign(orgId, "R1");
          await withOrg(orgId, async (c) => {
            if (withMenu) {
              menu = liveMenu((await c.query(
                "SELECT id, data FROM entities WHERE org_id=$1 AND kind='products' AND deleted=false", [orgId])).rows);
            }
            if (withAdmin) {
              const custRows = (await c.query(
                "SELECT id, data FROM entities WHERE org_id=$1 AND kind='customers' AND deleted=false", [orgId])).rows;
              const orderRows = (await c.query(
                "SELECT data FROM entities WHERE org_id=$1 AND kind='orders' AND deleted=false", [orgId])).rows;
              adminData.custData = liveCustData(custRows, orderRows);
              // Inventory stock levels from the real ingredients ledger.
              const ingRows = (await c.query(
                "SELECT name, current_stock, base_unit, min_stock, avg_cost FROM ingredients WHERE org_id=$1 AND active ORDER BY name", [orgId])).rows;
              adminData.stock = ingRows.map((i) => ({
                n: i.name, oh: Number(i.current_stock) || 0, unit: i.base_unit || "",
                par: Number(i.min_stock) || 0, cost: Math.round((Number(i.avg_cost) || 0) / 100),
              }));
              // Dashboard: today's headline KPIs + recent orders from real sales.
              const saleRows = (await c.query(
                "SELECT data FROM entities WHERE org_id=$1 AND kind='sales' AND deleted=false ORDER BY (data->>'at')::numeric DESC NULLS LAST LIMIT 200", [orgId]))
                .rows.map((r) => r.data || {}).filter((s) => !s.type || s.type === "sale");
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
              adminData.recv = custRows.map((r) => r.data || {}).filter((d) => (Number(d.balance) || 0) > 0)
                .sort((a, b) => (Number(b.balance) || 0) - (Number(a.balance) || 0))
                .map((d) => {
                  const bal = Math.round((Number(d.balance) || 0) / 100);
                  return { n: d.name || "", c: d.phone || "Account", bal, age: "—", last: dfmt(d.lastOrderAt), stk: bal >= 1000 ? "bad" : bal >= 300 ? "warn" : "ok" };
                });
              // Procurement > Expenses from the real expense ledger.
              const expRows = (await c.query(
                "SELECT data FROM entities WHERE org_id=$1 AND kind='expenses' AND deleted=false ORDER BY (data->>'t')::numeric DESC NULLS LAST LIMIT 40", [orgId])).rows.map((r) => r.data || {});
              adminData.expenses = expRows.map((e) => ({
                d: dfmt(e.t), cat: e.cat || "Purchases", v: e.supplier || e.userName || "—",
                m: e.paidFrom === "cash" ? "Cash" : e.paidFrom === "card" ? "Card" : "Transfer",
                amt: Math.round((Number(e.amount) || 0) / 100), ap: "Approved",
              }));
            }
          });
        } catch (e) { recordError(base + " data inject", e); }
      }
      // window.__resources drives both React vendoring (cdnScriptFor) and the
      // prototype's assetUrl(id) = __resources['art-'+id] image lookup, so we
      // map each real product's image onto its tile; items without an image
      // fall back to the prototype's glyph tiles.
      const resources = Object.assign({}, vendor);
      for (const p of menu) if (p.img) resources["art-" + p.id] = p.img;
      // <base href="base/"> so the template's relative ./support.js, artwork/*
      // and fonts/* resolve under the route even though the page URL has no
      // trailing slash. Injected right after <head> so it governs every later ref.
      // __ksPushSale persists a completed sale to /api/ops with the ops bearer
      // token; fire-and-forget so the register's own offline-first UX is never
      // blocked (a failed push just leaves the sale in the till's local log).
      const pushSaleJs = token
        ? `window.__ksToken=${JSON.stringify(token)};window.__ksPushSale=function(sale){try{fetch('/api/ops',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+window.__ksToken},body:JSON.stringify({ops:[{opId:'app2-'+sale.id,puts:[{kind:'sales',id:sale.id,data:sale}]}]})}).catch(function(){});}catch(e){}};`
        : "";
      // Corrective CSS: hide the scrollbar on horizontally-scrollable pill/tab
      // rows (they scroll instead of clipping on narrow screens) — Firefox uses
      // the inline scrollbar-width:none, this covers Chrome/Safari/WebKit.
      const fixCss = `\n<style>[style*="overflow-x:auto"]::-webkit-scrollbar{height:0;width:0;display:none}</style>`;
      const inject = `\n<base href="${base}/">${fixCss}\n<script>` +
        (withMenu ? `window.__ksMenu=${enc(menu)};` + pushSaleJs : "") +
        (withAdmin ? `window.__ksAdmin=${enc(adminData)};` : "") +
        `window.__resources=Object.assign(window.__resources||{},${enc(resources)});</script>\n`;
      const html = readProto(file).replace(/<head([^>]*)>/i, (m) => m + inject);
      res.set("Content-Security-Policy", PROTO_CSP);
      res.set("Content-Type", "text/html; charset=utf-8").send(html);
    });
  };
  serveProto({ base: "/app2", file: "index.html", withMenu: true });   // Register / till
  if (fs.existsSync(path.join(protoDir, "admin.html"))) {
    serveProto({ base: "/admin2", file: "admin.html", withMenu: true, withAdmin: true }); // Back-office cockpit
  }
}
/* Post-social-login onboarding: name the store, pick currency + PIN. Only
   meaningful while the org is un-onboarded; afterwards it's just /app. */
app.get("/welcome", (req, res) => {
  resolveAppSession(req).then((orgId) => {
    if (!orgId) return res.redirect(302, "/login");
    if (req.kOnboarded) return res.redirect(302, "/app");
    res.sendFile(path.join(siteDir, "welcome.html"));
  }).catch(() => res.redirect(302, "/login"));
});
/* Clean URLs for the marketing content pages (footer links). The files also
   sit in siteDir so /docs.html etc. resolve via express.static above; these
   just give them the extensionless paths used across the site. */
for (const p of ["docs", "api", "status", "privacy", "terms"]) {
  app.get("/" + p, (req, res) => res.sendFile(path.join(siteDir, p + ".html")));
}

const webDir = path.join(__dirname, "web", "dist");
if (fs.existsSync(webDir)) {
  const noCacheShell = { setHeaders: (res, file) => { if (file.endsWith(".html") || file.endsWith("sw.js")) res.set("Cache-Control", "no-cache"); } };
  const sendTill = (req, res) => res.sendFile(path.join(webDir, "index.html"), { headers: { "Cache-Control": "no-cache" } });

  /* Already-printed guest QR codes and shared links point at bare "/" with
     ?s=slug&t=table / &c=custId (see the SPA's own client-side urlMode
     detection) - keep serving the till bundle there so they keep working.
     The till itself now lives at /app; bare "/" with none of those params
     falls through to the marketing page below. */
  app.get("/", (req, res, next) => {
    if (req.query.s || req.query.t || req.query.c) return sendTill(req, res);
    next();
  });

  app.use("/app", express.static(webDir, { ...noCacheShell, index: false }));
  app.get(/^\/app(\/.*)?$/, requireAppSession, sendTill);

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
  const code = err && Number(err.status) >= 400 && Number(err.status) < 500 ? Number(err.status) : 500;
  res.status(code).json({ error: code === 500 ? "something went wrong on our side - please try again" : err.message });
});
process.on("unhandledRejection", (e) => { console.error("unhandled rejection:", errDetail(e)); recordError("unhandledRejection", e); });
app.listen(PORT, () => console.log("KashikeyoPOS Cloud on :" + PORT));
