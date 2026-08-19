'use strict';
/* Settlement reconciliation — 08-BUILD-STAGES §17.
 *
 * A card sale is not money yet, and this build has been pretending otherwise
 * since the first day: the till takes a card, the sale debits 1020 Card
 * receivable, and nothing has ever taken it off again. So account 1020 is the
 * sum of every card payment ever taken, against money sitting in a bank account
 * that the books do not know arrived.
 *
 * The tests below are mostly about the two ways a reconciliation lies: a
 * partial match (which balances, and is wrong) and a difference folded into the
 * fee (which balances, and hides a chargeback inside a cost of doing business).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('card settlements', () => {
  let ctx, mgr, today, cardIds = [];

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
    today = new Date().toISOString().slice(0, 10);
  });
  after(() => H.teardown(ctx));

  const req = (method, p, body, token) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: token || mgr.token });
  const get = (p, token) => req('GET', p, undefined, token);
  const sell = (basket, method) => H.push(ctx, [{
    opId: H.uuid(), kind: 'sale', at: Date.now(),
    payload: {
      businessDate: today, channel: 'dine_in', covers: 1,
      lines: basket.map(([itemId, qty]) => ({ itemId, qty })),
      payments: [{ method, amount: H.priceIt(ctx, basket).total / 100 }],
    },
  }]);
  const bal = async (code) => {
    const r = await get(`/reports/trial-balance?from=${today}&to=${today}`);
    return r.json.accounts.find((a) => a.code === code)?.balance ?? 0;
  };

  /* ── what 1020 is actually made of ────────────────────────────────────── */

  test('with nothing sold there is nothing outstanding, and that is not an error',
    async () => {
      const r = await get('/settlements');
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.batches, []);
      assert.equal(r.json.outstanding.total, 0);
      assert.equal(r.json.outstanding.oldest, null);
    });

  test('card sales pile up on 1020 until somebody settles them', async () => {
    await sell([['BURGER', 2]], 'card');
    await sell([['COLA', 3]], 'card');
    await sell([['BURGER', 1]], 'cash');     // not an acquirer's business

    const r = await get('/settlements');
    assert.equal(r.json.outstanding.payments, 2, 'the cash sale is not in here');
    assert.ok(r.json.outstanding.total > 0);
    assert.equal(r.json.outstanding.oldest, today);
    /* And it is the same figure the ledger has on the receivable. */
    assert.equal(r.json.outstanding.total, await bal('1020'));
  });

  /* ── entering what the acquirer says ──────────────────────────────────── */

  test('a statement whose own arithmetic does not work is refused', async () => {
    /* Caught now rather than at the match, where a typo would look like a
       variance in the trade instead of a mistake in the typing. */
    const r = await req('POST', '/settlements', {
      acquirer: 'BML', batchNo: 'B-1', valueDate: today,
      gross: 1000, fee: 25, net: 990,
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /1000\.00 less fee 25\.00 is 975\.00, not 990\.00/);
  });

  test('a batch needs the reference somebody would ring the acquirer about', async () => {
    const r = await req('POST', '/settlements', {
      acquirer: 'BML', batchNo: '', valueDate: today, gross: 100, fee: 2,
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /reference from the statement/);
  });

  test('the statement goes on the books, with the net worked out for you', async () => {
    const out = (await get('/settlements')).json.outstanding;
    const r = await req('POST', '/settlements', {
      acquirer: 'BML', batchNo: 'B-2201', valueDate: today,
      gross: out.total, fee: 12.50,
      note: 'Tuesday payout',
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.net, Math.round((out.total - 12.5) * 100) / 100);
    assert.equal(r.json.state, 'waiting to be matched');
    assert.equal(r.json.enteredBy, 'Duty Manager');
  });

  test('the same statement cannot be entered twice', async () => {
    /* The commonest mistake on this screen, and the one that would double-count
       a day's card takings. */
    const r = await req('POST', '/settlements', {
      acquirer: 'BML', batchNo: 'B-2201', valueDate: today, gross: 50, fee: 0,
    });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /already on the books/);
  });

  /* ── finding the payments ─────────────────────────────────────────────── */

  test('the suggestion is every unsettled card payment, and says whether it adds up',
    async () => {
      const b = (await get('/settlements')).json.batches[0];
      const s = await get(`/settlements/${b.id}/suggest`);
      assert.equal(s.status, 200, s.text);
      assert.equal(s.json.payments.length, 2);
      assert.equal(s.json.agrees, true);
      assert.equal(s.json.difference, 0);
      assert.match(s.json.message, /exactly what BML says it paid/);
      cardIds = s.json.payments.map((p) => p.id);
    });

  test('a cash payment is never suggested — an acquirer settles no drawer', async () => {
    const b = (await get('/settlements')).json.batches[0];
    const s = await get(`/settlements/${b.id}/suggest`);
    const methods = new Set(s.json.payments.map((p) => p.method));
    assert.deepEqual([...methods], ['card']);
  });

  /* ── the match, and what it posts ─────────────────────────────────────── */

  test('matching moves the money off the receivable and into the bank', async () => {
    const before = { r: await bal('1020'), bank: await bal('1010'), fees: await bal('6180') };
    const b = (await get('/settlements')).json.batches[0];

    const r = await req('POST', `/settlements/${b.id}/match`, { paymentIds: cardIds });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.matchedCount, 2);
    assert.equal(r.json.variance, 0);
    assert.match(r.json.message, /to the bank/);
    assert.ok(r.json.jvNo, 'and it names the voucher');

    assert.equal(await bal('1020'), Math.round((before.r - r.json.matchedAmount) * 100) / 100,
      'the receivable is discharged');
    assert.equal(await bal('1010'), Math.round((before.bank + b.net) * 100) / 100,
      'the bank has what actually arrived');
    assert.equal(await bal('6180'), Math.round((before.fees + b.fee) * 100) / 100,
      'and the acquirer\'s cut is a cost, per §17');
  });

  test('the entry is in the ledger, named for the batch anybody would quote', async () => {
    const j = await get(`/accounting/journals?from=${today}&to=${today}&source=settlement`);
    assert.equal(j.status, 200, j.text);
    const e = j.json.journals[0];
    assert.match(e.memo, /BML batch B-2201 — 2 payments/);
    assert.deepEqual(e.lines.map((l) => l.account).sort(), ['1010', '1020', '6180']);
  });

  test('a matched batch drops out of what is outstanding', async () => {
    const r = await get('/settlements');
    assert.equal(r.json.outstanding.payments, 0);
    assert.equal(r.json.outstanding.total, 0);
    assert.equal(r.json.batches[0].state, 'matched');
    assert.equal(r.json.totals.unmatched, 0);
  });

  test('matching the same batch twice is refused', async () => {
    const b = (await get('/settlements')).json.batches[0];
    const r = await req('POST', `/settlements/${b.id}/match`, { paymentIds: cardIds });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /already matched/);
  });

  /* ── the two ways a reconciliation lies ───────────────────────────────── */

  test('a payment already settled elsewhere fails the WHOLE match, not part of it',
    async () => {
      /* A partial match balances and is wrong: a batch reconciled against some
         of its payments looks done and leaves the rest orphaned for ever. */
      await sell([['BURGER', 1]], 'card');
      const fresh = (await get('/settlements')).json.outstanding.total;
      const made = await req('POST', '/settlements', {
        acquirer: 'BML', batchNo: 'B-2202', valueDate: today, gross: fresh, fee: 1,
      });
      const s = await get(`/settlements/${made.json.id}/suggest`);
      const ids = s.json.payments.map((p) => p.id).concat(cardIds[0]);

      const r = await req('POST', `/settlements/${made.json.id}/match`, { paymentIds: ids });
      assert.equal(r.status, 409, r.text);
      assert.match(r.json.error, /already settled in another batch — nothing has been changed/);

      /* And it means it: the batch is still open and the fresh payment is still
         unsettled. */
      const after = await get('/settlements');
      assert.equal(after.json.outstanding.payments, 1);
      assert.ok(after.json.batches.some((b) => b.batchNo === 'B-2202' && !b.matchedAt));
    });

  test('a difference gets its OWN account and stays visible', async () => {
    /* §17: "variance surfaced". Folding it into the fee would hide a chargeback
       inside a cost of doing business, and balancing it against 1020 would
       leave a receivable nobody can explain. */
    const b = (await get('/settlements')).json.batches.find((x) => x.batchNo === 'B-2202');
    const s = await get(`/settlements/${b.id}/suggest`);
    const ids = s.json.payments.map((p) => p.id);

    /* The acquirer paid 20.00 less than the payments were worth — a chargeback,
       say. Enter the statement as it actually reads. */
    await req('POST', '/settlements', {
      acquirer: 'BML', batchNo: 'B-2203', valueDate: today,
      gross: s.json.total - 20, fee: 1,
    });
    const short = (await get('/settlements')).json.batches.find((x) => x.batchNo === 'B-2203');

    const varianceBefore = await bal('6185');
    const r = await req('POST', `/settlements/${short.id}/match`, { paymentIds: ids });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.variance, -20);
    assert.match(r.json.message, /difference of 20\.00/);
    assert.match(r.json.message, /6185/);
    assert.equal(r.json.state, 'matched with a difference');

    assert.equal(await bal('6185'), Math.round((varianceBefore + 20) * 100) / 100,
      'the difference is a cost with a name, not a plug in the fee');
  });

  test('the trial balance still balances after all of it', async () => {
    const r = await get(`/reports/trial-balance?from=${today}&to=${today}`);
    assert.equal(r.json.balanced, true, JSON.stringify(r.json.totals));
  });

  /* ── undoing one ──────────────────────────────────────────────────────── */

  test('unmatching needs a reason', async () => {
    const b = (await get('/settlements')).json.batches.find((x) => x.batchNo === 'B-2203');
    const r = await req('POST', `/settlements/${b.id}/unmatch`, { reason: '' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /say why/);
  });

  test('unmatching REVERSES the entry and frees the payments — it deletes nothing',
    async () => {
      const b = (await get('/settlements')).json.batches.find((x) => x.batchNo === 'B-2203');
      const before = (await get(
        `/accounting/journals?from=${today}&to=${today}`)).json.journals.length;

      const r = await req('POST', `/settlements/${b.id}/unmatch`,
        { reason: 'matched against the wrong week' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.freed, 1);
      assert.match(r.json.message, /Both entries stay in the ledger/);

      const after = await get(`/accounting/journals?from=${today}&to=${today}`);
      assert.equal(after.json.journals.length, before + 1, 'one more entry, not one fewer');
      const gone = after.json.journals.find((j) => j.id === b.journalId);
      assert.ok(gone.reversedBy, 'and the original says what undid it');

      /* The payments are outstanding again, which is the true state. */
      const s = await get('/settlements');
      assert.equal(s.json.outstanding.payments, 1);
      assert.ok(s.json.batches.some((x) => x.batchNo === 'B-2203' && !x.matchedAt));
    });

  test('a batch that was never matched cannot be unmatched', async () => {
    const b = (await get('/settlements')).json.batches.find((x) => x.batchNo === 'B-2202');
    const r = await req('POST', `/settlements/${b.id}/unmatch`, { reason: 'no reason' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /never matched/);
  });

  test('and it all still balances', async () => {
    const r = await get(`/reports/trial-balance?from=${today}&to=${today}`);
    assert.equal(r.json.balanced, true, JSON.stringify(r.json.totals));
  });

  /* ── who may do it ────────────────────────────────────────────────────── */

  test('a till session reaches none of it', async () => {
    assert.equal((await get('/settlements', ctx.token)).status, 403);
    const r = await req('POST', '/settlements', {
      acquirer: 'X', batchNo: 'Y', valueDate: today, gross: 10, fee: 0,
    }, ctx.token);
    assert.equal(r.status, 403);
  });
});
