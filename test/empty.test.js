'use strict';
/* ═══ ZERO DEMO DATA ════════════════════════════════════════════════════════
   A restaurant opening this app must see its own business and nothing else.
   Previous rebuilds got this wrong in both directions: one kept the seed, so a
   restaurant saw another restaurant's tuna; another emptied the arrays and
   left screens that rendered nothing and explained nothing.

   So this asserts both halves. No demo string reaches the DOM, no figure is
   non-zero, AND every empty state names an action — what is missing, why it
   matters, and the live button that fixes it.
   ═══════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./harness');

const APP = path.join(__dirname, '..', 'app');

/* Every name, number and place from the reference's seeded chain. If any of
   these can be found in the shipped app, the seed came with it. */
const DEMO = [
  'Kashikeyo Chaandhanee', 'Kashikeyo Hulhumalé', 'Kashikeyo Maafushi',
  'Kashikeyo Velana', 'Kashikeyo Baa Atoll', 'Kashikeyo Group',
  'C-0912/2021', '1002345GST501', 'Boduthakurufaanu Magu',
  'Ahmed Shazail', 'Aminath Nashwa', 'Hassan Shifau', 'Mariyam Leena',
  'Fathimath Zoona', 'Ali Rifau', 'Ismail Nabeeh', 'Shifa Adam',
  'Aishath Reesha', 'Ibrahim Nazim', 'Yoosuf Waheed', 'Rahim Uddin',
  'Aishath Rifga', 'Mohamed Zayan', 'Sarah Lindqvist', 'Ibrahim Faisal',
  'Hawwa Nazly', 'Daniel Okafor', 'Aminath Leen', 'Yoosuf Nashid',
  'Adam Saleem', 'Hussain Niyaz', 'Ahmed Sinan', 'Kaafu Eats',
  'General Food Supplies', 'BEEF BECON',
  'Gulha & Bajiya Platter', 'Reef Fish Ceviche', 'Guacamole & Totopos',
  'Birria Dip Toast', 'Beef Tartare', 'Roasted Garlic Soup',
  'Chaandhanee Magu Holdings', 'MACL Concession',
  'accounts@kashikeyo.mv', 'chaandhanee@kashikeyo.mv', 'Ibrahim Nashid'
];

test('no string from the demo set ships in the app', () => {
  const files = ['index.html', 'guest.html', 'member.html',
    'kashikeyo-data.js', 'kashikeyo-raw.js', 'kpos-bridge.js', 'kashikeyo-api.js'];
  const found = [];
  files.forEach((f) => {
    const p = path.join(APP, f);
    if (!fs.existsSync(p)) return;
    const src = fs.readFileSync(p, 'utf8');
    DEMO.forEach((d) => { if (src.indexOf(d) >= 0) found.push(f + ' :: ' + d); });
  });
  assert.deepStrictEqual(found, [], 'demo data shipped: ' + found.join(', '));
});

test('the shipped catalogue is empty, and the shipped structure is not', () => {
  const { win } = H.loadLogic({});
  const K = win.KPOS, R = win.KPOS_RAW;

  // Trade: none of it ships.
  ['OUTLETS', 'MENU', 'MENU_CATEGORIES', 'BANNERS', 'PROMOS', 'MODIFIERS',
    'USERS', 'CUSTOMERS', 'STAFF', 'OPEX', 'ASSETS', 'VENDORS', 'REWARDS']
    .forEach((k) => {
      // strictEqual on the length, not deepStrictEqual on the array: these
      // objects come from the app's own realm and carry that realm's Array
      // prototype, which deepStrictEqual counts as a difference.
      assert.strictEqual(K[k].length, 0, k + ' must ship empty — it is trade, not structure');
    });
  ['items', 'inv', 'ledger', 'batches', 'purch', 'reqs', 'disp', 'prod', 'vendors', 'logs']
    .forEach((k) => {
      assert.strictEqual(R[k].length, 0, 'KPOS_RAW.' + k + ' must ship empty');
    });
  assert.strictEqual(Object.keys(K.ROLE_PINS).length, 0, 'no PIN ships with the product');
  assert.strictEqual(K.CHAIN.name, '', 'no placeholder company — a placeholder on a receipt is a false statement');
  assert.strictEqual(K.CHAIN.tin, '', 'no placeholder TIN');

  // Structure: all of it ships.
  assert.strictEqual(K.ACCOUNTS.length, 38, 'the chart of accounts ships complete');
  assert.strictEqual(K.MODULES.length, 33, 'the module catalogue ships');
  assert.strictEqual(K.ROLES.length, 7, 'the permission catalogue ships');
  assert.ok(K.TAX_VERSIONS.length >= 8, 'the statutory rate history ships — a tax version is law');
  assert.ok(K.UNITS.length >= 6, 'unit definitions ship');
  assert.ok(K.DOC_SERIES.length >= 5, 'document series definitions ship');
  assert.ok(K.CURRENCIES.length >= 1 && K.CURRENCIES[0].code === 'MVR', 'MVR is the base currency');
  assert.ok(K.REASONS.waste.length && K.REASONS.void.length && K.REASONS.discount.length,
    'reason codes ship — a void without a reason is unauditable');
  assert.ok(K.ALLERGENS.length >= 11, 'the allergen rules ship');
});

