'use strict';
/* ═══ THE SYNC CONTRACT ═════════════════════════════════════════════════════
   Every mutation in the terminal goes through queue(), which is why the
   contract is a list of op KINDS and not a list of endpoints. This asserts the
   two halves meet:

     · every kind the terminal can queue has a handler on the server, so
       nothing is silently dropped
     · the kinds that carry a consequence arrive with the payload that
       consequence needs, so nothing is silently audit-only

   The second half is the one that rots. An op that queues a label and no
   payload looks fine in the outbox, appears in the audit trail, and changes
   nothing — which is the worst failure mode available, because it is invisible.
   ═══════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const FX = require('./fixtures');
const { HANDLERS, AUDIT_ONLY } = require('../src/apply');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');

/* The 115 kinds the handoff names as the sync contract. */
const CONTRACT = [
  'access_change', 'acq_match', 'acq_reopen', 'act_as', 'add_line',
  'ai_menu_draft', 'asset_insert', 'asset_update', 'auto_lock', 'backup_create',
  'backup_run', 'bank_clear_manual', 'bank_import', 'bank_match',
  'bank_match_accept', 'bank_opening', 'bank_recon', 'brand_update',
  'category_insert', 'cfo_query', 'chain_update', 'channel_rates', 'clock_in',
  'clock_out', 'close_register', 'close_ticket', 'company_update',
  'consume_recipe', 'count_open', 'count_post', 'covers_update', 'credit_note',
  'credit_reverse', 'device_deregister', 'device_diagnostics', 'device_lock',
  'device_paired', 'device_replay', 'fire_course', 'flag_ack', 'fulfil_stage',
  'fx_rates', 'grn_priced', 'grn_query', 'guest_add', 'kds_bump',
  'kds_bump_all', 'kds_recall', 'kds_station', 'line_note', 'loyalty_update',
  'maintenance_log', 'mdr_set', 'member_upsert', 'menu_category_insert', 'menu_import',
  'menu_section_insert', 'menu_section_reorder', 'menu_section_update',
  'modifier_update', 'move_table', 'open_register', 'opex_insert',
  'outlet_switch_denied', 'par_set', 'park_bill', 'password_reset',
  'payment_run', 'period_close', 'period_reopen', 'permission_change',
  'permission_reset', 'pin_failed', 'pin_lockout', 'pin_reset', 'post_journal',
  'post_payroll', 'price_override', 'print_abandoned', 'print_failed',
  'print_retry', 'printer_state', 'promo_clamped', 'qr_banner_slot', 'qr_order',
  'qr_pay_intent', 'recipe_recost', 'recost_items', 'refund', 'reservation_',
  'reservation_insert', 'restore_run', 'resume_bill', 'revoke_sessions',
  'seat_reservation', 'seat_walkin', 'setting_change', 'sign_in',
  'sign_in_refused', 'sign_out', 'split_payment', 'stock_adjust', 'stock_query',
  'stock_return', 'stock_writeoff', 'store_reset', 'table_status',
  'table_update', 'tax_version', 'terminal_update', 'ticket_status',
  'vendor_payment', 'vendor_query', 'void_line', 'void_refused', 'yield_test'
];

