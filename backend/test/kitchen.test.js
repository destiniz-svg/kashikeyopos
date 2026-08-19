'use strict';
/* The kitchen chain — 02-POS-SPEC.md §4.
 *
 * A round is fired, the pass sees it, it moves Received → In the kitchen →
 * Ready → Served, and none of that touches the ledger. §37 of the brief:
 * "Do not couple kitchen display state directly to payment state." A guest
 * orders, eats and pays an hour apart, and a kitchen that waits on a card
 * machine is a kitchen that has stopped cooking.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('firing a round to the kitchen', () => {
  let ctx;
  before(async () => {
    ctx = await H.bootOutlet();
    // Two stations with DIFFERENT targets — the point of §4 is that a target is
    // configuration per station, so a test with one station proves nothing.
    await H.asOwner(ctx, 'INSERT INTO chain.station (outlet_id, name, target_mins, sort)'
      + " VALUES ($1,'Grill',14,0), ($1,'Bar',4,1)", [ctx.outletId]);
    await H.q(ctx, "UPDATE item SET station = 'Grill' WHERE id = 'BURGER'");
    await H.q(ctx, "UPDATE item SET station = 'Bar' WHERE id = 'COLA'");
  });
  after(() => H.teardown(ctx));

  test('a round opens a ticket and fires the stations it touches', async () => {
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T04', covers: 2, lines: [{ itemId: 'BURGER', qty: 2 }, { itemId: 'COLA', qty: 1 }] },
    }]);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const out = r.json.results[0].result;
    assert.ok(out.ticketId, JSON.stringify(r.json.results[0]));
    assert.deepEqual(out.fired.map((f) => f.station).sort(), ['Bar', 'Grill']);

    const t = await H.q(ctx, "SELECT status, covers FROM ticket WHERE table_no = 'T04'");
    assert.equal(t.rows[0].status, 'open');
    assert.equal(t.rows[0].covers, 2);
  });

  test('each station card carries its OWN target, not a shared constant', async () => {
    const k = await H.q(ctx, 'SELECT station, target_mins FROM kds_ticket ORDER BY station');
    const by = Object.fromEntries(k.rows.map((x) => [x.station, x.target_mins]));
    assert.equal(by.Grill, 14);
    assert.equal(by.Bar, 4);
  });

  test('a second round joins the SAME open ticket', async () => {
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T04', lines: [{ itemId: 'COLA', qty: 2 }] },
    }]);
    assert.equal(r.status, 200);
    const n = await H.q(ctx, "SELECT count(*)::int AS n FROM ticket WHERE table_no = 'T04'");
    assert.equal(n.rows[0].n, 1, 'one table, one open ticket');
    const lines = await H.q(ctx,
      "SELECT count(*)::int AS n FROM ticket_line l JOIN ticket t ON t.id = l.ticket_id"
      + " WHERE t.table_no = 'T04'");
    assert.equal(lines.rows[0].n, 3, 'and the new round appended to it');
  });

  test('every fired line is stamped sent_at', async () => {
    const l = await H.q(ctx,
      'SELECT count(*)::int AS n FROM ticket_line WHERE sent_at IS NULL');
    assert.equal(l.rows[0].n, 0, 'a round that reached the kitchen is a sent round');
  });

  test('firing the kitchen posts NOTHING to the ledger', async () => {
    // The whole point: a round is not a sale.
    const j = await H.q(ctx, 'SELECT count(*)::int AS n FROM journal');
    assert.equal(j.rows[0].n, 0);
    const s = await H.q(ctx, 'SELECT count(*)::int AS n FROM sale');
    assert.equal(s.rows[0].n, 0);
  });

  test('an unrouted dish still reaches the pass', async () => {
    // A configuration gap must not become a missing order.
    await H.q(ctx, "INSERT INTO item (id, name, category, price) VALUES ('SOUP','Soup','Food',30.00)"
      + ' ON CONFLICT (id) DO NOTHING');
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T07', lines: [{ itemId: 'SOUP', qty: 1 }] },
    }]);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.results[0].result.fired.length, 1,
      'it landed on the first configured station rather than vanishing');
  });

  test('an unknown item is refused', async () => {
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T08', lines: [{ itemId: 'GHOST', qty: 1 }] },
    }]);
    assert.match(r.json.results[0].error, /unknown or inactive item/i);
  });

  test('REPLAY: the same round twice fires once', async () => {
    const op = {
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T09', lines: [{ itemId: 'COLA', qty: 1 }] },
    };
    await H.push(ctx, [op]);
    const again = await H.push(ctx, [op]);
    assert.equal(again.json.results[0].replay, true);
    const n = await H.q(ctx,
      "SELECT count(*)::int AS n FROM ticket_line l JOIN ticket t ON t.id = l.ticket_id"
      + " WHERE t.table_no = 'T09'");
    assert.equal(n.rows[0].n, 1, 'one line, not two');
  });
});

describe('moving a round along the pass', () => {
  let ctx, kdsId;
  before(async () => {
    ctx = await H.bootOutlet();
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T01', lines: [{ itemId: 'BURGER', qty: 1 }] },
    }]);
    const k = await H.q(ctx, 'SELECT id FROM kds_ticket LIMIT 1');
    kdsId = k.rows[0].id;
  });
  after(() => H.teardown(ctx));

  const advance = (stage, token) => H.push({ ...ctx, token: token || ctx.token }, [{
    opId: H.uuid(), kind: 'kds_advance', at: Date.now(), payload: { kdsId, stage },
  }]);

  test('a new round starts at Received', async () => {
    const k = await H.q(ctx, 'SELECT stage FROM kds_ticket WHERE id = $1', [kdsId]);
    assert.equal(k.rows[0].stage, 'Received');
  });

  test('it advances through the stages in order', async () => {
    for (const stage of ['In the kitchen', 'Ready', 'Served']) {
      const r = await advance(stage);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.results[0].result.stage, stage);
    }
    const k = await H.q(ctx, 'SELECT stage, ready_at, served_at FROM kds_ticket WHERE id = $1', [kdsId]);
    assert.equal(k.rows[0].stage, 'Served');
    assert.ok(k.rows[0].ready_at, 'Ready stamped a time');
    assert.ok(k.rows[0].served_at, 'Served stamped a time');
  });

  test('a stage never moves BACKWARD', async () => {
    /* Dragging a served ticket back to the kitchen would restart a timer
       against a target that was already met, quietly rewriting the kitchen's
       own performance. */
    const r = await advance('In the kitchen');
    assert.equal(r.json.results[0].result.unchanged, true);
    const k = await H.q(ctx, 'SELECT stage FROM kds_ticket WHERE id = $1', [kdsId]);
    assert.equal(k.rows[0].stage, 'Served');
  });

  test('re-tapping the current stage is a no-op, not an error', async () => {
    // Two hands on two screens, or a replayed op. It must be safe.
    const r = await advance('Served');
    assert.equal(r.json.results[0].result.unchanged, true);
  });

  test('an unknown stage is refused', async () => {
    const r = await advance('Plated-ish');
    assert.match(r.json.results[0].error, /unknown stage/i);
  });

  test('the stage change is in the audit trail, before and after', async () => {
    const a = await H.q(ctx,
      "SELECT before, after FROM chain.audit WHERE action = 'kds_stage'"
      + ' ORDER BY at DESC LIMIT 1');
    assert.ok(a.rows.length, 'the pass is attributable like everything else');
    assert.ok(a.rows[0].before.stage);
    assert.ok(a.rows[0].after.stage);
  });

  test('a KITCHEN rank can drive the pass but cannot sell', async () => {
    /* §1.5's ladder earns its keep here: the kitchen is rank 1 precisely so a
       hand at the pass can work their own screen without a session that could
       take money. */
    const cook = await H.addStaff(ctx, 'Cook', 1);
    const send = await H.push({ ...ctx, token: cook.token }, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'dine_in', covers: 1,
        lines: [{ itemId: 'COLA', qty: 1 }],
        payments: [{ method: 'cash', amount: '27.50' }],
      },
    }]);
    /* /sync/push is a BATCH: the transport accepts the request and each
       operation carries its own verdict, so the refusal is in the result and
       not in the HTTP status. One bad op in a batch must not fail the ops
       around it. */
    assert.equal(send.status, 200);
    assert.match(send.json.results[0].error, /sale needs rank 2/,
      'rank 1 is below till rank');

    const k = await H.q(ctx, 'SELECT id FROM kds_ticket LIMIT 1');
    const move = await H.push({ ...ctx, token: cook.token }, [{
      opId: H.uuid(), kind: 'kds_advance', at: Date.now(),
      payload: { kdsId: k.rows[0].id, stage: 'Ready' },
    }]);
    assert.equal(move.status, 200, 'but the pass is theirs');
  });
});
