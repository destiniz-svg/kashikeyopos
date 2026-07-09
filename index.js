/* KashikeyoPOS Cloud — Phase 2 Stage 1
   Postgres-backed sync: catalog + orders + waiter calls across devices,
   public guest endpoints for customer/table links, SSE real-time pokes. */
const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 4000;
const SECRET = process.env.JWT_SECRET || "kashikeyo-dev-secret-change-me";
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.RAILWAY_DATABASE_URL || "";
const hasPgEnv = !!(process.env.PGHOST || process.env.PGUSER || process.env.PGDATABASE);
const localDatabaseUrl = process.env.NODE_ENV === "production" ? "" : "postgres://kash:kash@127.0.0.1:5432/kash";
const connectionString = databaseUrl || (hasPgEnv ? "" : localDatabaseUrl);
const poolConfig = connectionString ? { connectionString } : {};
if (connectionString && !/localhost|127\.0\.0\.1/.test(connectionString)) poolConfig.ssl = { rejectUnauthorized: false };
if (process.env.NODE_ENV === "production" && !databaseUrl && !hasPgEnv) {
  console.warn("No Railway Postgres variables found. Attach a Postgres database or add DATABASE_URL.");
}
const pool = new Pool(poolConfig);
/* auto-migrate: create tables on first boot (schema is idempotent) */
(async () => {
  try {
    await pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
    console.log("schema ready");
  } catch (e) { console.error("schema init failed:", e.message); }
})();

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use((req, res, next) => {           // CORS for tills paired from other origins
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const uid = () => crypto.randomUUID();
const slugify = (s) => (s || "shop").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "shop";
const errDetail = (e) => [e && e.message, e && e.code, e && e.address, e && e.port].filter(Boolean).join(" ") || String(e || "unknown error");

/* ── SSE hub: org → set of responses ── */
const hubs = new Map();
const poke = (orgId, rowver) => {
  const set = hubs.get(orgId);
  if (!set) return;
  for (const res of set) { try { res.write(`data: ${JSON.stringify({ rowver })}\n\n`); } catch {} }
};

/* ── auth ── */
const sign = (orgId, register) => jwt.sign({ o: orgId, r: register }, SECRET, { expiresIn: "365d" });
const auth = (req, res, next) => {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : req.query.token;
  try { req.org = jwt.verify(tok, SECRET); next(); }
  catch { res.status(401).json({ error: "unauthorized" }); }
};

app.post("/api/register", async (req, res) => {
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
  } catch (e) {
    return res.status(409).json({ error: "email already registered — use Sign in" });
  }
  res.json({ token: sign(id, "R1"), slug, register: "R1" });
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body || {};
  const r = await pool.query("SELECT * FROM orgs WHERE email=$1", [(email || "").toLowerCase()]);
  const org = r.rows[0];
  if (!org || !bcrypt.compareSync(password || "", org.pass_hash))
    return res.status(401).json({ error: "wrong email or password" });
  const upd = await pool.query("UPDATE orgs SET registers = registers + 1 WHERE id=$1 RETURNING registers", [org.id]);
  const register = "R" + upd.rows[0].registers;
  res.json({ token: sign(org.id, register), slug: org.slug, register });
});

/* ── op-log sync: idempotent batched puts/dels ── */
app.post("/api/ops", auth, async (req, res) => {
  const ops = (req.body && req.body.ops) || [];
  const client = await pool.connect();
  let rowver = 0;
  try {
    await client.query("BEGIN");
    for (const op of ops) {
      const dup = await client.query(
        "INSERT INTO ops (org_id, op_id, register) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1",
        [req.org.o, op.opId || uid(), req.org.r]);
      if (!dup.rowCount) continue;                       // replay -> skip
      for (const p of op.puts || []) {
        /* Stage 2: server owns the counters; puts never clobber stock / balance / points. */
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
           RETURNING rowver`, [req.org.o, p.kind, String(p.id), JSON.stringify(p.data)]);
        rowver = Math.max(rowver, Number(r.rows[0].rowver));
      }
      /* Stage 2: arithmetic deltas; multi-till safe stock & credit. */
      const dz = op.deltas || {};
      for (const s of dz.stock || []) {
        const r = await client.query(
          `UPDATE entities SET
             data = jsonb_set(data, '{stock}', to_jsonb(COALESCE((data->>'stock')::numeric, 0) + $4), true),
             rowver = nextval('entities_rowver_seq'), updated_at = now()
           WHERE org_id=$1 AND kind=$2 AND id=$3 RETURNING rowver`,
          [req.org.o, "products", String(s.id), Number(s.d) || 0]);
        if (r.rowCount) rowver = Math.max(rowver, Number(r.rows[0].rowver));
      }
      for (const c of dz.cust || []) {
        const r = await client.query(
          `UPDATE entities SET
             data = data
               || jsonb_build_object('points', COALESCE((data->>'points')::numeric, 0) + $4)
               || jsonb_build_object('balance', GREATEST(0, COALESCE((data->>'balance')::numeric, 0) + $5)),
             rowver = nextval('entities_rowver_seq'), updated_at = now()
           WHERE org_id=$1 AND kind=$2 AND id=$3 RETURNING rowver`,
          [req.org.o, "customers", String(c.id), Number(c.pts) || 0, Number(c.bal) || 0]);
        if (r.rowCount) rowver = Math.max(rowver, Number(r.rows[0].rowver));
      }
      for (const d of op.dels || []) {
        const r = await client.query(
          `UPDATE entities SET deleted=true, rowver=nextval('entities_rowver_seq'), updated_at=now()
           WHERE org_id=$1 AND kind=$2 AND id=$3 RETURNING rowver`, [req.org.o, d.kind, String(d.id)]);
        if (r.rowCount) rowver = Math.max(rowver, Number(r.rows[0].rowver));
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
});

app.get("/api/pull", auth, async (req, res) => {
  const since = Number(req.query.since) || 0;
  const r = await pool.query(
    "SELECT kind, id, data, deleted, rowver FROM entities WHERE org_id=$1 AND rowver > $2 ORDER BY rowver ASC LIMIT 500",
    [req.org.o, since]);
  const entities = r.rows.map((x) => ({ kind: x.kind, id: x.id, data: x.data, deleted: x.deleted, rowver: Number(x.rowver) }));
  const rowver = entities.length ? entities[entities.length - 1].rowver : since;
  res.json({ rowver, entities, more: entities.length === 500 });
});

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

/* ── public guest endpoints (customer/table links) ── */
const orgBySlug = async (slug) => (await pool.query("SELECT * FROM orgs WHERE slug=$1", [slug])).rows[0];
const kindAll = async (orgId, kind) =>
  (await pool.query("SELECT id, data FROM entities WHERE org_id=$1 AND kind=$2 AND deleted=false", [orgId, kind]))
    .rows.map((r) => r.data);
const lineTotal = (l) => Math.round(l.price * l.qty * (1 - (l.discPct || 0) / 100));

app.get("/p/:slug/boot", async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const [settingsArr, products, zones, tables] = await Promise.all([
    kindAll(org.id, "settings"), kindAll(org.id, "products"), kindAll(org.id, "zones"), kindAll(org.id, "tables")]);
  const settings = settingsArr[0] || { storeName: org.store_name, gstBp: 800, currency: "MVR" };
  let cust = null;
  if (req.query.c) {
    const cs = await kindAll(org.id, "customers");
    const c = cs.find((x) => x.id === req.query.c);
    if (c) {
      const orders = await kindAll(org.id, "orders");
      const mine = orders.filter((o) => o.customerId === c.id && o.status === "completed");
      const spent = mine.reduce((a, o) => {
        const sub = (o.items || []).reduce((x, l) => x + lineTotal(l), 0) + (o.fee || 0);
        return a + sub + Math.round(sub * (settings.gstBp || 800) / 10000);
      }, 0);
      cust = { id: c.id, name: c.name, points: c.points || 0, balance: c.balance || 0,
               address: c.address || "", visits: mine.length, spent };
    }
  }
  res.json({ settings, zones,
    tables: tables.map((t) => t.name),
    products: products.filter((p) => (p.stock || 0) > 0)
      .map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, cat: p.cat, price: p.price, unit: p.unit, img: p.img || "", stock: p.stock })),
    cust });
});

app.post("/p/:slug/order", async (req, res) => {
  try {
    const org = await orgBySlug(req.params.slug);
    if (!org) return res.status(404).json({ error: "unknown workspace" });
    const { items, table, custId, gtype, zoneId, note, payOnline } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "cart is empty" });
    const [products, zones, customers] = await Promise.all([
      kindAll(org.id, "products"), kindAll(org.id, "zones"), kindAll(org.id, "customers")]);
    const lines = items.map((ci) => {
      const pid = String(ci.pid || ci.id || ci.productId || "");
      const p = products.find((x) => String(x.id) === pid);
      const src = p || ci;
      if (!src || (!pid && !src.name)) return null;
      return { pid: p ? p.id : pid || String(src.id || uid()), name: src.name || "Item", emoji: src.emoji || "",
               price: Number(src.price) || 0, cost: Number(src.cost) || 0, unit: src.unit || "pcs",
               vendor: !!src.vendor, qty: Math.max(1, Math.min(99, Number(ci.qty) || 1)), discPct: Number(src.discPct) || 0 };
    }).filter(Boolean);
    if (!lines.length) return res.status(400).json({ error: "those items are unavailable" });
    const otype = gtype === "delivery" ? "delivery" : gtype === "pickup" ? "takeaway" : "dinein";
    const zone = otype === "delivery" ? zones.find((z) => z.id === zoneId) || null : null;
    const cust = custId ? customers.find((c) => c.id === custId) || null : null;
    const upd = await pool.query("UPDATE orgs SET oseq = oseq + 1 WHERE id=$1 RETURNING oseq", [org.id]);
    const order = {
      id: uid(), no: "ORD-" + upd.rows[0].oseq,
      table: table || (otype === "delivery" ? "Delivery" : "Pickup"),
      items: lines, status: "new", createdAt: Date.now(), paidOnline: !!payOnline, call: false,
      source: "qr", otype, covers: 1,
      customerId: cust ? cust.id : null, customerName: cust ? cust.name : null,
      zone: zone ? zone.name : null, fee: zone ? zone.fee : 0,
      note: String(note || "").slice(0, 200) || (otype === "delivery" && cust ? cust.address || "" : "") };
    const r = await pool.query(
      `INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'orders',$2,$3) RETURNING rowver`,
      [org.id, order.id, JSON.stringify(order)]);
    poke(org.id, Number(r.rows[0].rowver));
    res.json({ ok: true, order });
  } catch (e) {
    const detail = errDetail(e);
    console.error("guest order failed:", detail, e);
    res.status(500).json({ error: "order failed: " + detail });
  }
});

app.get("/p/:slug/orders", async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const orders = await kindAll(org.id, "orders");
  const mine = orders.filter((o) => (req.query.c ? o.customerId === req.query.c : o.table === req.query.t))
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 25);
  res.json({ orders: mine });
});

app.post("/p/:slug/call", async (req, res) => {
  const org = await orgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: "unknown workspace" });
  const { table, custId } = req.body || {};
  let name = null;
  if (custId) { const cs = await kindAll(org.id, "customers"); name = (cs.find((c) => c.id === custId) || {}).name || null; }
  const call = { id: uid(), table: table || (name ? "Pickup" : "—"), name, t: Date.now() };
  const r = await pool.query(
    "INSERT INTO entities (org_id, kind, id, data) VALUES ($1,'waiterCalls',$2,$3) RETURNING rowver",
    [org.id, call.id, JSON.stringify(call)]);
  poke(org.id, Number(r.rows[0].rowver));
  res.json({ ok: true });
});

app.get("/api/health", async (req, res) => {
  const dbEnv = { databaseUrl: !!databaseUrl, pgEnv: hasPgEnv };
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "kashikeyo-cloud", db: true, dbEnv });
  } catch (e) {
    res.status(500).json({ ok: false, service: "kashikeyo-cloud", db: false, dbEnv, error: errDetail(e) });
  }
});

/* ── serve the till + guest PWA ── */
const webDir = path.join(__dirname, "web", "dist");
if (fs.existsSync(webDir)) {
  app.use(express.static(webDir));
  app.get(/^\/(?!api|p\/).*/, (req, res) => res.sendFile(path.join(webDir, "index.html")));
}

app.listen(PORT, () => console.log("KashikeyoPOS Cloud on :" + PORT));
