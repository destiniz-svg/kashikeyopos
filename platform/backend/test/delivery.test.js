'use strict';
/* Delivery & QR — §2 (`delivery`), 08-BUILD-STAGES §15.
 *
 * §14's acceptance criterion is the test plan: "A guest orders from a phone,
 * the till accepts it, the kitchen sees it, the guest's tracker follows it."
 *
 * Every clause of that was failing. The round arrived as jsonb, the accept
 * stamped a timestamp and took a ticket id nothing ever created, so the kitchen
 * never saw the food and the tracker had nothing to follow. This file walks the
 * whole sentence, in order.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('delivery and QR', () => {
  let ctx, mgr, guest;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
    const g = await H.post(`/api/outlet/${ctx.outletId}/guest/session`, { table: '3' });
    guest = g.json.token;
  });
  after(() => H.teardown(ctx));

  const req = (method, p, body, token) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: token || ctx.token });
  const get = (p, token) => req('GET', p, undefined, token);
  /* A guest's round, posted the way the phone posts it. */
  const round = (lines, extra) =>
    H.req('POST', `/api/outlet/${ctx.outletId}/guest/order`,
      { body: { table: '3', lines, opId: H.uuid(), ...extra }, token: guest });
  const guestSnap = () =>
    H.req('GET', `/api/outlet/${ctx.outletId}/snapshot`, { token: guest });

  /* ── a guest orders from a phone ──────────────────────────────────────── */

  test('an empty board is a quiet evening, not an error', async () => {
    const r = await get('/delivery');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.waiting, []);
    assert.equal(r.json.totals.waiting, 0);
    assert.equal(r.json.totals.oldestWait, 0);
  });

  test('a round from a phone lands on the till\'s board', async () => {
    const r = await round([{ itemId: 'BURGER', qty: 2 }]);
    assert.equal(r.status, 201, r.text);

    const board = await get('/delivery');
    assert.equal(board.json.waiting.length, 1);
    const o = board.json.waiting[0];
    assert.equal(o.tableNo, '3');
    assert.equal(o.channel, 'dine_in');
    assert.equal(o.source, 'qr');
    assert.equal(o.items, 2);
    assert.equal(o.stage, 'waiting for the till');
  });

  test('the board says how long the OLDEST one has waited', async () => {
    /* A count of five says nothing. "The oldest has been there eleven minutes"
       is the decision. */
    const board = await get('/delivery');
    assert.equal(typeof board.json.totals.oldestWait, 'number');
    assert.equal(board.json.waiting[0].waitingMins, board.json.totals.oldestWait);
  });

  /* ── the till accepts it, AND THE KITCHEN SEES IT ─────────────────────── */

  test('accepting turns the round into a real ticket on the pass', async () => {
    /* The clause that was missing entirely. `accepted_at` was stamped and
       nothing else happened: no ticket, no lines, no kitchen. */
    const board = await get('/delivery');
    const o = board.json.waiting[0];

    const r = await req('POST', `/delivery/${o.id}/accept`, {});
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.ticketId, 'a ticket exists now');
    assert.match(r.json.message, /kitchen has it/);

    const t = await H.q(ctx,
      'SELECT table_no, status FROM ticket WHERE id = $1', [r.json.ticketId]);
    assert.equal(t.rows[0].table_no, '3', 'at the guest\'s own table');
    assert.equal(t.rows[0].status, 'open');

    const lines = await H.q(ctx,
      'SELECT item_id, qty, sent_at FROM ticket_line WHERE ticket_id = $1',
      [r.json.ticketId]);
    assert.equal(lines.rows.length, 1);
    assert.equal(lines.rows[0].item_id, 'BURGER');
    assert.equal(Number(lines.rows[0].qty), 2);
    assert.ok(lines.rows[0].sent_at, 'and it was FIRED, not just written down');
  });

  test('the kitchen display has a card for it', async () => {
    const k = await H.q(ctx,
      "SELECT station, stage FROM kds_ticket WHERE served_at IS NULL");
    assert.ok(k.rows.length >= 1, 'the pass has it');
    assert.equal(k.rows[0].stage, 'Received');
  });

  test('accepting twice does not cook it twice', async () => {
    /* A till that lost its connection between the update and the reply will
       press again. */
    const board = await get('/delivery');
    const o = board.json.kitchen[0];
    const again = await req('POST', `/delivery/${o.id}/accept`, {});
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.already, true);

    const lines = await H.q(ctx,
      'SELECT count(*)::int AS n FROM ticket_line WHERE ticket_id = $1', [o.ticketId]);
    assert.equal(lines.rows[0].n, 1, 'still one line, not two');
  });

  /* ── the guest's tracker follows it ───────────────────────────────────── */

  test('the guest\'s own phone can see what became of their round', async () => {
    /* The tracker used to match its stage with a predicate that could never be
       true, because nothing linked a round to the ticket it became. */
    const s = await guestSnap();
    assert.equal(s.status, 200, s.text);
    assert.ok(Array.isArray(s.json.guestOrders));
    const o = s.json.guestOrders[0];
    assert.equal(o.stage, 'in the kitchen');
    assert.ok(o.ticketId, 'and it names the ticket');
    /* Which is the ticket the SAME snapshot carries stages for. */
    assert.ok(s.json.stages.some((k) => k.ticket_id === o.ticketId),
      'so a stage can actually be matched');
  });

  test('a guest is told nothing about the till', async () => {
    const s = await guestSnap();
    const o = s.json.guestOrders[0];
    assert.equal(o.acceptedBy, undefined);
    assert.equal(o.phone, undefined);
    assert.equal(o.fee, undefined);
  });

  test('the NEXT party at the same table does not read the last one\'s order',
    async () => {
      /* A table turns over. The phone of whoever sits down next asked the same
         question — "what is happening with table 3" — and used to be told,
         which is the previous party's evening, not theirs. */
      const s = await guestSnap();
      const mine = s.json.guestOrders[0];
      assert.ok(mine.ticketId, 'it went on a ticket');

      /* closed_at as well as the status: the schema will not let a ticket be
         closed without the moment it closed, which is the same rule the
         settlement path obeys. */
      await H.q(ctx, "UPDATE ticket SET status = 'closed', closed_at = now() WHERE id = $1",
        [mine.ticketId]);
      const after = await guestSnap();
      assert.ok(!after.json.guestOrders.some((o) => o.id === mine.id),
        'settled with the party that ordered it');
      /* And it is off the till's live board too, rather than sitting under
         "being cooked" for the rest of the night. */
      const board = await get('/delivery');
      assert.ok(!board.json.kitchen.some((o) => o.id === mine.id));

      await H.q(ctx, "UPDATE ticket SET status = 'open', closed_at = NULL WHERE id = $1",
        [mine.ticketId]);
    });

  test('another table\'s orders are not the guest\'s business', async () => {
    const other = await H.post(`/api/outlet/${ctx.outletId}/guest/session`, { table: '4' });
    const s = await H.req('GET', `/api/outlet/${ctx.outletId}/snapshot`,
      { token: other.json.token });
    assert.deepEqual(s.json.guestOrders, []);
  });

  /* ── turning one down ─────────────────────────────────────────────────── */

  test('a rejection needs a reason a guest can act on', async () => {
    await round([{ itemId: 'COLA', qty: 1 }]);
    const board = await get('/delivery');
    const o = board.json.waiting[0];
    const bad = await req('POST', `/delivery/${o.id}/reject`, { reason: 'no' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /say why/);
  });

  test('a rejected round says so ON THE GUEST\'S PHONE', async () => {
    /* Before this it stayed "awaiting the till" for ever and the guest sat
       there waiting for a drink nobody was making. */
    const board = await get('/delivery');
    const o = board.json.waiting[0];
    const r = await req('POST', `/delivery/${o.id}/reject`,
      { reason: 'we have run out of cola' });
    assert.equal(r.status, 200, r.text);

    const s = await guestSnap();
    const mine = s.json.guestOrders.find((x) => x.id === o.id);
    assert.equal(mine.stage, 'rejected');
    assert.equal(mine.rejectedReason, 'we have run out of cola');
  });

  test('a rejected round cannot then be accepted', async () => {
    const board = await get('/delivery');
    const gone = board.json.done.find((x) => x.rejectedAt);
    const r = await req('POST', `/delivery/${gone.id}/accept`, {});
    assert.equal(r.status, 409);
    assert.match(r.json.error, /already turned down/);
  });

  /* ── an order the till took itself ────────────────────────────────────── */

  test('a delivery with no address is refused while the customer is still on the telephone',
    async () => {
      const r = await req('POST', '/delivery', {
        channel: 'delivery', source: 'phone', lines: [{ itemId: 'BURGER', qty: 1 }],
      });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /where is it going/);
    });

  test('a telephone delivery is taken, and goes to the Delivery slot', async () => {
    const r = await req('POST', '/delivery', {
      channel: 'delivery', source: 'phone', address: 'Ameenee Magu, house 12',
      name: 'Ahmed', phone: '7779999', fee: 30,
      lines: [{ itemId: 'BURGER', qty: 1 }, { itemId: 'COLA', qty: 2 }],
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.channel, 'delivery');
    assert.equal(r.json.tableNo, 'Delivery', 'the slot the floor already draws');
    assert.equal(r.json.fee, 30);
    assert.equal(r.json.items, 3);
  });

  test('an aggregator order carries its own reference', async () => {
    /* Which is what somebody rings the aggregator about when it goes wrong. */
    const r = await req('POST', '/delivery', {
      channel: 'delivery', source: 'aggregator', extRef: 'AGG-88213',
      address: 'Boduthakurufaanu Magu', lines: [{ itemId: 'BURGER', qty: 1 }],
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.extRef, 'AGG-88213');
    assert.equal(r.json.source, 'aggregator');
  });

  /* ── the rider leg ────────────────────────────────────────────────────── */

  test('a delivery cannot be dispatched before it is accepted', async () => {
    const board = await get('/delivery');
    const d = board.json.waiting.find((x) => x.channel === 'delivery');
    const r = await req('POST', `/delivery/${d.id}/dispatch`, { rider: 'Nashid' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /accepted delivery/);
  });

  test('an accepted delivery goes out with a NAMED rider', async () => {
    const board = await get('/delivery');
    const d = board.json.waiting.find((x) => x.channel === 'delivery');
    const a = await req('POST', `/delivery/${d.id}/accept`, {});
    assert.equal(a.status, 200, a.text);
    assert.equal(a.json.stage, 'in the kitchen');

    const noName = await req('POST', `/delivery/${d.id}/dispatch`, {});
    assert.equal(noName.status, 400);
    assert.match(noName.json.error, /who is taking it/);

    const r = await req('POST', `/delivery/${d.id}/dispatch`, { rider: 'Nashid' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.stage, 'with the rider');
    assert.equal(r.json.rider, 'Nashid');
  });

  test('it arrives, and leaves the board', async () => {
    const board = await get('/delivery');
    assert.equal(board.json.riding.length, 1);
    const d = board.json.riding[0];
    const r = await req('POST', `/delivery/${d.id}/delivered`, {});
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.stage, 'delivered');

    const after = await get('/delivery');
    assert.equal(after.json.riding.length, 0);
    assert.ok(after.json.done.some((x) => x.id === d.id));
  });

  test('an order with no rider cannot have arrived', async () => {
    const board = await get('/delivery');
    const still = board.json.kitchen[0];
    const r = await req('POST', `/delivery/${still.id}/delivered`, {});
    assert.equal(r.status, 409);
    assert.match(r.json.error, /with a rider/);
  });

  /* ── who may work it ──────────────────────────────────────────────────── */

  test('the whole board is TILL rank', async () => {
    assert.equal((await get('/delivery', ctx.token)).status, 200);
    assert.equal((await get('/delivery', mgr.token)).status, 200);
  });

  test('a kitchen session reaches none of it', async () => {
    const kds = await H.addStaff(ctx, 'Chef', 1);
    assert.equal((await get('/delivery', kds.token)).status, 403);
  });

  test('a guest token cannot read the board or accept anything', async () => {
    assert.equal((await get('/delivery', guest)).status, 403);
    const board = await get('/delivery');
    const any = board.json.done[0];
    const r = await H.req('POST', `/api/outlet/${ctx.outletId}/delivery/${any.id}/accept`,
      { body: {}, token: guest });
    assert.equal(r.status, 403);
  });
});
