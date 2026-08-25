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
  'permission_reset', 'pin_failed', 'pin_lockout', 'pin_reset', 'plan_request', 'post_journal',
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

/* EVERY KIND, INCLUDING THE ONES NOT SPELLED AT THE OPENING BRACKET.

   This used to be `/this\.queue\(\s*"([a-z_]+)"/`, which only sees a call whose
   first character after the bracket is a quote. A kind chosen by a ternary —
   `this.queue(row ? "subrecipe_update" : "subrecipe_add", …)` — begins with an
   identifier, so it matched nothing and the kind was invisible to the contract.
   SIX kinds were hiding behind that: both sub-recipe writes, both guest
   signals and both discount events. The whole point of this file is that a
   queued kind cannot go unhandled without somebody noticing, and the check was
   quietly excusing the calls most likely to be forgotten.

   So: take the first ARGUMENT of every call — text up to the comma at bracket
   depth zero — and collect every string literal in it that has the shape of a
   kind. Concatenated suffixes ("_insert", "_update") start with an underscore
   and are deliberately excluded: those are the generic back-office fallback,
   which is a different contract. */
function kindsInSource() {
  const out = new Set();
  const CALL = 'this.queue(';
  let at = SRC.indexOf(CALL);
  while (at >= 0) {
    let i = at + CALL.length, depth = 0, q = null;
    for (; i < SRC.length; i++) {
      const ch = SRC[i];
      if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth--; }
      else if (ch === ',' && depth === 0) break;
    }
    /* A ternary's CONDITION lives in the first argument too, and its literals
       are things being compared against — `x.kind === "member" ? …` names a
       signal kind, not an op kind. Comparison operands are dropped before the
       rest is read, or the contract gains kinds nobody ever queued. */
    const firstArg = SRC.slice(at + CALL.length, i)
      .replace(/[!=]==?\s*"[^"]*"/g, '')
      .replace(/"[^"]*"\s*[!=]==?/g, '');
    const lit = /"([a-z][a-z0-9_]*)"/g;
    let m;
    while ((m = lit.exec(firstArg))) out.add(m[1]);
    at = SRC.indexOf(CALL, i);
  }
  return out;
}

test('every kind in the contract has a handler on the server', () => {
  const missing = CONTRACT.filter((k) => typeof HANDLERS[k] !== 'function');
  assert.deepStrictEqual(missing, [],
    'the server would silently drop: ' + missing.join(', '));
  assert.strictEqual(CONTRACT.length, 117, 'the contract is 117 kinds');
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
    email: 'aishath@example.mv', credit: 500, visits: 0, spent: 0, points: 0, used: 0 },
  'Customer created', 'customers');
  const cust = grab('member_upsert');
  has(cust, ['name', 'phone', 'email', 'credit']);
  assert.strictEqual(cust.payload.points, undefined,
    'points are the outlet\'s to award — a till that could send them could mint them');
  // And no tier: it is derived from those points against the published ladder
  // every time it is read, so a till sending one would be telling the outlet
  // what the outlet just told the till.
  assert.strictEqual(cust.payload.tier, undefined,
    'a tier is worked out, never sent: ' + JSON.stringify(cust.payload));

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

/* A double-tap on the settle button used to book the sale twice. The button
   has no disabled state and queue() mints a fresh opId on every call, so the
   server's op_log could not dedup the two — the evening's bill went through
   twice and the drawer over-counted. The guard reads the modal state, which
   the first tap flipped to "settled" synchronously, and returns the second. */
test('the settle button cannot book the same sale twice', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const queued = [];
  F.__win.KPOS_SYNC = { enqueue: (op) => { queued.push(op); return op.opId; } };

  const slot = 1, key = F.state.outletId + ':' + slot;
  const tk = Object.assign(F.blankTicket(), {
    waiter: 'Test Cashier', party: 4, bizDate: F.today(),
    lines: [{ id: 'm1', qty: 2, note: '', split: 0, fired: true, since: 1, firedAt: Date.now() }]
  });
  F.state.tickets = Object.assign({}, F.state.tickets, { [key]: tk });
  F.state.activeTable = slot;
  F.state.register = { open: true, float: 1000, openedBy: 'u_owner', openedAt: Date.now() };
  F.ticketPanelVals({ kind: 'ticket', slot: slot }).tkPay();
  F.state.modal = Object.assign({}, F.state.modal, { given: '1000' });

  // Two taps on the still-mounted button, before the DOM re-renders. The
  // overlay closure is captured ONCE, exactly as a real double-tap reuses the
  // same button's handler.
  const pay = F.overlayVals();
  pay.confirmPay();
  pay.confirmPay();

  const sales = queued.filter((q) => q.kind === 'sale');
  assert.strictEqual(sales.length, 1, 'one tap, one sale — not ' + sales.length);
  const closes = queued.filter((q) => q.kind === 'close_ticket');
  assert.strictEqual(closes.length, 1, 'and the ticket is closed once');
  assert.strictEqual(F.state.modal.kind, 'settled', 'the modal settled, and stayed settled');
});

/* A GUEST WITH A SCREEN READER ORDERS FROM THE SAME QR AS EVERYONE ELSE. The
   two public portals shipped with no aria, no labels and no document language:
   every control announced as "button", and the reader guessed the language of
   a page full of Maldivian names. This pins the labelling so it cannot quietly
   rot back — it is a floor, not a certificate: real assistive-technology
   testing is still outstanding and is recorded as such. */
test('the public portals name their controls and declare their language', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'app', f), 'utf8');
  for (const f of ['guest.html', 'member.html', 'index.html']) {
    const src = read(f);
    assert.match(src, /<html lang="[a-z]{2}"/,
      f + ' does not say what language it is in');
    // Every input carries an accessible name. A placeholder is not one: it
    // vanishes the moment the guest types.
    const inputs = src.match(/<input\b[^>]*>/g) || [];
    const nameless = inputs.filter((t) => !/aria-label=|aria-labelledby=/.test(t));
    assert.deepStrictEqual(nameless.map((t) => t.slice(0, 60)), [],
      f + ' has inputs a screen reader cannot name');
  }
  // And the guest portal's glyph-only controls say what they do.
  const g = read('guest.html');
  ['Clear the search', 'Fewer people sharing the bill', 'More people sharing the bill']
    .forEach((label) => assert.ok(g.indexOf('aria-label="' + label + '"') > 0,
      'the guest portal lost the label: ' + label));
});

/* THE HALF-BUILT RECIPE USED TO BE THE PRICE OF A MISSING INGREDIENT. When the
   search found nothing there was no way to create the item without leaving the
   modal — and the lines entered so far live in that modal, so leaving discarded
   them. The audit brief names this exact case: a user must be able to create a
   missing ingredient from any ingredient-selection workflow without losing what
   they have entered. */
