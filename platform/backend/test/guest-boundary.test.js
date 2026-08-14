'use strict';
/* The guest QR portal is a separate security boundary (prompt §27, §28).
 *
 * A guest token is handed out to anyone who scans a card on a table. It is the
 * least trusted credential in the system, and the only thing standing between
 * it and the rest of the outlet is what this file asserts.
 *
 * The cases are written the way an attacker would try them, not the way the app
 * uses them — the app is not the threat model. Every one of these was reachable
 * before the change that added them: the snapshot returned EVERY open ticket in
 * the outlet, so a phone at table 4 could read what table 9 had eaten and what
 * they owed. Nothing in the UI showed it, which is exactly why it needed a test:
 * the client was the only thing keeping one party's bill off another's screen.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('the guest boundary', () => {
  let ctx, guest, otherGuest;

  before(async () => {
    ctx = await H.bootOutlet();

    // Two parties, two tables, each with a real open ticket and a real bill.
    await H.q(ctx, "INSERT INTO ticket (id, table_no, split, status, covers)"
      + " VALUES ('aaaaaaaa-0000-4000-8000-000000000001','4',0,'open',2)");
    await H.q(ctx, "INSERT INTO ticket_line (ticket_id, item_id, name, qty, unit_price)"
      + " VALUES ('aaaaaaaa-0000-4000-8000-000000000001','BURGER','Beef burger',2,85.00)");
    await H.q(ctx, "INSERT INTO ticket (id, table_no, split, status, covers)"
      + " VALUES ('aaaaaaaa-0000-4000-8000-000000000002','9',0,'open',4)");
    await H.q(ctx, "INSERT INTO ticket_line (ticket_id, item_id, name, qty, unit_price)"
      + " VALUES ('aaaaaaaa-0000-4000-8000-000000000002','COLA','Cola',7,25.00)");

    guest = (await H.post(`/api/outlet/${ctx.outletId}/guest/session`, { table: '4' })).json;
    otherGuest = (await H.post(`/api/outlet/${ctx.outletId}/guest/session`, { table: '9' })).json;
  });
  after(() => H.teardown(ctx));

  test('a card scan mints a token for that table', async () => {
    assert.ok(guest.token, JSON.stringify(guest));
    assert.equal(guest.table, '4');
    assert.equal(guest.outletId, ctx.outletId);
  });

  test('a table the outlet does not have is refused', async () => {
    // Otherwise anyone can mint a session for table 9999 and probe for real ones.
    const r = await H.post(`/api/outlet/${ctx.outletId}/guest/session`, { table: '9999' });
    assert.equal(r.status, 404);
    assert.match(r.json.error, /no such table/i);
  });

  test('a guest token carries no rank and no staff identity', async () => {
    const r = await H.req('GET', '/api/me', { token: guest.token });
    assert.equal(r.status, 200);
    assert.equal(r.json.rank, 0);
    assert.equal(r.json.actor, null);
    assert.equal(r.json.guest, true);
    assert.equal(r.json.table, '4');
  });

  test('IDOR: a guest sees only its OWN table\'s ticket', async () => {
    const r = await H.req('GET', `/api/outlet/${ctx.outletId}/snapshot`, { token: guest.token });
    assert.equal(r.status, 200);
    const tables = r.json.tickets.map((t) => t.table_no);
    assert.deepEqual(tables, ['4'], 'table 9 must not be in the projection at all');
    // And the bill it can see is its own.
    assert.equal(r.json.tickets[0].lines[0].name, 'Beef burger');
  });

  test('IDOR: the other party sees only theirs', async () => {
    const r = await H.req('GET', `/api/outlet/${ctx.outletId}/snapshot`, { token: otherGuest.token });
    const tables = r.json.tickets.map((t) => t.table_no);
    assert.deepEqual(tables, ['9']);
  });

  test('a staff session still sees the whole floor', async () => {
    // The scoping must not break the thing it is scoping for.
    const r = await H.req('GET', `/api/outlet/${ctx.outletId}/snapshot`, { token: ctx.token });
    const tables = r.json.tickets.map((t) => t.table_no).sort();
    assert.deepEqual(tables, ['4', '9']);
  });

  test('a guest cannot order for another table', async () => {
    const r = await H.post(`/api/outlet/${ctx.outletId}/guest/order`, {
      opId: H.uuid(), table: '9', lines: [{ itemId: 'COLA', qty: 40 }],
    }, guest.token);
    assert.equal(r.status, 403);
    assert.match(r.json.error, /table mismatch/i);
  });

  test('a guest cannot raise a request against another table', async () => {
    const r = await H.post(`/api/outlet/${ctx.outletId}/guest/request`, {
      table: '9', kind: 'bill',
    }, guest.token);
    assert.equal(r.status, 403);
  });

  test('a guest CAN order for its own table', async () => {
    const r = await H.post(`/api/outlet/${ctx.outletId}/guest/order`, {
      opId: H.uuid(), table: '4', lines: [{ itemId: 'COLA', qty: 1 }],
    }, guest.token);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.status, 'awaiting till');
  });

  test('a replayed guest order does not create a second order', async () => {
    const opId = H.uuid();
    const body = { opId, table: '4', lines: [{ itemId: 'COLA', qty: 2 }] };
    const a = await H.post(`/api/outlet/${ctx.outletId}/guest/order`, body, guest.token);
    const b = await H.post(`/api/outlet/${ctx.outletId}/guest/order`, body, guest.token);
    assert.equal(a.json.id, b.json.id, 'the replay returned the stored result');
    const n = await H.q(ctx, 'SELECT count(*)::int AS n FROM guest_order WHERE id = $1', [a.json.id]);
    assert.equal(n.rows[0].n, 1);
  });

  test('THE PHONE NEVER TAKES MONEY: a guest cannot reach the sale path', async () => {
    const r = await H.post(`/api/outlet/${ctx.outletId}/sync/push`, {
      ops: [{
        opId: H.uuid(), kind: 'sale', at: Date.now(),
        payload: {
          businessDate: ctx.today, channel: 'dine_in', covers: 1,
          lines: [{ itemId: 'COLA', qty: 1 }],
          payments: [{ method: 'cash', amount: '0.00' }],
        },
      }],
    }, guest.token);
    assert.equal(r.status, 403, 'a guest device must not be able to settle anything');
  });

  test('a guest cannot pull the till feed', async () => {
    const r = await H.req('GET', `/api/outlet/${ctx.outletId}/sync/pull?since=0`, { token: guest.token });
    assert.equal(r.status, 403);
  });

  test('a guest cannot read the estate', async () => {
    const r = await H.req('GET', '/api/estate/day', { token: guest.token });
    assert.equal(r.status, 403);
  });

  test('a guest cannot reach another OUTLET, whatever it asks for', async () => {
    const other = ctx.outletId + 1;
    const r = await H.req('GET', `/api/outlet/${other}/snapshot`, { token: guest.token });
    assert.equal(r.status, 403, 'sameOutlet refuses before the database is touched');
  });

  test('the projection carries no costs, margins or staff records', async () => {
    // 03-GUEST-PORTAL-SPEC.md §8: "It never reads costs, margins or staff
    // records — a guest device has no business holding those, so they are not
    // in the projection at all."
    const r = await H.req('GET', `/api/outlet/${ctx.outletId}/snapshot`, { token: guest.token });
    const blob = JSON.stringify(r.json);
    for (const forbidden of ['unit_cost', 'line_cost', 'cogs', 'avg_cost', 'pin_hash', 'pin_salt']) {
      assert.ok(!blob.includes(forbidden), forbidden + ' reached a guest device');
    }
    assert.ok(!('staff' in r.json));
  });

  test('a forged guest claim without a table is refused', async () => {
    // A token that says `g:true` but names no table must not fall through to a
    // staff-shaped context with a null table that scopes to everything.
    const { sign } = require('../src/secrets');
    const forged = sign({ o: ctx.outletId, g: true, exp: Date.now() + 60000 });
    const r = await H.req('GET', `/api/outlet/${ctx.outletId}/snapshot`, { token: forged });
    assert.equal(r.status, 401);
  });

  test('an expired guest token is refused', async () => {
    const { sign } = require('../src/secrets');
    const stale = sign({ o: ctx.outletId, g: true, tbl: '4', exp: Date.now() - 1000 });
    const r = await H.req('GET', `/api/outlet/${ctx.outletId}/snapshot`, { token: stale });
    assert.equal(r.status, 401);
  });

  test('a tampered token is refused', async () => {
    const parts = guest.token.split('.');
    const body = Buffer.from(JSON.stringify({
      o: ctx.outletId, g: true, tbl: '9', exp: Date.now() + 60000,
    })).toString('base64url');
    const r = await H.req('GET', `/api/outlet/${ctx.outletId}/snapshot`,
      { token: body + '.' + parts[1] });
    assert.equal(r.status, 401, 'the signature is over the body, so swapping the body breaks it');
  });
});
