'use strict';
/* ═══ GST IS OPTIONAL, BECAUSE REGISTRATION IS ══════════════════════════════
   In the Maldives a business registers for GST once its taxable supplies pass
   a threshold; below it, it charges nothing. Tourism registers regardless.

   The app shipped assuming registration. Every receipt, bill strip, pay sheet
   and ribbon printed a tax row unconditionally — so an unregistered café's
   bills read "NONE 0%", which is not merely untidy: a document showing a tax
   line claims a registration the business does not hold.

   This sweeps EVERY screen and EVERY modal for an unregistered outlet and
   fails on any tax row that survived.
   ═══════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const H = require('./harness');
const FX = require('./fixtures');

// The same fixture, with the one fact that matters flipped.
function unregistered() {
  const k = FX.kpos();
  k.OUTLETS = k.OUTLETS.map((o) => Object.assign({}, o, { tax: 'NONE', rate: 0 }));
  k.GST_WATCH = {
    registered: false, code: 'NONE', threshold: 1000000, months: 12,
    turnover: 42000, sales: 310, due: false, near: false, tourismAlways: false,
    note: 'Taxable supplies over MVR 1,000,000 in any 12 months require registration.',
    authority: 'MIRA · GST Act 10/2011'
  };
  return k;
}

test('an unregistered outlet is reported as unregistered', () => {
  const F = H.makeInstance({ kpos: unregistered(), raw: FX.raw(), real: FX.real() });
  assert.strictEqual(F.taxRegistered(), false);
  assert.strictEqual(F.taxLine(), '', 'there is no rate to print');

  const R = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  assert.strictEqual(R.taxRegistered(), true);
  assert.strictEqual(R.taxLine(), 'GGST 8%');
});

test('a registered outlet still charges, to the laari', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const tk = Object.assign(F.blankTicket(), {
    lines: [{ id: 'm1', qty: 2, note: '', split: 0, fired: true, since: 1, firedAt: Date.now() }]
  });
  const T = F.totals(tk);
  // 2 × 185 = 370 net, 10% service = 37, GGST 8% on 407 = 32.56
  assert.strictEqual(Math.round(T.net * 100) / 100, 370);
  assert.strictEqual(Math.round(T.svc * 100) / 100, 37);
  assert.strictEqual(Math.round(T.tax * 100) / 100, 32.56);
});

test('an unregistered outlet charges no tax at all', () => {
  const F = H.makeInstance({ kpos: unregistered(), raw: FX.raw(), real: FX.real() });
  const tk = Object.assign(F.blankTicket(), {
    lines: [{ id: 'm1', qty: 2, note: '', split: 0, fired: true, since: 1, firedAt: Date.now() }]
  });
  const T = F.totals(tk);
  assert.strictEqual(Math.round(T.tax * 100) / 100, 0, 'no tax');
  assert.strictEqual(Math.round(T.total * 100) / 100, 407, 'net plus service, and nothing else');
});

/* The sweep. Every screen generator and every modal is rendered for an
   unregistered outlet, and every string in the result is searched for a tax
   row that should not be there. */
function strings(v, out, depth) {
  if (depth > 6 || v === null || v === undefined) return out;
  if (typeof v === 'string') { out.push(v); return out; }
  if (typeof v !== 'object') return out;
  if (Array.isArray(v)) { v.forEach((x) => strings(x, out, depth + 1)); return out; }
  Object.keys(v).forEach((k) => {
    if (k === 'style' || k === 'go' || k === 'tap') return;   // styles are not copy
    try { strings(v[k], out, depth + 1); } catch (e) { /* getter */ }
  });
  return out;
}

test('no screen prints a tax line for an unregistered outlet', () => {
  const F = H.makeInstance({ kpos: unregistered(), raw: FX.raw(), real: FX.real() });
  const bad = [];
  /* A CLAIM is a tax class sitting next to a rate — "NONE 0%", "GGST 8%" —
     which is what a tax row looks like. Explanatory copy that mentions GGST
     and TGST as concepts ("GGST applies to general outlets") is documentation,
     not a claim about THIS outlet, and is left alone. */
  const claim = /\b(NONE|GGST|TGST)\b[^.a-z]{0,3}\d+(\.\d+)?\s*%/;

  H.GENERATORS.forEach((g) => {
    let v;
    try { v = F[g](); } catch (e) { return; }
    strings(v, [], 0).forEach((str) => {
      if (claim.test(str)) bad.push(g + ': "' + str.slice(0, 70) + '"');
    });
  });
  H.MODAL_KINDS.forEach((kind) => {
    let v;
    try { F.state.modal = { kind: kind }; v = F.modalVals ? F.modalVals(F.state.modal) : null; }
    catch (e) { return; }
    strings(v, [], 0).forEach((str) => {
      if (claim.test(str)) bad.push('modal ' + kind + ': "' + str.slice(0, 70) + '"');
    });
  });

  assert.deepStrictEqual(bad, [],
    'an unregistered business must not show a tax class anywhere:\n  ' + bad.join('\n  '));
});

