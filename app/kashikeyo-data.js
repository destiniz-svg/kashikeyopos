/* ═══ KASHIKEYOPOS — STRUCTURE, NOT DATA ════════════════════════════════════
   What ships with the product because it is law or definition, and nothing
   that represents trade.

   A previous rebuild got this wrong in both directions: one kept the seed, so
   a restaurant opened the app and saw another restaurant's tuna; another
   emptied the arrays and left screens that rendered nothing and explained
   nothing. The distinction is that STRUCTURE IS NOT DATA.

   Ships here:  the chart of accounts, the five-rank ladder and the module
                permission matrix, the allergen and diet rules, the payroll
                statute, MVR as base currency, every label and empty state.
   Never here:  outlets, tables, dishes, prices, recipes, vendors, customers,
                staff, assets, costs, tickets, or a demo PIN.

   Everything an outlet actually trades in arrives from its own database at
   sign-in (kashikeyo-api.js -> /api/outlet/:id/bootstrap) and replaces the
   empty arrays below. Until then every screen renders its empty state, which
   names the action that fills it.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  var R = window.KPOS_RAW || {};

  // The chain identity is written at onboarding, step 1. Until then it is
  // blank — not a placeholder company, because a placeholder on a receipt is
  // a false statement to a tax authority.
  var CHAIN = {
    id: "", name: "", country: "MV", currency: "MVR",
    tin: "", regNo: "", hq: "", phone: "", email: "",
    brand: {
      mark: "brand/kashikeyo-mark.png", name: "", tagline: "",
      receiptFoot: "", poweredBy: true, colour: "#982030"
    }
  };

  // Trade. Every one of these is filled from this outlet's own database.
  var OUTLETS = [];
  var MENU = [];
  var MENU_CATEGORIES = [];
  var MENU_SECTIONS = [];
  var BANNERS = [];
  var PROMOS = [];
  var MODIFIERS = [];
  var REWARDS = [];
  var USERS = [];
  var CUSTOMERS = [];
  var STAFF = [];
  var OPEX = [];
  var ASSETS = [];
  var VENDORS = [];
  var LOCATIONS = [];
  var DEVICES = [];

  // A tier ladder is a definition — a name and a threshold — and ships with
  // the product. The members standing on it do not.
  var TIERS = [
    { key: "bronze", name: "Bronze", at: 0, mark: "III", from: "#8a6a4f", to: "#5d4632" },
    { key: "silver", name: "Silver", at: 3000, mark: "II", from: "#7c8290", to: "#4c515c" },
    { key: "gold", name: "Gold", at: 7000, mark: "I", from: "#b8862f", to: "#7d5a17" },
    { key: "platinum", name: "Platinum", at: 15000, mark: "\u2605", from: "#3c3f46", to: "#16171b" }
  ];

  // There are no shipped PINs. A PIN is set per person at onboarding and is
  // hashed with a per-row salt the moment it is set: a shared or visible PIN
  // would make every "who voided this" answer in the audit log a guess.
  var ROLE_PINS = {};

  var MODULES = [
    { key: "pos", label: "POS terminal", group: "Front of house" },
    { key: "kds", label: "Kitchen display", group: "Front of house" },
    { key: "reservations", label: "Reservations", group: "Front of house" },
    { key: "customers", label: "Customers & credit", group: "Front of house" },
    { key: "orders", label: "Orders & receipts", group: "Front of house" },
    { key: "delivery", label: "Delivery & QR orders", group: "Front of house" },
    { key: "promos", label: "Promotions & banners", group: "Front of house" },
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
      perms: perms({ pos: ALL, kds: VAE, reservations: ALL, customers: VAE, orders: VAE, delivery: VAE, promos: VAE, chain: V, branches: V, menu: V, inventory: V, ledger: V, counts: VAE, requests: VAE, dispatches: VAE, batches: V, reports: V, accounting: V, sync: V, settings: V, logs: V, staff: VAE, costs: V, assets: VAE })
    },
    {
      key: "Cashier", label: "Cashier / Waiter", color: "#0074D9", scope: "outlet",
      blurb: "Terminal, and receiving on shift. Never sees cost or margin.",
      perms: perms({ pos: VAE, reservations: VAE, customers: VA, orders: VA, delivery: VA, promos: V, kds: V, purchases: VA, counts: VA, inventory: V, ledger: V, batches: V, vendors: V })
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

  // ── The chart of accounts ─────────────────────────────────────────────────
  // Thirty-five codes, and the codes are LOAD-BEARING: the auto-posting rules,
  // the P&L grouping and the GST return all read them. Do not renumber.
  //
  // `till` marks the accounts a manual journal must REFUSE. The ledger
  // reconciles to the POS by construction, and only stays that way if nobody
  // can hand-key cash, revenue, discount, tax or stock.
  var ACCOUNTS = [
    { code: "1010", name: "Cash on hand", type: "Asset", till: true },
    { code: "1020", name: "Bank \u2014 BML MVR", type: "Asset" },
    { code: "1030", name: "Card settlement receivable", type: "Asset", till: true },
    { code: "1040", name: "Customer credit receivable", type: "Asset", till: true },
    { code: "1200", name: "Inventory \u2014 raw", type: "Asset", till: true },
    { code: "1210", name: "Inventory \u2014 finished", type: "Asset" },
    { code: "1500", name: "Equipment at cost", type: "Asset" },
    { code: "1510", name: "Accumulated depreciation", type: "Liability" },
    { code: "2100", name: "Accounts payable", type: "Liability" },
    { code: "2200", name: "GST payable (GGST/TGST)", type: "Liability", till: true },
    { code: "2300", name: "Service charge payable", type: "Liability" },
    { code: "2450", name: "Tips payable to staff", type: "Liability" },
    { code: "2500", name: "MRPS pension payable", type: "Liability" },
    { code: "2600", name: "Employee withholding tax payable", type: "Liability" },
    { code: "4000", name: "Food & beverage revenue", type: "Revenue", till: true },
    { code: "4100", name: "Delivery revenue", type: "Revenue", till: true },
    // Contra-revenue. Discounts are shown, never netted into 4000: a chain
    // that nets them cannot tell a good month from a heavily discounted one.
    { code: "4200", name: "Discounts & allowances", type: "Revenue", till: true },
    { code: "4900", name: "Cash rounding", type: "Revenue", till: true },
    { code: "5000", name: "Cost of goods sold", type: "Expense", till: true },
    { code: "5100", name: "Wastage & variance", type: "Expense" },
    { code: "5300", name: "Wages & salaries", type: "Expense" },
    { code: "5310", name: "Employer pension contribution", type: "Expense" },
    { code: "5400", name: "Repairs & maintenance", type: "Expense" },
    { code: "5500", name: "Depreciation", type: "Expense" },
    { code: "5600", name: "Bank & card charges", type: "Expense" },
    { code: "5700", name: "Packaging & consumables", type: "Expense" },
    { code: "5800", name: "Delivery commission", type: "Expense" },
    { code: "6100", name: "Rent & premises", type: "Expense" },
    { code: "6200", name: "Utilities", type: "Expense" },
    { code: "6300", name: "Administration", type: "Expense" },
    { code: "6400", name: "Licences & insurance", type: "Expense" },
    { code: "6500", name: "Marketing & promotion", type: "Expense" },
    { code: "6600", name: "Travel & transport", type: "Expense" },
    { code: "6700", name: "Professional & recruitment", type: "Expense" },
    { code: "6800", name: "Cleaning, laundry & upkeep", type: "Expense" }
  ];

  // ── Tax versions ──────────────────────────────────────────────────────────
  // A version is LAW, not a figure: a rate change next year must not restate a
  // return that was already filed, so every rate that has ever been in force
  // ships with the date it took effect. `none` is a real answer — a business
  // that is not GST-registered charges nothing, and turning that into 8%
  // because `0 || 8` is falsy is a bug we refuse to ship.
  var TAX_VERSIONS = [
    { code: "TGST", rate: 3.5, from: "2011-01-01", to: "2011-12-31", ref: "Act 10/2011" },
    { code: "TGST", rate: 6, from: "2012-01-01", to: "2012-12-31", ref: "Act 10/2011" },
    { code: "TGST", rate: 8, from: "2013-01-01", to: "2014-10-31", ref: "Act 10/2011" },
    { code: "TGST", rate: 12, from: "2014-11-01", to: "2022-12-31", ref: "Act 10/2011" },
    { code: "TGST", rate: 16, from: "2023-01-01", to: null, ref: "Act 25/2022" },
    { code: "GGST", rate: 3.5, from: "2011-10-02", to: "2011-12-31", ref: "Act 10/2011" },
    { code: "GGST", rate: 6, from: "2012-01-01", to: "2022-12-31", ref: "Act 10/2011" },
    { code: "GGST", rate: 8, from: "2023-01-01", to: null, ref: "Act 25/2022" },
    { code: "NONE", rate: 0, from: "2011-01-01", to: null, ref: "Not registered for GST" }
  ];

  // MVR is the book currency and change is always given in rufiyaa. The rates
  // here are a starting point an outlet edits; the currency LIST is structure.
  var CURRENCIES = [
    { code: "MVR", name: "Maldivian rufiyaa", symbol: "MVR", base: true, rate: 1 },
    { code: "USD", name: "US dollar", symbol: "$", rate: 15.42 },
    { code: "EUR", name: "Euro", symbol: "\u20ac", rate: 16.8 },
    { code: "GBP", name: "Pound sterling", symbol: "\u00a3", rate: 19.6 }
  ];

  var UNITS = [
    { code: "g", name: "gram", base: "g", factor: 1 },
    { code: "kg", name: "kilogram", base: "g", factor: 1000 },
    { code: "ml", name: "millilitre", base: "ml", factor: 1 },
    { code: "l", name: "litre", base: "ml", factor: 1000 },
    { code: "pcs", name: "piece", base: "pcs", factor: 1 },
    { code: "doz", name: "dozen", base: "pcs", factor: 12 },
    { code: "box", name: "box", base: "pcs", factor: 1 },
    { code: "pkt", name: "packet", base: "pcs", factor: 1 },
    { code: "btl", name: "bottle", base: "pcs", factor: 1 },
    { code: "can", name: "can", base: "pcs", factor: 1 }
  ];

  // Document series definitions and their numbering rule. A series, once it
  // has issued a number, cannot be renumbered.
  var DOC_SERIES = [
    { kind: "SALE", label: "Sales receipt", suffix: "R" },
    { kind: "CN", label: "Credit note", suffix: "CN" },
    { kind: "PO", label: "Purchase order", suffix: "PO" },
    { kind: "GRN", label: "Goods received note", suffix: "GRN" },
    { kind: "PR", label: "Indent / purchase request", suffix: "PR" },
    { kind: "DSP", label: "Dispatch note", suffix: "DSP" },
    { kind: "JV", label: "Journal voucher", suffix: "JV" }
  ];

  var EXPENSE_CATEGORIES = ["Rent & premises", "Utilities", "Administration",
    "Licences & insurance", "Marketing & promotion", "Travel & transport",
    "Professional & recruitment", "Cleaning, laundry & upkeep",
    "Packaging & consumables", "Repairs & maintenance", "Bank & card charges",
    "Delivery commission"];

  var COUNT_FREQUENCIES = ["daily", "weekly", "fortnightly", "monthly", "quarterly"];

  // Reason codes. A void, a discount or a write-off without a reason is
  // unauditable, so the list is part of the product.
  var REASONS = {
    waste: ["Spoiled", "Expired", "Dropped", "Over-prepped", "Returned by guest",
      "Staff meal", "Training", "Damaged in transit"],
    "void": ["Wrong item rung", "Guest changed mind", "Kitchen out of stock",
      "Quality issue", "Duplicate line", "Training"],
    discount: ["Manager approval", "Loyalty reward", "Promotion",
      "Service recovery", "Staff meal", "Corporate rate"]
  };

  var STATIONS = ["main", "grill", "cold", "bar", "dessert", "expo"];

  // Reconciliation has three outcomes, never two: an exact hit inside
  // tolerance clears itself, a near miss becomes a proposal a human accepts or
  // rejects, and anything else stays unexplained — which is the point.
  var RECON = { exactMvr: 1, nearPct: 3, nearDays: 2 };

  var ACQUIRERS = [
    { acquirer: "BML", scheme: "Visa/Mastercard", mdrPct: 2.5, settleDays: 1 },
    { acquirer: "MIB", scheme: "Visa/Mastercard", mdrPct: 2.5, settleDays: 1 },
    { acquirer: "Ooredoo m-Faisaa", scheme: "Wallet", mdrPct: 1.5, settleDays: 1 },
    { acquirer: "Dhiraagu Pay", scheme: "Wallet", mdrPct: 1.5, settleDays: 1 }
  ];

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

  var ALLERGENS = [
    { k: "dairy", label: "Dairy", icon: "M8 2h8l-1 4v14H9V6z", cat: [3], re: /MILK|CREAM|CHEESE|BUTTER|YOGH|GHEE|PANEER|MOZZAR|PARMES|CHEDDAR|MASCARP|CUSTARD/i },
    { k: "gluten", label: "Gluten", icon: "M12 3v18M12 7c-3-2-5 0-5 0s2 3 5 1M12 12c3-2 5 0 5 0s-2 3-5 1", re: /FLOUR|BREAD|PASTA|NOODLE|WHEAT|CRUMB|BUN|ROTI|CHAPATI|PASTRY|BATTER|SEMOL|COUSCOUS|BARLEY|BISCUIT|CRACKER/i },
    { k: "fish", label: "Fish", icon: "M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6zM17 11h.01", re: /FISH|TUNA|SNAPPER|REEF|SALMON|ANCHOV|SARDIN|MAAS|GARUDHIY|COD/i },
    { k: "shellfish", label: "Shellfish", icon: "M12 3a7 7 0 0 0-7 7c0 5 7 11 7 11s7-6 7-11a7 7 0 0 0-7-7z", re: /PRAWN|SHRIMP|CRAB|LOBSTER|SQUID|OCTOPUS|CALAMAR|CLAM|MUSSEL|OYSTER/i },
    { k: "egg", label: "Egg", icon: "M12 2c-4 5-6 8-6 12a6 6 0 0 0 12 0c0-4-2-7-6-12z", re: /\bEGG|MAYON|MERINGUE|AIOLI/i },
    { k: "nuts", label: "Tree nuts", icon: "M12 2C8 6 6 9 6 13a6 6 0 0 0 12 0c0-4-2-7-6-11zM12 8v8", re: /CASHEW|ALMOND|WALNUT|PISTACH|HAZELNUT|PECAN|MACADAM|\bNUT\b|NUTS\b/i },
    { k: "peanut", label: "Peanut", icon: "M9 4a4 4 0 1 0 0 8 4 4 0 1 0 0 8 4 4 0 1 0 6-3 4 4 0 1 0-6-3z", re: /PEANUT|GROUNDNUT/i },
    { k: "soy", label: "Soy", icon: "M4 12c4-8 12-8 16 0-4 8-12 8-16 0z", re: /\bSOY|SOYA|TOFU|EDAMAME|MISO|TERIYAKI/i },
    { k: "sesame", label: "Sesame", icon: "M12 4v16M6 8v8M18 8v8", re: /SESAME|TAHINI/i },
    { k: "mustard", label: "Mustard", icon: "M7 3h10l-1 18H8z", re: /MUSTARD/i },
    { k: "sulphite", label: "Sulphites", icon: "M12 3l9 16H3z", re: /WINE|VINEGAR|DRIED FRUIT|SULPH/i }
  ];
  var DIETS = [
    { k: "veg", label: "Vegetarian", blocks: ["fish", "shellfish"], meat: true },
    { k: "vegan", label: "Vegan", blocks: ["fish", "shellfish", "dairy", "egg"], meat: true },
    { k: "gf", label: "No gluten", blocks: ["gluten"] },
    { k: "nutfree", label: "No nuts", blocks: ["nuts", "peanut"] },
    { k: "dairyfree", label: "No dairy", blocks: ["dairy"] }
  ];
  var MEAT_RE = /BEEF|CHICKEN|MUTTON|LAMB|PORK|BACON|SAUSAGE|HAM\b|TURKEY|DUCK|MEAT/i;

  // ── What this system actually is ──────────────────────────────────────────
  // The Architecture screen reads these. They describe the deployed design, so
  // that a screen claiming to explain the system is not describing a different
  // one.
  var JWT_CLAIM = [
    '{',
    '  "o":   1,                      // outlet id — the ONLY outlet this token reaches',
    '  "r":   3,                      // rank: Kitchen 1 · Till 2 · Manager 3 · Admin 4 · Owner 5',
    '  "s":   "9f3a…",                // chain.staff.id — who every action is attributed to',
    '  "rk":  "OutletManager",        // permission-catalogue key the terminal reads',
    '  "d":   "0a8a…",                // chain.device.id — a device is attributable or it takes no money',
    '  "sid": "b71c…",                // chain.session.id, revocable from Users & roles',
    '  "exp": 1787293602687',
    '}',
    '',
    '// The outlet in the path must equal the outlet in the token, and the server',
    '// refuses a mismatch. Scope "group" is honoured only at rank 5.'
  ];

  var RLS_SQL = [
    '-- Two belts. The first is that each outlet connects as its OWN login role,',
    '-- granted USAGE on its own schema alone: another outlet\'s tables are',
    '-- unreachable, not merely filtered. The second is RLS on the shared',
    '-- control plane.',
    '',
    'CREATE OR REPLACE FUNCTION app.current_outlet() RETURNS int',
    '  LANGUAGE sql STABLE AS $$',
    '  SELECT nullif(current_setting(\'app.outlet_id\', true), \'\')::int $$;',
    '',
    '-- Group scope is the ONE way to see across outlets: rank 5, read-only, and',
    '-- stamped on every row it touches in chain.audit.',
    'CREATE OR REPLACE FUNCTION app.group_scope() RETURNS boolean',
    '  LANGUAGE sql STABLE AS $$',
    '  SELECT coalesce(current_setting(\'app.scope\', true) = \'group\', false)',
    '     AND app.current_rank() >= 5 $$;',
    '',
    '-- FORCE matters: without it the table owner bypasses every policy, and',
    '-- migrations run as the owner.',
    'ALTER TABLE chain.staff ENABLE ROW LEVEL SECURITY;',
    'ALTER TABLE chain.staff FORCE  ROW LEVEL SECURITY;',
    '',
    'CREATE POLICY staff_scoped ON chain.staff FOR SELECT',
    '  USING (outlet_id = app.current_outlet()',
    '         OR app.current_outlet() = ANY (outlets)',
    '         OR app.group_scope());',
    '',
    '-- Admin+ may write staff, and never above their own rank: a rank-4 admin',
    '-- cannot mint a rank-5 owner.',
    'CREATE POLICY staff_write ON chain.staff FOR ALL',
    '  USING (outlet_id = app.current_outlet() AND app.current_rank() >= 4',
    '         AND rank <= app.current_rank())',
    '  WITH CHECK (outlet_id = app.current_outlet() AND app.current_rank() >= 4',
    '         AND rank <= app.current_rank());',
    '',
    '-- Request context dies at COMMIT. SET without LOCAL is a cross-tenant leak',
    '-- waiting for load.',
    'SELECT set_config(\'app.outlet_id\', $1, true),',
    '       set_config(\'app.user_rank\', $2, true),',
    '       set_config(\'app.actor\',     $3, true),',
    '       set_config(\'app.scope\',     $4, true);',
    '',
    '-- The audit trail is append-only. There is deliberately no UPDATE and no',
    '-- DELETE policy: a trail that can be edited is not a trail.',
    'CREATE POLICY audit_append ON chain.audit FOR INSERT',
    '  WITH CHECK (outlet_id = app.current_outlet());'
  ];

  var ERD = [
    ["chain.company", "The legal entity. One row. Who files the return."],
    ["chain.outlet", "id, code, schema_name, db_role, tax_code, service_pct"],
    ["chain.staff", "name, rank 1-5, role_key, pin_hash + pin_salt, outlets[]"],
    ["chain.device", "A till, a KDS or a printer, paired and revocable"],
    ["chain.session", "Issued at sign-in, revocable, expires"],
    ["chain.tax_version", "code, rate, effective_from — law, not a figure"],
    ["chain.doc_series", "Numbers allocated under a row lock, per outlet per kind"],
    ["chain.member", "Loyalty is chain-wide: earn here, spend there"],
    ["chain.supplier", "One vendor, many outlets"],
    ["chain.audit", "Append-only. Who, what, when, on which device"],
    ["outlet_N.ticket \u2192 sale", "The floor becomes money"],
    ["sale \u2192 payment", "Tender by method: cash, card, credit, foreign note"],
    ["sale \u2192 stock_move", "Recipe explosion at the moment of sale"],
    ["sale \u2192 journal", "Tender, revenue, discount, service, tax, rounding, COGS"],
    ["journal \u2192 journal_line", "A deferred trigger refuses an unbalanced entry at COMMIT"],
    ["delivery \u2192 vendor_invoice", "Signed for on arrival, PRICED later \u2014 that is what claims input tax"],
    ["op_log", "The client\'s own opId is the primary key. Replay is a no-op."]
  ];

  var RAILWAY = [
    ["Service", "One Node process: the API and the terminal it serves"],
    ["Database", "One Postgres. One schema and one login role per outlet"],
    ["Healthcheck", "/readyz \u2014 ready only when the control plane answers"],
    ["Migrations", "Applied at boot, recorded with a checksum in chain.migration"],
    ["Leak test", "In the deploy pipeline, not in a checklist"],
    ["Secrets", "OUTLET_ROLE_SECRET, SESSION_SECRET, PORTAL_SECRET \u2014 three, deliberately"]
  ];

  var RAILWAY_NOTES = [
    "Per-outlet database passwords are DERIVED from OUTLET_ROLE_SECRET and never stored: nothing readable inside the database yields another outlet\'s credentials.",
    "The owner connection runs migrations and provisioning only. No request handler imports it \u2014 the owner role bypasses both belts of isolation.",
    "A deploy that cannot see its database fails its healthcheck rather than going live.",
    "The terminal has no build step. What ships is the file that was read \u2014 edit it, restart, reload."
  ];


  window.KPOS = {
    ALLERGENS: ALLERGENS, DIETS: DIETS, MEAT_RE: MEAT_RE,
    CHAIN: CHAIN, OUTLETS: OUTLETS, MENU: MENU,
    MENU_CATEGORIES: MENU_CATEGORIES, MENU_SECTIONS: MENU_SECTIONS,
    BANNERS: BANNERS, PROMOS: PROMOS, MODIFIERS: MODIFIERS,
    TIERS: TIERS, REWARDS: REWARDS,
    MODULES: MODULES, ROLES: ROLES, USERS: USERS, CUSTOMERS: CUSTOMERS,
    STAFF: STAFF, PAYROLL_RULES: PAYROLL_RULES, OPEX: OPEX, ASSETS: ASSETS,
    VENDORS: VENDORS, LOCATIONS: LOCATIONS, DEVICES: DEVICES,
    ROLE_PINS: ROLE_PINS,
    ACCOUNTS: ACCOUNTS, TAX_VERSIONS: TAX_VERSIONS, CURRENCIES: CURRENCIES,
    UNITS: UNITS, DOC_SERIES: DOC_SERIES, REASONS: REASONS,
    EXPENSE_CATEGORIES: EXPENSE_CATEGORIES, COUNT_FREQUENCIES: COUNT_FREQUENCIES,
    STATIONS: STATIONS, RECON: RECON, ACQUIRERS: ACQUIRERS,
    JWT_CLAIM: JWT_CLAIM, RLS_SQL: RLS_SQL, ERD: ERD,
    RAILWAY: RAILWAY, RAILWAY_NOTES: RAILWAY_NOTES,
    RAW: R, HERO: ""
  };

  // One implementation, shared by the till, the guest QR app and the member
  // portal. Three copies of an allergen rule is three chances to poison somebody.
  window.KPOS.dishAllergens = function (dish) {
    if (!dish) return [];
    var raw = window.KPOS_RAW || {}, items = raw.items || [];
    var hit = {};
    (dish.recipe || []).forEach(function (r) {
      var it = items.filter(function (x) { return x[0] === r[0]; })[0];
      if (!it) return;
      var name = String(it[2] || ""), cat = it[1];
      ALLERGENS.forEach(function (a) {
        if ((a.cat && a.cat.indexOf(cat) >= 0) || a.re.test(name)) hit[a.k] = 1;
      });
    });
    // A manual addition for something no ingredient list can show — a shared
    // fryer, a dusted worktop. Additive only: nobody may declare an allergen
    // absent that the recipe says is present.
    (dish.allergensAdd || []).forEach(function (k) { hit[k] = 1; });
    return ALLERGENS.filter(function (a) { return hit[a.k]; });
  };
  window.KPOS.dishHasMeat = function (dish) {
    if (!dish) return false;
    if (dish.veg === true) return false;
    var raw = window.KPOS_RAW || {}, items = raw.items || [];
    return (dish.recipe || []).some(function (r) {
      var it = items.filter(function (x) { return x[0] === r[0]; })[0];
      return it && MEAT_RE.test(String(it[2] || ""));
    });
  };
  window.KPOS.dishSuits = function (dish, dietKey) {
    var d = DIETS.filter(function (x) { return x.k === dietKey; })[0];
    if (!d) return true;
    if (d.meat && window.KPOS.dishHasMeat(dish)) return false;
    var have = window.KPOS.dishAllergens(dish).map(function (a) { return a.k; });
    return !d.blocks.some(function (b) { return have.indexOf(b) >= 0; });
  };
  window.dispatchEvent(new Event("kpos-data-ready"));
})();
