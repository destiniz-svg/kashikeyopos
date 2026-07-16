"use strict";

/*
 * Canonical starter menu shared by every outlet.
 *
 * Two levels of menu geography live here:
 *   - CAT_GROUPS is the ordered MAIN category -> sub category tree that drives
 *     the two-row menu nav on the till and the guest/user portal. It is seeded
 *     into settings.catGroups and is fully editable from the back office.
 *   - Each product carries `cat` = its SUB category (leaf); its main category is
 *     derived from whichever group lists that sub. Nothing else stores the main,
 *     so re-grouping in the back office is a one-place edit.
 *
 * Products are seeded as GLOBAL products (no storeId -> shared across an org's
 * stores) on registration and idempotently backfilled on boot (ensureDefaultMenu
 * in index.js). They flow through the normal sync stream onto the main POS tiles
 * and the guest QR portals alike. Photos are read from scripts/<dir>/ (shipped in
 * the Docker image) and embedded as offline data URIs. Prices/add-on prices are
 * MVR in the table, stored as laari (x100). Items are stock-untracked (no `stock`
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

// Ordered main category -> sub categories. Seeded into settings.catGroups.
const CAT_GROUPS = [
  { name: "Main Dishes", subs: ["Breakfast", "Appetizer & Soups", "All-Time Favorites", "Pasta", "Express Specials", "Pizza", "Filipino Dishes", "Kohthu Roshi", "Rice", "Noodles", "Chicken/Beef Dishes"] },
  { name: "Coffee", subs: ["Nescafe", "Lavazza", "Illy"] },
  { name: "Drinks", subs: ["Fresh Drinks", "Milk Shake", "Mojito"] },
  { name: "Bakery", subs: ["Pastries", "Cakes"] },
  { name: "Grocery", subs: ["Essentials"] },
  { name: "Hedhikaa", subs: ["Savoury Bites"] },
];

// Flat sub-category order (derived) — kept for the older settings.catOrder readers.
const CAT_ORDER = CAT_GROUPS.reduce((a, g) => a.concat(g.subs), []);

// id, name, sub category, price (MVR), emoji, image (relative to scripts/),
// allergens, add-ons, description, noKitchen
const ITEMS = [
  ["p1", "Espresso", "Nescafe", 35, "☕", "product-images/p1-espresso.webp", "", [], "Rich single-shot espresso.", false],
  ["p2", "Flat White", "Lavazza", 45, "☕", "product-images/p2-flat-white.webp", "Dairy", [], "Double ristretto with steamed milk.", false],
  ["p3", "Iced Latte", "Illy", 50, "🥤", "product-images/p3-iced-latte.webp", "Dairy", [], "Chilled espresso with milk over ice.", false],
  ["p4", "Hot Chocolate", "Nescafe", 45, "☕", "product-images/p4-hot-chocolate.webp", "Dairy", [], "Steamed milk with rich cocoa.", false],
  ["p5", "Almond Croissant", "Pastries", 40, "🥐", "product-images/p5-almond-croissant.webp", "Gluten, Nuts, Dairy", [], "Buttery croissant with almond filling.", true],
  ["p6", "Blueberry Muffin", "Pastries", 35, "🧁", "product-images/p6-blueberry-muffin.webp", "Gluten, Egg, Dairy", [], "Soft muffin loaded with blueberries.", true],
  ["p8", "Chocolate Cake", "Cakes", 60, "🍰", "product-images/p8-chocolate-cake.webp", "Gluten, Egg, Dairy", [], "Moist chocolate layer cake.", true],
  ["p9", "Water 500ml", "Fresh Drinks", 15, "💧", "product-images/p9-water-500ml.webp", "", [], "Chilled bottled water.", true],
  ["p10", "Orange Juice", "Fresh Drinks", 40, "🧃", "product-images/p10-orange-juice.webp", "", [], "Freshly squeezed orange juice.", false],
  ["p11", "Kurumba", "Fresh Drinks", 30, "🥥", "product-images/p11-kurumba-coconut.webp", "", [], "Young coconut, served fresh.", false],
  ["p12", "Cola Can", "Fresh Drinks", 25, "🥫", "product-images/p12-cola-can.webp", "", [], "Chilled canned cola.", true],
  ["p13", "Rice 5kg", "Essentials", 120, "🍚", "product-images/p13-rice-5kg.webp", "", [], "5kg bag of rice.", true],
  ["p14", "Cooking Oil 1L", "Essentials", 85, "🛢️", "product-images/p14-cooking-oil-1l.webp", "", [], "1 litre cooking oil.", true],
  ["p15", "Eggs Tray 30", "Essentials", 95, "🥚", "product-images/p15-eggs-tray-30.webp", "Egg", [], "Tray of 30 eggs.", true],
  ["p16", "Rihaakuru Jar", "Essentials", 65, "🫙", "product-images/p16-rihaakuru-jar.webp", "Fish", [], "Jar of Maldivian fish paste.", true],
  ["p17", "Gulha", "Savoury Bites", 3, "🟤", "product-images/p17-gulha.webp", "Fish, Gluten", [], "Bite-size tuna dumplings.", true],
  ["p18", "Bajiyaa", "Savoury Bites", 3, "🥟", "product-images/p18-bajiyaa.webp", "Fish, Gluten", [], "Savoury tuna pastry.", true],
  ["p19", "Masroshi", "Savoury Bites", 5, "🫓", "product-images/p19-masroshi.webp", "Fish, Gluten", [], "Flatbread stuffed with spiced tuna.", true],
  ["ow01", "Continental Breakfast", "Breakfast", 65, "🍳", "oakwood-images/ow-continental-breakfast.webp", "Gluten, Egg", [], "Eggs, toast and breakfast sides, continental style.", false],
  ["ow02", "Mashuni with Roshi/Disk", "Breakfast", 60, "🥥", "oakwood-images/ow-mashuni-roshi.webp", "Fish, Gluten", [{ name: "Roshi", price: 0 }, { name: "Disk", price: 0 }], "Maldivian tuna and coconut mashuni, served with roshi or disk.", false],
  ["ow03", "Kulhimas with Roshi/Disk", "Breakfast", 60, "🐟", "oakwood-images/ow-kulhimas-roshi.webp", "Fish, Gluten", [{ name: "Roshi", price: 0 }, { name: "Disk", price: 0 }], "Spiced dark tuna kulhimas, served with roshi or disk.", false],
  ["ow04", "Rihaakuru with Roshi/Disk", "Breakfast", 60, "🐟", "oakwood-images/ow-rihaakuru-roshi.webp", "Fish, Gluten", [{ name: "Roshi", price: 0 }, { name: "Disk", price: 0 }], "Rich Maldivian fish paste, served with roshi or disk.", false],
  ["ow05", "Mix Breakfast with Roshi/Disk", "Breakfast", 65, "🍳", "oakwood-images/ow-mix-breakfast.webp", "Fish, Gluten, Egg", [{ name: "Roshi", price: 0 }, { name: "Disk", price: 0 }], "Mixed breakfast platter, served with roshi or disk.", false],
  ["ow06", "French Fries", "Appetizer & Soups", 40, "🍟", "oakwood-images/ow-french-fries.webp", "", [], "Crisp golden fries.", false],
  ["ow07", "Cheesy Fries", "Appetizer & Soups", 50, "🍟", "oakwood-images/ow-cheesy-fries.webp", "Dairy", [], "Golden fries topped with melted cheese.", false],
  ["ow08", "Popcorn Chicken", "Appetizer & Soups", 55, "🍗", "oakwood-images/ow-popcorn-chicken.webp", "Gluten", [], "Bite-size crispy fried chicken.", false],
  ["ow09", "Tuna Noodles Soup", "Appetizer & Soups", 55, "🍜", "oakwood-images/ow-tuna-noodles-soup.webp", "Fish, Gluten", [], "Noodle soup with tuna.", false],
  ["ow10", "Chicken Noodles Soup", "Appetizer & Soups", 60, "🍜", "oakwood-images/ow-chicken-noodles-soup.webp", "Gluten", [], "Noodle soup with chicken.", false],
  ["ow11", "Cream of Chicken Soup", "Appetizer & Soups", 60, "🥣", "oakwood-images/ow-cream-of-chicken-soup.webp", "Dairy", [], "Smooth creamy chicken soup.", false],
  ["ow12", "Tuna Sandwich", "All-Time Favorites", 50, "🥪", "oakwood-images/ow-tuna-sandwich.webp", "Fish, Gluten", [], "Fresh tuna sandwich.", false],
  ["ow13", "Chicken Sandwich", "All-Time Favorites", 60, "🥪", "oakwood-images/ow-chicken-sandwich.webp", "Gluten", [], "Fresh chicken sandwich.", false],
  ["ow14", "Club Sandwich", "All-Time Favorites", 80, "🥪", "oakwood-images/ow-club-sandwich.webp", "Gluten, Egg", [], "Double-decker club sandwich.", false],
  ["ow15", "Chicken & Chips", "All-Time Favorites", 75, "🍗", "oakwood-images/ow-chicken-and-chips.webp", "Gluten", [], "Fried chicken with golden fries.", false],
  ["ow16", "Fish & Chips", "All-Time Favorites", 75, "🐟", "oakwood-images/ow-fish-and-chips.webp", "Fish, Gluten", [], "Battered fish with golden fries.", false],
  ["ow17", "Classic Chicken Burger", "All-Time Favorites", 85, "🍔", "oakwood-images/ow-classic-chicken-burger.webp", "Gluten", [], "Classic chicken burger.", false],
  ["ow18", "OW Special Beef Burger", "All-Time Favorites", 100, "🍔", "oakwood-images/ow-ow-special-beef-burger.webp", "Gluten, Dairy", [], "The house special double beef burger.", false],
  ["ow19", "Chicken Wrap", "All-Time Favorites", 65, "🌯", "oakwood-images/ow-chicken-wrap.webp", "Gluten", [], "Grilled chicken wrap.", false],
  ["ow20", "Chicken Submarine", "All-Time Favorites", 80, "🥖", "oakwood-images/ow-chicken-submarine.webp", "Gluten", [], "Chicken submarine sandwich.", false],
  ["ow21", "Beef Submarine", "All-Time Favorites", 90, "🥖", "oakwood-images/ow-beef-submarine.webp", "Gluten", [], "Beef submarine sandwich.", false],
  ["ow22", "Penne/Spaghetti Bolognese", "Pasta", 85, "🍝", "oakwood-images/ow-penne-spaghetti-bolognese.webp", "Gluten", [{ name: "Penne", price: 0 }, { name: "Spaghetti", price: 0 }], "Pasta in slow-cooked bolognese sauce.", false],
  ["ow23", "Penne/Spaghetti Carbonara", "Pasta", 85, "🍝", "oakwood-images/ow-penne-spaghetti-carbonara.webp", "Gluten, Dairy, Egg", [{ name: "Penne", price: 0 }, { name: "Spaghetti", price: 0 }], "Pasta in creamy carbonara sauce.", false],
  ["ow24", "Oakwood Special Pasta", "Pasta", 100, "🍝", "oakwood-images/ow-oakwood-special-pasta.webp", "Gluten", [], "The house special pasta.", false],
  ["ow25", "Chicken Pasta Aglio Olio", "Pasta", 85, "🍝", "oakwood-images/ow-chicken-pasta-aglio-olio.webp", "Gluten", [], "Garlic and olive oil pasta with chicken.", false],
  ["ow26", "Valhomas Pasta Aglio Olio", "Pasta", 85, "🍝", "oakwood-images/ow-valhomas-pasta-aglio-olio.webp", "Fish, Gluten", [], "Garlic and olive oil pasta with smoked Maldivian tuna.", false],
  ["ow27", "Garudhiya with Rice/Roshi", "Express Specials", 55, "🥣", "oakwood-images/ow-garudhiya-rice-roshi.webp", "Fish, Gluten", [{ name: "Rice", price: 0 }, { name: "Roshi", price: 0 }], "Clear Maldivian fish broth, served with rice or roshi.", false],
  ["ow28", "Fish Curry with Rice/Roshi", "Express Specials", 60, "🍛", "oakwood-images/ow-fish-curry-rice-roshi.webp", "Fish, Gluten", [{ name: "Rice", price: 0 }, { name: "Roshi", price: 0 }], "Maldivian fish curry, served with rice or roshi.", false],
  ["ow29", "Chicken Curry with Rice/Roshi", "Express Specials", 65, "🍛", "oakwood-images/ow-chicken-curry-rice-roshi.webp", "Gluten", [{ name: "Rice", price: 0 }, { name: "Roshi", price: 0 }], "Chicken curry, served with rice or roshi.", false],
  ["ow30", "Chilli Boava with Rice/Roshi", "Express Specials", 85, "🐙", "oakwood-images/ow-chilli-boava-rice-roshi.webp", "Shellfish (mollusc), Gluten", [{ name: "Rice", price: 0 }, { name: "Roshi", price: 0 }], "Spicy octopus chilli boava, served with rice or roshi.", false],
  ["ow31", "Tuna Pizza", "Pizza", 75, "🍕", "oakwood-images/ow-tuna-pizza.webp", "Fish, Gluten, Dairy", [], "Pizza topped with tuna.", false],
  ["ow32", "Chicken Hawaiian Pizza", "Pizza", 80, "🍕", "oakwood-images/ow-chicken-hawaiian-pizza.webp", "Gluten, Dairy", [], "Chicken and pineapple pizza.", false],
  ["ow33", "Seafood Pizza", "Pizza", 110, "🍕", "oakwood-images/ow-seafood-pizza.webp", "Fish, Shellfish, Gluten, Dairy", [], "Mixed seafood pizza.", false],
  ["ow34", "Tandoori Pizza", "Pizza", 90, "🍕", "oakwood-images/ow-tandoori-pizza.webp", "Gluten, Dairy", [], "Tandoori-spiced chicken pizza.", false],
  ["ow35", "Chicken Adobo", "Filipino Dishes", 65, "🍗", "oakwood-images/ow-chicken-adobo.webp", "Soy", [], "Filipino chicken braised in soy and vinegar.", false],
  ["ow36", "Beef Pares", "Filipino Dishes", 65, "🍲", "oakwood-images/ow-beef-pares.webp", "Soy", [], "Filipino braised beef stew with rice.", false],
  ["ow37", "Bistek Tagalog", "Filipino Dishes", 65, "🥩", "oakwood-images/ow-bistek-tagalog.webp", "Soy", [], "Filipino beefsteak with onions in citrus-soy sauce.", false],
  ["ow38", "Tuna Kohthu", "Kohthu Roshi", 70, "🫓", "oakwood-images/ow-tuna-kohthu.webp", "Fish, Gluten", [], "Chopped roshi stir-fried with tuna.", false],
  ["ow39", "Chicken Kohthu", "Kohthu Roshi", 75, "🫓", "oakwood-images/ow-chicken-kohthu.webp", "Gluten", [], "Chopped roshi stir-fried with chicken.", false],
  ["ow40", "Beef Kohthu", "Kohthu Roshi", 75, "🫓", "oakwood-images/ow-beef-kohthu.webp", "Gluten", [], "Chopped roshi stir-fried with beef.", false],
  ["ow41", "Valhomas Kohthu", "Kohthu Roshi", 70, "🫓", "oakwood-images/ow-valhomas-kohthu.webp", "Fish, Gluten", [], "Chopped roshi stir-fried with smoked Maldivian tuna.", false],
  ["ow42", "Seafood Kohthu", "Kohthu Roshi", 90, "🫓", "oakwood-images/ow-seafood-kohthu.webp", "Fish, Shellfish, Gluten", [], "Chopped roshi stir-fried with mixed seafood.", false],
  ["ow43", "Mixed Kohthu", "Kohthu Roshi", 85, "🫓", "oakwood-images/ow-mixed-kohthu.webp", "Fish, Gluten", [], "Chopped roshi stir-fried with mixed proteins.", false],
  ["ow44", "Nasigoreng", "Rice", 80, "🍛", "oakwood-images/ow-nasigoreng.webp", "Egg, Soy", [], "Indonesian-style fried rice topped with fried egg.", false],
  ["ow45", "Tuna Fried Rice", "Rice", 65, "🍚", "oakwood-images/ow-tuna-fried-rice.webp", "Fish, Soy", [], "Fried rice with tuna.", false],
  ["ow46", "Chicken Fried Rice", "Rice", 70, "🍚", "oakwood-images/ow-chicken-fried-rice.webp", "Soy", [], "Fried rice with chicken.", false],
  ["ow47", "Beef Fried Rice", "Rice", 70, "🍚", "oakwood-images/ow-beef-fried-rice.webp", "Soy", [], "Fried rice with beef.", false],
  ["ow48", "Valhomas Fried Rice", "Rice", 70, "🍚", "oakwood-images/ow-valhomas-fried-rice.webp", "Fish, Soy", [], "Fried rice with smoked Maldivian tuna.", false],
  ["ow49", "Seafood Fried Rice", "Rice", 90, "🍚", "oakwood-images/ow-seafood-fried-rice.webp", "Fish, Shellfish, Soy", [], "Fried rice with mixed seafood.", false],
  ["ow50", "Mixed Fried Rice", "Rice", 80, "🍚", "oakwood-images/ow-mixed-fried-rice.webp", "Fish, Soy", [], "Fried rice with mixed proteins.", false],
  ["ow51", "Chicken Biryani", "Rice", 80, "🥘", "oakwood-images/ow-chicken-biryani.webp", "Dairy", [], "Fragrant chicken biryani.", false],
  ["ow52", "Beef Biryani", "Rice", 80, "🥘", "oakwood-images/ow-beef-biryani.webp", "Dairy", [], "Fragrant beef biryani.", false],
  ["ow53", "Bamigoreng", "Noodles", 80, "🍜", "oakwood-images/ow-bamigoreng.webp", "Gluten, Egg, Soy", [], "Indonesian-style fried noodles.", false],
  ["ow54", "Tuna Fried Noodles", "Noodles", 65, "🍜", "oakwood-images/ow-tuna-fried-noodles.webp", "Fish, Gluten, Soy", [], "Fried noodles with tuna.", false],
  ["ow55", "Chicken Fried Noodles", "Noodles", 70, "🍜", "oakwood-images/ow-chicken-fried-noodles.webp", "Gluten, Soy", [], "Fried noodles with chicken.", false],
  ["ow56", "Beef Fried Noodles", "Noodles", 70, "🍜", "oakwood-images/ow-beef-fried-noodles.webp", "Gluten, Soy", [], "Fried noodles with beef.", false],
  ["ow57", "Valhomas Fried Noodles", "Noodles", 70, "🍜", "oakwood-images/ow-valhomas-fried-noodles.webp", "Fish, Gluten, Soy", [], "Fried noodles with smoked Maldivian tuna.", false],
  ["ow58", "Seafood Fried Noodles", "Noodles", 90, "🍜", "oakwood-images/ow-seafood-fried-noodles.webp", "Fish, Shellfish, Gluten, Soy", [], "Fried noodles with mixed seafood.", false],
  ["ow59", "Mixed Fried Noodles", "Noodles", 80, "🍜", "oakwood-images/ow-mixed-fried-noodles.webp", "Fish, Gluten, Soy", [], "Fried noodles with mixed proteins.", false],
  ["ow60", "Grilled Chicken", "Chicken/Beef Dishes", 100, "🍗", "oakwood-images/ow-grilled-chicken.webp", "Gluten", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Grilled chicken. Served with choice of plain/veg/garlic rice or roshi, and salad.", false],
  ["ow61", "Devilled Chicken", "Chicken/Beef Dishes", 70, "🍗", "oakwood-images/ow-devilled-chicken.webp", "Gluten, Soy", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Spicy devilled chicken. Served with choice of plain/veg/garlic rice or roshi, and salad.", false],
  ["ow62", "Chilli Chicken", "Chicken/Beef Dishes", 70, "🌶️", "oakwood-images/ow-chilli-chicken.webp", "Gluten, Soy", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Chilli chicken stir-fry. Served with choice of plain/veg/garlic rice or roshi, and salad.", false],
  ["ow63", "Chicken Stroganoff", "Chicken/Beef Dishes", 80, "🍲", "oakwood-images/ow-chicken-stroganoff.webp", "Gluten, Dairy", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Chicken in creamy stroganoff sauce. Served with choice of plain/veg/garlic rice or roshi, and salad.", false],
  ["ow64", "Beef Pepper Steak", "Chicken/Beef Dishes", 80, "🥩", "oakwood-images/ow-beef-pepper-steak.webp", "Gluten, Dairy", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Beef steak in pepper sauce. Served with choice of plain/veg/garlic rice or roshi, and salad.", false],
  ["ow65", "Devilled Beef", "Chicken/Beef Dishes", 70, "🥩", "oakwood-images/ow-devilled-beef.webp", "Gluten, Soy", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Spicy devilled beef. Served with choice of plain/veg/garlic rice or roshi, and salad.", false],
  ["ow66", "Chilli Beef", "Chicken/Beef Dishes", 70, "🌶️", "oakwood-images/ow-chilli-beef.webp", "Gluten, Soy", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Chilli beef stir-fry. Served with choice of plain/veg/garlic rice or roshi, and salad.", false],
  ["ow67", "Beef Stroganoff", "Chicken/Beef Dishes", 80, "🍲", "oakwood-images/ow-beef-stroganoff.webp", "Gluten, Dairy", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Beef in creamy stroganoff sauce. Served with choice of plain/veg/garlic rice or roshi, and salad.", false],
  ["ow68", "Chicken ala Kiev", "Chicken/Beef Dishes", 85, "🍗", "oakwood-images/ow-chicken-ala-kiev.webp", "Gluten, Dairy, Egg", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Breaded chicken filled with herb butter. Served with choice of plain/veg/garlic rice or roshi, and salad.", false],
  ["ow69", "Chicken Cordon Bleu", "Chicken/Beef Dishes", 85, "🍗", "oakwood-images/ow-chicken-cordon-bleu.webp", "Gluten, Dairy, Egg", [{ name: "Plain Rice", price: 0 }, { name: "Veg Rice", price: 0 }, { name: "Garlic Rice", price: 0 }, { name: "Roshi", price: 0 }], "Breaded chicken filled with ham and cheese. Served with choice of plain/veg/garlic rice or roshi, and salad.", false],
];

const DEFAULT_MENU = ITEMS.map(([id, name, cat, mvr, emoji, file, allergens, addons, desc, noKitchen]) => {
  const item = {
    id, name, cat, emoji,
    unit: "pcs",
    price: Math.round(Number(mvr) * 100),
    cost: 0,
    taxable: true,
    img: imgDataUri(file),
  };
  if (desc) item.desc = desc;
  if (allergens) item.allergens = allergens;
  if (addons && addons.length) item.addons = addons;
  if (noKitchen) item.noKitchen = true;
  return item;
});

module.exports = { DEFAULT_MENU, CAT_GROUPS, CAT_ORDER };
