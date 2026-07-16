"use strict";

/*
 * Canonical starter menu shared by every outlet — the production Oakwood
 * menu (69 dishes across 11 groups).
 *
 * These products are seeded as GLOBAL products (no storeId, so they are
 * shared across every store/branch in an org) into each org on registration,
 * and idempotently backfilled into existing orgs on boot (see
 * ensureDefaultMenu / the boot backfill in index.js). Because they are plain
 * `products` entities they flow through the normal sync stream onto the main
 * POS (till) tiles and the guest/user QR portals alike.
 *
 * Photos are read from scripts/oakwood-images/ (shipped in the Docker image
 * via `COPY . .`) and embedded as offline data URIs so images work offline and
 * travel with the entity. Prices are MVR in the table and stored as laari
 * (x100). Add-on prices are laari too. Items are left stock-untracked (no
 * `stock` key) so they stay sellable until an outlet opts a line into tracking.
 *
 * CAT_ORDER is the intended left-to-right / top-to-bottom group order; it is
 * seeded into settings.catOrder for outlets that have not set their own.
 */

const fs = require("fs");
const path = require("path");

const IMG_DIR = path.join(__dirname, "scripts", "oakwood-images");
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

const CAT_ORDER = ["Breakfast", "Appetizer & Soups", "All-Time Favorites", "Pasta", "Express Specials", "Pizza", "Filipino Dishes", "Kohthu Roshi", "Rice", "Noodles", "Chicken/Beef Dishes"];

