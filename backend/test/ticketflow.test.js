'use strict';
/* THE TICKET, END TO END — 02-POS-SPEC.md §3.3 and §3.4.
 *
 * Every one of these covers a break that a passing test suite did not catch,
 * because each was a gap BETWEEN two things that each worked: the till knew
 * how to fire a round and the server knew how to settle a sale, and nothing
 * asked whether the sale it settled was the ticket it had fired.
 *
 *   · A sale carrying no ticketId left the ticket open. The table stayed
 *     shaded busy for the rest of the day and the same meal sat on the Orders
 *     board twice — once as an unsettled tab and once as a receipt.
 *   · The snapshot handed the till lines with no id on them, so the ticket
 *     panel could only ever be a picture of a bill: it could not settle THIS
 *     ticket or void THIS line.
 *   · `void_at` was read by five queries and written by nothing, so a dish
 *     keyed by mistake could not be taken off a tab by anybody at any rank.
 *   · `ticket.split` was in the unique index from the first migration and
 *     every insert wrote a literal 0, so a table could hold exactly one bill.
 *   · The snapshot asked chain.station directly while the fire path asked
 *     kitchen.stationsFor(), which supplies an implicit pass. In a default
 *     outlet the two disagreed and every KDS card listed no food at all.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const snapshot = (ctx) =>
  H.req('GET', `/api/outlet/${ctx.outletId}/snapshot`, { token: ctx.token });
const board = (ctx) =>
  H.req('GET', `/api/outlet/${ctx.outletId}/orders`, { token: ctx.token });

describe('a ticket is a thing the till can hold', () => {
  let ctx;
  before(async () => { ctx = await H.bootOutlet(); });
  after(() => H.teardown(ctx));

  test('the snapshot gives staff the line id and item id a ticket is worked by', async () => {
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T01', covers: 2, lines: [{ itemId: 'BURGER', qty: 2 }] },
    }]);
    const s = await snapshot(ctx);
    const t = s.json.tickets.find((x) => x.table_no === 'T01');
    assert.ok(t, 'the ticket is in the snapshot');
    assert.ok(t.lines[0].id, 'a line carries its own id');
    assert.equal(t.lines[0].itemId, 'BURGER', 'and the item it is');
  });

  test('an outlet that has configured no stations still gets its pass', async () => {
    const s = await snapshot(ctx);
    assert.ok(s.json.stations.length > 0,
      'the snapshot supplies the implicit pass, as the fire path does');
    const fired = await H.q(ctx, 'SELECT DISTINCT station FROM kds_ticket');
    assert.deepEqual(
      s.json.stations.map((x) => x.name).sort(), fired.rows.map((r) => r.station).sort(),
      'and it is the SAME station the round was fired to — the disagreement '
      + 'between these two lists is what emptied every card');
  });

  test('settling with the ticket id closes it, and the receipt keeps the table', async () => {
    const before = await board(ctx);
    const tk = before.json.open.find((o) => o.table === 'T01');
    assert.ok(tk, 'the tab is on the board before it is paid');

    const s = await snapshot(ctx);
    const t = s.json.tickets.find((x) => x.table_no === 'T01');
    const lines = t.lines.map((l) => ({ itemId: l.itemId, qty: Number(l.qty) }));
    /* 2 burgers at 85.00 = 170.00 goods, +10% service = 187.00. The server
       derives this; the total is sent only so it can disagree. */
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'dine_in', covers: 2,
        ticketId: tk.ticketId, lines,
        payments: [{ method: 'cash', amount: '187.00' }], clientTotal: '187.00',
      },
    }]);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.results[0].result.receiptNo, JSON.stringify(r.json.results[0]));

    const after = await board(ctx);
    assert.equal(after.json.open.filter((o) => o.table === 'T01').length, 0,
      'the tab is off the floor');
    const sale = after.json.closed.find((c) => c.receiptNo === r.json.results[0].result.receiptNo);
    assert.equal(sale.table, 'T01', 'and the receipt says which table it was');

    const row = await H.q(ctx, "SELECT status FROM ticket WHERE table_no = 'T01'");
    assert.equal(row.rows[0].status, 'closed');
  });

  test('a paid ticket whose food is still on the pass keeps its card', async () => {
    /* Paid does not mean served — a takeaway settled at the counter is the
       ordinary case — so the snapshot still carries it for the kitchen, and
       it is the STATUS that tells the floor the table is free. */
    const s = await snapshot(ctx);
    const t = s.json.tickets.find((x) => x.table_no === 'T01');
    assert.ok(t, 'still in the snapshot for the pass');
    assert.equal(t.status, 'closed', 'flagged closed so the floor can drop it');
    assert.ok(t.lines.length > 0, 'with the dishes the cook still has to make');
  });
});

