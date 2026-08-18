'use strict';
/* The bill-arithmetic guard.
 *
 * The invariant  gross − discount + service + tax + rounding = total  is the
 * same equation the database's `sale_adds_up` check constraint enforces, so a
 * failure here is a sale the server will not be able to persist. It is asserted
 * EXACTLY, in integer laari — "within a laari" is how a day's takings end up a
 * few rufiyaa out with nothing to point at.
 *
 * Randomised across the whole configuration matrix rather than on chosen
 * examples: rounding bugs live at the awkward quantities (7 × 333, a 33%
 * discount on a 3-line bill), not at the ones a person would pick for a test.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { priceBill, taxWithin, creditShare, saleAddsUp } = require('./money');

const RATES = [0, 8, 16];          // not registered, GGST, TGST
const SERVICE = [0, 10, 12.5];
const ROUNDING = [0, 5, 10];       // laari increments

describe('taxWithin', () => {
  test('extracts, never adds on top', () => {
    // 108 inclusive at 8% contains 8, leaving 100 of goods.
    assert.equal(taxWithin(10800, 8), 800);
    assert.equal(taxWithin(11600, 16), 1600);
  });
  test('a store that is not GST-registered is charged nothing', () => {
    assert.equal(taxWithin(10000, 0), 0);
  });
  test('rounds half away from zero, once', () => {
    assert.equal(taxWithin(100, 8), Math.round(100 * 0.08 / 1.08));
  });
});

describe('priceBill', () => {
  test('a plain single-line cash bill', () => {
    const b = priceBill({ lines: [{ unitPrice: 10000, qty: 1 }], taxRate: 8, servicePct: 10 });
    assert.equal(b.goodsIncl, 10000);
    assert.equal(b.service, 1000 - taxWithin(1000, 8));
    assert.equal(b.total, 11000);
    assert.ok(saleAddsUp(b));
  });

  test('the service charge does not apply to the delivery fee', () => {
    const withFee = priceBill({
      lines: [{ unitPrice: 10000, qty: 1 }], fee: 3000, taxRate: 8, servicePct: 10 });
    const noFee = priceBill({
      lines: [{ unitPrice: 10000, qty: 1 }], taxRate: 8, servicePct: 10 });
    // Service is identical: the fee did not enter the service base.
    assert.equal(withFee.service, noFee.service);
    // And the fee still arrives in the total.
    assert.equal(withFee.total, noFee.total + 3000);
  });

  test('the service charge is itself taxed', () => {
    const b = priceBill({ lines: [{ unitPrice: 10000, qty: 1 }], taxRate: 8, servicePct: 10 });
    assert.equal(b.taxService, taxWithin(1000, 8));
    assert.ok(b.taxService > 0, 'service carried its own GST');
  });

  test('a discount reduces goods BEFORE service and tax', () => {
    const b = priceBill({
      lines: [{ unitPrice: 10000, qty: 1 }], discount: 2000, taxRate: 8, servicePct: 10 });
    // Service is 10% of the discounted 8000, not of 10000.
    assert.equal(b.taxService, taxWithin(800, 8));
    assert.equal(b.total, 8000 + 800);
    assert.ok(saleAddsUp(b));
  });

  test('a discount cannot exceed the goods', () => {
    const b = priceBill({ lines: [{ unitPrice: 5000, qty: 1 }], discount: 999999, taxRate: 8 });
    assert.equal(b.discountIncl, 5000);
    assert.equal(b.total, 0);
    assert.ok(saleAddsUp(b));
  });

  test('line amounts are rounded once from the line, not from the unit price', () => {
    // 3 × 333 laari. Rounding a unit price back out drifts; rounding the line
    // once does not.
    const b = priceBill({ lines: [{ unitPrice: 333, qty: 3 }], taxRate: 8 });
    assert.equal(b.linesIncl[0], 999);
    assert.equal(b.goodsIncl, 999);
  });

  test('net line amounts sum EXACTLY to the net goods figure', () => {
    const b = priceBill({
      lines: [{ unitPrice: 333, qty: 7 }, { unitPrice: 1777, qty: 3 }, { unitPrice: 99, qty: 11 }],
      taxRate: 16 });
    const sum = b.netLines.reduce((a, v) => a + v, 0);
    const goodsNet = b.goodsIncl - taxWithin(b.goodsIncl, 16);
    assert.equal(sum, goodsNet, 'no laari left over when the lines are added back up');
  });

  test('cash rounding moves the total and is recorded, signed', () => {
    const b = priceBill({ lines: [{ unitPrice: 10003, qty: 1 }], taxRate: 0, roundTo: 10 });
    assert.equal(b.total % 10, 0);
    assert.equal(b.rounding, b.total - 10003);
    assert.ok(saleAddsUp(b));
  });

  test('a store that is not GST-registered is charged no tax', () => {
    // `rate || 8` would silently turn "not registered" into 8% — the exact bug
    // that overcharges a small café every single bill.
    const b = priceBill({ lines: [{ unitPrice: 10000, qty: 1 }], taxRate: 0, servicePct: 10 });
    assert.equal(b.tax, 0);
    assert.equal(b.total, 11000);
    assert.ok(saleAddsUp(b));
  });

  test('THE INVARIANT holds exactly, across the whole matrix', () => {
    // Deterministic PRNG: a failure has to be reproducible from the seed, and
    // Math.random() gives a bug one chance to appear and none to be fixed.
    let seed = 20260814;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

    let checked = 0;
    for (const taxRate of RATES) {
      for (const servicePct of SERVICE) {
        for (const roundTo of ROUNDING) {
          for (let i = 0; i < 400; i++) {
            const lines = [];
            const n = 1 + rnd(8);
            for (let k = 0; k < n; k++) lines.push({ unitPrice: 1 + rnd(50000), qty: 1 + rnd(9) });
            const goods = lines.reduce((a, l) => a + l.unitPrice * l.qty, 0);
            const bill = {
              lines, taxRate, servicePct, roundTo,
              discount: rnd(4) === 0 ? rnd(goods + 1) : 0,
              fee: rnd(3) === 0 ? rnd(5000) : 0,
            };
            const b = priceBill(bill);

            const lhs = b.gross - b.discount + b.service + b.tax + b.rounding;
            assert.equal(lhs, b.total,
              'invariant broke at ' + JSON.stringify({ taxRate, servicePct, roundTo, bill, b }));

            // Nothing may be negative except the rounding adjustment.
            assert.ok(b.total >= 0 && b.tax >= 0 && b.gross >= 0 && b.service >= 0,
              'a negative figure at ' + JSON.stringify(b));
            // Every figure is a whole number of laari.
            for (const k of ['gross', 'discount', 'service', 'tax', 'rounding', 'total']) {
              assert.ok(Number.isInteger(b[k]), k + ' was not an integer: ' + b[k]);
            }
            checked++;
          }
        }
      }
    }
    assert.equal(checked, RATES.length * SERVICE.length * ROUNDING.length * 400);
  });
});

describe('creditShare — what a credit note gives back', () => {
  /* The property that makes a pro-rata share the right choice: crediting
     everything returns exactly what was taken. Anything else means a guest
     holding a receipt for 187.00 is handed 186.99 and is right to argue. */
  test('a FULL credit returns the sale total, to the laari', () => {
    for (const taxRate of [0, 6, 8, 16]) {
      for (const servicePct of [0, 10]) {
        for (const n of [1, 3, 7]) {
          const bill = {
            lines: Array.from({ length: n }, (_, i) => ({ unitPrice: 850 + i * 337, qty: 1 + i })),
            servicePct, taxRate,
          };
          const b = priceBill(bill);
          const share = creditShare(b.gross, b);
          assert.equal(share.total, b.total - b.rounding,
            'full credit ≠ total at ' + JSON.stringify({ taxRate, servicePct, n }));
        }
      }
    }
  });

  test('a partial credit never returns more than the sale did', () => {
    const b = priceBill({ lines: [{ unitPrice: 16500, qty: 3 }], servicePct: 10, taxRate: 8 });
    for (let part = 1; part <= 3; part++) {
      const goods = Math.round(b.gross * (part / 3));
      const share = creditShare(goods, b);
      assert.ok(share.total <= b.total, 'gave back more than was taken');
      assert.ok(Number.isInteger(share.total), 'not whole laari: ' + share.total);
    }
  });

  test('the discount comes off the credit in the same proportion', () => {
    /* Otherwise a guest who paid 80 after a 20 discount is refunded 100 — the
       restaurant buying back its own goodwill gesture at full price. */
    const b = priceBill({
      lines: [{ unitPrice: 10000, qty: 2 }], discount: 4000, servicePct: 0, taxRate: 8,
    });
    const half = creditShare(Math.round(b.gross / 2), b);
    assert.equal(half.discount, Math.round(b.discount / 2));
    assert.ok(half.total < Math.round(b.total / 2) + 2);
  });

  test('a sale of nothing credits nothing rather than dividing by zero', () => {
    const share = creditShare(0, { gross: 0, discount: 0, service: 0, tax: 0 });
    assert.equal(share.total, 0);
  });
});