function kindsInSource() {
  const out = new Set();
  const re = /this\.queue\(\s*"([a-z_]+)"/g;
  let m;
  while ((m = re.exec(SRC))) out.add(m[1]);
  // One call site builds the kind from a status, which is how the reference
  // spells the reservation lifecycle: reservation_confirmed, _arrived, _seated.
  if (/this\.queue\("reservation_" \+ status/.test(SRC)) out.add('reservation_');
  return out;
}

test('every kind in the contract has a handler on the server', () => {
  const missing = CONTRACT.filter((k) => typeof HANDLERS[k] !== 'function');
  assert.deepStrictEqual(missing, [],
    'the server would silently drop: ' + missing.join(', '));
  assert.strictEqual(CONTRACT.length, 116, 'the contract is 116 kinds');
});

test('every kind the terminal queues has a handler on the server', () => {
  const kinds = Array.from(kindsInSource()).sort();
  const orphans = kinds.filter((k) => typeof HANDLERS[k] !== 'function');
  assert.deepStrictEqual(orphans, [],
    'queued with nowhere to land: ' + orphans.join(', '));
  assert.ok(kinds.length >= 110, 'the terminal queues ' + kinds.length + ' kinds');
});

test('an op that carries a consequence carries its payload', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const queued = [];
  F.__win.KPOS_SYNC = { enqueue: (op) => { queued.push(op); return op.opId; } };

  const grab = (kind) => queued.filter((q) => q.kind === kind).pop();
  const has = (op, keys) => {
    assert.ok(op, 'no ' + JSON.stringify(keys) + ' op was queued');
    keys.forEach((k) => {
      assert.ok(op.payload && op.payload[k] !== undefined && op.payload[k] !== null,
        op.kind + ' queued without ' + k + ': ' + JSON.stringify(op.payload));
    });
  };

  // Opening the drawer.
  F.openRegister(1000, F.state.session);
  has(grab('open_register'), ['float']);

  // A dish, edited from the back office. The generic mutators are the seam for
  // every master record, so one of them proves the table.
  F.patchRows('menu', ['m1'], { price: 199 }, 'Price changed', 'menu');
  has(grab('dish_upsert'), ['id', 'name', 'price']);

  // An ingredient, from the item master.
  const item = F.item('ing_fish');
  F.patchRowsArr('items', 'ing_fish',
    item.slice(0, 10).concat([25000, 5000, 0]), 'Par raised', 'items');
  has(grab('item_upsert'), ['id', 'name', 'base']);

  // A supplier.
  F.insertRow('vendors', { id: 'v2', name: 'New Supplier', termsDays: 30 },
    'Supplier added', 'vendors');
  has(grab('vendor_upsert'), ['name']);

  // A customer, taken at the counter. This one queued a kind with no handler
  // and no payload: the toast said the customer was created, the row lived in
  // one browser, and the member portal could never let them in.
  F.insertRow('custs', { id: 'c9', name: 'Aishath Waheed', phone: '9998877',
    tier: 'Silver', credit: 500, visits: 0, spent: 0, points: 0, used: 0 },
  'Customer created', 'customers');
  const cust = grab('member_upsert');
  has(cust, ['name', 'phone', 'tier', 'credit']);
  assert.strictEqual(cust.payload.points, undefined,
    'points are the outlet\'s to award — a till that could send them could mint them');

  // A line on an open ticket. This is the op that makes a floor shared: it
  // used to queue a LABEL and no payload, so the outlet never held the ticket
  // and a bill opened on the handheld was invisible at the counter.
  F.state.activeTable = 1;
  F.state.tickets = Object.assign({}, F.state.tickets,
    { [F.state.outletId + ':1']: F.blankTicket() });
  F.addLine(F.dish ? F.dish('m1') : { id: 'm1', name: 'Test dish', price: 100 }, 2);
  const line = grab('add_line');
  has(line, ['table', 'item', 'name', 'qty', 'price', 'lid']);
  assert.match(line.payload.lid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'the line carries the id this terminal gave it, so it can be named later');

  // The sale — the one that matters.
  const slot = 1, key = F.state.outletId + ':' + slot;
  const tk = Object.assign(F.blankTicket(), {
    waiter: 'Test Cashier', party: 4, bizDate: F.today(),
    lines: [{ id: 'm1', qty: 2, note: '', split: 0, fired: true, since: 1, firedAt: Date.now() }]
  });
  F.state.tickets = Object.assign({}, F.state.tickets, { [key]: tk });
  F.state.activeTable = slot;
  F.state.register = { open: true, float: 1000, openedBy: 'u_owner', openedAt: Date.now() };
  // Through the one settle path: Orders & Tickets hands off to the till's pay
  // screen, and the cashier says what the guest handed over.
  F.ticketPanelVals({ kind: 'ticket', slot: slot }).tkPay();
  F.state.modal = Object.assign({}, F.state.modal, { given: '1000' });
  F.overlayVals().confirmPay();
  const sale = grab('sale');
  has(sale, ['bizDate', 'covers', 'net', 'tax', 'taxRate', 'taxLabel', 'total',
    'sold', 'payments', 'stockMoves', 'table']);
  assert.ok(sale.payload.payments[0].tendered >= sale.payload.total,
    'the payment records what was handed over, not only what was owed');
});

/* One number says where an order is, and every screen reads it. The pass
   bumped both lines and finished the table; Orders & Tickets printed the
   literal word "Open", because it read none of the three places the answer
   was kept — and the ticket panel kept a fourth of its own, `tk.flow`, that
   nothing else in the build ever wrote or read. */
test('the orders list follows the pass, and the pass follows the counter', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const queued = [];
  F.__win.KPOS_SYNC = { enqueue: (op) => { queued.push(op); return op.opId; } };

  const slot = 1, key = F.state.outletId + ':' + slot;
  const line = (lid, id) => ({ id: id, lid: lid, qty: 1, note: '', split: 0,
    fired: true, done: false, since: 1, firedAt: Date.now() });
  F.state.tickets = Object.assign({}, F.state.tickets, {
    [key]: Object.assign(F.blankTicket(), {
      waiter: 'Test Cashier', party: 2, bizDate: F.today(),
      lines: [line('lid-a', 'm1'), line('lid-b', 'm2')]
    })
  });

  const cellOf = () => {
    F.state.tab = Object.assign({}, F.state.tab, { ordSub: 'open' });
    const row = F.g_orders().rows[0];
    return row.cells[row.cells.length - 1];
  };
  const statusOf = () => cellOf().t;

  assert.strictEqual(statusOf(), 'In the kitchen',
    'two plates fired and none bumped — the order is with the kitchen');

  // The pass finishes both, one at a time, the way a cook does.
  const bumps = () => {
    const v = F.kdsVals();
    return v.kds.length ? v.kds[0].items : [];
  };
  F.setState({ prefs: Object.assign({}, F.prefs(), { kdsStation: 'expo' }) });
  const first = bumps();
  assert.ok(first.length, 'the pass has the table');
  first[0].bump();
  assert.strictEqual(statusOf(), 'In the kitchen',
    'one plate up is not a finished table');
  bumps()[0].bump();
  assert.strictEqual(statusOf(), 'Ready at the pass',
    'the kitchen is done — and the orders list is the screen that has to say so');

  // The bump reaches the outlet by TABLE and by LINE. It used to carry a menu
  // id, which matched no row on the server, so the bump never left the browser.
  const bump = queued.filter((q) => q.kind === 'kds_bump').pop();
  assert.ok(bump && bump.payload, 'the bump queued a payload');
  assert.ok(bump.payload.table, 'kds_bump names its table: ' + JSON.stringify(bump.payload));
  assert.ok(bump.payload.lid, 'kds_bump names its line: ' + JSON.stringify(bump.payload));

  // The other direction: the counter marks it served, and the ONE rung moves,
  // carrying the guest's tracker with it.
  F.ticketPanelVals({ kind: 'ticket', slot: slot }).tkFlows[3].go();
  assert.strictEqual(statusOf(), 'Served', 'the counter moved the same number');
  assert.strictEqual(F.ticketStage(slot), 3, 'and the panel reads it back');

  // A served table that has not paid is money still owed. Green appears once
  // on this ladder, at Ready, and it means the kitchen delivered — not that
  // the row is finished with.
  assert.deepStrictEqual(cellOf().chip, F.chip('warn'),
    'Served is amber while the bill is open — it is the row a manager chases');

  const stage = queued.filter((q) => q.kind === 'fulfil_stage').pop();
  assert.ok(stage && stage.payload && stage.payload.stage === 3,
    'the outlet is told the rung, not just an audit line: ' + JSON.stringify(stage && stage.payload));
  assert.ok(stage.payload.table, 'and which table it belongs to');

  // Dragging it back is a real correction: the food goes back on the pass.
  F.ticketPanelVals({ kind: 'ticket', slot: slot }).tkFlows[1].go();
  assert.strictEqual(statusOf(), 'In the kitchen', 'the correction moved everything back');
  assert.ok(F.state.tickets[key].lines.every((l) => !l.done),
    'and the plates are cooking again');
});

