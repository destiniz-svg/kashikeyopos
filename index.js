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

const PORT = process.env.PORT || 4000;
const SECRET = process.env.JWT_SECRET || "kashikeyo-dev-secret-change-me";
const DEFAULT_STORE_ID = "main";
const SHARED_KINDS = new Set(["settings", "customers", "units", "categories", "vendors"]);
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.RAILWAY_DATABASE_URL || "";
const hasPgEnv = !!(process.env.PGHOST || process.env.PGUSER || process.env.PGDATABASE);
const localDatabaseUrl = process.env.NODE_ENV === "production" ? "" : "postgres://kash:kash@127.0.0.1:5432/kash";
const connectionString = databaseUrl || (hasPgEnv ? "" : localDatabaseUrl);
const poolConfig = connectionString ? { connectionString } : {};
if (connectionString && !/localhost|127\.0\.0\.1/.test(connectionString)) poolConfig.ssl = { rejectUnauthorized: false };
if (process.env.NODE_ENV === "production" && !databaseUrl && !hasPgEnv) console.warn("No Postgres variables found. Attach DATABASE_URL.");
const pool = new Pool(poolConfig);

(async () => {
  try {
    await pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
    console.log("schema ready");
  } catch (e) { console.error("schema init failed:", e.message); }
})();

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
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
const storageId = (kind, id, storeId, shared) => {
  const raw = String(id);
  if (shared || raw.includes(":")) return raw;
  return cleanStoreId(storeId) + ":" + raw;
};
const publicId = (row) => String(row.data && row.data.id ? row.data.id : row.id).split(":").pop();

const hubs = new Map();
const poke = (orgId, rowver) => {
  const set = hubs.get(orgId);
  if (!set) return;
  for (const res of set) { try { res.write(`data: ${JSON.stringify({ rowver })}\n\n`); } catch {} }
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

async function ensureDefaultStore(orgId, storeName = "Main Store") {
  await pool.query(
    `INSERT INTO stores (org_id, id, code, name)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (org_id, id) DO NOTHING`,
    [orgId, DEFAULT_STORE_ID, "MAIN", storeName || "Main Store"]);
}

async function orgBySlug(slug) {
  return (await pool.query("SELECT * FROM orgs WHERE slug=$1", [slug])).rows[0];
}

async function kindAll(orgId, kind, storeId = DEFAULT_STORE_ID) {
  const r = await pool.query("SELECT id, data FROM entities WHERE org_id=$1 AND kind=$2 AND deleted=false", [orgId, kind]);
  return r.rows.map((row) => row.data).filter((data) => isVisibleInStore(data, storeId));
}

const lineTotal = (l) => Math.round(Number(l.price || 0) * Number(l.qty || 1) * (1 - (Number(l.discPct || 0)) / 100));

app.post("/api/register", wrap(async (req, res) => {
  const { email, password, storeName } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  const base = slugify(storeName || email.split("@")[0]);
  let slug = base;
  for (let i = 0; i < 5; i++) {
    const hit = await pool.query("SELECT 1 FROM orgs WHERE slug=$1", [slug]);
    if (!hit.rowCount) break;
    slug = base + "-" + crypto.randomBytes(2).toString("hex");
  }
  const id = uid();
  try {
    await pool.query(
      "INSERT INTO orgs (id, slug, email, pass_hash, store_name, registers) VALUES ($1,$2,$3,$4,$5,1)",
      [id, slug, email.toLowerCase(), bcrypt.hashSync(password, 10), storeName || "My Store"]);
  } catch {
    return res.status(409).json({ error: "email already registered - use Sign in" });
  }
  await ensureDefaultStore(id, storeName || "Main Store");
  res.json({ token: sign(id, "R1", DEFAULT_STORE_ID), slug, register: "R1", storeId: DEFAULT_STORE_ID });
}));

app.post("/api/login", wrap(async (req, res) => {
  const { email, password, storeId } = req.body || {};
  const r = await pool.query("SELECT * FROM orgs WHERE email=$1", [(email || "").toLowerCase()]);
  const org = r.rows[0];
  if (!org || !bcrypt.compareSync(password || "", org.pass_hash)) return res.status(401).json({ error: "wrong email or password" });
  await ensureDefaultStore(org.id, org.store_name);
  const selectedStore = cleanStoreId(storeId || DEFAULT_STORE_ID);
  const store = await pool.query("SELECT 1 FROM stores WHERE org_id=$1 AND id=$2 AND active=true", [org.id, selectedStore]);
  if (!store.rowCount) return res.status(404).json({ error: "unknown store" });
  const upd = await pool.query("UPDATE orgs SET registers = registers + 1 WHERE id=$1 RETURNING registers", [org.id]);
  const register = "R" + upd.rows[0].registers;
  res.json({ token: sign(org.id, register, selectedStore), slug: org.slug, register, storeId: selectedStore });
}));

app.get("/api/stores", auth, wrap(async (req, res) => {
  await ensureDefaultStore(req.org.o);
  const r = await pool.query("SELECT id, code, name, address, active, created_at FROM stores WHERE org_id=$1 ORDER BY created_at ASC", [req.org.o]);
  res.json({ stores: r.rows.map((s) => ({ id: s.id, code: s.code, name: s.name, address: s.address, active: s.active, createdAt: s.created_at })) });
}));

app.post("/api/stores", auth, wrap(async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "store name required" });
  const id = cleanStoreId(req.body?.id || name);
  const code = String(req.body?.code || id).toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 16) || "STORE";
  const address = String(req.body?.address || "").slice(0, 200);
  const r = await pool.query(
    `INSERT INTO stores (org_id, id, code, name, address) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (org_id, id) DO UPDATE SET code=excluded.code, name=excluded.name, address=excluded.address, active=true
     RETURNING id, code, name, address, active`,
    [req.org.o, id, code, name, address]);
  res.json({ store: r.rows[0] });
}));

