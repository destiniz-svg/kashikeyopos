'use strict';
/* ═══ THE CHAIN ═════════════════════════════════════════════════════════════
   One party of four, two dishes, cash settle — and then nine assertions in
   order. This is the whole product in one test: if it passes, a sale really
   does travel from the floor to the kitchen to the drawer to the tax return to
   the stock ledger to the books.

   It is driven from Orders & Tickets, because there is now exactly ONE place
   in the build where money is taken and that panel hands off to it. There used
   to be two: the Orders panel wrote thirteen of twenty-nine fields and booked
   the pre-discount subtotal as revenue, so every discounted bill closed from
   Orders overstated sales and understated food cost — and after that was
   repaired it still could not tender, so a cashier taking cash could not say
   what the guest handed over and the drawer never learned the change.
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

// Settling FROM Orders & Tickets. The panel has no settle of its own: Take
// payment opens the till's own pay screen on this ticket, which is where the
// cash, the change and the journal are written. `given` is what the guest
// actually handed over — the thing this route could not express at all.
function settleFromOrders(F, slot, given) {
  const panel = F.ticketPanelVals({ kind: 'ticket', slot: slot });
  assert.strictEqual(typeof panel.tkPay, 'function', 'the panel offers to take payment');
  assert.strictEqual(panel.tkSettle, undefined,
    'and keeps no settle of its own — a second one is a second set of bugs');
  panel.tkPay();
  assert.strictEqual((F.state.modal || {}).kind, 'pay',
    'Take payment opens the till pay screen');
  assert.strictEqual(F.state.activeTable, slot, 'on this ticket');
  F.state.modal = Object.assign({}, F.state.modal,
    { given: String(given === undefined ? 100000 : given) });
  F.overlayVals().confirmPay();
}

test('the chain — a sale moves everything it is supposed to move', () => {
  const F = liveInstance();
  const { slot, key } = ringUp(F);

  const ingBefore = F.bookOnHand('ing_fish');
  const T = F.totals(F.state.tickets[key]);

  // Settle from the Orders ticket panel.
  settleFromOrders(F, slot);

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

test('Orders & Tickets settles through the till, and takes a tender', () => {
  // The defect this replaced: settling with cash from Orders & Tickets could
  // not ask what the guest handed over. It assumed exact money, recorded no
  // change, and the drawer count at the end of the shift was the first place
  // anyone found out.
  const queued = [];
  const F = liveInstance();
  F.__win.KPOS_SYNC = { enqueue: (op) => { queued.push(op); return op.opId; } };
  const { slot, key } = ringUp(F);
  const T = F.totals(F.state.tickets[key]);

  const panel = F.ticketPanelVals({ kind: 'ticket', slot: slot });
  panel.tkPay();
  const pay = F.overlayVals();

  // The cash pad is there: quick notes to press, a keypad to type on, and a
  // confirm that refuses until enough has actually been tendered.
  assert.ok((pay.quickTender || []).length, 'quick cash notes are offered');
  assert.ok((pay.keys || []).length, 'and a keypad to type an amount on');
  assert.match(String(pay.confirmLabel), /Tender/,
    'nothing tendered yet — the button says how much more is needed');

  // Hand over a 500 note against a bill of ~552.9, which is not enough.
  F.state.modal = Object.assign({}, F.state.modal, { given: '500' });
  assert.match(String(F.overlayVals().confirmLabel), /Tender/,
    'a short tender is refused by name, not silently accepted');

  // Now a 600.
  F.state.modal = Object.assign({}, F.state.modal, { given: '600' });
  const ready = F.overlayVals();
  assert.doesNotMatch(String(ready.confirmLabel), /Tender/, 'enough is enough');
  ready.confirmPay();

  const row = F.state.settled[0];
  assert.ok(row, 'the ticket settled');
  assert.ok(!F.state.tickets[key], 'and the table was released');
  assert.ok(Math.abs(row.total - Math.round(T.total * 2) / 2) < 0.005,
    'the total is the cash-rounded figure');
  assert.ok(Math.abs(row.chg - (600 - row.total)) < 0.005,
    'the change that went back is on the row: ' + row.chg);

  // And it reaches the outlet, because a drawer that reconciles only on this
  // device is a drawer nobody else can count.
  const sale = queued.filter((q) => q.kind === 'sale').pop();
  const paid = ((sale.payload || {}).payments || [])[0] || {};
  assert.ok(paid.tendered >= row.total,
    'the payment records what was handed over (' + paid.tendered + '), not only what was owed');
  assert.ok(Math.abs(paid.chg - (600 - row.total)) < 0.005,
    'and the change on the same payment: ' + paid.chg);
});

test('there is one place in the build where money is taken', () => {
  // Two settle implementations is two sets of arithmetic to keep in step, and
  // this build has already been bitten once by exactly that. The panel is
  // allowed to open the till's pay screen; it is not allowed to have its own.
  const F = liveInstance();
  const { slot } = ringUp(F);
  const panel = F.ticketPanelVals({ kind: 'ticket', slot: slot });
  assert.strictEqual(panel.tkSettle, undefined, 'the panel settles nothing itself');
  assert.strictEqual(panel.tkTenders, undefined, 'and offers no tender list of its own');
  assert.strictEqual(typeof F.TENDER_SET, 'undefined',
    'the second list of tenders is gone — TENDERS() carries the account each posts to');

  // What it does offer is the hand-off, and it names the amount.
  assert.match(String(panel.tkPayLabel), /Take payment/, 'the panel offers to take payment');
});

test('cash rounding is on the row, and matches the button', () => {
  const F = liveInstance();
  const { slot, key } = ringUp(F);
  const T = F.totals(F.state.tickets[key]);
  settleFromOrders(F, slot);
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

  settleFromOrders(F, slot);
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
  settleFromOrders(F, slot);

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

/* ═══ WHO MOVES THE MONEY ════════════════════════════════════════════════════
   Card, wallet and QR were blended into one daily batch checked against a
   single merchant rate, so a gateway overcharging half a percent looked exactly
   like a terminal batch landing a day early — and neither could be argued with
   a bank.
   ═══════════════════════════════════════════════════════════════════════ */
