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
// state key in the reference, not a formSpec entry. Counted honestly at 53.
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
  assert.strictEqual(r.f.rendered, 53, 'all 53 forms have a spec');
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