describe('taking a line off a bill', () => {
  let ctx, mgr, lineId;
  before(async () => {
    ctx = await H.bootOutlet();
    /* bootOutlet signs in a TILL. Voiding a line the kitchen already has is a
       manager's signature, so the suite needs both to prove the rule. */
    mgr = await H.addStaff(ctx, 'Test Manager', 3);
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T02', covers: 1, lines: [{ itemId: 'BURGER', qty: 1 }, { itemId: 'COLA', qty: 1 }] },
    }]);
    const s = await snapshot(ctx);
    lineId = s.json.tickets.find((x) => x.table_no === 'T02').lines.find((l) => l.itemId === 'COLA').id;
  });
  after(() => H.teardown(ctx));

  test('a void with no reason is refused', async () => {
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_line_void', at: Date.now(), payload: { lineId },
    }]);
    assert.match(String(r.json.results[0].error), /reason/);
  });

  test('a till cannot take off a line the kitchen already has', async () => {
    const r = await H.push({ ...ctx }, [{
      opId: H.uuid(), kind: 'ticket_line_void', at: Date.now(),
      payload: { lineId, reason: 'keyed twice' },
    }]);
    assert.match(String(r.json.results[0].error), /manager/,
      'the food was cooked; writing it off is a signature from above the till');
    const row = await H.q(ctx, 'SELECT void_at FROM ticket_line WHERE id = $1', [lineId]);
    assert.equal(row.rows[0].void_at, null, 'and nothing happened to the line');
  });

  test('a manager can, and it stays on the ticket as voided', async () => {
    const r = await H.push({ ...ctx, token: mgr.token }, [{
      opId: H.uuid(), kind: 'ticket_line_void', at: Date.now(),
      payload: { lineId, reason: 'keyed twice' },
    }]);
    assert.equal(r.json.results[0].result.lineId, lineId, JSON.stringify(r.json.results[0]));

    const row = await H.q(ctx, 'SELECT void_at, void_reason FROM ticket_line WHERE id = $1', [lineId]);
    assert.ok(row.rows[0].void_at, 'not deleted — voided');
    assert.equal(row.rows[0].void_reason, 'keyed twice');

    const s = await snapshot(ctx);
    const t = s.json.tickets.find((x) => x.table_no === 'T02');
    assert.equal(t.lines.length, 1, 'and it is off the bill the cashier sees');
  });

  test('replaying the same void is idempotent', async () => {
    const r = await H.push({ ...ctx, token: mgr.token }, [{
      opId: H.uuid(), kind: 'ticket_line_void', at: Date.now(),
      payload: { lineId, reason: 'keyed twice' },
    }]);
    assert.equal(r.json.results[0].result.already, true,
      'a till replaying its own queued work must not be told it was an error');
  });

  test('it is in the audit trail with what it was worth', async () => {
    const log = await H.asOwner(ctx,
      "SELECT action, after FROM chain.audit WHERE action = 'ticket_line_void'"
      + ' AND outlet_id = $1 ORDER BY at DESC LIMIT 1', [ctx.outletId]);
    assert.equal(log.rows.length, 1);
    assert.equal(log.rows[0].after.reason, 'keyed twice');
    assert.equal(log.rows[0].after.wasSent, true);
  });
});

