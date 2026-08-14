'use strict';
/* Orders & Tickets — §2 (`orders`): "Every ticket today, open and closed, with
 * its receipt, tender, server and audit trail."
 *
 * The claim under test is the governing principle's first line: no screen is a
 * dead end. So these tests do not check that a list renders; they check that
 * from a receipt you can reach every consequence the sale had — the tender, the
 * tax version it was rung up under, the journal it posted, the stock it
 * consumed, and who did what between the round being fired and the money being
 * taken. And that a cashier reaches the receipt but not the margin.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('orders & tickets', () => {
  let ctx, mgr, sale, ticketId;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);

    /* A ticket that lived a whole evening: opened on a table, fired to the
       kitchen, then settled. Built through the REAL operations — a fixture that
       INSERTs a sale row proves nothing about the audit trail, because the
       trail is written by those operations and by nothing else. */
    const send = await H.push(ctx, [{ opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: {
        table: '6', covers: 2, server: 'Aishath',
        lines: [{ itemId: 'BURGER', qty: 2 }, { itemId: 'COLA', qty: 1 }],
      } }]);
    assert.equal(send.status, 200, JSON.stringify(send.json));
    ticketId = send.json.results[0].result.ticketId;
    assert.ok(ticketId, JSON.stringify(send.json));

    const bill = H.priceIt(ctx, [['BURGER', 2], ['COLA', 1]]);
    const r = await H.push(ctx, [{ opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        ticketId, businessDate: ctx.today, channel: 'dine_in', covers: 2,
        lines: [{ itemId: 'BURGER', qty: 2 }, { itemId: 'COLA', qty: 1 }],
        server: 'Aishath',
        payments: [{ method: 'cash', amount: bill.total / 100, tendered: 250 }],
        clientTotal: bill.total / 100,
      } }]);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    sale = r.json.results[0].result;
    assert.ok(sale && sale.saleId, JSON.stringify(r.json));
  });

  after(() => H.teardown(ctx));

  const asMgr = (p) => H.req('GET', `/api/outlet/${ctx.outletId}${p}`, { token: mgr.token });
  const asTill = (p) => H.req('GET', `/api/outlet/${ctx.outletId}${p}`, { token: ctx.token });

  /* ── the day ──────────────────────────────────────────────────────────── */

  test('the day lists the sale, its table, its server and its tender', async () => {
    const r = await asMgr(`/orders?date=${ctx.today}`);
    assert.equal(r.status, 200, r.text);
    const row = r.json.closed.find((x) => x.saleId === sale.saleId);
    assert.ok(row, 'the settled sale is on the day');
    assert.equal(row.receiptNo, sale.receiptNo);
    assert.equal(row.table, '6');
    assert.equal(row.server, 'Aishath');
    assert.deepEqual(row.methods, ['cash']);
    assert.equal(row.voided, false);
    assert.equal(row.mismatch, null, 'the till agreed with the server');
  });

  test("the day's totals equal the sales on it, and the invariant holds", async () => {
    const r = await asMgr(`/orders?date=${ctx.today}`);
    const t = r.json.totals;
    const sum = (k) => r.json.closed.reduce((a, x) => a + x[k], 0);
    assert.equal(t.tickets, r.json.closed.length);
    assert.equal(t.total.toFixed(2), sum('total').toFixed(2));
    // gross − discount + service + tax + rounding = total, on the day as on
    // every bill. If a day summary can drift from its own rows, the ribbon is
    // decoration.
    assert.equal(
      (t.gross - t.discount + t.service + t.tax + t.rounding).toFixed(2),
      t.total.toFixed(2));
    assert.equal(t.average.toFixed(2), (t.total / t.tickets).toFixed(2));
  });

  test('tender is broken out by method and adds up to the day', async () => {
    const r = await asMgr(`/orders?date=${ctx.today}`);
    const taken = r.json.tender.reduce((a, x) => a + x.amount, 0);
    assert.equal(taken.toFixed(2), r.json.totals.total.toFixed(2),
      'what was taken equals what was billed');
  });

  test('an open ticket stays on the floor list until it is paid', async () => {
    const send = await H.push(ctx, [{ opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: {
        table: '9', covers: 4, server: 'Hassan',
        lines: [{ itemId: 'COLA', qty: 3 }],
      } }]);
    const openId = send.json.results[0].result.ticketId;

    const r = await asMgr(`/orders?date=${ctx.today}`);
    const open = r.json.open.find((x) => x.ticketId === openId);
    assert.ok(open, 'the open ticket is listed');
    assert.equal(open.table, '9');
    assert.equal(open.covers, 4);
    assert.equal(open.lines, 1);
    assert.equal(open.sent, 1, 'and it is with the kitchen');
    // 3 × MVR 25 at the menu price, GST-inclusive: what the table is running up,
    // not a bill — the bill is priced when it is settled.
    assert.equal(Number(open.value).toFixed(2), '75.00');

    // …and the settled one is NOT: it is closed, and closed tickets are money.
    assert.ok(!r.json.open.some((x) => x.ticketId === ticketId));
  });

  test('a day with no trading is empty, not an error', async () => {
    const r = await asMgr('/orders?date=2019-02-11');
    assert.equal(r.status, 200);
    assert.equal(r.json.closed.length, 0);
    assert.equal(r.json.totals.tickets, 0);
    assert.equal(r.json.totals.total, 0);
    assert.equal(r.json.totals.average, 0, 'and no division by zero');
  });

  test('a malformed date is refused rather than guessed at', async () => {
    assert.equal((await asMgr('/orders?date=yesterday')).status, 400);
  });

  /* ── the receipt ──────────────────────────────────────────────────────── */

  test('the receipt carries the tax version it was RUNG UP UNDER', async () => {
    const r = await asMgr(`/orders/${sale.saleId}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.sale.taxCode, 'GGST');
    assert.equal(Number(r.json.sale.taxRate), ctx.taxRate);
    assert.equal(r.json.sale.receiptNo, sale.receiptNo);
    assert.equal(r.json.sale.table, '6');
    assert.equal(r.json.sale.covers, 2);
  });

  test('the receipt adds up to what was taken', async () => {
    const r = await asMgr(`/orders/${sale.saleId}`);
    const s = r.json.sale;
    assert.equal((s.gross - s.discount + s.service + s.tax + s.rounding).toFixed(2),
      s.total.toFixed(2));
    const paid = r.json.payments.reduce((a, p) => a + p.amount, 0);
    assert.equal(paid.toFixed(2), s.total.toFixed(2));
    // The lines are NET of tax and sum to the gross — the same convention the
    // sale row uses, so a reader can add the column up and get the subtotal.
    const lines = r.json.lines.reduce((a, l) => a + l.lineTotal, 0);
    assert.equal(lines.toFixed(2), s.gross.toFixed(2));
  });

  test('the journal the sale posted is reachable FROM the sale', async () => {
    const r = await asMgr(`/orders/${sale.saleId}`);
    const j = r.json.journal;
    assert.ok(j, 'the sale names its journal');
    const dr = j.lines.reduce((a, l) => a + l.dr, 0);
    const cr = j.lines.reduce((a, l) => a + l.cr, 0);
    assert.equal(dr.toFixed(2), cr.toFixed(2), 'and it balances');
    const codes = j.lines.map((l) => l.account);
    assert.ok(codes.includes('1000'), 'cash debited');
    assert.ok(codes.includes('4000'), 'sales credited');
    assert.ok(codes.includes('2100'), 'GST payable credited');
    assert.ok(codes.includes('5000') && codes.includes('1100'), 'and cost of sales moved');
    assert.ok(j.lines.every((l) => l.name), 'every account is named, not just coded');
  });

  test('the stock the sale consumed is reachable from the sale', async () => {
    const r = await asMgr(`/orders/${sale.saleId}`);
    const beef = r.json.stock.find((m) => m.ingredientId === 'BEEF');
    assert.ok(beef, 'the beef it used is listed');
    // 2 burgers × 150 g with 5% waste — the recipe, exploded at the moment of
    // sale. Negative because a sale takes stock out.
    assert.ok(beef.qty < 0, 'and it went out, not in');
    assert.ok(r.json.stock.some((m) => m.ingredientId === 'BUN'));
    assert.ok(r.json.stock.some((m) => m.ingredientId === 'SYRUP'));
    const cogs = r.json.stock.reduce((a, m) => a + Math.abs(m.value), 0);
    assert.equal(cogs.toFixed(2), Number(r.json.sale.cogs).toFixed(2),
      'and the cost on the receipt is the cost of the stock it moved');
  });

  test('the audit trail reads as the evening happened', async () => {
    const r = await asMgr(`/orders/${sale.saleId}`);
    assert.equal(r.json.auditVisible, true);
    const actions = r.json.audit.map((a) => a.action);
    assert.ok(actions.includes('ticket_send'), 'the round was fired');
    assert.ok(actions.includes('sale'), 'and the money was taken');
    assert.ok(actions.indexOf('ticket_send') < actions.indexOf('sale'),
      'in that order');
    assert.ok(r.json.audit.every((a) => a.at), 'every act is timestamped');
    assert.ok(r.json.audit.some((a) => a.actor), 'and attributed to a person');
  });

  test('a voided ticket line survives on the receipt, with who and why', async () => {
    /* A guest sent a drink back before paying. "We were charged for a drink we
       sent back" has to be answerable, and it cannot be if the row was deleted.

       Written directly because VOIDING A LINE HAS NO OPERATION YET — it belongs
       with the void/credit-note work, which posts a reversing journal. This
       test pins the PROJECTION ahead of that operation, so the screen is ready
       for it; it is not claiming the operation exists. */
    await H.q(ctx,
      "UPDATE ticket_line SET void_at = now(), void_by = $2, void_reason = 'sent back'"
      + " WHERE ticket_id = $1 AND item_id = 'COLA'", [ticketId, ctx.staffId]);
    const r = await asMgr(`/orders/${sale.saleId}`);
    const v = r.json.ticketLines.find((l) => l.voided);
    assert.ok(v, 'the voided line is still on the ticket');
    assert.equal(v.voidReason, 'sent back');
    assert.equal(v.voidBy, 'Test Cashier');
    // and it is not in the charged lines
    assert.equal(r.json.lines.filter((l) => l.itemId === 'COLA').length, 1,
      'the sale still charged the cola that WAS drunk');
  });

  test('an unknown sale is 404, and a malformed id is not a 500', async () => {
    assert.equal((await asMgr(`/orders/${H.uuid()}`)).status, 404);
    assert.equal((await asMgr('/orders/not-a-uuid')).status, 404);
  });

  /* ── rank ─────────────────────────────────────────────────────────────── */

  test('a CASHIER gets the receipt but not the margin', async () => {
    const r = await asTill(`/orders/${sale.saleId}`);
    assert.equal(r.status, 200, r.text);
    // What a cashier needs: the receipt, the tender, what the guest paid.
    assert.equal(r.json.sale.receiptNo, sale.receiptNo);
    assert.equal(r.json.payments.length, 1);
    assert.ok(r.json.sale.total > 0);
    // What a cashier does not: plate cost, COGS, the inventory legs.
    assert.equal(r.json.sale.cogs, null);
    assert.ok(r.json.lines.every((l) => l.lineCost === null && l.unitCost === null));
    assert.ok(r.json.stock.every((m) => m.value === null));
    const codes = r.json.journal.lines.map((l) => l.account);
    assert.ok(!codes.includes('5000') && !codes.includes('1100'),
      'the cost of sales legs are stripped, not merely hidden by the client');
    assert.equal(r.json.journal.partial, true, 'and it says so');
  });

  test('a cashier is told the trail is withheld, not that it is empty', async () => {
    const r = await asTill(`/orders/${sale.saleId}`);
    assert.equal(r.json.auditVisible, false);
    assert.equal(r.json.audit, null,
      'null, not [] — "you may not see this" is not "nothing happened"');
  });

  test("the day's COGS is withheld from a till session too", async () => {
    const r = await asTill(`/orders?date=${ctx.today}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.totals.cogs, null);
    assert.ok(r.json.totals.total > 0, 'but the takings are still there');
  });

  test('a guest token cannot read the orders of the outlet it is sitting in', async () => {
    const g = await H.post(`/api/outlet/${ctx.outletId}/guest/session`, { table: '6' });
    assert.equal(g.status, 200);
    const r = await H.req('GET', `/api/outlet/${ctx.outletId}/orders?date=${ctx.today}`,
      { token: g.json.token });
    assert.equal(r.status, 403);
    const one = await H.req('GET', `/api/outlet/${ctx.outletId}/orders/${sale.saleId}`,
      { token: g.json.token });
    assert.equal(one.status, 403);
  });

  test("another outlet's session cannot read this outlet's orders", async () => {
    const other = await H.bootOutlet();
    const r = await H.req('GET', `/api/outlet/${ctx.outletId}/orders?date=${ctx.today}`,
      { token: other.token });
    assert.equal(r.status, 403, 'the outlet in the path must be the outlet in the token');
  });

  /* ── the disagreement the system is built to surface ──────────────────── */

  test('a till that disagrees with the server is FLAGGED, not averaged in', async () => {
    const bill = H.priceIt(ctx, [['COLA', 1]]);
    const r = await H.push(ctx, [{ opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'takeaway', covers: 1,
        lines: [{ itemId: 'COLA', qty: 1 }],
        payments: [{ method: 'card', amount: bill.total / 100 }],
        clientTotal: (bill.total / 100) + 5,      // the till thinks it is MVR 5 more
      } }]);
    const id = r.json.results[0].result.saleId;

    const day = await asMgr(`/orders?date=${ctx.today}`);
    assert.ok(day.json.totals.mismatched >= 1, 'the day counts the disagreement');
    const row = day.json.closed.find((x) => x.saleId === id);
    assert.ok(row.mismatch !== null, 'and the row carries what the till said');

    const one = await asMgr(`/orders/${id}`);
    assert.equal(one.json.sale.mismatch, true);
    assert.ok(one.json.audit.some((a) => a.action === 'sale_total_mismatch'),
      'and the trail records it as an event, not just a difference');
  });

  /* ── paging ───────────────────────────────────────────────────────────── */

  test('paging returns a page but counts the whole day', async () => {
    const r = await asMgr(`/orders?date=${ctx.today}&limit=1&offset=0`);
    assert.equal(r.json.closed.length, 1);
    assert.ok(r.json.page.count > 1, 'the count is the day, not the page');
    assert.equal(r.json.totals.tickets, r.json.page.count);

    const p2 = await asMgr(`/orders?date=${ctx.today}&limit=1&offset=1`);
    assert.notEqual(p2.json.closed[0].saleId, r.json.closed[0].saleId);
    // The ribbon must read the same on page two. This is the whole reason the
    // totals are a separate query from the page.
    assert.equal(p2.json.totals.total.toFixed(2), r.json.totals.total.toFixed(2));
  });

  test('an absurd limit is clamped rather than obeyed', async () => {
    const r = await asMgr(`/orders?date=${ctx.today}&limit=100000`);
    assert.equal(r.status, 200);
    assert.ok(r.json.page.limit <= 200);
  });
});
