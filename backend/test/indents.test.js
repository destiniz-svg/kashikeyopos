'use strict';
/* Indent Requests — 02-POS-SPEC §2 (`requests`).
 *
 * The chain this closes is the point of the file: `purchase_order` and
 * `po_line` have existed since the first migration, the PO document series has
 * been minting numbers, and NOTHING in this application had ever written a row
 * to either. Deliveries arrived against a supplier and no order at all, so what
 * was asked for and what turned up were never the same conversation.
 *
 *     the kitchen asks → a manager decides → it becomes an order →
 *     the delivery is received against that order
 *
 * Each arrow is a rank and a record, and the last one is tested here for the
 * first time.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('indent requests', () => {
  let ctx, mgr, admin, cook, supplierId;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Head Chef', 3);
    /* The supplier master is shared across the estate and carries payment
       terms, so writing it is ADMIN — a manager may order from a supplier
       without being able to invent one. */
    admin = await H.addStaff(ctx, 'Head Office', 4);
    cook = await H.addStaff(ctx, 'A Cook', 1);
    const s = await H.req('POST', `/api/outlet/${ctx.outletId}/vendors`,
      { body: { name: 'Island Provisions', termsDays: 14 }, token: admin.token });
    assert.equal(s.status, 201, s.text);
    supplierId = s.json.id;
  });
  after(() => H.teardown(ctx));

  const req = (method, p, body, token) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: token || mgr.token });
  const get = (p, token) => req('GET', p, undefined, token);

  test('an outlet with nothing asked for says so', async () => {
    const r = await get('/indents', cook.token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.indents, []);
    assert.equal(r.json.waiting, 0);
  });

  test('a KITCHEN hand can ask — that is the whole point', async () => {
    /* A request only a manager can enter is a request that gets made by
       shouting across a kitchen instead. */
    const r = await req('POST', '/indents', {
      forArea: 'the pass', note: 'weekend',
      lines: [{ ingredientId: 'BEEF', qty: 5000 }, { ingredientId: 'BUN', qty: 200 }],
    }, cook.token);
    assert.equal(r.status, 201, r.text);
    assert.match(r.json.ref, /-IND-/);
  });

  test('an empty one is not a request', async () => {
    assert.equal((await req('POST', '/indents', { lines: [] }, cook.token)).status, 400);
  });

  test('the same thing twice is a mistake, not a merge', async () => {
    const r = await req('POST', '/indents', {
      lines: [{ ingredientId: 'BEEF', qty: 1 }, { ingredientId: 'BEEF', qty: 2 }],
    }, cook.token);
    assert.equal(r.status, 400);
  });

  test('a cook cannot decide their own request', async () => {
    const list = await get('/indents', cook.token);
    const one = list.json.indents[0];
    assert.equal((await req('POST', `/indents/${one.id}/decide`, {}, cook.token)).status, 403);
  });

  test('the manager sees what the store already has beside what was asked for',
    async () => {
      const list = await get('/indents');
      const one = list.json.indents.find((i) => i.forArea === 'the pass');
      const beef = one.lines.find((l) => l.ingredientId === 'BEEF');
      /* Deciding a quantity is answering "do we need this", and a decision
         made without the shelf figure is a guess about somebody else's store. */
      assert.equal(beef.onHand, 10000);
      assert.ok('par' in beef);
      assert.ok(one.estimate > 0, 'no sense of what it would cost');
    });

  describe('deciding', () => {
    let indent;

    before(async () => {
      const list = await get('/indents');
      indent = list.json.indents.find((i) => i.forArea === 'the pass');
    });

    test('cutting a line without saying why is refused', async () => {
      const beef = indent.lines.find((l) => l.ingredientId === 'BEEF');
      const r = await req('POST', `/indents/${indent.id}/decide`, {
        lines: [{ id: beef.id, approvedQty: 2000 }],
      });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /how the next request gets padded/);
    });

    test('approving MORE than was asked for is refused', async () => {
      /* That is somebody using the approval screen to order, which is a
         different act with a different rank. */
      const beef = indent.lines.find((l) => l.ingredientId === 'BEEF');
      const r = await req('POST', `/indents/${indent.id}/decide`, {
        lines: [{ id: beef.id, approvedQty: 99999, reason: 'why not' }],
      });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /less than was asked for, not more/);
    });

    test('a line with no decision on it is approved in full', async () => {
      const beef = indent.lines.find((l) => l.ingredientId === 'BEEF');
      const r = await req('POST', `/indents/${indent.id}/decide`, {
        lines: [{ id: beef.id, approvedQty: 2000, reason: 'the freezer is full' }],
      });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.approvedLines, 2);

      const after = await get('/indents');
      const it = after.json.indents.find((i) => i.id === indent.id);
      const b = it.lines.find((l) => l.ingredientId === 'BEEF');
      const bun = it.lines.find((l) => l.ingredientId === 'BUN');
      /* Asked for and approved side by side, neither overwriting the other. */
      assert.equal(b.qty, 5000);
      assert.equal(b.approvedQty, 2000);
      assert.equal(b.reason, 'the freezer is full');
      assert.equal(bun.approvedQty, bun.qty, 'a line nobody touched came back cut');
      assert.equal(it.state, 'decided');
    });

    test('and it cannot be decided twice', async () => {
      const r = await req('POST', `/indents/${indent.id}/decide`, {});
      assert.equal(r.status, 400);
      assert.match(r.json.error, /already been decided/);
    });

    test('an approved indent nobody has ordered is counted, because that is the gap',
      async () => {
        const r = await get('/indents');
        assert.ok(r.json.approvedNotOrdered >= 1,
          'a kitchen thinks something is coming and nothing is');
      });
  });

  describe('ordering it', () => {
    let indent, po;

    before(async () => {
      const list = await get('/indents');
      indent = list.json.indents.find((i) => i.forArea === 'the pass');
    });

    test('it becomes a purchase order — the first this build has ever written',
      async () => {
        const before = await H.asOwner(ctx, 'SELECT count(*)::int AS n FROM purchase_order');
        assert.equal(before.rows[0].n, 0, 'the table was supposed to be empty');

        const r = await req('POST', `/indents/${indent.id}/order`, { supplierId });
        assert.equal(r.status, 200, r.text);
        po = r.json;
        assert.match(po.poNo, /-PO-/);
        assert.equal(po.lines.length, 2);
        /* Priced off what the store last paid, and said to be. */
        assert.equal(po.lines.every((l) => l.pricedFrom === 'last paid'), true);
        assert.ok(po.total > 0);
      });

    test('an order is a promise, so nothing reaches the ledger', async () => {
      assert.match(po.ledger, /a promise, not a purchase/);
      const j = await H.asOwner(ctx,
        "SELECT count(*)::int AS n FROM journal WHERE source = 'purchase_order'");
      assert.equal(j.rows[0].n, 0);
    });

    test('the indent now points at the order', async () => {
      const r = await get('/indents');
      const it = r.json.indents.find((i) => i.id === indent.id);
      assert.equal(it.state, 'ordered');
      assert.equal(it.poNo, po.poNo);
      assert.equal(it.poStatus, 'sent');
    });

    test('and it cannot be ordered twice', async () => {
      const r = await req('POST', `/indents/${indent.id}/order`, { supplierId });
      assert.equal(r.status, 400);
    });

    test('the order is open, with what is still outstanding on it', async () => {
      const r = await get('/purchase-orders?open=1');
      const o = r.json.orders.find((x) => x.poNo === po.poNo);
      assert.ok(o);
      assert.equal(o.outstanding, 2200, '2000 g of beef and 200 buns');
    });
  });

  describe('receiving against it', () => {
    let po;

    before(async () => {
      const r = await get('/purchase-orders?open=1');
      po = r.json.orders[0];
    });

    test("a delivery for another supplier's order is refused", async () => {
      const other = await req('POST', '/vendors', { name: 'Somebody Else' }, admin.token);
      const r = await H.req('POST', `/api/outlet/${ctx.outletId}/sync/push`, {
        token: mgr.token,
        body: { ops: [{ opId: H.uuid(), kind: 'delivery_receive', at: Date.now(),
          payload: { supplierId: other.json.id, poId: po.id,
            lines: [{ ingredientId: 'BUN', qty: 10, unitPrice: 4.5 }] } }] },
      });
      assert.match(String(r.json.results[0].error), /different supplier/);
    });

    test('a partial delivery marks the order off and leaves it open', async () => {
      const r = await H.req('POST', `/api/outlet/${ctx.outletId}/sync/push`, {
        token: mgr.token,
        body: { ops: [{ opId: H.uuid(), kind: 'delivery_receive', at: Date.now(),
          payload: { supplierId, poId: po.id,
            lines: [{ ingredientId: 'BUN', qty: 200, unitPrice: 4.5 }] } }] },
      });
      assert.ok(!r.json.results[0].error, JSON.stringify(r.json.results[0]));
      const result = r.json.results[0].result;
      assert.equal(result.order.status, 'part');
      assert.equal(result.order.outstanding, 2000, 'the beef is still to come');
    });

    test('and the rest closes it', async () => {
      const r = await H.req('POST', `/api/outlet/${ctx.outletId}/sync/push`, {
        token: mgr.token,
        body: { ops: [{ opId: H.uuid(), kind: 'delivery_receive', at: Date.now(),
          payload: { supplierId, poId: po.id,
            lines: [{ ingredientId: 'BEEF', qty: 2000, unitPrice: 0.09 }] } }] },
      });
      const result = r.json.results[0].result;
      assert.equal(result.order.status, 'received');
      assert.equal(result.order.outstanding, 0);
    });

    test('over-delivering does not make an order more than complete', async () => {
      /* The surplus IS on the shelf — the stock movement is what is true — and
         the order only ever says how much of it has been answered. */
      const list = await get('/purchase-orders');
      const o = list.json.orders.find((x) => x.poNo === po.poNo);
      assert.ok(o.lines.every((l) => l.receivedQty <= l.qty));
      assert.equal(o.outstanding, 0);
    });

    test('the delivery names the order it answered', async () => {
      const d = await H.asOwner(ctx,
        'SELECT po_id FROM delivery WHERE po_id IS NOT NULL LIMIT 1');
      assert.ok(d.rows.length, '`delivery.po_id` is still never set');
      assert.equal(d.rows[0].po_id, po.id);
    });
  });
});