describe('separate bills on one table', () => {
  let ctx;
  before(async () => { ctx = await H.bootOutlet(); });
  after(() => H.teardown(ctx));

  test('two splits are two tickets, not one read twice', async () => {
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T03', split: 0, covers: 3, lines: [{ itemId: 'BURGER', qty: 1 }] },
    }]);
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T03', split: 1, covers: 1, lines: [{ itemId: 'COLA', qty: 2 }] },
    }]);
    const s = await snapshot(ctx);
    const bills = s.json.tickets.filter((x) => x.table_no === 'T03').sort((a, b) => a.split - b.split);
    assert.equal(bills.length, 2);
    assert.deepEqual(bills.map((b) => b.split), [0, 1]);
    assert.notEqual(bills[0].id, bills[1].id);
  });

  test('a second round joins the split it names, not the table', async () => {
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T03', split: 1, lines: [{ itemId: 'BURGER', qty: 1 }] },
    }]);
    const s = await snapshot(ctx);
    const bills = s.json.tickets.filter((x) => x.table_no === 'T03').sort((a, b) => a.split - b.split);
    assert.equal(bills[0].lines.length, 1, "the table's own bill is untouched");
    assert.equal(bills[1].lines.length, 2, "the guest's bill took the round");
  });

  test('paying one leaves the other open', async () => {
    const s = await snapshot(ctx);
    const guest = s.json.tickets.filter((x) => x.table_no === 'T03').find((x) => x.split === 1);
    /* 2 colas at 25.00 and a burger at 85.00 = 135.00, +10% = 148.50. */
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'dine_in', covers: 1, ticketId: guest.id,
        lines: guest.lines.map((l) => ({ itemId: l.itemId, qty: Number(l.qty) })),
        payments: [{ method: 'card', amount: '148.50' }], clientTotal: '148.50',
      },
    }]);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.results[0].result.receiptNo, JSON.stringify(r.json.results[0]));

    const open = await H.q(ctx,
      "SELECT split FROM ticket WHERE table_no = 'T03' AND status = 'open'");
    assert.deepEqual(open.rows.map((x) => x.split), [0],
      "the table's own bill is still open");
  });
});

describe('a bill paid more than one way', () => {
  let ctx;
  before(async () => { ctx = await H.bootOutlet(); });
  after(() => H.teardown(ctx));

  test('cash and card on one sale post to their own accounts', async () => {
    /* 1 burger 85.00 + 1 cola 25.00 = 110.00, +10% service = 121.00. */
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'takeaway', covers: 1,
        lines: [{ itemId: 'BURGER', qty: 1 }, { itemId: 'COLA', qty: 1 }],
        payments: [{ method: 'cash', amount: '50.00' }, { method: 'card', amount: '71.00' }],
        clientTotal: '121.00',
      },
    }]);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const saleId = r.json.results[0].result.saleId;

    const pay = await H.q(ctx,
      'SELECT method, amount FROM payment WHERE sale_id = $1 ORDER BY method', [saleId]);
    assert.deepEqual(pay.rows.map((x) => [x.method, Number(x.amount)]),
      [['card', 71], ['cash', 50]], 'two payment rows, not one merged figure');

    /* 1000 is cash, 1020 is the card float — the split has to reach the ledger
       as a split or the drawer expects money the card took. */
    const j = await H.q(ctx,
      'SELECT l.account_code, l.dr FROM journal_line l JOIN journal j ON j.id = l.journal_id'
      + " WHERE j.source_id = $1 AND l.dr > 0 AND l.account_code IN ('1000','1020')"
      + ' ORDER BY l.account_code', [saleId]);
    assert.deepEqual(j.rows.map((x) => [x.account_code, Number(x.dr)]),
      [['1000', 50], ['1020', 71]]);
  });

  test('a bank transfer is a tender the till can name', async () => {
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'takeaway', covers: 1,
        lines: [{ itemId: 'COLA', qty: 1 }],
        payments: [{ method: 'bank', amount: '27.50' }], clientTotal: '27.50',
      },
    }]);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const j = await H.q(ctx,
      'SELECT l.dr FROM journal_line l JOIN journal j ON j.id = l.journal_id'
      + " WHERE j.source_id = $1 AND l.account_code = '1010' AND l.dr > 0",
      [r.json.results[0].result.saleId]);
    assert.equal(Number(j.rows[0].dr), 27.5, 'it lands in the bank, not the drawer');
  });
});

