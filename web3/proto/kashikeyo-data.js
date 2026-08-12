/* KashikeyoPOS — seed data & platform spec.
   Inventory/supply-chain rows come from kashikeyo-raw.js (imported from the
   backend workbook); costs converted KWD -> MVR at 50.0. */
(function () {
  var R = window.KPOS_RAW || {};
  var IMG = function (n) { return "img/" + n + ".jpg"; };

  var CHAIN = {
    id: "ch_kashikeyo", name: "Kashikeyo Group", country: "MV", currency: "MVR",
    tin: "1002345GST501", regNo: "C-0912/2021",
    hq: "Boduthakurufaanu Magu, Malé 20026, Maldives",
    // ── Merchant branding ────────────────────────────────────────────────
    // The software is KashikeyoPOS; the business is Kashikeyo Group. Guest
    // facing artefacts — receipts, KOT, the QR ordering portal — carry the
    // MERCHANT's brand, never the vendor's. The vendor appears once, small,
    // as a "powered by" line, which a chain can switch off on a paid tier.
    brand: {
      mark: "brand/kashikeyo-mark.png",
      name: "KASHIKEYO",
      tagline: "Reef to table, since 2021",
      receiptFoot: "Thank you — Shukuriyyaa",
      poweredBy: true,
      colour: "#982030"
    }
  };

  // loc_type mirrors the workbook Branches sheet (main_store / central_kitchen /
  // restaurant + child stock locations). tax: GGST 8% general, TGST 16% tourism.
  var OUTLETS = [
    { id: 1, code: "MS-MLE", name: "Main Store — Malé", type: "main_store", loc: "main_store", parent: 0, region: "Malé", tax: "GGST", rate: 8, sc: 0, addr: "Industrial Village, Malé", mgr: "Ibrahim Nazim", pos: false, seats: 0 },
    { id: 2, code: "CK-HUL", name: "Hulhumalé Central Kitchen", type: "central_kitchen", loc: "central_kitchen", parent: 0, region: "Malé", tax: "GGST", rate: 8, sc: 0, addr: "Phase 1, Hulhumalé", mgr: "Aishath Reesha", pos: false, seats: 0 },
    { id: 3, code: "KO-CHA", name: "Kashikeyo Chaandhanee", type: "restaurant", loc: "restaurant", parent: 0, region: "Malé", tax: "GGST", rate: 8, sc: 10, addr: "Chaandhanee Magu, Malé", mgr: "Hassan Shifau", pos: true, seats: 64, tables: 16 },
    { id: 4, code: "KO-HUL", name: "Kashikeyo Hulhumalé", type: "restaurant", loc: "restaurant", parent: 0, region: "Malé", tax: "GGST", rate: 8, sc: 10, addr: "Nirolhu Magu, Hulhumalé", mgr: "Mariyam Leena", pos: true, seats: 48, tables: 12 },
    { id: 5, code: "KO-VIA", name: "Kashikeyo Velana Airport", type: "restaurant", loc: "restaurant", parent: 0, region: "Malé", tax: "TGST", rate: 16, sc: 10, addr: "Velana Intl. Airport, Hulhulé", mgr: "Ahmed Vishah", pos: true, seats: 36, tables: 9 },
    { id: 6, code: "KO-MAA", name: "Kashikeyo Maafushi", type: "restaurant", loc: "restaurant", parent: 0, region: "Atolls", tax: "TGST", rate: 16, sc: 10, addr: "Beach Road, Maafushi, K. Atoll", mgr: "Fathimath Zoona", pos: true, seats: 52, tables: 13 },
    { id: 7, code: "KO-BAA", name: "Kashikeyo Baa Atoll", type: "restaurant", loc: "restaurant", parent: 0, region: "Atolls", tax: "TGST", rate: 16, sc: 10, addr: "Dharavandhoo, Baa Atoll", mgr: "Ali Rifau", pos: true, seats: 40, tables: 10 },
    { id: 10, code: "MS-DRY", name: "Main Store — Dry Store", type: "main_store", loc: "store", parent: 1, region: "Malé", tax: "GGST", rate: 8, sc: 0, pos: false, seats: 0 },
    { id: 11, code: "MS-FRZ", name: "Main Store — Freezer", type: "main_store", loc: "freezer", parent: 1, region: "Malé", tax: "GGST", rate: 8, sc: 0, pos: false, seats: 0 },
    { id: 12, code: "CK-PRP", name: "Central Kitchen — Prep Line", type: "central_kitchen", loc: "kitchen", parent: 2, region: "Malé", tax: "GGST", rate: 8, sc: 0, pos: false, seats: 0 },
    { id: 13, code: "CK-DRY", name: "Central Kitchen — Dry Store", type: "central_kitchen", loc: "store", parent: 2, region: "Malé", tax: "GGST", rate: 8, sc: 0, pos: false, seats: 0 },
    { id: 14, code: "CK-FRZ", name: "Central Kitchen — Freezer", type: "central_kitchen", loc: "freezer", parent: 2, region: "Malé", tax: "GGST", rate: 8, sc: 0, pos: false, seats: 0 },
    { id: 20, code: "CHA-KIT", name: "Chaandhanee — Kitchen", type: "restaurant", loc: "kitchen", parent: 3, region: "Malé", tax: "GGST", rate: 8, sc: 0, pos: false, seats: 0 },
    { id: 21, code: "CHA-FLR", name: "Chaandhanee — Floor", type: "restaurant", loc: "floor", parent: 3, region: "Malé", tax: "GGST", rate: 8, sc: 0, pos: false, seats: 0 },
    { id: 22, code: "HUL-KIT", name: "Hulhumalé — Kitchen", type: "restaurant", loc: "kitchen", parent: 4, region: "Malé", tax: "GGST", rate: 8, sc: 0, pos: false, seats: 0 },
    { id: 23, code: "MAA-KIT", name: "Maafushi — Kitchen", type: "restaurant", loc: "kitchen", parent: 6, region: "Atolls", tax: "TGST", rate: 17, sc: 0, pos: false, seats: 0 }
  ];

  // icon keys resolve against CAT_ICONS in the component. Stroke glyphs, not
  // emoji: the till is read at a glance across a counter, and emoji render
  // differently on every device and vanish on a thermal print.
  var MENU_CATEGORIES = [
    { id: "starters", name: "Starters", icon: "starter" },
    { id: "mains", name: "Mains", icon: "main" },
    { id: "grill", name: "From the Grill", icon: "grill" },
    { id: "rice", name: "Rice & Noodles", icon: "rice" },
    { id: "sides", name: "Sides", icon: "side" },
    { id: "desserts", name: "Desserts", icon: "dessert" },
    { id: "drinks", name: "Drinks", icon: "drink" }
  ];
  // Top-level groups the 20+ real categories collapse under (Drinks/Breakfast/
  // Food/Desserts). Empty in the demo seed; filled from REAL.groups in real mode.
  var MENU_GROUPS = [];
  // Groups the category manager can assign to (canonical four + any custom in
  // use). Empty in the demo seed; filled from REAL.groupPalette in real mode.
  var MENU_GROUP_PALETTE = [];

  // price = chain master price in MVR. recipe = [rawItemId, qty in base unit]
  // price = chain master price in MVR (targets 30% food cost against the item master)
  // recipe = [items.id, qty in the item BASE unit (GRM / ML / PCS)]
  var MENU = [
    { id: "m1", cat: "starters", name: "Gulha & Bajiya Platter", desc: "Maldivian short-eats, chilli sambol, lime mayo", price: 75, veg: false, img: IMG("photo_1604909052743_94e838986d24"), recipe: [[18, 180], [174, 90], [116, 60], [106, 20], [76, 40], [170, 8], [104, 15], [78, 30]] },
    { id: "m2", cat: "starters", name: "Reef Fish Ceviche", desc: "Line-caught fish, lime, red onion, tortilla crisp", price: 105, veg: false, img: IMG("photo_1615141982883_c7ad0e69fd62"), recipe: [[18, 170], [99, 60], [118, 45], [122, 55], [103, 10], [109, 30], [96, 8], [203, 2], [92, 45]] },
    { id: "m3", cat: "starters", name: "Guacamole & Totopos", desc: "Hand-mashed avocado, lime, coriander, warm chips", price: 170, veg: false, img: IMG("photo_1608897013039_887f21d8c804"), recipe: [[92, 180], [121, 50], [117, 40], [109, 20], [96, 10], [35, 0.2], [199, 3]] },
    { id: "m4", cat: "starters", name: "Crispy Shrimp, Chipotle Mayo", desc: "Dusted and fried, lime, shredded lettuce", price: 80, veg: false, img: IMG("photo_1604909052743_94e838986d24"), recipe: [[21, 180], [174, 45], [76, 45], [69, 40], [104, 15], [111, 30]] },
    { id: "m5", cat: "starters", name: "Watermelon, Feta & Lime", desc: "Chilled melon, feta, mixed leaves, olive oil", price: 165, veg: true, img: IMG("photo_1505253668822_42074d58a7c6"), recipe: [[124, 160], [48, 0.35], [111, 40], [80, 15], [109, 12], [153, 1]] },
    { id: "m6", cat: "starters", name: "Birria Dip Toast", desc: "Slow-cooked birria, Monterey Jack, tortilla, consommé", price: 220, veg: false, img: IMG("photo_1432139509613_5c4255815697"), recipe: [[64, 140], [202, 1], [52, 40], [117, 30], [96, 8], [160, 6]] },
    { id: "m7", cat: "starters", name: "Shrimp Ceviche Cups", desc: "Ceviche shrimp, cucumber, chilli, lime", price: 110, veg: false, img: IMG("photo_1599021456807_25db0f974333"), recipe: [[15, 150], [104, 25], [118, 30], [103, 8], [109, 20], [214, 2]] },
    { id: "m8", cat: "starters", name: "Beef Tartare", desc: "Hand-cut striploin, egg yolk, dijon, tortilla crisp", price: 150, veg: false, img: IMG("photo_1544025162_d76694265947"), recipe: [[5, 140], [16, 1], [125, 30], [75, 0.05], [80, 12], [153, 1], [203, 2]] },
    { id: "m9", cat: "starters", name: "Charred Cabbage, Chipotle Ranch", desc: "Wok-charred, buttermilk ranch, lime, chilli crunch", price: 55, veg: true, img: IMG("photo_1580013759032_c96505e24c1f"), recipe: [[93, 220], [69, 45], [65, 35], [102, 15], [104, 15], [76, 25], [199, 3]] },
    { id: "m10", cat: "starters", name: "Roasted Garlic Soup", desc: "Sweet garlic, cream, parmesan crust, thyme", price: 70, veg: true, img: IMG("photo_1547592180_85f173990554"), recipe: [[101, 60], [127, 120], [45, 80], [41, 25], [54, 20], [160, 8], [174, 15]] },
    { id: "m20", cat: "mains", name: "Pan-Seared Reef Snapper", desc: "Sweet corn purée, cream, coriander oil", price: 150, veg: false, img: IMG("photo_1519708227418_c8fd9a32b7a2"), recipe: [[18, 300], [41, 40], [38, 110], [45, 70], [96, 8], [80, 12], [199, 3]] },
    { id: "m21", cat: "mains", name: "Yellowfin Tuna Steak", desc: "Seared rare, capsicum, mixed leaves, soy", price: 120, veg: false, img: IMG("photo_1544025162_d76694265947"), recipe: [[18, 320], [80, 20], [104, 20], [94, 70], [111, 50], [87, 15]] },
    { id: "m22", cat: "mains", name: "Parmesan Rice, Caramelised Onion", desc: "Slow-stirred jasmine rice, cream, parmesan", price: 105, veg: true, img: IMG("photo_1476124369491_e7addf5db371"), recipe: [[183, 200], [45, 100], [54, 55], [41, 35], [127, 60], [160, 10], [80, 12]] },
    { id: "m23", cat: "mains", name: "Soy-Glazed Reef Fish", desc: "Brown sugar and soy glaze, jasmine rice, garlic", price: 115, veg: false, img: IMG("photo_1467003909585_2f8a72700288"), recipe: [[18, 280], [87, 25], [183, 160], [101, 12], [96, 10], [154, 25], [74, 15]] },
    { id: "m30", cat: "grill", name: "Striploin 450g, Garlic Butter", desc: "Fire-grilled, roast garlic butter, potato", price: 390, veg: false, img: IMG("photo_1558030006_450675393462"), recipe: [[5, 450], [41, 45], [101, 20], [115, 150], [153, 3], [199, 4], [80, 15]] },
    { id: "m31", cat: "grill", name: "Beef Topside, Potato Purée", desc: "Slow-grilled topside, cream purée, garlic", price: 265, veg: false, img: IMG("photo_1432139509613_5c4255815697"), recipe: [[6, 280], [45, 70], [115, 200], [41, 30], [101, 12], [153, 2]] },
    { id: "m32", cat: "grill", name: "Half Chicken, Paprika & Lime", desc: "Marinated overnight, charred, coriander", price: 100, veg: false, img: IMG("photo_1514516345957_556ca7d90a29"), recipe: [[8, 450], [101, 20], [80, 20], [96, 12], [104, 20], [193, 4], [199, 3]] },
    { id: "m33", cat: "grill", name: "Cabbage & Chickpea Steak", desc: "Thick-cut charred cabbage, chickpeas, paprika", price: 85, veg: true, img: IMG("photo_1568901346375_23c9450c58cd"), recipe: [[93, 300], [158, 90], [80, 25], [193, 5], [109, 15], [96, 8], [69, 40]] },
    { id: "m34", cat: "grill", name: "Striploin for Two, 900g", desc: "Shared cut, garlic butter, roast potato", price: 760, veg: false, img: IMG("photo_1546964124_0cce460f38ef"), recipe: [[5, 900], [41, 60], [101, 25], [115, 250], [153, 5], [199, 6], [96, 10]] },
    { id: "m35", cat: "grill", name: "Grilled Shrimp, Salsa Verde", desc: "Charred head-on shrimp, potato, salsa verde", price: 145, veg: false, img: IMG("photo_1579631542720_3a87824fff86"), recipe: [[21, 240], [115, 140], [86, 55], [80, 20], [104, 15], [96, 8]] },
    { id: "m36", cat: "grill", name: "Whole Grilled Reef Fish", desc: "Whole fish, lime, garlic, curry leaf, banana leaf", price: 160, veg: false, img: IMG("photo_1544025162_d76694265947"), recipe: [[18, 450], [104, 30], [101, 20], [170, 10], [96, 12], [74, 20], [199, 4]] },
    { id: "m37", cat: "grill", name: "Grilled Mozzarella & Capsicum", desc: "Fire-grilled cheese, sweet capsicum, salsa verde", price: 85, veg: true, img: IMG("photo_1565299585323_38d6b0865b47"), recipe: [[53, 150], [94, 130], [86, 45], [80, 20], [104, 15], [191, 2]] },
    { id: "m40", cat: "rice", name: "Mas Riha & Steamed Rice", desc: "Tuna curry, curry leaf, steamed jasmine rice", price: 100, veg: false, img: IMG("photo_1621996346565_e3dbc646d9a9"), recipe: [[18, 220], [170, 12], [116, 60], [120, 50], [101, 15], [183, 240], [74, 20], [204, 4]] },
    { id: "m41", cat: "rice", name: "Cilantro Rice Bowl", desc: "Coriander rice, corn salsa, pinto beans, avocado", price: 165, veg: true, img: IMG("photo_1473093295043_cdd812d0e601"), recipe: [[25, 300], [27, 80], [36, 90], [84, 45], [49, 40], [96, 10], [242, 1]] },
    { id: "m42", cat: "rice", name: "Shrimp Ravioli, Parmesan Cream", desc: "Hand-rolled pasta, shrimp, cream, parmesan", price: 130, veg: false, img: IMG("photo_1551183053_bf91a1d81141"), recipe: [[21, 180], [174, 90], [16, 1], [45, 80], [54, 30], [41, 25], [96, 6]] },
    { id: "m50", cat: "sides", name: "Parmesan Fries", desc: "Fried crisp, parmesan, coriander, chipotle mayo", price: 60, veg: true, img: IMG("photo_1573080496219_bb080dd4f877"), recipe: [[29, 220], [76, 40], [54, 25], [69, 30], [96, 5]] },
    { id: "m51", cat: "sides", name: "Buttered Peas & Carrot", desc: "Green peas, carrot, garlic butter, black pepper", price: 55, veg: true, img: IMG("photo_1466637574441_749b8f19452f"), recipe: [[178, 140], [95, 90], [41, 25], [101, 10], [153, 1]] },
    { id: "m52", cat: "sides", name: "Creamed Sweet Corn", desc: "Sweet corn, cream, parmesan, caramelised onion", price: 75, veg: true, img: IMG("photo_1576402187878_974f70c890a5"), recipe: [[38, 170], [45, 80], [41, 20], [54, 25], [127, 35]] },
    { id: "m53", cat: "sides", name: "Mac & Cheese", desc: "Cheddar, mozzarella, milk, panko crust", price: 85, veg: true, img: IMG("photo_1543339308_43e59d6b73a6"), recipe: [[190, 1.5], [49, 90], [53, 60], [50, 90], [41, 20], [174, 15]] },
    { id: "m60", cat: "desserts", name: "White Chocolate Torte", desc: "White chocolate, cream, vanilla, butter crumb", price: 70, veg: true, img: IMG("photo_1606313564200_e75d5e30476c"), recipe: [[58, 80], [41, 45], [16, 2], [173, 50], [174, 45], [45, 45]] },
    { id: "m61", cat: "desserts", name: "Crème Brûlée", desc: "Vanilla custard, torched sugar, fresh melon", price: 65, veg: true, img: IMG("photo_1470124182917_cc6e71b22ecc"), recipe: [[45, 130], [16, 2], [173, 35], [205, 0.2], [124, 45]] },
    { id: "m62", cat: "desserts", name: "Churros, Cinnamon Sugar", desc: "Fried to order, cinnamon sugar, white chocolate dip", price: 50, veg: true, img: IMG("photo_1587314168485_3236d6710814"), recipe: [[24, 150], [164, 6], [173, 30], [76, 35], [58, 40], [220, 1]] },
    { id: "m70", cat: "drinks", name: "Horchata, Cinnamon", desc: "Rice-milk horchata, cinnamon, served over ice", price: 45, veg: true, img: IMG("photo_1470337458703_46ad1756a187"), recipe: [[130, 240], [164, 2], [173, 12], [213, 1], [253, 1]] },
    { id: "m71", cat: "drinks", name: "Hibiscus Cooler", desc: "Steeped hibiscus, lime, lightly sweetened", price: 40, veg: true, img: IMG("photo_1514362545857_3bc16c4c7d1b"), recipe: [[180, 12], [104, 25], [173, 15], [213, 1], [253, 1]] },
    { id: "m72", cat: "drinks", name: "Sparkling Water", desc: "Chilled, lime wedge", price: 45, veg: true, img: IMG("photo_1523362628745_0c100150b504"), recipe: [[139, 1], [104, 10]] },
    { id: "m73", cat: "drinks", name: "Masala Tea", desc: "Black tea, milk, cardamom, palm sugar", price: 30, veg: true, img: IMG("photo_1461023058943_07fcbe16d735"), recipe: [[142, 14], [50, 90], [154, 12], [165, 1], [211, 1]] },
    { id: "m74", cat: "drinks", name: "Fresh Mango Juice", desc: "Pressed to order, no added sugar", price: 60, veg: true, img: IMG("photo_1613478223719_2ab802602423"), recipe: [[32, 200], [110, 70], [173, 15], [213, 1], [253, 1]] }
  ];

  // ── Roles: workbook roles + POS/platform roles the prototype adds ──────────
  var MODULES = [
    { key: "pos", label: "POS terminal", group: "Front of house" },
    { key: "kds", label: "Kitchen display", group: "Front of house" },
    { key: "reservations", label: "Reservations", group: "Front of house" },
    { key: "customers", label: "Customers & credit", group: "Front of house" },
    { key: "orders", label: "Orders & receipts", group: "Front of house" },
    { key: "delivery", label: "Delivery & QR orders", group: "Front of house" },
    { key: "chain", label: "Chain overview", group: "Chain" },
    { key: "branches", label: "Outlets", group: "Chain" },
    { key: "menu", label: "Menu master", group: "Chain" },
    { key: "aimenu", label: "AI menu builder", group: "Chain" },
    { key: "users", label: "Users & roles", group: "Chain" },
    { key: "logs", label: "Audit log", group: "Chain" },
    { key: "inventory", label: "Inventory", group: "Supply chain" },
    { key: "ledger", label: "Stock ledger", group: "Supply chain" },
    { key: "counts", label: "Stock counts", group: "Supply chain" },
    { key: "purchases", label: "Purchases / GRN", group: "Supply chain" },
    { key: "requests", label: "Indent requests", group: "Supply chain" },
    { key: "dispatches", label: "Dispatches", group: "Supply chain" },
    { key: "production", label: "Production", group: "Supply chain" },
    { key: "recipes", label: "Recipes", group: "Supply chain" },
    { key: "batches", label: "Batches & expiry", group: "Supply chain" },
    { key: "vendors", label: "Vendors", group: "Supply chain" },
    { key: "staff", label: "Staff & time clock", group: "People" },
    { key: "payroll", label: "Payroll & pension", group: "People" },
    { key: "accounting", label: "Accounting flow", group: "Finance" },
    { key: "costs", label: "Operating costs", group: "Finance" },
    { key: "assets", label: "Equipment & maintenance", group: "Finance" },
    { key: "reports", label: "Reports & exports", group: "Finance" },
    { key: "analytics", label: "Analytics & CFO", group: "Finance" },
    { key: "sync", label: "Sync & devices", group: "Platform" },
    { key: "settings", label: "Settings", group: "Platform" },
    { key: "architecture", label: "Architecture", group: "Platform" }
  ];

  function perms(spec) {
    var out = {};
    MODULES.forEach(function (m) { out[m.key] = spec[m.key] || { v: 0, a: 0, e: 0, d: 0 }; });
    return out;
  }
  var ALL = { v: 1, a: 1, e: 1, d: 1 }, VAE = { v: 1, a: 1, e: 1, d: 0 }, VA = { v: 1, a: 1, e: 0, d: 0 }, V = { v: 1, a: 0, e: 0, d: 0 };

  var ROLES = [
    {
      key: "SuperAdmin", label: "Super Admin", color: "#a88ad9", scope: "platform",
      blurb: "Platform owner. Crosses every chain — the only role whose JWT omits chain_id.",
      perms: (function () { var o = {}; MODULES.forEach(function (m) { o[m.key] = ALL; }); return o; })()
    },
    {
      key: "ChainAdmin", label: "Chain / HQ Admin", color: "#f2a43a", scope: "chain",
      blurb: "Full reach inside one chain, every outlet.",
      perms: (function () { var o = {}; MODULES.forEach(function (m) { o[m.key] = m.key === "architecture" ? V : ALL; }); o.analytics = V; return o; })()
    },
    {
      key: "OutletManager", label: "Outlet Manager", color: "#2e7d32", scope: "outlet",
      blurb: "One outlet. Reads chain menu master, writes local overrides.",
      perms: perms({ pos: ALL, kds: VAE, reservations: ALL, customers: VAE, orders: VAE, delivery: VAE, chain: V, branches: V, menu: VAE, inventory: V, ledger: V, counts: VAE, requests: VAE, dispatches: VAE, batches: V, reports: V, accounting: V, sync: V, settings: V, logs: V, staff: VAE, costs: V, assets: VAE })
    },
    {
      key: "Cashier", label: "Cashier / Waiter", color: "#0074D9", scope: "outlet",
      blurb: "Runs the till and receives stock on shift — take orders and payments, receive deliveries / premade foods / supplies, add items and vendors, count stock, record waste, transfer and reorder. Cannot edit prices or the menu, delete anything, or see finance, payroll, settings or other outlets.",
      perms: perms({ pos: VAE, reservations: VAE, customers: VA, orders: VA, delivery: VA, kds: V, menu: V,
        inventory: VA, purchases: VA, counts: VAE, ledger: V, batches: V, requests: VA, dispatches: V, vendors: VA })
    },
    {
      key: "KitchenManager", label: "Kitchen Manager", color: "#e65100", scope: "outlet",
      blurb: "Central kitchen + KDS. Production, recipes, indents.",
      perms: perms({ kds: VAE, pos: V, production: VAE, recipes: VAE, requests: VAE, dispatches: VAE, consumption: VAE, inventory: V, ledger: V, counts: VAE, batches: VAE, menu: V, reports: V, sync: V, staff: V, assets: VAE })
    },
    {
      key: "StoreKeeper", label: "Store Keeper", color: "#67a2d9", scope: "outlet",
      blurb: "Main store. Receiving, dispatch, counts, vendors.",
      perms: perms({ purchases: VAE, dispatches: VAE, requests: VAE, inventory: V, ledger: V, counts: VAE, batches: VAE, vendors: VAE, reports: V, sync: V, assets: VAE })
    },
    {
      key: "Accountant", label: "Accountant / Auditor", color: "#6bbf7b", scope: "chain",
      blurb: "Read-everything, write-nothing. Exports GST returns.",
      perms: (function () { var o = {}; MODULES.forEach(function (m) { o[m.key] = V; }); o.accounting = VAE; o.reports = VAE; o.payroll = VAE; o.costs = VAE; o.pos = { v: 0, a: 0, e: 0, d: 0 }; return o; })()
    }
  ];

  // Device PINs. A shared till never asks for a password — staff tap their own
  // name and key four digits, which is what makes a void or a drawer opening
  // attributable to a person. Demo values; production hashes these per user.
  var ROLE_PINS = {
    SuperAdmin: "1111", ChainAdmin: "2222", OutletManager: "3333",
    Cashier: "4444", KitchenManager: "5555", StoreKeeper: "6666", Accountant: "7777"
  };

  // Access is per PERSON, not per role: the PIN, the home outlet and any extra
  // outlet grants live on the user row. A shared role PIN would make every
  // "who voided this" answer in the audit log a guess.
  var USERS = [
    { id: "u1", name: "Ahmed Shazail", user: "shazail", role: "SuperAdmin", outlet: null, outlets: [], pin: "4718", status: "Active", last: "2m ago" },
    { id: "u2", name: "Aminath Nashwa", user: "nashwa", role: "ChainAdmin", outlet: null, outlets: [], pin: "2093", status: "Active", last: "18m ago" },
    { id: "u3", name: "Hassan Shifau", user: "shifau", role: "OutletManager", outlet: 3, outlets: [], pin: "7364", status: "Active", last: "Now" },
    { id: "u4", name: "Mariyam Leena", user: "leena", role: "OutletManager", outlet: 4, outlets: [7], pin: "5281", status: "Active", last: "1h ago" },
    { id: "u5", name: "Fathimath Zoona", user: "zoona", role: "OutletManager", outlet: 6, outlets: [], pin: "9047", status: "Active", last: "3h ago" },
    { id: "u6", name: "Ali Rifau", user: "rifau", role: "OutletManager", outlet: 7, outlets: [], pin: "3915", status: "Suspended", last: "6d ago" },
    { id: "u7", name: "Ismail Nabeeh", user: "nabeeh", role: "Cashier", outlet: 3, outlets: [], pin: "6520", status: "Active", last: "Now" },
    { id: "u8", name: "Shifa Adam", user: "shifa", role: "Cashier", outlet: 3, outlets: [], pin: "1836", status: "Active", last: "Now" },
    { id: "u9", name: "Aishath Reesha", user: "reesha", role: "KitchenManager", outlet: 2, outlets: [], pin: "4402", status: "Active", last: "12m ago" },
    { id: "u10", name: "Ibrahim Nazim", user: "nazim", role: "StoreKeeper", outlet: 1, outlets: [], pin: "8173", status: "Active", last: "40m ago" },
    { id: "u11", name: "Yoosuf Waheed", user: "waheed", role: "Accountant", outlet: null, outlets: [], pin: "2657", status: "Active", last: "2d ago" }
  ];

  var CUSTOMERS = [
    { id: "c1", name: "Aishath Rifga", phone: "+960 777 4821", visits: 24, spent: 18420, points: 1842, tier: "Platinum", credit: 2500, used: 940, last: "Today" },
    { id: "c2", name: "Mohamed Zayan", phone: "+960 991 2077", visits: 11, spent: 7310, points: 731, tier: "Gold", credit: 1500, used: 1500, last: "2 days ago" },
    { id: "c3", name: "Sarah Lindqvist", phone: "+46 70 118 9920", visits: 4, spent: 4180, points: 418, tier: "Silver", credit: 0, used: 0, last: "Yesterday" },
    { id: "c4", name: "Ibrahim Faisal", phone: "+960 778 0164", visits: 31, spent: 22960, points: 2296, tier: "Platinum", credit: 5000, used: 1120, last: "Today" },
    { id: "c5", name: "Hawwa Nazly", phone: "+960 966 3345", visits: 7, spent: 3120, points: 312, tier: "Silver", credit: 1000, used: 0, last: "1 week ago" },
    { id: "c6", name: "Daniel Okafor", phone: "+44 7700 900412", visits: 2, spent: 1560, points: 156, tier: "Bronze", credit: 0, used: 0, last: "3 weeks ago" }
  ];

  // ── Platform spec ─────────────────────────────────────────────────────────
  var JWT_CLAIM = [
    '{',
    '  "sub":        "u_7f3a91c2",              // auth.users.id',
    '  "role":       "authenticated",           // Postgres role assumed by PostgREST',
    '  "app_role":   "OutletManager",           // KashikeyoPOS role key',
    '  "chain_id":   "ch_kashikeyo",            // NULL only for SuperAdmin',
    '  "outlet_ids": [3, 20, 21],               // outlet + its stock locations',
    '  "device_id":  "dev_CHA_T1",              // registered terminal',
    '  "shift_id":   "sh_20260803_evening",',
    '  "iat": 1785700000, "exp": 1785703600',
    '}'
  ].join("\n");

  var RLS_SQL = [
    "-- ─────────────────────────────────────────────────────────────────────",
    "-- KashikeyoPOS · row-level security  (Postgres 16 · Railway)",
    "-- Every tenant-scoped table carries chain_id; every outlet-scoped table",
    "-- also carries outlet_id. Policies read the request JWT, never the client.",
    "-- ─────────────────────────────────────────────────────────────────────",
    "",
    "create schema if not exists kpos;",
    "",
    "-- Claim helpers ------------------------------------------------------",
    "create or replace function kpos.jwt() returns jsonb",
    "  language sql stable as $$",
    "  select coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;",
    "",
    "create or replace function kpos.chain_id() returns text",
    "  language sql stable as $$ select kpos.jwt()->>'chain_id' $$;",
    "",
    "create or replace function kpos.app_role() returns text",
    "  language sql stable as $$ select kpos.jwt()->>'app_role' $$;",
    "",
    "create or replace function kpos.outlet_ids() returns int[]",
    "  language sql stable as $$",
    "  select coalesce(array(select jsonb_array_elements_text(kpos.jwt()->'outlet_ids')::int),",
    "                  '{}'::int[]) $$;",
    "",
    "create or replace function kpos.is_super() returns boolean",
    "  language sql stable as $$ select kpos.app_role() = 'SuperAdmin' $$;",
    "",
    "create or replace function kpos.is_chain_wide() returns boolean",
    "  language sql stable as $$",
    "  select kpos.app_role() in ('SuperAdmin','ChainAdmin','Accountant') $$;",
    "",
    "-- Tenant root ---------------------------------------------------------",
    "alter table kpos.chains enable row level security;",
    "create policy chain_read on kpos.chains for select",
    "  using ( kpos.is_super() or id = kpos.chain_id() );",
    "",
    "-- Outlets: chain-wide roles see all; outlet roles see their own subtree -",
    "alter table kpos.outlets enable row level security;",
    "create policy outlet_read on kpos.outlets for select",
    "  using ( kpos.is_super()",
    "          or ( chain_id = kpos.chain_id()",
    "               and ( kpos.is_chain_wide() or id = any(kpos.outlet_ids()) ) ) );",
    "create policy outlet_write on kpos.outlets for all",
    "  using  ( kpos.app_role() in ('SuperAdmin','ChainAdmin')",
    "           and (kpos.is_super() or chain_id = kpos.chain_id()) )",
    "  with check ( kpos.is_super() or chain_id = kpos.chain_id() );",
    "",
    "-- Orders: written at the terminal, readable up the hierarchy -----------",
    "alter table kpos.orders enable row level security;",
    "create policy order_read on kpos.orders for select",
    "  using ( kpos.is_super()",
    "          or ( chain_id = kpos.chain_id()",
    "               and ( kpos.is_chain_wide() or outlet_id = any(kpos.outlet_ids()) ) ) );",
    "",
    "create policy order_insert on kpos.orders for insert",
    "  with check ( chain_id  = kpos.chain_id()",
    "               and outlet_id = any(kpos.outlet_ids())",
    "               and device_id = kpos.jwt()->>'device_id'",
    "               and kpos.app_role() in ('Cashier','OutletManager','ChainAdmin') );",
    "",
    "-- Closed tickets are immutable; corrections go through kpos.void_order()",
    "create policy order_update on kpos.orders for update",
    "  using ( status <> 'closed'",
    "          and outlet_id = any(kpos.outlet_ids())",
    "          and kpos.app_role() in ('Cashier','OutletManager') )",
    "  with check ( outlet_id = any(kpos.outlet_ids()) );",
    "",
    "-- Cost price is hidden from Cashier via a column-masked view ------------",
    "create view kpos.menu_for_terminal with (security_invoker = true) as",
    "  select id, outlet_id, name, description, sell_price, tax_class, photo_url,",
    "         case when kpos.app_role() = 'Cashier' then null else food_cost end",
    "           as food_cost",
    "  from kpos.menu_items;",
    "",
    "-- Stock ledger is append-only for everyone ------------------------------",
    "alter table kpos.stock_ledger enable row level security;",
    "create policy ledger_read on kpos.stock_ledger for select",
    "  using ( chain_id = kpos.chain_id()",
    "          and ( kpos.is_chain_wide() or outlet_id = any(kpos.outlet_ids()) ) );",
    "create policy ledger_append on kpos.stock_ledger for insert",
    "  with check ( chain_id = kpos.chain_id()",
    "               and outlet_id = any(kpos.outlet_ids()) );",
    "revoke update, delete on kpos.stock_ledger from authenticated;",
    "",
    "-- Offline sync: the replay endpoint is the only writer of sync_ops ------",
    "alter table kpos.sync_ops enable row level security;",
    "create policy sync_own_device on kpos.sync_ops for all",
    "  using      ( device_id = kpos.jwt()->>'device_id' )",
    "  with check ( device_id = kpos.jwt()->>'device_id'",
    "               and outlet_id = any(kpos.outlet_ids()) );",
    "",
    "-- Audit log: insert-only, chain-scoped read ------------------------------",
    "alter table kpos.audit_log enable row level security;",
    "create policy audit_read on kpos.audit_log for select",
    "  using ( kpos.is_super() or (chain_id = kpos.chain_id() and kpos.is_chain_wide()) );",
    "create policy audit_append on kpos.audit_log for insert",
    "  with check ( chain_id = kpos.chain_id() );",
    "",
    "-- Force RLS so the table owner is not exempt -----------------------------",
    "do $$ declare t text; begin",
    "  for t in select tablename from pg_tables where schemaname = 'kpos' loop",
    "    execute format('alter table kpos.%I force row level security', t);",
    "  end loop;",
    "end $$;"
  ].join("\n");

  var ERD = [
    { group: "Tenancy", color: "#f2a43a", tables: [
      { name: "chains", cols: ["id pk", "name", "country", "currency", "tin"], rls: "id = jwt.chain_id" },
      { name: "outlets", cols: ["id pk", "chain_id fk", "parent_id fk", "code", "loc_type", "tax_class", "tax_rate"], rls: "chain + outlet_ids[]" },
      { name: "devices", cols: ["id pk", "outlet_id fk", "label", "last_seen", "app_version"], rls: "outlet_ids[]" },
      { name: "users", cols: ["id pk", "chain_id fk", "app_role", "outlet_id fk", "status"], rls: "chain, self-read" },
      { name: "roles", cols: ["key pk", "label", "scope", "permissions jsonb"], rls: "chain" }
    ]},
    { group: "Front of house", color: "#67a2d9", tables: [
      { name: "tables", cols: ["id pk", "outlet_id fk", "num", "capacity", "status", "qr_token"], rls: "outlet_ids[]" },
      { name: "orders", cols: ["id pk", "chain_id", "outlet_id", "table_id", "device_id", "status", "channel"], rls: "insert: own device" },
      { name: "order_lines", cols: ["id pk", "order_id fk", "menu_item_id fk", "qty", "unit_price", "note", "kds_state"], rls: "via order" },
      { name: "payments", cols: ["id pk", "order_id fk", "method", "amount", "tendered", "ref"], rls: "via order" },
      { name: "reservations", cols: ["id pk", "outlet_id fk", "customer_id fk", "ts", "party", "status"], rls: "outlet_ids[]" },
      { name: "customers", cols: ["id pk", "chain_id fk", "name", "phone", "tier", "points", "credit_limit"], rls: "chain-wide" },
      { name: "credit_ledger", cols: ["id pk", "customer_id fk", "order_id fk", "debit", "credit", "balance"], rls: "chain-wide" },
      { name: "deliveries", cols: ["id pk", "order_id fk", "channel", "rider", "eta", "status"], rls: "outlet_ids[]" }
    ]},
    { group: "Menu", color: "#a88ad9", tables: [
      { name: "menu_items", cols: ["id pk", "chain_id fk", "category", "name", "sell_price", "tax_class", "food_cost"], rls: "chain-wide read" },
      { name: "menu_overrides", cols: ["id pk", "menu_item_id fk", "outlet_id fk", "price", "is_available"], rls: "outlet_ids[]" },
      { name: "recipes", cols: ["id pk", "menu_item_id fk", "yield_qty", "yield_unit"], rls: "chain" },
      { name: "recipe_lines", cols: ["id pk", "recipe_id fk", "item_id fk", "qty", "waste_pct"], rls: "via recipe" }
    ]},
    { group: "Supply chain", color: "#6bbf7b", tables: [
      { name: "items", cols: ["id pk", "chain_id fk", "category_id fk", "item_code", "base_unit", "stock_unit", "unit_cost"], rls: "chain" },
      { name: "categories", cols: ["id pk", "chain_id fk", "name", "storage_type", "count_freq"], rls: "chain" },
      { name: "units", cols: ["code pk", "kind", "base_code", "factor"], rls: "global" },
      { name: "inventory", cols: ["outlet_id fk", "item_id fk", "qty", "updated_at"], rls: "outlet_ids[]" },
      { name: "stock_ledger", cols: ["id pk", "outlet_id", "item_id", "movement_type", "ref_id", "qty_in", "qty_out", "balance"], rls: "append-only" },
      { name: "batches", cols: ["id pk", "item_id fk", "outlet_id fk", "batch_no", "expiry_date", "qty_remaining"], rls: "outlet_ids[]" },
      { name: "purchases", cols: ["id pk", "grn_no", "vendor_id fk", "outlet_id fk", "total", "status"], rls: "outlet_ids[]" },
      { name: "purchase_items", cols: ["id pk", "purchase_id fk", "item_id fk", "qty", "unit_cost"], rls: "via purchase" },
      { name: "requests", cols: ["id pk", "request_no", "from_outlet", "to_outlet", "status", "priority"], rls: "either side" },
      { name: "dispatches", cols: ["id pk", "invoice_no", "from_outlet", "to_outlet", "status"], rls: "either side" },
      { name: "productions", cols: ["id pk", "production_no", "outlet_id fk", "item_id fk", "output_qty"], rls: "outlet_ids[]" },
      { name: "stock_counts", cols: ["id pk", "count_no", "outlet_id fk", "blind", "variance_value", "status"], rls: "outlet_ids[]" },
      { name: "vendors", cols: ["id pk", "chain_id fk", "name", "phone"], rls: "chain" }
    ]},
    { group: "Platform", color: "#e26060", tables: [
      { name: "sync_ops", cols: ["id pk", "device_id fk", "outlet_id", "op", "payload jsonb", "lamport", "state"], rls: "own device" },
      { name: "audit_log", cols: ["id pk", "chain_id", "actor", "action", "details", "ts"], rls: "insert-only" },
      { name: "journal_entries", cols: ["id pk", "chain_id", "outlet_id", "ref_type", "ref_id", "posted_at"], rls: "chain-wide" },
      { name: "journal_lines", cols: ["id pk", "entry_id fk", "account_code", "debit", "credit"], rls: "via entry" }
    ]}
  ];

  var RAILWAY = [
    { id: "edge", name: "Cloudflare", sub: "TLS · WAF · CDN for /img", kind: "external", col: 0 },
    { id: "web", name: "kpos-web", sub: "Static PWA · service worker · IndexedDB outbox", kind: "service", col: 1, port: "3000" },
    { id: "api", name: "kpos-api", sub: "Node 20 · PostgREST-style · signs JWT with chain_id + outlet_ids", kind: "service", col: 1, port: "8080" },
    { id: "sync", name: "kpos-sync", sub: "Replay worker · Lamport ordering · conflict resolver", kind: "service", col: 1, port: "8081" },
    { id: "ai", name: "kpos-ai", sub: "Menu builder · cost engineering · demand forecast", kind: "service", col: 1, port: "8082" },
    { id: "pg", name: "Postgres 16", sub: "Railway managed · RLS forced · PITR 7 days", kind: "db", col: 2 },
    { id: "redis", name: "Redis", sub: "Sync locks · rate limit · KDS pub/sub", kind: "db", col: 2 },
    { id: "bucket", name: "Object storage", sub: "Item photos · GRN scans · Z-report PDFs", kind: "db", col: 2 }
  ];

  var RAILWAY_NOTES = [
    ["Environments", "production · staging · pr-* ephemeral. Each gets its own Postgres volume; staging seeds from a scrubbed nightly dump."],
    ["Private networking", "kpos-web is the only service with a public domain. api/sync/ai talk to Postgres over railway.internal — no egress, no public port."],
    ["Secrets", "DATABASE_URL, JWT_SECRET, AI_KEY are Railway shared variables referenced as ${{Postgres.DATABASE_URL}}; nothing in the repo."],
    ["Connection pooling", "PgBouncer sidecar in transaction mode. RLS claims are set per-transaction with set_config('request.jwt.claims', …, true) so pooled connections cannot leak a tenant."],
    ["Migrations", "kpos-api runs `railway run migrate` as a pre-deploy command; every migration ends with the force-RLS DO block."],
    ["Health & rollback", "/healthz checks Postgres + Redis. Railway keeps the previous deploy warm; failed health check auto-rolls back."],
    ["Backups", "Daily logical dump to object storage + Railway PITR. Restores are rehearsed monthly into a pr- environment."]
  ];

  var ACCOUNTS = [
    { code: "1010", name: "Cash on hand", type: "Asset" },
    { code: "1020", name: "Bank — BML MVR", type: "Asset" },
    { code: "1030", name: "Card settlement receivable", type: "Asset" },
    { code: "1040", name: "Customer credit receivable", type: "Asset" },
    { code: "1200", name: "Inventory — raw", type: "Asset" },
    { code: "1210", name: "Inventory — finished", type: "Asset" },
    { code: "2100", name: "Accounts payable", type: "Liability" },
    { code: "2200", name: "GST payable (GGST/TGST)", type: "Liability" },
    { code: "2300", name: "Service charge payable", type: "Liability" },
    { code: "4000", name: "Food & beverage revenue", type: "Revenue" },
    { code: "4100", name: "Delivery revenue", type: "Revenue" },
    { code: "5000", name: "Cost of goods sold", type: "Expense" },
    { code: "5100", name: "Wastage & variance", type: "Expense" }
  ];

  // ── People ────────────────────────────────────────────────────────────────
  // kind drives the pension and tax treatment: MRPS is mandatory for Maldivian
  // employees aged 16–65 and voluntary for foreign nationals. basic is the
  // pensionable wage (the contract basic salary), which is what 7%+7% is taken
  // on — not gross. hourly is used to cost clocked shifts.
  // ot: paid for overtime at 1.25x. Salaried supervisory staff are contracted on
  // a monthly wage and are not, though their hours are still clocked.
  // svc: shares in the service charge pool.
  // mrps: enrolled in the pension scheme.
  // All three govern PAY ONLY. Hours, overtime and attendance are tracked for
  // every employee regardless, because a dispute is settled by the record.
  var STAFF = [
    { id: "s1", name: "Hassan Shifau", outlet: 3, job: "Outlet Manager", kind: "local", basic: 18000, hourly: 104, joined: "2021-03-14", mrps: true, ot: false, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s2", name: "Ismail Nabeeh", outlet: 3, job: "Cashier", kind: "local", basic: 8200, hourly: 47, joined: "2023-07-02", mrps: true, ot: true, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s3", name: "Shifa Adam", outlet: 3, job: "Waiter", kind: "local", basic: 7600, hourly: 44, joined: "2024-01-19", mrps: true, ot: true, svc: true, sex: "f", type: "fulltime", photo: "" },
    { id: "s4", name: "Rahim Uddin", outlet: 3, job: "Chef de partie", kind: "expat", basic: 11500, hourly: 66, joined: "2022-09-08", mrps: false, ot: false, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s5", name: "Sabuj Miah", outlet: 3, job: "Commis", kind: "expat", basic: 7200, hourly: 42, joined: "2024-05-21", mrps: false, ot: true, svc: true, sex: "m", type: "contract", photo: "" },
    { id: "s6", name: "Mariyam Leena", outlet: 4, job: "Outlet Manager", kind: "local", basic: 17500, hourly: 101, joined: "2020-11-30", mrps: true, ot: false, svc: true, sex: "f", type: "fulltime", photo: "" },
    { id: "s7", name: "Aminath Sana", outlet: 4, job: "Cashier", kind: "local", basic: 8400, hourly: 48, joined: "2023-02-11", mrps: true, ot: true, svc: true, sex: "f", type: "fulltime", photo: "" },
    { id: "s8", name: "Kumar Rajan", outlet: 4, job: "Sous chef", kind: "expat", basic: 13200, hourly: 76, joined: "2021-06-04", mrps: false, ot: false, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s9", name: "Nishan Perera", outlet: 4, job: "Steward", kind: "expat", basic: 6800, hourly: 39, joined: "2025-01-08", mrps: false, ot: true, svc: true, sex: "m", type: "contract", photo: "" },
    { id: "s10", name: "Fathimath Zoona", outlet: 6, job: "Outlet Manager", kind: "local", basic: 19500, hourly: 113, joined: "2019-08-22", mrps: true, ot: false, svc: true, sex: "f", type: "fulltime", photo: "" },
    { id: "s11", name: "Ahmed Sinan", outlet: 6, job: "Waiter", kind: "local", basic: 8800, hourly: 51, joined: "2024-03-17", mrps: true, ot: true, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s12", name: "Anwar Hossain", outlet: 6, job: "Grill cook", kind: "expat", basic: 9600, hourly: 55, joined: "2023-10-29", mrps: false, ot: true, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s13", name: "Ali Rifau", outlet: 7, job: "Outlet Manager", kind: "local", basic: 16800, hourly: 97, joined: "2022-02-05", mrps: true, ot: false, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s14", name: "Hawwa Shifna", outlet: 7, job: "Cashier", kind: "local", basic: 7900, hourly: 46, joined: "2025-04-14", mrps: true, ot: true, svc: true, sex: "f", type: "fulltime", photo: "" },
    { id: "s15", name: "Aishath Reesha", outlet: 2, job: "Kitchen Manager", kind: "local", basic: 21000, hourly: 121, joined: "2020-05-18", mrps: true, ot: false, svc: true, sex: "f", type: "fulltime", photo: "" },
    { id: "s16", name: "Ibrahim Nazim", outlet: 1, job: "Store Keeper", kind: "local", basic: 10400, hourly: 60, joined: "2021-12-01", mrps: true, ot: false, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s17", name: "Adam Saleem", outlet: 3, job: "Waiter", kind: "local", basic: 6900, hourly: 40, joined: "2021-01-01", mrps: true, ot: true, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s18", name: "Hussain Niyaz", outlet: 3, job: "Waiter", kind: "local", basic: 7400, hourly: 43, joined: "2022-02-04", mrps: true, ot: true, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s19", name: "Aishath Nuha", outlet: 3, job: "Commis", kind: "local", basic: 7400, hourly: 43, joined: "2023-03-07", mrps: true, ot: true, svc: true, sex: "f", type: "contract", photo: "" },
    { id: "s20", name: "Mohamed Athif", outlet: 4, job: "Steward", kind: "local", basic: 7400, hourly: 44, joined: "2024-04-10", mrps: true, ot: true, svc: true, sex: "m", type: "contract", photo: "" },
    { id: "s21", name: "Fathimath Rishma", outlet: 4, job: "Line cook", kind: "local", basic: 8600, hourly: 50, joined: "2025-05-13", mrps: true, ot: true, svc: true, sex: "f", type: "fulltime", photo: "" },
    { id: "s22", name: "Ahmed Waheed", outlet: 4, job: "Barista", kind: "local", basic: 7700, hourly: 45, joined: "2021-06-16", mrps: true, ot: true, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s23", name: "Aminath Shazna", outlet: 6, job: "Host", kind: "local", basic: 7600, hourly: 44, joined: "2022-07-19", mrps: true, ot: true, svc: true, sex: "f", type: "contract", photo: "" },
    { id: "s24", name: "Ibrahim Latheef", outlet: 6, job: "Kitchen porter", kind: "local", basic: 7200, hourly: 42, joined: "2023-08-22", mrps: true, ot: true, svc: true, sex: "m", type: "contract", photo: "" },
    { id: "s25", name: "Hawwa Rimsha", outlet: 7, job: "Runner", kind: "local", basic: 6400, hourly: 37, joined: "2024-09-25", mrps: true, ot: true, svc: true, sex: "f", type: "contract", photo: "" },
    { id: "s26", name: "Ali Shameem", outlet: 2, job: "Prep cook", kind: "local", basic: 8100, hourly: 47, joined: "2025-10-01", mrps: true, ot: true, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s27", name: "Mariyam Nasha", outlet: 3, job: "Waiter", kind: "local", basic: 7500, hourly: 44, joined: "2021-11-04", mrps: true, ot: true, svc: true, sex: "f", type: "fulltime", photo: "" },
    { id: "s28", name: "Yoosuf Imad", outlet: 3, job: "Waiter", kind: "local", basic: 8000, hourly: 47, joined: "2022-12-07", mrps: true, ot: true, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s29", name: "Jahangir Alam", outlet: 3, job: "Commis", kind: "expat", basic: 6800, hourly: 39, joined: "2023-01-10", mrps: false, ot: true, svc: true, sex: "m", type: "contract", photo: "" },
    { id: "s30", name: "Rubel Sheikh", outlet: 4, job: "Steward", kind: "expat", basic: 6800, hourly: 40, joined: "2024-02-13", mrps: false, ot: true, svc: true, sex: "m", type: "contract", photo: "" },
    { id: "s31", name: "Monir Hossain", outlet: 4, job: "Line cook", kind: "expat", basic: 9200, hourly: 54, joined: "2025-03-16", mrps: false, ot: true, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s32", name: "Shahin Islam", outlet: 4, job: "Barista", kind: "expat", basic: 8300, hourly: 49, joined: "2021-04-19", mrps: false, ot: true, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s33", name: "Selvam Kumar", outlet: 6, job: "Host", kind: "expat", basic: 7000, hourly: 40, joined: "2022-05-22", mrps: false, ot: true, svc: true, sex: "m", type: "contract", photo: "" },
    { id: "s34", name: "Ruwan Silva", outlet: 6, job: "Kitchen porter", kind: "expat", basic: 6600, hourly: 38, joined: "2023-06-25", mrps: false, ot: true, svc: true, sex: "m", type: "contract", photo: "" },
    { id: "s35", name: "Chaminda Perera", outlet: 7, job: "Runner", kind: "expat", basic: 7000, hourly: 41, joined: "2024-07-01", mrps: false, ot: true, svc: true, sex: "m", type: "contract", photo: "" },
    { id: "s36", name: "Bikash Thapa", outlet: 2, job: "Prep cook", kind: "expat", basic: 8700, hourly: 51, joined: "2025-08-04", mrps: false, ot: true, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s37", name: "Dipesh Rai", outlet: 3, job: "Waiter", kind: "expat", basic: 6900, hourly: 40, joined: "2021-09-07", mrps: false, ot: true, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s38", name: "Sujan Gurung", outlet: 3, job: "Waiter", kind: "expat", basic: 7400, hourly: 43, joined: "2022-10-10", mrps: false, ot: true, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s39", name: "Farid Ahmed", outlet: 3, job: "Commis", kind: "expat", basic: 7400, hourly: 43, joined: "2023-11-13", mrps: false, ot: true, svc: true, sex: "m", type: "contract", photo: "" },
    { id: "s40", name: "Nazrul Hoque", outlet: 4, job: "Steward", kind: "expat", basic: 7400, hourly: 44, joined: "2024-12-16", mrps: false, ot: true, svc: true, sex: "m", type: "contract", photo: "" },
    { id: "s41", name: "Kamal Uddin", outlet: 4, job: "Line cook", kind: "expat", basic: 8600, hourly: 50, joined: "2025-01-19", mrps: false, ot: true, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s42", name: "Prakash Nair", outlet: 4, job: "Barista", kind: "expat", basic: 7700, hourly: 45, joined: "2021-02-22", mrps: false, ot: true, svc: true, sex: "m", type: "fulltime", photo: "" },
    { id: "s43", name: "Tharindu Fernando", outlet: 6, job: "Host", kind: "expat", basic: 7600, hourly: 44, joined: "2022-03-25", mrps: false, ot: true, svc: true, sex: "m", type: "contract", photo: "" },
    { id: "s44", name: "Milan Shrestha", outlet: 6, job: "Kitchen porter", kind: "expat", basic: 7200, hourly: 42, joined: "2023-04-01", mrps: false, ot: true, svc: true, sex: "m", type: "contract", photo: "" },
    { id: "s45", name: "Rakib Hasan", outlet: 7, job: "Runner", kind: "expat", basic: 6400, hourly: 37, joined: "2024-05-04", mrps: false, ot: true, svc: true, sex: "m", type: "contract", photo: "" },
    { id: "s46", name: "Sanjay Pillai", outlet: 2, job: "Prep cook", kind: "expat", basic: 8100, hourly: 47, joined: "2025-06-07", mrps: false, ot: true, svc: true, sex: "m", type: "fulltime", photo: "" }
  ];

  // Statutory rates. Every one of these is DATA, never a constant in code, so a
  // change of law is an UPDATE. Verify with the chain's accountant before use.
  var PAYROLL_RULES = {
    mrps_employee: 0.07, mrps_employer: 0.07,
    week_hours: 48, ot_weekday: 1.25, ot_holiday: 1.5,
    service_charge_distributable: 0.99,
    // The roster below is the salaried management sample the prototype ships.
    // The chain employs this many people in total, and the service charge must
    // be divided equally among ALL of them — so the per-head share is computed
    // against the real headcount, not against the sample.
    total_headcount: 46,
    ramadan_allowance: 3000,
    // Employee withholding tax, monthly bands (Income Tax Act 25/2019).
    // Taxable base is gross remuneration AFTER the employee's MRPS deduction.
    wht_bands: [[60000, 0], [100000, 0.055], [150000, 0.08], [200000, 0.12], [Infinity, 0.15]],
    min_wage_small: 4500, min_wage_medium: 6000, min_wage_large: 8000
  };

  // ── Operating costs: the half of the P&L a POS usually ignores ────────────
  var OPEX = [
    { id: "e1", cat: "Rent", vendor: "Chaandhanee Magu Holdings", outlet: 3, amt: 62000, freq: "monthly", due: 1, acct: "6100" },
    { id: "e2", cat: "Rent", vendor: "MACL Concession", outlet: 4, amt: 88000, freq: "monthly", due: 1, acct: "6100" },
    { id: "e3", cat: "Rent", vendor: "Maafushi Council Lease", outlet: 6, amt: 34000, freq: "monthly", due: 5, acct: "6100" },
    { id: "e4", cat: "Electricity", vendor: "STELCO", outlet: 3, amt: 19400, freq: "monthly", due: 12, acct: "6200" },
    { id: "e5", cat: "Electricity", vendor: "STELCO", outlet: 4, amt: 26800, freq: "monthly", due: 12, acct: "6200" },
    { id: "e6", cat: "Electricity", vendor: "FENAKA", outlet: 6, amt: 21200, freq: "monthly", due: 12, acct: "6200" },
    { id: "e7", cat: "Water & sewerage", vendor: "MWSC", outlet: 3, amt: 4600, freq: "monthly", due: 15, acct: "6200" },
    { id: "e8", cat: "Cooking gas", vendor: "Villa Gas", outlet: 3, amt: 8900, freq: "monthly", due: 20, acct: "6200" },
    { id: "e9", cat: "Cooking gas", vendor: "Villa Gas", outlet: 6, amt: 7400, freq: "monthly", due: 20, acct: "6200" },
    { id: "e10", cat: "Internet & phone", vendor: "Dhiraagu", outlet: 0, amt: 6800, freq: "monthly", due: 8, acct: "6300" },
    { id: "e11", cat: "Licences & permits", vendor: "Ministry of Economic Development", outlet: 0, amt: 14000, freq: "annual", due: 28, acct: "6400" },
    { id: "e12", cat: "Work permit & quota", vendor: "Ministry of Homeland Security", outlet: 0, amt: 22500, freq: "annual", due: 28, acct: "6400" },
    { id: "e13", cat: "Insurance", vendor: "Allied Insurance", outlet: 0, amt: 9600, freq: "annual", due: 18, acct: "6400" },
    { id: "e14", cat: "Waste collection", vendor: "WAMCO", outlet: 3, amt: 3200, freq: "monthly", due: 25, acct: "6200" },
    { id: "e15", cat: "Freight & ferry", vendor: "MTCC Cargo", outlet: 6, amt: 12600, freq: "monthly", due: 22, acct: "6300" },
    { id: "e16", cat: "Staff accommodation", vendor: "Hulhumale Housing", outlet: 0, amt: 31000, freq: "monthly", due: 3, acct: "6100" },
    { id: "e17", cat: "Software & POS", vendor: "KashikeyoPOS", outlet: 0, amt: 5400, freq: "monthly", due: 1, acct: "6300" },
    { id: "e18", cat: "Bank & card fees", vendor: "Bank of Maldives", outlet: 0, amt: 11800, freq: "monthly", due: 30, acct: "6300" }
  ];

  // ── Equipment: a breakdown is a maintenance cost AND a stock write-off ────
  var ASSETS = [
    { id: "a1", name: "Walk-in chiller", outlet: 3, kind: "Refrigeration", bought: "2021-04-10", cost: 185000, life: 10, lastSvc: "2026-06-12", svcDays: 90, status: "ok", ytd: 4200 },
    { id: "a2", name: "Blast freezer", outlet: 2, kind: "Refrigeration", bought: "2020-09-02", cost: 240000, life: 10, lastSvc: "2026-05-02", svcDays: 90, status: "due", ytd: 9800 },
    { id: "a3", name: "6-burner range", outlet: 3, kind: "Cooking", bought: "2021-04-10", cost: 96000, life: 8, lastSvc: "2026-07-01", svcDays: 180, status: "ok", ytd: 1800 },
    { id: "a4", name: "Double fryer", outlet: 4, kind: "Cooking", bought: "2022-01-22", cost: 54000, life: 6, lastSvc: "2026-04-18", svcDays: 120, status: "due", ytd: 6400 },
    { id: "a5", name: "Combi oven", outlet: 2, kind: "Cooking", bought: "2019-11-15", cost: 310000, life: 12, lastSvc: "2026-06-28", svcDays: 120, status: "ok", ytd: 12400 },
    { id: "a6", name: "Ice machine", outlet: 6, kind: "Refrigeration", bought: "2023-03-08", cost: 72000, life: 8, lastSvc: "2026-03-30", svcDays: 90, status: "down", ytd: 15200 },
    { id: "a7", name: "Dishwasher", outlet: 3, kind: "Warewash", bought: "2022-08-19", cost: 88000, life: 8, lastSvc: "2026-06-20", svcDays: 120, status: "ok", ytd: 3100 },
    { id: "a8", name: "Espresso machine", outlet: 3, kind: "Beverage", bought: "2024-02-14", cost: 128000, life: 7, lastSvc: "2026-07-10", svcDays: 60, status: "ok", ytd: 2400 },
    { id: "a9", name: "Split AC ×4", outlet: 4, kind: "Climate", bought: "2022-01-22", cost: 116000, life: 8, lastSvc: "2026-02-15", svcDays: 90, status: "due", ytd: 8700 },
    { id: "a10", name: "Generator 40kVA", outlet: 6, kind: "Power", bought: "2023-03-08", cost: 265000, life: 15, lastSvc: "2026-05-25", svcDays: 180, status: "ok", ytd: 5600 },
    { id: "a11", name: "Chest freezer ×3", outlet: 1, kind: "Refrigeration", bought: "2020-02-11", cost: 96000, life: 10, lastSvc: "2026-06-05", svcDays: 120, status: "ok", ytd: 2900 },
    { id: "a12", name: "Delivery scooter ×2", outlet: 3, kind: "Vehicle", bought: "2024-06-30", cost: 78000, life: 5, lastSvc: "2026-07-15", svcDays: 60, status: "ok", ytd: 4800 }
  ];

  ACCOUNTS.push(
    { code: "1500", name: "Equipment at cost", type: "Asset" },
    { code: "1510", name: "Accumulated depreciation", type: "Liability" },
    { code: "2400", name: "Service charge payable", type: "Liability" },
    { code: "2500", name: "MRPS pension payable", type: "Liability" },
    { code: "2600", name: "Employee withholding tax payable", type: "Liability" },
    { code: "5300", name: "Wages & salaries", type: "Expense" },
    { code: "5310", name: "Employer pension contribution", type: "Expense" },
    { code: "5400", name: "Repairs & maintenance", type: "Expense" },
    { code: "5500", name: "Depreciation", type: "Expense" },
    { code: "6100", name: "Rent & premises", type: "Expense" },
    { code: "6200", name: "Utilities", type: "Expense" },
    { code: "6300", name: "Administration", type: "Expense" },
    { code: "6400", name: "Licences & insurance", type: "Expense" }
  );

  /* ── Live hydration ───────────────────────────────────────────────────────
     When the server injects window.KPOS_REAL (a real back-office session), the
     seeded menu / categories / outlet tax are replaced with the store's actual
     data. Everything else (roles, module map, chain spec) stays as the platform
     definition. With no session the seeds render, so the design still previews. */
  var REAL = window.KPOS_REAL;
  // Gate the real-data overlay on the SESSION, not on the menu being non-empty.
  // A freshly-onboarded store with no menu yet still gets its real (empty) data —
  // otherwise the whole baked demo dataset (menu, customers, inventory, KDS)
  // leaked onto a real empty store and every stat read off fake numbers.
  if (REAL) {
    var CAT_ICON = { starters: "starter", mains: "main", grill: "grill", rice: "rice",
      sides: "side", desserts: "dessert", drinks: "drink", coffee: "drink", beverages: "drink" };
    MENU_CATEGORIES = (REAL.categories || []).map(function (c) {
      // subs = the category's ordered SUBCATEGORY names (the third taxonomy
      // level). Empty for a store that has never used one, which renders as the
      // flat category it always was.
      return { id: c.id, name: c.name, group: c.group || "", subs: (c.subs || []).slice(), icon: CAT_ICON[c.id] || "main" };
    });
    MENU_GROUPS = (REAL.groups || []);
    // Full group palette for the category manager (the four canonical groups
    // plus any custom in use), so a section can move to a group nothing sits in.
    MENU_GROUP_PALETTE = (REAL.groupPalette && REAL.groupPalette.length) ? REAL.groupPalette : (REAL.groups || []);
    var CAT_GROUP = {};
    MENU_CATEGORIES.forEach(function (c) { CAT_GROUP[c.id] = c.group; });
    MENU = (REAL.menu || []).map(function (m) {
      return { id: m.id, cat: m.cat, subcat: m.subcat || "", group: CAT_GROUP[m.cat] || "", name: m.name, desc: m.desc || "", price: Number(m.price) || 0,
        veg: !!m.veg, img: m.img || "", recipe: m.recipe || [], hidden: !!m.hidden, addons: m.addons || [], bestSeller: !!m.bestSeller, soldOut: !!m.soldOut };
    });
    if (REAL.customers) CUSTOMERS = REAL.customers;   // Customers & credit — real accounts
    if (REAL.staff && REAL.staff.length) USERS = REAL.staff;  // Sign-in roster — real staff (real PINs)

    /* Real mode carries NO seeded back-office data. Inventory, vendors,
       purchases, indents, dispatches, production, batches, operating costs,
       assets and payroll-staff all start from the real backend — empty for a
       store that hasn't entered them yet, and filled only from actual records
       (via /api/inv and /api/ops). This is what removes the demo dataset. */
    ["items", "inv", "cats", "batches", "vendors", "purch", "reqs", "disp", "prod", "logs"]
      .forEach(function (k) { if (R && typeof R === "object") R[k] = []; });
    // Real ingredient stock replaces the cleared inventory arrays. items/inv/cats
    // are projected from the ingredients table (see buildV2RealForOrg); the other
    // supply-chain arrays stay empty until their own records exist.
    if (REAL.inventory && R && typeof R === "object") {
      R.items = REAL.inventory.items || [];
      R.inv = REAL.inventory.inv || [];
      R.cats = REAL.inventory.cats || [];
      R.ledger = REAL.inventory.ledger || [];
      R.vendors = REAL.inventory.vendors || [];
      R.purch = REAL.inventory.purch || [];
    }
    OPEX = (REAL.expenses || []); ASSETS = (REAL.assets || []);
    // The HR/payroll roster is the real sign-in staff. Contract wage fields are
    // left unset (basic 0) until an admin configures them — so labour HOURS are
    // real from clock punches while labour COST stays an honest zero, and each
    // person still shares real service charge. They map to the primary outlet
    // (id 3) so clock and labour attribute to the trading floor.
    STAFF = (REAL.staff || []).map(function (u) {
      return { id: u.id, name: u.name, job: u.role || "Staff", outlet: 3,
        kind: "local", basic: 0, ot: true, svc: true, mrps: false, joined: "",
        status: u.status || "Active" };
    });
    if (REAL.outlet) CHAIN.currency = REAL.outlet.currency || CHAIN.currency;
    // Real merchant branding → the chain brand the guest storefront + receipts
    // read, so the QR page wears the store's own name/tagline/logo/footer and
    // white-label, not the demo "KASHIKEYO" fascia. whiteLabel drops the
    // powered-by line (poweredBy=false).
    if (REAL.brand) {
      CHAIN.brand = Object.assign({}, CHAIN.brand, {
        name: REAL.brand.name || CHAIN.brand.name,
        tagline: REAL.brand.tagline || "",
        logo: REAL.brand.logo || "",
        accent: REAL.brand.accent || "",
        receiptFoot: REAL.brand.footer || CHAIN.brand.receiptFoot,
        poweredBy: !REAL.brand.whiteLabel,
      });
    }
    if (REAL.fiscal) {
      CHAIN.name = REAL.fiscal.legalName || (REAL.brand && REAL.brand.name) || CHAIN.name;
      CHAIN.tin = REAL.fiscal.tin || "";
    }
    if (REAL.outlets && REAL.outlets.length) {
      // Real chain: the org's own stores replace the seeded outlet list. The
      // primary store carries id 3 (the terminal default), so the floor, ticket
      // engine and stat couplings keep working against real outlets.
      OUTLETS = REAL.outlets;
      // The primary outlet wears the trading name, so a Merchant-branding rename
      // shows on the storefront's outlet line / picker immediately — even before
      // the stores-table row has caught up. Named branches keep their own names.
      if (REAL.outlet && REAL.outlet.name) {
        var primaryO = null;
        for (var oi = 0; oi < OUTLETS.length; oi++) { if (OUTLETS[oi].id === 3) { primaryO = OUTLETS[oi]; break; } }
        if (!primaryO) primaryO = OUTLETS[0];
        if (primaryO) primaryO.name = REAL.outlet.name;
      }
    } else if (REAL.outlet) {
      // Fallback (no stores row): rename + retax the default trading outlet.
      OUTLETS.forEach(function (o) {
        if (o.id === 3) {
          o.name = REAL.outlet.name || o.name;
          o.tax = REAL.outlet.tax || o.tax;
          if (REAL.outlet.rate != null) o.rate = REAL.outlet.rate;
          if (REAL.outlet.sc != null) o.sc = REAL.outlet.sc;
        }
      });
    }
  }

  window.KPOS = {
    CHAIN: CHAIN, OUTLETS: OUTLETS, MENU: MENU, MENU_CATEGORIES: MENU_CATEGORIES, MENU_GROUPS: MENU_GROUPS, MENU_GROUP_PALETTE: MENU_GROUP_PALETTE,
    MODULES: MODULES, ROLES: ROLES, USERS: USERS, CUSTOMERS: CUSTOMERS,
    STAFF: STAFF, PAYROLL_RULES: PAYROLL_RULES, OPEX: OPEX, ASSETS: ASSETS,
    ROLE_PINS: ROLE_PINS,
    JWT_CLAIM: JWT_CLAIM, RLS_SQL: RLS_SQL, ERD: ERD,
    RAILWAY: RAILWAY, RAILWAY_NOTES: RAILWAY_NOTES, ACCOUNTS: ACCOUNTS,
    RAW: R, HERO: IMG("hero")
  };
  window.dispatchEvent(new Event("kpos-data-ready"));
})();
