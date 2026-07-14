/*
 * Bulk menu import — wipe all existing products and replace them from a JSON
 * list, over the till's own sync API (so the change flows to every device).
 *
 * Usage:
 *   TOKEN=<store bearer token> \
 *   API_BASE=https://<your-app>            (default http://127.0.0.1:4014) \
 *   ITEMS=./scripts/amico-menu.json        (default) \
 *   STOCK=30                               (opening stock for every item) \
 *   node scripts/import-menu.mjs
 *
 * The TOKEN is the till/ops bearer token for the target store (the same token
 * the register receives from /api/register or /api/login). Get it from that
 * store — never hard-code it here.
 *
 * Each item in the JSON: { sku, name, cat, priceMVR, taxable, emoji, img, desc }
 * Prices are MVR in the file and stored as laari (×100). `img` may be a URL or
 * an image data URI; the till renders either.
 */
import { readFileSync } from "fs";

const BASE = process.env.API_BASE || "http://127.0.0.1:4014";
const TOKEN = process.env.TOKEN;
const STOCK = Number(process.env.STOCK || 30);
const ITEMS = process.env.ITEMS || new URL("./amico-menu.json", import.meta.url).pathname;
if (!TOKEN) { console.error("Set TOKEN to the target store's bearer token."); process.exit(1); }

const items = JSON.parse(readFileSync(ITEMS, "utf8"));
const H = { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN };
const post = (op) => fetch(BASE + "/api/ops", { method: "POST", headers: H, body: JSON.stringify({ ops: [op] }) }).then((r) => r.json());
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
let opN = 0; const oid = () => "import-" + Date.now() + "-" + (++opN);

// 1) remove every current product
const pull = await fetch(BASE + "/api/pull?since=0", { headers: H }).then((r) => r.json());
const existing = (pull.entities || []).filter((e) => e.kind === "products" && !e.deleted).map((e) => e.id);
console.log("removing", existing.length, "existing products…");
for (const c of chunk(existing, 40)) {
  const r = await post({ opId: oid(), dels: c.map((id) => ({ kind: "products", id })) });
  if (!r.ok) console.error("delete op failed:", r);
}

// 2) insert the new menu
const puts = items.map((it) => ({
  kind: "products", id: it.sku,
  data: {
    id: it.sku, name: it.name, emoji: it.emoji || "🍽️", cat: it.cat || "General",
    price: Math.round(Number(it.priceMVR || 0) * 100), cost: 0, unit: "pcs",
    stock: STOCK, taxable: !!it.taxable, img: it.img || "", desc: it.desc || "",
  },
}));
let inserted = 0;
for (const c of chunk(puts, 20)) {
  const r = await post({ opId: oid(), puts: c });
  if (!r.ok) console.error("insert op failed:", r); else inserted += c.length;
}
console.log("inserted", inserted, "of", items.length, "items (stock " + STOCK + " each)");

// 3) verify
const after = await fetch(BASE + "/api/pull?since=0", { headers: H }).then((r) => r.json());
const now = (after.entities || []).filter((e) => e.kind === "products" && !e.deleted);
console.log("products now live:", now.length,
  "| all stock " + STOCK + ":", now.every((e) => e.data.stock === STOCK),
  "| all have image:", now.every((e) => !!e.data.img));