describe('giving a table back without a sale', () => {
  let ctx, mgr;
  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Test Manager', 3);
  });
  after(() => H.teardown(ctx));

  test('a ticket with nothing on it could not be settled by anybody', async () => {
    /* The shape a reservation leaves behind: a party seated, a table held, and
       nothing ordered. sale.js refuses a sale with no lines — rightly — so
       before ticket_void existed the table stayed busy until closing. */
    await H.asOwner(ctx,
      "INSERT INTO " + ctx.schema + ".ticket (table_no, split, channel, status, covers)"
      + " VALUES ('T07', 0, 'dine_in', 'open', 2)");
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'dine_in', covers: 2, lines: [],
        payments: [{ method: 'cash', amount: '0.00' }],
      },
    }]);
    assert.match(String(r.json.results[0].error), /at least one line/);
  });

  test('a till can give an empty table back', async () => {
    const t = await H.q(ctx, "SELECT id FROM ticket WHERE table_no = 'T07'");
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_void', at: Date.now(), payload: { ticketId: t.rows[0].id },
    }]);
    assert.equal(r.json.results[0].result.table, 'T07', JSON.stringify(r.json.results[0]));
    const row = await H.q(ctx, "SELECT status FROM ticket WHERE table_no = 'T07'");
    assert.equal(row.rows[0].status, 'void', 'void, not closed — nothing was paid');
  });

  test('a till cannot write off a bill the kitchen cooked', async () => {
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T08', covers: 2, lines: [{ itemId: 'BURGER', qty: 2 }] },
    }]);
    const t = await H.q(ctx, "SELECT id FROM ticket WHERE table_no = 'T08'");
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_void', at: Date.now(),
      payload: { ticketId: t.rows[0].id, reason: 'walked out' },
    }]);
    assert.match(String(r.json.results[0].error), /manager/);
    const row = await H.q(ctx, "SELECT status FROM ticket WHERE table_no = 'T08'");
    assert.equal(row.rows[0].status, 'open', 'and the bill is untouched');
  });

  test('a manager needs a reason, and every line is voided by name', async () => {
    const t = await H.q(ctx, "SELECT id FROM ticket WHERE table_no = 'T08'");
    const bare = await H.push({ ...ctx, token: mgr.token }, [{
      opId: H.uuid(), kind: 'ticket_void', at: Date.now(), payload: { ticketId: t.rows[0].id },
    }]);
    assert.match(String(bare.json.results[0].error), /reason/);

    const r = await H.push({ ...ctx, token: mgr.token }, [{
      opId: H.uuid(), kind: 'ticket_void', at: Date.now(),
      payload: { ticketId: t.rows[0].id, reason: 'walked out' },
    }]);
    assert.equal(r.json.results[0].result.lines, 1, JSON.stringify(r.json.results[0]));
    assert.equal(Number(r.json.results[0].result.value), 170);

    const lines = await H.q(ctx,
      'SELECT void_at, void_reason FROM ticket_line WHERE ticket_id = $1', [t.rows[0].id]);
    assert.ok(lines.rows.every((l) => l.void_at), 'itemised, not one number at the ticket');
    assert.equal(lines.rows[0].void_reason, 'walked out');
  });

  test('and the kitchen card goes with it', async () => {
    const t = await H.q(ctx, "SELECT id FROM ticket WHERE table_no = 'T08'");
    const k = await H.q(ctx,
      'SELECT served_at FROM kds_ticket WHERE ticket_id = $1', [t.rows[0].id]);
    assert.ok(k.rows.length > 0);
    assert.ok(k.rows.every((x) => x.served_at),
      'a card for a bill that no longer exists is worse than no card');
  });

  test('a settled ticket is never voided over', async () => {
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T09', covers: 1, lines: [{ itemId: 'COLA', qty: 1 }] },
    }]);
    const t = await H.q(ctx, "SELECT id FROM ticket WHERE table_no = 'T09'");
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'dine_in', covers: 1, ticketId: t.rows[0].id,
        lines: [{ itemId: 'COLA', qty: 1 }],
        payments: [{ method: 'cash', amount: '27.50' }], clientTotal: '27.50',
      },
    }]);
    const r = await H.push({ ...ctx, token: mgr.token }, [{
      opId: H.uuid(), kind: 'ticket_void', at: Date.now(),
      payload: { ticketId: t.rows[0].id, reason: 'changed my mind' },
    }]);
    assert.match(String(r.json.results[0].error), /credit note/);
  });

  test('replaying a void is idempotent', async () => {
    const t = await H.q(ctx, "SELECT id FROM ticket WHERE table_no = 'T08'");
    const r = await H.push({ ...ctx, token: mgr.token }, [{
      opId: H.uuid(), kind: 'ticket_void', at: Date.now(),
      payload: { ticketId: t.rows[0].id, reason: 'walked out' },
    }]);
    assert.equal(r.json.results[0].result.already, true);
  });

  test('the write-off is in the audit trail with what it was worth', async () => {
    const log = await H.asOwner(ctx,
      "SELECT after FROM chain.audit WHERE action = 'ticket_void' AND outlet_id = $1"
      + " AND after->>'table' = 'T08' ORDER BY at DESC LIMIT 1", [ctx.outletId]);
    assert.equal(log.rows.length, 1);
    assert.equal(log.rows[0].after.reason, 'walked out');
    assert.equal(Number(log.rows[0].after.value), 170);
  });
});

