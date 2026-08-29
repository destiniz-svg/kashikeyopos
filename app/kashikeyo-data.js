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
  //
  // `at` is a threshold in POINTS. It used to hold spend-scale figures while
  // being measured in points, so every member sat in Bronze while their row
  // claimed Platinum — and the phone ranked on lifetime SPEND against a third
  // set of thresholds again, so the same guest could read Platinum on their
  // phone and Bronze at the counter. One ladder, in one unit.
  //
  // `spend` is the lifetime-goods equivalent, carried for the copy that quotes
  // it to a guest. It is not a second way to rank: ranking is on points.
  var TIERS = [
    { key: "bronze", name: "Bronze", at: 0, spend: 0, mark: "III", from: "#8a6a4f", to: "#5d4632" },
    { key: "silver", name: "Silver", at: 500, spend: 5000, mark: "II", from: "#7c8290", to: "#4c515c" },
    { key: "gold", name: "Gold", at: 1500, spend: 15000, mark: "I", from: "#b8862f", to: "#7d5a17" },
    { key: "platinum", name: "Platinum", at: 3000, spend: 30000, mark: "\u2605", from: "#3c3f46", to: "#16171b" }
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

  /* THE SEVEN ROLES ARE PRESENTATIONS OF THE FIVE RANKS, and nothing else.
     The key is a wire value — src/auth.js carries it in the session and maps
     it back to a rank — so the keys stay whatever they were named on the day.
     The label and the blurb are what a person reads, and they described a
     product that was deleted: a platform above chains, a role whose token
     omitted a chain_id column that exists nowhere, an outlet "reading the chain
     menu master". An install holds ONE company; a session names ONE outlet.

     `scope` has two values because the server has two: `outlet` is every
     session, and `group` is the rank-5 estate read (src/auth.js groupScope,
     honoured at rank 5 and silently downgraded below it). */
  var ROLES = [
    {
      key: "SuperAdmin", label: "Owner", color: "#a88ad9", scope: "group",
      blurb: "Owns the business. The only rank that reads the estate figure across outlets, reopens a filed month, registers for GST or renames the store address.",
      perms: (function () { var o = {}; MODULES.forEach(function (m) { o[m.key] = ALL; }); return o; })()
    },
    {
      key: "ChainAdmin", label: "Administrator", color: "#f2a43a", scope: "outlet",
      blurb: "Settings, staff, roles, devices and the floor plan \u2014 how the outlet is configured, rather than what it takes today.",
      perms: (function () { var o = {}; MODULES.forEach(function (m) { o[m.key] = m.key === "architecture" ? V : ALL; }); o.analytics = V; return o; })()
    },
    {
      key: "OutletManager", label: "Outlet Manager", color: "#2e7d32", scope: "outlet",
      blurb: "Voids after fire, discounts, refunds, prices a delivery, closes the day and the month.",
      perms: perms({ pos: ALL, kds: VAE, reservations: ALL, customers: VAE, orders: VAE, delivery: VAE, promos: VAE, chain: V, branches: V, menu: V, inventory: V, ledger: V, counts: VAE, requests: VAE, dispatches: VAE, batches: V, reports: V, accounting: V, sync: V, settings: V, logs: V, staff: VAE, costs: V, assets: VAE })
    },
    {
      key: "Cashier", label: "Cashier / Waiter", color: "#0074D9", scope: "outlet",
      blurb: "Sells, settles, voids before fire, 86s a dish and signs for a delivery. Never sees cost or margin, and never prices what it receives.",
      perms: perms({ pos: VAE, reservations: VAE, customers: VA, orders: VA, delivery: VA, promos: V, kds: V, purchases: VA, counts: VA, inventory: V, ledger: V, batches: V, vendors: V })
    },
    {
      key: "KitchenManager", label: "Kitchen", color: "#e65100", scope: "outlet",
      blurb: "The pass. Bumps a line, moves an order through the kitchen, keeps the recipes and the batches. Sells nothing and settles nothing.",
      perms: perms({ kds: VAE, pos: V, production: VAE, recipes: VAE, requests: VAE, dispatches: VAE, consumption: VAE, inventory: V, ledger: V, counts: VAE, batches: VAE, menu: V, reports: V, sync: V, staff: V, assets: VAE })
    },
    {
      key: "StoreKeeper", label: "Store Keeper", color: "#67a2d9", scope: "outlet",
      blurb: "Receiving, dispatch, counts and vendors, at the same rung as the till \u2014 the bread arrives before the office does. Pricing the invoice is the manager's second signature.",
      perms: perms({ purchases: VAE, dispatches: VAE, requests: VAE, inventory: V, ledger: V, counts: VAE, batches: VAE, vendors: VAE, reports: V, sync: V, assets: VAE })
    },
    {
      key: "Accountant", label: "Accountant / Auditor", color: "#6bbf7b", scope: "outlet",
      blurb: "The books, the audit trail and the GST figures. It carries a manager's rank, so it can write whatever a manager can \u2014 the screens keep it off the till, the rank does not.",
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
    { code: "2350", name: "Loyalty points liability", type: "Liability", till: true },
    { code: "2400", name: "Net wages payable", type: "Liability" },
    { code: "2450", name: "Tips payable to staff", type: "Liability" },
    { code: "2500", name: "MRPS pension payable", type: "Liability" },
    { code: "2600", name: "Employee withholding tax payable", type: "Liability" },
    { code: "4000", name: "Food & beverage revenue", type: "Revenue", till: true },
    { code: "4100", name: "Delivery revenue", type: "Revenue", till: true },
    // Contra-revenue. Discounts are shown, never netted into 4000: a chain
    // that nets them cannot tell a good month from a heavily discounted one.
    { code: "4200", name: "Discounts & allowances", type: "Revenue", till: true },
    { code: "4900", name: "Cash rounding", type: "Revenue", till: true },
    { code: "5000", name: "Cost of goods sold", type: "Expense" },
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
    { code: "6550", name: "Loyalty points expense", type: "Expense", till: true },
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
  // `minor` is how many decimals the currency has; `cashRound` is what CASH
  // settles to — the rufiyaa to its 50-laari coin, a dollar to nothing.
  // `canBase` marks the currencies a business may keep its books in.
  var CURRENCIES = [
    { code: "MVR", name: "Maldivian rufiyaa", symbol: "MVR", base: true,
      canBase: true, rate: 1, minor: 2, cashRound: 0.5 },
    { code: "USD", name: "US dollar", symbol: "$",
      canBase: true, rate: 15.42, minor: 2, cashRound: 0 },
    { code: "EUR", name: "Euro", symbol: "\u20ac", rate: 16.8, minor: 2, cashRound: 0 },
    { code: "GBP", name: "Pound sterling", symbol: "\u00a3", rate: 19.6, minor: 2, cashRound: 0 }
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

  // The allergen and diet rules are shared with the server, which derives a
  // dish's declaration from the recipe a guest device never holds.
  var RULES = (typeof window !== "undefined" && window.KPOS_RULES) || {};
  var ALLERGENS = RULES.ALLERGENS || [];
  var DIETS = RULES.DIETS || [];

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

  // The data model, as it is actually deployed. Grouped by which belt of
  // isolation guards it: the control plane is shared and guarded by RLS; a
  // per-outlet schema is guarded by not being reachable at all.
  var ERD = [
    {
      group: "Control plane · chain (RLS, FORCE)", color: "#f2a43a",
      tables: [
        { name: "chain.company", rls: "rank 4 writes", cols: ["id pk", "legal_name", "reg_no", "tin", "address", "brand jsonb"] },
        { name: "chain.outlet", rls: "self or group", cols: ["id pk", "code", "schema_name", "db_role", "tax_code", "service_pct", "day_start"] },
        { name: "chain.staff", rls: "own outlet", cols: ["id pk", "name", "rank", "role_key", "pin_hash", "pin_salt", "outlets[]"] },
        { name: "chain.device", rls: "own outlet", cols: ["id pk", "label", "kind", "pair_code", "fingerprint", "revoked"] },
        { name: "chain.session", rls: "own outlet", cols: ["id pk", "staff_id fk", "device_id fk", "rank", "expires_at", "revoked_at"] },
        { name: "chain.tax_version", rls: "own or statute", cols: ["id pk", "outlet_id fk", "code", "rate", "effective_from", "effective_to"] },
        { name: "chain.doc_series", rls: "own outlet", cols: ["outlet_id pk", "kind pk", "prefix", "next_no", "used"] },
        { name: "chain.member", rls: "any outlet", cols: ["id pk", "phone", "points", "tier", "credit_limit"] },
        { name: "chain.supplier", rls: "rank 3 writes", cols: ["id pk", "name", "trn", "terms_days"] },
        { name: "chain.audit", rls: "append only", cols: ["id pk", "at", "outlet_id", "actor", "rank", "device_id", "action", "before jsonb", "after jsonb"] }
      ]
    },
    {
      group: "Service · outlet_N", color: "#7c92f5",
      tables: [
        { name: "zone", rls: "schema", cols: ["id pk", "name", "pos"] },
        { name: "table_def", rls: "schema", cols: ["id pk", "label", "zone_id fk", "seats", "status"] },
        { name: "ticket", rls: "schema", cols: ["id pk", "table_no", "split", "channel", "status", "covers", "party", "business_date"] },
        { name: "ticket_line", rls: "schema", cols: ["id pk", "ticket_id fk", "item_id", "qty", "unit_price", "sent_at", "void_at"] },
        { name: "reservation", rls: "schema", cols: ["id pk", "guest_name", "party", "at", "status", "ticket_id fk"] },
        { name: "kds_ticket", rls: "schema", cols: ["id pk", "ticket_id fk", "station", "stage", "target_mins"] }
      ]
    },
    {
      group: "Money · outlet_N", color: "#34c77b",
      tables: [
        { name: "sale", rls: "no delete", cols: ["id pk", "receipt_no", "business_date", "subtotal", "discount", "net", "service", "tax_rate", "tax", "rounding", "total", "cogs"] },
        { name: "sale_line", rls: "no delete", cols: ["id pk", "sale_id fk", "item_id", "qty", "line_total", "line_cost"] },
        { name: "payment", rls: "no delete", cols: ["id pk", "sale_id fk", "method", "amount", "currency", "fx_rate", "tendered", "change_given"] },
        { name: "credit_note", rls: "no delete", cols: ["id pk", "cn_no", "sale_id fk", "amount", "tax", "reason", "approved_by"] },
        { name: "settlement_batch", rls: "schema", cols: ["id pk", "acquirer", "batch_no", "gross", "mdr_pct", "fee", "net", "variance", "state"] },
        { name: "drawer_session", rls: "schema", cols: ["id pk", "float_amount", "counted", "expected", "variance"] },
        { name: "journal", rls: "no delete", cols: ["id pk", "jv_no", "entry_date", "memo", "source", "posted_by"] },
        { name: "journal_line", rls: "no delete", cols: ["id pk", "journal_id fk", "account_code fk", "dr", "cr"] },
        { name: "account", rls: "schema", cols: ["code pk", "name", "type", "normal_side", "till_owned"] },
        { name: "period", rls: "schema", cols: ["id pk", "starts_on", "ends_on", "state"] },
        { name: "bank_line", rls: "schema", cols: ["id pk", "value_date", "descr", "amount", "state", "matched_account"] }
      ]
    },
    {
      group: "Stock and supply · outlet_N", color: "#a88ad9",
      tables: [
        { name: "ingredient", rls: "schema", cols: ["id pk", "name", "base_unit", "stock_unit", "on_hand", "avg_cost", "par"] },
        { name: "recipe_line", rls: "schema", cols: ["id pk", "item_id fk", "ingredient_id fk", "sub_item_id fk", "qty", "waste_pct"] },
        { name: "stock_move", rls: "immutable", cols: ["id pk", "ingredient_id fk", "qty", "unit_cost", "value", "reason", "sale_id fk"] },
        { name: "batch", rls: "schema", cols: ["id pk", "ingredient_id fk", "lot", "qty", "use_by", "state"] },
        { name: "stock_count", rls: "schema", cols: ["id pk", "by_staff", "variance_value", "state"] },
        { name: "delivery", rls: "schema", cols: ["id pk", "grn_no", "supplier_id", "priced", "net", "tax"] },
        { name: "vendor_invoice", rls: "schema", cols: ["id pk", "supplier_id", "invoice_no", "due_date", "amount", "paid"] },
        { name: "indent", rls: "schema", cols: ["id pk", "pr_no", "to_outlet", "status"] },
        { name: "dispatch", rls: "schema", cols: ["id pk", "dsp_no", "indent_id fk", "status", "value"] }
      ]
    },
    {
      group: "People, costs and replay · outlet_N", color: "#f4553c",
      tables: [
        { name: "employee", rls: "schema", cols: ["id pk", "staff_id", "job", "basic", "hourly", "mrps", "ot", "svc"] },
        { name: "clock_entry", rls: "schema", cols: ["id pk", "employee_id fk", "in_at", "out_at", "business_date"] },
        { name: "payroll_run", rls: "schema", cols: ["id pk", "gross", "pension_ee", "pension_er", "withholding", "net"] },
        { name: "opex", rls: "schema", cols: ["id pk", "category", "amount", "freq", "due_day", "account_code fk"] },
        { name: "asset", rls: "schema", cols: ["id pk", "name", "cost", "bought_on", "life_years", "state"] },
        { name: "op_log", rls: "immutable", cols: ["op_id pk", "kind", "payload jsonb", "client_at", "lamport", "result jsonb"] }
      ]
    }
  ];


  /* RAILWAY and RAILWAY_NOTES lived here and nothing rendered them: the screen
     that was meant to read them expected objects with a name, a kind and a
     port, and these are pairs of strings — so the topology tab drew six blank
     cards. They are deleted rather than repaired because one of them was also
     WRONG: "the owner connection runs migrations and provisioning only, no
     request handler imports it" — six handlers do, deliberately, and the list
     is pinned by a test. Unused copy that carries a false claim is the next
     person's shortcut. What the deployment tab says now is written where it is
     rendered, so the two cannot drift apart again. */

  /* ═══ THE SECTION GLYPH SET ══════════════════════════════════════════════
     One stroke icon per menu section, and it lives HERE rather than in the
     terminal because the guest's phone draws the same plates. Two copies is
     how the allergen table ended up with two key vocabularies — "shellfish"
     in one and "crustacean" in the other — so a diet that blocked one never
     blocked the other. The same file, loaded by both, or a dish's tile means
     one thing at the counter and another on the phone.

     24×24, fill:none, stroke-width 1.15, round caps and joins. */
  var SECTION_GLYPHS = {
    all: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
    starter: "M4 13h16M6.5 13a5.5 5.5 0 0 1 11 0M3 17h18",
    main: "M7 3v7M5 3v4a2 2 0 0 0 4 0V3M7 10v11M17 3c-1.4 1.8-2 3.8-2 6h4M17 9v12",
    grill: "M12 3c3 2.6 4.5 5 4.5 7.5a4.5 4.5 0 0 1-9 0C7.5 9 8.6 7.9 10 7c0 1.8.9 2.7 1.6 2.7.8 0 1.1-1.4 1-2.5-.1-1.6-.6-3-.6-4.2zM5 21h14",
    rice: "M4 11h16a8 8 0 0 1-16 0zM3 21h18M12 4v3M9 6.5V8M15 6.5V8",
    side: "M6 12h12a6 6 0 0 1-12 0zM4 20h16M10 8V5M14 8V6",
    dessert: "M8.5 21h7l1-8h-9zM7 13a5 5 0 0 1 10 0M12 3v2M10.5 5.5h3",
    drink: "M6 4h12l-1.4 9h-9.2zM12 13v6M8.5 19h7M15.5 8h3",
    soup: "M4 11h16a8 8 0 0 1-16 0zM3 21h18M9 3v3M12 2v4M15 3v3",
    salad: "M3 12h18a9 9 0 0 1-18 0zM12 3a4 4 0 0 1 4 4M12 3a4 4 0 0 0-4 4",
    seafood: "M3 12c4-5 14-5 18 0-4 5-14 5-18 0zM17 12h.01M6 8.5 3 6M6 15.5 3 18",
    coffee: "M4 8h12v5a5 5 0 0 1-10 0zM16 9h2a2.5 2.5 0 0 1 0 5h-2M4 21h14",
    /* The typed kinds a Maldivian menu actually has, so a section reads as
       WHAT IT SELLS rather than as generic cutlery: a curry is a bowl with
       steam (not the soup bowl — the steam curls where soup's stands
       straight), breakfast is the pan with the egg in it, the western rail
       is a burger, noodles are the bowl under chopsticks, and a cold drink
       is the tall glass with the straw the drink tumbler is not. */
    curry: "M4 12h16a8 8 0 0 1-16 0zM3 21h18M8.5 8c.8-.8.8-1.6 0-2.4s-.8-1.6 0-2.4M12 8c.8-.8.8-1.6 0-2.4s-.8-1.6 0-2.4M15.5 8c.8-.8.8-1.6 0-2.4s-.8-1.6 0-2.4",
    breakfast: "M10 13m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0M10 13m-2.6 0a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0-5.2 0M17 13h4",
    burger: "M4 10a8 4.8 0 0 1 16 0v.6H4zM3.5 13.6h17M5 16.6h14v1a2.6 2.6 0 0 1-2.6 2.6H7.6A2.6 2.6 0 0 1 5 17.6zM9 7h.01M12.5 6.4h.01",
    noodles: "M4 12h16a8 8 0 0 1-16 0zM3 21h18M7 9.5 17.5 3M10.5 9.5 20 4.5",
    juice: "M7.5 5h9l-1.2 15h-6.6zM13 5l2.6-3M7 10h10"
  };
  /* One hue per section KIND, so the colour says the same thing the glyph
     does: every drinks rail in every store is the drinks teal, every curry
     section the curry maroon. Food kinds sit warm, drinks cool, and the
     hues are tints and strokes (16% washes, half-opacity lines), never text
     — so distinctness matters here and AA does not. */
  var SECTION_ART = {
    all: "#64748b", breakfast: "#b7791f", starter: "#c05621", main: "#b8431d",
    curry: "#8c2f39", grill: "#7f5330", burger: "#9a3412", rice: "#4d6b23",
    noodles: "#67702a", side: "#6a8a2a", salad: "#2f7d4f", soup: "#a8721a",
    seafood: "#2b5a9e", dessert: "#9c2f63", drink: "#1d6b57",
    juice: "#0e7490", coffee: "#5f4025"
  };
  /* One hue per section, by section index — the LAST resort, kept for a page
     holding an older copy of this file. Everything current classifies by
     type through sectionArt() instead. */
  var SECTION_HUES = ["#b8431d", "#1d6b57", "#6f47a8", "#a8721a", "#2b5a9e",
    "#9c2f63", "#4d6b23", "#7f5330"];
  /* THE TYPE DECIDES THE DESIGN. A section is classified from its NAME into
     one kind, and the kind carries both the glyph and the hue — so "Mains &
     Curries" is the curry bowl in curry maroon on the till, the guest's
     phone and the member card alike, and two stores' drinks rails wear the
     same glass. Most specific families first: a name that says "curry" is a
     curry section whatever else it says, and "Cold Beverages" is a juice
     glass, not the generic tumbler. An explicit icon or colour a person
     picked in the section editor always wins over this — the classifier is
     the DEFAULT, never the decision. */
  function sectionArt(name) {
    var t = String(name || "").toLowerCase();
    function pick(k) { return { icon: k, hue: SECTION_ART[k] || SECTION_ART.main }; }
    if (/breakfast|brunch|morning|nashta|egg/.test(t)) return pick("breakfast");
    if (/curry|curries|riha|garudhiya|masala/.test(t)) return pick("curry");
    if (/burger|pizza|pasta|sandwich|submarine|western|wrap/.test(t)) return pick("burger");
    if (/noodle|chow ?mein|goreng/.test(t)) return pick("noodles");
    if (/juice|shake|smoothie|lassi|mojito|beverage|cold drink|soft drink/.test(t)) return pick("juice");
    if (/coffee|\btea\b|hot drink|espresso|latte|sai\b/.test(t)) return pick("coffee");
    if (/seafood|fish|reef|tuna|prawn|crab|lobster|octopus/.test(t)) return pick("seafood");
    if (/soup/.test(t)) return pick("soup");
    if (/salad/.test(t)) return pick("salad");
    if (/dessert|sweet|cake|pudding|ice cream/.test(t)) return pick("dessert");
    if (/grill|bbq|barbecue|tandoor/.test(t)) return pick("grill");
    if (/rice|biryani/.test(t)) return pick("rice");
    if (/side|add-on|extras/.test(t)) return pick("side");
    if (/starter|hedhikaa|short eat|snack|appetiser|appetizer|bites/.test(t)) return pick("starter");
    if (/drink|water/.test(t)) return pick("drink");
    return pick("main");
  }
  // Kept under its old name for every existing caller: the glyph half of the
  // classification above.
  function glyphFor(name) { return sectionArt(name).icon; }

  window.KPOS = {
    ALLERGENS: ALLERGENS, DIETS: DIETS, MEAT_RE: RULES.MEAT_RE,
    CHAIN: CHAIN, OUTLETS: OUTLETS, MENU: MENU,
    MENU_CATEGORIES: MENU_CATEGORIES, MENU_SECTIONS: MENU_SECTIONS,
    SECTION_GLYPHS: SECTION_GLYPHS, SECTION_HUES: SECTION_HUES,
    SECTION_ART: SECTION_ART, sectionArt: sectionArt, glyphFor: glyphFor,
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
    RAW: R, HERO: ""
  };

  /* One implementation, in kashikeyo-rules.js, shared by the till, the guest
     QR app, the member portal AND the server. Everything below is the lookup
     that turns a dish into the ingredient list those rules read.

     A device that HOLDS RECIPES works the declaration out from them. A device
     that does not — a guest phone, deliberately, because a recipe is a cost
     sheet — reads what the outlet published for the dish. Same rules, applied
     where the recipe actually lives. */
  function partsOf(dish) {
    var raw = window.KPOS_RAW || {}, items = raw.items || [];
    return (dish && dish.recipe || []).map(function (r) {
      var it = items.filter(function (x) { return x[0] === r[0]; })[0];
      return it ? { name: it[2], cat: it[1] } : null;
    }).filter(Boolean);
  }
  function keyed(keys) {
    return ALLERGENS.filter(function (a) { return (keys || []).indexOf(a.k) >= 0; });
  }

  window.KPOS.dishAllergens = function (dish) {
    if (!dish) return [];
    var parts = partsOf(dish);
    return keyed(parts.length
      ? RULES.allergenKeys(parts, dish.allergensAdd)
      : (dish.allergens || []));
  };
  window.KPOS.dishHasMeat = function (dish) {
    if (!dish) return false;
    if (dish.veg === true) return false;
    var parts = partsOf(dish);
    // No recipe on this device: a dish is vegetarian only if the outlet SAID
    // so. Silence is not a claim.
    if (!parts.length) return (dish.diets || []).indexOf("veg") < 0;
    return RULES.hasMeat(parts);
  };
  window.KPOS.dishSuits = function (dish, dietKey) {
    var d = DIETS.filter(function (x) { return x.k === dietKey; })[0];
    if (!d) return true;                       // a filter nobody defined filters nothing
    if (!dish) return false;
    var parts = partsOf(dish);
    if (!parts.length) return (dish.diets || []).indexOf(dietKey) >= 0;
    return RULES.dietKeys(parts, dish.allergensAdd, dish.veg).indexOf(dietKey) >= 0;
  };
  window.dispatchEvent(new Event("kpos-data-ready"));
})();