// id, name, category, price (MVR), emoji, image file, allergens, add-ons, description
const ITEMS = [
  ["ow01", "Continental Breakfast", "Breakfast", 65, "🍳", "ow-continental-breakfast.webp", "Gluten, Egg", [], "Eggs, toast and breakfast sides, continental style."],
  ["ow02", "Mashuni with Roshi/Disk", "Breakfast", 60, "🥥", "ow-mashuni-roshi.webp", "Fish, Gluten", [{ name: "Roshi", price: 0 }, { name: "Disk", price: 0 }], "Maldivian tuna and coconut mashuni, served with roshi or disk."],
  ["ow03", "Kulhimas with Roshi/Disk", "Breakfast", 60, "🐟", "ow-kulhimas-roshi.webp", "Fish, Gluten", [{ name: "Roshi", price: 0 }, { name: "Disk", price: 0 }], "Spiced dark tuna kulhimas, served with roshi or disk."],
  ["ow04", "Rihaakuru with Roshi/Disk", "Breakfast", 60, "🐟", "ow-rihaakuru-roshi.webp", "Fish, Gluten", [{ name: "Roshi", price: 0 }, { name: "Disk", price: 0 }], "Rich Maldivian fish paste, served with roshi or disk."],
  ["ow05", "Mix Breakfast with Roshi/Disk", "Breakfast", 65, "🍳", "ow-mix-breakfast.webp", "Fish, Gluten, Egg", [{ name: "Roshi", price: 0 }, { name: "Disk", price: 0 }], "Mixed breakfast platter, served with roshi or disk."],
  ["ow06", "French Fries", "Appetizer & Soups", 40, "🍟", "ow-french-fries.webp", "", [], "Crisp golden fries."],
  ["ow07", "Cheesy Fries", "Appetizer & Soups", 50, "🍟", "ow-cheesy-fries.webp", "Dairy", [], "Golden fries topped with melted cheese."],
  ["ow08", "Popcorn Chicken", "Appetizer & Soups", 55, "🍗", "ow-popcorn-chicken.webp", "Gluten", [], "Bite-size crispy fried chicken."],
  ["ow09", "Tuna Noodles Soup", "Appetizer & Soups", 55, "🍜", "ow-tuna-noodles-soup.webp", "Fish, Gluten", [], "Noodle soup with tuna."],
  ["ow10", "Chicken Noodles Soup", "Appetizer & Soups", 60, "🍜", "ow-chicken-noodles-soup.webp", "Gluten", [], "Noodle soup with chicken."],
  ["ow11", "Cream of Chicken Soup", "Appetizer & Soups", 60, "🥣", "ow-cream-of-chicken-soup.webp", "Dairy", [], "Smooth creamy chicken soup."],
  ["ow12", "Tuna Sandwich", "All-Time Favorites", 50, "🥪", "ow-tuna-sandwich.webp", "Fish, Gluten", [], "Fresh tuna sandwich."],
  ["ow13", "Chicken Sandwich", "All-Time Favorites", 60, "🥪", "ow-chicken-sandwich.webp", "Gluten", [], "Fresh chicken sandwich."],
  ["ow14", "Club Sandwich", "All-Time Favorites", 80, "🥪", "ow-club-sandwich.webp", "Gluten, Egg", [], "Double-decker club sandwich."],
  ["ow15", "Chicken & Chips", "All-Time Favorites", 75, "🍗", "ow-chicken-and-chips.webp", "Gluten", [], "Fried chicken with golden fries."],
  ["ow16", "Fish & Chips", "All-Time Favorites", 75, "🐟", "ow-fish-and-chips.webp", "Fish, Gluten", [], "Battered fish with golden fries."],
  ["ow17", "Classic Chicken Burger", "All-Time Favorites", 85, "🍔", "ow-classic-chicken-burger.webp", "Gluten", [], "Classic chicken burger."],
  ["ow18", "OW Special Beef Burger", "All-Time Favorites", 100, "🍔", "ow-ow-special-beef-burger.webp", "Gluten, Dairy", [], "The house special double beef burger."],
  ["ow19", "Chicken Wrap", "All-Time Favorites", 65, "🌯", "ow-chicken-wrap.webp", "Gluten", [], "Grilled chicken wrap."],
  ["ow20", "Chicken Submarine", "All-Time Favorites", 80, "🥖", "ow-chicken-submarine.webp", "Gluten", [], "Chicken submarine sandwich."],
  ["ow21", "Beef Submarine", "All-Time Favorites", 90, "🥖", "ow-beef-submarine.webp", "Gluten", [], "Beef submarine sandwich."],
  ["ow22", "Penne/Spaghetti Bolognese", "Pasta", 85, "🍝", "ow-penne-spaghetti-bolognese.webp", "Gluten", [{ name: "Penne", price: 0 }, { name: "Spaghetti", price: 0 }], "Pasta in slow-cooked bolognese sauce."],
  ["ow23", "Penne/Spaghetti Carbonara", "Pasta", 85, "🍝", "ow-penne-spaghetti-carbonara.webp", "Gluten, Dairy, Egg", [{ name: "Penne", price: 0 }, { name: "Spaghetti", price: 0 }], "Pasta in creamy carbonara sauce."],
  ["ow24", "Oakwood Special Pasta", "Pasta", 100, "🍝", "ow-oakwood-special-pasta.webp", "Gluten", [], "The house special pasta."],
  ["ow25", "Chicken Pasta Aglio Olio", "Pasta", 85, "🍝", "ow-chicken-pasta-aglio-olio.webp", "Gluten", [], "Garlic and olive oil pasta with chicken."],
  ["ow26", "Valhomas Pasta Aglio Olio", "Pasta", 85, "🍝", "ow-valhomas-pasta-aglio-olio.webp", "Fish, Gluten", [], "Garlic and olive oil pasta with smoked Maldivian tuna."],
  ["ow27", "Garudhiya with Rice/Roshi", "Express Specials", 55, "🥣", "ow-garudhiya-rice-roshi.webp", "Fish, Gluten", [{ name: "Rice", price: 0 }, { name: "Roshi", price: 0 }], "Clear Maldivian fish broth, served with rice or roshi."],
  ["ow28", "Fish Curry with Rice/Roshi", "Express Specials", 60, "🍛", "ow-fish-curry-rice-roshi.webp", "Fish, Gluten", [{ name: "Rice", price: 0 }, { name: "Roshi", price: 0 }], "Maldivian fish curry, served with rice or roshi."],
  ["ow29", "Chicken Curry with Rice/Roshi", "Express Specials", 65, "🍛", "ow-chicken-curry-rice-roshi.webp", "Gluten", [{ name: "Rice", price: 0 }, { name: "Roshi", price: 0 }], "Chicken curry, served with rice or roshi."],
  ["ow30", "Chilli Boava with Rice/Roshi", "Express Specials", 85, "🐙", "ow-chilli-boava-rice-roshi.webp", "Shellfish (mollusc), Gluten", [{ name: "Rice", price: 0 }, { name: "Roshi", price: 0 }], "Spicy octopus chilli boava, served with rice or roshi."],
  ["ow31", "Tuna Pizza", "Pizza", 75, "🍕", "ow-tuna-pizza.webp", "Fish, Gluten, Dairy", [], "Pizza topped with tuna."],
  ["ow32", "Chicken Hawaiian Pizza", "Pizza", 80, "🍕", "ow-chicken-hawaiian-pizza.webp", "Gluten, Dairy", [], "Chicken and pineapple pizza."],
  ["ow33", "Seafood Pizza", "Pizza", 110, "🍕", "ow-seafood-pizza.webp", "Fish, Shellfish, Gluten, Dairy", [], "Mixed seafood pizza."],
  ["ow34", "Tandoori Pizza", "Pizza", 90, "🍕", "ow-tandoori-pizza.webp", "Gluten, Dairy", [], "Tandoori-spiced chicken pizza."],
  ["ow35", "Chicken Adobo", "Filipino Dishes", 65, "🍗", "ow-chicken-adobo.webp", "Soy", [], "Filipino chicken braised in soy and vinegar."],
  ["ow36", "Beef Pares", "Filipino Dishes", 65, "🍲", "ow-beef-pares.webp", "Soy", [], "Filipino braised beef stew with rice."],
  ["ow37", "Bistek Tagalog", "Filipino Dishes", 65, "🥩", "ow-bistek-tagalog.webp", "Soy", [], "Filipino beefsteak with onions in citrus-soy sauce."],
  ["ow38", "Tuna Kohthu", "Kohthu Roshi", 70, "🫓", "ow-tuna-kohthu.webp", "Fish, Gluten", [], "Chopped roshi stir-fried with tuna."],
  ["ow39", "Chicken Kohthu", "Kohthu Roshi", 75, "🫓", "ow-chicken-kohthu.webp", "Gluten", [], "Chopped roshi stir-fried with chicken."],
  ["ow40", "Beef Kohthu", "Kohthu Roshi", 75, "🫓", "ow-beef-kohthu.webp", "Gluten", [], "Chopped roshi stir-fried with beef."],
  ["ow41", "Valhomas Kohthu", "Kohthu Roshi", 70, "🫓", "ow-valhomas-kohthu.webp", "Fish, Gluten", [], "Chopped roshi stir-fried with smoked Maldivian tuna."],
  ["ow42", "Seafood Kohthu", "Kohthu Roshi", 90, "🫓", "ow-seafood-kohthu.webp", "Fish, Shellfish, Gluten", [], "Chopped roshi stir-fried with mixed seafood."],
  ["ow43", "Mixed Kohthu", "Kohthu Roshi", 85, "🫓", "ow-mixed-kohthu.webp", "Fish, Gluten", [], "Chopped roshi stir-fried with mixed proteins."],
  ["ow44", "Nasigoreng", "Rice", 80, "🍛", "ow-nasigoreng.webp", "Egg, Soy", [], "Indonesian-style fried rice topped with fried egg."],
  ["ow45", "Tuna Fried Rice", "Rice", 65, "🍚", "ow-tuna-fried-rice.webp", "Fish, Soy", [], "Fried rice with tuna."],
  ["ow46", "Chicken Fried Rice", "Rice", 70, "🍚", "ow-chicken-fried-rice.webp", "Soy", [], "Fried rice with chicken."],
  ["ow47", "Beef Fried Rice", "Rice", 70, "🍚", "ow-beef-fried-rice.webp", "Soy", [], "Fried rice with beef."],
  ["ow48", "Valhomas Fried Rice", "Rice", 70, "🍚", "ow-valhomas-fried-rice.webp", "Fish, Soy", [], "Fried rice with smoked Maldivian tuna."],
  ["ow49", "Seafood Fried Rice", "Rice", 90, "🍚", "ow-seafood-fried-rice.webp", "Fish, Shellfish, Soy", [], "Fried rice with mixed seafood."],
  ["ow50", "Mixed Fried Rice", "Rice", 80, "🍚", "ow-mixed-fried-rice.webp", "Fish, Soy", [], "Fried rice with mixed proteins."],
  ["ow51", "Chicken Biryani", "Rice", 80, "🥘", "ow-chicken-biryani.webp", "Dairy", [], "Fragrant chicken biryani."],
  ["ow52", "Beef Biryani", "Rice", 80, "🥘", "ow-beef-biryani.webp", "Dairy", [], "Fragrant beef biryani."],
  ["ow53", "Bamigoreng", "Noodles", 80, "🍜", "ow-bamigoreng.webp", "Gluten, Egg, Soy", [], "Indonesian-style fried noodles."],
  ["ow54", "Tuna Fried Noodles", "Noodles", 65, "🍜", "ow-tuna-fried-noodles.webp", "Fish, Gluten, Soy", [], "Fried noodles with tuna."],
  ["ow55", "Chicken Fried Noodles", "Noodles", 70, "🍜", "ow-chicken-fried-noodles.webp", "Gluten, Soy", [], "Fried noodles with chicken."],
  ["ow56", "Beef Fried Noodles", "Noodles", 70, "🍜", "ow-beef-fried-noodles.webp", "Gluten, Soy", [], "Fried noodles with beef."],
  ["ow57", "Valhomas Fried Noodles", "Noodles", 70, "🍜", "ow-valhomas-fried-noodles.webp", "Fish, Gluten, Soy", [], "Fried noodles with smoked Maldivian tuna."],
  ["ow58", "Seafood Fried Noodles", "Noodles", 90, "🍜", "ow-seafood-fried-noodles.webp", "Fish, Shellfish, Gluten, Soy", [], "Fried noodles with mixed seafood."],
  ["ow59", "Mixed Fried Noodles", "Noodles", 80, "🍜", "ow-mixed-fried-noodles.webp", "Fish, Gluten, Soy", [], "Fried noodles with mixed proteins."],
  ["ow60", "Grilled Chicken", "Chicken/Beef Dishes", 100, "🍗", "ow-grilled-chicken.webp", "Gluten", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Grilled chicken. Served with choice of plain/veg/garlic rice or roshi, and salad."],
  ["ow61", "Devilled Chicken", "Chicken/Beef Dishes", 70, "🍗", "ow-devilled-chicken.webp", "Gluten, Soy", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Spicy devilled chicken. Served with choice of plain/veg/garlic rice or roshi, and salad."],
  ["ow62", "Chilli Chicken", "Chicken/Beef Dishes", 70, "🌶️", "ow-chilli-chicken.webp", "Gluten, Soy", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Chilli chicken stir-fry. Served with choice of plain/veg/garlic rice or roshi, and salad."],
  ["ow63", "Chicken Stroganoff", "Chicken/Beef Dishes", 80, "🍲", "ow-chicken-stroganoff.webp", "Gluten, Dairy", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Chicken in creamy stroganoff sauce. Served with choice of plain/veg/garlic rice or roshi, and salad."],
  ["ow64", "Beef Pepper Steak", "Chicken/Beef Dishes", 80, "🥩", "ow-beef-pepper-steak.webp", "Gluten, Dairy", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Beef steak in pepper sauce. Served with choice of plain/veg/garlic rice or roshi, and salad."],
  ["ow65", "Devilled Beef", "Chicken/Beef Dishes", 70, "🥩", "ow-devilled-beef.webp", "Gluten, Soy", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Spicy devilled beef. Served with choice of plain/veg/garlic rice or roshi, and salad."],
  ["ow66", "Chilli Beef", "Chicken/Beef Dishes", 70, "🌶️", "ow-chilli-beef.webp", "Gluten, Soy", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Chilli beef stir-fry. Served with choice of plain/veg/garlic rice or roshi, and salad."],
  ["ow67", "Beef Stroganoff", "Chicken/Beef Dishes", 80, "🍲", "ow-beef-stroganoff.webp", "Gluten, Dairy", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Beef in creamy stroganoff sauce. Served with choice of plain/veg/garlic rice or roshi, and salad."],
  ["ow68", "Chicken ala Kiev", "Chicken/Beef Dishes", 85, "🍗", "ow-chicken-ala-kiev.webp", "Gluten, Dairy, Egg", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Breaded chicken filled with herb butter. Served with choice of plain/veg/garlic rice or roshi, and salad."],
  ["ow69", "Chicken Cordon Bleu", "Chicken/Beef Dishes", 85, "🍗", "ow-chicken-cordon-bleu.webp", "Gluten, Dairy, Egg", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Breaded chicken filled with ham and cheese. Served with choice of plain/veg/garlic rice or roshi, and salad."],
];

const DEFAULT_MENU = ITEMS.map(([id, name, cat, mvr, emoji, file, allergens, addons, desc]) => {
  const item = {
    id,
    name,
    cat,
    emoji,
    unit: "pcs",
    price: Math.round(Number(mvr) * 100),
    cost: 0,
    taxable: true,
    img: imgDataUri(file),
  };
  if (desc) item.desc = desc;
  if (allergens) item.allergens = allergens;
  if (addons && addons.length) item.addons = addons;
  return item;
});

module.exports = { DEFAULT_MENU, CAT_ORDER };