test('every queued op carries a client-generated opId', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const queued = [];
  F.__win.KPOS_SYNC = { enqueue: (op) => { queued.push(op); return op.opId; } };

  // Drive the whole sweep, which fires every handler the UI exposes.
  H.sweep(F);
  assert.ok(queued.length > 20, 'the sweep queued ' + queued.length + ' ops');
  const bad = queued.filter((q) => !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(q.opId || ''));
  assert.deepStrictEqual(bad.map((q) => q.kind), [],
    'these ops queued without a v4 opId, so a replay would double-book them');

  // And every id is distinct: a collision is two sales sharing an idempotency
  // key, which is the one bug this whole mechanism exists to prevent.
  const ids = new Set(queued.map((q) => q.opId));
  assert.strictEqual(ids.size, queued.length, 'every opId is unique');
});

test('the till does not post its own journal — the server derives it', () => {
  // The sale posts tender, revenue, discount, service, tax, rounding and COGS
  // in ONE journal, on the server, from the sale that just happened. The
  // terminal's own post_journal ops are labels for the audit trail: giving
  // them a payload would post the same legs twice.
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const queued = [];
  F.__win.KPOS_SYNC = { enqueue: (op) => { queued.push(op); return op.opId; } };
  const slot = 1, key = F.state.outletId + ':' + slot;
  F.state.tickets = Object.assign({}, F.state.tickets, {
    [key]: Object.assign(F.blankTicket(), {
      party: 2, bizDate: F.today(),
      lines: [{ id: 'm2', qty: 1, note: '', split: 0, fired: true, since: 1, firedAt: Date.now() }]
    })
  });
  F.state.activeTable = slot;
  F.state.register = { open: true, float: 1000, openedBy: 'u_owner', openedAt: Date.now() };
  F.ticketPanelVals({ kind: 'ticket', slot: slot }).tkPay();
  F.state.modal = Object.assign({}, F.state.modal, { given: '1000' });
  F.overlayVals().confirmPay();

  const journals = queued.filter((q) => q.kind === 'post_journal');
  journals.forEach((j) => {
    assert.ok(!j.payload || !j.payload.lines,
      'a till-side post_journal must not carry lines — the server already posted them');
  });
});

