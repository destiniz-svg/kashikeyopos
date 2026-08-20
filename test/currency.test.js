'use strict';
/* ═══ THE BOOKS ARE KEPT IN ONE CURRENCY ════════════════════════════════════
   A business chooses its base currency when it opens. Every price, receipt,
   report and ledger figure is in it. A guest may hand over another currency at
   the counter — that is a TENDER, converted at a rate the till records — and
   it does not make the ledger bilingual.

   Three things shipped wrong and are asserted here:

     · every money figure was formatted "MVR " by two module-level functions,
       so a business keeping its books in dollars saw rufiyaa everywhere;
     · CASH rounded to the nearest half unit — written as Math.round(n*2)/2 —
       which is the 50-laari coin rule applied to a currency that has cents;
     · the terminal carried its own currency table, with EUR at 17.85 against
       the published 16.80, so the rate depended on which screen quoted it.
   ═══════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const H = require('./harness');
const FX = require('./fixtures');

function inCurrency(code) {
  const k = FX.kpos();
  k.OUTLETS = k.OUTLETS.map((o) => Object.assign({}, o, { currency: code }));
  k.CHAIN = Object.assign({}, k.CHAIN || {}, { currency: code });
  k.CURRENCIES = [
    { code: 'MVR', name: 'Maldivian rufiyaa', symbol: 'MVR', base: true,
      canBase: true, rate: 1, minor: 2, cashRound: 0.5 },
    { code: 'USD', name: 'US dollar', symbol: '$', canBase: true,
      rate: 15.42, minor: 2, cashRound: 0 },
    { code: 'EUR', name: 'Euro', symbol: '€', rate: 16.8, minor: 2, cashRound: 0 }
  ];
  const F = H.makeInstance({ kpos: k, raw: FX.raw(), real: FX.real() });
  F.syncCurrency();
  return F;
}

test('a rufiyaa business is quoted in rufiyaa', () => {
  const F = inCurrency('MVR');
  assert.strictEqual(F.base(), 'MVR');
  assert.match(F.fmtCur('MVR', 1234.5), /^MVR 1,234\.50$/);
});

test('a dollar business is quoted in dollars, everywhere', () => {
  const F = inCurrency('USD');
  assert.strictEqual(F.base(), 'USD');
  assert.match(F.fmtCur('USD', 1234.5), /^\$1,234\.50$/);
  // And the base is 1 by definition — never 15.42 of itself.
  assert.strictEqual(F.cur('USD').rate, 1);
});

test('cash rounds to the coin the currency actually has', () => {
  const mvr = inCurrency('MVR');
  assert.strictEqual(mvr.cashStep(), 0.5, 'the rufiyaa settles to its 50-laari coin');

  const usd = inCurrency('USD');
  assert.strictEqual(usd.cashStep(), 0, 'a dollar has cents, so it rounds to nothing');
});

test('there is one currency table, and the rates are re-based', () => {
  // Books in rufiyaa: a dollar is worth 15.42 of them.
  const mvr = inCurrency('MVR');
  assert.strictEqual(mvr.cur('MVR').rate, 1);
  assert.strictEqual(mvr.cur('USD').rate, 15.42);

  // Books in dollars: the rufiyaa becomes the foreign tender, worth 1/15.42.
  const usd = inCurrency('USD');
  assert.strictEqual(usd.cur('USD').rate, 1);
  assert.ok(Math.abs(usd.cur('MVR').rate - (1 / 15.42)) < 0.0001,
    'the rufiyaa is re-based against the books, not left at 1');
  assert.ok(Math.abs(usd.cur('EUR').rate - (16.8 / 15.42)) < 0.0001,
    'and so is every other currency');
});

test('the terminal no longer keeps its own rates', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  // The second table's tell-tale: rates written into the terminal itself.
  assert.strictEqual(/rate: \+p\.EUR \|\| 17\.85/.test(src), false,
    'the terminal must not carry its own EUR rate');
  assert.match(src, /K\(\)\.CURRENCIES/,
    'it reads the table the outlet published');
});

test('a foreign tender is converted, and the books stay in base', () => {
  const F = inCurrency('MVR');
  const slot = 1, key = F.state.outletId + ':' + slot;
  F.state.tickets = Object.assign({}, F.state.tickets, {
    [key]: Object.assign(F.blankTicket(), {
      party: 2, bizDate: F.today(),
      lines: [{ id: 'm1', qty: 1, note: '', split: 0, fired: true, since: 1, firedAt: Date.now() }]
    })
  });
  F.state.activeTable = slot;

  const T = F.totals(F.state.tickets[key]);
  // 185 net + 10% service + 8% GGST
  const due = Math.round(T.total * 100) / 100;
  const inUsd = Math.ceil((due / 15.42) * 100) / 100;

  const v = F.modalVals({ kind: 'pay', slot: slot, tender: 'cash', cur: 'USD',
    given: String(inUsd) });
  assert.ok(v, 'the pay sheet opens in a foreign currency');
  assert.match(String(v.curDueLabel || ''), /Due in USD/,
    'the guest is told what to hand over in their own currency');
  assert.match(String(v.fxNote || ''), /at 15\.42/,
    'and the rate is on the receipt, so the conversion is checkable');
});
