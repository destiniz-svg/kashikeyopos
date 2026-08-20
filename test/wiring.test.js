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
  'maintenance_log', 'mdr_set', 'menu_category_insert', 'menu_import',
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
  assert.strictEqual(CONTRACT.length, 115, 'the contract is 115 kinds');
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

  // The sale — the one that matters.
  const slot = 1, key = F.state.outletId + ':' + slot;
  const tk = Object.assign(F.blankTicket(), {
    waiter: 'Test Cashier', party: 4, bizDate: F.today(),
    lines: [{ id: 'm1', qty: 2, note: '', split: 0, fired: true, since: 1, firedAt: Date.now() }]
  });
  F.state.tickets = Object.assign({}, F.state.tickets, { [key]: tk });
  F.state.activeTable = slot;
  F.ticketPanelVals({ kind: 'ticket', slot: slot, tender: 'cash' }).tkSettle();
  const sale = grab('sale');
  has(sale, ['bizDate', 'covers', 'net', 'tax', 'taxRate', 'taxLabel', 'total',
    'sold', 'payments', 'stockMoves']);
  assert.ok(sale.payload.payments[0].tendered >= sale.payload.total,
    'the payment records what was handed over, not only what was owed');
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
  F.ticketPanelVals({ kind: 'ticket', slot: slot, tender: 'cash' }).tkSettle();

  const journals = queued.filter((q) => q.kind === 'post_journal');
  journals.forEach((j) => {
    assert.ok(!j.payload || !j.payload.lines,
      'a till-side post_journal must not carry lines — the server already posted them');
  });
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