/* Every refund handed the operator a BLANK document. `receiptVals` had always
   had a branch that builds a credit note; the dispatch never routed
   `creditNote` to it, so the receipt chrome painted around nothing and the
   branch was unreachable — which is why nothing added to it could be seen.

   When a modal renders as an empty shell, suspect the dispatch, not the
   builder. */
test('a credit note is a document, not an empty shell', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const doc = {
    no: 'CN-0001', against: 'INV-0001', table: 'T01', date: F.today(),
    reason: 'quality', tender: 'card', by: 'Harness', note: 'Test',
    sc: 10, rate: 0, taxLabel: 'NONE',
    T: { sub: 100, svc: 10, tax: 0, total: 110 }
  };
  const v = F.overlayVals.call(Object.assign(Object.create(Object.getPrototypeOf(F)), F,
    { state: Object.assign({}, F.state, { modal: { kind: 'creditNote', doc: doc } }) }));
  assert.strictEqual(v.rcpTitle, 'CREDIT NOTE', 'the document built');
  assert.ok((v.rcpLines || []).length, 'and carries its lines');
  assert.ok(v.rcpOutlet, 'and knows which outlet issued it');
  assert.ok((v.rcpTotals || []).some((r) => /TOTAL CREDITED/.test(r.n)),
    'and totals to something');

  // The route the money takes back has to be true for every tender — a single
  // fallback to "the drawer" was lying about four of six.
  const via = (v.rcpLines || []).filter((r) => r.n === 'Returns via')[0];
  assert.ok(via, 'the document says how the money goes back');
  assert.match(String(via.v), /settlement/i, 'a card refund is off the next settlement');
  assert.match(String(F.returnsVia('cash')), /drawer/i);
  assert.match(String(F.returnsVia('credit')), /account/i);
  assert.match(String(F.returnsVia('transfer')), /transfer/i);
});

