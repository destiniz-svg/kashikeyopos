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
  'device_paired', 'device_replay', 'door_priced', 'door_receipt', 'fire_course', 'flag_ack', 'fulfil_stage',
  'fx_rates', 'grn_priced', 'grn_query', 'guest_add', 'kds_bump',
  'kds_bump_all', 'kds_recall', 'kds_station', 'line_note', 'loyalty_update',
  'maintenance_log', 'mdr_set', 'member_upsert', 'menu_category_insert',
  'menu_category_reorder', 'menu_category_update', 'menu_import',
  'menu_section_insert', 'menu_section_reorder', 'menu_section_update',
  'modifier_remove', 'modifier_update', 'move_table', 'open_register', 'opex_insert',
  'outlet_brand', 'outlet_switch_denied', 'par_set', 'park_bill', 'password_reset',
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
  assert.strictEqual(CONTRACT.length, 123, 'the contract is 123 kinds');
});

test('every kind the terminal queues has a handler on the server', () => {
  const kinds = Array.from(kindsInSource()).sort();
  const orphans = kinds.filter((k) => typeof HANDLERS[k] !== 'function');
  assert.deepStrictEqual(orphans, [],
    'queued with nowhere to land: ' + orphans.join(', '));
  /* A FLOOR, not a target — it exists so a broken extractor cannot pass by
     seeing nothing. It came down by two when the three `menu_section_*` writes
     were replaced by the one `menu_category_*` seam that actually reaches the
     table the bootstrap reads. */
  assert.ok(kinds.length >= 108, 'the terminal queues ' + kinds.length + ' kinds');
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

  /* A MENU SECTION. Three screens wrote one and every one of them queued its
     op with NO PAYLOAD — and two named `menu_section`, a different table from
     the `menu_category` the bootstrap publishes and `item.category_id`
     references. So the outlet refused each for want of a name, the toast said
     "Section created", the section lived in one browser, and the first dish
     saved into it was refused by the foreign key on every retry until the
     outbox parked it. That is what a live store reported. */
  F.setCatMeta('mains', { name: 'Main plates', color: '#c8553d' }, 'Main plates updated');
  const cat = grab('menu_category_insert');
  has(cat, ['id', 'name']);
  assert.strictEqual(cat.payload.colour, '#c8553d',
    'the colour reaches every terminal, not one browser: ' + JSON.stringify(cat.payload));
  assert.ok(cat.payload.station, 'and the station its dishes fire to');

  // CREATING one, through the shipped modal's own save handler rather than a
  // retyped copy of it. This is the screen a store used, and the op it sent
  // carried nothing at all.
  const catModal = { kind: 'catb', id: null, c: { name: 'Short Eats & Snacks',
    color: '#c8553d', icon: 'starter', station: 'hot', hidden: false } };
  F.state.modal = catModal;
  F.modalVals(catModal).cbSave();
  const made = grab('menu_category_insert');
  has(made, ['id', 'name', 'icon', 'colour', 'station']);
  assert.strictEqual(made.payload.id, 'short-eats-snacks',
    'the id the dish will reference: ' + JSON.stringify(made.payload));
  assert.strictEqual(made.payload.name, 'Short Eats & Snacks');

  // And the dish that follows names that section — the save that was refused
  // for ever, because the section it names had never reached the outlet.
  F.state.modal = null;
  F.insertRow('menu', { id: 'm_bajiya', name: 'Bajiya', cat: 'short-eats-snacks',
    price: 120, station: 'hot', recipe: [] }, 'Dish created · Bajiya', 'menu_items');
  const bajiya = grab('dish_upsert');
  has(bajiya, ['id', 'name', 'price']);
  assert.strictEqual(bajiya.payload.cat, made.payload.id,
    'the dish points at the section the outlet was just sent');

  // The rail's order is the outlet's. Without the order the handler walked an
  // empty array and answered success — a control that says it did something.
  F.moveCat('mains', 1);
  const ord = grab('menu_category_reorder');
  assert.ok(ord && Array.isArray(ord.payload.order) && ord.payload.order.length > 1,
    'the reorder carries the order: ' + JSON.stringify(ord && ord.payload));

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
  // A floor, not a census: it exists so that a sweep which silently stopped
  // reaching the handlers cannot pass. It went from 21 to 20 when pinning the
  // sidebar stopped queueing anything — a device preference is not the shop's.
  assert.ok(queued.length >= 20, 'the sweep queued ' + queued.length + ' ops');
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

  /* PERSISTED UNDER A DEVICE KEY, NOT AN OUTLET'S. This assertion used to
     match `this.local("lamport", next)` — the CALL, not the storage — and
     stayed green for months while the property was false: local() is
     namespaced by outlet and short-circuits when none is selected, so on a
     terminal that had not signed in the clock ticked in memory and persisted
     nothing, restarting at one on every reload. A static check that matches a
     call site cannot see that the callee returns early. The browser test in
     test/runtime.test.js is what found it, the first time it was ever allowed
     to run. */
  assert.ok(/var LAMPORT_KEY = "kashikeyo\.lamport"/.test(API),
    'the clock has a key of its own, because it is the device\'s and not an outlet\'s');
  assert.ok(/localStorage\.setItem\(LAMPORT_KEY/.test(API),
    'the clock is persisted, so a drained outbox cannot walk it back');
  assert.ok(!/this\.local\("lamport"/.test(API),
    'and never through the outlet-namespaced accessor, which drops it before sign-in');
  assert.ok(/kashikeyo\\\.o\\d\+\\\.lamport/.test(API),
    'a device upgrading across that change reads its old number as a FLOOR,'
    + ' so no number is ever re-issued');
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
test('only the named routers reach past the isolation belts', () => {
  const dir = path.join(__dirname, '..', 'src', 'routes');

  /* owner() is the BUSINESS database's superuser connection: it bypasses both
     belts inside one customer. Five files, each answering a question no outlet
     role can be scoped to ask. */
  const allowed = {
    'onboarding.js': 'steps 1-3 run before an outlet or a session exists',
    'auth.js': 'the single-database fallback, where there is only one database'
      + ' to be right about',
    'platform.js': 'aggregates for the seller, key-guarded and audited'
  };

  /* ownerForOutlet() IS A THIRD PRIVILEGE, and it gets its own list because it
     answers a question owner() cannot: WHICH DATABASE. owner() is the one this
     PROCESS dialled, and in a registry install that is a database nobody
     trades in — so three handlers that legitimately needed the privilege were
     using it against the wrong customer. The lock screen returned an empty
     outlet list, so a till could sign nobody in; GST registration would have
     marked another database's company registered while the real one kept
     charging nothing; a rename claimed the name in the registry and renamed a
     store nobody was looking at.

     The old list justified the privilege and never the address. This one is
     the address, and it is a list for the same reason the other two are: a
     fourth caller has to say why. */
  const addressed = {
    'auth.js': 'the lock screen asks before anybody has signed in, so the'
      + ' terminal names its own store',
    'outlet.js': 'GST registration is a company fact that must reach every'
      + ' outlet of THAT business, and a handle rename must move the store\'s'
      + ' own copy as well as the registry\'s claim'
  };

  /* control() is a DIFFERENT privilege and gets its own list: it opens the
     registry, which sits above every business. account.js left the owner() list
     when the account plane moved out of a business database — it does not reach
     past a business's belts any more, it reaches a database that has none
     because no outlet role can connect to it at all. */
  const registry = {
    'account.js': 'the account plane lives in the registry: one account may own'
      + ' several businesses',
    'onboarding.js': 'records the new business and who owns it',
    'outlet.js': 'a handle is one name across every business, so the registry'
      + ' owns it and chain.outlet.slug follows',
    'guest.js': 'resolves a handle TO a business and an outlet — a business'
      + ' database only knows its own',
    /* A SEVENTH, and it is the SAME question guest.js asks. A receipt link is
       `https://<handle>.kashikeyopos.com/r/<token>`, so the host names the
       store and the registry is what turns that name into an outlet — exactly
       as it does for a QR scan. The alternative was walking every business
       looking for the token, which is both a privileged connection this file
       has no business holding and an O(businesses × outlets) scan on a page a
       guest opens from a message. */
    'doc.js': 'resolves a handle TO a business and an outlet, so a shared'
      + ' receipt is looked for in one store rather than in all of them'
  };


  const clean = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  /* owner() and control() take no arguments, so empty parens are the whole
     call. ownerForOutlet() takes the outlet — that IS the point of it — so it
     is matched with its argument. Matching it on empty parens found nothing
     and reported the exception as stale, which is the false negative this
     whole test exists to avoid. */
  const call = (name) => new RegExp('\\b' + name
    + (name === 'ownerForOutlet' ? '\\s*\\(' : '\\s*\\(\\)'));
  const importsFrom = (src, name) =>
    new RegExp("require\\('\\.\\./db'\\)").test(src)
      && call(name).test(clean(src));

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  const uses = (name) => files.filter((f) =>
    importsFrom(fs.readFileSync(path.join(dir, f), 'utf8'), name));

  [['owner', allowed], ['control', registry],
    ['ownerForOutlet', addressed]].forEach(([name, list]) => {
    uses(name).forEach((f) => {
      assert.ok(list[f], 'src/routes/' + f + ' calls ' + name + '() — if that is'
        + ' deliberate, name it and its reason in this test and in CLAUDE.md,'
        + ' because an unexplained privileged connection is how a leak gets'
        + ' written');
    });
    Object.keys(list).forEach((f) => {
      assert.ok(uses(name).includes(f), 'src/routes/' + f + ' no longer uses '
        + name + '() — take it off the list rather than leaving a stale'
        + ' exception standing');
    });
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

/* ═══ AN OP CARRIES ITS PAYLOAD, OR IT IS NAMED ════════════════════════════
   `queue(kind, label, entity, payload)` — and a call that stops at three
   arguments reaches the outlet carrying a sentence and nothing else. The
   handler then writes from a payload it never got: the row is empty, or the
   insert fails on a NOT NULL, and the screen says "Saved" either way. It is
   the worst failure mode available, because it is invisible from the screen
   that caused it — a live store lost its menu sections to exactly this, and
   the first symptom was a DIFFERENT screen refusing a dish.

   The check above ("an op that carries a consequence carries its payload")
   only sees the paths the harness happens to walk. This one reads every
   `this.queue(` in the file, so a new screen cannot add a bare call quietly.

   The parser skips comments, which the first version of this sweep did not:
   an apostrophe in a `//` line ("the operator's answer") put it into string
   mode and it reported payload-carrying ops as bare. A sweep that
   over-reports sends somebody to fix what is not broken, so it is worth the
   twenty lines. */
function queueCalls(src) {
  const CALL = 'this.queue(';
  const out = [];
  let at = src.indexOf(CALL);
  while (at >= 0) {
    let i = at + CALL.length, depth = 0, args = [], cur = '', q = null;
    for (; i < src.length; i++) {
      const c = src[i], n = src[i + 1];
      if (q) {
        if (c === '\\') { cur += c + src[++i]; continue; }
        if (c === q) q = null;
        cur += c; continue;
      }
      if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; }
      if ('([{'.indexOf(c) >= 0) depth++;
      if (')]}'.indexOf(c) >= 0) { if (depth === 0) { args.push(cur); break; } depth--; }
      if (c === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
      cur += c;
    }
    const m = (args[0] || '').trim().match(/^"([a-z_]+)"$/);
    if (m) out.push({ kind: m[1], args: args.length, at: at });
    at = src.indexOf(CALL, at + 1);
  }
  return out;
}

/* The kinds that legitimately carry no payload, each because the op RECORDS
   something rather than performing it — a signal, a state this device already
   holds, or a consequence that rode on another op. A kind is on this list
   because somebody decided it belongs there, which is the whole point: "not
   modelled yet" and "nothing to send" must stay distinguishable.

   FIVE OF THESE ARE KIND/HANDLER MISMATCHES rather than settled decisions, and
   they are marked so nobody reads the list as a clean bill of health. Each
   needs a decision about which side is wrong, and giving two of them a payload
   would be actively harmful — `consume_recipe` would deduct the stock the sale
   has already deducted. */
const BARE_BY_DESIGN = [
  'ai_menu_draft', 'bank_recon', 'credit_reverse',
  'printer_state', 'promo_clamped', 'qr_pay_intent',
  'recipe_recost', 'recost_items', 'seat_walkin',
  'split_payment', 'terminal_update',
  // ── mismatched, and knowingly left: see the note above
  'category_insert',   // a STOCK category, sent to the MENU category handler
  'consume_recipe',    // an announcement; the sale already moved the stock
  'kds_station',       // a device preference, sent to a handler that moves a docket
  'modifier_update'    // the screen edits the whole list; the handler takes one
];

/* ═══ A SETTING IS THE OUTLET'S, SO IT REACHES EVERY TERMINAL ═══════════════
   The outlet has had a `setting` table since the schema was written, the
   handler wrote to it, and `src/bootstrap.js` read it into a local called
   `oset` that was USED BY NOTHING. So an owner changing a policy from home
   changed it on their own screen and no till ever heard: `autoLock`,
   `voidPin`, `showCost`, the merchant rate, the exchange rates, the packaging
   cost and the QR banner slot all lived in one browser's localStorage.

   Three properties, and each is a way the old shape was wrong:
     · the settings screen's ONE write sends the key and the value;
     · a DEVICE preference is named and does NOT travel — pushing "keep the
       menu pinned" would pin somebody else's sidebar, and a paper width would
       re-point somebody else's printer;
     · the local copy is a HOLDING PEN: dropped the moment the outlet publishes
       that key, on the key and never on the value, the same rule a measured
       yield and a saved menu section already follow. */
test('a setting is the outlet\'s, unless it is named as this terminal\'s', () => {
  // ── the bootstrap publishes it at all. This is the whole defect: the read
  //    existed and the publish did not.
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const boot = src('src/bootstrap.js');
  assert.match(boot, /PREFS:\s*oset/,
    "the outlet's own settings are read and published, not read and dropped");

  // ── the one write carries the key and the value, and is gated on the key
  //    being the outlet's business rather than this screen's.
  const set = SRC.slice(SRC.indexOf('const set = (k, v) =>'));
  const body = set.slice(0, set.indexOf('const tog ='));
  assert.match(body, /if \(!this\.isDevicePref\(k\)\)/,
    'a device preference is not pushed to the outlet');
  assert.match(body, /queue\("setting_change"[\s\S]*?\{ key: k, value: v \}/,
    'and a policy is sent with the key and the value its handler reads');

  // ── the three sources, in the order that settles a disagreement.
  const prefs = SRC.slice(SRC.indexOf('  prefs() {'));
  assert.match(prefs.slice(0, 400),
    /PREF_DEFAULTS[\s\S]*?\(K\(\) \|\| \{\}\)\.PREFS[\s\S]*?this\.state\.prefs/,
    'shipped default, then the OUTLET, then this device — in that order');

  // ── and the pen empties. Without this the first terminal to change a
  //    setting keeps its own answer for ever and never sees anybody else's.
  assert.match(SRC, /reconcilePrefs\(\) \{/, 'there is a reconciliation');
  assert.match(SRC, /applyLocal\(\) \{[\s\S]{0,4000}?this\.reconcilePrefs\(\);/,
    'and it runs on every bootstrap, beside the sections it mirrors');
  const rec = SRC.slice(SRC.indexOf('  reconcilePrefs() {'));
  assert.match(rec.slice(0, 700), /!this\.isDevicePref\(k\)[\s\S]*?hasOwnProperty\.call\(pub, k\)/,
    'dropped when the outlet publishes the KEY, and a device preference never');

  // ── the four rate screens send what their handlers read. Each wrote a key
  //    no terminal ever read: `acquirer_rates_outlet`, `channel_rates`,
  //    `fx_rates`, and a banner upsert for a display toggle.
  const apply = src('src/apply.js');
  [['mdr_set', 'processors'], ['channel_rates', 'packCost'],
    ['fx_rates', "'fx'"], ['qr_banner_slot', 'qrBanners']].forEach(([kind, key]) => {
    const h = apply.slice(apply.indexOf('H.' + kind + ' ='));
    assert.ok(h.slice(0, 900).indexOf(key) > 0,
      kind + ' writes the key the till reads back, not one nobody reads: ' + key);
  });
});

/* And behaviourally, on the shipped logic class: the outlet's answer displaces
   the shipped default, the local pen shows an edit at once and empties the
   moment the outlet publishes that key, and a DEVICE preference is never
   dropped because it is never published. */
test('the outlet\'s settings displace the defaults, and the pen empties', () => {
  const kpos = FX.kpos();
  const F = H.makeInstance({ kpos: kpos, raw: FX.raw(), real: FX.real() });

  // ── nobody has decided anything: the shipped default.
  assert.strictEqual(F.prefs().autoLock, F.PREF_DEFAULTS.autoLock);

  // ── the outlet has. A terminal that has never touched this setting reads
  //    the shop's answer, which is the whole of what was missing.
  F.__win.KPOS.PREFS = { autoLock: 12, voidPin: false };
  assert.strictEqual(F.prefs().autoLock, 12, "the outlet's answer wins over the default");
  assert.strictEqual(F.prefs().voidPin, false);

  // ── this terminal edits it: shown at once, including offline.
  F.state.prefs = { autoLock: 30, navPinned: true };
  assert.strictEqual(F.prefs().autoLock, 30, 'an un-synced edit shows immediately');

  // ── and the pen empties once the outlet has it. Dropped on the KEY and
  //    never on the value: a disagreement means somebody edited it elsewhere
  //    and theirs is the later decision. Keeping it BECAUSE it differs is
  //    exactly how a holding pen becomes a private fork.
  F.__win.KPOS.PREFS = { autoLock: 45, voidPin: false };
  F.reconcilePrefs();
  assert.strictEqual(F.prefs().autoLock, 45, 'the outlet is read once it has answered');
  assert.strictEqual(F.state.prefs.autoLock, undefined, 'and the local copy is gone');
  assert.strictEqual(F.state.prefs.navPinned, true,
    'while a device preference stays — it is never published, so it never lands');
});

/* ═══ A ROW THE OUTLET HAS NO RECORD OF HAS NOT BEEN DELIVERED ══════════════
   Reported straight after the section fix landed: "I added three menu items,
   two on one browser and one on another, and I still don't see them all".

   A back-office row lives in TWO places until the outlet accepts it — the live
   collection and `state.local` — and `applyLocal()` is what puts the held copy
   back after a bootstrap replaces window.KPOS wholesale. It did ONLY that. So
   a row whose op was refused (a dish whose section had never arrived), or
   overwritten (two devices minting the same id), or recorded as unmodelled,
   was re-drawn on the browser that made it on every bootstrap for ever, and
   existed nowhere else. The screen said saved and the shop had no such dish.

   Two halves, and the pen has to do both or it is a fork:
     · a held row the outlet does NOT have is queued again, once per session;
     · a held row the outlet DOES have is dropped, so the local copy can never
       shadow an edit made on another terminal. */
test('a held row the outlet never received is re-sent, and one it has is dropped', () => {
  const kpos = FX.kpos();
  const F = H.makeInstance({ kpos: kpos, raw: FX.raw(), real: FX.real() });
  const queued = [];
  F.__win.KPOS_SYNC = { enqueue: (op) => { queued.push(op); return op.opId; } };

  const MENU = F.__win.KPOS.MENU;
  const landed = MENU[0];
  assert.ok(landed && landed.id, 'the fixture publishes a menu to compare against');

  /* One row the outlet HAS and one it does not. The held copy is a separate
     object, because that is what a pen restored from localStorage contains —
     and it is what lets the pen tell the outlet's row apart from the one this
     replay put there itself. */
  const held = JSON.parse(JSON.stringify(landed));
  const orphan = { id: 'm-never-arrived', name: 'Bajiya', cat: landed.cat,
    price: 120, active: true, recipe: [] };
  F.state.local = { menu: [held, orphan] };

  F.applyLocal();

  // ── the orphan is asked for again, carrying the row rather than a label.
  const sent = queued.filter((q) => q.kind === 'dish_upsert');
  assert.strictEqual(sent.length, 1, 'exactly the row the outlet does not have');
  assert.strictEqual(sent[0].payload.id, 'm-never-arrived',
    'and it is the orphan, not the one that landed');
  assert.ok(sent[0].payload.name, 'with its payload, which is what was refused for want of');

  // ── it is on the screen too, or the operator watches their own dish vanish
  //    while it is being re-sent.
  assert.ok(F.__win.KPOS.MENU.some((x) => x.id === 'm-never-arrived'),
    'the held row still renders while it is in flight');

  // ── and the row the outlet HAS is out of the pen. Kept, it shadows every
  //    later edit made anywhere else — a private fork wearing the word
  //    "offline".
  assert.strictEqual((F.state.local.menu || []).map((r) => r.id).join(','),
    'm-never-arrived',
    'the delivered row is dropped and only the undelivered one is held');

  // ── ONCE PER SESSION. The outbox owns retrying; queueing on every bootstrap
  //    is how a hot outbox is made.
  queued.length = 0;
  F.applyLocal();
  assert.strictEqual(queued.filter((q) => q.kind === 'dish_upsert').length, 0,
    'a second bootstrap does not ask again');

  /* AND NOT BEFORE THE OUTLET HAS ANSWERED. This is the fence, and without it
     the whole lane is decoration: before a bootstrap the collections are still
     the shipped list, so every held row reads as missing, and KPOS_SYNC — the
     durable outbox — is not loaded, so `queue()` records the op locally and
     enqueues nothing. The op evaporates, the row is marked as asked for, and
     the terminal never asks again. Measured in a browser exactly that way. */
  const G = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const late = [];
  G.__win.KPOS_SYNC = null;
  const cat = (G.__win.KPOS.MENU[0] || {}).cat;
  G.state.local = { menu: [{ id: 'm-too-early', name: 'Too early', cat: cat,
    price: 10, active: true, recipe: [] }] };
  G.applyLocal();
  assert.strictEqual(G._rowSent['menu:m-too-early'], undefined,
    'nothing is marked as sent while there is nothing to send it with');
  assert.ok(G.__win.KPOS.MENU.some((x) => x.id === 'm-too-early'),
    'and the row is still drawn — holding it back would lose it from the screen too');

  // The bootstrap lands, and now it asks.
  G.__win.KPOS_SYNC = { enqueue: (op) => { late.push(op); return op.opId; } };
  G.applyLocal();
  assert.strictEqual(late.filter((q) => q.kind === 'dish_upsert').length, 1,
    'the first pass with an outbox and an outlet answer is the one that sends');
});

/* ═══ THE SECTION GOES FIRST, OR THE RE-SEND RE-CREATES THE REFUSAL ═════════
   Reported off a live Sync screen while this was the wrong way round:

     Dish created · NESCAFE MILK at MVR 20 — insert or update on table "item"
     violates foreign key constraint "item_category_id_fkey"

   A push is applied in lamport order, which is the order the ops were queued
   in. So a dish queued before the section it sits in is APPLIED before it and
   refused by the same key that refused it the first time — a re-send lane
   that re-creates the refusal it exists to clear, and parks a second op saying
   what the first one said.

   And a dish naming a section that is neither at the outlet nor in this pen
   cannot be saved by anybody: it stays held rather than parking again. */
test('a re-sent dish lands after its section, and one with no section waits', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const queued = [];
  F.__win.KPOS_SYNC = { enqueue: (op) => { queued.push(op); return op.opId; } };

  // A section this terminal holds and the outlet does not, with a dish in it —
  // exactly the pair a live store is sitting on.
  F.state.local = {
    menucats: [{ id: 'short-eats', name: 'Short Eats & Snacks' }],
    menu: [{ id: 'm-nescafe', name: 'NESCAFE MILK', cat: 'short-eats',
      price: 20, active: true, recipe: [] }]
  };
  F.applyLocal();

  const kinds = queued.map((q) => q.kind);
  const section = kinds.indexOf('menu_category_insert');
  const dish = kinds.indexOf('dish_upsert');
  assert.ok(section >= 0, 'the section the outlet never received is re-sent');
  assert.ok(dish >= 0, 'and so is the dish that was refused for want of it');
  assert.ok(section < dish,
    'the section is queued FIRST, so it carries the lower lamport and is'
    + ' applied first — queued after, the dish is refused all over again');

  // ── a dish whose section is nowhere at all is held, not parked again.
  const G = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const later = [];
  G.__win.KPOS_SYNC = { enqueue: (op) => { later.push(op); return op.opId; } };
  G.state.local = { menu: [{ id: 'm-orphaned', name: 'Orphan', cat: 'no-such-section',
    price: 20, active: true, recipe: [] }] };
  G.applyLocal();
  assert.strictEqual(later.filter((q) => q.kind === 'dish_upsert').length, 0,
    'a dish nobody can save is not queued to be refused a second time');
  assert.ok(G.__win.KPOS.MENU.some((x) => x.id === 'm-orphaned'),
    'it is still on the screen, and still in the pen, waiting for its section');
});

/* AND THE REFUSAL IS READ BY A PERSON. `e.message` went straight to the parked
   lane, so what an operator opened said `violates foreign key constraint
   "item_category_id_fkey"` — every fact they need, none of it legible. Same
   rule the handle route already keeps for a check violation: a NAMED
   constraint is Postgres phrasing it and is translated; a RAISE was written
   for a person and is repeated as written. */
/* THE SECTION PEN HAS TO SURVIVE A RELOAD, or the re-send that follows has
   nothing left but the id. `state.catMeta` and `state.catOrder` are the same
   class of thing as `state.local` and `state.prefs` — this terminal's
   un-synced answer about a section's name, colour, glyph, station and order —
   and neither was written to the session nor read back from it. Measured in a
   browser: a section held on one terminal reached the outlet named
   `hot-drinks-mtb373zz`, on the till rail and on the guest's menu. */
test('the section pen survives a reload, and the re-send carries the name', () => {
  assert.match(SRC, /catMeta: s\.catMeta, catOrder: s\.catOrder/,
    'both halves of the section pen are persisted');
  assert.match(SRC, /catMeta: this\._saved\.catMeta \|\| \{\}/,
    'and read back, or persisting them is write-only');
  assert.match(SRC, /catOrder: this\._saved\.catOrder \|\| null/,
    'the order too — null is "nobody has re-ordered", not an empty rail');

  // The held ROW is the record; catMeta is a later edit layered on it.
  const rec = SRC.slice(SRC.indexOf('  reconcileCats() {'));
  assert.match(rec.slice(0, 2200),
    /const meta = Object\.assign\(\{\}, row, \(this\.state\.catMeta \|\| \{\}\)\[id\] \|\| \{\}\);/,
    'the re-send names the section from the row it is holding, never from'
    + ' catMeta alone, which answers { id, name: id } for a section the outlet'
    + ' has never published');

  // And behaviourally: a pen with a name in the row and nothing in catMeta.
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const queued = [];
  F.__win.KPOS_SYNC = { enqueue: (op) => { queued.push(op); return op.opId; } };
  F.state.catMeta = {};
  F.state.local = { menucats: [{ id: 'hot-drinks-x9', name: 'Hot Drinks',
    color: '#8a6f4f', icon: 'coffee', station: 'bar', hidden: false }] };
  F.applyLocal();
  const sec = queued.filter((q) => q.kind === 'menu_category_insert')[0];
  assert.ok(sec, 'the section is re-sent');
  assert.strictEqual(sec.payload.name, 'Hot Drinks',
    'under its name, not its id — an id on the rail is what shipped');
  assert.strictEqual(sec.payload.icon, 'coffee', 'with the glyph it was given');
  assert.strictEqual(sec.payload.station, 'bar', 'and the station its dishes fire to');
});

/* ═══ HANDING OVER AND LEAVING ARE DIFFERENT DECISIONS ══════════════════════
   Only one of them existed. The identity sheet offered "Switch user", which
   clears who is on the screen and KEEPS the token — right for a handover a
   dozen times a shift, because the till is still the till and its outbox is
   still delivering behind the lock. Actually leaving was offered nowhere:
   `POST /api/auth/signout` has been written since the API was, the client's
   `signOut()` calls it and drops the token, and NOTHING has ever called that.
   So a copy of a browser's storage stayed a way into the till until the token
   expired on its own — and the answer to "how do I log out" was that you
   could not. */
test('a till can be handed over, and it can also be left', () => {
  // ── the two are separate methods, so neither can quietly become the other.
  assert.match(SRC, /  lockTill\(\) \{/, 'the handover has its own name');
  const lock = SRC.slice(SRC.indexOf('  lockTill() {'));
  assert.ok(lock.slice(0, 400).indexOf('KPOS_BRIDGE') < 0,
    'and it does NOT drop the token — the till keeps delivering behind the lock');

  // ── the bridge exposes the real one, which is what was missing.
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'app', 'kpos-bridge.js'), 'utf8');
  assert.match(bridge, /signOut: function \(\) \{ return api\.signOut\(\); \}/,
    'ending a session is reachable from the app at all');

  // ── and the client's own signOut revokes server-side rather than only
  //    forgetting locally: a token nobody dropped is a token that still works.
  const api = fs.readFileSync(path.join(__dirname, '..', 'app', 'kashikeyo-api.js'), 'utf8');
  const so = api.slice(api.indexOf('    signOut() {'));
  assert.match(so.slice(0, 700), /localStorage\.removeItem\(TOKEN_KEY\)/, 'the token is dropped');
  assert.match(so.slice(0, 700), /\/api\/auth\/signout/, 'and the outlet is told to revoke it');

  // ── the sheet offers both, and says which is which. Two rows that read the
  //    same are one row an operator picks at random.
  const sheet = SRC.slice(SRC.indexOf('if (m.kind === "switch")'));
  const body = sheet.slice(0, sheet.indexOf('head: "How this till looks"'));
  assert.match(body, /Switch user/, 'the handover');
  assert.match(body, /Sign out of this terminal/, 'and leaving');
  assert.match(body, /the till stays connected and keeps delivering/,
    'the handover says it keeps the till connected');
  assert.match(body, /Ends this session on the outlet, clears this terminal's cache and returns to the sign-in page/,
    'and signing out says what it actually ends — the session, this browser\'s cache, and where it lands');

  // ── UNDELIVERED WORK IS NAMED, not blocked. The ops are durable and survive
  //    signing out; what changes is that nothing will deliver them until
  //    somebody signs in here again, which is a fact whoever is walking away
  //    needs BEFORE they walk away.
  assert.match(body, /not reached the outlet/,
    'the confirm counts what is still owed to the outlet');
  assert.match(body, /_signOutArmed/,
    'and it asks twice — this sits beside the theme toggle on a touch sheet');
});

/* ═══ A SECOND DEVICE IS NOT A SECOND CUSTOMER ═════════════════════════════
   Reported: "when I log in from another device from the browser, no menu item
   is there."

   A browser that has never been told which store it belongs to answers
   `needStore` and the bridge sends it to /account. Two completely different
   errands arrive at that one door: a NEW CUSTOMER from the website, and an
   OWNER whose second device needs to be told its store. The page opened on
   "Create your account" for both, with Create account as the primary action.

   Following it makes a second account, a second business and an empty store,
   silently — and the till then points at it. That is the reported symptom
   exactly: signed in on another device, and no menu. */
test('a device asking which store it is opens on sign in, not sign up', () => {
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'app', 'kpos-bridge.js'), 'utf8');
  assert.match(bridge, /if \(!held && install\.needStore\) to = "\/account\?store=1";/,
    'the errand is carried in the address — the door cannot guess it');
  assert.match(bridge, /location\.pathname \+ location\.search !== to/,
    'and the redirect compares the query too, or it loops or never fires');

  const acct = fs.readFileSync(path.join(__dirname, '..', 'app', 'account.html'), 'utf8');
  assert.match(acct, /var forStore = \/\[\?&\]store=1\\b\/\.test\(location\.search\);/,
    'the page reads it');
  // Two errands open on Sign in — a terminal that has not been told its store,
  // and one somebody just signed out — and the front door keeps Create account.
  assert.match(acct, /var mode = \(forStore \|\| signedOut\) \? "signin" : "signup";/,
    'and opens on SIGN IN for a terminal — the front door keeps sign up');

  // And it says what is happening. A screen that silently swaps its default
  // is a screen somebody blames themselves for.
  assert.match(acct, /Which store is this terminal\?/,
    'the heading names the errand');
  assert.match(acct, /does not know which store it belongs to yet/,
    'and the subtitle explains it, so nobody reads it as a new sign-up');

  /* The server has answered this all along and nobody read it. `needStore` is
     what distinguishes "this install has never been set up" from "this browser
     has not been told" — two states the bridge treated as one. */
  const auth = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
  assert.match(auth, /needStore/, 'the install answer carries the distinction');
});

/* ═══ A FAILURE THIS SHAPE HAS ONLY ONE SYMPTOM, SO THE TILL SAYS IT ════════
   A back-office row lives in two places until the outlet accepts it, and the
   failure of that lane is INVISIBLE by construction: the row is re-drawn on
   the browser that made it, on every bootstrap, so that screen looks right
   while every other terminal in the shop shows nothing. Reported three times
   in one day, each time as "I don't see it on the other device" — which is
   the only symptom it has, and it points at the wrong device.

   So Sync & Devices names it: what this terminal is holding that the outlet
   has no record of, why each one is stuck, and a control to ask again. */
test('the till says what it is holding that the outlet has never seen', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  F.__win.KPOS_SYNC = { enqueue: (op) => op.opId };
  const cat = (F.__win.KPOS.MENU[0] || {}).cat;

  // Nothing held: the card must not exist, or it is noise on every install.
  assert.strictEqual(F.heldRows().length, 0, 'a clean terminal holds nothing');

  F.state.local = { menu: [
    { id: 'm-sendable', name: 'PLAIN BUN', cat: cat, price: 12, active: true, recipe: [] },
    { id: 'm-orphan', name: 'ORPHAN TEA', cat: 'gone-section', price: 15, active: true, recipe: [] }
  ] };
  const held = F.heldRows();
  assert.strictEqual(held.length, 2, 'both are held before anything is sent');

  // THE REASON IS THE POINT. "Waiting" and "cannot be saved by anybody" are
  // different situations and only one of them resolves on its own.
  const orphan = held.filter((h) => h.id === 'm-orphan')[0];
  assert.match(orphan.why, /menu section has not reached the outlet/,
    'a dish whose section is nowhere says so: ' + orphan.why);
  const ok = held.filter((h) => h.id === 'm-sendable')[0];
  assert.strictEqual(ok.why, 'waiting to be delivered');

  // Once the outlet has it, it leaves the list — a card that keeps counting
  // delivered rows is a card nobody reads by the second week.
  F.applyLocal();
  F.__win.KPOS.MENU.push({ id: 'm-sendable', name: 'PLAIN BUN', cat: cat, price: 12 });
  F.state.local = { menu: (F.state.local.menu || []).filter((r) => r.id !== 'm-sendable') };
  assert.strictEqual(F.heldRows().map((h) => h.id).join(','), 'm-orphan',
    'only what is still stuck is counted');

  // And the control is real: it clears this session's marks and runs the pen.
  assert.match(SRC, /  resendHeld\(\) \{/, 'there is a way to ask again now');
  const re = SRC.slice(SRC.indexOf('  resendHeld() {'));
  assert.match(re.slice(0, 900), /this\._rowSent = \{\};[\s\S]*?this\.applyLocal\(\);/,
    'it clears the once-per-session marks and replays the pen');
  assert.match(re.slice(0, 900), /outletAnswered\(\)/,
    'and refuses before the outlet has answered rather than evaporating the ops');
});

/* ═══ THE FIRST DISH A STORE EVER CREATES ═══════════════════════════════════
   The root of every "I added menu items and the other device does not show
   them" report, and the reason three fixes before it did not help: they made
   a lost row recoverable and said nothing about a row that could never land.

   The dish editor defaulted its section to `(cats[0] || {}).id || "mains"`.
   A store that has not made a section yet has no cats[0] — so every dish on a
   brand-new store was created in a section called `mains` THAT NOBODY HAD
   EVER CREATED, and `item_category_id_fkey` refused it on every retry, for
   ever. The toast said "Dish created", the holding pen re-drew the row on that
   browser after every bootstrap, and no other terminal ever saw it.

   Measured by driving the shipped screens in two real browsers before the fix:
   browser A showed MASALA TEA, browser B showed nothing, and the outlet had no
   item row and no op_log row at all — the op never survived its first apply.

   EVERY TEST IN THIS SUITE ENQUEUED OPS DIRECTLY, which is why it survived:
   that path skips the dish editor, insertRow() and queue() entirely. This one
   drives the editor. */
test('the first dish on a store with no sections creates its section first', () => {
  const kpos = FX.kpos();
  const F = H.makeInstance({ kpos: kpos, raw: FX.raw(), real: FX.real() });
  const queued = [];
  F.__win.KPOS_SYNC = { enqueue: (op) => { queued.push(op); return op.opId; } };

  // A STORE THAT HAS NEVER MADE A SECTION. This is a real customer on their
  // first afternoon, and it was the one state nothing tested.
  F.__win.KPOS.MENU_CATEGORIES = [];
  F.__win.KPOS.MENU = [];
  F.state.local = {}; F.state.catMeta = {};

  F.openDish(null);
  const v = F.modalVals(F.state.modal);
  assert.ok(v.dbSave, 'the dish editor opened');
  // The section the form defaulted to, on a store with none of its own.
  const cat = F.state.modal.d.cat;
  assert.ok(cat, 'it still picks one — a dish belongs somewhere');

  F.setState({ modal: Object.assign({}, F.state.modal,
    { d: Object.assign({}, F.state.modal.d, { name: 'MASALA TEA', price: '25' }) }) });
  F.modalVals(F.state.modal).dbSave();

  const kinds = queued.map((q) => q.kind);
  const sec = kinds.indexOf('menu_category_insert');
  const dish = kinds.indexOf('dish_upsert');
  assert.ok(sec >= 0,
    'the section is created for real — without it the dish is refused by'
    + ' item_category_id_fkey on every retry, for ever');
  assert.ok(dish >= 0, 'and the dish is queued');
  assert.ok(sec < dish,
    'the section FIRST, so it carries the lower lamport and is applied first');

  // AND IT IS A SECTION, not an id wearing a name. "mains" on the till rail
  // and on the guest's menu is the same defect in lower case.
  const payload = queued[sec].payload;
  assert.strictEqual(payload.id, cat, 'keyed by the id the dish names');
  assert.strictEqual(payload.name, 'Mains',
    'under its shipped name, not its id: ' + payload.name);
  assert.strictEqual(queued[dish].payload.cat, cat, 'and the dish lands in it');

  /* THE ID IS STABLE, NOT MINTED. The write is an upsert keyed by it, so two
     devices that both need a Mains section converge on one row rather than
     two — which is the opposite rule from a DISH id, and deliberately so. */
  const G = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const other = [];
  G.__win.KPOS_SYNC = { enqueue: (op) => { other.push(op); return op.opId; } };
  G.__win.KPOS.MENU_CATEGORIES = []; G.__win.KPOS.MENU = [];
  G.state.local = {}; G.state.catMeta = {};
  G.openDish(null);
  G.setState({ modal: Object.assign({}, G.state.modal,
    { d: Object.assign({}, G.state.modal.d, { name: 'PLAIN TEA', price: '20' }) }) });
  G.modalVals(G.state.modal).dbSave();
  const otherSec = other.filter((q) => q.kind === 'menu_category_insert')[0];
  assert.strictEqual(otherSec.payload.id, payload.id,
    'a second device needing the same section writes the same row, not a rival');

  // A section the outlet ALREADY has is not re-created.
  const P = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const third = [];
  P.__win.KPOS_SYNC = { enqueue: (op) => { third.push(op); return op.opId; } };
  P.state.local = {}; P.state.catMeta = {};
  P.openDish(null);
  P.setState({ modal: Object.assign({}, P.state.modal,
    { d: Object.assign({}, P.state.modal.d, { name: 'ANOTHER', price: '30' }) }) });
  P.modalVals(P.state.modal).dbSave();
  assert.strictEqual(third.filter((q) => q.kind === 'menu_category_insert').length, 0,
    'a store WITH sections writes no section — only the dish');
});

/* ═══ THE OUTLET DOES NOT ALWAYS KEEP THE ID THIS DEVICE MINTED ════════════
   Reported: "when I add a customer I see a duplicate record, but when I log in
   from another browser it shows correctly."

   A dish is upserted BY the id the till gave it, so the holding pen finds the
   outlet's copy by that id. A CUSTOMER is not: `member_upsert` ignores an id
   that is not a uuid — which is every id a till invents — and the outlet
   issues its own. So the row comes back under a DIFFERENT id, the pen never
   matches it, and `applyLocal()` unshifts the local copy on top of the
   outlet's on every bootstrap. Two rows, on the browser that added them and
   nowhere else, which is exactly how it was reported. */
test('a customer the outlet re-keyed is recognised, not duplicated', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  F.__win.KPOS_SYNC = { enqueue: (op) => op.opId };

  // What the till holds: the row it made, under the id IT minted.
  const mine = { id: 'c-mtb-local', name: 'Hassan Moosa', phone: '7771234',
    email: '', credit: 0, points: 0 };
  F.state.local = { custs: [mine] };
  F.__win.KPOS.CUSTOMERS = [];
  F.applyLocal();
  assert.strictEqual(F.__win.KPOS.CUSTOMERS.length, 1,
    'before the outlet has it, the pen draws it — otherwise it vanishes on save');

  /* THE BOOTSTRAP, with the outlet's own uuid. This is the row the till just
     created, coming back wearing an id this device has never seen. */
  F.__win.KPOS.CUSTOMERS = [{ id: '9f1c2b74-0000-4000-8000-000000000001',
    name: 'Hassan Moosa', phone: '7771234', email: '', credit: 0, points: 0 }];
  F.applyLocal();

  assert.strictEqual(F.__win.KPOS.CUSTOMERS.length, 1,
    'ONE customer, not two — the duplicate is what was reported');
  assert.strictEqual(F.__win.KPOS.CUSTOMERS[0].id,
    '9f1c2b74-0000-4000-8000-000000000001', "and it is the OUTLET's row that stands");
  assert.strictEqual(((F.state.local || {}).custs || []).length, 0,
    'the pen releases it, so a later edit made anywhere else is not shadowed');
  assert.strictEqual(F.heldRows().length, 0,
    'and nothing is reported as held — it was delivered, under another id');

  // A DIFFERENT customer is still held. The key is the phone, not the fact of
  // being a customer.
  F.state.local = { custs: [{ id: 'c-other', name: 'Aishath', phone: '7779999' }] };
  assert.strictEqual(F.heldRows().length, 1, 'a genuinely undelivered one still counts');

  // AND THE FALLBACK IS THE ID. A half-filled row with no phone must never be
  // matched to a different customer just because both are missing the key.
  const G = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  G.__win.KPOS_SYNC = { enqueue: (op) => op.opId };
  G.__win.KPOS.CUSTOMERS = [{ id: 'srv-1', name: 'Someone', phone: '' }];
  G.state.local = { custs: [{ id: 'c-mine', name: 'Another', phone: '' }] };
  G.applyLocal();
  assert.strictEqual(G.__win.KPOS.CUSTOMERS.length, 2,
    'two rows with no phone between them are two customers, not one');
});

/* ═══ EVERYTHING THE DISH EDITOR COLLECTS IS SENT ══════════════════════════
   Reported: "an item added shows, and its tags and heat are not recorded and
   synced." The form asks for eleven things and the op carried eight.

   `tags` had a column from the first migration, the handler wrote it and the
   bootstrap published it — and this mapping never sent them, so `arr(undefined)`
   made the array empty and every save came back with Chef's pick, New,
   Signature and Gluten free erased. `spice` had nowhere to be stored at all
   until migration 041. `addons` decide what the till and the QR menu offer
   beside the dish and reached the outlet never. */
test('a dish op carries its tags, its heat and its add-ons', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const op = F.opFor('menu', {
    id: 'd1', name: 'MASALA TEA', cat: 'hot', price: 25, desc: '', station: 'bar',
    tags: ['chef', 'new'], spice: 2, addons: ['g-extras'], veg: false, recipe: []
  });
  assert.strictEqual(op.kind, 'dish_upsert');
  assert.deepStrictEqual(op.payload.tags, ['chef', 'new'],
    'the tags the editor collected are in the payload');
  assert.strictEqual(op.payload.spice, 2, 'and the heat');
  assert.deepStrictEqual(op.payload.addons, ['g-extras'], 'and the add-ons');

  // NULL ADD-ONS IS "inherit the section", which is the editor's own default
  // and a real answer — it must not arrive as an empty list, which would clear
  // every add-on the section offers.
  const inherit = F.opFor('menu', { id: 'd2', name: 'X', cat: 'hot', price: 1,
    tags: [], spice: 0, addons: null, recipe: [] });
  assert.strictEqual(inherit.payload.addons, null,
    'silence about add-ons stays silence, not a clearing');
  assert.deepStrictEqual(inherit.payload.tags, [],
    'while an empty TAG list is a decision and is sent as one');

  // A figure off the four-rung scale never reaches the wire.
  assert.strictEqual(F.opFor('menu', { id: 'd3', name: 'X', cat: 'h', price: 1,
    spice: 99, recipe: [] }).payload.spice, 3, 'heat is clamped to the scale');

  /* AND THE ROUND TRIP ON THE SHIPPED READERS. `dishTags()` and `dishSpice()`
     are what every surface reads — the menu master, the till tile, the printed
     list — so a field the bootstrap does not publish reads as absent however
     faithfully it was stored. */
  const back = { id: 'd1', name: 'MASALA TEA', cat: 'hot', price: 25,
    tags: ['chef', 'new'], spice: 2, diets: [], veg: false };
  assert.deepStrictEqual(F.dishTags(back), ['chef', 'new'],
    'the tags come back off the published row');
  assert.strictEqual(F.dishSpice(back), 2, 'and so does the heat');

  // The dish editor re-opens on what the outlet holds, not on a default.
  F.__win.KPOS.MENU = [back];
  F.openDish('d1');
  assert.deepStrictEqual(F.state.modal.d.tags, ['chef', 'new'],
    'reopening the editor shows the tags that were saved');
  assert.strictEqual(F.state.modal.d.spice, 2, 'and the heat');
});

/* AND THE CSV IMPORT CARRIES ITS DISHES. `H.menu_import` has always existed
   and loops `dish_upsert` over what it is given; the call site sent a label
   and nothing else, so a menu imported from a spreadsheet was written into one
   browser and reached the outlet never. */
test('a menu imported from a spreadsheet reaches the outlet', () => {
  const src = SRC.slice(SRC.indexOf('  applyMenuImport(plan) {'));
  const body = src.slice(0, src.indexOf('  downloadText('));
  assert.match(body, /this\.queue\("menu_import"[\s\S]*?\{ dishes: dishes \}/,
    'the import op carries the dishes its handler reads');
  assert.match(body, /this\.opFor\("menu", r\)/,
    'composed through the one mapping every dish write goes through, so an'
    + ' imported dish and a typed one arrive in the same shape');
  assert.match(body, /made\.concat\(plan\.upd\.map/,
    'and it carries the UPDATED rows too — those are patches, and the holding'
    + ' pen would never have re-sent them');
});

/* ═══ A BILL THE OUTLET NO LONGER LISTS HAS BEEN CLOSED ════════════════════
   Reported: "tickets do not disappear from the other device."

   `buildLive()` sends the floor WHOLE — every open and held ticket, on every
   tick — precisely so that absence is an answer. `seed()` read it as no answer
   at all: `if (!there) { mine[k] = here; return; }` kept the local copy
   unconditionally, so a table settled at the counter stayed on the tablet for
   ever. The money was taken, the docket was gone from the pass, and the floor
   plan still showed it occupied until somebody reloaded.

   Two cases are indistinguishable by absence alone and only one may be
   dropped: a bill this device ADOPTED from the outlet, which the outlet has
   now stopped listing, and a bill this device OPENED whose lines may still be
   in the outbox. `src: "outlet"` is what separates them. */
test('a table settled elsewhere leaves this floor, and an un-pushed one stays', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const slot = (n) => F.state.outletId + ':' + n;
  const live = (tickets) => { F.__win.KPOS_REAL = { session: null, at: Date.now(),
    state: { tickets: tickets } }; };

  // ── the outlet has T05 open. This terminal adopts it.
  live({ 'T05:0': { id: 'srv-5', table: 'T05', split: 0, status: 'open',
    stage: 1, lines: [{ lid: 'l1', id: 'd1', qty: 1 }] } });
  F.seed();
  const five = Object.keys(F.state.tickets).filter((k) => /:5$/.test(k))[0];
  assert.ok(five, 'the outlet\'s table is adopted: ' + Object.keys(F.state.tickets));
  assert.strictEqual(F.state.tickets[five].src, 'outlet',
    'and it is marked as the outlet\'s, which is what makes it droppable');

  // ── a bill THIS device opened, which the outlet has never heard of.
  F.setState({ tickets: Object.assign({}, F.state.tickets,
    { [slot(9)]: { table: 'T09', status: 'occupied', lines: [{ lid: 'x1' }] } }) });

  // ── the counter settles T05. The outlet stops listing it; T09 is still not
  //    at the outlet at all.
  live({});
  F.seed();

  assert.ok(!Object.keys(F.state.tickets).some((k) => /:5$/.test(k)),
    'the settled table LEAVES this floor — that is the whole report');
  assert.ok(F.state.tickets[slot(9)],
    'and the bill this device opened stays: its lines may still be in the'
    + ' outbox, and dropping it would throw away a bill somebody is at');

  /* AND SOMEBODY MAY BE STANDING AT THE ONE THAT WENT. Dropping a settled
     table is right; dropping it out from under a waiter who has it open,
     leaving them on a bill with no rows, is not. */
  live({ 'T05:0': { id: 'srv-5', table: 'T05', split: 0, status: 'open',
    stage: 1, lines: [{ lid: 'l1' }] } });
  F.seed();
  const five2 = Object.keys(F.state.tickets).filter((k) => /:5$/.test(k))[0];
  F.setState({ activeTable: Number(five2.split(':')[1]),
    modal: { kind: 'pay' } });
  F.__toasts.length = 0;
  live({});
  F.seed();
  assert.strictEqual(F.state.activeTable, null,
    'the panel closes rather than showing a bill with no rows');
  assert.strictEqual(F.state.modal, null, 'and the pay screen with it');
  assert.match((F.__toasts[0] || {}).t || '', /settled on another terminal/,
    'and the operator is told what happened rather than watching it vanish');

  /* AND A TICK THAT CARRIES NOTHING CHANGES NOTHING. `buildLive` degrades to
     `state: null` rather than failing the poll, and a floor emptied by a
     failed read would be every table in the shop vanishing at once. */
  F.__win.KPOS_REAL = { session: null, state: null, at: Date.now() };
  const before = Object.keys(F.state.tickets).sort().join(',');
  F.seed();
  assert.strictEqual(Object.keys(F.state.tickets).sort().join(','), before,
    'a slice that could not be read leaves the floor exactly as it was');
});

test('a constraint refusal speaks English on the parked lane', () => {
  const sync = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sync.js'), 'utf8');
  assert.match(sync, /out\.push\(\{ opId: op\.opId, error: opSays\(e\) \}\)/,
    'the push handler translates rather than passing the driver message through');
  const { HANDLERS } = require('../src/apply');
  assert.ok(HANDLERS, 'apply is loadable');

  // The one that was reported, by name.
  assert.match(sync, /item_category_id_fkey:/,
    'the key that refused NESCAFE MILK is named');
  assert.match(sync, /menu section the outlet has no/,
    'and it says what is actually wrong, in words an operator can act on');

  // A sentence somebody wrote is never rewritten. That is the whole of the
  // rule, and losing it would silently swallow every RAISE in the schema.
  assert.match(sync, /return e\.message;/,
    'an unnamed refusal is repeated as written — a person composed it');
});

test('an op reaches the outlet with its payload, or is named as carrying none', () => {
  const { AUDIT_ONLY } = require('../src/apply');
  const named = new Set(AUDIT_ONLY.concat(BARE_BY_DESIGN));
  const bare = queueCalls(SRC).filter((q) => q.args <= 3 && !named.has(q.kind));
  const kinds = [...new Set(bare.map((q) => q.kind))].sort();
  assert.deepStrictEqual(kinds, [],
    'queued with a label and nothing else: ' + kinds.join(', ')
    + ' — give it the payload its handler reads, or name it in BARE_BY_DESIGN');

  // The parser is the whole contract, so prove it can see a payload that
  // follows a comment containing an apostrophe — which is what broke it.
  const probe = 'this.queue("x", "label", "entity",\n  // the operator\'s answer\n  { a: 1 });';
  const seen = queueCalls(probe);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].args, 4, 'a comment must not swallow the payload');
});

/* ═══ AN ID MINTED ON A DEVICE IS UNIQUE ACROSS DEVICES ═════════════════════
   Reported from a live store: three menu items added, two on one browser and
   one on another, and neither browser showed all three.

   `nextId()` counts the rows THIS browser is holding and adds one, so two
   terminals that have not yet seen each other's work mint the SAME id — and
   `dish_upsert` upserts on it, so the second to reach the outlet SILENTLY
   DESTROYS the first. Measured in two real browsers against a real outlet:
   three dishes added, TWO rows left, and the one that vanished had a toast
   saying it was created.

   Within one browser it is fine, which is what made it invisible: insertRow()
   unshifts the new row before queueing, so one terminal adding two in a row
   gets m4 then m5. Only the second terminal collides. */
test('two devices cannot mint the same id for a new record', () => {
  // Two INSTANCES is two devices: each holds its own copy of the same menu,
  // which is precisely the situation that collided.
  const A = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const B = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });

  // The defect, stated as a fact about the old rule: counting rows gives both
  // devices the same answer, every time.
  assert.strictEqual(A.nextId('menu', 'm'), B.nextId('menu', 'm'),
    'counting rows is what collided — this is the behaviour being replaced');

  // The rule that replaces it.
  /* TWENTY THOUSAND, not a thousand, and drawn as fast as the loop runs — so
     nearly all of them share a millisecond and the RANDOM half is what has to
     carry them. A weaker rule passes a small sample and fails a shop: the
     first version of this minted four bytes but kept one base36 digit of each,
     which is 1.68 million combinations rather than 2^32, and this assertion
     caught it at 999 of 1000. */
  const seen = new Set();
  for (let i = 0; i < 10000; i++) { seen.add(A.newId('m')); seen.add(B.newId('m')); }
  assert.strictEqual(seen.size, 20000,
    'twenty thousand ids from two devices, all distinct: ' + seen.size);
  const one = A.newId('m');
  assert.ok(/^m[0-9a-z]{14,}$/.test(one), 'still readable, still says what it is: ' + one);
  // The random half really is random: a rule that collapsed its alphabet would
  // show up here before it showed up as a lost row in a shop.
  const tail = new Set();
  for (let i = 0; i < 2000; i++) tail.add(A.newId('m').slice(-10));
  assert.ok(tail.size > 1990, 'the random half varies: ' + tail.size + ' of 2000');
  assert.ok(!/^m\d+$/.test(one), 'and never a count of what this device happens to hold');

  /* THROUGH THE SHIPPED EDITOR, not a retyped copy of it. This is the path the
     store used: the dish modal's own save handler. */
  const dish = { name: 'Bajiya', desc: '', cat: 'mains', price: 120, station: 'hot',
    tags: [], spice: 0, addons: null, hidden: false, img: '' };
  const mA = { kind: 'dishb', id: null, d: dish };
  A.state.modal = mA;
  A.modalVals(mA).dbSave();
  const mB = { kind: 'dishb', id: null, d: dish };
  B.state.modal = mB;
  B.modalVals(mB).dbSave();
  const idOf = (F) => (F.coll('menu') || [])[0] && (F.coll('menu') || [])[0].id;
  assert.ok(idOf(A) && idOf(B), 'both devices created a dish');
  assert.notStrictEqual(idOf(A), idOf(B),
    'and the second does not overwrite the first: ' + idOf(A) + ' vs ' + idOf(B));
});

/* The two that keep counting do so because their id never becomes a key at the
   outlet: an outlet row is replaced by the id the REGISTRY allocates, and a
   supplier's op resolves by NAME and carries no id at all. Anything else must
   mint. */
test('every id that becomes a key at the outlet is minted, not counted', () => {
  const IDX = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const counted = [...IDX.matchAll(/this\.nextId\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepStrictEqual(counted.sort(), ['"outlets"', '"vendors"'],
    'a new counted id has to justify itself here: ' + counted.join(' · '));
  assert.ok(/crypto\.getRandomValues/.test(IDX.slice(IDX.indexOf('newId(prefix) {'),
    IDX.indexOf('nextId(k, prefix) {'))), 'from the platform CSPRNG, like opId already is');

  /* THE WHOLE CLASS, not just the dish that was reported. Each of these ends
     up as the conflict target of an upsert on the server, so counting rows —
     or seeding only from a clock — costs a row the moment a second device
     does the same thing in the same window. */
  ['m', 'i', 'S', 'e', 'a', 's', 'mod', 'rw', 'b', 'c'].forEach((pfx) => {
    assert.ok(IDX.indexOf('this.newId("' + pfx + '")') > 0,
      'the "' + pfx + '" record is minted');
  });
  // And none of the old shapes survive anywhere.
  [/reduce\(\(a, x\) => Math\.max\(a, x\[0\]/, /Math\.max\(a, \+String\(x\.id\)/,
    /id: "e" \+ Date\.now\(\)/, /id: "a" \+ Date\.now\(\)/,
    /"mod" \+ \(mods\.length/, /"rw" \+ \(list\.length/, /"s" \+ \(\(K0\.STAFF/]
    .forEach((re) => assert.ok(!re.test(IDX),
      'a counted or clock-only id is back: ' + re));

  /* A BATCH'S PREFIX IS LOAD-BEARING. isSub() reads the first character to
     tell a batch from an ingredient, so a batch id that stopped starting with
     "S" would be costed as an ingredient nobody has — and an ingredient id
     that STARTED with one would be costed as a batch. */
  assert.ok(/isSub\(id\) \{ return String\(id\)\.charAt\(0\) === "S"; \}/.test(IDX),
    'the discriminator is still the first character');
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  for (let i = 0; i < 200; i++) {
    assert.ok(F.isSub(F.newId('S')), 'a batch is always recognised as one');
    assert.ok(!F.isSub(F.newId('i')), 'and an ingredient is never mistaken for one');
    assert.ok(!F.isSub(F.newId('m')), 'nor is a dish');
  }
});

/* ═══ THE POLL IS PAID FOR, SO IT HAD BETTER BE READ ════════════════════════
   Every signed-in terminal asks its outlet what changed every five seconds.
   The bridge dispatched that answer as `kpos-tick` and NOTHING CONSUMED IT —
   twelve requests a minute, per terminal, thrown away — so the only thing
   that ever re-read the outlet was a bootstrap: on sign-in, after this
   device's own material push, or on an explicit refresh. Measured in two real
   browsers: over twenty seconds, the second terminal saw none of a table, a
   dish, a section or a sale rung on the first.

   This is the shape of the fix, pinned where a silent deletion would show. */
test('the five-second answer is consumed, through the one merge path', () => {
  const BR = fs.readFileSync(path.join(__dirname, '..', 'app', 'kpos-bridge.js'), 'utf8');
  const IDX = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const BOOT = fs.readFileSync(path.join(__dirname, '..', 'src', 'bootstrap.js'), 'utf8');
  const SYNC = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sync.js'), 'utf8');

  // The tick is absorbed, not merely announced.
  assert.ok(/api\.onTick\(function \(t\) \{[\s\S]{0,300}absorb\(t\)/.test(BR),
    'every tick is absorbed — this listener is the whole defect');
  // ONE merge path: the tick re-uses the event a bootstrap already fires, so
  // the terminal grows no second way to fold the same rows in.
  assert.ok(/absorb\(t\) \{[\s\S]{0,1600}dispatchEvent\(new CustomEvent\("kpos-live"/.test(BR),
    'the slice arrives on kpos-live, the path a bootstrap already uses');
  assert.ok(/state: Object\.assign\(\{\}, prev, slice\)/.test(BR),
    'MERGED onto what the bootstrap gave, never assigned over it');

  // The server's half.
  assert.ok(/async function buildLive\(ctx, opts\)/.test(BOOT), 'there is a bounded slice');
  assert.ok(/out\.state = await buildLive\(req\.ctx, \{ since: since \}\)/.test(SYNC),
    'and the poll carries it, bounded by what this device has already been told');
  const live = BOOT.slice(BOOT.indexOf('async function buildLive'),
    BOOT.indexOf('function ticketMap'));
  assert.ok(/settledToday:/.test(live) && !/^\s+settled:/m.test(live),
    'today\'s takings are their own key: a partial answer must never be able to '
    + 'pass for the bootstrap\'s wholesale refill');
  assert.ok(/business_date = current_date/.test(live),
    'bounded by the OUTLET\'s trading day, not by an interval a container\'s UTC would shift');
  assert.ok(!/FROM journal|FROM stock_move|FROM bank_line/.test(live),
    'and it carries nothing that grows with trading history — this runs every five seconds');

  // The terminal merges today's rows rather than replacing its cache.
  assert.ok(/Array\.isArray\(live\.settledToday\)/.test(IDX),
    'the terminal knows the difference between today and everything');
  assert.ok(/patch\.settled = live\.settledToday\.concat\(kept\)/.test(IDX),
    'and merges by id rather than assigning a day over two months');

  /* WHAT THE SLICE DOES NOT CARRY, A BOOTSTRAP RE-READS — and the list of
     kinds it does carry FAILS OPEN, so an unclassified kind costs a read and
     can never cost staleness. */
  assert.ok(/var TICK_COVERS = \{/.test(BR), 'the closed list exists');
  const covers = BR.slice(BR.indexOf('var TICK_COVERS'), BR.indexOf('var READ_GAP_MS'));
  ['add_line', 'close_ticket', 'sale', 'kds_bump', 'qr_order']
    .forEach((k) => assert.ok(new RegExp('\\b' + k + ':').test(covers),
      k + ' is on the floor, so the tick already said what it did'));
  ['dish_upsert', 'menu_category_insert', 'member_upsert', 'employee_upsert', 'price_override']
    .forEach((k) => assert.ok(!new RegExp('\\b' + k + ':').test(covers),
      k + ' is not on the floor — it must force a re-read, or the menu goes stale'));
  assert.ok(/if \(TICK_COVERS\[o\.kind\]\) continue;\s*\n\s*reread\(\);/.test(BR),
    'an unknown kind falls THROUGH to a re-read, which is the safe direction');
  assert.ok(/setInterval\(function \(\) \{ if \(api\.signedIn\(\)\) reread\(\); \}, SLOW_MS\)/.test(BR),
    'and a slow floor, so a sale\'s points, credit and ledger cannot be stale for ever');
});

/* A FAULT FROM A BROWSER EXTENSION IS NOT THIS BUILD'S BUG. Found on a live
   till's own Diagnostics screen: two caught faults, both "Failed to connect to
   MetaMask" — a wallet extension injected into the page — reported under
   "a fault that repeats on one action is a bug to report". That sends an
   operator to raise a ticket against software this project does not ship.
   Both are still counted and still shown; only ours make the line a warning. */
test('a fault says whose fault it is', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  assert.strictEqual(F.faultFrom('chrome-extension://abc/inpage.js'), 'extension');
  assert.strictEqual(F.faultFrom('moz-extension://abc/inpage.js'), 'extension');
  assert.strictEqual(F.faultFrom('at connect (chrome-extension://x/y.js:1:1)'), 'extension',
    'a rejection carries its origin in the stack, not a filename');
  assert.strictEqual(F.faultFrom('https://app.kashikeyopos.com/index.html'), null,
    'the terminal\'s own frames are ours to answer for');
  assert.strictEqual(F.faultFrom(undefined), null);

  const line = () => F.diagnose().find((r) => r.name === 'Script faults this session');

  // Ours: a warning, in the words that ask for a bug report.
  F._faults = [{ at: '04:04', where: 'promise', msg: 'boom' }];
  let row = line();
  assert.strictEqual(row.ok, 'warn', 'our own fault is a warning');
  assert.match(row.why, /bug to report/, 'and is ours to answer for');

  // Theirs alone: counted, named, and not a warning about this build.
  F._faults = [{ at: '04:04', where: 'extension', msg: 'Failed to connect to MetaMask' }];
  row = line();
  assert.match(row.why, /extension installed in this browser/,
    'it says where the fault came from: ' + row.why);
  assert.ok(!/bug to report/.test(row.why), 'and does not call it a bug against this build');
  assert.strictEqual(row.ok, 'ok', 'nor a warning about something nobody here can fix');
  assert.match(row.val, /browser extension/, 'while still being counted, not hidden');

  // Both: the count is ours, the extension is named beside it.
  F._faults = [{ at: '04:04', where: 'extension', msg: 'MetaMask' },
    { at: '04:05', where: 'window', msg: 'boom' }];
  row = line();
  assert.strictEqual(row.ok, 'warn');
  assert.match(row.val, /1 caught .* 1 from a browser extension/,
    'neither is hidden behind the other: ' + row.val);
});

/* ═══ A MENU SECTION IS THE OUTLET'S, NOT ONE BROWSER'S ═════════════════════
   The till's "sections" ARE `menu_category` rows — that is what the bootstrap
   publishes as MENU_CATEGORIES and what `item.category_id` references. Two of
   the three screens that wrote one named `menu_section`, which is the grouping
   ABOVE a category and a different table entirely, and all three queued their
   op with no payload. The consequence surfaced one screen later wearing a
   different face: `item_category_id_fkey` refusing a dish, for ever.

   Pinned statically as well as behaviourally, because the behavioural half
   above only sees the paths the harness walks. */
test('the till writes a section to the table the rest of the app reads', () => {
  const IDX = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const BOOT = fs.readFileSync(path.join(__dirname, '..', 'src', 'bootstrap.js'), 'utf8');

  // No client path queues the wrong table any more.
  ['menu_section_insert', 'menu_section_update', 'menu_section_reorder'].forEach((k) => {
    assert.ok(!new RegExp('queue\\(\\s*"' + k + '"').test(IDX),
      k + ' writes menu_section, which is not what a till calls a section');
  });
  // But the handlers stay, for a device still holding one in its outbox.
  ['menu_section_insert', 'menu_section_update', 'menu_section_reorder'].forEach((k) => {
    assert.strictEqual(typeof HANDLERS[k], 'function',
      k + ' keeps its handler for an outbox that holds one');
  });

  // One seam, and every section write goes through it.
  assert.ok(/catWrite\(id, meta, label\) \{/.test(IDX), 'there is one seam for a section');
  const seam = IDX.slice(IDX.indexOf('catWrite(id, meta, label)'),
    IDX.indexOf('setCatMeta(id, patch, label)'));
  ['id:', 'name:', 'icon:', 'colour:', 'station:', 'hidden:'].forEach((k) => {
    assert.ok(seam.indexOf(k) >= 0, 'the section carries ' + k + ' — it collected it');
  });

  // And the outlet's answer is published in the words the terminal reads,
  // with the colour no longer standing in for the glyph.
  const pub = BOOT.slice(BOOT.indexOf('MENU_CATEGORIES: categories.rows.map'),
    BOOT.indexOf('MENU_SECTIONS:'));
  assert.ok(/icon: r\.icon \|\| null/.test(pub), 'the glyph is published as the glyph');
  assert.ok(/color: r\.colour \|\| null/.test(pub), 'and the colour as the colour');
  assert.ok(!/icon: r\.colour/.test(pub), 'the two are not one column read twice');
  assert.ok(/station: r\.station \|\| null/.test(pub) && /hidden: !!r\.hidden/.test(pub),
    'along with the station and whether the section shows at all');

  // The local copy is a holding pen, not a private fork — the same rule a
  // measured yield and a saved batch already follow.
  assert.ok(/reconcileCats\(\) \{/.test(IDX), 'the pen empties itself after a bootstrap');
  const rec = IDX.slice(IDX.indexOf('reconcileCats() {'),
    IDX.indexOf('reconcileCats() {') + 1800);
  assert.ok(/pub\.icon != null/.test(rec),
    'dropped once the outlet has published that section');
  assert.ok(/_catSent/.test(rec),
    'and a section the outlet never received is re-sent once, not on every poll');
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

  assert.ok(/WHERE i\.active AND NOT i\.off_menu AND NOT i\.is_batch/.test(OUT),
    'and a guest is offered neither a hidden dish nor a batch');
  // The QR channel is the third axis (048): resolved in the same query, once,
  // so the table menu and the member portal can never disagree.
  assert.ok(/AND NOT i\.qr_off AND NOT coalesce\(mc\.hidden, false\)/.test(OUT),
    'a dish or a section off the QR never reaches a phone');
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
    // This reason is rendered on /account now, so it reads as a sentence.
    assert.match(await say('', ''), /no email transport is configured/,
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

/* ═══ THE FALLBACK THE WHOLE DOCTRINE RESTS ON ══════════════════════════════
   "A fallback is not a failure" is stated in src/email.js and shown to the
   person waiting: with no transport, the code is written where an
   administrator can read it out, and the screen says so.

   It had never worked. `chain.audit.outlet_id` was NOT NULL and account events
   are written with NULL — the account plane sits ABOVE every outlet, and the
   events that matter most happen before one exists — so the insert failed on
   the constraint, was swallowed by a `.catch(() => {})`, and not one account
   event ever reached the trail. The code was not in the payload either. Both
   halves were false while /account told the customer where to look.

   Found by creating an account on a fresh install and going to fetch the code
   the screen promised. */
test('an account code that could not be sent is where the screen says it is', () => {
  const mig = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations',
    '035_an_account_belongs_to_no_outlet.sql'), 'utf8');
  assert.match(mig, /ALTER TABLE chain\.audit ALTER COLUMN outlet_id DROP NOT NULL/,
    'an account event belongs to no outlet, and the column now says so');

  const acc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'account.js'), 'utf8');
  const issue = acc.slice(acc.indexOf('async function issueCode'), acc.indexOf('function ackCode'));
  assert.ok(issue.length > 200, 'found issueCode');

  /* The code goes on the trail ONLY where it went nowhere else. A delivered
     credential written to a second place is a second place to steal it from,
     and the trail is read by more people than an inbox is. */
  assert.match(issue, /out\.sent \? \{\} : \{/,
    'the code is attached only when the send did not happen');
  assert.ok(/code: value/.test(issue), 'and it is the code itself, not a note about one');

  // The screen and the server have to agree about where to look.
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'account.html'), 'utf8');
  assert.ok(/audit trail/.test(page),
    'the sign-in screen still points at the trail — which is now true');
});

/* THE PASSWORDLESS DOOR ON THE SIGNUP FORM SENT NOTHING.

   Found in a live install's own HTTP log: two POSTs to /api/account/code at
   00:33 and 00:39 and never one to /signup, against a Resend account whose
   most recent send was five days earlier. The customer was pressing "Email me
   a code instead" on the CREATE ACCOUNT form.

   /code is the existing-account door. For an address it has never seen it
   answers "if that address has an account, a code is on its way" and sends
   nothing — deliberately, because any other answer enumerates the customer
   list. The page then reported "Code sent. It lasts ten minutes" and showed
   Check your email over an inbox that would never receive one: the exact
   shape this file exists to refuse, and worse than the backup screen, because
   it stops a customer signing up at all.

   Nothing is lost by taking it off that form. Creating an account with the
   password left blank IS the passwordless path, and it sends a code. */
test('the code button is offered only on the door that can send one', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'account.html'), 'utf8');
  const paint = page.match(/\$\("useCode"\)\.style\.display\s*=\s*([^;]+);/);
  assert.ok(paint, 'account.html still decides when the code button is shown');
  assert.match(paint[1], /mode === "signin"/,
    'the code button is a SIGN-IN affordance: on the signup form it reports a'
    + ' send the server deliberately never makes');
  assert.ok(!/code \? "none" : "inline-block"/.test(paint[1]),
    'the old rule showed it on every door but the code step, signup included');

  // The blank-password path has to stay discoverable, or removing the button
  // takes the only passwordless route with it.
  assert.match(page, /leave it blank and sign in with a code/,
    'creating the account is the passwordless path, and the form says so');
});

/* A REFUSAL PRINTED IN GREEN.

   Found on the live install, in a screenshot of its own /account screen: the
   heading read "Check your email", the subtitle read "We sent a six-digit code
   to <address>", and underneath, in the SUCCESS box, sat

     the email transport refused this install: 401 {"statusCode":401,
     "name":"validation_error","message":"API key is invalid"}

   All three are the same defect wearing three faces. The transport answered
   and refused; no message was sent; and the screen said one was on its way,
   twice as fact and once in the colour of work that succeeded. A customer
   reading it waits for an email that will never arrive.

   The page had two boxes and say() wrote into whichever it was not, so
   anything that was not an error became a success by default — the same shape
   as every other control this file exists to refuse. Three temperatures now,
   and the two sentences that state a fact read off the flag that knows. */
test('a code that was not sent is never reported as one that was', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'account.html'), 'utf8');

  // The refusal never rides the success style.
  assert.ok(!/say\(\s*"ok"[^;]*undelivered\(/.test(page),
    'the undelivered branch is not a success — it is a send that did not'
    + ' happen, and green is the one colour it may never wear');
  assert.strictEqual((page.match(/: undelivered\(r,/g) || []).length, 2,
    'both senders — creating an account and asking for a code — report it');
  assert.strictEqual((page.match(/say\(sent \? "ok" : "warn"/g) || []).length, 2,
    'and both choose the temperature from whether the send actually happened');

  // That temperature has to exist, or "warn" silently renders as unstyled text.
  assert.match(page, /\.msg\.warn\{[^}]*--warn-bright/,
    'the warning tier is its own colour, from the shared token set');
  assert.ok(!/^\.ok\{/m.test(page) && !/^\.err,\.ok\{/m.test(page),
    'and the two-element shape that caused this is gone, not patched');

  /* THE HEADING IS A STATEMENT OF FACT. Colour was the visible half; the other
     half is that "Check your email" and "We sent a six-digit code to …" were
     printed whether or not anything was sent. */
  const paint = page.slice(page.indexOf('function paint()'),
    page.indexOf('function rememberStore'));
  assert.ok(paint.length > 200, 'found paint()');
  assert.match(paint, /sent \? "Check your email" : "No code was sent"/,
    'the heading says which of the two happened');
  assert.match(paint, /could not be/,
    'and the subtitle stops claiming a send it did not make');
  assert.match(paint, /audit trail/,
    'and says where the code actually is, which is the only thing left to do');
  assert.match(paint, /codeLabel/,
    'and so does the field label — "The six digits we sent you" over six empty'
    + ' boxes is the same claim in smaller type');
});

/* A DISH ADDED ON THE TILL VANISHED WHEN THE FIRST BILL WAS RUNG.

   Reported from the live store, and it was two screens at once — the till grid
   and the menu master — because both read K().MENU.

   A back-office row created on the till lives in TWO places until the outlet
   accepts it: unshifted into the live collection, and held in `state.local`.
   `applyLocal()` is what puts the held copy back after a bootstrap replaces
   window.KPOS wholesale, and it was wired like this:

     if (!this.state.ready) window.addEventListener("kpos-data-ready", …);
     else this.applyLocal();

   `ready` starts as `!!window.KPOS`, and kashikeyo-data.js sets that and fires
   kpos-data-ready before the component ever mounts — so the ELSE branch ran,
   applyLocal() happened once, and the listener WAS NEVER REGISTERED. Every
   hydrate after that replaced the menu with the server's copy and nothing put
   the un-replayed row back.

   The trigger is the first bill because that is the first push: a material
   push fires kpos-sync-done, the bridge re-bootstraps, and the menu is
   replaced. Reloading brought it back, which is what made a lost row look
   like a display glitch.

   Proved in real Chromium against both versions of the shipped page — WIPED
   before, SURVIVED after. */
test('an un-synced back-office row survives every bootstrap, not just the first', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const mount = page.slice(page.indexOf('_mountRest() {'),
    page.indexOf('KPOS_REPAINT = (patch)'));
  assert.ok(mount.length > 200, 'found _mountRest()');

  assert.ok(!/if \(!this\.state\.ready\) window\.addEventListener\("kpos-data-ready"/.test(mount),
    'the replay is no longer registered only when the data has not arrived yet'
    + ' — which was never, because the data script fires before this mounts');
  assert.match(mount, /window\.addEventListener\("kpos-data-ready", \(\) => \{[\s\S]*this\.applyLocal\(\)/,
    'every kpos-data-ready replays the holding pen');
  assert.match(mount, /if \(this\.state\.ready\) this\.applyLocal\(\);/,
    'and it still runs immediately when the data was already there, so `ready`'
    + ' means what it meant');

  /* The bridge fires that event on EVERY hydrate for exactly this reason, and
     a bootstrap replaces the collections wholesale. Both halves have to stay
     true or the wiring above is decoration. */
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'app', 'kpos-bridge.js'), 'utf8');
  assert.match(bridge, /dispatchEvent\(new Event\("kpos-data-ready"\)\)/,
    'the bridge announces every hydrate');
  assert.match(bridge, /K\[k\] = live\[k\];/,
    'and a bootstrap does replace the collection, which is what makes the'
    + ' replay necessary rather than merely tidy');

  // applyLocal itself must stay idempotent, or replaying on every bootstrap
  // would duplicate rows instead of restoring them.
  const apply = page.slice(page.indexOf('applyLocal() {'), page.indexOf('/* ── master data, one seam'));
  assert.match(apply, /if \(there && there !== row\) \{ dropped\+\+; return; \}/,
    'a row the outlet has already accepted is not added twice — it leaves the'
    + ' pen, because a held copy that outlives delivery shadows every later edit');
  assert.match(apply, /const there = arr\.filter\(\(x\) => this\.sameRow\(k, x, row\)\)\[0\];/,
    'and the match is by identity first, so this replay cannot read its own'
    + ' insertion from the last pass as the outlet having accepted the row —'
    + ' through sameRow(), which also knows the collections whose id the OUTLET'
    + ' allocates rather than this device');
});

/* A DATABASE IS NOT A LOBBY. Postgres grants CONNECT on every database to
   PUBLIC, so an outlet role could open a session on any business database in
   the cluster. It could read nothing there — every schema denied, belt one
   holding — but it could sit inside another customer's database and read the
   world-readable catalogs: schema names, object counts, the shape of somebody
   else's install. Metadata, not data, and closed anyway, because the guarantee
   this build states is refusal AT another business's database. */
test('a business database, and the registry, are shut to everyone not named', () => {
  const dir = path.join(__dirname, '..', 'src', 'migrations');
  const biz = fs.readFileSync(path.join(dir, '039_a_database_is_not_a_lobby.sql'), 'utf8');
  const reg = fs.readFileSync(path.join(dir, 'control', '003_the_registry_is_not_a_lobby.sql'), 'utf8');

  assert.match(biz, /REVOKE CONNECT ON DATABASE %I FROM PUBLIC/);
  assert.match(reg, /REVOKE CONNECT ON DATABASE %I FROM PUBLIC/);

  /* ORDER IS THE WHOLE SAFETY OF THAT FILE: the grants come first and the
     revoke last, in one transaction, so there is no instant at which a store's
     own role has lost CONNECT and not yet been given it back. */
  assert.ok(biz.indexOf('GRANT CONNECT ON DATABASE %I TO %I')
    < biz.indexOf('REVOKE CONNECT ON DATABASE %I FROM PUBLIC'),
  'every outlet role here keeps its way in BEFORE the door closes');
  assert.match(biz, /kashikeyo_report/,
    'and so does the estate read role, which is the one deliberate crossing');

  // The roles are discovered from the schemas that are actually here, not from
  // a list somebody has to remember to update.
  assert.match(biz, /FROM pg_namespace[\s\S]*nspname ~ '\^outlet_\[0-9\]\+\$'/);

  /* And a NEW outlet gets it at provision time, which is also what makes
     `provision:outlet --all` — the remedy /readyz prints — actually restore
     this rather than leaving a store connected but blind. */
  const prov = fs.readFileSync(path.join(dir, '003_outlet_provision.sql'), 'utf8');
  assert.match(prov, /GRANT CONNECT ON DATABASE %I TO %I', current_database\(\), r/);
});

/* A CREDENTIAL EVERY CALLER HAS TO REMEMBER IS ONE A CALLER WILL FORGET.

   app/account.html's api() attached the account token only where a caller
   passed it as a header, and exactly one of eleven callers did. The one that
   did not, and mattered, was POST /api/account/business — made the instant a
   six-digit code verifies, to create the business the account is about to
   onboard into. It went out bare, was refused "sign in again", and the
   customer read that as the code having been rejected, because typing the code
   is the last thing they did.

   The fix is that api() attaches it, once, for everybody. This pins the shape
   so nobody puts the remembering back on the call sites. */
test('the account token rides on every call, not on whoever remembers it', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'account.html'), 'utf8');
  const api = page.slice(page.indexOf('function api(path, body, headers)'),
    page.indexOf('function paint()'));
  assert.ok(api.length > 100, 'found api()');

  assert.match(api, /token\(\)[\s\S]*authorization[\s\S]*Bearer/,
    'api() builds the header itself from the stored token');
  assert.match(api, /Object\.assign\([^)]*auth/,
    'and merges it into every request rather than waiting to be handed one');

  /* And no call site hand-rolls one any more: a second way to attach it is a
     second thing to get wrong, which is how this started. */
  const calls = page.match(/api\("\/[^)]*authorization/g) || [];
  assert.deepStrictEqual(calls, [],
    'no caller composes its own Authorization header');
});

/* CREATING A BUSINESS IS THE MOST CONSEQUENTIAL THING THIS INSTALL DOES, AND
   IT WAS SILENT. Audited against a real store's first hour: boot logs
   "[migrate] N business database(s) at head 38", and creating one logged
   NOTHING — a CREATE DATABASE and thirty-eight migrations, no line anywhere.
   The progress is recorded in chain.business.build_state, which is right for a
   half-built row; the process log is where somebody looks when a customer says
   the signup hung, and it had nothing to show them. */
test('creating a business says so, and says so when it fails', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'business.js'), 'utf8');
  const make = src.slice(src.indexOf('async function createBusiness'),
    src.indexOf('module.exports'));
  assert.ok(make.length > 400, 'found createBusiness()');

  assert.ok(!/migrateBusiness\(db, \(\) => \{\}\)/.test(make),
    'the migration logger is no longer thrown away');
  assert.match(make, /migrateBusiness\(db, \(line\) => console\.log/,
    'every migration line reaches the log, named by business');
  assert.match(make, /console\.log\('\[business\] ' \+ id[\s\S]*creating /,
    'and the create is announced before it happens');
  assert.match(make, /console\.log\('\[business\] ' \+ id[\s\S]*live/,
    'and the finish is announced with where it landed');
  assert.match(make, /console\.error\('\[business\] ' \+ id[\s\S]*FAILED/,
    'and a failure is an error line, not only a column nobody is watching');
});

/* ONE POLL LOOP, AND THE SLOT IS CLAIMED SYNCHRONOUSLY. `_timer` was assigned
   only after the first `await this.pull()` resolved, so the re-entrancy guard
   was open for a whole network round trip. Nothing reaches it today — the
   bridge's own start() guard is the only caller — but the symptom would be
   every terminal polling its outlet twice for ever, with nothing on any screen
   to say so. */
test('the poll loop cannot be started twice while its first tick is in flight', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'app', 'kashikeyo-api.js'), 'utf8');
  const tick = api.slice(api.indexOf('onTick(fn)'), api.indexOf('/* ── writes:'));
  assert.ok(tick.length > 200, 'found onTick()');

  assert.ok(!/if \(!this\._timer\) \{/.test(tick),
    'the guard is no longer the timer handle, which only exists after an await');
  assert.match(tick, /if \(!this\._running\)[\s\S]*this\._running = true;/,
    'the slot is claimed before anything is awaited');
  assert.match(tick, /if \(!this\._running\) return;/,
    'and a tick that lands after stop() does not resurrect the loop it stopped');
  assert.match(tick, /stop\(\) \{\s*this\._running = false;/,
    'which is the half stop() was missing');
});

/* A CONTROL DOES WHAT IT SAYS, OR IT IS NOT A CONTROL.

   Found by running the restore drill the deployment guide asks for. The
   database restored perfectly — same bills, same trial balance to the laari,
   same install uuid — but the app's own Backup and Restore screens turned out
   to be a picture of a backup system. `backup_run`, `backup_create`,
   `restore_run` and `store_reset` are all AUDIT_ONLY: they record the press
   and do nothing. Yet the Restore card listed archives with dates and
   sizes, the form demanded a typed RESTORE, and the toast said the tills would
   stay locked until it finished. An operator who trusted that screen believed
   they had backups and a way back; they had neither.

   THE APP TAKES BACKUPS NOW (src/backup.js, `npm run backup`), and that does
   not soften this rule by a word - it sharpens it. The archives are taken
   against the database with the install's own credentials and recorded in the
   REGISTRY, which an outlet login role is refused at the door of; so the till
   still cannot read whether one landed, and still may not say. The three op
   kinds stay audit-only and unbuttoned for the same reason they always were:
   a restore is a destructive act belonging to whoever holds the database, not
   a control on a counter.

   The same shape had "3 active" sessions on an install nobody had signed into
   twice, over a control that queued an audit-only op and toasted a "+2" it had
   invented — so a manager who had lost a tablet was told every other session
   was ended and none of them was. That one had a real endpoint all along.

   The rule this pins: an AUDIT_ONLY kind may be queued by a screen that says
   it is RECORDING something. It may never be queued by a screen that reports
   the thing was DONE. */
test('no screen claims an action this build only records', () => {
  const banned = ['backup_run', 'restore_run', 'backup_create'];
  banned.forEach((k) => {
    assert.ok(!new RegExp('queue\\(\\s*"' + k + '"').test(SRC),
      k + ' is audit-only — no screen may queue it while reporting a backup or a restore');
  });

  // And the fictional archive list, retention and size are gone with it.
  ['Newest archive', 'Oldest retained', '30 nightly', '41 MB', '39 MB'].forEach((lie) => {
    assert.ok(SRC.indexOf(lie) < 0, 'an invented backup figure is still on screen: ' + lie);
  });

  /* THE CARD MUST NOT SWING THE OTHER WAY EITHER. It used to say "This app
     takes none of its own", which was true when it was written and is false
     now - and a screen that is confidently wrong in the reassuring direction
     is the same defect as one that is confidently wrong in the alarming one.
     What it may not do is print a last-backup time, because that record is in
     the registry and this page cannot reach it. */
  assert.ok(SRC.indexOf('takes none of its own') < 0,
    'the Backup card still claims the app takes no copies, which stopped being'
    + ' true when src/backup.js landed');
  assert.ok(!/Last (backup|archive)[^\n]{0,40}(ago|20\d\d)/.test(SRC),
    'and it must not print a last-backup time it has no way of reading');
  assert.match(SRC, /npm run backup -- --check/,
    'it names where the answer actually is instead');
  assert.match(SRC, /beside the live one first/i,
    'and the Restore card says a restore lands beside, not over - which is'
    + ' what makes it safe to describe at all');

  /* The Terminal card beside them carried two more of the same: an app version
     of "4.2.1" on a build numbered otherwise — the figure somebody rings
     support quoting — and an offline cache of "42 MB" that was never measured.
     "behind" on the Sync screen was a verdict against that same literal. */
  assert.ok(SRC.indexOf('42 MB') < 0, 'the cache size was never measured');
  assert.ok(!/"4\.2\.1"/.test(SRC.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')),
    'and the version was a literal');
  assert.match(SRC, /appVer\(\) \{ return \(\(K\(\) \|\| \{\}\)\.APPVER\)/,
    'the version comes from the bootstrap');
  assert.match(SRC, /navigator\.storage\.estimate\(\)/, 'and the cache is asked of the browser');
  assert.match(SRC, /return "not measured"/, 'with an honest answer where it will not say');
  const bs = fs.readFileSync(path.join(__dirname, '..', 'src', 'bootstrap.js'), 'utf8');
  assert.match(bs, /APPVER: APP_VERSION/, 'read from package.json, the one place it is stated');

  /* AND THE RESET IS NOW THE OTHER DIRECTION OF THE SAME RULE. It used to
     file a REQUEST and say so, which was the honest thing to do while nothing
     behind it erased anything. `src/reset.js` erases, so the copy states an
     erase — and the rule holds because the control and the sentence moved
     TOGETHER. What must never come back is the pairing that failed the rule:
     the audit-only op under a screen reporting the deed.

     It is a CALL, not an outbox op, for the same reason signing out everywhere
     is: a half-applied reset behind a toast is precisely the defect the
     holding pen exists to catch, and 42 tables is not a till write. */
  assert.ok(!/queue\(\s*"store_reset"/.test(SRC),
    'the reset is a call to the outlet, never an op queued behind a toast');
  assert.match(SRC, /B\.resetTrade\(/,
    'the control calls POST /api/outlet/:id/reset/trade');
  assert.ok(SRC.indexOf('nothing has been erased') < 0,
    'the request-only wording outlived the request-only behaviour');

  /* THE CONFIRMATION STATES A FIGURE, NOT A PROMISE. The census is fetched
     before the form opens — "this erases your trading" is a sentence somebody
     skims; the bill count and the money are what stop them if it is the wrong
     store. A form that gains that fact after opening is a form nobody reads it
     in, which is the lesson the setup export already paid for. */
  assert.match(SRC, /B\.tradeCensus\(\)/, 'the card asks the outlet what is there');
  assert.ok(SRC.indexOf('B.tradeCensus()') < SRC.indexOf('this.openForm("resetStore")'),
    'and it asks BEFORE the form opens');
  assert.match(SRC, /This store holds/, 'the foot leads with the count');
  assert.match(SRC, /has not traded yet/,
    'and an untraded store is told there is nothing to clear rather than shown a zero');

  /* THE WORD IS ASKED FOR AT BOTH ENDS. A screen is not the only caller a door
     can have, so the door asks too — this is the most destructive thing in the
     product and a client-side guard is a courtesy, never a gate. */
  assert.match(SRC, /toUpperCase\(\) !== "RESET"/, 'the screen holds out for the word');
  const rt = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'outlet.js'), 'utf8');
  assert.match(rt, /confirm[^\n]*RESET/, 'and so does the route');
  assert.match(rt, /'\/reset\/trade', sameOutlet, atLeast\('owner'\)/,
    'at rank 5, because this is the whole of what the store traded leaving the building');

  // Sessions: a measured count, and the real endpoint.
  assert.ok(SRC.indexOf('"3 active"') < 0 && SRC.indexOf('"2 active"') < 0,
    'the session counts were literals on an install nobody had signed into twice');
  assert.ok(!/queue\(\s*"revoke_sessions"/.test(SRC),
    'signing out everywhere is a call, not an outbox op — a lost tablet cannot wait for a flush');
  assert.match(SRC, /B\.revokeSessions\(\)/,
    'the control calls POST /api/auth/revoke');
  assert.match(SRC, /SESS\.live/, 'and the chip shows the count the outlet published');

  const api = fs.readFileSync(path.join(__dirname, '..', 'app', 'kashikeyo-api.js'), 'utf8');
  assert.match(api, /revokeSessions\(\)\s*\{[\s\S]*?\/api\/auth\/revoke/,
    'the client has that call');

  const boot = fs.readFileSync(path.join(__dirname, '..', 'src', 'bootstrap.js'), 'utf8');
  assert.match(boot, /SESSIONS:/, 'and the bootstrap measures it rather than the screen guessing');

  /* The handlers stay — a device that was offline across this change may be
     holding one of these in its outbox, exactly like `ticket_status`. */
  ['backup_run', 'restore_run', 'backup_create', 'store_reset', 'revoke_sessions']
    .forEach((k) => assert.ok(AUDIT_ONLY.indexOf(k) >= 0,
      k + ' keeps its audit-only handler for an outbox that still holds one'));
});

/* WHO WORKS HERE IS THE OUTLET'S ANSWER, NOT THE TERMINAL'S.

   Same shape as the backup screen, found in the same pass and worse in kind.
   Every write on Users & Roles went through `patchRows("users", …)`, which
   paints the local table and queues `users_update` — a kind with NO HANDLER.
   `applyOp` records an unhandled kind as `unmodelled` and answers success, so
   the screen said "Removed" and the person kept their rank, their PIN and
   their sign-in. Proved against a live outlet: `chain.staff.active` was still
   true after the op the Remove button queues. Suspending suspended nobody. A
   PIN reset reset nothing. And "Invite user" promised a magic link this build
   has never had, writing a local row reading "Invited" and creating no account
   at all — while POST /api/auth/staff and PATCH /api/auth/staff/:id sat there
   fully written, guarded at rank 4, with nothing calling them. */
test('granting and revoking access reaches the outlet', () => {
  // (the comment above the seam quotes the old call, so match a real one)
  assert.ok(!/this\.patchRows\("users"/.test(SRC),
    'no staff write may be a local paint plus an unmodelled op');
  assert.ok(!/queue\(\s*"users_update"/.test(SRC), 'and users_update has no handler to reach');
  assert.ok(!HANDLERS.users_update, 'still no handler — which is why the screen must not queue it');

  // Every one of the four writes now calls the endpoint.
  assert.match(SRC, /B\.addStaff\(\{/, 'creating an account calls POST /api/auth/staff');
  assert.match(SRC, /B\.editStaff\(u\.id, \{ active: false \}\)/, 'removing sets active false');
  assert.match(SRC, /B\.editStaff\(u\.id, \{ pin: p \}\)/, 'a PIN reset sends the PIN');
  assert.match(SRC, /active: v\.status !== "Suspended"/, 'suspending sets active false');

  /* The rank IS the gate — src/auth.js and the RLS policies both read it — so
     a role change that sent only the key would leave the old rank enforced.

     And it must be the CAPABILITY ladder it carries, not the seniority one.
     This pinned rankOf, which is the seniority table, where a Cashier sits at 1
     because a cashier is the most junior person on the floor. That number went
     straight into chain.staff.rank, so a cashier created here landed at Kitchen
     and was refused from the Till rung the job is made of. */
  assert.match(SRC, /rank: this\.rankFor\(v\.role\)/,
    'a role change carries the rank the server actually gates on');
  assert.match(SRC, /rank: this\.rankFor\(v\.role\), roleKey: v\.role/,
    'and so does creating an account');
  assert.ok(!/rank: this\.rankOf\(/.test(SRC),
    'seniority is who may act on whom — it is never what a grant writes');

  // No offline path: an optimistic grant is the one write that must not be.
  assert.match(SRC, /async staffWrite\(run, said\)/, 'one seam for all four');
  assert.match(SRC, /this terminal is not connected to one/,
    'and it refuses in words when there is no outlet to ask');

  // The magic link that never existed.
  assert.ok(SRC.indexOf('Magic-link invite') < 0, 'no magic link is promised');
  assert.ok(SRC.indexOf('link not used yet') < 0, 'and no account waits on one');

  const bridge = fs.readFileSync(path.join(__dirname, '..', 'app', 'kpos-bridge.js'), 'utf8');
  assert.match(bridge, /addStaff: function/, 'the bridge carries both calls');
  assert.match(bridge, /editStaff: function/);
  /* And the screen reads the roll that says whether an account is ACTIVE. The
     anonymous roster carries only the faces at the terminal, so a suspended
     account rendered as absent rather than as suspended. */
  assert.match(bridge, /api\.token \? await api\.staff\(\)/,
    'signed in, USERS comes from the authenticated staff roll');
  assert.match(bridge, /status: !u\.active \? "Suspended"/, 'which is what makes Suspended renderable');
});

/* A REVOKED TOKEN IS REFUSED, NOT MERELY RECORDED.

   The continuation of the sweep above, and the worst of it. Two columns
   existed and NOTHING EVER READ EITHER. `session()` in src/auth.js verified
   the JWT and touched no database, so:

     · "Sign out other sessions" set `chain.session.revoked_at` and the signed-
       out terminals kept working for the twelve hours their tokens had left —
       including, embarrassingly, right after that button was wired to the real
       endpoint in the previous commit;
     · deregistering a device set `chain.device.revoked` and the device kept
       signing in and kept writing, which is precisely the scenario the card's
       own copy invokes: a lost tablet.

   And underneath both, the device id bound into every token was a FREE-TEXT
   FIELD in Settings defaulting to "dev_CHA_T1", so `chain.device` had no row
   for it and nothing about a device could have been enforced even if it had
   been checked. The Sync screen meanwhile rendered seven hardcoded terminals
   belonging to outlets KAS-CHA, KAS-MAA and KAS-HUL — which exist on no real
   install — with invented pending counts and an invented version, while the
   real `chain.device` rows the bootstrap has always published went unread. */
test('a revoked session or device is refused, not merely recorded', () => {
  const auth = fs.readFileSync(path.join(__dirname, '..', 'src', 'auth.js'), 'utf8');
  assert.match(auth, /async function session\(req, res, next\)/,
    'the check is in the one place all three routers mount');
  assert.match(auth, /await stillGood\(req\.ctx\)/, 'and it is actually awaited');
  assert.match(auth, /deregistered — ask a manager to enrol it again/,
    'a deregistered device is named, because keying a PIN will not fix it');

  const rev = fs.readFileSync(path.join(__dirname, '..', 'src', 'revoked.js'), 'utf8');
  assert.match(rev, /revoked_at, expires_at FROM chain\.session/, 'the session is asked about');
  assert.match(rev, /SELECT revoked FROM chain\.device/, 'and so is the device');
  /* Fails OPEN on an unreachable database: refusing there would sign the whole
     floor out over a blip, which is worse than a revocation landing late. Same
     call src/limit.js makes. */
  assert.match(rev, /return \{ ok: true \};[\s\S]{0,40}\}\s*\n\s*if \(row\.d/,
    'an unreachable database does not sign the floor out');
  assert.match(rev, /withOutletRead/, 'read under the outlet role — no seventh owner exception');

  const ra = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
  // One process, so the revoking endpoints make it immediate rather than 30s.
  ['/revoke', '/devices/:id/signout', '/devices/:id/revoke'].forEach(() => {});
  assert.strictEqual((ra.match(/\n    forget\(/g) || []).length >= 3, true,
    'every endpoint that revokes drops the positive cache');
  // Refused at the KEYPAD, or the till loops sign-in → refusal → sign-in.
  assert.match(ra, /if \(d\.rows\[0\] && d\.rows\[0\]\.revoked\) return \{ refused: true, device: true \}/,
    'a deregistered device cannot sign in at all');
  assert.match(ra, /r\.post\('\/pin\/change'/, 'your own PIN is changeable');
  assert.match(ra, /r\.post\('\/devices\/claim'/, 'and an enrolment is claimable');
});

test('the devices screen shows the outlet roll, not seven invented terminals', () => {
  assert.ok(!/DEVICE_REGISTRY/.test(SRC), 'the hardcoded registry is gone');
  ['dev_CHA_T2', 'dev_CHA_KDS', 'KAS-MAA', 'KAS-HUL', 'dev_CHA_T1'].forEach((lie) => {
    assert.ok(SRC.indexOf(lie) < 0, 'an invented device is still on screen: ' + lie);
  });
  assert.match(SRC, /devices\(\) \{\s*\n\s*const rows = \(K\(\) \|\| \{\}\)\.DEVICES/,
    'the roll comes from the bootstrap');

  // The two device writes reach the outlet, through one seam, with no offline path.
  assert.match(SRC, /async deviceAct\(d, call, said\)/, 'one seam');
  assert.match(SRC, /"signOutDevice"/, 'signing a device out is a call');
  assert.match(SRC, /"deregisterDevice"/, 'so is deregistering it');
  ['device_lock', 'device_deregister', 'device_paired', 'device_replay', 'pin_reset',
    'password_reset'].forEach((k) => {
    assert.ok(!new RegExp('queue\\(\\s*"' + k + '"').test(SRC),
      k + ' is audit-only — no screen may queue it while reporting the thing was done');
    assert.ok(AUDIT_ONLY.indexOf(k) >= 0, k + ' keeps its handler for an outbox that holds one');
  });

  /* The pairing code is the OUTLET's. This browser used to mint one with
     Math.random and then ask the operator to confirm it matched the code on a
     screen that had no way of knowing it. */
  assert.ok(!/Math\.random\(\) \* A\.length/.test(SRC), 'no code is minted in this browser');
  assert.match(SRC, /B\.registerDevice\(\{/, 'enrolling asks the outlet');
  assert.match(SRC, /B\.claimDevice\(code\)/, 'and the new screen claims it');
  assert.match(SRC, /B\.changePin\(/, 'a PIN change is a call, not an outbox op');

  // Version drift is measured against what a device reported, where it has.
  assert.match(SRC, /!d\.self && d\.ver && d\.ver !== this\.appVer\(\)/,
    'a device that has not said is not "behind"');
  const boot = fs.readFileSync(path.join(__dirname, '..', 'src', 'bootstrap.js'), 'utf8');
  assert.match(boot, /ver: r\.app_version \|\| null/, 'and the bootstrap publishes what it said');
  const sync = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sync.js'), 'utf8');
  assert.match(sync, /x-app-version/, 'reported on the push, where the device already names itself');
});

/* READINESS IS NOT "DID A DATABASE ANSWER".

   /readyz asked the OWNER connection whether chain.outlet had a row. The owner
   connection bypasses both isolation belts, so it could never detect the one
   failure that actually takes an install off the air — and did not, in the
   restore drill: a pg_dump of one database carries no roles, so a restore into
   a fresh cluster left every `outlet_<n>_app` missing, the app booted, this
   endpoint answered 200, and every outlet request failed. The behavioural
   proof is in test/api.test.js; this pins the shape, because the trap here is
   a one-word edit back to owner(). */
test('readiness crosses the belts a real request crosses', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // To the end of the handler, not a fixed number of characters — a window
  // measured in bytes silently stops covering the thing it was written for the
  // first time the block grows.
  const block = srv.slice(srv.indexOf('async function everyOutlet()'),
    srv.indexOf('/* Which store this request is addressed to'));
  assert.ok(block.length > 400, 'found the readiness block');

  assert.match(block, /withOutletRead\(\{ outletId: o\.id/,
    'each outlet is checked out with its OWN login role');
  assert.match(block, /SELECT 1 FROM item LIMIT 1/,
    'and reads a table in that outlet\'s own schema, which is where the grants are');

  /* AND THE HALF A POOL CANNOT TEST. A pool authenticates once and then serves
     for as long as it holds the connection, so a revoked CONNECT, a dropped
     role or a rotated OUTLET_ROLE_SECRET stayed invisible: measured on a live
     outlet, this endpoint answered 200 for three minutes while a fresh
     connection was refused the whole time. It was proving the GRANTS and
     calling that the credential. */
  assert.match(block, /await canConnect\(o\.id, o\.db\)/,
    'readiness opens a connection of its own, outside the pool');
  assert.match(block, /q\.rows\.forEach\(\(r\) => out\.push\(Object\.assign\(\{ db: b\.db_name \}/,
    'and knows which database each outlet is in, so it connects to the right one');
  assert.ok(!/owner\(\)[\s\S]{0,80}unreachable/.test(block),
    'the owner connection cannot stand in for an outlet role here');

  // An install with no outlets is a FRESH install on its way to onboarding.
  // A probe that never goes green there is an install that can never be set up.
  assert.match(block, /outlets: readyAnswer\.outlets/,
    'the count is reported rather than asserted');
  assert.ok(!/if \(!outlets\.rowCount\) return res\.status\(503\)/.test(srv),
    'zero outlets is not a failure');

  // A 503 nobody can act on is the old 200 with a different number.
  assert.match(block, /unreachable: bad/, 'the failing outlet is named');
  assert.match(block, /provision:outlet -- --all/, 'with the command that fixes it');

  // Fail slow, recover fast.
  assert.match(block, /readyChecked = \(now\.unreachable\.length \|\| now\.businesses\.length\)/,
    'only a good answer is cached, so recovery needs no restart and no wait');

  /* TWO FAULTS, TWO REMEDIES. A business whose DATABASE will not open was
     reported as an outlet whose LOGIN ROLE will not serve, under the remedy for
     the latter — which recreates roles and cannot do a thing about a missing
     database. Found by auditing a real store against a registry holding four
     businesses whose databases had been dropped. */
  assert.match(block, /businesses\.push\(\{ db: o\.code, error: o\.dead \}\)/,
    'a database that would not open is counted apart from an outlet that would not serve');
  assert.match(block, /outlets: rows\.length - businesses\.length/,
    'and is not counted as an outlet, which is how "4 of 5 outlets" named none');
  assert.match(block, /Recreating login roles does nothing for this one/,
    'the database half carries its own remedy, and says the other one will not help');
});

/* A TOKEN SAYS WHAT PLANE IT IS FOR.

   Two findings from the security pass, one root cause: a signed blob with no
   type is whichever credential the reader's field lookups happen to make it.

     · `PORTAL_SECRET || SESSION_SECRET` meant an install that had not set the
       portal secret signed a stranger's table token with the manager's key.
       Proved on a live install: the token from GET /api/g/<slug>/token — which
       needs no credential at all, it is what a QR scan does — verified as a
       STAFF session and returned a 2.6 MB bootstrap carrying every recipe,
       cost, sale, staff record and the install uuid;
     · a MEMBER token satisfied the table check, because a table token is
       recognised by having been signed rather than by saying what it is. A
       member holds theirs for thirty days. Proved: it placed a guest order
       onto table 7 while the table-1 token it was minted from correctly could
       not.

   Both are closed twice over: `typ` is checked on every verify, and the portal
   secret is DERIVED rather than borrowed when it is not configured, so the two
   keys are different by construction. */
test('a token carries its plane, and the guest plane has its own key', () => {
  const sec = fs.readFileSync(path.join(__dirname, '..', 'src', 'secrets.js'), 'utf8');

  assert.match(sec, /if \(claims\.typ !== typ\) return null;/,
    'the plane is checked, not inferred from which fields happen to be present');
  /* FIVE planes now: a DOCUMENT link — an account statement handed to a
     customer — is signed and expiring, and it must not be tradeable for a
     member token, a table token or anything else. */
  assert.match(sec, /const TYPE = \{ staff: 's', account: 'a', table: 't', member: 'm', doc: 'd' \}/,
    'five planes, five letters');
  ['sign = ', 'verify = '].forEach(() => {});
  assert.match(sec, /signWith\(need\('SESSION_SECRET'\), TYPE\.staff/, 'staff tokens are stamped');
  assert.match(sec, /signWith\(portalSecret\(\), TYPE\.table/, 'table tokens are stamped');
  assert.match(sec, /signWith\(portalSecret\(\), TYPE\.member/, 'member tokens are stamped');
  assert.match(sec, /signWith\(need\('SESSION_SECRET'\), TYPE\.account/, 'account tokens are stamped');

  // Derived, never borrowed.
  assert.ok(!/PORTAL_SECRET \|\| need\('SESSION_SECRET'\)/.test(sec),
    'the guest plane must never fall back to the session secret');
  assert.match(sec, /createHmac\('sha256', need\('SESSION_SECRET'\)\)[\s\S]{0,60}kashikeyo:portal:v1/,
    'it is derived from it instead, so the two can never be equal');
});

/* THE PRINT RELAY IS AN SSRF PRIMITIVE, SO ITS FENCE HAS TO HOLD.

   It blocked 127.x, ::1 and 169.254.x and let 0.0.0.0 through — and on Linux a
   connect to 0.0.0.0 goes to loopback. Proved: host "0.0.0.0" delivered bytes
   to a listener on 127.0.0.1:9100 and the endpoint answered {"sent":true}. */
test('the anonymous table-token mint has a doorman', () => {
  // (the relay fence has its own test below, now that it is an allow-list)
  const guest0 = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'guest.js'), 'utf8');
  assert.ok(guest0.length > 100, 'read the guest router');
  // The one anonymous door that reaches the database had no doorman.
  const guest = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'guest.js'), 'utf8');
  assert.match(guest, /r\.get\('\/token', gate\('table-mint'/, 'the host-routed mint is gated');
  assert.match(guest, /r\.get\('\/:slug\/token', gate\('table-mint'/, 'and the path form too');
});

/* THE MATRIX SHOWS THE LADDER; IT DOES NOT SET IT.

   The last of the "a control does what it says" class, and the one that was
   most confidently wrong. Every cell cycled on tap, wrote `state.permOverride`
   — one browser's local object — and queued `permission_change`, which is
   AUDIT_ONLY. Nothing per-ROLE is stored anywhere: `chain.staff.perm_override`
   is per PERSON and nothing writes it either. A manager who took Purchasing
   away from Cashiers changed one tab until it reloaded.

   The note beside it claimed each cell "corresponds to a policy predicate on
   the underlying table" and that changing one "rewrites the role's grant".
   Neither has ever been true. The policies read the RANK, `atLeast()` reads the
   rank, and there is exactly one gate. */
test('the permission matrix reads the ladder rather than pretending to set it', () => {
  ['permission_change', 'permission_reset'].forEach((k) => {
    assert.ok(!new RegExp('queue\\(\\s*"' + k + '"').test(SRC),
      k + ' is audit-only — nothing may queue it while reporting a change');
    assert.ok(AUDIT_ONLY.indexOf(k) >= 0, k + ' keeps its handler for an outbox that holds one');
  });

  /* The local override layer is gone with the switches that wrote it: every
     screen that read it rendered a different answer from the server's. */
  assert.ok(!/this\.state\.permOverride/.test(SRC), 'no screen reads a local override');
  assert.ok(!/permOverride: this\._saved/.test(SRC), 'and none is persisted');
  assert.match(SRC, /roleFor\(key\) \{[\s\S]{0,180}return base \|\| \{ perms: \{\}, label: "" \};/,
    'what a role reaches is what shipped');

  // The claim that was false.
  assert.ok(SRC.indexOf('corresponds to a policy predicate') < 0,
    'the cells were never policy predicates');
  assert.ok(SRC.indexOf("rewrites the role's grant") < 0, 'and tapping one rewrote nothing');
  assert.match(SRC, /"The rank is the gate"/, 'the note names the one gate there is');
});

/* A CREDENTIAL NEVER RIDES IN A QUERY STRING — this build's own rule, written
   when an unused `?at=` fallback came off the account guard. The guest guard
   still read `req.query.t`, and on the QR portal `?t=` is the TABLE NUMBER, so
   one parameter meant two things. Every client has always sent the header. */
test('the guest guard takes its token from the header only', () => {
  const g = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'guest.js'), 'utf8');
  assert.match(g, /const t = req\.get\('x-table-token'\) \|\| '';/,
    'the header, and only the header');
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'app', 'guest-bridge.js'), 'utf8');
  assert.match(bridge, /headers\["x-table-token"\] = state\.token/,
    'which is what the client has always sent');

  /* And a wildcard origin is refused in production: the apps are same-origin,
     so `*` buys nothing and hands every website the answers to this install's
     anonymous endpoints. Not a boot failure — a CORS setting is not a
     half-migrated schema, and taking a restaurant off the air over one is
     worse than the setting. */
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(srv, /raw\.indexOf\('\*'\) >= 0/, 'production notices the wildcard');
  assert.match(srv, /return raw\.filter\(\(o\) => o !== '\*'\)/, 'and drops it');
  assert.match(srv, /\[cors\] ALLOWED_ORIGINS contains "\*" — refused in production/,
    'saying so by name');
});

/* AND THE COPY AROUND THEM. Fixing a control leaves the sentences beside it,
   and on Users & Roles those sentences were the confident kind: the header
   read "Role matrix enforced by Postgres RLS" (the RANK is what Postgres
   enforces — a different sentence and the true one), the guide walked through
   an email invite and a link that "activates the account on a device" for a
   flow that has never existed, and the rank ladder listed taking and restoring
   backups as things an Admin and an Owner can do here. */
test('the copy on Users & Roles describes this build', () => {
  assert.ok(SRC.indexOf('Role matrix enforced by Postgres RLS') < 0,
    'the matrix is a picture of the ladder; the ladder is what is enforced');
  assert.ok(SRC.indexOf('status Invited') < 0, 'no row waits on a link');
  assert.ok(SRC.indexOf('activates only when the link is used') < 0,
    'and no link activates anything');
  assert.match(SRC, /Give them a name, a role and a four-digit PIN/,
    'which is what creating an account actually needs');

  /* Backups are not a rank's power here. The app takes them now, but against
     the database and with the install's own credentials - no rank on a till
     grants that, so no rank may be described as carrying it. */
  const ranks = SRC.slice(SRC.indexOf('  RANKS() {'), SRC.indexOf('  RANKS() {') + 900);
  assert.ok(ranks.indexOf('backups') < 0 && ranks.indexOf('Restore a backup') < 0,
    'no rank on a till restores a backup: it is done where the database lives');

  assert.match(SRC, /lands on the audit trail as a permission_change/,
    'and the trail is named for the table it is actually written to');
});

/* THE THREE THAT WERE "ACCEPTED WITH REASONS" — closed, because a reason is
   not the same as an impossibility. */
test('a PIN hash never leaves the database', () => {
  const mig = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations',
    '038_a_pin_hash_never_leaves_the_database.sql'), 'utf8');

  // Salts out (a salt is not a secret), hashes back, comparison in there.
  assert.match(mig, /FUNCTION chain\.pin_salts\(p_outlet int\)/, 'the salts are handed out');
  assert.ok(!/pin_hash/.test(mig.slice(mig.indexOf('chain.pin_salts'),
    mig.indexOf('chain.pin_match'))), 'and no hash travels with them');
  assert.match(mig, /FUNCTION chain\.pin_match\(/, 'the comparison happens in the database');
  assert.match(mig, /s\.pin_hash = t\.h/, 'against the hashes the caller offered');
  assert.match(mig, /s\.locked_until IS NULL OR s\.locked_until <= now\(\)/,
    'and a locked account never matches, so the caller cannot ignore the lockout');
  assert.match(mig, /DROP FUNCTION IF EXISTS chain\.pin_candidates\(int\)/,
    'the function that returned hashes is dropped, not left for the next shortcut');

  /* And the COLUMN, or the function was theatre: every outlet role holds
     SELECT on chain.staff and the policy returns the whole row, so the hashes
     were one plain SELECT away. Verified by connecting as the role. */
  assert.match(mig, /REVOKE SELECT ON chain\.staff FROM %I/, 'the blanket grant comes off');
  assert.match(mig, /column_name NOT IN \('pin_hash', 'pin_salt'\)/,
    'and goes back column by column, without the two');
  const prov = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations',
    '003_outlet_provision.sql'), 'utf8');
  assert.match(prov, /GRANT SELECT \(%s\) ON chain\.staff TO %I/,
    'a newly provisioned outlet gets the column grant too, not the old one');

  const auth = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
  assert.ok(!/pin_candidates/.test(auth), 'sign-in no longer asks for candidates');
  assert.match(auth, /chain\.pin_match\(\$1,\$2,\$3\)/, 'it asks which row matches');
  assert.ok(!/pinMatches/.test(auth), 'and compares nothing itself');
});

test('the print relay dials the shop LAN and nothing else', () => {
  const out = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'outlet.js'), 'utf8');
  const fence = out.slice(out.indexOf('AN ALLOW-LIST, NOT A DENY-LIST'),
    out.indexOf('port: 9100') + 40);
  assert.ok(fence.length > 400, 'found the fence');

  /* It blocked the addresses somebody had thought of and let everything else
     through — including 0.0.0.0, which on Linux reaches loopback, and every
     public address on the internet. The question is turned round. */
  assert.match(fence, /o\[0\] === 10/, '10/8 is a printer network');
  assert.match(fence, /o\[0\] === 172 && o\[1\] >= 16 && o\[1\] <= 31/, 'so is 172.16/12');
  assert.match(fence, /o\[0\] === 192 && o\[1\] === 168/, 'and 192.168/16');
  assert.match(fence, /if \(!privateV4 && !privateV6 && !allowLoop\)/,
    'everything outside a private range is refused without anyone naming it');
  assert.match(fence, /replace\(\/\^::ffff:\/i, ''\)/,
    'an IPv4-mapped v6 address is unwrapped before it is judged');
  assert.match(fence, /net\.connect\(\{ host: flat/, 'and the address dialled is the one judged');
});

test("'unsafe-eval' is a property of three pages, not of the product", () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(srv, /const EVAL_FREE = \/\^\\\/\(account\|onboarding\|r\|st\)/,
    'the two front doors and the two document pages are named');
  assert.match(srv, /EVAL_FREE\.test\(req\.path\) \? csp\(\)\.strict : csp\(\)\.eval/,
    'and served the strict header');

  /* They are vanilla DOM — the template runtime is what needs new Function,
     and they do not load it. They are also the pages a stranger reaches first:
     the sign-up form and the panel that claims an install. */
  ['account', 'onboarding'].forEach((f) => {
    const page = fs.readFileSync(path.join(__dirname, '..', 'app', f + '.html'), 'utf8');
    assert.ok(page.indexOf('support.js') < 0, f + '.html does not load the runtime');
  });
  ['index', 'guest', 'member'].forEach((f) => {
    const page = fs.readFileSync(path.join(__dirname, '..', 'app', f + '.html'), 'utf8');
    assert.ok(page.indexOf('support.js') >= 0, f + '.html does, so it keeps the directive');
  });
});

/* THE COPY SWEEP.

   The eleven controls that lied were found by accident — by opening a screen
   and reading it. This is the systematic pass: every user-visible string of 25
   characters or more was extracted, the 259 that assert something checkable
   were classified, and each was verified against the database or the server.

   The largest seam was a stratum of architecture copy written against the
   PREVIOUS app, which was deleted in full. It named `kpos.*` tables, a
   `chain_id` claim, an `outlet_ids[]` array in the token, a
   `menu_for_terminal` security_invoker view and a PgBouncer that is not
   deployed. Asked of a live database: the `kpos` schema does not exist, no
   column anywhere is called `chain_id`, no view matches `menu_for%`, and no
   policy mentions `from_outlet`. The code samples beside that prose were
   already correct, which is the worst arrangement — a reader trusts the
   sentence over the SQL. */
test('no screen describes the app that was deleted', () => {
  const APPS = ['index.html', 'guest.html', 'member.html', 'account.html', 'onboarding.html'];
  const DATA = ['kashikeyo-data.js', 'kashikeyo-rules.js', 'kashikeyo-invite.js'];
  const GONE = [
    ['kpos.', 'the previous app\'s schema — this build is chain.* and outlet_N.*'],
    ['chain_id', 'no column anywhere is called that; an install holds one company'],
    ['outlet_ids', 'a token names ONE outlet, and the path must match it'],
    ['menu_for_terminal', 'there is no such view — cost is hidden by the screen, not the wire'],
    ['security_invoker', 'no view in this build uses it'],
    ['PgBouncer', 'not deployed; the pool is pg\'s own, in one process'],
    ['SQLite', 'the terminal\'s local store is IndexedDB']
  ];
  APPS.concat(DATA).forEach((f) => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app', f), 'utf8');
    // Comments may name the old vocabulary — that is how a fix explains itself.
    const shipped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
    GONE.forEach(([word, why]) => {
      assert.ok(shipped.indexOf(word) < 0,
        f + ' still says "' + word + '" on a screen — ' + why);
    });
  });
});

/* AND THE CLAIMS THAT WERE CHECKABLE ONE BY ONE. Each of these was asked of a
   live database or the server source before it was rewritten. */
test('the claims a screen makes are the ones the server keeps', () => {
  // The credit limit: no CHECK on chain.member, no trigger. Verified by query.
  assert.ok(SRC.indexOf('The credit limit is enforced in the database') < 0,
    'there is no constraint and no trigger — the till blocks it and a replay is flagged');

  // Journals: composed by applySale() in Node. The only trigger in an outlet
  // schema is journal_balances, a deferred check on the total.
  assert.ok(SRC.indexOf('produced by a database trigger on a source event') < 0,
    'the server composes them from the sale; the trigger only refuses an unbalanced one');

  // The architecture screen: four panes, four labels. It had five labels and
  // branches on 1..5 plus a default — six panes, two unreachable by clicking.
  const arch = SRC.slice(SRC.indexOf('  g_architecture()'), SRC.indexOf('  g_architecture()') + 9000);
  const labels = (arch.match(/const tabs = \[([^\]]*)\]/) || [])[1] || '';
  const panes = (arch.match(/if \(tab === \d\)/g) || []).length + 1;   // +1 default
  assert.strictEqual(labels.split(',').length, panes,
    'every tab has a pane and every pane has a tab');
  assert.ok(arch.indexOf('0007_rls.sql') < 0, 'the migration is 002, and it is named correctly');

  // Unused data that carried a false claim is deleted, not left for a reader.
  const data = fs.readFileSync(path.join(__dirname, '..', 'app', 'kashikeyo-data.js'), 'utf8');
  assert.ok(!/var RAILWAY(_NOTES)? = \[/.test(data),
    'RAILWAY_NOTES said no request handler imports the owner connection — six do');

  /* A role's SCOPE is one of the two values src/auth.js knows. It carried
     "platform" and "chain" — a platform above the install and a chain of them,
     neither of which exists — and scopedOutlets() reads this field, so
     "anything but outlet" silently handed three roles every outlet in the
     switcher when a session names exactly one. */
  const scopes = [...data.matchAll(/scope: "([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(scopes.length >= 7, 'every role declares a scope');
  scopes.forEach((sc) => assert.ok(sc === 'outlet' || sc === 'group',
    'scope "' + sc + '" is not a scope src/auth.js honours'));
  assert.strictEqual(scopes.filter((x) => x === 'group').length, 1,
    'group scope is the rank-5 estate read, and only the owner holds it');

  /* AND THE SWITCHER ITSELF. A session names one outlet: the token carries it,
     every path repeats it, and the server refuses any other. Changing
     state.outletId painted the other outlet's name over this outlet's data. */
  assert.match(SRC, /sign out and sign in at/,
    'switching outlet says what it actually takes');
});

/* A DRAIN IS BOUNDED WORK, NOT ONE LONG TRANSACTION.

   The only error in the whole load campaign, and the only measured performance
   defect in the build. A push applied the entire batch inside ONE transaction,
   so a till back from a dark evening asked the server to hold a pooled
   connection for as long as the batch took: at 80 ops with eight outboxes
   draining together, up to 16.9 s — past the 8 s checkout bound the other
   seven were waiting on, and past the 15 s statement timeout, which is what
   cancelled it. Measured on one box before and after: p99 17,615 ms with one
   request in 132 cancelled, against p99 7,798 ms and zero errors, twice, with
   live serving unchanged at 30 terminals.

   Two halves. The server sorts the whole batch ONCE and then applies it in
   bounded chunks, each its own transaction, so the connection goes back to the
   pool between them — that closes the ceiling for any client, including a
   terminal in the field still slicing 100. The client asks for less per
   request and paces a working drain by whether the last push delivered
   anything, because five seconds is the right politeness after a refusal and a
   pure tax on a drain that is succeeding.

   The cap stays 200: lowering it would 413 every deployed terminal, and an op
   that cannot be delivered is not safer than one applied in two transactions. */
test('a push is applied in bounded chunks, and a drain paces itself', () => {
  const sync = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sync.js'), 'utf8');

  // The server splits, and each piece is its own transaction.
  assert.match(sync, /const CHUNK = \d+;/, 'the chunk size is named');
  const size = Number((/const CHUNK = (\d+);/.exec(sync) || [])[1]);
  assert.ok(size > 0 && size <= 50, 'and bounded — ' + size + ' ops is one transaction');
  assert.match(sync, /for \(let ci = 0; ci < chunks\.length; ci\+\+\) \{\s*\n\s*const part = await withOutlet\(/,
    'one withOutlet per chunk, so the connection is returned between them');

  /* The sort happens BEFORE the split, over the whole batch — otherwise chunk
     two could carry an op that belongs in front of chunk one, and a line is
     added to a ticket that does not exist yet. */
  assert.ok(sync.indexOf('const ordered = ops.map') < sync.indexOf('const chunks = []'),
    'the whole batch is ordered before it is split');
  assert.ok(sync.indexOf('const chunks = []') < sync.indexOf('for (let ci = 0'),
    'and split before it is applied');

  // The seen-set spans the push. A duplicate opId across two chunks is still a
  // duplicate; declaring it inside the loop would let one through.
  assert.ok(sync.indexOf('const inThisBatch = new Set()') < sync.indexOf('for (let ci = 0'),
    'the duplicate check spans the delivery, not one piece of it');

  // An empty push still proves the device reached its outlet.
  assert.match(sync, /if \(!chunks\.length\) chunks\.push\(\[\]\);/,
    'an empty delivery still gets a transaction, so the device is still stamped');
  assert.match(sync, /ci === chunks\.length - 1/, 'and it is stamped when the work is done');

  // The cap is unchanged: a deployed terminal must not start getting 413s.
  assert.match(sync, /ops\.length > 200/, 'the outer bound still admits what the field sends');

  const api = fs.readFileSync(path.join(__dirname, '..', 'app', 'kashikeyo-api.js'), 'utf8');
  assert.match(api, /KashikeyoAPI\.PUSH_CHUNK = \d+;/, 'the client asks for a bounded piece');
  assert.match(api, /ops\.slice\(0, KashikeyoAPI\.PUSH_CHUNK\)/, 'and slices by it');
  assert.ok(Number((/PUSH_CHUNK = (\d+);/.exec(api) || [])[1]) <= 200,
    'within what the server will accept');

  /* Paced by delivery, not by the clock. Without that distinction a poison op
     spins at the fast interval — the hot outbox the parking lane exists to
     stop — so the fast gap must be conditional on something having left. */
  assert.match(api, /delivered > 0 \? KashikeyoAPI\.DRAIN_MS : 5000/,
    'a working drain keeps going; a refusal backs off');
  assert.match(api, /delivered\+\+;/, 'and "delivered" counts ops the outlet accepted');
});

/* THE RESOLVER THAT THREW THE WRITE AWAY AND SAID IT HAD WON.

   The worst thing the copy sweep turned up, and it was a control, not a
   sentence. Nothing in this build detects a write-write conflict: the server
   applies a batch in the operator's own order and answers a refusal with a
   REASON. state.conflicts was fed from those refusals, and a "Replay conflict"
   screen then told the operator a story about them — that another terminal had
   written the same order line first, "quantity 3, fired at 19:31", "Accepted by
   the server, Lamport 6", beside their own write at "Lamport 4". Every one of
   those was a literal: identical on every install, every refusal, every op.

   Then "Keep mine" marked the outbox row `sent`, re-pushed NOTHING, and toasted
   "local write replayed over the server copy". A refused sale, payment or
   credit charge was deleted by the control that reported it had won.

   The lane that works was already here for the eighth refusal. It runs from the
   first one now. */
test('a refused write goes to the one lane that can decide it', () => {
  // A fix explains itself in a comment, and a comment ships nothing — so the
  // absence half of this is asked of the code alone.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
  assert.ok(code.indexOf('Lamport 6') < 0, 'no invented counterpart write');
  assert.ok(code.indexOf('Captured offline, Lamport 4') < 0, 'and no invented lamport for our own');
  assert.ok(!/resolveConflict/.test(code), 'the resolver that dropped the op is gone');
  assert.ok(!/mConflict|conflictTheirs|conflictFoot/.test(code),
    'and so is the screen it drew');
  assert.ok(!/state\.conflicts|conflicts: s\.conflicts/.test(code),
    'a refusal is a row in the outbox, not a second list beside it');

  // What a refusal reaches instead: the outlet's own reason and two decisions
  // that are both real — one re-pushes, one deletes with an audit op.
  assert.match(SRC, /refusedOps\(\) \{/, 'one derivation of what was refused');
  assert.match(SRC, /state === "refused" \|\| x\.state === "conflict"/,
    'and a persisted outbox from before the rename still shows its refusals');
  assert.match(SRC, /parkedActions\(refusedOps\[0\]\)/, 'the Sync action opens that lane');
  assert.match(SRC, /this\.parkedActions\(x\) : null/, 'so does the row itself');
  assert.ok(HANDLERS.op_discarded === undefined || AUDIT_ONLY.indexOf('op_discarded') >= 0,
    'discarding still replays as the audit op naming what was given up');
});

/* THE BUTTON THAT ENDS EVERY SALE PRINTED NOTHING.

   The settled modal offered "Email receipt" and "Print & close", and BOTH were
   bound to `closeModal`. `settledDone` — which holds the only receipt print in
   the build — was bound nowhere in the template, and the same binding carried
   the credit note and the Z-report with it. So a cashier pressing Print got a
   closed dialog and no paper, on every sale, on every till. Nothing in the
   client or the server has ever been able to email a receipt. */
test('the settle modal prints what its button says it prints', () => {
  assert.match(SRC, /<button onClick="\{\{ settledDone \}\}"/,
    'the primary action is bound to the callback that prints');
  assert.match(SRC, /\{\{ settledDoneLabel \}\}/, 'and it is named by the branch that set it');
  assert.ok(SRC.indexOf('Email receipt') < 0,
    'nothing here or on the server can email a receipt');
  assert.match(SRC, /Close without printing/, 'the alternative says what it does');

  // Every branch that sets the callback also names the button.
  const done = (SRC.match(/settledDone: \(\) =>/g) || []).length;
  const label = (SRC.match(/settledDoneLabel:/g) || []).length;
  assert.strictEqual(done, label, 'no branch renders a nameless button');

  /* And "Print the receipt automatically" was a switch nothing read. It is
     honoured at settle, which is where "automatically" means something. */
  assert.match(SRC, /if \(this\.prefs\(\)\.autoPrint\) \{/, 'the pref is read on the settle path');
  assert.match(SRC, /settledDoneLabel: this\.prefs\(\)\.autoPrint \? "Close"/,
    'and the button stops offering a print that has already happened');
});

/* ═══ A DOCUMENT LINK CARRIES ITS STORE, OR IT RESOLVES TO NOTHING ══════════
   `docUrl()` spells a shared receipt two ways: the store's own subdomain,
   where `Host` names the store, and — for a deploy with no base domain —
   `PUBLIC_URL/r/<token>?s=<handle>`, which is the only thing that can name it
   there. The page read the token off the path and asked for the document with
   no store attached, so every link of the second kind landed on "that receipt
   could not be found". Found by opening one; invisible from the code, because
   both halves are individually correct.

   ONE NAMED PARAMETER. A click-wrapper appends its own to any link that goes
   through an inbox, and forwarding the whole query string is how a foreign
   value reaches a lookup — the `?t=` defect the invitation landing already
   paid for once. */
test('a shared document carries the store its link named', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'doc.html'), 'utf8');

  assert.match(page, /URLSearchParams\(location\.search\)\.get\("s"\)/,
    'the page reads the handle its own link carried');
  assert.match(page, /\?s=" \+ encodeURIComponent\(store\)/,
    'and passes it to the document read, or the path form resolves to nothing');
  assert.match(page, /\[a-z0-9-\]\{3,40\}/,
    'held to the shape of a handle, so nothing else can ride in on it');
  assert.ok(page.indexOf('location.search)') > 0
    && !/fetch\([^)]*location\.search(?!\))/.test(page),
    'never the whole query string — a click-wrapper appends its own');

  /* AND THE SERVER READS THE SAME TWO SOURCES, in that order: the host first,
     because that is what a real store link looks like. */
  const doc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'doc.js'), 'utf8');
  assert.match(doc, /req\.storeHandle \|\| req\.query\.s/,
    'the host names the store, and the path form falls back to `?s=`');
});

/* ═══ OLD IS NOT WRONG ══════════════════════════════════════════════════════
   `verifyWith()` refuses an expired token exactly like a forged one. That is
   right for every credential plane in this build and wrong for a document
   link: the only useful thing the person holding an aged statement can do is
   ask for a new one, and "could not be found" sends them to check their own
   copying instead. `doc.html` already carried "This link has expired" and the
   410 that would reach it was unreachable code. */
test('a statement link that aged out says so, and a forged one does not', () => {
  const sec = fs.readFileSync(path.join(__dirname, '..', 'src', 'secrets.js'), 'utf8');

  assert.match(sec, /function sealed\(/,
    'the MAC and the plane are askable without the clock');
  assert.match(sec, /function docExpired\(/,
    'and exactly one caller may ask: a document link');
  /* THE SPLIT MUST NOT WIDEN. `sealed()` is not exported — a "verify but
     ignore expiry" primitive on the module surface is one the next reader
     reaches for on a session. */
  assert.ok(!/\bsealed\b/.test(sec.slice(sec.lastIndexOf('module.exports'))),
    'sealed() is never exported');
  assert.match(sec.slice(sec.lastIndexOf('module.exports')), /docExpired/,
    'docExpired is');
  assert.match(sec, /function verifyWith[\s\S]{0,240}sealed\(secret, typ, token\)/,
    'and every other plane still goes through the clock');

  const doc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'doc.js'), 'utf8');
  assert.match(doc, /docExpired\(tok\)[\s\S]{0,220}410/,
    'an aged statement answers 410 rather than 404');
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'doc.html'), 'utf8');
  assert.match(page, /410[\s\S]{0,80}expired/i,
    'and the page has the sentence that 410 is for');
});

/* ═══ A SALE THE TILL CAN NAME ══════════════════════════════════════════════
   The outlet allocates a sale's id AND its receipt number — a document number
   is a statutory sequence and cannot be minted on a device that has been dark
   all evening. Correct, and it left the till holding a settled bill it could
   not point at: the Send control matched the outlet's row by receipt NUMBER,
   the till mints `INV-<code>-<year>-0001` off its own persisted counter, and
   the two allocators never produce the same string. So the control read "once
   this bill reaches the outlet" for ever, on every real sale — measured in a
   browser with the bill already at the outlet in under two seconds.

   Same answer as `ticket_line.client_id` one row up: the device names the row,
   the outlet keeps the name, the bootstrap publishes it back. */
test('a settled bill carries the name the till gave it', () => {
  // MINTED, not counted: two tills settling at once must not collide.
  assert.match(SRC, /const cid = this\.newId\("R"\)/,
    'the till mints a name for the bill');
  assert.match(SRC, /const snapshot = \{\s*\n\s*cid: cid,/,
    'the receipt snapshot carries it');
  assert.match(SRC, /const settledRow = \{\s*\n\s*cid: cid,/,
    'and so does the row that goes into state.settled');
  assert.match(SRC, /cid: row\.cid \|\| null,/, 'the sale op sends it');
  assert.match(SRC, /\(s\.settled \|\| \[\]\)\.find\(\(x\) => x && x\.cid && p\.cid && x\.cid === p\.cid\)/,
    'and the settled receipt finds its own row by it');
  assert.ok(!/x\.no && p\.no && x\.no === p\.no/.test(SRC),
    'never by receipt number again — two allocators, never equal');

  const APPLY = fs.readFileSync(path.join(__dirname, '..', 'src', 'apply.js'), 'utf8');
  assert.match(APPLY, /INSERT INTO sale \(client_id, receipt_no/, 'the outlet keeps it');
  assert.match(APPLY, /String\(p\.cid \|\| ''\)\.slice\(0, 64\) \|\| null/,
    'bounded, and NULL where an older build sent none');

  const BOOT = fs.readFileSync(path.join(__dirname, '..', 'src', 'bootstrap.js'), 'utf8');
  assert.match(BOOT, /cid: s\.client_id \|\| null,/, 'and publishes it back');
});

/* ═══ A SHEET THAT SHOWS WHAT ITS CALLER COMPOSED ═══════════════════════════
   `kind: "actions"` is the TABLE sheet: that branch builds its own title,
   subtitle and list from the active table and ignores the modal state. The
   share sheet reused it, so "Send the receipt" opened "Table actions · Tnull ·
   free · Parked bills · Table QR · Mark reserved". Found by tapping it. */
test('the share sheet has a kind of its own, and comes back to the receipt', () => {
  assert.match(SRC, /if \(m\.kind === "share"\) \{/, 'its own branch');
  assert.match(SRC, /modalTitle: m\.title \|\| "Send it", modalSub: m\.sub \|\| ""/,
    'which renders what the caller composed');
  assert.match(SRC, /modal: \{ kind: "share",/, 'and shareDoc opens that one');
  assert.match(SRC, /m\.kind === "actions" \|\| m\.kind === "share"/,
    'drawn as an action sheet');

  /* AND IT PUTS THE RECEIPT BACK. `state.modal` is one slot, so the sheet
     REPLACES the settled receipt — Print button and all — and sharing used to
     drop the cashier back on the floor one tap after taking the money. */
  assert.match(SRC, /this\._docBack = \(this\.state\.modal && \(this\.state\.modal\.kind === "settled"/,
    'the receipt is stashed');
  assert.match(SRC, /const back = this\._docBack \|\| null;/, 'and restored after the send');
  assert.ok(!/if \(via === "copy"\) return this\.copyLink\(r\.link\);/.test(SRC),
    'on every branch, the copy included');
});

/* ═══ COPYING IS NOT SENDING ════════════════════════════════════════════════
   "Copy the link" asked the outlet for an EMAIL share and threw the answer
   away, so copying a link for a customer with no address on file was refused
   409 and opened a form demanding one — for a message nobody was going to
   send. Giving a document an address and DELIVERING it are two acts. */
test('a link is a channel of its own, and needs no address', () => {
  assert.match(SRC, /const call = via === "copy" \? "link" : via;/,
    'the till asks for a link, not an email');
  const OUT = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'outlet.js'), 'utf8');
  assert.match(OUT, /SHARE_KINDS = \{ email: 1, whatsapp: 1, viber: 1, link: 1 \}/,
    'and the outlet knows it');
  assert.match(OUT, /if \(via === 'link'\) return \{ sent: false, reason: '' \};/,
    'nothing is sent, so nothing is claimed and nothing is a failure');
  assert.match(OUT, /\(via === 'email' \|\| via === 'link'\) \? '' : SHARE\.channelUrl/,
    'and there is no app to hand off to');
});

/* ═══ A WALK-IN HAS NO RECORD TO KEEP AN ADDRESS ON ═════════════════════════
   The address popup said "This customer has no email address on file yet" and
   promised "the address is saved on the customer" — over a takeaway bill rung
   on nobody. Nothing was saved and nothing could be. */
test('the address popup says which of the two situations it is in', () => {
  const spec = SRC.slice(SRC.indexOf('docEmail: (() => {'));
  assert.ok(spec.indexOf('docEmail: (() => {') === 0,
    'the spec is built per render, so it can read who the bill was rung on');
  assert.match(spec.slice(0, 2600), /sub: c \? c\.name \+ " has no email address on file yet"/,
    'a customer is named');
  assert.match(spec.slice(0, 2600), /: "This bill was not rung on a customer's record"/,
    'and a walk-in is not called one');
  assert.match(spec.slice(0, 2600), /save: c \? "Save and send" : "Send it"/,
    'the button says which it will do');
  assert.match(spec.slice(0, 2600), /There is no customer record to keep it on/,
    'and the foot promises no save it cannot make');
});

/* ═══ A SETUP FILE IS NOT A BACKUP ═════════════════════════════════════════
   "Let us pick what goes in the backup" is two requests wearing one sentence.
   A BACKUP must be complete or restoring from it is a fiction — tick "menu
   and customers", skip the sales, and the file cannot bring a store back. So
   the picker belongs to a SETUP file, which says what it is, and the screen
   that offers it says what it cannot do. */
test('the setup file says what it is, and the picker belongs to it', () => {
  const SETUP = fs.readFileSync(path.join(__dirname, '..', 'src', 'setup.js'), 'utf8');

  /* ONE DIRECTION OF TRUTH: the export emits the same ops the till queues and
     the import replays them through the same handlers, so an imported dish
     and a typed one arrive by one road. A bespoke importer would be a second
     way to write a dish. */
  assert.match(SETUP, /const \{ HANDLERS \} = require\('\.\/apply'\)/,
    'the import runs the till’s own handlers');
  assert.match(SETUP, /HANDLERS\[kind\]\(c, op\.payload \|\| \{\}, o\.ctx \|\| \{\}\)/,
    'and nothing else writes a row');

  /* THE FENCE. Without the allowlist this is "run any op you like": a
     hand-edited JSON posts a journal under an owner's own token. */
  const S = require('../src/setup');
  const kinds = Object.keys(S._IMPORTABLE);
  assert.ok(kinds.length, 'the allowlist is not empty');
  ['sale', 'post_journal', 'settle_credit', 'refund', 'void_sale', 'stock_adjust',
    'loyalty_update', 'close_ticket', 'payment_run', 'vendor_payment']
    .forEach((k) => assert.ok(kinds.indexOf(k) < 0,
      'a setup file must never be able to carry ' + k));
  kinds.forEach((k) => assert.ok(HANDLERS[k],
    k + ' is on the allowlist but has no handler'));

  // The install's own uuid (026) must not travel: copied into a second store,
  // the fence that stops one install's outbox replaying into another is gone.
  assert.ok(S._SETTING_NEVER.install, 'the install identity never travels');

  /* AND THE SCREEN SAYS WHAT THE FILE CANNOT DO, on the card and on the form,
     because somebody reaching for this after losing a database has to be told
     while they are still looking for the thing that would have helped. */
  assert.match(SRC, /title: "Store setup file"/, 'the card exists');
  assert.match(SRC, /It is not a backup and does not pretend to be/,
    'and refuses the word it is not');
  assert.match(SRC, /Never carries", "sales, payments, the ledger"/,
    'naming what is absent, not only what is present');
  assert.match(SRC, /this\.rank\(\) >= 5 \? "Download or restore setup" : ""/,
    'rank 5: the owner decides what the shop IS');

  /* THE PARTS COME FROM THE OUTLET, fetched BEFORE the form opens. `openForm`
     seeds every field at the moment it opens, so a form that gains its fields
     afterwards has none of them seeded — measured in a browser, every part
     read "Leave out" and the ordinary answer took ten taps. */
  assert.match(SRC, /await B\.setupParts\(\)[\s\S]{0,220}this\.openForm\("setupFile", \{\}\)/,
    'the parts are loaded, then the form opens');
  assert.ok(!/openForm\("setupFile", null\)/.test(SRC),
    'never opened on nothing — the second control needs a record to act on');
  assert.match(SRC, /k: "p_" \+ p\.key, label: p\.label, full: 1,\s*\n\s*v: "1"/,
    'and everything is included by default');
});

/* ═══ A RECEIPT DOES NOT REQUIRE A CUSTOMER ════════════════════════════════
   Reported: "every receipt expects a customer for sharing. it should not be
   the case." Most bills in a café are rung on nobody, and WhatsApp refused
   every one of them — the till telling the cashier to add a number to a
   record that does not exist. Neither handoff ever needed a recipient. */
test('a bill rung on nobody is still shareable, on every channel', () => {
  const S = require('../app/kashikeyo-share.js');
  const doc = { kind: 'receipt', outlet: 'X', docNo: 'R1', total: 1, currency: 'MVR',
    when: '2026-08-27', link: 'https://x/r/RC1' };

  // WhatsApp with no number opens its OWN contact picker — fewer taps than
  // typing one into this app and watching WhatsApp ask for it again.
  assert.match(S.channelUrl('whatsapp', doc), /^https:\/\/wa\.me\/\?text=/,
    'no recipient is a valid wa.me link');
  assert.match(S.channelUrl('whatsapp', Object.assign({ phone: '7712345' }, doc)),
    /^https:\/\/wa\.me\/9607712345\?text=/, 'and a number is still honoured');

  /* EMAIL IS THE ONLY CHANNEL THAT MAY REFUSE, because a message cannot be
     posted to an inbox nobody named. Refusing the other two for want of a
     number was a requirement this build invented. */
  assert.strictEqual(S.why('whatsapp', doc), '', 'WhatsApp needs nothing');
  assert.strictEqual(S.why('viber', doc), '', 'nor does Viber');
  assert.match(S.why('email', doc), /no email address on file/, 'email still asks');

  // And the till offers a number rather than naming a record that may not
  // exist — the refusal path opens the field, it does not scold.
  assert.match(SRC, /if \(\/no usable mobile\/i\.test\(msg\)\) return this\.askNumber\(s\);/,
    'a missing number opens the field');
  assert.ok(!/add one on their record first/.test(SRC),
    'and never tells a cashier to edit a customer that is not there');
  assert.match(SRC, /askNumber\(spec\) \{/, 'the popup exists');
  assert.match(SRC, /docPhone: \(\(\) => \{/, 'and has a spec built per render');
  // It is held to the SAME definition the link is composed from, so a number
  // this screen accepts can never be one wa.me refuses.
  assert.match(SRC, /S && S\.msisdn \? S\.msisdn\(raw\) : /, 'one definition of a number');
});

/* ═══ AND A CLOSED TICKET IS SHAREABLE TOO ═════════════════════════════════
   The Send control lived only on the receipt that appears the instant a bill
   is settled, so a guest who asked ten minutes later could be sent nothing.
   The row reopened from Orders & Tickets came from the OUTLET, so it already
   carries the outlet's own id — there was nothing to resolve and nothing to
   wait for. */
test('a bill settled earlier can still be sent', () => {
  assert.match(SRC, /shareLabel: ord\.id \? "Send the receipt/,
    'the closed-ticket receipt has its own Send control');
  assert.match(SRC, /doShare: \(\) => ord\.id[\s\S]{0,200}this\.shareDoc\(\{ kind: "receipt", id: ord\.id/,
    'and shares the row the outlet published');
  // A row this device settled but has not yet delivered has no outlet id, and
  // says so rather than offering a control that cannot work.
  assert.match(SRC, /"This bill has not reached the outlet yet"/,
    'an undelivered bill says so plainly');
  /* AND IT COMES BACK. `state.modal` is one slot, so the sheet replaces
     whatever asked for it — on both receipts, not just the settle-time one. */
  assert.match(SRC, /this\.state\.modal\.kind === "settled"\s*\n?\s*\|\| this\.state\.modal\.kind === "receipt"/,
    'both receipts are restored after a send');
});

/* ═══ A 401 SAYS WHICH OF THE TWO IT IS, AND THE TILL LOCKS ════════════════
   Reported: "while sharing a completed receipt, it says session expired."
   Three things were wrong on that path and none of them was the share.

   The server writes a sentence for each case — a signed-out session is fixed
   by keying a PIN, a deregistered device is not fixed by anything the person
   holding it can do — and `_fetch` threw both away for the words "session
   expired". So the one report anybody could make carried the symptom and not
   the fact.

   And `kpos-session-expired` was dispatched into an empty room: no listener,
   anywhere in the build. The token was dropped in silence, the poll stopped,
   the outbox stopped delivering, and a side errand took the whole till down
   without saying so. Same defect as the poll that fired `kpos-tick` and was
   discarded. */
test('a refused session says what the server said, and the terminal locks', () => {
  const API = fs.readFileSync(path.join(__dirname, '..', 'app', 'kashikeyo-api.js'), 'utf8');

  // The body is read BEFORE the status is judged, or there is no sentence to
  // carry — that ordering is the whole fix.
  assert.match(API, /var text = await res\.text\(\)[\s\S]{0,220}if \(res\.status === 401 && !o\.anon\)/,
    'the body is read before a 401 is decided');
  assert.match(API, /var why = \(data && data\.error\)/, "and the server's own words are kept");
  assert.ok(!/throw new Error\("session expired"\)/.test(API),
    'the invented sentence is gone');
  // The event carries enough for the next report to name the fact.
  assert.match(API, /detail: \{ why: why, path: path, revoked: \(data && data\.revoked\) \|\| null \}/,
    'the event says why, where, and which');

  /* AND SOMETHING LISTENS. This is the half that was missing entirely — the
     token was dropped and nothing on any screen said so. */
  assert.match(SRC, /window\.addEventListener\("kpos-session-expired"/,
    'the terminal listens for it');
  assert.match(SRC, /this\.setState\(\{ session: null, modal: null \}\)/,
    'and locks rather than carrying on signed out');
  /* UNDELIVERED WORK IS NAMED, not lost: the outbox is durable and survives
     this, and whoever is standing there needs telling that it resumes when
     somebody signs in — the same rule signing out by hand already follows. */
  assert.match(SRC, /still held here and will go when somebody signs in/,
    'and says what happens to work not yet delivered');
  assert.match(SRC, /this\.fault\("session",/, 'and it lands on Diagnostics');
});

/* ═══ ONE FACT IS ASKED ONCE ════════════════════════════════════════════════
   Three things were asked twice on the onboarding panel, and every one of them
   was invisible from the step that asked second — nothing errors, nothing is
   lost, the customer simply types their own street name into two boxes and
   answers the same tax question on two screens. Repetition is the kind of
   defect a test has to hold, because it never announces itself.

   The tax step was the worst of the three: provisionOutlet() writes
   chain.tax_version from the outlet step's own taxCode, taxRate and taxFrom,
   so the server reported that step DONE before anybody reached it, and it
   could only ever open on "Saved · continue". */
test('the onboarding panel asks one fact once', () => {
  const panel = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'onboarding.html'), 'utf8');

  const steps = panel.slice(panel.indexOf('var STEPS = ['),
    panel.indexOf('var APPLICATION = {'));

  // Every key that appears in more than one step's field list, with what it
  // is allowed to appear twice for. Nothing is allowed twice today.
  const perStep = {};
  let key = null;
  steps.split('\n').forEach((line) => {
    const k = line.match(/^\s{4}key: "([a-z]+)"/);
    if (k) { key = k[1]; perStep[key] = perStep[key] || []; return; }
    const f = line.match(/\{ k: "([A-Za-z0-9]+)"/);
    if (f && key) perStep[key].push(f[1]);
  });

  const CONTACT = ['address', 'atoll', 'phone', 'email', 'zip', 'mobile', 'website'];
  CONTACT.forEach((k) => {
    const asked = Object.keys(perStep).filter((s) => perStep[s].indexOf(k) >= 0);
    /* The outlet may ask again, but only BEHIND the toggle: "same as the
       business" is the default and the fields are hidden until somebody says
       this store trades somewhere else. Asked outright on both steps is the
       defect. */
    asked.forEach((s) => {
      if (s === 'company') return;
      /* The owner step's mobile is the PERSON'S, not the shopfront's — the
         admin's own number on their staff record (migration 045), a different
         fact from the company telephone, so asking both is not asking one
         fact twice. Every other step still has to justify a contact field
         behind the sameAs toggle. */
      if (s === 'owner' && k === 'phone') return;
      const step = steps.slice(steps.indexOf('key: "' + s + '"'));
      const field = (step.match(new RegExp('\\{ k: "' + k + '",[\\s\\S]{0,300}?\\},\\n')) || [''])[0];
      assert.match(field, /showIf: \{ k: "sameAs", is: "no" \}/,
        k + ' on the ' + s + ' step is asked only where it differs');
    });
  });

  // And the outlet step sends the company's answer when it is not asked.
  const outlet = steps.slice(steps.indexOf('key: "outlet"'));
  assert.match(outlet, /var own = v\.sameAs !== "yes";/,
    'the outlet step knows which answer it is sending');
  assert.match(outlet, /address: own \? v\.address : c\.address/,
    "and sends the company's where the store has not given its own");

  // The tax step is gone, absorbed into the step that already wrote its row.
  assert.ok(!/key: "tax"/.test(panel), 'there is no separate tax step');

  /* AND THE PANEL READS THE BUSINESS IT IS SETTING UP, not the terminal it is
     being typed on. /api/auth/install resolves its outlet from the TERMINAL's
     own stamp — so an owner standing at a machine already signed into their
     first store, setting up their second, was shown the FIRST store's code,
     tax class and rate. The document-series prefix is built from that code,
     and a series that has issued a number can never be renumbered: the second
     store's receipts would have carried the first store's prefix for good. */
  assert.ok(!/state\.outlet\b(?!Rec)/.test(panel),
    'nothing reads the lock screen\'s idea of which outlet this is');
  assert.match(panel, /state\.outletRec && state\.outletRec\.code/,
    'the series prefix comes from this business\'s own outlet');

  /* THE NUMBER IS DERIVED. Every step used to carry its own `n` and the screen
     its own literal 14, so folding one step into another was a fourteen-place
     edit and a missed one reads as "step 5 of 14" over the fourth card. */
  assert.ok(!/\bn: \d+, label:/.test(panel), 'no step numbers itself');
  assert.match(panel, /STEPS\.forEach\(function \(s, i\) \{\n\s*s\.n = i \+ 1;/,
    'the number comes from the position');
  /* Comments describe the defect being fixed and are allowed to quote it; the
     CODE is what must not count to a literal. Strip the prose first, or this
     check fails on the paragraph explaining why it exists. */
  const code = panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/of 14|\/ 14\b|doneN \/ 14/.test(code),
    'and nothing counts to a literal fourteen');
});

/* A logo is an image off a phone, and a four-megapixel JPEG in an offline
   cache costs a terminal its whole storage budget — the same rule the dish
   photograph already follows. PNG stays PNG: a logo is the one image in this
   app that genuinely needs transparency, and re-encoding it as JPEG puts a
   white box behind the mark on every dark receipt header. */
test('a logo is scaled on the device, and a PNG stays a PNG', () => {
  const panel = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'onboarding.html'), 'utf8');
  const fn = panel.slice(panel.indexOf('function logoControl('),
    panel.indexOf('function renderTable('));
  assert.match(fn, /var max = 320;/, 'it is scaled down before it is sent');
  assert.match(fn, /got\.type === "image\/png"\s*\n?\s*\? cv\.toDataURL\("image\/png"\)/,
    'and a PNG keeps its transparency');
  assert.match(fn, /2 \* 1024 \* 1024/, 'a file over the limit is refused');
  assert.match(fn, /a logo is a PNG or a JPG/, 'and refused BY NAME, not ignored');

  // Both logos reach a column. A field collected, toasted as saved and written
  // nowhere is the defect this build refuses by name.
  assert.match(panel, /brand: \{ logo: v\.logo \|\| "", type: v\.bizType/,
    "the company's logo rides on chain.company.brand");
  assert.match(panel, /logo: v\.logo \|\| "",\n\s*email:/,
    "and the outlet's on chain.outlet.brand");
  const mig = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations',
    '044_an_outlet_has_a_face.sql'), 'utf8');
  assert.match(mig, /ALTER TABLE chain\.outlet ADD COLUMN IF NOT EXISTS brand jsonb/,
    'which migration 044 gave it');
});

/* ═══ PAYMENT EVIDENCE IS NEVER MINTED ══════════════════════════════════════
   The card/wallet settle path used to hold the operator on a 780 ms spinner
   ("Waiting for the terminal…") and then stamp a SIX-DIGIT CODE FROM
   Math.random into the payment's `ref` — the field the settlement screen
   matches against the acquirer's file, and the field the "Unreferenced card
   sales" exception lane exists to police. No terminal integration exists, so
   the wait was theatre and the code was fabricated evidence that silenced the
   one control built to catch an uncorroborated card sale. Found by the
   Math.random sweep in the re-audit; this pin keeps it out. */
test('the till never fabricates an approval code', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/approvalCode/.test(code), 'no approval-code minter exists');
  assert.ok(!/Waiting for the terminal/.test(code),
    'and no copy claims a terminal round-trip this build does not make');
  assert.ok(!/Captured from the terminal/.test(code),
    'the reference field never claims to be captured');
  // The honest lane: a blank reference is flagged, never filled in.
  assert.match(app, /Leave blank and the sale is flagged unreferenced/,
    'the field says what a blank one costs');
  /* And Math.random never touches a payment. The only remaining uses in the
     till are the CSPRNG-absent uuid fallback (unreachable in any browser that
     can run this app) — a payment reference is not allowed to join them. */
  const payZone = app.slice(app.indexOf('confirmPay:'), app.indexOf('confirmPay:') + 4000)
    .replace(/\/\*[\s\S]*?\*\//g, '');   // the comment explaining the defect may name it
  assert.ok(!/Math\.random/.test(payZone), 'nothing random inside the settle path');
});

/* ═══ THE ROLE LOCK SPANS THE COMMIT ════════════════════════════════════════
   provisionOutlet's cluster mutex used to wrap only the provision_outlet
   STATEMENT — and an advisory lock on the maintenance connection frees when
   the statement resolves, while the provision's own transaction goes on
   holding the uncommitted ALTER ROLE tuple through the registry round-trips.
   The next provisioner took the freed lock and died on the still-open
   transaction: "tuple concurrently updated", inside the lock, unretryable.
   Reproduced deterministically (two suites provisioning in parallel → one
   105-failure cascade) and caught with DDL logging. The lock has to wrap the
   whole transaction, and this pin keeps it there. */
test('the provision lock wraps the transaction, not the statement', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'provision.js'), 'utf8');
  assert.match(src, /return withRoleLock\(\(\) => provisionLocked\(opts, client\)\)/,
    'the whole provision runs inside the lock');
  const locked = src.slice(src.indexOf('async function provisionLocked'));
  assert.match(locked, /BEGIN/, 'the transaction begins inside it');
  assert.match(locked, /COMMIT/, 'and commits inside it');
  assert.ok(!/withRoleLock/.test(locked.slice(0, locked.indexOf('COMMIT'))),
    'and nothing nests the lock inside itself');
  // The migration runner's cluster-wide role work holds the same mutex.
  const mig = fs.readFileSync(path.join(__dirname, '..', 'src', 'scripts', 'migrate.js'), 'utf8');
  assert.match(mig, /return withRoleLock\(\(\) => ensureReportRoleUnlocked\(db, say, opts\)\);/,
    'the report-role writer holds it too');
});

/* ═══ THE PHONE QUOTES THE MERCHANT'S RATE, WITH OR WITHOUT A ROSTER ════════
   The member card's programme() preferred the till-published roster and, when
   no roster had ever been published, fell back to a hard-coded 100-for-25 —
   while the projection it had ALREADY LOADED carried the outlet's real
   loyalty setting. Measured: a store publishing 200-for-40 showed 36 points
   as WORTH MVR 9.00 against the 7.20 the till would honour. And a published
   ladder carries thresholds with no colours, which painted the whole
   membership card white on white until the shipped rows' presentation was
   inherited by key. */
test("the member card reads the outlet's published rate and skins its ladder", () => {
  const card = fs.readFileSync(path.join(__dirname, '..', 'app', 'member.html'), 'utf8');
  const prog = card.slice(card.indexOf('programme() {'), card.indexOf('programme() {') + 1600);
  assert.match(prog, /this\.K\(\)\.LOYALTY/, 'the fallback reads the published loyalty setting');
  assert.match(prog, /Number\(L\.redeemPts\) > 0 \? Number\(L\.redeemPts\) : 100/,
    'and the literal is only the last resort of a store that never published');
  assert.match(card, /tierSkin\(t\)/, 'a published rung inherits the shipped presentation');
  assert.match(card, /TIERS_SHIPPED/, 'from the stashed shipped ladder, not a second copy');
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'app', 'guest-bridge.js'), 'utf8');
  assert.match(bridge, /if \(!K\.TIERS_SHIPPED\) K\.TIERS_SHIPPED = K\.TIERS;/,
    'the bridge stashes the shipped rows before the published ladder replaces them');
});

test('the table QR is a real code, and the print buttons print', () => {
  /* What stood behind "scan to order" was a 13×13 grid of Math.random()
     cells — a picture of a QR no camera could read — and both buttons under
     it closed the modal. A QR that is subtly wrong looks exactly like one
     that is right, which is why this pin is static: the fake could return
     wearing any refactor. */
  const till = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const qr = till.slice(till.indexOf('if (m.kind === "qr") {'),
    till.indexOf('if (m.kind === "qr") {') + 2200);
  assert.match(qr, /KPOS_QR\.dataUrl/, 'the modal draws the real matrix');
  assert.ok(!/rnd\(\) > 0\.5/.test(qr), 'the random fake is gone');
  assert.match(till, /<script src="\.\/kashikeyo-qr\.js"><\/script>/,
    'the shared encoder is loaded');
  assert.match(till, /printQrCards\(slots\)/, 'the print sheet exists');
  assert.match(till, /qrPrintAll/, 'and every table can be printed in one act');
  assert.ok(!/Rotate token/.test(till),
    'no control offers a rotation this build cannot perform');
  // The shared module is one file both runtimes load, like kashikeyo-rules.
  const qrMod = fs.readFileSync(path.join(__dirname, '..', 'app', 'kashikeyo-qr.js'), 'utf8');
  assert.match(qrMod, /module\.exports = API/, 'required by the server');
  assert.match(qrMod, /root\.KPOS_QR = API/, 'and loaded by the browser');
});

test("a member's round carries its table and its membership", () => {
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'app', 'guest-bridge.js'), 'utf8');
  /* `Object.assign({ table: state.table }, { table: undefined })` clobbers
     the bound table — every order from the member card went out table-less
     and was refused 400 while the toast said "sent". */
  assert.match(bridge, /table: e\.table \|\| state\.table/,
    "the caller's table wins only where the caller names one");
  assert.match(bridge, /bindTable: function \(t\)/,
    'keying a table re-mints the token for it');
  assert.match(bridge, /"x-member-token": state\.member/,
    'the membership rides as a header, never a body field');
  const card = fs.readFileSync(path.join(__dirname, '..', 'app', 'member.html'), 'utf8');
  assert.match(card, /table: s\.table \}/, 'sendOrder carries the keyed table');
  assert.match(card, /KPOS_GUEST_API\.bindTable/, 'picking a table binds the bridge');
  const guest = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'guest.js'), 'utf8');
  assert.match(guest, /x-member-token/, 'the order door reads the member token');
  assert.ok(!/b\.member\b/.test(guest),
    'and never a client-claimed member id from the body');
});

test('the bill ask carries its decision, and the ask has a control', () => {
  /* requestBill() existed on the guest portal since the tab was written and
     NOTHING CALLED IT — a guest chose a split, a tip and a tender, was told
     what they were paying, and the screen offered no way to say so. And the
     network path sent kind+text only, so the decision survived solely in
     localStorage, which reaches a till only when the till shares the browser. */
  const guest = fs.readFileSync(path.join(__dirname, '..', 'app', 'guest.html'), 'utf8');
  assert.match(guest, /V\.askPay = \(\) => asked \? null : this\.requestBill\(\);/,
    'the guest bill tab has the ask itself');
  assert.match(guest, /const pay = kind === "bill" \? \{/,
    'and the ask carries tender, tip, due and split over the wire');
  const card = fs.readFileSync(path.join(__dirname, '..', 'app', 'member.html'), 'utf8');
  assert.match(card, /const pay = kind === "bill" \? \{/, 'the member card sends the same');
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'app', 'guest-bridge.js'), 'utf8');
  assert.match(bridge, /pay: pay \|\| undefined/, 'the bridge forwards it');
  const till = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  assert.match(till, /Object\.assign\(\{\}, r\.pay \|\| \{\}/,
    'the till folds the intent onto the signal ingestPayIntent reads');
  const sync = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'guest.js'), 'utf8');
  assert.match(sync, /tender: String\(b\.pay\.tender \|\| ''\)\.slice\(0, 16\)/,
    'the open door whitelists the shape field by field');
});

test("the portals sell with the till's tenders and the outlet's add-ons", () => {
  const outlet = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'outlet.js'), 'utf8');
  assert.match(outlet, /tenders: tenders,\n    modifiers: modifiers/,
    'the guest projection publishes both');
  assert.match(outlet, /memberOnly: true/, 'customer credit says it is a member tender');
  const guest = fs.readFileSync(path.join(__dirname, '..', 'app', 'guest.html'), 'utf8');
  assert.match(guest, /TENDERS_PUBLISHED/, 'the guest pay sheet reads the published set');
  /* The add-on's NAME feeds the kitchen and its MONEY feeds the bill — the
     note alone reached the docket and never the total, so every priced
     add-on was given away. */
  assert.match(guest, /addons: l\.extra \|\| 0,/, 'the guest round carries the add-on money');
  const card = fs.readFileSync(path.join(__dirname, '..', 'app', 'member.html'), 'utf8');
  assert.match(card, /TENDERS_PUBLISHED/, 'the member pay sheet reads the published set');
  assert.match(card, /addons: l\.extra \|\| 0,/, 'the member round carries it too');
  assert.match(card, /confirmDishSheet\(\)/, 'and the member card has the add-on sheet');
  const till = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  assert.match(till, /this\.menuPrice\(mi\) \+ \(\+ql\.addons \|\| 0\)/,
    'the till prices the line menu + declared add-ons');
});

test('the member card draws the same plates as the guest portal', () => {
  const card = fs.readFileSync(path.join(__dirname, '..', 'app', 'member.html'), 'utf8');
  /* This card fed raw data: URLs into background-image — `;base64` ends the
     inline declaration and the photo paints NOTHING — and an unphotographed
     dish was a blank grey box. The plate is one composition across the till,
     the guest portal and this card. */
  assert.match(card, /photoUrl\(src\)/, 'a data URL becomes a blob before CSS sees it');
  assert.match(card, /artGlyphUrl\(catId, ink\)/, 'the section artifact is composed here too');
  assert.ok((card.match(/this\.plate\(/g) || []).length >= 5,
    'every dish image site goes through the one plate composition');
  assert.ok(!/url\('" \+ d\.img \+ "'\)/.test(card),
    'no site feeds a raw data URL into background-image any more');
});

/* ═══ A DISCOUNTED RECEIPT SHOWS ITS DISCOUNT, EVERYWHERE A RECEIPT IS ══════
   Service and tax follow the DISCOUNTED goods, so a receipt that prints
   Subtotal, Service, Tax and TOTAL without the discount row is a paper whose
   own arithmetic overshoots its TOTAL by exactly the discount — and the guest
   is never told one was given. Four surfaces had the gap, each differently:
   the settled receipt modal (and the paper "Print & close" maps from it), the
   auto-printed receipt (which carried NO totals at all), the Orders-reopened
   copy (which RECOMPUTED the total from the pre-discount subtotal, so every
   discounted bill was overstated on the one screen a guest asks to see
   again), and the ticket panel's own totals. And the reason the form makes
   mandatory, plus who authorised it, never rode the sale op at all —
   sale.discount_reason and discount_by were NULL for every discount ever
   given. */
test('a discounted receipt shows its discount on every surface', () => {
  // 1 · the settled receipt modal (its rows are also what the print maps)
  assert.match(SRC, /\{ n: "Discount" \+ \(T\.discCode \? " " \+ T\.discCode : ""\) \+ \(T\.discPct \? " " \+ T\.discPct \+ "%" : ""\),\s*\n\s*v: "\\u2212 " \+ MVRc\(T\.disc\)/,
    'the settled receipt carries a Discount row between Subtotal and Service');

  // 2 · the auto-printed paper carries totals, discount included
  assert.match(SRC, /const totalRows = \[\["Subtotal", MVRc\(T\.sub\)\]\]/,
    'the auto-printed receipt composes its totals');
  assert.match(SRC, /\.concat\(T\.disc \? \[\["Discount" \+ \(T\.discCode \? " " \+ T\.discCode : ""\), "\\u2212 " \+ MVRc\(T\.disc\)\]\] : \[\]\)/,
    'with the discount where one was given');
  assert.match(SRC, /rows: \(snapshot\.lines \|\| \[\]\)\.map\(\(l\) => \[l\.n, l\.v\]\)\.concat\(\[\{ rule: 1 \}\], totalRows\)/,
    'and they reach the paper after the rule');

  // 3 · Orders-reopened prints the STORED total, never a recomputation
  assert.match(SRC, /const ordTotal = ord\.total !== undefined \? ord\.total : \(acc - ordDisc\) \+ svc \+ tax;/,
    'the reopened receipt reads the stored total');
  assert.match(SRC, /\{ n: "Discount" \+ \(ord\.discCode \? " " \+ ord\.discCode : ""\), v: "\\u2212 " \+ MVRc\(ordDisc\)/,
    'and shows the discount row');
  assert.match(SRC, /refundTotal: ordTotal,/,
    'the refund figure is the stored total too');
  assert.ok(!/TOTAL", v: MVRc\(acc \+ svc \+ tax\)/.test(SRC),
    'no reopened TOTAL is recomputed from the pre-discount subtotal');

  // 4 · the ticket panel totals
  assert.match(SRC, /\.concat\(T\.disc \? \[\{ k: "Discount" \+ \(T\.discCode \? " " \+ T\.discCode : ""\) \+ \(T\.discPct \? " " \+ T\.discPct \+ "%" : ""\),/,
    'the ticket panel lists the discount between Subtotal and Service');

  // 5 · the reason and the authoriser ride the sale op to the outlet
  assert.match(SRC, /byId: \(this\.state\.session \|\| \{\}\)\.id \|\| null, why: v\.why/,
    'applying a discount records the session actor uuid beside the name');
  assert.match(SRC, /discWhy: pr \? \(pr\.why \|\| ""\) : "", discBy: pr \? \(pr\.byId \|\| ""\) : ""/,
    'the trail carries both');
  assert.match(SRC, /discReason: row\.discWhy \|\| null, discBy: row\.discBy \|\| null,/,
    'and the sale op sends them under the names the server reads');
});

/* ═══ THE MENU IMPORT TAKES A FILE ══════════════════════════════════════════
   The Import & export modal had a paste box and a dry-run plan, and no way to
   hand it the .csv the spreadsheet actually saved — and Menu Master's one
   button opened on the EXPORT tab, so "import a CSV" began with a download
   screen. The dishes screen opens straight into import now, and the picker's
   file lands in the SAME text the paste box feeds: one road to the plan,
   however the rows arrive. */
test('the menu import takes a file, and Menu Master opens straight into it', () => {
  assert.match(SRC, /\{ label: "Import CSV", go: \(\) => this\.openMenuIO\("import"\) \}/,
    'the dishes screen has the direct door');
  assert.match(SRC, /tab: tab === "import" \? "import" : "export"/,
    'and openMenuIO lands on the tab it was asked for');
  assert.match(SRC, /inp\.accept = "\.csv,text\/csv,text\/plain";/,
    'the picker takes a .csv file');
  assert.match(SRC, /rd\.onload = \(\) => put\(\{ text: String\(rd\.result \|\| ""\), file: f\.name \}\);/,
    'and what it reads feeds the same plan the paste box does');
  assert.match(SRC, /onClick="\{\{ ioPick \}\}"/, 'the button is in the template');
  // The op still carries the dishes — the fix that made import real at all.
  assert.match(SRC, /this\.queue\("menu_import", "Menu imported \\u00b7 " \+ label, "menu_items",\s*\n\s*\{ dishes: dishes \}\)/,
    'and the import op still carries the dishes');
});

/* ═══ SECTIONS AND ADD-ONS RIDE THE SAME FILE ══════════════════════════════
   "add sections as well to be included in the csv file. addons everything."
   One file carries the whole menu, and the QUEUE ORDER IS THE APPLY ORDER —
   a push applies in lamport order, which is the order things are queued in.
   So the section goes first (a dish naming one that has not landed is refused
   by the foreign key), the add-on GROUP goes before the dishes (a dish naming
   a new add-on writes an item_modifier row whose group must already exist),
   the dishes follow, and the section LINKS go last, once every dish in the
   file exists to be linked. */
test('one CSV carries a section, an add-on and a dish, queued in the order the outlet can accept', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const queued = [];
  F.__win.KPOS_SYNC = { enqueue: (op) => { queued.push(op); return op.opId; } };

  const csv = [
    'type,name,section,price,description,station,tags,spice,addons,visible',
    'section,Night Grill,,,,Hot pass,,,,yes',
    'addon,Garlic butter,Night Grill,12,,,,,,yes',
    'dish,Grilled Job Fish,Night Grill,180,Whole fish over coals,,,2,Garlic butter,yes'
  ].join('\n');
  const plan = F.menuImportPlan(csv);
  // vm-created arrays fail deepStrictEqual's cross-realm prototype check,
  // so everything here compares by value.
  assert.strictEqual(plan.err.length, 0, 'nothing is rejected: ' + JSON.stringify(plan.err));
  assert.strictEqual(plan.secAdd.length, 1, 'the section is planned');
  assert.strictEqual(plan.secAdd[0].id, 'night-grill',
    'under a stable slug id, so two devices importing the same file converge');
  assert.strictEqual(plan.modAdd.length, 1, 'the add-on is planned');
  assert.strictEqual(JSON.stringify(plan.modAdd[0].cats), '["night-grill"]',
    'published to the section defined in the same file');
  assert.strictEqual(plan.add.length, 1, 'the dish is planned');
  assert.strictEqual(plan.add[0].cat, 'night-grill',
    'and it resolves the section defined higher up the same file');
  assert.strictEqual(plan.add[0].addons.length, 1);
  assert.strictEqual(plan.add[0].addons[0], plan.modAdd[0].id,
    'wearing the add-on the same file defined');

  F.applyMenuImport(plan);
  const kinds = queued.map((q) => q.kind);
  const iSec = kinds.indexOf('menu_category_insert');
  const iGrp = kinds.indexOf('modifier_update');
  const iDish = kinds.indexOf('menu_import');
  const iLink = kinds.lastIndexOf('modifier_update');
  assert.ok(iSec >= 0 && iGrp > iSec && iDish > iGrp && iLink > iDish,
    'section → add-on group → dishes → section links: ' + kinds.join(', '));
  assert.strictEqual(queued[iSec].payload.id, 'night-grill');
  const grp = queued[iGrp].payload;
  assert.strictEqual(grp.groupName, 'Garlic butter');
  assert.strictEqual(grp.price, 12);
  assert.strictEqual(grp.items.length, 0,
    'no links before the dishes exist — item_modifier references item(id)');
  const imp = queued[iDish].payload;
  assert.strictEqual(imp.dishes.length, 1);
  assert.strictEqual(imp.dishes[0].addons.length, 1);
  assert.strictEqual(imp.dishes[0].addons[0], grp.id,
    'the dish op names the add-on group the file defined');
  const link = queued[iLink].payload;
  assert.strictEqual(link.items.length, 1, 'the link rides once the dish exists');
  assert.strictEqual(link.items[0], imp.dishes[0].id);

  // A file from before the type column existed still imports whole.
  const old = F.menuImportPlan('name,section,price\nOld Dish,Night Grill,90');
  assert.strictEqual(old.err.length, 0, 'an old header is still a dish list');
  assert.strictEqual(old.add.length, 1);

  // And the export carries all three kinds, so a round trip loses nothing.
  const out = F.menuCsv();
  assert.match(out, /^type,id,name,section,price/, 'the header leads with type and id');
  assert.match(out, /\nsection,/, 'the sections are in the file');
  assert.match(out, /\ndish,/, 'and the dishes');
});

/* ═══ BOUGHT IN READY TO SELL (048) ════════════════════════════════════════
   Two honest kinds of menu item, from one nullable link — and the till's op
   carries it, or the whole model lives in one browser. */
test('a bought-in dish rides the wire whole, and the CSV can define one', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const op = F.opFor('menu', { id: 'm_gulha', name: 'Gulha', cat: 'mains', price: 8,
    buy: { item: 'ing_fish', vendor: null, pack: 24 }, qrOff: true, tags: [], recipe: [] });
  assert.ok(op && op.kind === 'dish_upsert');
  assert.strictEqual(op.payload.buy.item, 'ing_fish', 'the buy link travels the item');
  assert.strictEqual(op.payload.buy.vendor, null, 'and the vendor');
  assert.strictEqual(op.payload.buy.pack, 24, 'and the pack');
  assert.strictEqual(op.payload.qrOff, true, 'and the QR-channel switch');
  // Silence still preserves: a row that has never heard of either sends
  // buy: null (the whole row always knows) and qrOff: null.
  const bare = F.opFor('menu', { id: 'm1', name: 'X', cat: 'mains', price: 10, tags: [], recipe: [] });
  assert.strictEqual(bare.payload.buy, null);
  assert.strictEqual(bare.payload.qrOff, null);
  // A bought-in dish fires to no pass.
  assert.strictEqual(F.dishStation({ buy: { item: 'ing_fish', pack: 1 }, cat: 'mains' }), 'counter');

  // The CSV can define one — and refuses the two fictions by name.
  const head = F.MENUCSV().join(',');
  const plan = F.menuImportPlan([head,
    'dish,,Gulha Tray,Mains,8,,,,,,yes,no,bought,ing_fish,24,',
    'dish,,Ghost Tray,Mains,8,,,,,,yes,yes,bought,,,',
    'dish,,Gulha Tray,Mains,9,,,,,,yes,yes,made,,,'
  ].join('\n'));
  assert.strictEqual(plan.add.length, 1, JSON.stringify(plan.err));
  assert.strictEqual(plan.add[0].buy.item, 'ing_fish');
  assert.strictEqual(plan.add[0].buy.pack, 24);
  assert.strictEqual(plan.add[0].station, 'counter');
  assert.strictEqual(plan.add[0].qrOff, true, 'qr=no takes it off the guest channel on import');
  assert.ok(plan.err.some((e) => /Bought-in dishes need a stock_item/.test(e[1])),
    'a bought-in row with no stock item is refused by name');
  assert.ok(plan.err.some((e) => /Appears twice in this file/.test(e[1])),
    'and a duplicate dish name is refused rather than last-wins');
});

/* AND THE ADD-ON EDITOR'S OWN WRITES REACH THE OUTLET. `setMods()` queued
   `modifier_update` with a label and NO PAYLOAD — the same class as the
   section ops — so every add-on created, repriced or republished on the till
   lived in one browser's session and reached the outlet never, while the
   toast said it was saved. */
test('an add-on edited on the till goes out whole, and a removed one is removed', () => {
  const F = H.makeInstance({ kpos: FX.kpos(), raw: FX.raw(), real: FX.real() });
  const queued = [];
  F.__win.KPOS_SYNC = { enqueue: (op) => { queued.push(op); return op.opId; } };

  F.setMods(F.modList().concat([{ id: 'mod_x', name: 'Extra cheese', price: 5, cats: ['mains'] }]),
    'Extra cheese added');
  const op = queued.filter((q) => q.kind === 'modifier_update').pop();
  assert.ok(op, 'the op is queued at all');
  ['group', 'groupName', 'id', 'name', 'price', 'items'].forEach((k) => {
    assert.ok(op.payload[k] !== undefined, 'the op carries ' + k + ': ' + JSON.stringify(op.payload));
  });
  assert.strictEqual(op.payload.group, 'mod_x',
    'one group per till-made add-on, under the add-on\'s own id');
  assert.ok(Array.isArray(op.payload.items), 'the section links ride as items');

  F.setMods(F.modList().filter((x) => x.id !== 'mod_x'), 'Extra cheese removed');
  const rm = queued.filter((q) => q.kind === 'modifier_remove').pop();
  assert.ok(rm && rm.payload.id === 'mod_x' && rm.payload.group === 'mod_x',
    'the removal reaches the outlet instead of being resurrected by the next bootstrap');

  // The bare call this replaced must never come back.
  assert.ok(!/this\.queue\("modifier_update", line/.test(SRC),
    'no modifier_update is queued without its payload');
});

/* AND `state.modifiers` IS A HOLDING PEN, NOT A PRIVATE FORK — which is the
   rule every other local copy in this build already keeps (a measured yield,
   a saved batch, a published programme, a section's meta) and the one
   `modList()` broke.

   It answered `this.state.modifiers || K().MODIFIERS`. An EMPTY ARRAY IS
   TRUTHY, so a terminal holding no un-synced add-on edit answered the outlet's
   hundred-odd options with nothing at all: Menu Master read "Add-ons · 0" on a
   store whose outlet publishes 115, which is exactly how it was reported. And
   a pen holding ONE row was worse than empty — it hid the other hundred behind
   a single local edit, so the dish sheet offered one add-on and the CSV export
   wrote one row.

   Layering is the fix and the test is the shape: the outlet's list is the
   floor, a held row REPLACES the outlet's copy of that same id (this device's
   edit has not been delivered yet, so it is the later answer here), and a held
   row the outlet has never published is appended. */
test('the add-on pen layers over the outlet, and an empty one answers for nothing', () => {
  const K = FX.kpos();
  K.MODIFIERS = [
    { id: 'm1', name: 'Extra cheese', price: 5, cats: ['mains'] },
    { id: 'm2', name: 'Extra chilli', price: 3, cats: ['mains'] },
    { id: 'm3', name: 'Large', price: 10, cats: ['drinks'] }
  ];
  const F = H.makeInstance({ kpos: K, raw: FX.raw(), real: FX.real() });

  // No pen at all — the outlet answers.
  F.state.modifiers = null;
  assert.strictEqual(F.modList().length, 3, 'with no pen the outlet\'s list is the answer');

  // THE REPORTED SHAPE. An empty pen is truthy and used to win.
  F.state.modifiers = [];
  assert.strictEqual(F.modList().length, 3,
    'an empty pen must not answer zero over an outlet that publishes three');

  // A held EDIT of a published row replaces that row, and only that row.
  F.state.modifiers = [{ id: 'm2', name: 'Extra chilli', price: 4, cats: ['mains'] }];
  const layered = F.modList();
  assert.strictEqual(layered.length, 3, 'a one-row pen does not hide the other two');
  assert.strictEqual(layered.find((x) => x.id === 'm2').price, 4,
    'this device\'s un-delivered edit is what it reads back');
  assert.strictEqual(layered.find((x) => x.id === 'm1').price, 5,
    'and the outlet\'s answer stands for every row the pen says nothing about');

  // A held row the outlet has never heard of is carried too.
  F.state.modifiers = [{ id: 'mNew', name: 'Double shot', price: 12, cats: ['drinks'] }];
  const withNew = F.modList();
  assert.strictEqual(withNew.length, 4, 'an un-synced new add-on rides beside the outlet\'s');
  assert.ok(withNew.some((x) => x.id === 'mNew'));

  // And the defect itself, statically: `||` over a possibly-empty array.
  assert.ok(!/this\.state\.modifiers\s*\|\|\s*(this\.)?K\(\)\.MODIFIERS/.test(SRC),
    'the pen never REPLACES the published list');
});

/* ── A SETTLED BILL IS A STAGE, AND THE LAST ONE ─────────────────────────────
   Reported: "qr portal orders when settled shows received status."

   The guest snapshot's ticket query is `WHERE t.status = 'open'`, so the
   moment the counter takes the money the table leaves the floor list the
   tracker reads. `stage()` then fell through every live branch to its
   localStorage fallback — this phone's own record of what it last SENT, which
   is "Received" — and stayed there for ever. The guest paid and watched their
   food be received.

   Absence cannot be the answer, because an open list carries no reason: closed,
   voided and moved all look identical from the phone. So the projection SAYS
   so, and the ladder gains a rung. */
test('the guest projection carries settled bills, and the tracker ends on Paid', () => {
  const SNAP = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'outlet.js'), 'utf8');
  const BR = fs.readFileSync(path.join(__dirname, '..', 'app', 'guest-bridge.js'), 'utf8');
  const GU = fs.readFileSync(path.join(__dirname, '..', 'app', 'guest.html'), 'utf8');

  // The projection is the road — never the co-located till's localStorage,
  // which only works when the phone and the till share a browser.
  assert.ok(/settled:\s*q\.settled\.rows/.test(SNAP),
    'the guest snapshot publishes a settled list');
  assert.ok(/JOIN\s+ticket\s+t\s+ON\s+t\.id\s*=\s*s\.ticket_id/.test(SNAP),
    'joined through ticket_id, so the row names the TABLE the guest is sitting at');
  assert.ok(/voided_at\s+IS\s+NULL/.test(SNAP),
    'a voided sale is not a bill anybody settled');
  assert.ok(/s\.at\s*>\s*now\(\)\s*-\s*interval/.test(SNAP),
    'and it is a window, not the store\'s whole trading history');

  // Nothing a guest may not see rides along.
  const seg = SNAP.slice(SNAP.indexOf('settled:'), SNAP.indexOf('settled:') + 400);
  ['cogs', 'margin', 'staff', 'device_id', 'member_id'].forEach((k) => {
    assert.ok(seg.indexOf(k) < 0, 'the settled row carries no ' + k);
  });

  assert.ok(/K\.SETTLED\s*=/.test(BR), 'the bridge hands it to the page');
  assert.ok(/settledHere\(\)/.test(GU) && /steps:\s*STEPS\.concat\(\["Paid"\]\)/.test(GU),
    'and the ladder gains its last rung from the outlet\'s own answer');
  // A settlement older than this phone's last round belongs to an earlier
  // sitting — the same guard paidReceipt() already keeps.
  assert.ok(/new Date\(hit\.at \|\| 0\)\.getTime\(\) < last/.test(GU),
    'an earlier sitting\'s bill cannot claim a round somebody has just sent');
  // fmt() rounds to whole units. What the guest paid is not a menu price.
  assert.ok(/"Settled · " \+ this\.money\(paidRow\.total\)/.test(GU),
    'the paid rung states the exact total, never a rounded one');
});

/* ── THE PRE-SET MENU IS INTERNALLY WHOLE ─────────────────────────────────────
   The onboarding choice and the Menu Master action both replay
   src/data/preset-menu.json through the ordinary handlers. A reference that
   does not resolve — a dish naming a section, add-on group or stock item the
   file does not carry — would be refused at apply time on a customer's very
   first screen, so the file is held to its own references here, statically,
   and the op order is pinned: suppliers, then sections, then add-on groups,
   then stock items, then dishes — the apply order the FKs force. */
test('the pre-set menu resolves every reference it makes, in apply order', () => {
  const { presetOps, presetCounts } = require('../src/preset');
  const P = require('../src/data/preset-menu.json');

  const counts = presetCounts();
  assert.ok(counts.dishes >= 300, counts.dishes + ' dishes shipped');
  assert.ok(counts.addons >= 100, counts.addons + ' add-on options');
  assert.ok(counts.sections >= 5 && counts.counter >= 5 && counts.suppliers >= 1);

  const secs = new Set(P.sections.map((s) => s.id));
  const grps = new Set(P.addons.map((a) => a.group));
  const stock = new Set(P.stockItems.map((s) => s.id));
  const sups = new Set(P.suppliers.map((s) => s.name));
  const ids = new Set();
  P.dishes.forEach((d) => {
    assert.ok(!ids.has(d.id), 'dish id ' + d.id + ' appears once');
    ids.add(d.id);
    assert.ok(secs.has(d.cat), d.name + ' sits in a section the file defines');
    (d.addons || []).forEach((a) =>
      assert.ok(grps.has(a), d.name + ' names add-on group ' + a + ' the file defines'));
    if (d.buy) {
      assert.ok(stock.has(d.buy.item), d.name + ' buys a stock item the file defines');
      assert.ok(sups.has(d.buy.vendorName), d.name + ' names a supplier the file defines');
      assert.ok(d.buy.pack >= 1, d.name + ' has a pack that serves');
    }
    assert.ok(typeof d.price === 'number' && d.price >= 0, d.name + ' has a price');
  });

  const kinds = presetOps().map((o) => o.kind);
  const first = (k) => kinds.indexOf(k), last = (k) => kinds.lastIndexOf(k);
  assert.ok(last('vendor_upsert') < first('dish_upsert'), 'suppliers before dishes');
  assert.ok(last('menu_category_insert') < first('dish_upsert'), 'sections before dishes');
  assert.ok(last('modifier_update') < first('dish_upsert'), 'add-on groups before dishes');
  assert.ok(last('item_upsert') < first('dish_upsert'), 'stock items before the buy links');
  assert.strictEqual(kinds.length,
    counts.suppliers + counts.sections + counts.addons + counts.stockItems
    + counts.dishes,
    'nothing rides the preset but what the counts describe');
});

/* ── AND THE ADD-ONS CAN BE LOADED WITHOUT THE 301 DISHES ────────────────────
   Reported: "menu master ... addons is zero. I asked to bring all addons list
   in that prot and add those."

   The pre-set loader is drawn only while a store's menu is still small, and
   rightly — it replays 301 `dish_upsert`s, which are exhaustive and would put
   the shipped name, price and description back over whatever the store has
   since typed. So a store that reached its menu ANY OTHER WAY (the CSV import,
   or a build from before the add-ons were in this file) had no door to the 112
   options at all, and Menu Master read "Add-ons · 0" for ever with nothing on
   screen to do about it.

   `part: 'addons'` is the additive half: the groups and options, plus the
   links, and not one dish row. */
test('the pre-set add-ons load on their own, links and all', () => {
  const { presetOps } = require('../src/preset');
  const P = require('../src/data/preset-menu.json');

  const only = presetOps({ part: 'addons' });
  assert.ok(only.length && only.every((o) => o.kind === 'modifier_update'),
    'the add-ons part writes add-ons and nothing else');
  assert.strictEqual(only.length, P.addons.length, 'every shipped option');
  assert.ok(!only.some((o) => o.kind === 'dish_upsert'),
    'NO DISH ROW — the whole reason this is a separate door from the catalogue');

  // The links ride here and only here.
  const links = only.reduce((n, o) => n + (o.payload.items || []).length, 0);
  assert.ok(links > 1000, 'the links that attach them to the dishes ride along: ' + links);
  const ids = new Set(P.addons.map((a) => a.id));
  P.dishes.forEach((d) => (d.addons || []).forEach((a) =>
    assert.ok(ids.has(a), d.name + ' names an add-on the file does not carry: ' + a)));

  /* And NOT on the whole-catalogue load. There the add-ons are applied before
     the dishes exist — they must be, or a dish naming a group that has not
     landed loses the link — so a link written there would name a row that is
     not there yet; the dishes write their own a moment later. */
  const all = presetOps();
  assert.ok(all.filter((o) => o.kind === 'modifier_update')
    .every((o) => !(o.payload.items || []).length),
    'the whole-catalogue load leaves the links to the dishes that follow it');

  /* A link resolves by id and, failing that, by NAME. A store whose menu came
     through the CSV import holds every dish under an id its own terminal
     minted, so id alone attaches nothing — measured exactly that way against a
     real outlet before this was written: 112 options landed and 0 links. */
  const SRC_P = fs.readFileSync(path.join(__dirname, '..', 'src', 'preset.js'), 'utf8');
  assert.ok(/byName/.test(SRC_P) && /itemResolver/.test(SRC_P),
    'the resolver matches on the name as well as the id');
  assert.ok(/byName\.has\(k\) \? null : r\.id/.test(SRC_P),
    'and a name this outlet holds twice resolves to NOBODY, never to one of them');

  // An unknown dish is dropped by the handler, not a refusal of the whole load.
  const APPLY = fs.readFileSync(path.join(__dirname, '..', 'src', 'apply.js'), 'utf8');
  assert.ok(/WHERE EXISTS \(SELECT 1 FROM item WHERE id = \$1\)/.test(APPLY),
    'item_modifier is guarded, so one deleted dish cannot abort the load');

  // The screen's gate is the shipped count, never a literal that would drift.
  assert.ok(/\(K\(\)\.PRESET \|\| \{\}\)\.addons/.test(SRC),
    'the add-ons screen reads what the catalogue actually holds');
  assert.ok(!/mods\.length < 112/.test(SRC), 'no hardcoded 112 decides the gate');
  assert.ok(/Load the pre-set add-ons/.test(SRC), 'and the door is on the add-ons screen');

  // The route takes the two parts and refuses anything else by name.
  const RT = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'outlet.js'), 'utf8');
  assert.ok(/part !== 'all' && part !== 'addons'/.test(RT),
    'an unknown part is refused rather than rounded down to the destructive one');
});

/* ── ACCEPTING A GUEST'S ROUND IS THE DECISION TO COOK IT ────────────────────
   The other half of "kitchen tab does not show portal orders". `ingestQr()`
   put the round's lines on the ticket UNFIRED and nothing ever fired them, so
   a round a guest sent from their own phone reached the counter and stopped:
   never on the Kitchen Display, and the guest's own tracker sitting on
   "Received" while the kitchen had never been told.

   A waiter's order is fired by a person because a person is still standing at
   the table taking it. A QR round is not — the guest pressed send, and the
   counter accepting it is the only decision left. */
test('a QR round is fired when it is accepted, not left off the pass', () => {
  const K = FX.kpos();
  const F = H.makeInstance({ kpos: K, raw: FX.raw(), real: FX.real() });
  const queued = [];
  F.__win.KPOS_SYNC = { enqueue: (op) => { queued.push(op); return op.opId; } };

  const dish = (K.MENU || [])[0];
  assert.ok(dish, 'the fixture has a menu');
  F.__win.KPOS_REAL = { state: { guestOrders: [{ id: 'g1', table: '9', at: Date.now(),
    lines: [{ id: dish.id, qty: 2 }] }], guestRequests: [] } };
  F.state.outletId = F.state.outletId || 1;

  F.ingestQr();

  const adds = queued.filter((x) => x.kind === 'add_line');
  assert.strictEqual(adds.length, 1, 'the round becomes a line on the outlet\'s ticket');
  const fire = queued.filter((x) => x.kind === 'fire_course');
  assert.strictEqual(fire.length, 1, 'AND IT IS FIRED — otherwise the pass never sees it');
  assert.ok(Array.isArray(fire[0].payload.lids) && fire[0].payload.lids.length === 1,
    'the fire names the lines the add_lines just created: '
    + JSON.stringify(fire[0].payload));
  assert.strictEqual(fire[0].payload.lids[0], adds[0].payload.lid,
    'by the SAME lid, or fire_course resolves nothing');

  /* Order is not negotiable: lamport order is queue order, so the fire has to
     be queued AFTER the lines it names or it resolves against a ticket that
     has none of them yet. */
  assert.ok(queued.indexOf(adds[0]) < queued.indexOf(fire[0]),
    'the lines are queued before the fire that names them');

  // And the local copy shows it as fired at once, so the pass is not waiting
  // on a round trip to draw the docket.
  const key = F.state.outletId + ':' + F.tableSlot('9');
  const tk = F.state.tickets[key];
  assert.ok(tk && tk.lines.length === 1 && tk.lines[0].fired,
    'the terminal draws it on the pass immediately: ' + JSON.stringify(tk && tk.lines));
});

/* ── A REFUSAL THE OUTLET CANNOT EXPLAIN REACHES THE OPERATOR'S LOG ──────────
   `flag_ack` compared a uuid column to text[] and raised
   `operator does not exist: uuid = text` on EVERY acknowledgement since it was
   written — and the process log said nothing at all. The customer reported it
   and the logs they were pointed at were empty.

   Data refusals stay silent on purpose: a foreign key or a trigger's own
   sentence belongs to the till that sent it, and one poison op retrying every
   five seconds would fill the log. SQLSTATE class 42 is the exception —
   undefined column, table, function or OPERATOR cannot be caused by data. It
   means the query this build sent cannot run against this schema, for anybody,
   for ever. */
test('an op that cannot run against the schema is a BUILD FAULT in the log', () => {
  const SY = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sync.js'), 'utf8');
  assert.ok(/BUILD FAULT/.test(SY), 'it is named as what it is');
  assert.ok(/indexOf\('42'\) === 0/.test(SY),
    'and fires on SQLSTATE class 42, which data can never cause');
  assert.ok(/BUILD_FAULTS\[mark\]/.test(SY),
    'once per kind per boot — the fault is the code, so the first is the finding');
  // It must carry what a person needs: which outlet, which op, and the words.
  const seg = SY.slice(SY.indexOf('BUILD FAULT'), SY.indexOf('BUILD FAULT') + 400);
  ['outlet ', 'op.kind', 'e.code', 'e.message'].forEach((k) =>
    assert.ok(seg.indexOf(k) >= 0, 'the line carries ' + k));
  // And an ordinary data refusal still says nothing, or one poison op fills it.
  assert.ok(!/console\.error[\s\S]{0,120}opSays/.test(SY),
    'a data refusal is answered to the till, not logged');
});

/* ── THE MINIMUM WAGE IS A BAND, AND THE BUSINESS SAYS WHICH ─────────────────
   Reported: "an employee could not be added. not showing."

   Two defects, one on top of the other.

   `rules()` returned `K().PAYROLL_RULES` raw — and there were TWO KEY SETS for
   the same facts. Migration 006 seeds `payroll_rules` with `otMultiplier`,
   `standardHours` and the pension percentages and NO minimum wage at all;
   every reader in the terminal asks for `week_hours`, `ot_weekday` and three
   `min_wage_*` bands. Not one key in common, on every install since the schema
   was written — the allergen-vocabulary defect one module over. So the three
   wage bands `kashikeyo-data.js` has always shipped were unreachable from any
   screen.

   And the hiring form read ONE of them, `min_wage_medium || 6000`, for every
   business. A small café paying a lawful MVR 5,000 could not add that employee
   at all: the sheet stayed open, no op was queued, and the only thing said was
   "Below the MVR 6000 sector minimum wage" — a band nobody had chosen. A large
   business had the mirror: 7,000 sailed through, below its own floor, silently. */
test('the wage floor is the business\'s own band, and unset is a real answer', () => {
  const BR = fs.readFileSync(path.join(__dirname, '..', 'app', 'kpos-bridge.js'), 'utf8');
  const DATA = fs.readFileSync(path.join(__dirname, '..', 'app', 'kashikeyo-data.js'), 'utf8');
  const BOOT = fs.readFileSync(path.join(__dirname, '..', 'src', 'bootstrap.js'), 'utf8');

  // All three bands ship, and the shipped table survives the bootstrap that
  // replaces the key — the same stash the guest bridge keeps for TIERS_SHIPPED.
  assert.ok(/min_wage_small:\s*4500/.test(DATA) && /min_wage_medium:\s*6000/.test(DATA)
    && /min_wage_large:\s*8000/.test(DATA), 'the statutory bands ship');
  assert.ok(/PAYROLL_RULES_SHIPPED\s*=\s*K\.PAYROLL_RULES/.test(BR),
    'and the bridge stashes them before the bootstrap replaces the key');
  assert.ok(/RULE_ALIAS/.test(SRC) && /otMultiplier:\s*"ot_weekday"/.test(SRC),
    'rules() normalises the outlet\'s vocabulary onto the shipped one');
  assert.ok(/PAYROLL_RULES_SHIPPED \|\| \{\}/.test(SRC),
    'and layers the outlet over the shipped table rather than replacing it');
  // `{}` is an opinion; undefined is "the server has no opinion".
  assert.ok(/PAYROLL_RULES: setting\.payroll_rules \|\| undefined/.test(BOOT),
    'an outlet with no row leaves the shipped structure standing');

  // The behaviour, on the shipped logic class.
  const K = FX.kpos();
  const F = H.makeInstance({ kpos: K, raw: FX.raw(), real: FX.real() });
  F.__win.KPOS.PAYROLL_RULES_SHIPPED = { min_wage_small: 4500,
    min_wage_medium: 6000, min_wage_large: 8000, week_hours: 48, ot_weekday: 1.25 };
  F.__win.KPOS.PAYROLL_RULES = { otMultiplier: 1.25, standardHours: 48 };

  const R = F.rules();
  assert.strictEqual(R.min_wage_small, 4500, 'the shipped band survives');
  assert.strictEqual(R.ot_weekday, 1.25, 'and the outlet\'s figure lands on the till\'s key');
  assert.strictEqual(R.week_hours, 48);

  // NO BAND SET — refuse only what is unlawful whichever band applies.
  F.state.prefs = {};
  assert.strictEqual(F.wageFloor().band, null, 'unset is a real answer');
  assert.ok(F.wageCheck(3000).refuse, 'below every floor is refused');
  assert.strictEqual(F.wageCheck(5000).refuse, null,
    'THE REPORTED CASE: a lawful small-business wage is not refused on a guess');
  assert.ok(F.wageCheck(5000).note,
    'it is noted instead, so nothing is silently unchecked');
  /* And the note is a NOTE, never a toast of its own: the save that follows
     toasts in the same tick and would overwrite it unseen. Measured — the
     first version of this fix did exactly that. */
  assert.ok(!/wageCheck[\s\S]{0,600}?this\.toast\([\s\S]{0,80}?size band/.test(SRC),
    'the warning rides on the one message the operator reads');

  // A BAND SET — that band's floor, in both directions.
  F.state.prefs = { wageBand: 'large' };
  assert.strictEqual(F.wageFloor().floor, 8000);
  assert.ok(F.wageCheck(7000).refuse, 'a large business is held to its own floor');
  assert.strictEqual(F.wageCheck(8000).refuse, null);
  F.state.prefs = { wageBand: 'small' };
  assert.strictEqual(F.wageCheck(5000).refuse, null,
    'and a small one is not held to somebody else\'s');
  assert.strictEqual(F.wageCheck(5000).note, null, 'with nothing left to note');

  // The band is a POLICY, so it travels — never a device preference.
  assert.ok(!/wageBand/.test(SRC.slice(SRC.indexOf('DEVICE_PREFS ='),
    SRC.indexOf('DEVICE_PREFS =') + 900)),
    'the band is not on the list of things that stay on one browser');
  assert.ok(/key: "wageBand", value: band/.test(SRC),
    'it goes out as a setting_change carrying its value');
  /* The literal that caused it must not come back. Matched on the two CALL
     forms it took, not the phrase — the paragraph above quotes it. */
  assert.ok(!/this\.rules\(\)\.min_wage_medium/.test(SRC)
    && !/\bR\.min_wage_medium/.test(SRC),
    'no screen reads the medium band as though it were every business\'s');
});

/* ── THE OFFER BANNER REACHES A REAL PHONE, AND THE SLOTS ARE GUIDED ─────────
   The banner strip used to be "published" into this browser's localStorage
   (kashikeyo.promos.v1), which only a portal sharing the machine could read —
   a real guest's phone saw nothing, ever, while the screen at the counter
   said what was live. And the banner form asked for an "Image path" defaulting
   to img/hero.jpg, a file that resolves to nothing on any phone. These pins
   hold the replacement road: rows through banner_upsert, filtered by the slot
   switch and the date window IN THE PROJECTION, rendered by both portals; and
   image slots that state their type and size and take a dropped file. */
test('banners ride the projection and the image slots are guided', () => {
  const file = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const outletR = file('src/routes/outlet.js');
  // The snapshot filters what a guest may see: live, in window, slot on.
  assert.ok(/banners: \['SELECT[^\]]*starts_on IS NULL OR starts_on <= current_date/.test(outletR),
    'the snapshot applies each banner\'s own date window');
  assert.ok(/bannerSlot: \["SELECT value FROM setting WHERE key = 'qrBanners'"\]/.test(outletR),
    'the snapshot reads the slot switch');
  assert.ok(outletR.indexOf("(q.bannerSlot.rows[0] || {}).value === true) ? q.banners.rows : []") > 0,
    'the slot OFF empties the strip on every phone, not only on the till');
  assert.ok(/outlet: \['SELECT[^\]]*brand[^\]]*FROM chain\.outlet/.test(outletR),
    'the snapshot carries the outlet\'s face');

  // The till: no typed image path, no localStorage publish, guided slots.
  assert.ok(SRC.indexOf('publishPromos') < 0,
    'the localStorage "publish" is gone — the projection is the road');
  assert.ok(SRC.indexOf('kashikeyo.promos.v1') < 0, 'and so is its key');
  assert.ok(SRC.indexOf('Image path') < 0,
    'no banner asks for a typed image path');
  const bannerSpec = SRC.slice(SRC.indexOf('banner: {'), SRC.indexOf('banner: {') + 2200);
  assert.ok(/k: "img", kind: "image"/.test(bannerSpec),
    'the banner image is a guided slot, not a text field');
  const brandSpec = SRC.slice(SRC.indexOf('portalBrand: {'), SRC.indexOf('portalBrand: {') + 2600);
  assert.ok(/k: "logo", kind: "image", label: "Store logo", mode: "png"/.test(brandSpec),
    'the logo slot keeps PNG — transparency is the point of the file');
  assert.ok(/320 × 320 px/.test(brandSpec) && /1200 × 640 px/.test(brandSpec),
    'each slot states its size on the holder');
  assert.ok(/this\.queue\("outlet_brand"/.test(SRC),
    'saving the branding queues the op the handler reads');
  assert.ok(typeof HANDLERS.outlet_brand === 'function', 'and the handler exists');

  // Both portals read the projection's banners, not a co-located till's state.
  const member = file('app/member.html');
  assert.ok(member.indexOf('kashikeyo.promos.v1') < 0,
    'the member card no longer reads a till\'s localStorage for offers');
  assert.ok(/\(this\.K\(\) \|\| \{\}\)\.BANNERS/.test(member),
    'it reads the projection\'s banners');
  const guest = file('app/guest.html');
  assert.ok(/bannersV = banners\.map/.test(guest) && /k\.BANNERS/.test(guest),
    'the guest QR menu renders the banner strip from the projection');
  assert.ok(/coverStyle = brand\.cover/.test(guest),
    'and wears the outlet\'s cover as its masthead');
  // A tap on a coded banner fills the same promo state the bill tab verifies.
  assert.ok(/promo: b\.code, promoOk: true/.test(guest),
    'tapping a coded banner fills the promo field');
  // The bridge hands the outlet's face to both portals.
  const bridge = file('app/guest-bridge.js');
  assert.ok(/logo: \(o\.brand \|\| \{\}\)\.logo/.test(bridge),
    'the bridge maps chain.outlet.brand onto the portals\' outlet record');
});

/* ── A LOCKED TERMINAL STAYS LOCKED THROUGH A RELOAD ──────────────────────────
   Reported: PIN-lock the till, refresh the browser — the lock disappears; a
   deployed update's reload did the same. adoptSession() exists so a tab that
   crashed mid-shift comes back without costing the floor a PIN, and it was
   also undoing a lock somebody CHOSE, because the lock decision itself was
   never persisted. These pins hold the fix: the lock is a persisted fact,
   adoption refuses while it stands, and only a keyed PIN clears it. */
test('the lock survives a reload, and only a PIN clears it', () => {
  const lock = SRC.slice(SRC.indexOf('lockTill() {'), SRC.indexOf('lockTill() {') + 700);
  assert.ok(/locked: true/.test(lock), 'lockTill persists the decision');
  const idle = SRC.slice(SRC.indexOf('checkIdle() {'), SRC.indexOf('checkIdle() {') + 900);
  assert.ok(/locked: true/.test(idle), 'the idle lock is the same persisted decision');
  const adopt = SRC.slice(SRC.indexOf('adoptSession() {'), SRC.indexOf('adoptSession() {') + 700);
  assert.ok(/if \(this\.state\.locked\) return false;/.test(adopt),
    'a locked terminal never adopts the token\'s session back');
  const signin = SRC.slice(SRC.indexOf('signIn(u) {'), SRC.indexOf('signIn(u) {') + 1600);
  assert.ok(/locked: false/.test(signin), 'a keyed PIN is what clears it');
  assert.ok(/locked: !!s\.locked/.test(SRC), 'and the mark rides the persisted session');
  assert.ok(/locked: !!this\._saved\.locked/.test(SRC), 'restored at boot');
});

/* The full log-out. Both doors — the signed-in sheet and the lock screen —
   go through one road: end the session on the outlet, clear this browser's
   cached till state, reload so the next login starts fresh. The rules that
   make that safe are exactly the ones a regression would drop silently. */
test('the full log-out: cleared, kept, gated, and recorded', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'app', 'kashikeyo-api.js'), 'utf8');
  const wl = api.slice(api.indexOf('async wipeLocal()'), api.indexOf('async wipeLocal()') + 1000);
  assert.ok(wl.includes('"kashikeyo.outlet"') && wl.includes('"kashikeyo.device"')
    && wl.includes('"kashikeyo.lamport"'),
    'the store identity, the pairing and the clock survive the wipe — a cleared '
    + 'terminal is still THIS store\'s terminal, and a clock never walks back');
  assert.ok(/if \(!owed\)/.test(wl),
    'the durable outbox is deleted only when it owes nothing — undelivered work is never destroyed');
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'app', 'kpos-bridge.js'), 'utf8');
  assert.ok(/wipeLocal: function/.test(bridge), 'the bridge exposes the wipe');

  // The lock screen's door: arming turns the NEXT keyed PIN into authority for
  // the sign-out, and the rank the SERVER issued decides.
  assert.ok(/if \(this\.state\.signOutIntent\) return this\.finishTerminalSignOut\(u\);/.test(SRC),
    'a PIN keyed while the intent is armed is authority for the sign-out, not a shift starting');
  const fin = SRC.slice(SRC.indexOf('finishTerminalSignOut(u) {'),
    SRC.indexOf('finishTerminalSignOut(u) {') + 1600);
  assert.ok(/\(u\.rank \|\| 0\) < 4/.test(fin), 'rank 4 or above, from the rank the server issued');
  assert.ok(/refused: /.test(fin), 'the refusal STANDS on the lock screen, not only in a toast');
  assert.ok(/queue\("sign_out",[\s\S]*?"sessions",\s*\{ note: /.test(fin),
    'the record carries a payload — an audit-only op records the payload, never the label');

  // Nothing persists after the wipe, and the reload is the point.
  const ws = SRC.slice(SRC.indexOf('writeSession() {'), SRC.indexOf('writeSession() {') + 500);
  assert.ok(/if \(this\._wiped\) return;/.test(ws),
    'after the wipe nothing persists — the sign-out\'s own toast must not re-create the blob');
  const t = SRC.slice(SRC.indexOf('terminalSignOut() {'), SRC.indexOf('terminalSignOut() {') + 3200);
  assert.ok(/this\._wiped = true/.test(t), 'the wipe turns persistence off one-way');
  /* AND IT LANDS ON THE LOGIN PAGE. Reloading /pos put the operator back on
     the staff PIN keypad — the screen a HANDOVER leaves them on — so the
     control that ends the session looked exactly like the one that keeps it.
     Reported as "when signed out of terminal, it stays in the pin login". */
  assert.ok(/location\.replace\("\/account\?signedout=1"\)/.test(t),
    'signing out of the application lands where signing in begins');
  const acct = fs.readFileSync(path.join(__dirname, '..', 'app', 'account.html'), 'utf8');
  assert.ok(/signedout=1\\b\/\.test\(location\.search\)/.test(acct),
    '/account knows the sign-out errand');
  assert.ok(/\(forStore \|\| signedOut\) \? "signin" : "signup"/.test(acct),
    'and opens on Sign in — following Create account there makes a second business');
  assert.ok(/signedOut \? "Signed out"/.test(acct), 'the heading says what happened');
  assert.ok(/signedOut && knowsStore && !code/.test(acct),
    'a cashier is not stranded behind an account password: the way back to the '
    + 'till shows where this browser still knows its store');
  assert.ok(/B\.flush/.test(t) && /B\.signOut/.test(t),
    'the sign_out op gets a bounded drain BEFORE the token it needs is dropped');
});

/* ═══ THE TYPE DECIDES THE DESIGN ═══════════════════════════════════════════
   A menu section's glyph and hue are classified from its NAME — a curry
   section is the bowl in curry maroon, a cold-drinks rail the glass in
   teal-cyan — on the till, the guest QR menu and the member card alike. The
   classifier is the DEFAULT: an icon or colour a person picked always wins,
   and an unpicked one is stored as NOTHING so a rename re-classifies. The
   pre-set menu ships classification-owned rows, and migration 049 resets
   exactly the machine-written values existing outlets carry. */
test('the section type decides the glyph and the hue, everywhere at once', () => {
  const vm = require('node:vm');
  const ctx = { window: {}, Event: function Event() {}, dispatchEvent: () => {} };
  ctx.window.dispatchEvent = () => {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app', 'kashikeyo-data.js'), 'utf8'), ctx);
  const k = ctx.window.KPOS;
  ['curry', 'breakfast', 'burger', 'noodles', 'juice'].forEach((key) => {
    assert.ok(k.SECTION_GLYPHS[key], 'the ' + key + ' glyph exists');
    assert.ok(k.SECTION_ART[key], 'and carries its own hue');
  });
  // The canonical pre-set sections classify to their kinds.
  const want = {
    'Mains & Curries': 'curry', 'Breakfast & Maldivian Specialties': 'breakfast',
    'Pizza, Burgers & Pasta': 'burger', 'Cold Beverages': 'juice',
    'Coffee & Tea': 'coffee', 'Short Eats & Snacks': 'starter',
    'Rice & Noodles': 'noodles', 'Desserts & Sweets': 'dessert',
    'Sides & Add-ons': 'side', 'Seafood Specials': 'seafood'
  };
  Object.keys(want).forEach((name) => {
    const art = k.sectionArt(name);
    assert.strictEqual(art.icon, want[name], name + ' classifies to ' + want[name]);
    assert.strictEqual(art.hue, k.SECTION_ART[want[name]], 'and wears that kind\'s hue');
  });
  assert.strictEqual(k.glyphFor('Mains & Curries'), 'curry',
    'glyphFor is the classification\'s icon half — one vocabulary, not two');
  assert.notStrictEqual(k.sectionArt('Cold Beverages').hue, k.sectionArt('Mains & Curries').hue,
    'drinks and curries are different colours by TYPE, not by position');

  // The till classifies where nothing was chosen…
  assert.ok(/const art = \(K\(\) \|\| \{\}\)\.sectionArt;/.test(SRC),
    'catHue falls through to the type before the index palette');
  assert.ok(/icon: K0\.sectionArt \? K0\.sectionArt\(base\.name \|\| id\)\.icon : "main"/.test(SRC),
    'and catMeta\'s default glyph is the type, not generic cutlery');
  // …and never bakes the guess into a row.
  assert.ok(/color: c\.color \|\| null, icon: c\.icon \|\| null/.test(SRC),
    'the section editor stores an unpicked icon or colour as NOTHING');
  assert.ok(/const meta = \{ id: key, name: name, icon: null, color: null,/.test(SRC),
    'ensureSection sends no icon and no colour of its own');

  // Both portals: a published choice wins, then the type — the same rule.
  ['guest.html', 'member.html'].forEach((f) => {
    const P = fs.readFileSync(path.join(__dirname, '..', 'app', f), 'utf8');
    assert.ok(/k\.sectionArt\(c \? c\.name : ""\)\.hue/.test(P), f + ' hue classifies by type');
    assert.ok(/c\.icon && g\[c\.icon\]/.test(P), f + ' honours a published glyph');
  });
  // The snapshot publishes the choice — and only a REAL colour: a till theme
  // token (`var(--cat-…)`) means nothing on a phone.
  const outletSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'outlet.js'), 'utf8');
  assert.ok(/CASE WHEN colour LIKE '#%' THEN colour END/.test(outletSrc),
    'a non-hex colour never reaches a phone');
  // And the guest bridge passes it through: its old literal `icon: "main"`
  // stamped cutlery onto every section, which made the classification
  // unreachable on a phone however right everything upstream was.
  const gb = fs.readFileSync(path.join(__dirname, '..', 'app', 'guest-bridge.js'), 'utf8');
  assert.ok(/icon: c\.icon \|\| null, colour: c\.colour \|\| null/.test(gb),
    'the bridge carries the published icon and colour, and invents neither');
  assert.ok(!/return \{ id: c\.id, name: c\.name, icon: "main" \}/.test(gb),
    'no hardcoded glyph in the bridge');

  // The pre-set ships classification-owned sections, and 049 repairs exactly
  // what the extraction wrote on existing outlets — never a person's pick.
  const preset = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'preset-menu.json'), 'utf8'));
  preset.sections.forEach((s) => {
    assert.strictEqual(s.icon, null, s.id + ' ships no baked icon');
    assert.strictEqual(s.colour, null, s.id + ' ships no baked colour');
  });
  const mig = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations', '049_a_section_wears_its_kind.sql'), 'utf8');
  assert.ok(/\('breakfast','salad'\)/.test(mig.replace(/''/g, "'")),
    'the breakfast-wearing-the-salad-glyph row is repaired by exact match');
  assert.ok(/var\(--cat-mains\)/.test(mig), 'and the theme token leaves the colour column');
});

/* ═══ THE STORE'S LOGO IS ON THE RECEIPT, AND THE PAPER SETTING IS REAL ═════
   The uploaded logo (Store branding) reaches every receipt surface — the
   on-screen papers, the printed paper as a GS v 0 raster, the shared /r/
   page, the sign-in screen — from ONE upload. And prefs().paper, collected
   since the printers screen existed and read by nothing, now decides the
   columns: 80mm = 48, 58mm = 32, with a per-printer override. */
test('the store logo reaches every receipt, and 58/80mm decides the columns', () => {
  // The raster is derived once, at publish, into the same outlet_brand op.
  assert.ok(/rasterPrintLogo\(v\.logo \|\| null\)\.then/.test(SRC),
    'publishing the logo derives the print raster in the same act');
  assert.ok(/printLogo: v\.logo \? printLogo : null/.test(SRC),
    'removing the logo removes the raster with it');
  const ras = SRC.slice(SRC.indexOf('rasterPrintLogo(dataUrl) {'),
    SRC.indexOf('rasterPrintLogo(dataUrl) {') + 2200);
  assert.ok(/Math\.min\(360,/.test(ras), 'capped at 360 dots — fits a 58mm head (384)');
  assert.ok(/fillStyle = "#ffffff"/.test(ras),
    'alpha composited onto WHITE first — raw transparency prints as ink');

  // The server accepts only a bitmap this build composed, bounded.
  const apply = fs.readFileSync(path.join(__dirname, '..', 'src', 'apply.js'), 'utf8');
  assert.ok(/w > 0 && w <= 384 && h > 0 && h <= 240/.test(apply),
    'outlet_brand bounds the raster');
  assert.ok(/Buffer\.from\(data, 'base64'\)\.length === Math\.ceil\(w \/ 8\) \* h/.test(apply),
    'and the payload must be exactly the rows it claims');
  const boot = fs.readFileSync(path.join(__dirname, '..', 'src', 'bootstrap.js'), 'utf8');
  assert.ok(/printLogo: \(r\.brand \|\| \{\}\)\.printLogo \|\| null/.test(boot),
    'the bootstrap publishes it to the signed-in outlet');

  // The print path: receipts carry it, dockets skip it, and paper → columns.
  const pd = SRC.slice(SRC.indexOf('printDoc(job) {'), SRC.indexOf('printDoc(job) {') + 1200);
  assert.ok(/job\.target === "receipt" \? \(this\.brandOf\(\)\.printLogo \|\| null\) : null/.test(pd),
    'the logo prints on receipts and never on a KOT');
  assert.ok(/cfg\.cols \|\| \(Number\(this\.prefs\(\)\.paper\) === 58 \? 32 : 48\)/.test(SRC),
    'prefs().paper decides the columns — 58mm is 32, the 80mm POS roll default is 48');
  const esc = fs.readFileSync(path.join(__dirname, '..', 'app', 'kashikeyo-escpos.js'), 'utf8');
  assert.ok(/image\(w, h, dataB64\)/.test(esc) && /GS, 0x76, 0x30, 0x00/.test(esc),
    'the composer speaks GS v 0');
  assert.ok(/this module never rasterises/.test(esc),
    'and never rasterises — one bitmap, both runtimes, identical bytes');

  // On screen: the uploaded logo leads; the free-text path is only a fallback.
  assert.ok(/const mark = \(b\.logo \? this\.photoUrl\(b\.logo\) : ""\)\s*\n?\s*\|\| \(b\.mark \? this\.photoUrl\(b\.mark\) : ""\)\s*\n?\s*\|\| "brand\/kashikeyo-mark\.png"/.test(SRC),
    'the receipt papers wear the uploaded logo first, the mark through the blob seam behind it');
  assert.ok(/lockLogoStyle/.test(SRC), 'and the sign-in screen leads with it');

  // The shared /r/ page: vetted server-side, rendered as an <img>.
  const doc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'doc.js'), 'utf8');
  assert.ok(/\^data:image\\\//.test(doc), 'only an image data URL travels to a stranger');
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'doc.html'), 'utf8');
  assert.ok(/d\.logo && \/\^data:image\\\/\/\.test\(d\.logo\)/.test(page),
    'and the page checks again before rendering it');
});

/* ═══ AN UPLOAD, NEVER A TYPED PATH ═════════════════════════════════════════
   Two controls asked for an address nobody has: Merchant branding's "Logo
   file" path (a customer cannot put a file on this server) and the employee
   "Photo URL" (the page's own CSP refuses a foreign address, and a pasted
   data URL dies on the inline-style semicolon). Both are image slots now,
   both render through the blob seam — and the photograph actually TRAVELS:
   it had no column, no place in the op, and the bootstrap published a
   literal '' that wiped a browser's copy on every hydrate. */
test('no control asks for a typed file path or URL, and the photo travels', () => {
  assert.ok(SRC.indexOf('Photo URL') < 0, 'the employee photograph is an upload');
  assert.ok(SRC.indexOf('Logo file path') < 0, 'and so is the chain receipt logo');
  assert.ok(/\{ k: "mark", kind: "image"/.test(SRC), 'the mark is an image slot');
  assert.ok(/\{ k: "photo", kind: "image"/.test(SRC), 'the photograph is an image slot');
  assert.ok(/b\.mark \? this\.photoUrl\(b\.mark\)/.test(SRC),
    'the receipt paper renders the mark through the blob seam');
  assert.ok(/this\.photoUrl\(st\.photo\)/.test(SRC),
    'and the avatar renders the photo through it');
  assert.ok(/photo: r\.photo \|\| null, sex: r\.sex \|\| null/.test(SRC),
    'the employee op carries the photo and the silhouette gender');
  const apply = fs.readFileSync(path.join(__dirname, '..', 'src', 'apply.js'), 'utf8');
  assert.ok(/photo = coalesce\(excluded\.photo, employee\.photo\)/.test(apply),
    'silence preserves — an older build\'s op cannot strip a photo');
  assert.ok(/that photograph is too large/.test(apply)
    && /that logo is too large/.test(apply.slice(apply.indexOf('H.brand_update'))),
    'oversize images are refused by name on both ops');
  const boot = fs.readFileSync(path.join(__dirname, '..', 'src', 'bootstrap.js'), 'utf8');
  assert.ok(/photo: r\.photo \|\| ''/.test(boot),
    'and the bootstrap publishes the row\'s own photo, not a literal blank');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'migrations', '050_a_person_has_a_face.sql')),
    'migration 050 gives it the column');
  assert.ok(/photo     text/.test(fs.readFileSync(
    path.join(__dirname, '..', 'src', 'migrations', '003_outlet_provision.sql'), 'utf8')),
    'and a brand-new outlet is born with it');
});

/* ═══ THE COUNTER CAN DRESS A DISH ══════════════════════════════════════════
   The guest's phone has offered add-ons since the portals were built; the
   TILL never did — `addonsFor()` was called only by the add-ons admin screen,
   a Menu Master count and the CSV export, never by the ordering path. So a
   guest ordering extra cheese from the table got it and one asking the person
   at the counter did not. The till gets the prototype's own sheet: the dish's
   add-ons as a flat list with a quantity each. */
test('choosing a dish at the till shows its add-ons, and the money follows', () => {
  assert.ok(/if \(this\.addonsFor\(m\)\.length\) return this\.openAddons\(m\.id\);/.test(SRC),
    'a dish the shop dresses opens the sheet when it is chosen');
  assert.ok(/openAddons\(id\) \{/.test(SRC), 'the sheet has an opener');
  assert.ok(/m\.kind === "dishadd"/.test(SRC), 'and a body');
  const sheet = SRC.slice(SRC.indexOf('if (m.kind === "dishadd")'),
    SRC.indexOf('if (m.kind === "dishadd")') + 3000);
  assert.ok(/Make it yours/.test(SRC), 'wearing the portal\'s own heading');
  assert.ok(/picks\[x\.id\] \|\| 0\) \* \(\+x\.price \|\| 0\)/.test(sheet),
    'a quantity each, priced — two extra shots are one line, not two');
  assert.ok(/daAddLabel: "Add · " \+ MVRc\(\(base \+ extra\) \* qty\)/.test(sheet),
    'and the button says what the line will cost');

  /* ONE DEFINITION OF WHAT A LINE COSTS, and it closed a money defect that
     was already live: the QR round's op carried menuPrice + addons to the
     outlet while the till's own subtotal added up menuPrice alone — and the
     pay screen takes money on the till's figure. */
  assert.ok(/linePrice\(l\) \{/.test(SRC), 'linePrice is the one definition');
  assert.ok(/\(m \? this\.menuPrice\(m\) : 0\) \+ \(\+\(l \|\| \{\}\)\.extra \|\| 0\)/.test(SRC),
    'menu price plus what was chosen on THAT line');
  assert.ok(!/menuPrice\(mi\) \* l\.qty/.test(SRC) && !/menuPrice\(m\) \* l\.qty/.test(SRC),
    'and no renderer prices a line any other way');
  assert.ok(/extra: \+ql\.addons \|\| 0/.test(SRC),
    'the accepted guest round stamps it on the LINE, not only in the op');

  // The two halves land where they already land for a phone order.
  const al = SRC.slice(SRC.indexOf('addLine(m, qtyIn, opts) {'),
    SRC.indexOf('addLine(m, qtyIn, opts) {') + 2600);
  assert.ok(/price: this\.menuPrice\(m\) \+ extra/.test(al),
    'the op carries the add-ons\' money on the price');
  assert.ok(/&& \(\+l\.extra \|\| 0\) === extra && String\(l\.note \|\| ""\) === note/.test(al),
    'a dressed line is never merged into a plain one');
});

/* ═══ A GRANT IS A DECISION, SO THE DEFAULT MUST BE THE SAFEST ONE ══════════
   Reported as "I cannot add staffs", and the sweep of everything around staff
   found three faults. This is the one that would have been worst to leave.

   `openForm` seeds a select with its FIRST option, and `assignableRoles()`
   returned `K().ROLES` in shipped order — which leads with SuperAdmin. So the
   Role box on "Add someone to the floor" came up reading **Owner**, and adding
   a waiter without touching that dropdown made a second RANK 5 account: the
   estate read, GST registration, the store rename and the trade reset, handed
   out by a control whose entire subject is who reaches what. Measured on a
   live outlet at both a desktop and a phone viewport before this was written:
   `select.value === "SuperAdmin"`, and the account it created came back
   `rank 5`.

   The list is ordered by REACH now, least first, so the default costs least if
   nobody thinks about it and the strongest role is the one somebody has to
   reach for. */
test('the role a new account gets by default is the safest one, not the strongest', () => {
  const H = require('./harness');
  [['SuperAdmin', 5], ['ChainAdmin', 4]].forEach(([who]) => {
    const F = H.makeInstance({ role: who });
    const roles = F.assignableRoles();
    assert.ok(roles.length > 1, who + ' can grant more than one role');

    const ranks = roles.map((r) => F.rankOf(r.key));
    const sorted = ranks.slice().sort((a, b) => a - b);
    assert.deepStrictEqual(ranks, sorted,
      'assignableRoles() must be ordered from the least reach upward, because'
      + ' openForm seeds a select with its FIRST option — ' + who + ' sees '
      + roles.map((r) => r.key).join(', '));

    assert.notStrictEqual(roles[0].key, 'SuperAdmin',
      'the Role box would open on Owner, so "add a waiter" creates a rank-5'
      + ' account for ' + who);
    assert.ok(F.rankFor(roles[0].key) <= 2,
      'the default grant is a floor rung, not a management one: '
      + roles[0].key + ' is rank ' + F.rankFor(roles[0].key));

    /* And nobody may hand out more reach than they hold — unchanged, and
       asserted here because the reorder moved every index in this list. */
    roles.forEach((r) => assert.ok(F.rankOf(r.key) <= F.rankOf(who),
      who + ' must not be offered ' + r.key));
  });

  /* THE RANK RIDES ON THE LABEL, because the rank is what the server actually
     enforces and "Owner · rank 5" is a sentence somebody reads before they
     hand it over. */
  assert.match(SRC, /l: r\.label \+ " · rank " \+ this\.rankFor\(r\.key\)/,
    'the role options name the rank they grant');
});

/* ═══ AND THE ADD PATH NAMES THE FIELD THAT IS MISSING ══════════════════════
   `onEdit` asked for a basic salary by name; the ADD path did not, so a form
   left on its default 0 fell through to the minimum-wage check and came back
   "Below the MVR 8,000 minimum wage" — which sends an operator to the Act, to
   the business size band and to the wrong screen, when what is actually wrong
   is that they have not typed a wage yet. Same defect class as a refusal that
   names a constraint instead of a cause. */
test('adding an employee with no salary says so, rather than citing the minimum wage', () => {
  assert.match(SRC, /A basic salary is required — it is the pensionable wage/,
    'the add path asks for the salary by name');
  const add = SRC.indexOf('A basic salary is required — it is the pensionable wage');
  const wage = SRC.indexOf('const W = this.wageCheck(basic);', add);
  assert.ok(add > 0 && wage > add,
    'and it asks BEFORE the wage check, or the wrong cause is still reported');
});

/* ═══ THE BOUGHT-IN FORM HAS A WAY THROUGH ══════════════════════════════════
   Reported as "bought in from a supplier form isn't working", and on a store
   with a stocked item master it worked exactly as designed — which is why the
   sweep went looking at the state a NEW store is in. `provisionOutlet()`
   creates no ingredients, and the eight bought-in trays only arrive with the
   pre-set catalogue, so an ordinary new customer opening that block saw:

     · a "Stock item sold" dropdown holding one entry — its own placeholder;
     · a status line reading "Pick the item the storekeeper receives", which is
       an instruction pointing at nothing;
     · and Create dish refused with "Pick the stock item this dish is sold
       from" — an instruction that cannot be followed from the form giving it.

   A dead end, and the same one `ensureSection()` closed a link along: the dish
   editor defaulted its SECTION to a row nobody had created and every dish on a
   brand-new store was refused by `item_category_id_fkey` for ever.
   `item.buy_item` references `ingredient.id`, so the failure and the fix are
   the same shape — make the row real, through the one seam, BEFORE the dish is
   queued. */
test('a bought-in dish can be created on a store with no item master', () => {
  const H = require('./harness');
  const F = H.makeInstance({ role: 'SuperAdmin' });
  assert.strictEqual(((F.__win.KPOS_RAW || {}).items || []).length, 0,
    'this instance is the empty store the test is about');

  const m = { kind: 'dishb', d: { name: 'GULHA', price: 5, cat: 'mains',
    buy: { item: '', vendor: '', pack: 24 } } };
  F.state.modal = m;
  const v = F.modalVals(m);

  /* THE WAY THROUGH IS IN THE LIST, not behind a trip to another screen. */
  const opts = v.dbBuyItemOpts || [];
  assert.ok(opts.some((o) => /New stock item/i.test(o.l)),
    'the dropdown offers to make one: ' + JSON.stringify(opts.map((o) => o.l)));

  /* AND THE LINE SAYS WHAT IS TRUE, rather than pointing at an empty list. */
  assert.match(v.dbBuyLine, /no stock items yet/i,
    'an empty item master is named: ' + v.dbBuyLine);

  const sentinel = (opts.find((o) => /New stock item/i.test(o.l)) || {}).v;
  v.onDbBuyItem({ target: { value: sentinel } });
  const w = F.modalVals(F.state.modal);
  assert.match(w.dbBuyLine, /Saving creates GULHA/,
    'and once chosen it says what saving will do: ' + w.dbBuyLine);
  assert.ok(w.dbBuyLineStyle.indexOf('warn') < 0,
    'in the ordinary ink — a decision already made is not a warning');

  /* THE ORDER IS NOT NEGOTIABLE. A push is applied in queue order, so the
     ingredient has to carry the lower lamport or the dish naming it is
     refused by its foreign key exactly as a dish naming an absent section
     was. */
  const ops = [];
  F.queue = (kind, label, ent, payload) => ops.push({ kind: kind, payload: payload });
  w.dbSave();
  const kinds = ops.map((o) => o.kind);
  assert.ok(kinds.indexOf('item_upsert') >= 0, 'the stock item is written: ' + kinds);
  assert.ok(kinds.indexOf('dish_upsert') >= 0, 'and the dish: ' + kinds);
  assert.ok(kinds.indexOf('item_upsert') < kinds.indexOf('dish_upsert'),
    'and the ingredient is queued FIRST, or item.buy_item refuses the dish: ' + kinds);

  const item = ops.find((o) => o.kind === 'item_upsert');
  const dish = ops.find((o) => o.kind === 'dish_upsert');
  assert.strictEqual(dish.payload.buy.item, item.payload.id,
    'the dish is linked to the ingredient that was just made');
  assert.strictEqual(dish.payload.buy.pack, 24, 'and the pack survives');
  /* Counted, costed and sold in ONE unit — 048's rule for a bought-in tray.
     The dish's own pack does the sellable conversion. */
  assert.strictEqual(item.payload.base, 'pcs');
  assert.strictEqual(item.payload.stock, 'pcs');
  assert.strictEqual(item.payload.factor, 1);
  assert.match(String(item.payload.id), /^i/,
    'minted by newId(), never counted — two devices adding a tray on one'
    + ' evening minting the same ingredient id re-points every recipe and every'
    + ' stock movement at a different ingredient');
});

/* AND A STORE THAT ALREADY HAS AN ITEM MASTER IS UNTOUCHED: picking a real
   row still links to it and creates nothing. The offer is additive. */
test('picking an existing stock item creates no second one', () => {
  const H = require('./harness');
  const F = H.makeInstance({ role: 'SuperAdmin' });
  F.__win.KPOS_RAW.items = [['IT-1', '', 'GULHA (VENDOR)', 'pcs', 3, 'raw',
    'IT-1', 'pcs', 'pcs', '3', null, null, 0, null, null]];
  const m = { kind: 'dishb', d: { name: 'GULHA', price: 5, cat: 'mains',
    buy: { item: 'IT-1', vendor: '', pack: 24 } } };
  F.state.modal = m;
  const v = F.modalVals(m);
  const ops = [];
  F.queue = (kind, label, ent, payload) => ops.push({ kind: kind, payload: payload });
  v.dbSave();
  assert.ok(!ops.some((o) => o.kind === 'item_upsert'),
    'nothing was created: ' + ops.map((o) => o.kind));
  const dish = ops.find((o) => o.kind === 'dish_upsert');
  assert.strictEqual(dish.payload.buy.item, 'IT-1', 'and the link is the row that was picked');
});

/* ═══ A DEFAULT IN THE VALUE IS A FIELD THAT CANNOT BE CLEARED ══════════════
   Reported as "units per pack is not editable". `dbBuyPack` read
   `String(pack || 1)`, and an empty string is falsy — so deleting the last
   digit rendered "1" straight back and the deletion was undone. Measured in a
   browser on the shipped build:

     starting value      "1"
     after one Backspace "1"     ← the deletion was undone
     after typing "24"   "124"   ← silently the wrong pack

   Only select-all-then-type ever worked, which is not how anyone edits a
   one-character box. And it is the one field CLAUDE.md already names as the
   one most tills forget: the supplier delivers a box, the guest buys a piece,
   and a wrong pack makes the shelf count wrong from the first delivery.

   The default belongs at the SAVE and at the derived figures, which all clamp
   with `Math.max(1, +pack || 1)` — never in the value the box renders. Sibling
   `dbPrice` had this right all along (`d.price || ""`), which is what made the
   odd one out findable in a sweep of all 100 bound inputs. */
test('units per pack can be cleared and retyped', () => {
  const H = require('./harness');
  const F = H.makeInstance({ role: 'SuperAdmin' });
  const m = { kind: 'dishb', d: { name: 'GULHA', price: 5, cat: 'mains',
    buy: { item: 'IT-1', vendor: '', pack: 1 } } };
  F.state.modal = m;

  assert.strictEqual(F.modalVals(m).dbBuyPack, '1', 'it renders what is held');

  /* THE KEYSTROKE THAT WAS UNDONE. Deleting the only digit leaves an empty
     box, and the next render must agree — or the operator types their number
     onto a "1" that came back. */
  F.modalVals(F.state.modal).onDbBuyPack({ target: { value: '' } });
  assert.strictEqual(F.modalVals(F.state.modal).dbBuyPack, '',
    'an emptied box stays empty; "1" here is the deletion being undone, and'
    + ' the next digits typed land on it');

  F.modalVals(F.state.modal).onDbBuyPack({ target: { value: '24' } });
  assert.strictEqual(F.modalVals(F.state.modal).dbBuyPack, '24');

  /* AND THE DEFAULT IS STILL THERE, where it belongs: an empty box saves as
     one unit per pack rather than as nothing. */
  F.modalVals(F.state.modal).onDbBuyPack({ target: { value: '' } });
  const ops = [];
  F.queue = (kind, label, ent, payload) => ops.push({ kind: kind, payload: payload });
  F.modalVals(F.state.modal).dbSave();
  const dish = ops.find((o) => o.kind === 'dish_upsert');
  assert.strictEqual(dish.payload.buy.pack, 1,
    'an empty box is one unit per pack at the save: ' + JSON.stringify(dish.payload.buy));

  /* And the box says so, so clearing it is a choice rather than a surprise. */
  assert.match(SRC, /aria-label="Units per pack"/);
  const tag = SRC.slice(SRC.indexOf('value="{{ dbBuyPack }}"'),
    SRC.indexOf('value="{{ dbBuyPack }}"') + 400);
  assert.match(tag, /placeholder="1"/,
    'the empty box states what it will be taken as');

  /* THE SHAPE ITSELF IS BANNED, because this is a class rather than a typo:
     the value a text input renders must never carry a non-empty default. */
  assert.ok(!/dbBuyPack: String\([^)]*\|\| *1\)/.test(SRC),
    'the default is back in the rendered value, and the field cannot be cleared again');
});

/* ═══ AN INVITATION THAT LEAVES THE COUNTER SOMETHING TO HAND OVER ═════════
   Reported as "customer invitations do not work — email, WhatsApp and Viber",
   and the SEND was never the broken half: the outlet answered 200 and minted
   a token on all three. What followed was `this.info(...)` immediately
   undone by `this.setState({ modal: null })` — the line meant to close the
   form, written without noticing that info() had already replaced the form
   with the result. Press Send, screen closes, nothing to give the guest.

   Both halves are pinned here because both are invisible from the server:
   the result must SURVIVE the tick that created it, and it must be tappable,
   since a `wa.me` URL rendered as right-aligned text is not a way to open
   WhatsApp. */
test('a sent invitation leaves a result on screen, and it can be acted on', async () => {
  const H = require('./harness');
  const INVITE = require('../app/kashikeyo-invite.js');

  for (const chan of ['email', 'whatsapp', 'viber']) {
    const F = H.makeInstance({ role: 'SuperAdmin' });
    const cust = { id: 'm1', name: 'Hassan Moosa', phone: '+960 7793216',
      email: 'hassan@example.mv' };
    const body = 'Loy Cafe here, Hassan — open it here: https://x.test/join/MV-aaa-1';
    let asked = null;
    F.__win.KPOS_BRIDGE = {
      inviteMember: (id, via, to) => {
        asked = { id: id, via: via, to: to };
        return Promise.resolve({
          member: cust, link: 'https://x.test/join/MV-aaa-1', body: body,
          days: 7, count: 2, via: via, channel: via, to: to,
          handoff: INVITE.handoff(via, cust.phone, body),
          sent: false, reason: 'No email transport is configured on this install'
        });
      },
      refresh: () => {}
    };

    await F.sendInvite(cust, chan);

    assert.strictEqual(asked.via, chan, chan + ': the channel reaches the outlet');
    const m = F.state.modal;
    /* THE WHOLE DEFECT, IN ONE ASSERTION. */
    assert.ok(m, chan + ': the result is still on screen — a null modal here is'
      + ' the send closing the screen and handing the counter nothing');
    assert.ok(Array.isArray(m.acts) && m.acts.length,
      chan + ': and it carries actions, not right-aligned text');

    const labels = m.acts.map((a) => a.label);
    assert.ok(labels.some((l) => /Copy the link/.test(l)),
      chan + ': the link can be copied — ' + JSON.stringify(labels));
    assert.ok(labels.some((l) => /Copy the message/.test(l)),
      chan + ': and so can the message');

    if (chan === 'email') {
      assert.ok(!labels.some((l) => /^Open /.test(l)),
        'email opens no messaging app');
      /* NOT SENT IS NEITHER A FAILURE NOR A SUCCESS, and the destroyed modal
         was swallowing a mail transport's own refusal along with everything
         else. */
      assert.match(m.title, /Not sent/, 'and an unsent email says so plainly');
      assert.match(m.sub, /No email transport/, 'with the reason, which is the install\'s');
    } else {
      const app = chan === 'viber' ? 'Viber' : 'WhatsApp';
      const open = m.acts.find((a) => /^Open /.test(a.label));
      assert.ok(open, chan + ': the one delivery this channel can make is offered');
      assert.match(open.label, new RegExp(app));
      assert.match(m.title, new RegExp(app + ' is ready'));
      // and tapping it is a real act, not a label
      let went = null;
      F.__win.open = (u) => { went = u; return {}; };
      open.go();
      assert.ok(went, chan + ': tapping it opens the app');
      assert.ok(went.indexOf('join') > -1 || decodeURIComponent(went).indexOf('join') > -1,
        chan + ': carrying the invitation, not an empty compose window');
    }
  }
});

/* VIBER HAD NO HANDOFF AT ALL, which is why the channel was named in the
   report. `kashikeyo-share.js` has composed `viber://forward?text=` for a
   RECEIPT since it was written — so a cashier could send a bill on Viber and
   not an invitation, from a list offering both. One definition now, in the
   module both runtimes read. */
test('both messaging channels have a handoff, and it is one definition', () => {
  const INVITE = require('../app/kashikeyo-invite.js');
  const body = 'hello https://x.test/join/MV-aaa-1';

  assert.match(INVITE.handoff('whatsapp', '+960 779 3216', body),
    /^https:\/\/wa\.me\/9607793216\?text=/, 'WhatsApp click-to-chat, digits only');
  assert.match(INVITE.handoff('viber', '+960 7793216', body),
    /^viber:\/\/forward\?text=/, 'and Viber, which had nothing at all');
  assert.strictEqual(INVITE.handoff('email', '7793216', body), '',
    'email is a transport, not a handoff');

  // The message rides inside both, or the app opens on an empty compose box.
  ['whatsapp', 'viber'].forEach((c) => {
    assert.ok(decodeURIComponent(INVITE.handoff(c, '7793216', body)).indexOf(body) > -1,
      c + ' carries the whole message');
  });

  /* ONE SPELLING. whatsappHandoff is the name the rest of the build calls;
     a second wa.me composer under it is how two links drift apart. */
  assert.strictEqual(INVITE.whatsappHandoff('+960 7793216', body),
    INVITE.handoff('whatsapp', '+960 7793216', body));

  /* And the door hands back whichever the channel has, rather than testing
     for one channel by name. */
  const OUT = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'outlet.js'), 'utf8');
  assert.ok(!/handoff:\s*via === 'whatsapp'/.test(OUT),
    'the invite answer no longer serves one channel and drops the other');
  assert.match(OUT, /handoff:\s*INVITE\.handoff\(via,/);
});

/* THE SHAPE ITSELF, because this is the third time this build has paid for
   it: the share sheet that threw the receipt away, the wage-band warning
   overwritten by a success toast, and now an invitation. Composing a result
   and then clearing the modal in the same tick is never right. */
test('nothing composes a result and then clears the modal in the same tick', () => {
  const i = SRC.indexOf('inviteResult(c, ch, r, to) {');
  assert.ok(i > 0, 'the invitation result has a seam of its own');
  /* Block comments come out first. The comment above `inviteResult` QUOTES the
     line being banned, because a defect worth a fence is worth explaining —
     and a check that cannot tell code from the prose about it would fail on
     its own documentation. */
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

  const fn = code(SRC.slice(i, SRC.indexOf('\n  openHandoff(url)', i)));
  assert.ok(!/setState\(\{\s*modal:\s*null\s*\}\)/.test(fn),
    'the result must not close itself');

  const send = code(SRC.slice(SRC.indexOf('sendInvite(c, chan) {'),
    SRC.indexOf('inviteResult(c, ch, r, to) {')));
  assert.ok(!/setState\(\{\s*modal:\s*null\s*\}\)/.test(send),
    'and neither must the send that produced it — this exact line is what made'
    + ' every invitation on every channel look like nothing had happened');
});

/* ═══ THE SIGN-IN ROSTER IS THE WHOLE ROLL ════════════════════════════════
   Reported as "switch user does not show staffs". The lock screen took
   `users.slice(0, 7)` with nothing on the screen saying so — no scroll, no
   count, no search, no "and 5 more" — so a store with more than seven active
   people showed seven and the rest could not sign in AT ALL.

   The ordering made it worse: the roll arrives `ORDER BY rank DESC`, so the
   owner and the managers are first and the FLOOR STAFF, who are the people
   handing a till over at a shift change, fall off the end. */
test('every active person on the roll can sign in, however many there are', () => {
  const H = require('./harness');
  const F = H.makeInstance({ role: 'SuperAdmin' });
  const K = F.__win.KPOS;

  const roll = [];
  for (let i = 0; i < 23; i++) {
    roll.push({ id: 'u' + i, name: 'Waiter ' + i, user: 'w' + i, role: 'Cashier',
      rank: 2, outlet: F.state.outletId, outlets: [], pin: '', status: 'Active' });
  }
  // Somebody suspended is still refused, and this is not the thing being fixed.
  roll.push({ id: 'gone', name: 'Left Last Month', user: 'gone', role: 'Cashier',
    rank: 2, outlet: F.state.outletId, outlets: [], pin: '', status: 'Suspended' });
  K.USERS = roll;

  const v = F.modalVals({ kind: 'lock' });
  assert.strictEqual(v.lockStaff.length, 23,
    'all 23 are reachable — 7 here is the silent cap that made the eighth'
    + ' person onwards unable to sign in: ' + v.lockStaff.length);
  assert.ok(!v.lockStaff.some((u) => /Left Last Month/.test(u.name)),
    'and a suspended account is still not offered');

  /* IT SCROLLS RATHER THAN TRUNCATING. A sheet that grows to 23 rows is a
     sheet whose sign-out control is off the bottom of a phone. */
  assert.match(String(v.lockListStyle), /overflow\s*:\s*auto/);
  assert.match(String(v.lockListStyle), /max-height/);

  /* AND A LONG ROLL CAN BE SEARCHED, because scrolling 40 names to find
     yours is its own defect. The count rides on it, so the screen states the
     size of the roll without an element of its own. */
  assert.ok(!/display:\s*none/.test(String(v.lockFindStyle)),
    'a long roll offers the finder');
  assert.match(String(v.lockFindHint), /23 on this roll/);

  const found = F.modalVals({ kind: 'lock', find: 'waiter 1' });
  // 1, and 10..19 — eleven of them
  assert.strictEqual(found.lockStaff.length, 11,
    'typing narrows it: ' + JSON.stringify(found.lockStaff.map((u) => u.name)));

  /* A FILTER THAT MATCHES NOBODY SAYS SO. An empty list under a box somebody
     typed into reads as a broken terminal, which is the whole complaint. */
  const none = F.modalVals({ kind: 'lock', find: 'zzzz' });
  assert.strictEqual(none.lockStaff.length, 0);
  assert.match(String(none.lockNone), /Nobody on this roll matches/);
  assert.ok(!/display:\s*none/.test(String(none.lockNoneStyle)));

  /* AND A SHORT ROLL IS NOT GIVEN A CONTROL IT DOES NOT NEED: on a
     three-person café the finder is one more thing between somebody and
     their shift. */
  K.USERS = roll.slice(0, 3);
  const small = F.modalVals({ kind: 'lock' });
  assert.strictEqual(small.lockStaff.length, 3);
  assert.match(String(small.lockFindStyle), /display:\s*none/);

  /* An outlet with nobody on it is a state, not a blank screen. */
  K.USERS = [];
  const empty = F.modalVals({ kind: 'lock' });
  assert.strictEqual(empty.lockStaff.length, 0);
  assert.match(String(empty.lockNone), /Nobody is on this outlet's roll yet/);
});

/* THE FACE YOU TAP IS THE PERSON THE PAD NAMES. `userOf()` in src/bootstrap.js
   derives `user` from the LAST WORD of the name, so every Ibrahim on the floor
   shares one — and the PIN pad looked the row up by it and drew the FIRST
   match. Signing in was never wrong (the server matches the PIN itself), but
   who the screen said you were, was — and a wrong attempt was filed on the
   trail against somebody who was not standing there. */
test('the lock screen identifies a person by id, never by a derived name key', () => {
  const H = require('./harness');
  const F = H.makeInstance({ role: 'SuperAdmin' });
  F.__win.KPOS.USERS = [
    { id: 'a1', name: 'Ahmed Ibrahim', user: 'ibrahim', role: 'Cashier', rank: 2,
      outlet: F.state.outletId, outlets: [], pin: '', status: 'Active' },
    { id: 'b2', name: 'Mohamed Ibrahim', user: 'ibrahim', role: 'Cashier', rank: 2,
      outlet: F.state.outletId, outlets: [], pin: '', status: 'Active' }
  ];

  const list = F.modalVals({ kind: 'lock' });
  assert.strictEqual(list.lockStaff.length, 2, 'both are on the roll');

  // Tap the SECOND one.
  const seen = [];
  F.setState = (p) => { seen.push(p); Object.assign(F.state, p); };
  list.lockStaff[1].go();
  const picked = seen[seen.length - 1].modal;
  assert.strictEqual(picked.who, 'b2',
    'the pick carries the row id, not a name key two people share');

  const pad = F.modalVals(picked);
  assert.strictEqual(pad.lockWhoName, 'Mohamed Ibrahim',
    'and the pad names the person whose face was tapped, not the first row'
    + ' sharing their derived key: ' + pad.lockWhoName);
});

/* THE SHAPE: a roster the operator is standing in front of may never be
   silently truncated. This is the one screen where the cap costs somebody
   their shift, so it is banned rather than merely fixed. */
test('the sign-in roster is never sliced', () => {
  const i = SRC.indexOf('lockStaff:');
  assert.ok(i > 0);
  const near = SRC.slice(i - 2400, i + 400).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/users\.slice\(/.test(near),
    'the roll is capped again — the eighth person onwards cannot sign in');
});

/* ═══ A DELIVERY REACHES THE OUTLET ═══════════════════════════════════════
   Reported as "new grn form does not work", and it was two defects stacked.

   FIRST, on any modern store the form refused a line it had been given
   correctly: `grnLines()` did `+r.item || 0`, right for the seed-era numeric
   item master and NaN for every id `newId()` has minted since — so the form's
   own check answered "Every line needs an item and a quantity above zero"
   against a line naming a real ingredient.

   SECOND, where it did save, it saved nowhere. Both halves went through
   `insertRow("purch", …)`; `purch` is not in COLLECTION_OP, so the generic
   fallback queued `purchases_insert` with NO PAYLOAD — no handler, recorded
   `unmodelled`, answered success. "GRN posted · 1 lines MVR 250" at the
   counter, and no delivery, no stock move, no document number anywhere.
   `H.grn_receive` had been complete on the server the whole time. */
test('the GRN form keeps the item id it was given', () => {
  const H = require('./harness');
  const F = H.makeInstance({ role: 'SuperAdmin' });

  const lines = F.grnLines([{ item: 'iFLOUR1', qty: '10', rate: '25' }]);
  assert.strictEqual(lines[0][0], 'iFLOUR1',
    'a minted id survives: 0 here is `+r.item` on a text id, and the form then'
    + ' refuses its own line by name — which is the whole report');
  assert.strictEqual(lines[0][1], 10);
  assert.strictEqual(lines[0][2], 25);

  // The seed-era numeric master still works, as a string.
  assert.strictEqual(F.grnLines([{ item: 3, qty: '2', rate: '1' }])[0][0], '3');
  // A blank row is dropped rather than rejected.
  assert.strictEqual(F.grnLines([{ item: '', qty: '' }]).length, 0);

  /* THE SHAPE ITSELF, because `doorLines()` one method up has always been
     right and this was the odd one out. */
  assert.ok(!/grnLines\(rows\)[\s\S]{0,300}\+r\.item \|\| 0/.test(SRC),
    'the item id is numbered again, and every line on a modern store is refused');
});

test('a posted GRN queues the op the outlet actually handles', () => {
  const H = require('./harness');
  const F = H.makeInstance({ role: 'SuperAdmin' });
  const W = F.__win;
  W.KPOS_RAW = Object.assign({}, W.KPOS_RAW, {
    items: [['iFLOUR1', 'ING-1', 'FLOUR', 'kg', 'kg', 1, 25, 0, 0, 10]],
    vendors: [{ id: 7, name: 'Reef Suppliers' }], purch: [] });
  const ops = [];
  F.queue = (kind, label, ent, payload) => ops.push({ kind: kind, payload: payload });
  F.showRecost = () => {};

  F.formSpec('grn').onSave({ no: 'GRN-2026-0001', date: F.today(), vendor: '7',
    branch: String(F.state.outletId), inv: 'VND-1', total: '0', notes: 'probe',
    lines: [{ item: 'iFLOUR1', qty: '10', rate: '25' }] });

  const g = ops.filter((o) => o.kind === 'grn_receive')[0];
  assert.ok(g, 'grn_receive is queued — `purchases_insert` here is the generic'
    + ' fallback, which has no handler and carries no payload: '
    + JSON.stringify(ops.map((o) => o.kind)));
  assert.ok(!ops.some((o) => /_insert$/.test(o.kind)),
    'and nothing goes out through the payload-less back-office lane');

  /* IT CARRIES WHAT THE HANDLER READS. An op that queues a label looks fine in
     the outbox, appears on the trail, and changes nothing. */
  assert.strictEqual(g.payload.vendorName, 'Reef Suppliers',
    'the supplier by NAME — delivery.supplier_id is a uuid and the till holds a'
    + ' number, which is the cast that was killing vendor_payment');
  assert.strictEqual(g.payload.ref, 'GRN-2026-0001',
    'the till number rides as a reference; the outlet allocates the document');
  assert.strictEqual(g.payload.bizDate, F.today());
  // Field by field: the payload is built inside the vm, so its objects carry
  // that realm's prototype and a strict deep-compare fails on identity alone.
  assert.strictEqual(g.payload.lines.length, 1);
  assert.strictEqual(g.payload.lines[0].ing, 'iFLOUR1');
  assert.strictEqual(g.payload.lines[0].qty, 10);
  assert.strictEqual(g.payload.lines[0].price, 25);
  assert.strictEqual(g.payload.lines[0].total, 250);

  /* AND `purch` STAYS OUT OF COLLECTION_OP. Putting it in would connect the
     wire and ALSO hand `applyLocal()` a GRN to re-send once per session —
     `grn_receive` allocates a document number and inserts a delivery, so a
     second send is a SECOND RECEIPT of the same stock. The outbox's own
     replay is safe (op_log.op_id); a fresh opId is not. */
  assert.strictEqual(F.COLLECTION_OP().purch, undefined,
    'purch must not join the map — the holding pen would receive the stock twice');
  assert.ok(!F.opFor('purch', { no: 'X' }),
    'so the pen has no op for it and never re-sends one');
});

test('a GRN with no supplier is refused before anything is queued', () => {
  const H = require('./harness');
  const F = H.makeInstance({ role: 'SuperAdmin' });
  const W = F.__win;
  W.KPOS_RAW = Object.assign({}, W.KPOS_RAW, {
    items: [['iFLOUR1', 'ING-1', 'FLOUR', 'kg', 'kg', 1, 25, 0, 0, 10]],
    vendors: [], purch: [] });
  const ops = [];
  F.queue = (kind) => ops.push(kind);
  F.__toasts.length = 0;
  F.showRecost = () => {};

  F.formSpec('grn').onSave({ no: 'GRN-2026-0002', date: F.today(), vendor: '',
    branch: String(F.state.outletId), inv: '', total: '0',
    lines: [{ item: 'iFLOUR1', qty: '10', rate: '25' }] });

  assert.strictEqual(ops.length, 0, 'nothing is sent: ' + JSON.stringify(ops));
  const said = (F.__toasts[F.__toasts.length - 1] || {}).t || '';
  assert.match(said, /supplier/i,
    'and it says which field, on the screen: ' + JSON.stringify(said));
});

/* ═══ THE GRN'S DROPDOWNS HAVE SOMETHING IN THEM ══════════════════════════
   Reported from the mobile shortcut and the browser: "GRN is bugged. drop
   down is stuck. vendor location." A `<select>` with ZERO options is exactly
   that — it cannot be opened on a desktop and does not respond to a tap on a
   phone — and "Receiving location" had none on every ordinary customer:
   `storeOpts` was `OUTLETS` filtered to the ones that are NOT restaurants (a
   chain's central warehouses), and a café is one outlet whose kind IS
   restaurant.

   The outlet's own `location` table is what `grn_line`, `batch.location_id`
   and `moveStock(loc)` have always taken, and the bootstrap has published it
   as LOCATIONS since it was written — nothing in the till had ever read it. */
test('the GRN offers a place to put it and a supplier to receive from', () => {
  const H = require('./harness');
  const F = H.makeInstance({ role: 'SuperAdmin' });
  const W = F.__win;
  // The shape of an ordinary customer: ONE outlet, and it is a restaurant.
  W.KPOS.OUTLETS = [{ id: F.state.outletId, code: 'LOYC', name: 'Loy Cafe',
    type: 'restaurant', pos: true, active: true }];
  W.KPOS.LOCATIONS = [{ id: 'L-DRY', name: 'Dry store', kind: 'store' },
    { id: 'L-CHILL', name: 'Walk-in chiller', kind: 'chiller' }];
  W.KPOS_RAW = Object.assign({}, W.KPOS_RAW, {
    vendors: [{ id: 7, name: 'Reef Suppliers' }], purch: [],
    items: [['iF', 'ING', 'FLOUR', 'kg', 'kg', 1, 25, 0, 0, 10]] });

  const fields = F.formSpec('grn').fields;
  const at = (k) => fields.filter((f) => f.k === k)[0];

  const where = at('branch');
  assert.ok(where.options.length >= 3,
    'a select with no options is the stuck dropdown: ' + JSON.stringify(where.options));
  assert.strictEqual(where.options[0].v, '',
    'and the FIRST option is the one that is always true — openForm seeds a'
    + ' select with it, so the default must be an answer a café can give');
  assert.ok(/store/i.test(where.options[0].l));
  assert.ok(where.options.some((o) => o.v === 'L-CHILL'),
    'the outlet\'s own stock locations are offered');

  /* A SUPPLIER IS A DECISION, so nothing is chosen by default — the Role box
     already paid for seeding a grant from the first option. */
  const vend = at('vendor');
  assert.strictEqual(vend.options[0].v, '', 'nothing is picked for you');
  assert.ok(vend.options.some((o) => o.v === '__new_supplier__'),
    'and the list carries its own way out for a store with no suppliers yet: '
    + JSON.stringify(vend.options.map((o) => o.l)));
  assert.ok(at('newVendor'), 'with somewhere to type the name');

  /* AND AN OUTLET WITH NO SUB-LOCATIONS IS STILL NOT AN EMPTY BOX. */
  W.KPOS.LOCATIONS = [];
  const bare = F.formSpec('grn').fields.filter((f) => f.k === 'branch')[0];
  assert.strictEqual(bare.options.length, 1,
    'the store itself is always an option: ' + JSON.stringify(bare.options));
});

test('a supplier can be named on the GRN, and lands before the delivery', () => {
  const H = require('./harness');
  const mk = () => {
    const F = H.makeInstance({ role: 'SuperAdmin' });
    const W = F.__win;
    W.KPOS.OUTLETS = [{ id: F.state.outletId, name: 'Loy Cafe', type: 'restaurant' }];
    W.KPOS.LOCATIONS = [{ id: 'L-DRY', name: 'Dry store', kind: 'store' }];
    W.KPOS_RAW = Object.assign({}, W.KPOS_RAW, {
      vendors: [{ id: 7, name: 'Reef Suppliers' }], purch: [],
      items: [['iF', 'ING', 'FLOUR', 'kg', 'kg', 1, 25, 0, 0, 10]] });
    F.showRecost = () => {};
    return F;
  };
  const post = (F, v) => {
    const ops = [];
    F.queue = (k, l, e, p) => ops.push({ kind: k, payload: p });
    F.formSpec('grn').onSave(Object.assign({ no: 'GRN-1', date: F.today(),
      branch: 'L-DRY', inv: 'V1', total: '0',
      lines: [{ item: 'iF', qty: '10', rate: '25' }] }, v));
    return ops;
  };

  // ── named a supplier nobody had entered ────────────────────────────────
  const F1 = mk();
  const made = post(F1, { vendor: '__new_supplier__', newVendor: 'Fresh Fish Co' });
  const kinds = made.map((o) => o.kind);
  assert.ok(kinds.indexOf('vendor_upsert') > -1, 'the supplier is created: ' + kinds);
  assert.ok(kinds.indexOf('vendor_upsert') < kinds.indexOf('grn_receive'),
    'BEFORE the delivery — a push applies in queue order, so it carries the'
    + ' lower lamport and lands first: ' + kinds);
  const vop = made.filter((o) => o.kind === 'vendor_upsert')[0];
  assert.strictEqual(vop.payload.name, 'Fresh Fish Co');
  assert.strictEqual(vop.payload.id, undefined,
    'composed through the ONE mapping every supplier write goes through, which'
    + ' sends no id — `H.vendor_upsert` reads none and resolves by name');
  const g1 = made.filter((o) => o.kind === 'grn_receive')[0];
  assert.strictEqual(g1.payload.vendorName, 'Fresh Fish Co');
  assert.strictEqual(g1.payload.vendor, null,
    'and the delivery carries no id, because the one this browser minted is'
    + ' local and no outlet has heard of it');
  assert.strictEqual(g1.payload.lines[0].loc, 'L-DRY',
    'the place it is being put rides on the line');
  assert.ok((F1.__win.KPOS_RAW.vendors || []).some((x) => x.name === 'Fresh Fish Co'),
    'and the dropdown carries it straight away');

  // ── a name the master already holds is that supplier, not a second one ──
  const F2 = mk();
  const dup = post(F2, { vendor: '__new_supplier__', newVendor: '  reef suppliers ' });
  assert.ok(dup.every((o) => o.kind !== 'vendor_upsert'),
    'no second supplier is created for a name that differs only in case');
  assert.strictEqual(dup.filter((o) => o.kind === 'grn_receive')[0].payload.vendorName,
    'Reef Suppliers', 'and the delivery names the one that exists');

  // ── picking one creates nothing ────────────────────────────────────────
  const F3 = mk();
  const picked = post(F3, { vendor: '7' });
  assert.ok(picked.every((o) => o.kind !== 'vendor_upsert'));
  assert.strictEqual(picked.filter((o) => o.kind === 'grn_receive')[0].payload.vendorName,
    'Reef Suppliers');

  // ── and saying nothing is refused by name, before anything is sent ──────
  const F4 = mk();
  F4.__toasts.length = 0;
  const none = post(F4, { vendor: '', newVendor: '   ' });
  assert.strictEqual(none.length, 0, 'nothing queued: ' + JSON.stringify(none.map((o) => o.kind)));
  assert.match((F4.__toasts[F4.__toasts.length - 1] || {}).t || '', /supplier/i);
});

/* ═══ THE INVENTORY MODULE ═════════════════════════════════════════════════
   Four tabs on one rail — On hand, Counts, Stock ledger, Batches & expiry —
   and every one of these fails against the version that shipped. */

test('the item form keeps the cost and the shelf life in separate slots', () => {
  const H = require('./harness');
  const mk = () => {
    const F = H.makeInstance({ role: 'SuperAdmin' });
    F.setState = () => {};
    F.__ops = [];
    F.queue = (kind, label, entity, payload) => F.__ops.push({ kind, payload });
    F.__win.KPOS_RAW = Object.assign({}, F.__win.KPOS_RAW, {
      cats: [{ id: 'Dry goods', name: 'Dry goods' }],
      // A real outlet's published row: pcs/pcs at MVR 20.3125.
      items: [['IT-0274', '', 'BAJIYA', 'pcs', 20.3125, 'raw', 'IT-0274',
        'pcs', 'pcs', '20.3125', 0, 0, 0, null, null, null]]
    });
    return F;
  };

  /* INDEX 9 IS THE COST PER BASE UNIT and this form asked for a SHELF LIFE
     and wrote it there, in both directions:
       creating  rice at MVR 32/KG sent `cost: 180, factor: 0.177` — MVR 180
                 a GRAM, 5,625× what the kitchen paid;
       editing   `pre()` handed the operator that item's own cost per base
                 unit in a box labelled "Shelf life (days)". */
  const F0 = mk();
  const shown = F0.formSpec('item').pre(F0.__win.KPOS_RAW.items[0]);
  assert.strictEqual(shown.shelf, '',
    'the shelf-life box is empty on an item nobody has assessed — it used to'
    + ' show that item\'s own cost per base unit: ' + JSON.stringify(shown));
  assert.strictEqual(shown.cost, '20.3125');

  // ── creating ─────────────────────────────────────────────────────────────
  const F1 = mk();
  F1.formSpec('item').onSave({ name: 'basmati rice', cat: 'Dry goods',
    base: 'GRM', stock: 'KG', cost: '32', par: '', shelf: '180' });
  const made = F1.__ops.filter((o) => o.kind === 'item_upsert')[0];
  assert.ok(made, 'an item reaches the outlet: ' + JSON.stringify(F1.__ops));
  assert.strictEqual(made.payload.cost, 0.032,
    'MVR 32 a kilo is 3.2 laari a gram, and `cost` is per BASE unit');
  assert.strictEqual(made.payload.factor, 1000, 'a thousand grams in a kilo');
  assert.strictEqual(made.payload.shelf, 180, 'the shelf life has a slot of its own');
  assert.strictEqual(made.payload.cat, 'Dry goods',
    'a stock category is a NAME — `+v.cat || 1` filed every item a till ever'
    + ' created under a category called "1"');

  /* AND A BRAND-NEW STORE HAS NO CATEGORIES AT ALL. `raw.cats` is SELECT
     DISTINCT category FROM ingredient, so on the first item anybody creates
     this was a select with ZERO options — the stuck dropdown the GRN's
     receiving location already paid for. */
  const F3 = H.makeInstance({ role: 'SuperAdmin' });
  F3.setState = () => {};
  F3.__ops = [];
  F3.queue = (kind, label, entity, payload) => F3.__ops.push({ kind, payload });
  F3.__win.KPOS_RAW = Object.assign({}, F3.__win.KPOS_RAW, { cats: [], items: [] });
  const catField = F3.formSpec('item').fields.filter((f) => f.k === 'cat')[0];
  assert.ok(catField.options.length >= 2,
    'a store with no categories still has a list: ' + JSON.stringify(catField.options));
  assert.strictEqual(catField.options[0].v, '',
    'and the FIRST option is the one always true — openForm seeds a select'
    + ' with it');
  assert.ok(catField.options.some((o) => o.v === '__new_category__'),
    'with its own way out');
  F3.formSpec('item').onSave({ name: 'ghee', cat: '__new_category__',
    newCat: '  Chilled  ', base: 'GRM', stock: 'KG', cost: '90', par: '', shelf: '' });
  assert.strictEqual(F3.__ops.filter((o) => o.kind === 'item_upsert')[0].payload.cat,
    'Chilled', 'a name typed here files the item under it, and the category is'
    + ' the outlet\'s the moment that item lands');
  assert.strictEqual(made.payload.par, null,
    'and an unset par is null, not the literal 100 this used to invent');

  // ── editing a price, with the shelf-life box left exactly as presented ───
  const F2 = mk();
  const it = F2.__win.KPOS_RAW.items[0];
  const pre = F2.formSpec('item').pre(it);
  F2.formSpec('item').onEdit(Object.assign({}, pre, { cost: '25' }), it);
  const ed = F2.__ops.filter((o) => o.kind === 'item_upsert')[0];
  assert.strictEqual(ed.payload.factor, 1,
    'correcting a PRICE must not rewrite the conversion every recipe divides'
    + ' by — this sent 1.23 for an item whose factor is 1');
  assert.strictEqual(ed.payload.cost, 25);
  assert.strictEqual(ed.payload.shelf, null, 'and says nothing it was not told');
});

test('an item id is the string it is, everywhere the master is picked', () => {
  const H = require('./harness');
  const F = H.makeInstance({ role: 'SuperAdmin' });
  F.setState = () => {};
  F.__ops = [];
  F.queue = (kind, label, entity, payload) => F.__ops.push({ kind, payload });
  F.__win.KPOS.LOCATIONS = [{ id: 'L-CHILL', name: 'Walk-in chiller', kind: 'chiller' }];
  F.__win.KPOS_RAW = Object.assign({}, F.__win.KPOS_RAW, {
    cats: [], items: [['iFLOUR1', 'Dry', 'FLOUR', 'kg', 25, 'raw', 'iFLOUR1',
      'g', 'kg', '0.025', 10, 0, 0, null, null, null]] });

  // ── the stock adjustment ────────────────────────────────────────────────
  const adj = F.formSpec('adjust');
  assert.ok(adj.fields.filter((f) => f.k === 'loc')[0].options
    .some((o) => o.v === 'L-CHILL'),
    'the location list is this outlet\'s own places, not the estate\'s outlets');
  F.__toasts.length = 0;
  adj.onSave({ item: 'iFLOUR1', loc: 'L-CHILL', dir: 'out', qty: '2',
    reason: 'Spoilage', notes: '' });
  const sa = F.__ops.filter((o) => o.kind === 'stock_adjust')[0];
  assert.ok(sa, '`+v.item` is NaN for every id newId() mints, and item() compares'
    + ' with === — so a correctly picked item was refused "Pick an item": '
    + JSON.stringify(F.__toasts));
  assert.strictEqual(sa.payload.ing, 'iFLOUR1');
  assert.strictEqual(sa.payload.loc, 'L-CHILL');

  // ── a recipe line ───────────────────────────────────────────────────────
  F.__win.KPOS.MENU = [{ id: 'd1', name: 'Roshi', recipe: [] }];
  F.patchRows = (k, keys, set) => { F.__patch = set; };
  F.formSpec('recipe').onSave({ dish: 'd1', item: 'iFLOUR1', qty: '100' });
  // Compared field by field: the array is minted inside the vm, so its
  // prototype is a different realm's and deepStrictEqual refuses it.
  const rl = ((F.__patch || {}).recipe || [])[0] || [];
  assert.strictEqual(rl[0], 'iFLOUR1',
    'a recipe line names an ingredient the server can explode, not NaN');
  assert.strictEqual(rl[1], 100);

  // ── and the shared lines editor the GRN and the door receipt both use ────
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'app', 'index.html'), 'utf8');
  assert.ok(!/this\.item\(\+/.test(src),
    'no path coerces an item id with + before looking it up');
});

test('a blind count sends the rows it computed, in the unit the ledger moves', () => {
  const H = require('./harness');
  const F = H.makeInstance({ role: 'SuperAdmin' });
  F.setState = (p) => { Object.assign(F.state, p || {}); };
  F.__ops = [];
  F.queue = (kind, label, entity, payload) => F.__ops.push({ kind, payload });
  F.info = () => {};
  // Flour, bought by the kilo and cooked by the gram.
  const it = ['iFLOUR1', 'Dry', 'FLOUR', 'kg', 25, 'raw', 'iFLOUR1', 'g', 'kg',
    '0.025', 10, 0, 0, null, null, null];
  F.__win.KPOS.OUTLETS = [{ id: F.state.outletId, code: 'LOYC', name: 'Loy Cafe' }];
  F.__win.KPOS_RAW = Object.assign({}, F.__win.KPOS_RAW, {
    items: [it], inv: [[F.state.outletId, 'iFLOUR1', 8000]], cats: [] });
  F.state.settled = [];

  F.postCount({ counted: { iFLOUR1: '6' }, cats: [] }, [it]);
  const cp = F.__ops.filter((o) => o.kind === 'count_post')[0];
  assert.ok(cp, 'a count reaches the outlet');
  const line = cp.payload.lines[0];
  /* `lines` in postCount is the SHEET — item ARRAYS — so `l.id`, `l.theo`,
     `l.actual` and `l.cost` were all undefined on every count ever taken, and
     `count_line.ingredient_id` is text NOT NULL: refused, parked, under a
     screen reporting the variance it had just worked out. */
  assert.strictEqual(line.ing, 'iFLOUR1', 'the line names its item: '
    + JSON.stringify(line));
  assert.strictEqual(line.expected, 8000,
    'BASE units — the server moves this straight into stock_move.qty, so 8 kg'
    + ' sent as 8 would move eight grams');
  assert.strictEqual(line.counted, 6000);
  assert.strictEqual(line.cost, 0.025, 'and the cost is per base unit too');
});

test('what the books think is on the shelf is one unit all the way through', () => {
  const H = require('./harness');
  const F = H.makeInstance({ role: 'SuperAdmin' });
  const it = ['iFLOUR1', 'Dry', 'FLOUR', 'kg', 25, 'raw', 'iFLOUR1', 'g', 'kg',
    '0.025', 10, 0, 0, null, null, null];
  F.__win.KPOS.OUTLETS = [{ id: F.state.outletId, code: 'LOYC', name: 'Loy Cafe' }];
  F.__win.KPOS_RAW = Object.assign({}, F.__win.KPOS_RAW, {
    items: [it], inv: [[F.state.outletId, 'iFLOUR1', 8000]], cats: [] });
  F.state.settled = [];
  /* `on_hand` and a GRN line are BASE units — `stock_move.qty` is, and that is
     what feeds them — and only the recipe term was being converted. So for any
     item bought by the kilo this read a thousand times its own shelf, in the
     one figure the whole Inventory screen is built on. */
  assert.strictEqual(F.bookOnHand('iFLOUR1'), 8,
    'eight kilograms, not eight thousand');
});

test('the Inventory screen names a place inside the store', () => {
  const H = require('./harness');
  const F = H.makeInstance({ role: 'SuperAdmin' });
  F.__win.KPOS.LOCATIONS = [{ id: 'L-CHILL', name: 'Walk-in chiller' }];
  assert.strictEqual(F.locName('L-CHILL'), 'Walk-in chiller',
    'the stock ledger and the FEFO shelf resolved this against OUTLETS, so a'
    + ' chiller the outlet has published since it was provisioned printed as'
    + ' "Location #L-CHILL"');
  assert.strictEqual(F.locName(null), 'The store');
  assert.strictEqual(F.locName('L-GONE'), 'L-GONE',
    'and an id that resolves to nothing is printed as itself');
});

test('the auto-indent reaches the outlet, and the stock category does not lie', () => {
  const H = require('./harness');
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'app', 'index.html'), 'utf8');
  /* `insertRow("reqs", …)` fell through to `requests_insert` with no payload —
     a kind with no handler, recorded `unmodelled`, answered success. It is an
     explicit queue now, and `reqs` stays OUT of COLLECTION_OP for the reason
     `purch` does: `H.indent` allocates a document number, so the holding pen
     must never re-send it. */
  assert.match(src, /this\.queue\("indent",/,
    'the below-par indent queues the op the outlet actually handles');
  const F = H.makeInstance({ role: 'SuperAdmin' });
  assert.ok(!F.COLLECTION_OP().reqs,
    'and `reqs` is not in the collection map, or the pen would re-raise it');

  /* "New category" on the Inventory screen minted `Math.max(0, "Dry goods")`
     — NaN — and queued `category_insert`, which the server aliases to the MENU
     section handler, with no payload. */
  assert.ok(!/queue\("category_insert"/.test(src),
    'a stock category is a name an item is filed under, not a menu section');
});
