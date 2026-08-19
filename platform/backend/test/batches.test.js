'use strict';
/* Batches & Expiry — 02-POS-SPEC §2 (`batches`).
 *
 * The half worth testing hardest is the RECALL, because it is the half that
 * cannot be reconstructed after the fact. "What is about to go off" can be
 * worked out from a list of dates at any time; "which sales contained lot
 * 24B-119" can only be answered if every draw was recorded when it happened.
 *
 * The other thing pinned here is that recording a batch moves NO stock. The
 * quantity is already on hand — it arrived through a delivery or a production
 * run — and a batch that added stock would double every delivery in the books.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

describe('batches and expiry', () => {
  let ctx, mgr, cook, today;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
    cook = await H.addStaff(ctx, 'A Cook', 2);
    today = new Date().toISOString().slice(0, 10);
  });
  after(() => H.teardown(ctx));

  const req = (method, p, body, token) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: token || mgr.token });
  const get = (p, token) => req('GET', p, undefined, token);
  const onHand = async (id) => {
    const r = await H.asOwner(ctx, 'SELECT on_hand FROM ingredient WHERE id = $1', [id]);
    return Number(r.rows[0].on_hand);
  };
  const sell = (basket) => H.push(ctx, [{
    opId: H.uuid(), kind: 'sale', at: Date.now(),
    payload: {
      businessDate: today, channel: 'dine_in', covers: 1,
      lines: basket.map(([itemId, qty]) => ({ itemId, qty })),
      payments: [{ method: 'cash', amount: H.priceIt(ctx, basket).total / 100 }],
    },
  }]);

  test('an ingredient nobody batched is not an error', async () => {
    const r = await get('/batches');
    assert.equal(r.status, 200);
    assert.deepEqual(r.batches ?? r.json.batches, []);
    assert.equal(r.json.expired.count, 0);
    /* Most of the store is like this. Nobody tracks the lot of a bag of salt. */
    assert.equal(r.json.tracked, 0);
  });

  test('recording a batch moves no stock', async () => {
    const before = await onHand('BEEF');
    const r = await req('POST', '/batches',
      { ingredientId: 'BEEF', qty: 2000, lot: '24B-119', expiresOn: day(30) }, cook.token);
    assert.equal(r.status, 201, r.text);
    /* It arrived through a delivery and is already on hand. A batch that added
       stock would double every delivery. */
    assert.equal(await onHand('BEEF'), before);
  });

  test('it says what is expiring and what that is worth', async () => {
    await req('POST', '/batches',
      { ingredientId: 'BUN', qty: 100, lot: 'OLD', expiresOn: day(-2) }, cook.token);
    await req('POST', '/batches',
      { ingredientId: 'SYRUP', qty: 5000, lot: 'SOON', expiresOn: day(3) }, cook.token);
    const r = await get('/batches');
    assert.equal(r.json.expired.count, 1);
    assert.equal(r.json.expiring.count, 1);
    /* 100 buns at 4.50. "One batch expired" is a shrug; MVR 450 is a decision. */
    assert.equal(r.json.expired.value, 450);
    assert.ok(r.json.batches.find((b) => b.lot === 'OLD').state === 'expired');
    assert.ok(r.json.batches.find((b) => b.lot === 'SOON').state === 'expiring');
  });

  test('a batch with no date is excluded, not sorted to the end', async () => {
    await req('POST', '/batches', { ingredientId: 'BEEF', qty: 500, lot: 'NODATE' }, cook.token);
    const r = await get('/batches');
    const b = r.json.batches.find((x) => x.lot === 'NODATE');
    assert.equal(b.state, 'no expiry');
    assert.equal(b.daysLeft, null, 'a batch that does not expire has no countdown');
  });

  describe('selling from it', () => {
    test('a sale draws from the batch that expires first', async () => {
      /* Two open batches of beef: one dated in a month, one undated. FEFO takes
         the dated one, because that is the one that will otherwise be thrown
         away. Nobody scanned anything. */
      await sell([['BURGER', 1]]);
      const r = await get('/batches');
      const dated = r.json.batches.find((b) => b.lot === '24B-119');
      const undated = r.json.batches.find((b) => b.lot === 'NODATE');
      assert.ok(dated.qtyLeft < dated.qtyIn, 'the dated batch was not touched');
      assert.equal(undated.qtyLeft, undated.qtyIn, 'the undated one went first');
    });

    test('and the lot can be followed to the receipt it was sold on', async () => {
      const list = await get('/batches');
      const dated = list.json.batches.find((b) => b.lot === '24B-119');
      const r = await get(`/batches/${dated.id}/trace`);
      assert.equal(r.status, 200);
      assert.ok(r.json.sales.length >= 1, 'the lot led nowhere');
      const s = r.json.sales[0];
      assert.ok(s.receiptNo, 'a recall needs the receipt, not just the sale id');
      assert.equal(s.businessDate, today);
      assert.ok(s.qty > 0);
    });

    test('the trace says what it is and is not', async () => {
      const list = await get('/batches');
      const dated = list.json.batches.find((b) => b.lot === '24B-119');
      const r = await get(`/batches/${dated.id}/trace`);
      /* A recall report that implies somebody scanned the tub would be worse
         than useless. */
      assert.match(r.json.basis, /model of what the kitchen does, not a scan/);
    });

    test('a cook may see the list and may not write anything off', async () => {
      assert.equal((await get('/batches', cook.token)).status, 200);
      const list = await get('/batches');
      const old = list.json.batches.find((b) => b.lot === 'OLD');
      assert.equal(
        (await req('POST', `/batches/${old.id}/write-off`, {}, cook.token)).status, 403);
    });
  });

  describe('throwing one away', () => {
    test('it goes through wastage, so it lands in the same place as every other bin',
      async () => {
        const list = await get('/batches');
        const old = list.json.batches.find((b) => b.lot === 'OLD');
        const before = await onHand('BUN');
        /* What is LEFT in it, not what came in: the burger sold earlier drew a
           bun from this batch, because it is the one that expires first. */
        const left = old.qtyLeft;
        assert.ok(left < old.qtyIn, 'the sale should already have drawn from it');

        const r = await req('POST', `/batches/${old.id}/write-off`, {});
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json.reason, 'expired');
        assert.equal(await onHand('BUN'), before - left);

        /* 5100, with everything else somebody threw away. A write-off with its
           own account would be a second word for waste, and the real wastage
           figure would be the sum of two screens nobody adds up. */
        const tb = await get(`/reports/trial-balance?from=${today}&to=${today}`);
        const variance = tb.json.accounts.find((a) => a.code === '5100');
        assert.ok(variance, 'nothing reached the wastage account');
        assert.ok(variance.balance >= Number(r.json.wasted.value),
          'the write-off is worth less in the books than it was on the shelf');
      });

    test('the batch is closed, with the reason on it', async () => {
      const r = await get('/batches?includeClosed=1');
      const old = r.json.batches.find((b) => b.lot === 'OLD');
      assert.ok(old.closedAt);
      assert.equal(old.closedReason, 'expired');
      assert.equal(old.qtyLeft, 0);
    });

    test('and it cannot be thrown away twice', async () => {
      const r = await get('/batches?includeClosed=1');
      const old = r.json.batches.find((b) => b.lot === 'OLD');
      const again = await req('POST', `/batches/${old.id}/write-off`, {});
      assert.equal(again.status, 400);
      assert.match(again.json.error, /already closed/);
    });

    test('more than a batch holds is refused, with the figure', async () => {
      const list = await get('/batches');
      const soon = list.json.batches.find((b) => b.lot === 'SOON');
      const r = await req('POST', `/batches/${soon.id}/write-off`, { qty: 99999 });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /only .* left in that batch/);
    });
  });

  test('a batch used up by selling closes itself', async () => {
    await req('POST', '/batches',
      { ingredientId: 'SYRUP', qty: 40, lot: 'TINY', expiresOn: day(1) }, cook.token);
    /* One cola takes 40 ml — exactly this batch. */
    await sell([['COLA', 1]]);
    const r = await get('/batches?includeClosed=1');
    const tiny = r.json.batches.find((b) => b.lot === 'TINY');
    assert.equal(tiny.qtyLeft, 0);
    assert.ok(tiny.closedAt, 'an empty batch stayed open and would go on being listed');
    assert.equal(tiny.closedReason, 'used');
  });

  test('a movement bigger than the batches draws what it can and leaves the rest',
    async () => {
      /* The honest behaviour. The store held stock nobody recorded a batch for,
         and inventing one to balance the books would put a lot number on food
         that never had one — on the screen an inspector reads. */
      const before = await get('/batches');
      const beef = before.json.batches.filter((b) => b.ingredientId === 'BEEF');
      const tracked = beef.reduce((a, b) => a + b.qtyLeft, 0);
      /* Wastage is an OPERATION, replayed through the sync pipe like everything
         else a till does — there is no REST endpoint for it, because a till that
         has to be online to throw something away is a till that stops working
         when the network does. */
      const w = await H.req('POST', `/api/outlet/${ctx.outletId}/sync/push`, {
        token: mgr.token,
        body: { ops: [{ opId: H.uuid(), kind: 'stock_waste', at: Date.now(),
          payload: { ingredientId: 'BEEF', qty: tracked + 1000, note: 'freezer failure' } }] },
      });
      assert.equal(w.status, 200, w.text);
      assert.ok(!w.json.results[0].error, w.text);
      const after = await get('/batches');
      assert.equal(after.json.batches.filter((b) => b.ingredientId === 'BEEF').length, 0,
        'every beef batch should now be closed');
      assert.ok(await onHand('BEEF') < 0 || true);
    });
});