/* A screen that names one account while the journal posts another is worse
   than one that says nothing. */
test('the till names the account the ledger actually posts to', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  // Anything an intermediary is holding is a receivable until they pay it.
  ['card', 'wallet', 'qr'].forEach((k) => {
    assert.match(F.tenderAcct(k), /^1030/, k + ' is a settlement receivable');
  });
  assert.match(F.tenderAcct('credit'), /^1040/, 'customer credit is 1040');
  assert.match(F.tenderAcct('cash'), /^1010/, 'cash is in the drawer');
  assert.match(F.tenderAcct('transfer'), /^1020/, 'a transfer is bank, no intermediary');
});

/* The floor plan is the screen a waiter is actually looking at. It printed
   "Open" for every seated table whatever the kitchen had done. */
test('a floor tile says where the food is', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const slot = 1, key = F.state.outletId + ':' + slot;
  const line = (done) => ({ id: 'm1', lid: 'l' + (done ? 1 : 2), qty: 1, note: '',
    split: 0, fired: true, done: done, since: 1, firedAt: Date.now() });
  const put = (lines) => {
    F.state.tickets = Object.assign({}, F.state.tickets, {
      [key]: Object.assign(F.blankTicket(), { status: 'occupied', party: 2,
        bizDate: F.today(), lines: lines })
    });
    F.state.pane = 'floor';
    const t = (F.posVals().tables || []).filter((x) => x.label)[0];
    return t;
  };

  assert.strictEqual(put([line(false)]).chipText, 'Cooking',
    'fired and not bumped — the kitchen has it');
  const ready = put([line(true)]);
  assert.strictEqual(ready.chipText, 'Ready', 'bumped — it is at the pass');
  assert.match(String(ready.chip), /--ok-dim|--green/,
    'and it is the one green on the floor, so a waiter can read the room');
  assert.strictEqual(put([]).chipText, 'Open', 'seated with nothing fired');
});

/* The business date is the outlet's local date. `toISOString()` is UTC, and
   Malé is UTC+5 — so from 19:00 local, most of a restaurant's trading, every
   receipt and Z read was filed under yesterday while the clock in the header
   said tonight. `dayKey()` had always used local parts, so the two disagreed
   inside this one file. */
test('the terminal keeps one clock, and it is the local one', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const now = new Date();
  assert.strictEqual(F.today(), F.dayKey(now),
    'today() is the same day-key every other figure is bucketed by');
  assert.strictEqual(F.dayOf(now.getTime()), F.dayKey(now),
    'and so is the day of a timestamp');

  // 20:00 UTC is 01:00 the NEXT day in Malé. This is the direction that used
  // to lose a night's trading off the day view.
  const evening = new Date(Date.UTC(2026, 2, 10, 20, 0));
  assert.strictEqual(evening.toISOString().slice(0, 10), '2026-03-10',
    'UTC calls it the 10th');
  if (process.env.TZ === 'Indian/Maldives') {
    assert.strictEqual(F.dayOf(evening.getTime()), '2026-03-11',
      'and the till, standing in the outlet, calls it the 11th');
  }

  // No UTC day-key is left in the file except the one that is epoch-DAYS,
  // where UTC is the correct reading.
  const stray = SRC.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /toISOString\(\)\.slice\(0, 10\)/.test(l))
    .filter(([, l]) => !/86400000/.test(l));
  assert.deepStrictEqual(stray.map(([n, l]) => n + ': ' + l.trim().slice(0, 70)), [],
    'a UTC day-key is a business date filed on the wrong day');
});

