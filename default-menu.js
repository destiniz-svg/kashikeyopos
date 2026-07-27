"use strict";

/*
 * Canonical starter menu shared by every outlet.
 *
 * Two levels of menu geography live here:
 *   - CAT_GROUPS is the ordered MAIN category -> sub category tree that drives
 *     the two-row menu nav on the till and the guest/user portal. Each group
 *     also carries a `color` used to tint its category chip. It is seeded into
 *     settings.catGroups and is fully editable from the back office.
 *   - Each product carries `cat` = its SUB category (leaf); its main category is
 *     derived from whichever group lists that sub. Nothing else stores the main,
 *     so re-grouping in the back office is a one-place edit.
 *
 * Products are seeded as GLOBAL products (no storeId -> shared across an org's
 * stores) on registration and idempotently backfilled on boot (ensureDefaultMenu
 * in index.js). They flow through the normal sync stream onto the main POS tiles
 * and the guest QR portals alike. Photos are either a local file under scripts/
 * (embedded as an offline data URI) or an https:// URL served straight to the
 * tile. Prices are MVR in the table, stored as laari (x100); they are sensible
 * starter placeholders each outlet edits. Items are stock-untracked (no `stock`
 * key) so they stay sellable until an outlet opts a line into tracking.
 */

const fs = require("fs");
const path = require("path");

const SCRIPTS_DIR = path.join(__dirname, "scripts");
const MIME = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