test('a missing ingredient can be created mid-recipe, and the recipe survives', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const queued = [];
  F.__win.KPOS_SYNC = { enqueue: (op) => { queued.push(op); return op.opId; } };

  const dish = (FX.kpos().MENU || [])[0];
  assert.ok(dish, 'the fixture has a dish to cost');
  F.state.modal = { kind: 'recipeb', dish: dish.id, lines: [], q: '' };

  // One line already entered — this is what used to be thrown away.
  const firstItem = (F.__win.KPOS_RAW.items || []).filter((it) => F.aiCostable(it))[0];
  assert.ok(firstItem, 'the fixture has a costable item');
  F.state.modal = Object.assign({}, F.state.modal, { lines: [[firstItem[0], 100]] });

  // Now search for something that does not exist, and create it inline.
  F.state.modal = Object.assign({}, F.state.modal,
    { q: 'Dhonkeyo Powder', newCost: '250', newUnit: 'KG' });
  const before = (F.__win.KPOS_RAW.items || []).length;
  F.overlayVals().rbNewGo();

  const created = queued.filter((q) => q.kind === 'item_upsert').pop();
  assert.ok(created, 'the item reaches the outlet, not just this browser');
  assert.strictEqual((F.__win.KPOS_RAW.items || []).length, before + 1, 'and the master has it');

  assert.ok(F.state.modal, 'the recipe modal is STILL OPEN — that is the whole fix');
  assert.strictEqual(F.state.modal.kind, 'recipeb');
  assert.strictEqual(F.state.modal.lines.length, 2,
    'the line already entered survived, and the new item was added beside it');
  assert.strictEqual(F.state.modal.lines[0][0], firstItem[0], 'in the order they were added');
  assert.strictEqual(F.state.modal.q, '', 'and the search is cleared for the next one');

  // A cost is required: an ingredient costed at nothing makes the dish look free.
  F.state.modal = Object.assign({}, F.state.modal, { q: 'Nother Thing', newCost: '0' });
  const n = queued.filter((q) => q.kind === 'item_upsert').length;
  F.overlayVals().rbNewGo();
  assert.strictEqual(queued.filter((q) => q.kind === 'item_upsert').length, n,
    'a zero cost is refused rather than defaulted');
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

/* ═══ A PHONE NEVER DECIDES MONEY ═══════════════════════════════════════════
   It shows what the till recorded, and it posts intent. Where a phone was
   found computing its own version, that was a defect.
   ═══════════════════════════════════════════════════════════════════════ */
test('a phone cannot witness a card payment', () => {
  const fs = require('fs');
  const path = require('path');
  const guest = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'guest.html'), 'utf8');

  // The guest app built "G" + the last four digits of the guest's own number
  // and posted it as `ref`. The till stamped it onto the settled row AS THE
  // PROCESSOR'S APPROVAL CODE, so an unreferenced card sale read as
  // corroborated on the reconciliation screen — defeating the one check that
  // exists to catch it.
  assert.match(guest, /guestRef:/,
    'the phone posts a way to call the table back, named as such');
  const bill = /requestBill\(\)\s*\{[\s\S]*?\n  \}/.exec(guest);
  assert.ok(bill, 'found the pay intent');
  assert.doesNotMatch(bill[0], /(^|[^a-zA-Z])ref:/,
    'and never a bare `ref` — a reference on a settled row is the processor\'s');

  // The till must not fall through to it either.
  assert.doesNotMatch(SRC, /ref: m\.ref \|\| \(\(tk \|\| \{\}\)\.payIntent/,
    'the settled row takes only what a terminal or an operator supplied');

  // Through the real thing: a table that asked to pay by QR settles with an
  // empty reference unless somebody actually supplied one.
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const slot = 1, key = F.state.outletId + ':' + slot;
  F.state.tickets = Object.assign({}, F.state.tickets, {
    [key]: Object.assign(F.blankTicket(), {
      party: 2, bizDate: F.today(),
      payIntent: { tender: 'qr', tip: 5, due: 861, guestRef: 'G1234' },
      lines: [{ id: 'm1', qty: 1, note: '', split: 0, fired: true, since: 1, firedAt: Date.now() }]
    })
  });
  F.state.activeTable = slot;
  F.state.register = { open: true, float: 1000, openedBy: 'u', openedAt: Date.now() };
  F.state.modal = { kind: 'pay', tender: 'qr', given: '' };

  // The till STATES what the table asked for rather than silently taking it.
  const pay = F.overlayVals();
  assert.match(String(pay.asked), /asked to pay by QR/, 'the request is shown');
  assert.match(String(pay.asked), /5% tip/);
  assert.match(String(pay.asked), /G1234/, 'and the guest reference, as a callback');
  assert.match(String(pay.asked), /whole table/,
    'MVR 861 exceeds this bill, and two money figures that disagree are explained');

  pay.confirmPay();
  assert.strictEqual(F.state.settled[0].ref, '',
    'nobody witnessed an approval, so the row carries no reference');
});

/* The tracker is this app's central promise, and it had never worked. */
test('the guest tracker reads the stage INDEX, and the row\'s own ladder', () => {
  const fs = require('fs');
  const path = require('path');
  const guest = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'guest.html'), 'utf8');

  // `indexOf(2)` on a list of WORDS returns −1, clamps to 0, and the tracker
  // shows "Received" for ever — on every table, whatever the kitchen does.
  assert.doesNotMatch(guest, /STAGES\.indexOf\(fs\.stage\)/,
    'the stage is an index; looking a number up in a list of words finds nothing');
  assert.match(guest, /fs\.steps/,
    "and the ladder comes off the row, so renaming a stage at the till renames it here");

  // A till writes "07"; a phone holds 7. Comparing raw strings meant tables
  // 1 to 9 never found their own row.
  assert.match(guest, /sameTable\(/, 'the table number is normalised on both sides');
});

/* Publishing is a contract, not a dump — but a contract has to carry what the
   other end needs. */
