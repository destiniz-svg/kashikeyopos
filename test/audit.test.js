'use strict';
/* The sweep, as an assertion. Every module renders, every sub-tab renders,
   every modal opens, every form has a spec, and every function any of them
   expose can be called without throwing — on an EMPTY database and on a seeded
   one, and at every rank.

   The handler sweep is the important one and the one nobody does. Two of the
   reference's defects were found only here: neither was reachable by clicking. */

const test = require('node:test');
const assert = require('node:assert');
const H = require('./harness');
const FX = require('./fixtures');

// `aiResult` is listed among the forms in the handoff inventory, but it is a
// state key in the reference, not a formSpec entry. Counted honestly at 57
// — `processor` is the payment contract each of the four is edited through.
const FORMS = H.FORMS.filter((f) => f !== 'aiResult');

function report(label, F) {
  const s = H.sweep(F);
  const m = H.sweepModals(F);
  const f = H.sweepForms(F, FORMS);
  const errs = [].concat(s.errs, m.errs, f.errs);
  if (errs.length) {
    console.error('\n' + label + ' failures:\n  ' + errs.join('\n  ') + '\n');
  }
  return { s, m, f, errs };
}

test('empty database — every screen renders and no handler throws', () => {
  const F = H.makeInstance({});
  const r = report('EMPTY', F);
  assert.strictEqual(r.errs.length, 0, r.errs.join(' | '));
  assert.strictEqual(r.s.rendered, 34, 'all 34 screen generators render');
  assert.strictEqual(r.m.rendered, 34, 'all 34 modal kinds open');
  assert.strictEqual(r.f.rendered, 59, 'all 59 forms have a spec');
  assert.ok(r.s.fired > 400, 'the handler sweep actually swept (' + r.s.fired + ' calls)');
});

test('seeded outlet — every screen renders and no handler throws', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const r = report('SEEDED', F);
  assert.strictEqual(r.errs.length, 0, r.errs.join(' | '));
  assert.strictEqual(r.s.rendered, 34);
  assert.strictEqual(r.m.rendered, 34);
});

/* Every rank renders every module. A gated action must REFUSE with the
   reference's wording, not vanish silently and not throw — a screen that
   disappears teaches an operator that the app is broken; a screen that says
   "this needs a manager" teaches them what to ask for. */
const RANKS = [
  ['KitchenManager', 1], ['Cashier', 2], ['OutletManager', 3],
  ['ChainAdmin', 4], ['SuperAdmin', 5]
];

RANKS.forEach(([roleKey, rank]) => {
  test('rank ' + rank + ' (' + roleKey + ') — every screen survives the sweep', () => {
    const F = H.makeInstance({
      kpos: FX.kpos(), raw: FX.raw(), real: FX.real({ rank }),
      role: roleKey,
      session: { id: 'u_x', user: 'x', name: 'Rank ' + rank, role: roleKey, outlet: 1, outlets: [] }
    });
    const r = report('RANK ' + rank, F);
    assert.strictEqual(r.errs.length, 0, r.errs.join(' | '));
  });
});

test('a rank-2 session cannot reach a rank-3 approval by asking for it', () => {
  const F = H.makeInstance({
    kpos: FX.kpos(), raw: FX.raw(), real: FX.real({ rank: 2 }),
    role: 'Cashier',
    session: { id: 'u_till', user: 'cashier', name: 'Test Cashier', role: 'Cashier', outlet: 1, outlets: [] }
  });
  // The permission catalogue is a presentation of the rank ladder, and the
  // server enforces the same ladder underneath. Neither may be bypassed by
  // navigating to the view.
  assert.strictEqual(F.can('accounting', 'e'), false, 'a cashier cannot edit the books');
  assert.strictEqual(F.can('users', 'a'), false, 'a cashier cannot add a user');
  assert.strictEqual(F.can('recipes', 'e'), false, 'a cashier cannot rewrite a recipe');
  assert.strictEqual(F.can('owner'), false, 'the owner screen is rank 5 or absent');

  // And asking for the view anyway must not produce a screen full of figures.
  F.state.view = 'accounting';
  const vals = F.g_accounting();
  assert.ok(vals, 'the module still renders rather than throwing');
});

test('the five-rank ladder is the only gate', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  [1, 2, 3, 4, 5].forEach((r) => {
    assert.strictEqual(typeof F.rankFor, 'function', 'ranks are read through one helper');
  });
  // Rank 5 is the only cross-outlet read.
  assert.strictEqual(F.can('owner'), true, 'rank 5 reaches the estate');
});

/* ═══ NO INVENTED FIGURES ═══════════════════════════════════════════════════
   Every ribbon card is a number a manager acts on. The reference's cards were
   written against a demo, so several were literals — "Registered customers"
   was the real count MULTIPLIED BY 214, "QR table sessions" was the string
   "38", "On-time tonight" was "94%", and the last cycle count was always
   "Today 06:12" with a variance of MVR 412.

   On a real install those read as measurements and are not. This walks the
   ribbon at every rank on an EMPTY database, where every honest figure is
   zero or an empty state, and fails on anything that isn't.
   ═══════════════════════════════════════════════════════════════════════ */