app.post("/api/select-store", auth, wrap(async (req, res) => {
  const storeId = cleanStoreId(req.body?.storeId || req.query.storeId || DEFAULT_STORE_ID);
  const hit = await pool.query("SELECT * FROM stores WHERE org_id=$1 AND id=$2 AND active=true", [req.org.o, storeId]);
  if (!hit.rowCount) return res.status(404).json({ error: "unknown store" });
  res.json({ token: sign(req.org.o, req.org.r, storeId), register: req.org.r, storeId, store: hit.rows[0] });
}));

app.post("/api/ops", auth, wrap(async (req, res) => {
  const ops = (req.body && req.body.ops) || [];
  const client = await pool.connect();
  let rowver = 0;
  try {
    await client.query("BEGIN");
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
          ? " || jsonb_build_object('stock', COALESCE(entities.data->'stock', excluded.data->'stock', '0'::jsonb))"
          : p.kind === "customers"
            ? " || jsonb_build_object('points', COALESCE(entities.data->'points', excluded.data->'points', '0'::jsonb), 'balance', COALESCE(entities.data->'balance', excluded.data->'balance', '0'::jsonb))"
            : "";
        const r = await client.query(
          `INSERT INTO entities (org_id, kind, id, data, deleted, updated_at)
           VALUES ($1,$2,$3,$4,false,now())
           ON CONFLICT (org_id, kind, id)
           DO UPDATE SET data = excluded.data${preserve}, deleted=false, rowver=nextval('entities_rowver_seq'), updated_at=now()
           RETURNING rowver`,
          [req.org.o, p.kind, storageId(p.kind, p.id, data.storeId || "global", shared), JSON.stringify(data)]);
        rowver = Math.max(rowver, Number(r.rows[0].rowver));
      }
      const dz = op.deltas || {};
      for (const s of dz.stock || []) {
        const ids = [String(s.id), storageId("products", s.id, storeId, false)];
        const r = await client.query(
          `UPDATE entities SET
             data = jsonb_set(data, '{stock}', to_jsonb(COALESCE((data->>'stock')::numeric, 0) + $4), true),
             rowver = nextval('entities_rowver_seq'), updated_at = now()
           WHERE org_id=$1 AND kind='products' AND id = ANY($2) AND COALESCE(data->>'storeId',$3) IN ('global',$3)
           RETURNING rowver`, [req.org.o, ids, storeId, Number(s.d) || 0]);
        for (const row of r.rows) rowver = Math.max(rowver, Number(row.rowver));
      }
      for (const c of dz.cust || []) {
        const r = await client.query(
          `UPDATE entities SET
             data = data
               || jsonb_build_object('points', COALESCE((data->>'points')::numeric, 0) + $4)
               || jsonb_build_object('balance', GREATEST(0, COALESCE((data->>'balance')::numeric, 0) + $5)),
             rowver = nextval('entities_rowver_seq'), updated_at = now()
           WHERE org_id=$1 AND kind='customers' AND id=$2 RETURNING rowver`,
          [req.org.o, String(c.id), Number(c.pts) || 0, Number(c.bal) || 0]);
        for (const row of r.rows) rowver = Math.max(rowver, Number(row.rowver));
      }
      for (const d of op.dels || []) {
        const shared = SHARED_KINDS.has(d.kind) && !d.storeId;
        const id = storageId(d.kind, d.id, cleanStoreId(d.storeId || storeId), shared);
        const r = await client.query(
          `UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now()
           WHERE org_id=$1 AND kind=$2 AND id=$3 RETURNING rowver`, [req.org.o, d.kind, id]);
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
  res.json({ ok: true, rowver });
}));

app.get("/api/pull", auth, wrap(async (req, res) => {
  const since = Number(req.query.since) || 0;
  const storeId = cleanStoreId(req.query.storeId || req.org.s || DEFAULT_STORE_ID);
  const r = await pool.query(
    `SELECT kind, id, data, deleted, rowver FROM entities
     WHERE org_id=$1 AND rowver>$2 AND COALESCE(data->>'storeId','global') IN ('global',$3)
     ORDER BY rowver ASC LIMIT 500`, [req.org.o, since, storeId]);
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

app.get("/p/:slug/boot", wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const storeId = cleanStoreId(req.query.storeId || req.query.store || req.query.st || DEFAULT_STORE_ID);
  await ensureDefaultStore(org.id, org.store_name);
  const [settingsArr, products, zones, tables, stores] = await Promise.all([
    kindAll(org.id, "settings", storeId), kindAll(org.id, "products", storeId), kindAll(org.id, "zones", storeId), kindAll(org.id, "tables", storeId),
    pool.query("SELECT id, code, name, address FROM stores WHERE org_id=$1 AND active=true ORDER BY created_at ASC", [org.id])]);
  const settings = settingsArr[0] || { storeName: org.store_name, gstBp: 800, currency: "MVR" };
  let cust = null;
  if (req.query.c) {
    const c = (await kindAll(org.id, "customers", storeId)).find((x) => idEq(x.id, req.query.c));
    if (c) {
      const mine = (await kindAll(org.id, "orders", storeId)).filter((o) => idEq(o.customerId, c.id) && o.status === "completed");
      const spent = mine.reduce((a, o) => {
        const sub = (o.items || []).reduce((x, l) => x + lineTotal(l), 0) + (o.fee || 0);
        return a + sub + Math.round(sub * (settings.gstBp || 800) / 10000);
      }, 0);
      cust = { id: c.id, name: c.name, points: c.points || 0, balance: c.balance || 0, address: c.address || "", visits: mine.length, spent };
    }
  }
  res.json({ settings, storeId, stores: stores.rows, zones,
    tables: tables.map((t) => t.name),
    products: products.filter((p) => (p.stock || 0) > 0).map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, cat: p.cat, price: p.price, unit: p.unit, img: p.img || "", stock: p.stock, storeId: p.storeId || "global" })),
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
    return { pid: p ? p.id : pid || String(src.id || uid()), name: src.name || "Item", emoji: src.emoji || "", price: Number(src.price) || 0, cost: Number(src.cost) || 0, unit: src.unit || "pcs", vendor: !!src.vendor, qty: Math.max(1, Math.min(99, Number(ci.qty) || 1)), discPct: Number(src.discPct) || 0 };
  }).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: "those items are unavailable" });
  const otype = gtype === "delivery" ? "delivery" : gtype === "pickup" ? "takeaway" : "dinein";
  const zone = otype === "delivery" ? zones.find((z) => idEq(z.id, zoneId)) || null : null;
  const cust = custId !== null && custId !== undefined && custId !== "" ? customers.find((c) => idEq(c.id, custId)) || null : null;
  const upd = await pool.query("UPDATE orgs SET oseq = oseq + 1 WHERE id=$1 RETURNING oseq", [org.id]);
  const order = { id: uid(), no: "ORD-" + upd.rows[0].oseq, storeId, table: table || (otype === "delivery" ? "Delivery" : "Pickup"), items: lines, status: "new", createdAt: Date.now(), paidOnline: !!payOnline, call: false, source: "qr", otype, covers: 1, customerId: cust ? cust.id : null, customerName: cust ? cust.name : null, zone: zone ? zone.name : null, fee: zone ? zone.fee : 0, note: String(note || "").slice(0, 200) || (otype === "delivery" && cust ? cust.address || "" : "") };
  const r = await pool.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'orders',$2,$3) RETURNING rowver", [org.id, storageId("orders", order.id, storeId, false), JSON.stringify(order)]);
  poke(org.id, Number(r.rows[0].rowver));
  res.json({ ok: true, order });
}));

