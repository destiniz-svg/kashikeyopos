"use strict";

/*
 * Canonical starter menu shared by every outlet.
 *
 * The 19 products below are seeded (as GLOBAL products — no storeId, so they
 * are shared across every store/branch in an org) into each org on
 * registration, and idempotently backfilled into existing orgs on boot
 * (see ensureDefaultMenu / the boot backfill in index.js). Because they are
 * plain `products` entities they flow through the normal sync stream onto the
 * main POS (till) tiles and the guest/user QR portals alike.
 *
 * Photos are read from scripts/product-images/ (shipped in the Docker image
 * via `COPY . .`) and embedded as offline data URIs so the menu images work
 * offline and travel with the entity. Prices are MVR in the table and stored
 * as laari (×100). Items are left stock-untracked (no `stock` key) so they are
 * always sellable until an outlet opts a line into stock tracking.
 */

const fs = require("fs");
const path = require("path");

const IMG_DIR = path.join(__dirname, "scripts", "product-images");
const MIME = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

function imgDataUri(file) {
  try {
    const ext = path.extname(file).toLowerCase();
    const buf = fs.readFileSync(path.join(IMG_DIR, file));
    return "data:" + (MIME[ext] || "image/webp") + ";base64," + buf.toString("base64");
  } catch (e) {
    return ""; // missing image just means no photo — the emoji still renders
  }
}

// id, name, category, price (MVR), emoji, image filename
const ITEMS = [
  ["p1", "Espresso", "Coffee", 35, "☕", "p1-espresso.webp"],
  ["p2", "Flat White", "Coffee", 45, "☕", "p2-flat-white.webp"],
  ["p3", "Iced Latte", "Coffee", 50, "🥤", "p3-iced-latte.webp"],
  ["p4", "Hot Chocolate", "Coffee", 45, "☕", "p4-hot-chocolate.webp"],
  ["p5", "Almond Croissant", "Bakery", 40, "🥐", "p5-almond-croissant.webp"],
  ["p6", "Blueberry Muffin", "Bakery", 35, "🧁", "p6-blueberry-muffin.webp"],
  ["p7", "Tuna Sandwich", "Snacks", 55, "🥪", "p7-tuna-sandwich.webp"],
  ["p8", "Chocolate Cake", "Bakery", 60, "🍰", "p8-chocolate-cake.webp"],
  ["p9", "Water 500ml", "Drinks", 15, "💧", "p9-water-500ml.webp"],
  ["p10", "Orange Juice", "Drinks", 40, "🧃", "p10-orange-juice.webp"],
  ["p11", "Kurumba", "Drinks", 30, "🥥", "p11-kurumba-coconut.webp"],
  ["p12", "Cola Can", "Drinks", 25, "🥫", "p12-cola-can.webp"],
  ["p13", "Rice 5kg", "Grocery", 120, "🍚", "p13-rice-5kg.webp"],
  ["p14", "Cooking Oil 1L", "Grocery", 85, "🛢️", "p14-cooking-oil-1l.webp"],
  ["p15", "Eggs Tray 30", "Grocery", 95, "🥚", "p15-eggs-tray-30.webp"],
  ["p16", "Rihaakuru Jar", "Grocery", 65, "🫙", "p16-rihaakuru-jar.webp"],
  ["p17", "Gulha", "Hedhikaa", 3, "🟤", "p17-gulha.webp"],
  ["p18", "Bajiyaa", "Hedhikaa", 3, "🥟", "p18-bajiyaa.webp"],
  ["p19", "Masroshi", "Hedhikaa", 5, "🫓", "p19-masroshi.webp"],
];

const DEFAULT_MENU = ITEMS.map(([id, name, cat, mvr, emoji, file]) => ({
  id,
  name,
  cat,
  emoji,
  unit: "pcs",
  price: Math.round(Number(mvr) * 100),
  cost: 0,
  taxable: true,
  img: imgDataUri(file),
}));

module.exports = { DEFAULT_MENU };
