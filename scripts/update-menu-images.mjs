/*
 * Update menu-item photos in bulk from a folder of local images, over the
 * back-office API (PUT /api/inv/products/:id/image). Each image rides the
 * normal sync stream onto every till tile and the guest QR menu. Images are
 * embedded straight from disk as data URIs, so the photos also work offline.
 *
 * Usage:
 *   TOKEN=<store bearer token OR kashikeyo_session cookie value> \
 *   API_BASE=https://<your-app>          (default http://127.0.0.1:4014) \
 *   DIR=./scripts/product-images         (default; folder of pN-<slug>.<ext>) \
 *   DRY=1                                 (optional: match + report, no writes) \
 *   node scripts/update-menu-images.mjs
 *
 * File naming: <productId>-<slug>.<png|jpg|jpeg|webp>, e.g. `p3-iced-latte.webp`.
 * The leading token before the first "-" is the product id (p3); the rest is a
 * human slug used only as a fallback matcher. Matching order per image:
 *   1) product whose entity id equals the file's id (p3),
 *   2) product whose SKU/`sku` field equals it,
 *   3) product whose name, normalised (lowercased, non-alphanumerics stripped),
 *      equals the slug normalised the same way ("iced-latte" -> "icedlatte").
 * Unmatched images and unmatched products are listed at the end so nothing is
 * silently skipped.
 *
 * The endpoint validates the payload is a data:image/(png|jpeg|webp) and caps
 * it at 700 KB; this script reports (and skips) anything larger rather than
 * failing the whole run. Auth accepts either the ops bearer token or the
 * kashikeyo_session cookie value in TOKEN (sent as both, whichever the server
 * honours).
 */
import { readFileSync, readdirSync } from "fs";
import path from "path";

const BASE = (process.env.API_BASE || "http://127.0.0.1:4014").replace(/\/$/, "");
const TOKEN = process.env.TOKEN;
const DIR = process.env.DIR || new URL("./product-images", import.meta.url).pathname;
const DRY = process.env.DRY === "1" || process.env.DRY === "true";
if (!TOKEN) { console.error("Set TOKEN to the target store's bearer token (or kashikeyo_session cookie value)."); process.exit(1); }

const H = {
  "Content-Type": "application/json",
  Authorization: "Bearer " + TOKEN,
  Cookie: "kashikeyo_session=" + TOKEN,
};
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const MAX = 700000; // matches the server's per-image cap
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/* Read the image folder into { id, slug, file, dataUri, bytes }. */
const images = readdirSync(DIR)
  .filter((f) => MIME[path.extname(f).toLowerCase()])
  .map((f) => {
    const ext = path.extname(f).toLowerCase();
    const base = f.slice(0, -ext.length);
    const dash = base.indexOf("-");
    const id = dash === -1 ? base : base.slice(0, dash);
    const slug = dash === -1 ? "" : base.slice(dash + 1);
    const buf = readFileSync(path.join(DIR, f));
    return { id, slug, file: f, bytes: buf.length, dataUri: "data:" + MIME[ext] + ";base64," + buf.toString("base64") };
  })
  .sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }));

if (!images.length) { console.error("No images found in", DIR); process.exit(1); }
console.log(`found ${images.length} image(s) in ${DIR}${DRY ? "  (DRY RUN — no writes)" : ""}`);

/* Pull the live product catalogue so we can resolve each image to a product. */
const pull = await fetch(BASE + "/api/pull?since=0", { headers: H }).then((r) => r.json()).catch((e) => {
  console.error("pull failed:", e.message); process.exit(1);
});
const products = (pull.entities || []).filter((e) => e.kind === "products" && !e.deleted).map((e) => ({ id: e.id, ...e.data }));
const byId = new Map(products.map((p) => [String(p.id), p]));
const bySku = new Map(products.filter((p) => p.sku).map((p) => [norm(p.sku), p]));
const byName = new Map(products.map((p) => [norm(p.name), p]));

function match(img) {
  return byId.get(String(img.id)) || bySku.get(norm(img.id)) || (img.slug && byName.get(norm(img.slug))) || null;
}

let updated = 0, skippedBig = 0, failed = 0;
const unmatched = [];
const matchedProductIds = new Set();

for (const img of images) {
  const p = match(img);
  if (!p) { unmatched.push(img.file); continue; }
  matchedProductIds.add(String(p.id));
  if (img.bytes > MAX) {
    console.error(`  ! ${img.file} -> ${p.id} (${p.name}) — ${img.bytes}B exceeds ${MAX}B cap, skipped`);
    skippedBig++; continue;
  }
  if (DRY) { console.log(`  · ${img.file} -> ${p.id} (${p.name})`); updated++; continue; }
  try {
    const res = await fetch(BASE + "/api/inv/products/" + encodeURIComponent(p.id) + "/image", {
      method: "PUT", headers: H, body: JSON.stringify({ img: img.dataUri }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) { console.log(`  ✓ ${img.file} -> ${p.id} (${p.name})`); updated++; }
    else { console.error(`  ✗ ${img.file} -> ${p.id}: ${res.status} ${body.error || ""}`); failed++; }
  } catch (e) { console.error(`  ✗ ${img.file} -> ${p.id}: ${e.message}`); failed++; }
}

console.log(`\n${DRY ? "would update" : "updated"} ${updated} · skipped(too large) ${skippedBig} · failed ${failed}`);
if (unmatched.length) console.log("no matching product for:", unmatched.join(", "));
const noPhoto = products.filter((p) => !matchedProductIds.has(String(p.id))).map((p) => p.id + "|" + p.name);
if (noPhoto.length) console.log(`products left without a new photo (${noPhoto.length}): ${noPhoto.slice(0, 40).join(", ")}${noPhoto.length > 40 ? " …" : ""}`);
