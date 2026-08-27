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
  'maintenance_log', 'mdr_set', 'member_upsert', 'menu_category_insert',
  'menu_category_reorder', 'menu_category_update', 'menu_import',
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
  assert.strictEqual(CONTRACT.length, 119, 'the contract is 119 kinds');
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
  assert.match(body, /stops being a way in until somebody signs in again/,
    'and signing out says what it actually ends');

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
  assert.match(acct, /var mode = forStore \? "signin" : "signup";/,
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

  /* The reset still exists — it is a real thing an owner needs — but it now
     files a REQUEST, and the wording says so on the card, in the form and in
     the toast. */
  assert.ok(/store_reset", "Store reset REQUESTED/.test(SRC),
    'the reset records a request rather than claiming an erase');
  assert.ok(/nothing has been erased/.test(SRC),
    'and the toast says plainly that nothing was erased');

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