test('the till publishes the tender set and the tables it just closed', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  F.state.settled = [{ outletId: F.state.outletId, no: 'INV-9', table: 'T01',
    at: Date.now(), total: 843.5, tender: 'cash', covers: 2, customer: '' }];
  F.publishGuest();
  const pub = JSON.parse(F.__win.localStorage.getItem(F.GUESTKEY));

  const ks = (pub.tenders || []).map((t) => t.k);
  assert.ok(ks.indexOf('qr') >= 0 && ks.indexOf('transfer') >= 0,
    'transfer and QR are offered — the till takes them and the phone never did');
  assert.ok((pub.tenders || []).filter((t) => t.k === 'credit')[0].memberOnly,
    'a table with no membership has no account to charge');

  // A ticket vanishes the moment it settles, so the phone was told nothing had
  // happened — its answer to the one thing the guest had just done.
  assert.ok(pub.closed && pub.closed['T01'], 'the closed table is published');
  assert.strictEqual(pub.closed['T01'].no, 'INV-9');
  assert.strictEqual(pub.closed['T01'].total, 843.5);
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

/* ═══ AN INVITATION IS AN EVENT ══════════════════════════════════════════
   The invite was a boolean flipped in bulk — no channel, no time, no sender,
   no resend, no revoke — and on a row where the field was simply ABSENT it
   claimed the customer already had access. Every one of those is a sentence
   a screen said and could not back. ═══════════════════════════════════════ */
function withCustomers(rows, portal) {
  const k = FX.kpos();
  k.CUSTOMERS = rows;
  if (portal) k.PORTAL = portal;
  return H.makeInstance({ kpos: k, raw: FX.raw(), real: FX.real() });
}
const LIVE_PORTAL = { base: 'kashikeyopos.com', origin: 'https://sea-house.kashikeyopos.com' };

const NEVER_ASKED = {
  id: 'c1', name: 'Hassan Moosa', phone: '9995544', email: '',
  points: 0, visits: 0, spent: 0, credit: 0, used: 0, last: '', seen: '',
  invitedVia: '', invitedTo: '', invitedAt: '', invites: 0, revoked: ''
};
const LET_GO = {
  id: 'c2', name: 'Mariyam Zahira', phone: '9991100', email: 'm@example.mv',
  points: 0, visits: 0, spent: 0, credit: 0, used: 0, last: '', seen: '',
  invitedVia: 'email', invitedTo: 'm@example.mv', invitedAt: '2026-08-22',
  invites: 2, revoked: '2026-08-22'
};

test('an invitation is composed before it is sent', () => {
  const F = withCustomers([NEVER_ASKED]);
  const v = F.modalVals({ kind: 'customer', id: 'c1' });
  const labels = (v.detailActs || []).map((a) => a.label);
  assert.ok(labels.some((l) => /Invite to the portal/.test(l)),
    'one control, because the channel is chosen beside the message: ' + labels.join(' | '));

  // The form names all three channels, and its foot IS the message.
  const spec = F.formSpec('invite');
  const chan = (spec.fields || []).filter((f) => f.k === 'chan')[0];
  assert.ok(chan, 'a channel is picked in the form');
  assert.deepStrictEqual((chan.options || []).map((o) => o.v).join(','),
    'email,viber,whatsapp', 'all three, by name');
  assert.strictEqual(spec.footPre, true,
    'the foot is the artefact, so it keeps its line breaks');
});

/* An invitation IS a link, so a deploy that cannot spell an absolute one has
   no invitation to send. The preview must say what the send will say — a
   message that reads fine and then refuses is worse than one that says up
   front it cannot go. */
test('a deploy with no public address says so before it is asked to send', () => {
  const F = withCustomers([Object.assign({}, NEVER_ASKED, { email: 'h@example.mv' })]);
  F.state.modal = { kind: 'form', form: 'invite', edit: F.member('c1') };
  F.state.formVals = { chan: 'email' };
  const foot = F.formSpec('invite').foot();
  assert.match(foot, /PUBLIC_URL/, 'and names what to set: ' + foot);
  assert.ok(foot.indexOf('/join/') < 0,
    'without showing a link that would land nowhere: ' + foot);
  // Still useful: the card's own address, which a server can read out.
  assert.match(foot, /\/m\//, foot);
});

test('with a public address the preview shows the link the server would spell', () => {
  const k = FX.kpos();
  k.CUSTOMERS = [Object.assign({}, NEVER_ASKED, { email: 'h@example.mv' })];
  k.PORTAL = { base: '', origin: 'https://kashikeyopos.com' };
  const F = H.makeInstance({ kpos: k, raw: FX.raw(), real: FX.real() });
  F.state.modal = { kind: 'form', form: 'invite', edit: F.member('c1') };
  F.state.formVals = { chan: 'email' };
  const foot = F.formSpec('invite').foot();
  assert.match(foot, /https:\/\/kashikeyopos\.com\/join\/MV-/, foot);
  assert.ok(foot.indexOf('PUBLIC_URL') < 0, 'and nothing to fix: ' + foot);
});

test('the message proves it came from a restaurant that knows them', () => {
  const known = Object.assign({}, NEVER_ASKED, {
    name: 'Hassan Moosa', points: 1842, email: 'hassan@example.mv'
  });
  const F = withCustomers([known], LIVE_PORTAL);
  const msg = F.inviteMessage(known, 'whatsapp', 'MV-abc-1');
  // Four things a bulk sender would not have.
  assert.match(msg.body, /Hassan/, 'their own name');
  assert.match(msg.body, /1,842/, 'their balance, as a quantity and not a serial number');
  assert.ok(msg.body.indexOf('1842') < 0, 'never unseparated: ' + msg.body);
  assert.match(msg.body, /Sent by /, 'a person to ask for at the counter');
  // One paragraph, because a notification shows two lines.
  assert.ok(msg.body.length < 320, 'app channels stay short: ' + msg.body.length);
  assert.strictEqual(msg.subject, '', 'and carry no subject');

  const mail = F.inviteMessage(known, 'email', 'MV-abc-1');
  assert.match(mail.subject, /1,842 points are already yours/, mail.subject);
});

test('a member with no points is invited without a balance claim', () => {
  const F = withCustomers([NEVER_ASKED], LIVE_PORTAL);
  const msg = F.inviteMessage(NEVER_ASKED, 'whatsapp', 'MV-abc-1');
  assert.ok(msg.body.indexOf('0 points') < 0,
    'a zero balance argues against the invitation rather than for it: ' + msg.body);
  assert.ok(msg.body.indexOf('points on it already') < 0, msg.body);
  const mail = F.inviteMessage(NEVER_ASKED, 'email', 'MV-abc-1');
  assert.match(mail.subject, /your membership is ready/, mail.subject);
});

test('the sender is a name, never a login handle', () => {
  const F = withCustomers([NEVER_ASKED]);
  F.state.session = { id: 'u1', user: 'nashwa', name: 'Nashwa Ali', role: 'SuperAdmin' };
  assert.strictEqual(F.meName(), 'Nashwa Ali',
    '"Sent by nashwa" is a system talking about itself');
});

test('a channel the customer has no address for is refused by name', () => {
  // On a deploy that CAN send — otherwise the governing refusal is the
  // deploy's, and telling a waiter to add an email would send them to fix
  // something that still would not go.
  const F = withCustomers([NEVER_ASKED], LIVE_PORTAL);
  // Refused in the form's own foot, where the operator is choosing, and
  // refused again on send. The control never vanishes — one that does teaches
  // an operator the app is broken.
  F.state.modal = { kind: 'form', form: 'invite', edit: NEVER_ASKED };
  F.state.formVals = { chan: 'email' };
  const foot = F.formSpec('invite').foot();
  assert.match(foot, /Hassan Moosa/, 'named in the preview: ' + foot);
  assert.match(foot, /email address/, 'and which address is missing');

  F.__toasts.length = 0;
  F.sendInvite(NEVER_ASKED, 'email');
  const said = (F.__toasts[0] || {}).t || '';
  assert.match(said, /Hassan Moosa/, 'refused BY NAME on send: ' + said);

  // Viber rides the mobile they already gave, so nothing is missing there.
  F.state.formVals = { chan: 'viber' };
  const ok = F.formSpec('invite').foot();
  assert.ok(ok.indexOf('no mobile number') < 0,
    'the number is on the row: ' + ok);
  assert.match(ok, /Viber to 9995544/, ok);
});

/* The Email channel offered a send and the refusal said "add one on the
   customer first" — and no screen in the terminal had the field. Every row's
   email was null, so the channel could never be used by anybody, and the
   instruction pointed at nothing. */
test('the customer form collects the address the invitation needs', () => {
  const F = withCustomers([NEVER_ASKED]);
  const spec = F.formSpec('cust');
  const keys = (spec.fields || []).map((f) => f.k);
  assert.ok(keys.indexOf('email') >= 0,
    'the Email channel needs somewhere to get an address: ' + keys.join(', '));
  assert.ok(keys.indexOf('phone') >= 0, 'and the identity is still the phone');
  // Optional, because a customer taken at a counter has given a name and a
  // number. Making it mandatory turns adding a guest into an interrogation.
  const em = spec.fields.filter((f) => f.k === 'email')[0];
  assert.match(String(em.label), /optional/i, 'and it says so: ' + em.label);
});

test('a tier cannot be typed over, because it is derived', () => {
  const F = withCustomers([NEVER_ASKED]);
  const keys = (F.formSpec('cust').fields || []).map((f) => f.k);
  assert.ok(keys.indexOf('tier') < 0,
    'tier is worked out from points every time it is asked for, so a dropdown '
    + 'here writes a column no screen reads and the panel keeps saying Bronze');
});

test('an address that cannot sign anyone in is refused before it is saved', () => {
  const F = withCustomers([NEVER_ASKED]);
  const spec = F.formSpec('cust');
  F.__toasts.length = 0;
  spec.onSave({ name: 'Ali Rasheed', phone: '+960 7770001', email: 'not-an-address', credit: '0' });
  assert.match((F.__toasts[0] || {}).t || '', /not an email address/,
    'a typo is caught while the guest is still standing there');

  // Empty is fine and is not an error.
  F.__toasts.length = 0;
  spec.onSave({ name: 'Ali Rasheed', phone: '+960 7770001', email: '   ', credit: '0' });
  assert.ok(((F.__toasts[0] || {}).t || '').indexOf('not an email') < 0,
    'no address is a normal customer, not a mistake');
});

test('one address cannot sign two customers in', () => {
  // Both `member_code_set` and `member_code_take` resolve on
  // `phone = $1 OR lower(email) = lower($1)` and take one row silently, so a
  // shared address is one guest being let into another's card.
  const held = Object.assign({}, LET_GO, { email: 'shared@example.mv', revoked: '' });
  const F = withCustomers([NEVER_ASKED, held]);
  const spec = F.formSpec('cust');
  F.__toasts.length = 0;
  spec.onSave({ name: 'Ali Rasheed', phone: '+960 7770001', email: 'SHARED@example.mv', credit: '0' });
  const said = (F.__toasts[0] || {}).t || '';
  assert.match(said, /Mariyam Zahira/, 'refused BY NAME, however it was cased: ' + said);
});

test('a channel refused for want of an address opens the field that fixes it', () => {
  const F = withCustomers([NEVER_ASKED]);
  F.__toasts.length = 0;
  F.sendInvite(F.member('c1'), 'email');
  assert.match((F.__toasts[0] || {}).t || '', /Hassan Moosa/, 'still refused by name');
  const m = F.state.modal || {};
  assert.strictEqual(m.kind, 'form', 'and lands on a form, not on a dead end');
  assert.strictEqual(m.form, 'cust', 'the customer\'s own record');
  assert.strictEqual((m.edit || {}).id, 'c1', 'opened ON them, not on a blank one');
});

test('the customer panel says what is on file', () => {
  const F = withCustomers([NEVER_ASKED]);
  const rows = JSON.stringify(F.modalVals({ kind: 'customer', id: 'c1' }).detailRows || []);
  assert.match(rows, /None on file/,
    'an absent address is readable, not inferred from a refusal');
  const withMail = withCustomers([Object.assign({}, NEVER_ASKED, { email: 'h@example.mv' })]);
  assert.match(JSON.stringify(withMail.modalVals({ kind: 'customer', id: 'c1' }).detailRows || []),
    /h@example\.mv/, 'and a present one is on the record');
});

test('a revoked customer reads Revoked, never Not invited', () => {
  const F = withCustomers([LET_GO]);
  const v = F.modalVals({ kind: 'customer', id: 'c2' });
  const portal = (v.detailRows || []).filter((r) => /Portal/.test(JSON.stringify(r)))[0];
  const line = JSON.stringify(portal || {});
  assert.match(line, /Revoked/, 'the row says what happened: ' + line);
  assert.ok(line.indexOf('Not invited') < 0,
    'a member who was let go and one who was never asked are different answers');

  const labels = (v.detailActs || []).map((a) => a.label);
  assert.ok(labels.some((l) => /fresh invitation/.test(l)),
    'the history is still there, so the next one is a resend: ' + labels.join(' | '));
  assert.ok(labels.some((l) => /revoked/i.test(l)),
    'and the revocation control states the state it is already in');

  const never = withCustomers([NEVER_ASKED])
    .modalVals({ kind: 'customer', id: 'c1' });
  assert.match(JSON.stringify((never.detailRows || [])
    .filter((r) => /Portal/.test(JSON.stringify(r)))[0] || {}), /Not invited/,
    'and a customer nobody asked reads exactly that');
  assert.ok((never.detailActs || []).every((a) => !/revok/i.test(a.label)),
    'there is nothing to withdraw from someone who was never let in');
});

/* The till used to queue its own redemption journal — "Dr 2300 Loyalty
   liability / Cr 4000" — and both halves were wrong: 2300 is the service
   charge pool, and 4000 is till-owned, so the server refused the op on every
   single redemption and it retried from the outbox forever. The ledger legs
   of a redemption are the SERVER's, derived from the sale op like every other
   leg of the sale. The only journal a till may compose is the manual form. */
/* Every journal the terminal queues carries its lines and its memo. A call
   with a label and no payload is an ANNOUNCEMENT — the server refuses it, it
   retries from the outbox forever, and the books get nothing. That was every
   post_journal in this file, including the manual form's own. */
test('every queued journal carries its lines and its memo', () => {
  const calls = SRC.match(/this\.queue\("post_journal"[\s\S]{0,900}?\);/g) || [];
  assert.strictEqual(calls.length, 5,
    'five composers: the manual form, two bank charges, the match difference,'
    + ' and the repair cost — a new one must justify itself here');
  calls.forEach((call) => {
    assert.ok(call.indexOf('lines:') >= 0,
      'a journal without lines is an announcement: ' + call.slice(0, 120));
    assert.ok(call.indexOf('memo:') >= 0,
      'a journal without a memo is unauditable: ' + call.slice(0, 120));
  });
  // And the ops that carry money carry it.
  const bare = (kind) => new RegExp(
    'this\\.queue\\("' + kind + '",[^;]*"[a-z_]+"\\);').test(SRC);
  ['vendor_payment', 'settle_credit', 'acq_match'].forEach((k) => {
    assert.ok(!bare(k), k + ' is never queued without its payload');
  });
});

test('the settle path composes no journal of its own', () => {
  // The sale op IS the journal: the server derives every leg — tender,
  // revenue, tax, rounding, the loyalty release and accrual — from the sale's
  // own components. The strings this pins are the three journals the till
  // used to queue at settle, all naming till-owned accounts (2300-for-loyalty,
  // which is the SERVICE CHARGE pool; 4900; the tender accounts), all refused
  // by the server's guard, on every settled bill, forever.
  assert.ok(SRC.indexOf('pts redeemed on') < 0,
    'no redemption journal is queued from the till');
  assert.ok(SRC.indexOf('Dr 2300 Loyalty') < 0 && SRC.indexOf('2300 Loyalty') < 0,
    'nothing names the service-charge pool as the loyalty liability');
  assert.ok(!/queue\("post_journal", "Cash rounding/.test(SRC),
    'no rounding journal is queued at settle — the sale op carries rounding');
  assert.ok(!/queue\("post_journal", "Journal posted/.test(SRC),
    'no tender journal is queued at settle — an announcement is not a journal');
});

test('a split bill remembers every share\'s tender, not just the last', () => {
  // The sale op used to carry one payment leg — the closing share's tender
  // for the whole bill — so a table split cash-then-card booked its entire
  // total to whichever tender happened to close it: wrong drawer, wrong
  // receivable, wrong settlement batch. The server journals each method to
  // its own account and always has; only the till was collapsing them.
  assert.ok(SRC.indexOf('settledRow.shares = (m.shares || []).concat') >= 0,
    'the closing share joins the ones already paid');
  assert.ok(/const shareLeg = \{ method: m\.tender === "wallet"/.test(SRC),
    'each interim share records its own leg as it pays');
  assert.ok(/paidRound: r2\(\(m\.paidRound \|\| 0\) \+ roundDiff\)/.test(SRC),
    'and its own cash rounding — the bill\'s rounding is the sum, not the last');
  assert.ok(/row\.shares && row\.shares\.length\) \? row\.shares/.test(SRC),
    'bookSale sends the shares as the payment legs');
  assert.ok(/x\.shares\.filter\(\(sh\) => sh\.method === "cash"\)/.test(SRC),
    'the drawer expectation counts only the cash shares of a split');
});

test('a printed docket is a claim a printer backed, or a spool that says so', () => {
  // The old runJob marked every job "done" on a 620ms timer — a claimed
  // print no printer made, on an app whose doctrine is that a reported send
  // that was not made is worse than no send at all.
  assert.ok(SRC.indexOf('kashikeyo-escpos.js') >= 0 && SRC.indexOf('kpos-print.js') >= 0,
    'the terminal loads the composer and the transports');
  assert.ok(/KPOS_PRINT\.send\(job\.target, bytes, cfg\)/.test(SRC),
    'a configured transport actually sends the bytes');
  assert.ok(/state: "spooled"/.test(SRC),
    'no transport means SPOOLED — never "done" on a timer');
  assert.ok(!/this\.patchJob\(id, \{ state: "done", doneAt: Date\.now\(\) \}\);\n    \}, 620\)/.test(SRC),
    'the timer that claimed prints is gone');
  // The drawer plugs into the receipt printer, so opening it is a print —
  // and only CASH opens it: a card receipt popping the drawer is how cash
  // walks.
  assert.ok(/kick: p\.tender === "cash"/.test(SRC), 'cash kicks, card does not');
  const ESC = fs.readFileSync(path.join(__dirname, '..', 'app', 'kashikeyo-escpos.js'), 'utf8');
  assert.ok(/module\.exports = api/.test(ESC) && /root\.KASHIKEYO_ESCPOS = api/.test(ESC),
    'one composer, loaded by browser and server alike');
});

test('one install\'s outbox never replays into another', () => {
  // The incident this fences: a terminal that queued demo ops against one
  // database (staging) later signs into another (production) whose outlet
  // happens to share the same small integer id — and the outbox, keyed on
  // that id, replays the demo night into the real store's books.
  const API = fs.readFileSync(path.join(__dirname, '..', 'app', 'kashikeyo-api.js'), 'utf8');
  const BOOT = fs.readFileSync(path.join(__dirname, '..', 'src', 'bootstrap.js'), 'utf8');

  assert.ok(/INSTALL: \(\(chainSettings\.rows\.find/.test(BOOT),
    'the bootstrap publishes the install\'s uuid');
  // installId, not install: the METHOD is called install() and holding the
  // identity on the same name overwrote it with a string.
  assert.ok(/install: this\.installId \|\| this\.local\("install"\)/.test(API),
    'every queued op is stamped with the install it was queued against');
  assert.ok(/^\s*install\(\)\s*\{/m.test(API),
    'and the install() call still exists to be called by name');
  assert.ok(API.indexOf('queued against a different install') >= 0
    && API.indexOf('queued before this terminal knew which install') >= 0,
    'a stranger op PARKS with its reason — it is never silently pushed');
  assert.ok(/row\.install = this\.installId/.test(API),
    'Send it again adopts the op into this install, because a person decided');
  assert.ok(API.indexOf('kpos-install-changed') >= 0,
    'a change of install is announced');
  assert.ok(SRC.indexOf('kpos-install-changed') >= 0
    && SRC.indexOf('its local history was set aside') >= 0,
    'and the terminal sheds the other install\'s trade state, saying so');
});

test('a poison op is parked, visible, and never silently resent', () => {
  const API = fs.readFileSync(path.join(__dirname, '..', 'app', 'kashikeyo-api.js'), 'utf8');
  const BRIDGE = fs.readFileSync(path.join(__dirname, '..', 'app', 'kpos-bridge.js'), 'utf8');

  // The lane exists: refusals are counted, the eighth parks the op, and a
  // parked op leaves the replay on both ends of the loop.
  assert.ok(/DEAD_TRIES = 8/.test(API), 'the allowance is stated, not implied');
  assert.ok(/attempts >= KashikeyoAPI\.DEAD_TRIES/.test(API), 'refusals are counted against it');
  assert.match(API, /outletId === this\.outletId && !o\.parked/,
    'a parked op is not sent again');
  assert.match(API, /\.filter\(function \(o\) \{ return !o\.parked; \}\)/,
    'parked rows alone do not keep the five-second retry loop hot');

  // Parking is announced, and the terminal listens.
  assert.ok(API.indexOf('kpos-op-parked') >= 0, 'the outbox says so when it gives up');
  const SRC2 = SRC;
  assert.ok(SRC2.indexOf('kpos-op-parked') >= 0, 'the terminal hears it');
  assert.ok(SRC2.indexOf('Send it again') >= 0 && SRC2.indexOf('Discard it') >= 0,
    'a parked op offers exactly its two ways forward');

  // Discarding is a decision with a record: the audit op replaces the op in
  // the replay, carries what was given up, and the server files it.
  assert.ok(/kind: "op_discarded"/.test(API), 'the discard replays as its own op');
  assert.ok(/of: row\.opId/.test(API) && /error: row\.error/.test(API),
    'the record names what was discarded and why it was refused');
  assert.strictEqual(typeof HANDLERS.op_discarded, 'function', 'the server files it');
  assert.ok(AUDIT_ONLY.indexOf('op_discarded') >= 0, 'audit-only by design, not by gap');

  // Both decisions ride the bridge, so the terminal never touches IndexedDB.
  assert.ok(/retryOp/.test(BRIDGE) && /discardOp/.test(BRIDGE), 'the bridge carries both');
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

  /* A form spec is usually an object literal, but nothing stops one being
     COMPUTED — `plan: (function (self) { ... })(this)` is a perfectly ordinary
     way to write one that needs a value twice. The first version of this
     extractor matched only `name: {`, so a computed spec was invisible to it
     and excused entirely — the same blind spot the op-kind extractor had with
     a ternary, and the same fix: match the key, not one shape of value. */
  const keys = (src.slice(from, to).match(/\n {6}[A-Za-z][A-Za-z0-9_]*: *[{(]/g) || [])
    .map((m) => m.trim().replace(/[:{(]/g, '').trim());
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

/* ═══ FOCUS IS DRAWN, AND THE MEASUREMENT IS NOT ALWAYS AVAILABLE ═══════════
   test/a11y.test.js measures this properly, in a real browser against a live
   server — and skips clean where neither exists, which is most CI runs. So the
   one thing that cannot be allowed to silently disappear is pinned statically:
   the rule itself. Every control in all three apps carries `outline:none` in
   its inline style for layout reasons, so a deleted `:focus-visible` block
   takes the keyboard's only visible cue with it and nothing else notices. */
test('every app draws a keyboard focus ring', () => {
  const files = {
    'app/kashikeyo.css': '!important',   // must beat 22 inline outline:none
    'app/guest.html': null,
    'app/member.html': null,
    'app/onboarding.html': null,
    'app/account.html': null
  };
  Object.entries(files).forEach(([f, needs]) => {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    // The SELECTOR, not the word: every one of these files explains itself
    // in a comment that mentions :focus-visible, and a comment styles nothing.
    const at = src.search(/:focus-visible\s*\{/);
    assert.ok(at > -1, f + ' draws no :focus-visible ring — a keyboard user '
      + 'cannot see what they are about to activate');
    if (needs) {
      // Somewhere in the file, a focus ring that WINS. The terminal's fields
      // each carry outline:none inline, and an inline declaration beats a
      // plain stylesheet rule — which is exactly how this app shipped with a
      // :focus-visible block that drew nothing on any input for months.
      assert.ok(/:focus-visible[^{]*\{[^}]*!important/.test(src),
        f + ' declares a focus ring that its own inline outline:none overrides');
    }
  });
});


/* ═══ THE CLOCK THAT ORDERS ONE OUTLET'S WORK ═══════════════════════════════
   A Lamport clock only means anything if it is RECEIVED as well as sent. This
   one never was: each device counted its own outbox from one, and the count
   went BACKWARDS whenever that outbox drained or was trimmed — so two tills
   produced two independent sequences that both restarted, and "sort by
   lamport" ordered a batch against numbers meaningless outside the device
   that wrote them. */
test('the sync clock is monotonic, persisted, and raised by what it receives', () => {
  const API = fs.readFileSync(path.join(__dirname, '..', 'app', 'kashikeyo-api.js'), 'utf8');
  const IDX = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const BRIDGE = fs.readFileSync(path.join(__dirname, '..', 'app', 'kpos-bridge.js'), 'utf8');
  const SYNC = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sync.js'), 'utf8');

  assert.ok(/this\.local\("lamport", next\)/.test(API),
    'the clock is persisted, so a drained outbox cannot walk it back');
  assert.ok(/seen\(n\)/.test(API) && /if \(top\) this\.seen\(top\)/.test(API),
    'and every poll raises it past what the outlet has already accepted');
  assert.ok(/tick: function \(atLeast\)/.test(BRIDGE),
    'the bridge exposes it, because the terminal is where ops are numbered');
  assert.ok(/KPOS_SYNC\.tick\(floor\)/.test(IDX),
    'queue() asks the outlet\'s clock, not its own outbox');
  assert.ok(/const floor = prev\.reduce/.test(IDX),
    'with the outbox high-water mark kept as a floor for a bridgeless terminal');

  /* And the SERVER's tiebreak is the batch's own order. It is not cosmetic:
     ops with no lamport all compare equal, and sorting those by anything else
     adds a line to a ticket that has not been opened yet. */
  assert.ok(/a\.i - b\.i/.test(SYNC),
    'equal lamports keep the order the operator did the work in');
  assert.ok(!/localeCompare/.test(SYNC),
    'and never an arbitrary one — an id sort shuffles an unstamped batch');
});

/* The two tables every signed-in terminal reads twelve times a minute had
   nothing beyond a primary key, so both were sequential scans on tables that
   only ever grow. It costs nothing on an install opened last week, which is
   exactly why it survives to production. */
test('the tables the five-second poll reads are indexed for what it asks', () => {
  const P = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations',
    '003_outlet_provision.sql'), 'utf8');
  const M = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations',
    '030_the_polled_tables.sql'), 'utf8');
  [['guest_order_open', 'accepted_at IS NULL'],
    ['guest_request_open', 'ack_at IS NULL'],
    ['stock_move_sale', 'sale_id IS NOT NULL']].forEach(([name, pred]) => {
    // In the template, so a NEW outlet is provisioned with them...
    assert.ok(P.includes(name) && P.includes(pred),
      '003 provisions ' + name + ' as a partial index');
    // ...and in the migration, so every outlet that already exists gets them.
    assert.ok(M.includes(name), '030 adds ' + name + ' to the outlets that exist');
  });
});

/* Four writes and three of them are consequences: turning registration off has
   to reach the outlets and the rate versions, and crediting the account has to
   reach the company. Run as four statements on a pooled connection, a crash
   between any two left the install in a state the database's own guards call
   impossible — and neither half is discoverable without looking. */
test('the company step is one transaction, not four statements', () => {
  const ONB = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes',
    'onboarding.js'), 'utf8');
  const step = ONB.slice(ONB.indexOf("r.post('/company'"), ONB.indexOf("async function baseCurrency"));
  assert.ok(step.includes("c.query('BEGIN')") && step.includes("c.query('COMMIT')"),
    'the company step opens and closes a transaction');
  assert.ok(step.includes("ROLLBACK"), 'and rolls back rather than half-writing');
  assert.ok(step.includes('c.release()'), 'and always gives the connection back');
  assert.ok(!/await owner\(\)\.query/.test(step),
    'nothing inside it reaches past the transaction to a fresh connection');
});

/* ═══ THE CONNECTION THAT BYPASSES BOTH BELTS ═══════════════════════════════
   owner() is the role that ignores the per-outlet schema grant AND the RLS
   policies, so where a REQUEST handler reaches for it is a list rather than a
   habit. CLAUDE.md said "no request handler imports it", which was not true of
   the code and had not been for a long time — and an invariant nobody keeps is
   worse than one nobody wrote down, because it stops anyone looking.

   Six files, each answering a question that cannot be asked from inside one
   outlet. A seventh has to justify itself here. */
test('only the six named routers reach for the owner connection', () => {
  const dir = path.join(__dirname, '..', 'src', 'routes');
  const allowed = {
    'account.js': 'migration 011 revokes the account plane from every outlet role',
    'onboarding.js': 'steps 1-3 run before an outlet or a session exists',
    'auth.js': 'the lock screen asks before anybody has signed in',
    'guest.js': 'resolves a handle TO an outlet — the outlet is the answer',
    'outlet.js': 'handle uniqueness and GST registration span every outlet',
    'platform.js': 'aggregates for the seller, key-guarded and audited'
  };
  const uses = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).filter((f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // The IMPORT, not the word: several files name it in a comment explaining
    // why they do not use it, and a comment connects to nothing.
    return /require\('\.\.\/db'\)[^\n]*\bowner\b|\bowner\b[^\n]*require\('\.\.\/db'\)/.test(src)
      && /\bowner\(\)/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''));
  });
  uses.forEach((f) => {
    assert.ok(allowed[f], 'src/routes/' + f + ' reaches past both isolation belts'
      + ' — if that is deliberate, name it and its reason in this test and in'
      + ' CLAUDE.md, because an unexplained owner() is how a leak gets written');
  });
  Object.keys(allowed).forEach((f) => {
    assert.ok(uses.includes(f), 'src/routes/' + f + ' no longer uses owner() —'
      + ' take it off the list rather than leaving a stale exception standing');
  });
});

/* ═══ THE SEVEN SMALL ONES ═══════════════════════════════════════════════════
   Each of these is cheap to get wrong again, and none of them is visible from
   the screen it affects — which is the definition of something a test has to
   hold rather than a reviewer. */
test('a credential never rides in a query string', () => {
  const ACC = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'account.js'), 'utf8');
  assert.ok(!/req\.query \|\| \{\}\)\.at/.test(ACC),
    'the ?at= fallback is gone — a token in a URL is a token in the proxy log,'
    + ' the browser history and every Referer a no-referrer policy misses');
  assert.ok(/authorization/.test(ACC), 'the header is still how an account is named');
});

test('a check violation speaks English, not a constraint name', () => {
  const OUT = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'outlet.js'), 'utf8');
  assert.ok(/CHECK_SAYS/.test(OUT) && /e\.constraint/.test(OUT),
    'a declarative check is translated by name');
  assert.ok(!/code === '23514'\) return res[^\n]*e\.message/.test(OUT),
    'and Postgres\'s own "violates check constraint \\"outlet_slug_is_a_handle\\""'
    + ' never reaches a browser');
});