test('the chart of accounts carries the codes the till owns', () => {
  const { win } = H.loadLogic({});
  const owned = win.KPOS.ACCOUNTS.filter((a) => a.till).map((a) => a.code).sort();
  // A manual journal must refuse these: the ledger reconciles to the POS by
  // construction and only stays that way if nobody can hand-key them.
  assert.strictEqual(owned.join(','),
    '1010,1030,1040,1200,2200,2350,4000,4100,4200,4900,6550',
    'the till-owned accounts are exactly the eleven the chain contract names'
    + ' — 2350 and 6550 are written only by the sale, which is what lets the'
    + ' loyalty liability tie to the member balances at all');
  // Codes are load-bearing: the P&L grouping and the GST return read them.
  const codes = win.KPOS.ACCOUNTS.map((a) => a.code);
  assert.strictEqual(new Set(codes).size, codes.length, 'no code appears twice');
  const expense = win.KPOS.ACCOUNTS.filter((a) => a.type === 'Expense');
  assert.ok(expense.length >= 17, 'the P&L is exhaustive by construction');
});

test('every figure on an empty install is zero', () => {
  const F = H.makeInstance({});
  const d = F.analyticsData();
  ['tot', 'cov', 'waste', 'labourCost', 'labourHours', 'opex'].forEach((k) => {
    assert.strictEqual(Number(d[k]) || 0, 0, 'analytics.' + k + ' is zero on an empty install');
  });
  assert.ok(d.days.every((x) => x.v === 0), 'the fourteen-day curve is flat, not modelled');
  assert.ok(d.hours.every((x) => x.v === 0), 'the hourly curve is flat, not modelled');
  assert.strictEqual(F.settledRows().length, 0, 'nothing has been settled');
  assert.strictEqual(F.clockRows().length, 0, 'nobody has punched in, so labour is zero');
});

test('every module that can be empty says what to do about it', () => {
  const F = H.makeInstance({});
  const bare = [];
  H.GENERATORS.forEach((g) => {
    const v = F[g]();
    const rows = (v.rows || []).length;
    const cards = (v.cards || []).length;
    const notes = (v.notes || []).length;
    const guide = (v.guide || []).length;
    const actions = (v.actions || []).length;
    const empty = String(v.emptyMsg || v.empty || '');
    // A screen with nothing on it must still carry either a guide, an empty
    // message, or an action. "No data" is not an empty state.
    if (!rows && !cards && !notes && !guide && !actions && !empty) bare.push(g);
  });
  assert.deepStrictEqual(bare, [], 'these screens are blank with no way forward: ' + bare.join(', '));
});

test('a screen with no rows still offers the action that fills it', () => {
  const F = H.makeInstance({});
  // The modules whose whole job is a list. Each must name a live action.
  ['g_inventory', 'g_purchases', 'g_vendors', 'g_menu', 'g_recipes', 'g_customers',
    'g_reservations', 'g_counts', 'g_assets', 'g_costs', 'g_staff'].forEach((g) => {
    const v = F[g]();
    const acts = (v.actions || []).filter((a) => typeof a.go === 'function');
    assert.ok(acts.length > 0, g + ' offers no action on an empty database');
  });
});