app.get("/p/:slug/orders", wrap(async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const storeId = cleanStoreId(req.query.storeId || req.query.store || req.query.st || DEFAULT_STORE_ID);
  const mine = (await kindAll(org.id, "orders", storeId)).filter((o) => (req.query.c ? idEq(o.customerId, req.query.c) : idEq(o.table, req.query.t))).sort((a, b) => b.createdAt - a.createdAt).slice(0, 25);
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
  const r = await pool.query("INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'waiterCalls',$2,$3) RETURNING rowver", [org.id, storageId("waiterCalls", call.id, storeId, false), JSON.stringify(call)]);
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
    const r = await pool.query("SELECT slug FROM orgs");
    if (r.rowCount === 1) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query)) q.set(k, String(v));
      q.set("s", r.rows[0].slug);
      return res.redirect(302, "/?" + q.toString());
    }
  }
  next();
}));

const webDir = path.join(__dirname, "web", "dist");
if (fs.existsSync(webDir)) {
  const noCacheShell = { setHeaders: (res, file) => { if (file.endsWith(".html") || file.endsWith("sw.js")) res.set("Cache-Control", "no-cache"); } };
  app.use(express.static(webDir, noCacheShell));
  app.get(/^\/(?!api|p\/).*/, (req, res) => res.sendFile(path.join(webDir, "index.html"), { headers: { "Cache-Control": "no-cache" } }));
}

app.use((err, req, res, next) => {
  console.error("request failed:", req.method, req.originalUrl, errDetail(err));
  if (res.headersSent) return res.end();
  res.status(500).json({ error: "something went wrong on our side - please try again" });
});
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", errDetail(e)));
app.listen(PORT, () => console.log("KashikeyoPOS Cloud on :" + PORT));