test('a declaration is complete or it is not published', () => {
  const AP = fs.readFileSync(path.join(__dirname, '..', 'src', 'apply.js'), 'utf8');
  const fn = AP.slice(AP.indexOf('async function publishDeclaration'),
    AP.indexOf('async function republishUsing'));
  assert.ok(/MAX_DEPTH = 12/.test(fn), 'the walk goes deeper than a real kitchen nests');
  assert.ok(/if \(frontier\.length\) \{/.test(fn) && /declaration_truncated/.test(fn),
    'and if it still has not finished, nothing is published: a PARTIAL'
    + ' declaration replacing a complete one is worse than no update');
  assert.ok(fn.indexOf('declaration_truncated') < fn.indexOf('UPDATE item SET allergens'),
    'the refusal comes before the write, not after it');
});

test('the veg mark carries a word, not only a colour and a shape', () => {
  const IDX = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  assert.ok(/vegLabel: m\.veg \? "Vegetarian"/.test(IDX), 'the label exists');
  assert.ok(/aria-label="\{\{ m\.vegLabel \}\}"/.test(IDX),
    'and reaches a screen reader, a colour-blind eye and a grayscale print');
});

test('voiding food that is already cooking asks twice', () => {
  const IDX = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  assert.ok(/_voidArm !== l\.lid/.test(IDX), 'a fired line arms before it voids');
  assert.ok(/_voidArmT = setTimeout/.test(IDX),
    'and the arm expires, so a stray tap cannot leave it loaded for the next person');
  assert.ok(/l\.fired && this\._voidArm/.test(IDX),
    'an unfired line still goes on the first tap — asking about a keystroke'
    + ' teaches an operator to tap through the question that matters');
});

test('the outbox waits rather than pushing into an install it cannot name', () => {
  const API = fs.readFileSync(path.join(__dirname, '..', 'app', 'kashikeyo-api.js'), 'utf8');
  // pending() is defined ABOVE flush() in this file, so slice forward from
  // flush to the next method rather than to a name that is already behind us.
  const from = API.indexOf('async flush()');
  const flush = API.slice(from, API.indexOf('async ', from + 20));
  assert.ok(/if \(!inst\) \{[\s\S]*return null;/.test(flush),
    'an unnamed install holds the flush — signing in flushes, and signing in'
    + ' happens before the first bootstrap, which is exactly the window the'
    + ' fence used to sit out');
  assert.ok(/_heldFor/.test(flush), 'and says why it is holding rather than doing nothing');
});

/* ═══ A YIELD IS AN OUTLET FACT ══════════════════════════════════════════════
   grossQty = net / (yield × (1 − waste)) decides how much stock every sale
   deducts. That factor lived in `state.local` — per-device, never synced — with
   a regex on the ingredient's NAME as the fallback, and the op meant to carry a
   measurement was queued with no payload at all. Three invisible consequences:
   two tills deducted different quantities for one dish, clearing a browser
   reverted a measurement to a guess, and the server could never reproduce what
   a sale consumed. */
test('a measured yield leaves the browser it was measured in', () => {
  const IDX = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const AP = fs.readFileSync(path.join(__dirname, '..', 'src', 'apply.js'), 'utf8');
  const BOOT = fs.readFileSync(path.join(__dirname, '..', 'src', 'bootstrap.js'), 'utf8');

  assert.ok(/queue\("yield_test",[\s\S]{0,400}?\{ ing: String\(id\), y: y, w: w/.test(IDX),
    'the op carries its measurement — it used to be queued bare, so the trail'
    + ' recorded a yield of zero against no ingredient');

  const h = AP.slice(AP.indexOf('H.yield_test'), AP.indexOf('H.grn_receive'));
  assert.ok(/UPDATE ingredient SET yield_pct/.test(h),
    'and the outlet writes it down rather than only logging it');
  assert.ok(/y > 0 && y <= 1/.test(h) && /w >= 0 && w < 1/.test(h),
    'a figure that is not a measurement is refused, not stored');

  assert.ok(/r\.yield_pct == null \? null : num\(r\.yield_pct\)/.test(BOOT),
    'the bootstrap publishes it — null when unassessed, never 1, because a'
    + ' guess must not be published as a measurement');

  const y = IDX.slice(IDX.indexOf('yieldOf(id) {'), IDX.indexOf('netFactor(id)'));
  assert.ok(y.indexOf('it[13]') > y.indexOf('state.local.yields'),
    'a local measurement is read first (it may not have synced yet)');
  assert.ok(y.indexOf('it[13]') < y.indexOf('KPOS_YIELD.shipped'),
    'but the OUTLET\'s figure beats the shipped estimate — that is the fix.'
    + ' The estimate now comes from the file the server reads too, so the'
    + ' fallback is the same fallback on both sides');

  assert.ok(/const held = this\.state\.local\.yields/.test(IDX)
    && /if \(it && it\[13\] != null\) \{ dropped\+\+; return; \}/.test(IDX),
    'and the local copy is a holding pen: dropped once the outlet publishes'
    + ' one, so a stale override cannot fork the stock ledger');
});

/* ═══ THE PROVISIONING TEMPLATE IS A format() STRING ═════════════════════════
   003 builds every outlet's schema by passing one enormous SQL body through
   PL/pgSQL's format(), so `%` is not a character in it — it is a directive. A
   single stray one (a comment saying "100%", most naturally) makes
   provision_outlet() raise "unrecognized format() type specifier" and a new
   outlet cannot be created at all.

   Nothing about the file looks like a format string while you are editing the
   table definitions in the middle of it, which is exactly why this is a test
   rather than a note. Only %1$I (the schema name) and %% (an escaped sign) are
   legal. */
test('nothing in the outlet template is mistaken for a format directive', () => {
  const P = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations',
    '003_outlet_provision.sql'), 'utf8');
  /* Only the $ddl$-quoted bodies — the rest of the file is ordinary PL/pgSQL
     with its own format() calls, whose %I and %L are correct where they are. */
  const bad = [];
  const blocks = P.split(/\$ddl\$/);
  let at = 0;
  blocks.forEach((block, n) => {
    const lineNo = P.slice(0, at).split('\n').length;
    at += block.length + 5;
    if (n % 2 === 0) return;                       // outside a $ddl$ body
    block.split('\n').forEach((line, i) => {
      // Consume the legal forms; anything left is a directive by accident.
      const rest = line.replace(/%1\$I/g, '').replace(/%%/g, '');
      if (rest.includes('%')) bad.push((lineNo + i) + ': ' + line.trim().slice(0, 90));
    });
  });
  assert.deepStrictEqual(bad, [],
    'a bare % in the provisioning template breaks provision_outlet() for every'
    + ' future outlet — use %% or reword:\n  ' + bad.join('\n  '));
});

/* ═══ A BATCH THE KITCHEN MAKES ══════════════════════════════════════════════
   recipe_line.sub_item_id has referenced item(id) since 003, and nothing ever
   wrote one — so it was a foreign key with no possible referent and a dish
   drawing on a batch could not be stored at all. The terminal carried three
   batches hard-coded in its source plus per-browser edits, and the ops meant to
   record one had no handler and no payload. */
test('a sub-recipe is written, published, and kept off the dish grid', () => {
  const AP = fs.readFileSync(path.join(__dirname, '..', 'src', 'apply.js'), 'utf8');
  const BOOT = fs.readFileSync(path.join(__dirname, '..', 'src', 'bootstrap.js'), 'utf8');
  const IDX = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');

  assert.strictEqual(typeof HANDLERS.subrecipe_add, 'function', 'it lands somewhere');
  assert.strictEqual(HANDLERS.subrecipe_update, HANDLERS.subrecipe_add,
    'and saving again corrects the batch rather than forking it');

  const h = AP.slice(AP.indexOf('H.subrecipe_add'), AP.indexOf('H.recipe_update'));
  assert.ok(/is_batch/.test(h), 'a batch says it is one — a batch and a hidden'
    + ' dish are both off_menu, and inferring the difference is a guess');
  assert.ok(/publishDeclaration/.test(h),
    'and its allergens reach every dish that draws on it');

  assert.ok(/MENU: items\.rows\.filter\(\(r\) => !r\.is_batch\)/.test(BOOT),
    'the dish grid, the guest menu and the KDS never see a batch');
  assert.ok(/SUBS: items\.rows\.filter\(\(r\) => r\.is_batch\)/.test(BOOT),
    'and it is published on its own list instead');

  assert.ok(/const published = \(K\(\) \|\| \{\}\)\.SUBS/.test(IDX),
    'the terminal reads the outlet\'s batches rather than only its own');
});

/* The extractor above is the whole contract: if it cannot see a kind, nothing
   checks that the kind lands anywhere. It used to read only a literal at the
   opening bracket, which excused every call whose kind is chosen by a ternary
   — six of them, including both sub-recipe writes. */
test('the contract can see a kind that is chosen, not spelled', () => {
  const kinds = kindsInSource();
  ['subrecipe_add', 'subrecipe_update', 'guest_signal', 'member_signal',
    'discount_applied', 'discount_cleared', 'kds_bump_all', 'kds_recall']
    .forEach((k) => assert.ok(kinds.has(k), k + ' is invisible to the contract'));
  // And the ternary's CONDITION is not mistaken for a kind.
  ['member', 'reward'].forEach((k) => assert.ok(!kinds.has(k),
    '"' + k + '" is something being compared against, not an op'));
});

/* ═══ HIDING A DISH AND 86-ING ONE ARE DIFFERENT DECISIONS ═══════════════════
   The terminal has always spoken of `hidden` (a standing menu decision) and
   `off` (tonight's stock), and the bootstrap published NEITHER — it published
   `offMenu` and `soldOutReason`. So both controls wrote a local flag, queued an
   op, and were wiped by the next bootstrap. The op made it worse: it derived
   BOTH offMenu and active from `off`, and never sent `hidden` at all. */
test('the two ways a dish comes off sale each survive a bootstrap', () => {
  const IDX = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const BOOT = fs.readFileSync(path.join(__dirname, '..', 'src', 'bootstrap.js'), 'utf8');
  const AP = fs.readFileSync(path.join(__dirname, '..', 'src', 'apply.js'), 'utf8');
  const OUT = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'outlet.js'), 'utf8');

  assert.ok(/hidden: !!r\.off_menu, off: !!r\.sold_out_reason/.test(BOOT),
    'the bootstrap publishes both in the words the terminal reads');

  const map = IDX.slice(IDX.indexOf('menu: ["dish_upsert"'), IDX.indexOf('items: ["item_upsert"'));
  assert.ok(/offMenu: !!r\.hidden/.test(map), 'the toggle sends the decision it makes');
  assert.ok(/soldOutReason: r\.off \?/.test(map), 'and 86 sends a stock-out');
  assert.ok(!/offMenu: !!r\.off\b/.test(map) && !/active: r\.off \?/.test(map),
    '86-ing a dish no longer hides it or deactivates it');

  assert.ok(/menuVisible\(m\) \{ return !m\.hidden && !m\.offMenu/.test(IDX),
    'the grid filters on the decision, from either side of a half-finished sync');

  assert.ok(/off_menu = coalesce\(\$15, item\.off_menu\)/.test(AP),
    'a save that says nothing about it does not put a hidden dish back');

  assert.ok(/WHERE active AND NOT off_menu AND NOT is_batch/.test(OUT),
    'and a guest is offered neither a hidden dish nor a batch');
});

/* ═══ ONE YIELD TABLE, NOT TWO ══════════════════════════════════════════════
   The server re-derives the till's recipe expansion to check it. A check
   computed from a DIFFERENT table is not a check — it is a second opinion,
   and the disagreement would present as a stock discrepancy on every bill in
   the shop. So the table lives in app/kashikeyo-yield.js and both runtimes
   read that one file, exactly as they do for the allergen rules.

   This is the same defect shape as the two allergen tables with different key
   vocabularies ("shellfish" vs "crustacean"), and it is pinned the same way. */
test('the till and the server read one yield table', () => {
  const src = SRC;

  // The terminal must LOAD it, or window.KPOS_YIELD is undefined and every
  // recipe expansion throws on the first bill.
  assert.match(src, /<script src="\.\/kashikeyo-yield\.js"><\/script>/,
    'the page loads the shared table');

  // And it must not carry a copy. A second table here is the whole defect.
  const inline = src.slice(src.indexOf('YIELD_TABLE'), src.indexOf('YIELD_TABLE') + 4000);
  assert.ok(!/\[\/tuna\|reef fish/.test(inline),
    'the regexes live in the shared file, not inlined here as well');
  assert.match(src, /YIELD_TABLE\(\)\s*\{\s*return \(window\.KPOS_YIELD/,
    'and the accessor reads the shared one');

  // The three functions the expansion turns on all delegate, so a change to
  // the rule cannot reach one runtime and not the other.
  ['netFactor', 'grossQty', 'shipped'].forEach((fn) => {
    assert.ok(src.indexOf('window.KPOS_YIELD.' + fn) > 0,
      'the terminal reaches for the shared ' + fn + '()');
  });

  // The server reads the same file as a module.
  const apply = fs.readFileSync(path.join(__dirname, '..', 'src', 'apply.js'), 'utf8');
  assert.match(apply, /require\('\.\.\/app\/kashikeyo-yield\.js'\)/,
    'the server requires it rather than restating it');
  assert.ok(/YIELD\.grossQty\(/.test(apply),
    'and derives its own expansion through it');

  // The harness loads it too — without that the whole terminal is untestable
  // and the failure is a bare "cannot read property of undefined".
  const harness = fs.readFileSync(path.join(__dirname, 'harness.js'), 'utf8');
  assert.ok(harness.indexOf('kashikeyo-yield.js') > 0,
    'the vm gets it as well, or every screen test dies on the first expansion');
});

test('the derivation is bounded, and a partial answer never wins', () => {
  const apply = fs.readFileSync(path.join(__dirname, '..', 'src', 'apply.js'), 'utf8');
  /* An unbounded UNION ALL over a recipe that references itself does not
     error — it hangs, holding the sale's transaction open. */
  assert.match(apply, /w\.depth < \$3/,
    'the recursive walk carries a depth guard');
  assert.match(apply, /const DERIVE_DEPTH = \d+/, 'and the bound is named');

  /* The three ways the derivation declines, each of which must leave the
     till's own figures alone rather than overwrite them with a partial
     answer: an unknown item, a walk that hit the cap, and nothing sold. */
  ['does not carry', 'nests deeper than', 'nothing sold'].forEach((why) => {
    assert.ok(apply.indexOf(why) > 0, 'it says why it declined: ' + why);
  });
  assert.match(apply, /const useDerived = derived\.complete && derived\.moves\.length > 0;/,
    'and only a COMPLETE derivation replaces what the till sent');
  assert.match(apply, /qtyOff = useDerived && supplied\.length/,
    'while a divergence still needs two numbers to be a divergence');
});

/* ═══ A TRIAL THE CUSTOMER CAN SEE, AND ONLY THE SELLER CAN MOVE ════════════
   The product is sold one install per customer, and the commercial state of
   that customer used to live ONLY in the seller's registry — on a screen the
   customer cannot open. So a trial ending was an event that happened somewhere
   else, and the first they heard of it was a phone call.

   The wiring that fixes it has four ends, and every one of them is a place it
   could quietly come undone: the plane that holds it, the door that writes it,
   the payload that carries it to the till, and the notice that renders it. */
test('the licence is readable by the outlet and writable only by the platform', () => {
  const mig = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'migrations', '033_the_licence_plane.sql'), 'utf8');

  /* It is NOT a row in chain.setting, and that is the whole design: settings
     are writable by any rank-4 admin, so a licence kept there is a text field
     an admin can type themselves a year into. */
  assert.match(mig, /CREATE TABLE IF NOT EXISTS chain\.licence/);
  assert.match(mig, /FORCE ROW LEVEL SECURITY/,
    'the table forces RLS, so even its owner is filtered');
  assert.match(mig, /CREATE POLICY licence_read ON chain\.licence FOR SELECT/,
    'the outlet may read it — the till has to render the countdown');
  assert.match(mig, /REVOKE INSERT, UPDATE, DELETE ON chain\.licence/,
    'and may not write it: protection by absence of grant, the same belt the'
    + ' account plane uses');

  /* A role created LATER must land in the same place, or the fence holds for
     today's outlets and not for the one opened next month. */
  const prov = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'migrations', '003_outlet_provision.sql'), 'utf8');
  assert.match(prov, /GRANT SELECT ON chain\.licence TO %I/,
    'a newly provisioned outlet can read it');
  assert.match(prov, /REVOKE INSERT, UPDATE, DELETE ON chain\.licence FROM %I/,
    'and cannot write it either');
});

test('the platform door reports the licence and is the only thing that sets it', () => {
  const pf = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'platform.js'), 'utf8');

  assert.match(pf, /r\.post\('\/licence'/, 'there is a write side');
  // Both halves of the same key check as the read side — a write door that is
  // easier to open than the read door beside it is the whole vulnerability.
  const write = pf.slice(pf.indexOf("r.post('/licence'"));
  assert.match(write, /keyOk\(req\)/, 'guarded by PLATFORM_KEY');
  assert.match(write, /ok === null\) return res\.status\(404\)/,
    'unset key, no door — a 404, like the read');
  assert.match(write, /kind !== 'trial' && ends/,
    'a paid install with a countdown is refused by name rather than stored:'
    + ' the till would otherwise have to render "Paid · 3 days left"');
  /* Mission Control reconciles on every dashboard load, which is what makes
     the copy self-healing. If each of those wrote a trail row the real change
     would be unfindable among them. */
  assert.match(write, /const moved =/, 'an unchanged push writes no trail');

  assert.match(pf, /licence: await readLicence\(o\)/, 'the summary reports it back');
  assert.match(pf, /planRequest: await readPlanRequest\(o\)/,
    'and reports whether the customer has asked for a plan — the one thing on'
    + " the seller's screen somebody has to act on");
});

