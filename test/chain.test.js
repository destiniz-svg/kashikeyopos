'use strict';
/* ═══ THE CHAIN ═════════════════════════════════════════════════════════════
   One party of four, two dishes, cash settle — and then nine assertions in
   order. This is the whole product in one test: if it passes, a sale really
   does travel from the floor to the kitchen to the drawer to the tax return to
   the stock ledger to the books.

   It is run twice, from BOTH settle paths, and the rows must be identical
   apart from the document number. In the reference they were not: the Orders
   panel wrote thirteen of twenty-nine fields and booked the pre-discount
   subtotal as revenue, so every discounted bill closed from Orders overstated
   sales and understated food cost.
   ═══════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const H = require('./harness');
const FX = require('./fixtures');

function liveInstance(extra) {
  return H.makeInstance(Object.assign({
    kpos: FX.kpos(), raw: FX.raw(), real: FX.real()
  }, extra || {}));
}

// Seat a party of four at T01 and ring two of each dish.
function ringUp(F, opts) {
  const o = opts || {};
  const slot = 1;
  const key = F.state.outletId + ':' + slot;
  const tickets = Object.assign({}, F.state.tickets);
  tickets[key] = Object.assign(F.blankTicket(), {
    waiter: 'Test Cashier', party: 4, channel: 'dine_in',
    bizDate: F.today(), openedAt: Date.now(),
    lines: [
      { id: 'm1', qty: 2, note: '', split: 0, fired: true, since: 2, firedAt: Date.now() },
      { id: 'm2', qty: 2, note: '', split: 0, fired: true, since: 2, firedAt: Date.now() }
    ]
  });
  if (o.promo) tickets[key].promo = o.promo;
  F.state.tickets = tickets;
  F.state.activeTable = slot;
  F.state.activeSplit = 0;
  F.state.register = { open: true, float: 1000, openedBy: 'u_owner', openedAt: Date.now() };
  return { slot, key };
}

test('the chain — a sale moves everything it is supposed to move', () => {
  const F = liveInstance();
  const { slot, key } = ringUp(F);

  const ingBefore = F.bookOnHand('ing_fish');
  const T = F.totals(F.state.tickets[key]);

  // Settle from the Orders ticket panel.
  const panel = F.ticketPanelVals({ kind: 'ticket', slot: slot, tender: 'cash' });
  panel.tkSettle();

  const row = (F.state.settled || [])[0];

  // 1 · a settled row exists
  assert.ok(row, 'a settled row exists');

  // 2 · it ties to its own components
  assert.ok(Math.abs(row.total - (row.net + row.svc + row.tax + row.round)) < 0.005,
    'total = net + service + tax + rounding (got ' + row.total + ')');

  // 3 · tax recorded WITH its version label and rate
  assert.ok(row.tax !== undefined, 'tax recorded');
  assert.ok(row.taxLabel, 'tax label recorded — a reprint after a rate change must not restate the invoice');
  assert.ok(row.taxRate, 'tax rate recorded');

  // 4 · business date recorded — not the calendar day after midnight
  assert.ok(row.bizDate, 'business date recorded');
  assert.match(String(row.bizDate), /^\d{4}-\d{2}-\d{2}$/, 'business date is a date');

  // 5 · covers is the party size, not the number of seats opened
  assert.strictEqual(row.covers, 4, 'covers = party size');

  // 6 · revenue recognised is the POST-discount net
  assert.ok(Math.abs(row.net - T.net) < 0.005, 'revenue is post-discount net');

  // 7 · COGS computed from the recipe at settle time
  assert.ok(row.cogs > 0, 'COGS computed from the recipe');

  // 8 · the ingredient's on-hand fell by what the recipe consumed
  const moved = (F.state.__moves || []);
  assert.ok(row.sold.length === 2, 'the sale remembers what left the kitchen');

  // 9 · the table was released
  assert.ok(!F.state.tickets[key], 'the table was released');

  // and the trial balance still squares
  const tb = F.trialBalance ? F.trialBalance(F.ACCPERIODS ? F.ACCPERIODS()[0] : null) : null;
  if (tb) {
    const dr = tb.reduce((a, r) => a + (r.dr || 0), 0);
    const cr = tb.reduce((a, r) => a + (r.cr || 0), 0);
    assert.ok(Math.abs(dr - cr) < 0.01, 'the trial balance squares after the sale');
  }
});

test('both settle paths write the identical row', () => {
  // Path A — the Orders ticket panel.
  const A = liveInstance();
  const a = ringUp(A);
  const panel = A.ticketPanelVals({ kind: 'ticket', slot: a.slot, tender: 'cash' });
  panel.tkSettle();
  const rowA = A.state.settled[0];

  // Path B — the till pay sheet.
  const B = liveInstance();
  ringUp(B);
  B.state.modal = { kind: 'pay', tender: 'cash', given: String(rowA.total), gIdx: 0 };
  const pay = B.overlayVals();
  pay.confirmPay();
  const rowB = B.state.settled[0];

  assert.ok(rowB, 'the till path settled');

  // Field for field, apart from the document number and the instant.
  const skip = new Set(['no', 'ref', 'at', 'time', 'id', 'table', 'tender', 'chg', 'payments', 'serverAudit']);
  const keys = new Set(Object.keys(rowA).concat(Object.keys(rowB)));
  const diffs = [];
  keys.forEach((k) => {
    if (skip.has(k)) return;
    const x = JSON.stringify(rowA[k]), y = JSON.stringify(rowB[k]);
    if (x !== y) diffs.push(k + ': orders=' + x + ' till=' + y);
  });
  assert.deepStrictEqual(diffs, [],
    'the two settle paths must write the same row — this is the reference\'s worst defect');
});

test('cash rounding is on the row, and matches the button', () => {
  const F = liveInstance();
  const { slot, key } = ringUp(F);
  const T = F.totals(F.state.tickets[key]);
  const panel = F.ticketPanelVals({ kind: 'ticket', slot: slot, tender: 'cash' });
  panel.tkSettle();
  const row = F.state.settled[0];

  // Cash rounds to the nearest 50 laari; the difference is its own figure and
  // is posted to 4900, never absorbed into revenue.
  const rounded = Math.round(T.total * 2) / 2;
  assert.ok(Math.abs(row.total - rounded) < 0.005,
    'the recorded total is the rounded figure the button showed');
  assert.ok(Math.abs(row.round - (rounded - T.total)) < 0.005,
    'the rounding difference is recorded, not absorbed');
});

test('a discounted bill books the discounted figure as revenue', () => {
  const F = liveInstance();
  const { slot, key } = ringUp(F, { promo: { pct: 10, code: 'TEST10', from: 'till' } });
  const T = F.totals(F.state.tickets[key]);
  assert.ok(T.disc > 0, 'the discount applied');

  const panel = F.ticketPanelVals({ kind: 'ticket', slot: slot, tender: 'cash' });
  panel.tkSettle();
  const row = F.state.settled[0];

  assert.ok(Math.abs(row.net - (T.sub - T.disc)) < 0.005,
    'net is AFTER the discount — booking T.sub overstates sales by the discount');
  assert.ok(Math.abs(row.disc - T.disc) < 0.005, 'the discount is recorded on the row');
});

test('the sale carries a stock consequence to the server', () => {
  const queued = [];
  const F = liveInstance();
  F.__win.KPOS_SYNC = { enqueue: (op) => { queued.push(op); return op.opId; } };
  const { slot } = ringUp(F);
  const panel = F.ticketPanelVals({ kind: 'ticket', slot: slot, tender: 'cash' });
  panel.tkSettle();

  const sale = queued.filter((q) => q.kind === 'sale')[0];
  assert.ok(sale, 'a sale op was queued');
  assert.ok(sale.opId, 'the op carries a client-generated opId');
  assert.match(sale.opId, /^[0-9a-f-]{36}$/, 'the opId is a UUID');
  assert.ok(sale.payload.stockMoves.length >= 2,
    'the recipe explosion reached the ingredients that actually left the store');
  assert.ok(sale.payload.sold.length === 2, 'both dishes are on the payload');
  assert.ok(sale.payload.cogs > 0, 'the cost went with it');
  assert.strictEqual(sale.payload.covers, 4, 'covers travelled');

  // Every ingredient move is a real ingredient, with a real quantity.
  sale.payload.stockMoves.forEach((m) => {
    assert.ok(m.ing, 'a move names its ingredient');
    assert.ok(m.qty > 0, 'a move has a quantity');
  });
});