test('the registration threshold is measured, not asked', () => {
  const F = H.makeInstance({ kpos: unregistered(), raw: FX.raw(), real: FX.real() });
  const w = F.gstWatch();
  assert.ok(w, 'the outlet publishes where it stands');
  assert.strictEqual(w.registered, false);
  assert.strictEqual(typeof w.turnover, 'number', 'turnover is a measurement');
  assert.ok(w.threshold > 0, 'against a statutory threshold');

  // Below the threshold: nothing is demanded of the owner.
  // .length, not deepStrictEqual: these arrays come from the vm realm and
  // carry that realm's Array.prototype, which deepStrictEqual rejects.
  const quiet = F.todayBrief().items.filter((i) => /GST/i.test(i.title));
  assert.strictEqual(quiet.length, 0,
    'a small business is not nagged: ' + quiet.map((i) => i.title).join(', '));
});

test('crossing the threshold becomes a decision the owner is shown', () => {
  const k = unregistered();
  k.GST_WATCH = Object.assign({}, k.GST_WATCH, { turnover: 1250000, due: true });
  const F = H.makeInstance({ kpos: k, raw: FX.raw(), real: FX.real() });
  const hit = F.todayBrief().items.filter((i) => /GST registration is due/.test(i.title));
  assert.strictEqual(hit.length, 1, 'it is raised once, as a decision');
  assert.strictEqual(hit[0].band, 'now', 'and it is not a "someday" item');
});

test('a registered outlet is never told to register', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const noise = F.todayBrief().items.filter((i) => /GST registration/i.test(i.title));
  assert.strictEqual(noise.length, 0,
    'the question is already answered: ' + noise.map((i) => i.title).join(', '));
});

/* ── the choice, and what it must not assert ────────────────────────────── */

test('onboarding asks whether the business is registered, and defaults to NOT', () => {
  const fs = require('fs');
  const path = require('path');
  const panel = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'onboarding.html'), 'utf8');

  const field = (panel.match(/\{ k: "gstRegistered",[\s\S]{0,700}?\},\n/) || [''])[0];
  assert.ok(field, 'step 1 asks the question outright');
  assert.match(field, /"no", "Not registered for GST"/, 'both answers are offered');
  assert.match(field, /"yes", "Registered for GST"/);
  // Most new businesses are below the threshold. A default of "registered"
  // is a default that puts 8% on a menu nobody agreed to.
  assert.match(field, /v: "no"/, 'and the default is not registered');

  // The TIN follows the answer rather than being demanded of everybody: a
  // business below the threshold has none, and inventing one is a false
  // statement on every receipt it prints.
  const tin = (panel.match(/\{ k: "tin",[\s\S]{0,400}?\},\n/) || [''])[0];
  assert.ok(tin, 'the TIN field is still there');
  assert.ok(!/req:\s*true/.test(tin), 'but it is not required of everybody');
  assert.match(tin, /showIf: \{ k: "gstRegistered", is: "yes" \}/,
    'it appears only when it applies');
});

test('the tax step claims nothing of a business that charges nothing', () => {
  const fs = require('fs');
  const path = require('path');
  const panel = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'onboarding.html'), 'utf8');

  const step = panel.slice(panel.indexOf('key: "tax"'), panel.indexOf('key: "series"'));
  assert.match(step, /if \(!state\.gstRegistered\(\)\)/,
    'the step branches on the answer');
  assert.match(step, /No GST to confirm/, 'and says so');

  /* The registered branch asserts "Prices on the menu are set exclusive of GST
     and the tax is shown as its own line". For a business that is not
     registered that is simply untrue, and the step used to say it to everybody
     — over a rate box defaulting to 8%. */
  const unreg = step.slice(step.indexOf('if (!state.gstRegistered()'),
    step.indexOf('return {\n          fields:'));
  assert.ok(!/shown as its own line/.test(unreg),
    'the unregistered branch does not promise a tax line');
  assert.ok(!/k: "rate"/.test(unreg), 'and does not ask for a rate');
  assert.ok(!/k: "code"/.test(unreg), 'or a tax class');
});

test('a receipt prints no TIN when the business has none', () => {
  const fs = require('fs');
  const path = require('path');
  const app = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  // "TIN " followed by nothing is worse than no line at all: it reads as a
  // missing number rather than an absent registration.
  assert.match(app, /<sc-if value="\{\{ rcpHasTin \}\}">\s*\n\s*<div[^>]*>TIN \{\{ rcpTin \}\}<\/div>/,
    'the TIN line is conditional');
  assert.ok(/rcpHasTin: !!this\.chainOf\(\)\.tin/.test(app),
    'and the condition is whether there is one');
});