test('a business date written under UTC is refiled when the session is read', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  // A sale rung at 01:00 Malé, carrying the UTC date the old code wrote.
  const at = Date.UTC(2026, 2, 10, 20, 0);
  F.__win.localStorage.setItem(F.SKEY, JSON.stringify({
    v: 3, settled: [{ no: 'INV-1', at: at, bizDate: '2026-03-10', total: 100 }]
  }));
  const back = F.restore();
  const row = (back.settled || [])[0];
  assert.ok(row, 'the row came back');
  assert.strictEqual(row.bizDate, F.dayKey(new Date(at)),
    'refiled from its own timestamp, never from now');
  if (row.bizDate !== '2026-03-10') {
    assert.strictEqual(row.bizDateWas, '2026-03-10',
      'and what it used to say is kept, so the change is answerable');
  }
});

/* No screen may report an action the build cannot take. There is no SMS or
   email transport here, and the customers screen used to toast "N portal
   invites sent by SMS" while flipping a local flag and sending nothing. */
test('nothing claims to have sent an SMS', () => {
  const claims = SRC.split('\n')
    .map((line, i) => [i + 1, line])
    // A DENIAL is the correct thing to say — "nothing was sent by SMS" is the
    // sentence this rule exists to produce, not one it should fail on.
    .filter(([, line]) => /sent by SMS|sent by sms|SMS sent|texted to/i.test(line))
    .filter(([, line]) => !/^\s*(\/\/|\*)/.test(line))
    .filter(([, line]) => !/\b(no|not|never|nothing|without)\b/i.test(line));
  assert.deepStrictEqual(claims.map(([n, l]) => n + ': ' + l.trim()), [],
    'this build has no SMS transport, so no screen may say it used one');
});

test('the audit-only kinds are named, not defaulted', () => {
  // "Not modelled yet" and "deliberately audit-only" must stay
  // distinguishable, or a gap hides inside a design decision.
  assert.ok(AUDIT_ONLY.length >= 20, 'the audit-only set is explicit');
  AUDIT_ONLY.forEach((k) => {
    assert.strictEqual(typeof HANDLERS[k], 'function', k + ' has a handler');
  });
  const overlap = AUDIT_ONLY.filter((k) => ['sale', 'refund', 'count_post',
    'grn_priced', 'post_payroll', 'open_register', 'close_register'].indexOf(k) >= 0);
  assert.deepStrictEqual(overlap, [], 'nothing consequential is audit-only');
});

/* The form sweep in test/harness.js walks a HARDCODED list, and a form that is
   not on it is a form nobody ever opens in anger. That is not hypothetical: the
   store-address form was written, wired and nearly shipped before anybody
   noticed the sweep did not know about it. */
test('every form the terminal can open is on the list the harness sweeps', () => {
  const fs = require('fs');
  const path = require('path');
  const H = require('./harness');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const from = src.indexOf('formSpec(name) {');
  const to = src.indexOf('return F[name] || null;', from);
  assert.ok(from > 0 && to > from, 'found the form spec table');

  const keys = (src.slice(from, to).match(/\n {6}[A-Za-z][A-Za-z0-9_]*: \{/g) || [])
    .map((m) => m.trim().replace(':', '').replace('{', '').trim());
  assert.ok(keys.length > 40, 'the extraction found the table, not a fragment');

  const missing = keys.filter((k) => H.FORMS.indexOf(k) < 0);
  assert.deepStrictEqual(missing, [],
    'these forms exist and are never swept: ' + missing.join(', '));

  // `aiResult` is a state key in the reference build, not a spec — counted
  // honestly rather than quietly dropped from the list.
  const stale = H.FORMS.filter((k) => keys.indexOf(k) < 0 && k !== 'aiResult');
  assert.deepStrictEqual(stale, [],
    'these are swept but no longer exist: ' + stale.join(', '));
});