function imgSrc(ref) {
  if (!ref) return "";
  if (/^https?:\/\//i.test(ref)) return ref; // remote photo — served straight to the tile
  try {
    const ext = path.extname(ref).toLowerCase();
    const buf = fs.readFileSync(path.join(SCRIPTS_DIR, ref));
    return "data:" + (MIME[ext] || "image/webp") + ";base64," + buf.toString("base64");
  } catch (e) {
    return ""; // missing image just means no photo — the emoji still renders
  }
}

// Ordered main category -> sub categories, each with a chip colour.
const CAT_GROUPS = [
  { name: "Coffee & Tea", color: "#4A2311", subs: ["Espresso & Black", "Milk-Based (Hot)", "Iced & Cold Brew", "Blended Frappes", "Local Tea"] },
  { name: "Juices & Cold Drinks", color: "#1E8449", subs: ["Fresh Juices", "Mocktails", "Smoothies", "Soft Drinks"] },
  { name: "Breakfast", color: "#F1C40F", subs: ["Maldivian Breakfast", "Continental Breakfast"] },
  { name: "Hedhikaa & Snacks", color: "#D35400", subs: ["Fried Savory", "Baked Savory", "Sweet Treats"] },
  { name: "Asian & Local Mains", color: "#C0392B", subs: ["Rice & Noodles", "Kottu", "Curries"] },
  { name: "Western Mains", color: "#8E44AD", subs: ["Burgers & Sandwiches", "Pizza", "Pasta", "Grills"] },
];

// Flat sub-category order (derived) — kept for the older settings.catOrder readers.
const CAT_ORDER = CAT_GROUPS.reduce((a, g) => a.concat(g.subs), []);

// id, name, sub category, price (MVR, starter placeholder), emoji, image
// (https URL or file relative to scripts/).
const ITEMS = [
  // ---- Coffee & Tea ----
  ["m1", "Espresso", "Espresso & Black", 30, "☕", "https://images.unsplash.com/photo-1510591509098-f4fdc6d0ff04?w=150&h=150&fit=crop"],
  ["m2", "Americano", "Espresso & Black", 35, "☕", "https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?w=150&h=150&fit=crop"],
  ["m3", "Cappuccino", "Milk-Based (Hot)", 45, "☕", "https://images.unsplash.com/photo-1534778101976-62847782c213?w=150&h=150&fit=crop"],
  ["m4", "Cafe Latte", "Milk-Based (Hot)", 50, "☕", "https://images.unsplash.com/photo-1561882468-9110e53a3b78?w=150&h=150&fit=crop"],
  ["m5", "Iced Latte", "Iced & Cold Brew", 55, "🥤", "https://images.unsplash.com/photo-1517701604599-bb29b565090c?w=150&h=150&fit=crop"],
  ["m6", "Caramel Frappe", "Blended Frappes", 65, "🥤", "https://images.unsplash.com/photo-1572490122747-3968b75cc699?w=150&h=150&fit=crop"],
  ["m7", "Kalhu Sai", "Local Tea", 15, "🍵", "https://images.unsplash.com/photo-1576092768241-dec231879fc3?w=150&h=150&fit=crop"],
  ["m8", "Kiru Sai", "Local Tea", 20, "🍵", "https://images.unsplash.com/photo-1544787219-7f47ccb76574?w=150&h=150&fit=crop"],
  // ---- Juices & Cold Drinks ----
  ["m9", "Watermelon Juice", "Fresh Juices", 55, "🥤", "https://images.unsplash.com/photo-1589734346109-278f7739501d?w=150&h=150&fit=crop"],
  ["m10", "Orange Juice", "Fresh Juices", 55, "🧃", "https://images.unsplash.com/photo-1613478223719-2ab802602423?w=150&h=150&fit=crop"],
  ["m11", "Papaya Juice", "Fresh Juices", 55, "🥤", "https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=150&h=150&fit=crop"],
  ["m12", "Virgin Mojito", "Mocktails", 65, "🍹", "https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?w=150&h=150&fit=crop"],
  ["m13", "Blue Lagoon", "Mocktails", 65, "🍹", "https://images.unsplash.com/photo-1551024709-8f23befc6f87?w=150&h=150&fit=crop"],
  ["m14", "Mango Smoothie", "Smoothies", 70, "🥤", "https://images.unsplash.com/photo-1553530666-ba11a7da3888?w=150&h=150&fit=crop"],
  ["m15", "Coca Cola", "Soft Drinks", 25, "🥤", "https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=150&h=150&fit=crop"],
  // ---- Breakfast ----
  ["m16", "Mas Huni", "Maldivian Breakfast", 45, "🥥", "https://images.unsplash.com/photo-1540420773420-3366772f4999?w=150&h=150&fit=crop"],
  ["m17", "Kulhimas", "Maldivian Breakfast", 65, "🐟", "https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=150&h=150&fit=crop"],
  ["m18", "Roshi (2 pcs)", "Maldivian Breakfast", 20, "🫓", "https://images.unsplash.com/photo-1565299585323-38d6b0865b47?w=150&h=150&fit=crop"],
  ["m19", "English Breakfast", "Continental Breakfast", 120, "🍳", "https://images.unsplash.com/photo-1533089860892-a7c6f0a88666?w=150&h=150&fit=crop"],
  ["m20", "Pancakes", "Continental Breakfast", 75, "🥞", "https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=150&h=150&fit=crop"],
  // ---- Hedhikaa & Snacks ----
  ["m21", "Bajiya", "Fried Savory", 8, "🥟", "https://images.unsplash.com/photo-1601050690597-df0568f70950?w=150&h=150&fit=crop"],
  ["m22", "Gulha", "Fried Savory", 8, "🥟", "https://images.unsplash.com/photo-1541529086526-db283c563270?w=150&h=150&fit=crop"],
  ["m23", "Keemia", "Fried Savory", 10, "🥟", "https://images.unsplash.com/photo-1599487484182-d58b0bac34bb?w=150&h=150&fit=crop"],
  ["m24", "Kulhi Boakibaa", "Baked Savory", 15, "🍰", "https://images.unsplash.com/photo-1509440159596-0249088772ff?w=150&h=150&fit=crop"],
  ["m25", "Masroshi", "Baked Savory", 12, "🫓", "https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=150&h=150&fit=crop"],
  ["m26", "Foni Boakibaa", "Sweet Treats", 15, "🍰", "https://images.unsplash.com/photo-1587314168485-3236d6710814?w=150&h=150&fit=crop"],
  // ---- Asian & Local Mains ----
  ["m27", "Valhomas Rice", "Rice & Noodles", 95, "🍚", "https://images.unsplash.com/photo-1512058564366-18510be2db19?w=150&h=150&fit=crop"],
  ["m28", "Nasi Goreng", "Rice & Noodles", 110, "🍚", "https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=150&h=150&fit=crop"],
  ["m29", "Mee Goreng", "Rice & Noodles", 105, "🍜", "https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=150&h=150&fit=crop"],
  ["m30", "Chicken Kottu", "Kottu", 120, "🍛", "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=150&h=150&fit=crop"],
  ["m31", "Beef Kottu", "Kottu", 140, "🍛", "https://images.unsplash.com/photo-1544025162-d76694265947?w=150&h=150&fit=crop"],
  ["m32", "Mas Riha", "Curries", 90, "🍲", "https://images.unsplash.com/photo-1589302168068-964664d93dc0?w=150&h=150&fit=crop"],
  ["m33", "Kukulhu Riha", "Curries", 95, "🍲", "https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?w=150&h=150&fit=crop"],
  // ---- Western Mains ----
  ["m34", "Club Sandwich", "Burgers & Sandwiches", 110, "🥪", "https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=150&h=150&fit=crop"],
  ["m35", "Beef Burger", "Burgers & Sandwiches", 130, "🍔", "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=150&h=150&fit=crop"],
  ["m36", "Margherita", "Pizza", 140, "🍕", "https://images.unsplash.com/photo-1604382355076-af4b0eb60143?w=150&h=150&fit=crop"],
  ["m37", "Seafood Pizza", "Pizza", 180, "🍕", "https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=150&h=150&fit=crop"],
  ["m38", "Chicken Alfredo", "Pasta", 150, "🍝", "https://images.unsplash.com/photo-1645112411341-6c4fd0237146?w=150&h=150&fit=crop"],
  ["m39", "Spaghetti Bolognese", "Pasta", 145, "🍝", "https://images.unsplash.com/photo-1621996346565-e3d5d6281297?w=150&h=150&fit=crop"],
  ["m40", "Grilled Reef Fish", "Grills", 190, "🐟", "https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=150&h=150&fit=crop"],
];

const DEFAULT_MENU = ITEMS.map(([id, name, cat, mvr, emoji, file]) => ({
  id, name, cat, emoji,
  unit: "pcs",
  price: Math.round(Number(mvr) * 100),
  cost: 0,
  taxable: true,
  img: imgSrc(file),
}));

module.exports = { DEFAULT_MENU, CAT_GROUPS, CAT_ORDER };
