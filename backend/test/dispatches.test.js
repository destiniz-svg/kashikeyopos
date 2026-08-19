'use strict';
/* Dispatches — 02-POS-SPEC §2 (`dispatches`).
 *
 * This is the one feature the tenancy model makes genuinely hard, so the tests
 * are mostly about the boundary holding while the stock moves across it:
 *
 *   · neither branch ever writes the other's stock — the sender's movement is
 *     written on the sender's connection and the receiver's on theirs
 *   · a transfer sent and never confirmed stays visibly in flight
 *   · what ARRIVES is what is received, and a shortfall is recorded rather
 *     than argued away
 *   · 1350 nets to zero across the two branches once both halves have posted,
 *     which is what makes an unconfirmed van visible in the books
 *
 * TWO OUTLETS, which no other test file in this suite needs. `bootOutlet`
 * provisions a fresh one per call, so the second is a real second tenant with
 * its own schema and its own login role.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('dispatches', () => {
  let a, b, aMgr, bMgr, aTill;

  before(async () => {
    a = await H.bootOutlet();
    b = await H.bootOutlet();
    aMgr = await H.addStaff(a, 'Malé Manager', 3);
    bMgr = await H.addStaff(b, 'Hulhumalé Manager', 3);
    aTill = await H.addStaff(a, 'Malé Cashier', 2);
  });
  after(async () => { await H.teardown(a); });

  const at = (ctx, token) => (method, p, body) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token });
  const A = (m, p, body) => at(a, aMgr.token)(m, p, body);
  const B = (m, p, body) => at(b, bMgr.token)(m, p, body);
  const onHand = async (ctx, id) => {
    const r = await H.asOwner(ctx, 'SELECT on_hand FROM ingredient WHERE id = $1', [id]);
    return Number(r.rows[0].on_hand);
  };
  const balance = async (ctx, token, code) => {
    const r = await at(ctx, token)('GET', '/reports/trial-balance');
    const acc = r.json.accounts.find((x) => x.code === code);
    return acc ? acc.balance : 0;
  };

  test('a branch can see where it may send, and nothing else about them',
    async () => {
      const r = await A('GET', '/dispatches');
      assert.equal(r.status, 200);
      const dest = r.json.destinations.find((d) => d.id === b.outletId);
      assert.ok(dest, 'the other branch is not offered');
      /* A name and a code. Not their takings, their staff or their stock. */
      assert.deepEqual(Object.keys(dest).sort(), ['code', 'id', 'name']);
    });

  test('a cashier cannot send stock out of the building', async () => {
    const r = await at(a, aTill.token)('POST', '/dispatches',
      { toOutlet: b.outletId, ingredientId: 'BEEF', qty: 100 });
    assert.equal(r.status, 403);
  });

  test('a branch cannot send to itself', async () => {
    const r = await A('POST', '/dispatches',
      { toOutlet: a.outletId, ingredientId: 'BEEF', qty: 100 });
    assert.equal(r.status, 400);
  });

  describe('sending', () => {
    let sent, beforeA;

    before(async () => {
      beforeA = await onHand(a, 'BEEF');
      const r = await A('POST', '/dispatches',
        { toOutlet: b.outletId, ingredientId: 'BEEF', qty: 2000, note: 'short at Hulhumalé' });
      assert.equal(r.status, 201, r.text);
      sent = r.json;
    });

    test('it takes its own document number', () => {
      assert.match(sent.ref, /-TRF-/,
        'borrowing the GRN series would leave gaps in that one');
    });

    test("the sender's stock leaves the sender's books, written by the sender",
      async () => {
        assert.equal(await onHand(a, 'BEEF'), beforeA - 2000);
      });

    test('and the value parks in the clearing account', async () => {
      /* 2000 g at 0.0850 = 170.00. */
      assert.equal(await balance(a, aMgr.token, '1350'), 170);
    });

    test('the receiving branch sees it waiting for them', async () => {
      const r = await B('GET', '/dispatches');
      assert.equal(r.json.waitingOnYou, 1);
      const t = r.json.inbound.find((x) => x.ref === sent.ref);
      assert.ok(t);
      assert.equal(t.direction, 'in');
      assert.equal(t.qtySent, 2000);
      /* Nobody has said what arrived, which is not the same as nothing did. */
      assert.equal(t.qtyReceived, null);
      assert.equal(t.variance, null);
    });

    test("and the sender sees it as not yet confirmed, which is the figure that matters",
      async () => {
        const r = await A('GET', '/dispatches');
        assert.equal(r.json.notConfirmed, 1);
        assert.equal(r.json.inFlightValue, 170);
      });

    test("nothing has touched the receiver's stock yet", async () => {
      /* The whole design: only the receiving branch can write the receiving
         branch's books, and they have not yet said it turned up. */
      assert.equal(await balance(b, bMgr.token, '1350'), 0);
    });

    test('a third party can see neither end of it', async () => {
      /* `a`'s cashier can read their own branch's board — the transfer names
         their outlet. What nobody outside the two can do is read it at all,
         which the leak test proves at the database level. Here: the row is
         scoped by policy, so `b`'s board holds only transfers naming `b`. */
      const r = await B('GET', '/dispatches');
      assert.ok(r.json.outbound.every((t) => t.from.id === b.outletId));
      assert.ok(r.json.inbound.every((t) => t.to.id === b.outletId));
    });

    describe('receiving', () => {
      test('the receiver names their OWN ingredient', async () => {
        const list = await B('GET', '/dispatches');
        const t = list.json.inbound.find((x) => x.ref === sent.ref);
        const r = await B('POST', `/dispatches/${t.id}/receive`, {});
        assert.equal(r.status, 400);
        assert.match(r.json.error, /which of your own ingredients/);
      });

      test('and a unit that does not match is refused rather than converted',
        async () => {
          const list = await B('GET', '/dispatches');
          const t = list.json.inbound.find((x) => x.ref === sent.ref);
          /* Beef is grams; syrup is millilitres. Guessing the conversion would
             put a wrong quantity into a real store. */
          const r = await B('POST', `/dispatches/${t.id}/receive`,
            { ingredientId: 'SYRUP' });
          assert.equal(r.status, 400);
          assert.match(r.json.error, /have to match/);
        });

      test('what arrives is what is received, and short is recorded not argued',
        async () => {
          const beforeB = await onHand(b, 'BEEF');
          const list = await B('GET', '/dispatches');
          const t = list.json.inbound.find((x) => x.ref === sent.ref);

          const r = await B('POST', `/dispatches/${t.id}/receive`,
            { ingredientId: 'BEEF', qty: 1900, reason: 'one bag was light' });
          assert.equal(r.status, 200, r.text);
          assert.equal(r.json.received, 1900);
          assert.equal(r.json.variance, -100);
          assert.ok(r.json.settlement, 'a shortfall with nothing said about it');
          assert.match(r.json.settlement.why, /whose it is/);

          assert.equal(await onHand(b, 'BEEF'), beforeB + 1900);
        });

      test('the stock arrived at what it cost where it came from', async () => {
        /* A transfer is not a sale: it must not make margin in one branch or
           destroy it in the other. */
        const r = await H.asOwner(b, "SELECT unit_cost FROM stock_move"
          + " WHERE ingredient_id = 'BEEF' AND reason = 'transfer' ORDER BY id DESC LIMIT 1");
        assert.equal(Number(r.rows[0].unit_cost), 0.085);
      });

      test('1350 is left holding exactly the difference, at both ends together',
        async () => {
          const aSide = await balance(a, aMgr.token, '1350');
          const bSide = await balance(b, bMgr.token, '1350');
          /* Malé debited 170.00 as 2000 g left; Hulhumalé credited 161.50 as
             1900 g arrived. What is left across the estate is the 100 g nobody
             can account for — 8.50 — which is the point of one account rather
             than a pair. */
          assert.equal(aSide, 170);
          assert.equal(bSide, -161.5);
          assert.equal(Math.round((aSide + bSide) * 100) / 100, 8.5);
        });

      test('and it cannot be received twice', async () => {
        const list = await B('GET', '/dispatches?days=90');
        const t = list.json.inbound.find((x) => x.ref === sent.ref);
        const r = await B('POST', `/dispatches/${t.id}/receive`, { ingredientId: 'BEEF' });
        assert.equal(r.status, 400);
        assert.match(r.json.error, /already been settled/);
        /* And it is still READABLE, which is the bug this nearly shipped with:
           a locking read has to satisfy the UPDATE policy too, and that policy
           is `state = 'sent'`, so a settled transfer answered "no such
           transfer" to the very people who had just settled it. */
        const still = await B('GET', '/dispatches?days=90');
        assert.ok(still.json.inbound.find((x) => x.ref === sent.ref));
      });
    });
  });

  describe('when it comes back', () => {
    let sent;

    before(async () => {
      const r = await A('POST', '/dispatches',
        { toOutlet: b.outletId, ingredientId: 'SYRUP', qty: 500 });
      sent = r.json;
    });

    test('the receiver can turn it away, with a reason', async () => {
      const list = await B('GET', '/dispatches');
      const t = list.json.inbound.find((x) => x.ref === sent.ref);
      const bare = await B('POST', `/dispatches/${t.id}/reject`, {});
      assert.equal(bare.status, 400, 'a rejection with no reason is an argument later');

      const r = await B('POST', `/dispatches/${t.id}/reject`, { reason: 'never turned up' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.state, 'rejected');
      /* And it says who has to act now, because nothing here can write the
         sending branch's books. */
      assert.match(r.json.next, /take it back into their own stock/);
    });

    test("the sender's stock is still out until the sender takes it back",
      async () => {
        const list = await A('GET', '/dispatches');
        const t = list.json.outbound.find((x) => x.ref === sent.ref);
        assert.equal(t.state, 'rejected');
        assert.equal(t.reason, 'never turned up');
      });

    test('taking it back is the sending branch, in the sending branch\'s books',
      async () => {
        const before = await onHand(a, 'SYRUP');
        const list = await A('GET', '/dispatches');
        const t = list.json.outbound.find((x) => x.ref === sent.ref);

        /* And the other branch cannot do it for them. */
        const wrong = await B('POST', `/dispatches/${t.id}/take-back`, {});
        assert.equal(wrong.status, 400);

        const r = await A('POST', `/dispatches/${t.id}/take-back`, {});
        assert.equal(r.status, 200, r.text);
        assert.equal(await onHand(a, 'SYRUP'), before + 500);
      });

    test('and the clearing account is clean again for that one', async () => {
      /* 500 ml of syrup at 0.0120 = 6.00, debited on the way out and credited
         on the way back. Only the beef shortfall is left. */
      assert.equal(await balance(a, aMgr.token, '1350'), 170);
    });
  });
});