test('the till is told, and never blocked', () => {
  const boot = fs.readFileSync(path.join(__dirname, '..', 'src', 'bootstrap.js'), 'utf8');
  assert.match(boot, /LICENCE: \(function \(\) \{/, 'the bootstrap publishes it');
  assert.match(boot, /if \(!l\) return null;/,
    'no licence is published as null — an install nobody sold shows no notice,'
    + ' rather than a countdown somebody invented');
  assert.match(boot, /today\(ctx\)/,
    "days are counted on the OUTLET's own calendar, or a trial expires at seven"
    + ' in the evening because the container is in UTC');

  /* NOTHING IN THE TERMINAL MAY GATE ON THE LICENCE. This is the promise the
     copy makes in four places — "nothing switches off" — and a promise the
     code does not keep is worse than no promise. */
  const lic = SRC.slice(SRC.indexOf('licenceNotice()'), SRC.indexOf('planAsked()'));
  assert.ok(lic.length > 200, 'found the notice');
  assert.ok(!/return\s*;\s*\/\/\s*block|disabled|readOnly|cannotSell/.test(lic),
    'the notice decides what to SAY, never what to allow');
  ['licence()', 'licenceNotice()'].forEach((fn) => {
    assert.ok(SRC.indexOf(fn) > 0, 'the terminal has ' + fn);
  });
  // Owner only: whether the business pays for its software is not a cashier's
  // to read, let alone to act on.
  assert.match(SRC, /if \(lic && this\.rank\(\) >= 5\)/,
    'the Today signal is rank 5');
  assert.match(SRC, /this\.rank\(\) >= 5 && this\.licence\(\)/,
    'and so is the Settings card');
});

test('asking for a plan grants nothing and is readable back', () => {
  const ap = fs.readFileSync(path.join(__dirname, '..', 'src', 'apply.js'), 'utf8');
  const h = ap.slice(ap.indexOf('H.plan_request'), ap.indexOf('H.item_upsert'));
  assert.ok(h.length > 100, 'the handler exists');

  /* It must not touch chain.licence. A plan a customer can award themselves is
     not a plan, and this is the one handler with any reason to reach for it. */
  assert.ok(h.indexOf('chain.licence') < 0,
    'the handler grants nothing — the consequence is the seller opening'
    + ' Mission Control, not a row in this database');

  assert.match(h, /INSERT INTO chain\.setting \(key, value\) VALUES \('plan_request'/,
    'the ask is recorded where the TILL can read it back, so the control can'
    + ' say "you asked on the 3rd" rather than offering to ask again');
  assert.match(h, /await log\(c, 'plan_request'/,
    'and on the trail as well: settings hold the latest ask, the trail holds'
    + ' every one, and a support call six weeks later needs the second');
  assert.match(h, /PLAN_WANTS\.includes/,
    'an unrecognised choice is recorded rather than refused — the customer has'
    + ' asked either way, and losing the ask over a vocabulary mismatch would'
    + ' be the worst outcome of pressing that button');
});

test('Mission Control pushes the licence and hands the install over', () => {
  const p = fs.readFileSync(path.join(__dirname, '..', 'panel', 'server.js'), 'utf8');

  /* THE SAME DATE RULE THE APP KEEPS. Without this, a Postgres `date` arrives
     as a JS Date and String(d).slice(0, 10) yields "Tue Sep 08" — which is
     exactly what made the first licence push fail, refused by the install as
     not a date. */
  assert.match(p, /types\.setTypeParser\(1082/,
    'the panel reads a date as the text it is, like src/db.js');

  assert.match(p, /function pushLicence/, 'it pushes');
  assert.match(p, /licenceDiffers\(want, \(p\.summary \|\| \{\}\)\.licence\)/,
    'only when the two disagree — reconciling on every load must cost a request'
    + ' and never a row');
  assert.match(p, /customer_note/,
    'what the CUSTOMER reads is its own column, never the seller\'s private notes');
  assert.ok(!/note: String\(row\.notes/.test(p),
    'and the private notes are never what gets pushed');

  assert.match(p, /function handoverMessage/, 'the customer is told their install exists');
  const msg = p.slice(p.indexOf('function handoverMessage'), p.indexOf('/* ── pushing the licence'));
  assert.ok(/Your address/.test(msg) && /Your setup code/.test(msg),
    'carrying the two things they need');
  assert.ok(!/password/i.test(msg) || /deliberately does not contain one/.test(msg),
    'and never a password: they set their own on their own install');
  assert.match(p, /require\('\.\.\/src\/email'\)/,
    'through the app\'s own email seam — a second transport is a second place'
    + ' for a send to fail silently');
});

/* An unresolved platform reference is not a configuration. Both services take
   the transport from the environment, and on Railway a variable may be written
   as a reference to another service — the LITERAL survives when the service
   name inside the braces is wrong, non-empty and truthy. Left alone that reads
   as configured, and every send comes back a 401 that blames the key when the
   fault is the name. */
test('a dangling platform reference is named, not sent with', async () => {
  const EMAIL = require('../src/email');
  const keep = { k: process.env.RESEND_API_KEY, f: process.env.EMAIL_FROM };
  try {
    const say = async (k, f) => {
      process.env.RESEND_API_KEY = k;
      process.env.EMAIL_FROM = f;
      return (await EMAIL.send({ to: 'x@example.com', subject: 's' })).reason;
    };
    assert.match(await say('', ''), /no transport configured/,
      'nothing set is still the ordinary, honest fallback');
    assert.match(await say('${{svc.RESEND_API_KEY}}', 'a@b.c'), /unresolved platform reference/,
      'a dangling key is named by what is actually wrong with it');
    assert.match(await say('re_key', '${{svc.EMAIL_FROM}}'), /unresolved platform reference/,
      'and so is a dangling from-address');
    assert.strictEqual(EMAIL.configured(), false,
      'either one dangling means not configured — never a doomed request');
  } finally {
    if (keep.k === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = keep.k;
    if (keep.f === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = keep.f;
  }
});

/* ═══ THE NAMES THE MAIL TRANSPORT TAKES ════════════════════════════════════
   Stores live on `<handle>.kashikeyopos.com` behind a WILDCARD, so every name
   under the base domain already answers whether anybody meant it to or not.
   That is what makes a new store work the moment its handle is taken, and it
   is also why "is this name free" cannot be answered by looking it up.

   The mail provider wants some of those names: SPF is published at `send`, and
   click tracking wants a CNAME at the tracking subdomain. Neither was
   reserved, so a store could have taken `send` or `track`, laminated it onto
   forty table cards, and had its portal broken the day somebody added the DNS
   record the provider asked for. */
test('a store cannot take a name the mail transport needs', () => {
  const mig = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations',
    '034_reserve_the_mail_names.sql'), 'utf8');

  /* `send` and `track` are the two that are actually claimed by DNS records
     today; the rest are the names a provider reaches for next. */
  ['send', 'track', 'noreply', 'links', 'click', 'bounce', 'unsubscribe',
    'dkim', 'dmarc'].forEach((n) => {
    assert.ok(mig.indexOf("('" + n + "'") > 0, n + ' is reserved');
  });
  assert.match(mig, /ON CONFLICT \(name\) DO NOTHING/,
    're-running it is a no-op, like 012 and 027');

  /* A store that somehow already holds one keeps trading. Taking a handle away
     from a business that has printed it is not a migration's call — but it is
     named on the trail so somebody can have the conversation. */
  assert.match(mig, /handle_now_reserved/,
    'an existing holder is named rather than evicted');
  assert.ok(!/DELETE FROM chain\.outlet|UPDATE chain\.outlet SET slug/.test(mig),
    'and nothing renames or removes a live store');
});