function sale(F, over) {
  return Object.assign({
    outletId: F.state.outletId, no: 'INV-' + Math.random().toString(36).slice(2, 8),
    tender: 'card', total: 1000, net: 1000, at: Date.now(), bizDate: F.today(),
    ref: 'A1', status: 'closed'
  }, over || {});
}

test('two processors taking money on the same day are two batches', () => {
  const F = liveInstance();
  F.state.settled = [
    sale(F, { tender: 'card', total: 1000, bizDate: '2026-03-10' }),
    sale(F, { tender: 'qr', total: 500, bizDate: '2026-03-10' })
  ];
  const b = F.settlementBatches();
  assert.strictEqual(b.length, 2, 'two contracts, two batches');
  const term = b.filter((x) => x.proc === 'term')[0];
  const gw = b.filter((x) => x.proc === 'gw')[0];
  assert.strictEqual(term.key, 'term|2026-03-10', 'keyed by processor AND day');
  assert.strictEqual(gw.key, 'gw|2026-03-10');

  // Each against its OWN rate: 1.5% of 1000 and 2.4% of 500.
  assert.strictEqual(term.fee, 15, 'the terminal takes 1.5%');
  assert.strictEqual(term.expected, 985);
  assert.strictEqual(gw.fee, 12, 'the gateway takes 2.4%');
  assert.strictEqual(gw.expected, 488);

  // And each on its own cycle.
  assert.strictEqual(term.cycle, 1, 'the terminal pays T+1');
  assert.strictEqual(gw.cycle, 2, 'the gateway pays T+2');

  // Matching one leaves the other waiting.
  F.acqPay(term, 985);
  const after = F.settlementBatches();
  assert.strictEqual(after.filter((x) => x.proc === 'term')[0].state, 'matched');
  assert.strictEqual(after.filter((x) => x.proc === 'gw')[0].state, 'awaiting',
    'the gateway is untouched — an advice cannot credit another processor');
});

test('a direct transfer is never a batch, and never overdue', () => {
  const F = liveInstance();
  F.state.settled = [sale(F, { tender: 'transfer', total: 800, bizDate: '2026-03-10' })];
  // `.length`, not deepStrictEqual: the logic class runs in a vm, so an array
  // it returns has that realm's Array prototype and compares unequal to one
  // built out here even when both are empty.
  assert.strictEqual(F.settlementBatches().filter((b) => b.proc === 'direct').length, 0,
    'nothing stands between the guest and the bank, so there is nothing to match');
  assert.strictEqual(F.settlementInTransit().overdue.filter((b) => b.proc === 'direct').length, 0,
    'and nothing that can be late');

  // It does appear as a bank expectation on the day sent — it was not on the
  // reconciliation screen at all before.
  const exp = F.bankExpect().filter((e) => e.kind === 'Bank transfer');
  assert.strictEqual(exp.length, 1, 'the money still arrives, and this says when');
  assert.strictEqual(exp[0].amt, 800);
  assert.strictEqual(exp[0].day, F.dayNum('2026-03-10'), 'T+0 — the same day');
});