describe('a dish taken off the menu mid-service', () => {
  let ctx;
  before(async () => { ctx = await H.bootOutlet(); });
  after(() => H.teardown(ctx));

  test('a bill carrying it can still be settled', async () => {
    /* `active` was in the WHERE clause of the price lookup, so retiring a dish
       at three in the afternoon made every open tab carrying it unsettleable
       for the rest of the day — refused with "inactive item", with no other way
       to close the ticket. You cannot RING UP something retired; you must be
       able to TAKE MONEY for something a guest was already served. */
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T05', covers: 1, lines: [{ itemId: 'BURGER', qty: 1 }] },
    }]);
    const t = await H.q(ctx, "SELECT id FROM ticket WHERE table_no = 'T05'");
    await H.q(ctx, "UPDATE item SET active = false WHERE id = 'BURGER'");

    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'dine_in', covers: 1, ticketId: t.rows[0].id,
        lines: [{ itemId: 'BURGER', qty: 1 }],
        payments: [{ method: 'cash', amount: '93.50' }], clientTotal: '93.50',
      },
    }]);
    assert.ok(r.json.results[0].result?.receiptNo, JSON.stringify(r.json.results[0]));
  });

  test('but it cannot be rung up onto a bill it was never on', async () => {
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'takeaway', covers: 1,
        lines: [{ itemId: 'BURGER', qty: 1 }],
        payments: [{ method: 'cash', amount: '93.50' }], clientTotal: '93.50',
      },
    }]);
    assert.match(String(r.json.results[0].error), /off the menu/);
  });
});
