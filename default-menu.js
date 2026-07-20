"use strict";

/*
 * Canonical starter menu shared by every outlet — the Kashikeyo demo menu from
 * the register prototype (18 Maldivian items across four categories).
 *
 * Two levels of menu geography live here:
 *   - CAT_GROUPS is the ordered MAIN category -> sub category tree that drives
 *     the till's category chips (All / Hedhikaa / Mains / Drinks / Sweets) and
 *     the guest/user portal. Seeded into settings.catGroups, editable in /back.
 *   - Each product carries `cat` = its category (a leaf that is also its group's
 *     only sub), so re-grouping in the back office stays a one-place edit.
 *
 * Products are seeded as GLOBAL products (no storeId -> shared across an org's
 * stores) on registration and idempotently backfilled on boot (ensureDefaultMenu
 * in index.js). Photos are read from scripts/kashikeyo-menu/ (shipped in the
 * Docker image) and embedded as offline data URIs. Prices/add-on prices are MVR
 * in the table, stored as laari (x100). Items are stock-untracked (no `stock`
 * key) so they stay sellable until an outlet opts a line into tracking.
 */

const fs = require("fs");
const path = require("path");

const SCRIPTS_DIR = path.join(__dirname, "scripts");
const MIME = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

function imgDataUri(rel) {
  try {
    const ext = path.extname(rel).toLowerCase();
    const buf = fs.readFileSync(path.join(SCRIPTS_DIR, rel));
    return "data:" + (MIME[ext] || "image/webp") + ";base64," + buf.toString("base64");
  } catch (e) {
    return ""; // missing image just means no photo — the emoji still renders
  }
}

// Ordered main category -> sub categories. Seeded into settings.catGroups. Each
// category is its own single leaf so the till chips read one label per group.
const CAT_GROUPS = [
  { name: "Hedhikaa", subs: ["hedhikaa"] },
  { name: "Mains", subs: ["mains"] },
  { name: "Drinks", subs: ["drinks"] },
  { name: "Sweets", subs: ["sweets"] },
];

// Flat sub-category order (derived) — kept for the older settings.catOrder readers.
const CAT_ORDER = CAT_GROUPS.reduce((a, g) => a.concat(g.subs), []);

// id, English name, Dhivehi name, category, price (MVR), emoji,
// image (relative to scripts/), add-ons [{name, price MVR}], description.
const ITEMS = [
  ["gulha", "Gulha", "ގުޅަ", "hedhikaa", 5, "🟤", "kashikeyo-menu/gulha.webp", [], "Deep-fried dough balls stuffed with spiced smoked tuna & coconut."],
  ["bajiya", "Bajiya", "ބަޖިޔާ", "hedhikaa", 5, "🥟", "kashikeyo-menu/bajiya.webp", [], "Golden pastry parcels filled with tuna, onion & coconut."],
  ["kavaabu", "Kavaabu", "ކަވާބު", "hedhikaa", 7, "🧆", "kashikeyo-menu/kavaabu.webp", [], "Spiced tuna & lentil fritters, fried golden."],
  ["kboakibaa", "Kulhi Boakibaa", "ކުޅިބޯކިބާ", "hedhikaa", 10, "🍥", "kashikeyo-menu/kboakibaa.webp", [], "Baked spicy tuna & rice cake."],
  ["masroshi", "Masroshi", "މަސްރޮށި", "hedhikaa", 8, "🌯", "kashikeyo-menu/masroshi.webp", [], "Flatbread filled with spiced smoked tuna."],
  ["cutlets", "Cutlets", "ކަޓްލަސް", "hedhikaa", 6, "🥔", "kashikeyo-menu/cutlets.webp", [], "Breaded tuna & potato cutlets."],
  ["mashuni", "Mas Huni & Roshi", "މަސްހުނި ރޮށި", "mains", 30, "🥗", "kashikeyo-menu/mashuni.webp", [{ name: "Extra roshi", price: 5 }, { name: "Githeyo mirus", price: 2 }], "Smoked tuna shredded with grated coconut, chili, onion & lime, served with warm roshi."],
  ["garudhiya", "Garudhiya Set", "ގަރުދިޔަ", "mains", 45, "🍲", "kashikeyo-menu/garudhiya.webp", [{ name: "Extra rice", price: 5 }, { name: "Lime & mirus", price: 0 }], "Clear Maldivian tuna broth with steamed rice, lime, chili & onion on the side."],
  ["riha", "Kukulhu Riha", "ކުކުޅު ރިހަ", "mains", 55, "🍛", "kashikeyo-menu/riha.webp", [], "Tender Maldivian chicken curry simmered in island spices & coconut milk."],
  ["friedrice", "Fried Rice", "ފްރައިޑް ރައިސް", "mains", 50, "🍚", "kashikeyo-menu/friedrice.webp", [], "Fragrant fried rice with egg, vegetables and a hit of island spice."],
  ["kalhusai", "Kalhu Sai", "ކަޅުސައި", "drinks", 8, "🍵", "kashikeyo-menu/kalhusai.webp", [{ name: "Less sugar", price: 0 }, { name: "Extra strong", price: 0 }], "Traditional Maldivian black tea."],
  ["kirusai", "Kiru Sai", "ކިރުސައި", "drinks", 12, "🥛", "kashikeyo-menu/kirusai.webp", [], "Classic milk tea, island style."],
  ["coffee", "Coffee", "ކޮފީ", "drinks", 30, "☕", "kashikeyo-menu/coffee.webp", [{ name: "Iced", price: 5 }, { name: "Extra shot", price: 8 }], "Locally roasted coffee, served hot or over ice."],
  ["passion", "Passion Juice", "ޕެޝަން ޖޫސް", "drinks", 35, "🧃", "kashikeyo-menu/passion.webp", [], "Chilled fresh passionfruit juice, lightly sweetened."],
  ["kurumba", "Kurumba", "ކުރުނބާ", "drinks", 40, "🥥", "kashikeyo-menu/kurumba.webp", [], "Fresh young coconut water, served chilled."],
  ["bondibai", "Bondibai", "ބޮނޑިބައި", "sweets", 20, "🍮", "kashikeyo-menu/bondibai.webp", [], "Creamy coconut rice pudding — a Maldivian classic."],
  ["fonibkb", "Foni Boakibaa", "ފޮނިބޯކިބާ", "sweets", 15, "🍰", "kashikeyo-menu/fonibkb.webp", [], "Sweet baked coconut cake."],
  ["saagu", "Saagu Bondibai", "ސާގު ބޮނޑިބައި", "sweets", 22, "🍧", "kashikeyo-menu/saagu.webp", [], "Sago pearls in sweet coconut milk."],
];

const DEFAULT_MENU = ITEMS.map(([id, name, dv, cat, mvr, emoji, file, addons, desc]) => {
  const item = {
    id, name, dv, cat, emoji,
    unit: "pcs",
    price: Math.round(Number(mvr) * 100),
    cost: 0,
    taxable: true,
    img: imgDataUri(file),
  };
  if (desc) item.desc = desc;
  if (addons && addons.length) item.addons = addons.map((a) => ({ name: a.name, price: Math.round(Number(a.price || 0) * 100) }));
  return item;
});

// Every current default product id — used by the one-time menu reset in
// index.js to retire any previously-seeded starter items on existing orgs.
const DEFAULT_MENU_IDS = ITEMS.map((i) => i[0]);

module.exports = { DEFAULT_MENU, DEFAULT_MENU_IDS, CAT_GROUPS, CAT_ORDER };
