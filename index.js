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

/* Row Level Security only has teeth if the role running app queries is
   NOT the table owner and NOT a superuser — both bypass RLS regardless of
   policies (superusers unconditionally; owners unless FORCE is set, and
   Railway's default Postgres template grants a superuser role, which no
   FORCE setting can override). bootPool connects with whatever credentials
   were provided (owner-level, needed to create tables/roles/policies).
   pool — used for every request — connects as a separate, restricted
   kashikeyo_app role with only DML rights, so the tenant_isolation
   policies in schema.sql are actually enforced by Postgres itself. */
const bootPool = new Pool(poolConfig);
const APP_DB_ROLE = "kashikeyo_app";
const appRolePassword = crypto.createHash("sha256").update(`${SECRET}:kashikeyo_app_role`).digest("hex");

function appPoolConfig() {
  if (connectionString) {
    try {
      const u = new URL(connectionString);
      u.username = APP_DB_ROLE;
      u.password = appRolePassword;
      const cfg = { connectionString: u.toString() };
      if (!/localhost|127\.0\.0\.1/.test(connectionString)) cfg.ssl = { rejectUnauthorized: false };
      return cfg;
    } catch { /* fall through to poolConfig below */ }
  }
  if (hasPgEnv) {
    const cfg = {
      host: process.env.PGHOST, port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
      database: process.env.PGDATABASE, user: APP_DB_ROLE, password: appRolePassword,
    };
    if (!/localhost|127\.0\.0\.1/.test(String(process.env.PGHOST || ""))) cfg.ssl = { rejectUnauthorized: false };
    return cfg;
  }
  return poolConfig;
}
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
    audit_sessions, audit_lines, suppliers, purchase_invoices, purchase_invoice_lines TO ${APP_DB_ROLE}`);
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

(async () => {
  try {
    await bootPool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
    console.log("schema ready");
    await ensureAppRole();
    pool = new Pool(appPoolConfig());
    pool.on("error", (e) => console.error("app pool error:", errDetail(e)));
    console.log(`connected as restricted role ${APP_DB_ROLE} for request handling`);
    await mergeForkedStoreRows();
    await ensurePlatformAdmin();
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
})();

const app = express();
app.use(express.json({ limit: "25mb" }));
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

const hubs = new Map();
const poke = (orgId, rowver) => {
  const set = hubs.get(orgId);
  if (!set) return;
  for (const res of set) { try { res.write(`data: ${JSON.stringify({ rowver })}\n\n`); } catch {} }
};

/* Small in-memory ring buffer the developer panel's health view reads from -
   resets on restart, which is fine for "what's gone wrong recently", not
   meant as a durable audit log. */
const bootedAt = Date.now();
const recentErrors = [];
const recordError = (where, e) => {
  recentErrors.unshift({ t: Date.now(), where, message: errDetail(e) });
  if (recentErrors.length > 50) recentErrors.length = 50;
};

const sign = (orgId, register, storeId = DEFAULT_STORE_ID) => jwt.sign({ o: orgId, r: register, s: cleanStoreId(storeId) }, SECRET, { expiresIn: "365d" });
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
const inventory = require("./inventory")({ withOrg, uid, wrap, recordError, resolveAppSession, bearerAuth: auth, poke });
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
  const org = await withSystem(async (client) =>
    (await client.query("SELECT * FROM orgs WHERE email=$1", [(email || "").toLowerCase()])).rows[0]);
  if (!org || !bcrypt.compareSync(password || "", org.pass_hash)) return res.status(401).json({ error: "wrong email or password" });
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

/* A browser can hold a valid app-session cookie without ever having gone
   through /login on that device — e.g. the owner's phone that only opened
   /back. The till bundle reads its cloud pairing from localStorage, so on
   such a device /app boots into the bundle's baked-in standalone demo
   ("Nexus Café") instead of the user's store. This mints the pairing for
   the cookie's org (new register, same as a fresh login) so "Open the
   till" works from any signed-in device; the caller stores it in
   localStorage before navigating. */
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
  const r = await pool.query("SELECT * FROM platform_admins WHERE email=$1", [(email || "").toLowerCase()]);
  const admin = r.rows[0];
  if (!admin || !bcrypt.compareSync(password || "", admin.pass_hash)) return res.status(401).json({ error: "wrong email or password" });
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
  const client = await pool.connect();
  let rowver = 0;
  const settledSales = [];
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id',$1,true), set_config('app.is_superadmin','off',true)", [String(req.org.o)]);
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
                  " || CASE WHEN NOT (excluded.data ? 'catGroups') AND entities.data ? 'catGroups' THEN jsonb_build_object('catGroups', entities.data->'catGroups') ELSE '{}'::jsonb END"
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
        const r = await client.query(
          `UPDATE entities SET
             data = data
               || jsonb_build_object('points', COALESCE((data->>'points')::numeric, 0) + $3)
               || jsonb_build_object('balance', GREATEST(0, COALESCE((data->>'balance')::numeric, 0) + $4)),
             rowver = nextval('entities_rowver_seq'), updated_at = now()
           WHERE org_id=$1 AND kind='customers' AND id=$2 RETURNING rowver`,
          [req.org.o, String(c.id), Number(c.pts) || 0, Number(c.bal) || 0]);
        for (const row of r.rows) rowver = Math.max(rowver, Number(row.rowver));
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
    return res.status(500).json({ error: "ops failed: " + errDetail(e) });
  }
  client.release();
  if (rowver) poke(req.org.o, rowver);
  /* Recipe-based ingredient deduction runs AFTER the sync commit, never
     inside it: a till sale must never be rejected because inventory math
     failed. The ledger's (org_id, ref, ingredient_id) uniqueness makes the
     deduction idempotent, so a crash between commit and here at worst skips
     a deduction the next audit reconciles — it can never double-deduct. */
  if (settledSales.length) inventory.processSales(req.org.o, settledSales);
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
    products: products.filter((p) => hasRecipe.has(String(p.id)) || p.stock == null || Number(p.stock) > 0).map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, cat: p.cat, price: p.price, unit: p.unit, img: p.img || "", desc: p.desc || "", allergens: p.allergens || "", addons: Array.isArray(p.addons) ? p.addons : [], spiceLevels: Array.isArray(p.spiceLevels) ? p.spiceLevels : [], comments: !!p.comments, noKitchen: !!p.noKitchen, stock: p.stock, storeId: p.storeId || "global", soldOut: p.recipeAvail != null ? Number(p.recipeAvail) <= 0 : (p.stock != null && Number(p.stock) <= 0), soldOutReason: p.soldOutReason || null })),
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
    const src = p || ci;
    if (!src || (!pid && !src.name)) return null;
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