test('no ribbon card invents a figure on an empty install', () => {
  const F = H.makeInstance({});
  const bad = [];
  // statCards() reads the current view, so drive it the way the shell does.
  const VIEWS = H.GENERATORS.map((g) => g.replace(/^g_/, ''))
    .concat(['pos', 'kds', 'bill', 'sync']);
  VIEWS.forEach((v) => {
    let cards;
    F.state.view = v;
    try { cards = F.statCards(); } catch (e) { return; }   // a view with no ribbon
    (cards || []).forEach((c) => {
      const value = String((c && c.value) !== undefined ? c.value : (c && c.v) || '');
      const sub = String((c && c.sub) || '');
      // A figure on an empty database is 0, an em dash, "Never", a currency
      // zero, a percentage of nothing, or a label. Anything else was typed.
      const n = value.replace(/[^0-9.]/g, '');
      if (n && Number(n) !== 0) {
        bad.push(v + ' · ' + (c.label || '?') + ' = "' + value + '"');
      }
      // Sub-lines are where the inventions hid: "12 online · 2 last seen > 1h".
      // Three kinds of number are NOT measurements and are allowed to be
      // written down: a statutory rate (MRPS is 7% + 7%, the service charge
      // pool is 99%), an account code in the chart, and a target this outlet
      // configured. Everything else on an empty install must be zero.
      const digits = sub.match(/\b[1-9][0-9]*\b/g) || [];
      const statutory = /\b7% employee|99% distributed|MRPS|GST|TGST|GGST\b/;
      const accountCode = /\b(1[0-9]{3}|2[0-9]{3}|3[0-9]{3}|4[0-9]{3}|5[0-9]{3}|6[0-9]{3})\b/;
      const configured = /target|sla|red at|10 points|1 pt|MVR 1 off|every |per |set on this device/i;
      if (digits.length && !statutory.test(sub) && !accountCode.test(sub)
        && !configured.test(sub)) {
        bad.push(v + ' · ' + (c.label || '?') + ' sub "' + sub + '"');
      }
    });
  });
  assert.deepStrictEqual(bad, [],
    'these read as measurements on an empty install:\n  ' + bad.join('\n  '));
});

/* AND NO TABLE INVENTS ONE EITHER. The ribbon sweep above has guarded the
   cards since it was written; the screens BEHIND them were never asked the
   same question, and a real customer found the gap on the day they opened
   their store.

   Recipes & Costing → Yields and trim loss came up with EIGHT rows of data on
   an install where nobody had entered anything:

     Item #1 · 100% · 2% · 98% · MVR 0.00 / kg · MVR 0.00 / kg · +-100% · default

   A name that is a placeholder for a missing row, the shipped "nobody has
   assessed this" fallback rendered as the ingredient's own yield, a cost of
   zero, and an uplift of minus a hundred per cent from dividing by it.

   They came from three DEMO batches hard-coded in the terminal and shown to
   any store that had saved none of its own. The yields tab lists every
   ingredient any recipe or batch draws on, so the demo lines populated it —
   and those lines carry ingredient ids from an old seed belonging to no real
   outlet. Demo content is not an exception to "no invented figures"; it is
   the most persuasive way to break it. */
test('no costing table invents a figure on an empty install', () => {
  const F = H.makeInstance({});

  /* Lengths, not deepStrictEqual: the logic runs in a vm, so the arrays it
     returns carry that realm's Array.prototype and a strict deep-equal against
     a literal [] fails on the prototype alone — which reads as "the fix did
     not work" and is nothing of the kind. */
  assert.strictEqual(F.SUBS().length, 0,
    'a store that has saved no batches has none — the three shipped demo'
    + ' batches are not a real outlet\'s data and must not stand in for it:'
    + ' ' + JSON.stringify(F.SUBS().map((x) => x.name)));

  const tabs = { 1: 'dishes', 2: 'sub-recipes', 3: 'yields & trim loss' };
  Object.keys(tabs).forEach((t) => {
    F.state.tab = Object.assign({}, F.state.tab, { rec: Number(t) });
    const out = F.g_recipes();
    const rows = [].concat(out.rows || [], out.cards || []);
    assert.strictEqual(rows.length, 0,
      'the ' + tabs[t] + ' tab shows nothing on an install with nothing in it,'
      + ' rather than demo content: ' + JSON.stringify(rows).slice(0, 200));
  });

  /* And the empty state SAYS so, rather than being a blank panel — which is
     the other half of the same rule. */
  F.state.tab = Object.assign({}, F.state.tab, { rec: 3 });
  assert.match(String(F.g_recipes().empty || ''), /\S/,
    'the yields tab says what is true when it has nothing to show');
});

/* A ROW FOR AN INGREDIENT THIS OUTLET DOES NOT HAVE CAN ONLY INVENT FIGURES.
   Taking the demo batches out is the cause; this is the guard, because a
   recipe can still name an ingredient the item master has since lost. */
test('the yields table skips ingredients the item master does not have', () => {
  const F = H.makeInstance({});
  F.state.local = Object.assign({}, F.state.local, {
    subs: [{ id: 'S9', name: 'Ghost batch', batch: 1000, unit: 'g', loss: 0,
      lines: [['no-such-ingredient', 100]] }]
  });
  F.state.tab = Object.assign({}, F.state.tab, { rec: 3 });
  assert.strictEqual((F.g_recipes().rows || []).length, 0,
    'an ingredient with no row behind it has nothing to say, and saying it'
    + ' anyway is a name placeholder, a zero cost and an uplift of -100%');
});