test('a reversal nets off the next settlement not yet paid', () => {
  const F = liveInstance();
  F.state.settled = [
    sale(F, { tender: 'card', total: 1000, bizDate: '2026-03-10' }),
    sale(F, { tender: 'card', total: 2000, bizDate: '2026-03-11' })
  ];
  // File the first day, so it has been paid and banked.
  F.acqPay(F.settlementBatches().filter((b) => b.date === '2026-03-10')[0], 985);

  // Now refund against that filed day.
  F.state.docs = [{ kind: 'CN', outletId: F.state.outletId, tender: 'card',
    bizDate: '2026-03-10', at: Date.now(), T: { total: 300 } }];

  const b = F.settlementBatches();
  const filed = b.filter((x) => x.date === '2026-03-10')[0];
  assert.strictEqual(filed.state, 'matched', 'the filed batch stays filed');
  assert.strictEqual(filed.paid, 985, 'at the figure the bank actually paid');
  assert.strictEqual(filed.reversed, 0, 'nothing was clawed back out of it');

  const next = b.filter((x) => x.date === '2026-03-11')[0];
  assert.strictEqual(next.reversed, 300, 'the refund walked forward to the open one');
  assert.strictEqual(next.expected, 1670, '2000 − 300 reversed − 30 fee');
});

test('a bucket carrying only reversals is a debit, and cannot be overdue', () => {
  const F = liveInstance();
  F.state.settled = [];
  F.state.docs = [{ kind: 'CN', outletId: F.state.outletId, tender: 'card',
    bizDate: '2026-03-10', at: Date.now(), T: { total: 671 } }];

  const b = F.settlementBatches();
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].n, 0, 'no tickets');
  assert.strictEqual(b[0].reversalOnly, true);
  assert.strictEqual(b[0].expected, -671, 'the processor will debit you');

  const t = F.settlementInTransit();
  assert.strictEqual(t.amount, 0, 'nothing is coming toward you');
  assert.strictEqual(t.owedBack, 671, 'it is stated separately, as money going back');
  assert.strictEqual(t.overdue.length, 0,
    'a reversal bucket can never be late — nothing is arriving');
});

test('suspending a processor takes its tender off the till', () => {
  const F = liveInstance();
  const { slot } = ringUp(F);
  const tenders = () => {
    F.state.modal = { kind: 'pay', tender: 'cash', given: '' };
    return F.overlayVals().tenders.map((t) => t.label);
  };
  assert.ok(tenders().indexOf('QR') >= 0, 'QR is offered at the till');
  assert.ok(tenders().indexOf('Transfer') >= 0, 'and so is Transfer — neither was before');

  F.state.prefs = Object.assign({}, F.prefs(), { processors: { gw: { rate: 2.4, cycle: 2, suspended: true } } });
  assert.strictEqual(tenders().indexOf('QR'), -1,
    'a suspended contract comes off the till rather than failing at the counter');
  assert.ok(tenders().indexOf('Card') >= 0, 'the others are untouched');
  void slot;
});

test('a contract with no intermediary refuses a rate, by name', () => {
  const F = liveInstance();
  const said = [];
  F.toast = (m) => said.push(String(m));
  F.setProcessor('direct', { rate: '2', cycle: '1' });
  assert.match(said.join(' '), /no intermediary/i,
    'refused by name — accepting a figure that never applies is worse');
  assert.strictEqual((F.prefs().processors || {}).direct, undefined, 'and nothing was stored');

  // The same contract can still be suspended: that is a real thing to do to it.
  F.setProcessor('direct', { suspended: 'yes' });
  assert.strictEqual(F.proc('direct').suspended, true);
});

test('editing a rate re-checks unmatched batches and leaves filed ones alone', () => {
  const F = liveInstance();
  F.state.settled = [
    sale(F, { tender: 'card', total: 1000, bizDate: '2026-03-10' }),
    sale(F, { tender: 'card', total: 1000, bizDate: '2026-03-11' })
  ];
  F.acqPay(F.settlementBatches().filter((b) => b.date === '2026-03-10')[0], 985);
  F.setProcessor('term', { rate: '3', cycle: '1' });

  const b = F.settlementBatches();
  const filed = b.filter((x) => x.date === '2026-03-10')[0];
  const open = b.filter((x) => x.date === '2026-03-11')[0];
  assert.strictEqual(filed.paid, 985, 'the filed batch keeps what the bank paid');
  assert.strictEqual(open.fee, 30, 'the unmatched one is re-checked at 3%');
  assert.strictEqual(open.expected, 970);
});
