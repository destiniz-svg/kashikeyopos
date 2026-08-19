'use strict';
/* Credit notes — 08-BUILD-STAGES §21, and DEPLOYMENT.md's promise that "a
 * closed sale is corrected with a credit note, never erased."
 *
 * Three things this file is really about:
 *
 *   · The approval. Nothing moves until a second person says yes — no money,
 *     no stock, and no document number, because a gapless series must not carry
 *     a hole where a declined note used to be.
 *   · The arithmetic. A full credit returns exactly what was taken, to the
 *     laari, because the figures are a share of the SALE's own rather than a
 *     recalculation that would drift.
 *   · The tax return. A refund the return does not know about is tax declared
 *     on money that was handed back.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('credit notes', () => {
  let ctx, mgr, admin, today, sale, lines;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
    admin = await H.addStaff(ctx, 'General Manager', 4);
    today = new Date().toISOString().slice(0, 10);

    const basket = [['BURGER', 3], ['COLA', 2]];
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: today, channel: 'dine_in', covers: 2,
        lines: basket.map(([itemId, qty]) => ({ itemId, qty })),
        payments: [{ method: 'cash', amount: H.priceIt(ctx, basket).total / 100 }],
      },
    }]);
    sale = r.json.results[0].result;
    const got = await H.req('GET',
      `/api/outlet/${ctx.outletId}/sales/${sale.saleId}/credit`, { token: ctx.token });
    lines = got.json.lines;
  });
  after(() => H.teardown(ctx));

  const req = (method, p, body, token) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: token || ctx.token });
  const get = (p, token) => req('GET', p, undefined, token);
  const bal = async (code) => {
    const r = await get(`/reports/trial-balance?from=${today}&to=${today}`, mgr.token);
    return r.json.accounts.find((a) => a.code === code)?.balance ?? 0;
  };

  /* ── what may be credited ─────────────────────────────────────────────── */

  test('a sale offers its lines and how much of each is left', async () => {
    const r = await get(`/sales/${sale.saleId}/credit`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.lines.length, 2);
    const burger = r.json.lines.find((l) => l.itemId === 'BURGER');
    assert.equal(burger.qty, 3);
    assert.equal(burger.credited, 0);
    assert.equal(burger.remaining, 3);
    /* And what it was paid with, so a refund can go back the same way. */
    assert.deepEqual(r.json.tenders.map((t) => t.method), ['cash']);
  });

  /* ── raising one ──────────────────────────────────────────────────────── */

  test('"refund" is not a reason', async () => {
    const r = await req('POST', '/credit-notes', {
      saleId: sale.saleId, reason: 'no', refundMethod: 'cash',
      lines: [{ saleLineId: lines[0].id, qty: 1 }],
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /say why/);
  });

  test('a refund has to go somewhere the ledger knows about', async () => {
    const r = await req('POST', '/credit-notes', {
      saleId: sale.saleId, reason: 'the burger was raw', refundMethod: 'goodwill',
      lines: [{ saleLineId: lines[0].id, qty: 1 }],
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /refund by one of/);
  });

  test('more than was sold cannot be credited', async () => {
    const burger = lines.find((l) => l.itemId === 'BURGER');
    const r = await req('POST', '/credit-notes', {
      saleId: sale.saleId, reason: 'all of them were raw', refundMethod: 'cash',
      lines: [{ saleLineId: burger.id, qty: 4 }],
    });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /3 left to credit, not 4/);
  });

  test('raising posts NOTHING — it is a request', async () => {
    const before = { sales: await bal('4000'), cash: await bal('1000') };
    const burger = lines.find((l) => l.itemId === 'BURGER');

    const r = await req('POST', '/credit-notes', {
      saleId: sale.saleId, reason: 'one burger came back raw', refundMethod: 'cash',
      lines: [{ saleLineId: burger.id, qty: 1 }],
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.state, 'waiting for approval');
    assert.equal(r.json.no, null, 'and it holds no document number yet');
    assert.match(r.json.message, /Nothing has moved yet/);

    assert.equal(await bal('4000'), before.sales, 'income untouched');
    assert.equal(await bal('1000'), before.cash, 'and the drawer untouched');
  });

  test('a till session cannot approve its own note — or anybody\'s', async () => {
    const pending = (await get('/credit-notes')).json.notes[0];
    const r = await req('POST', `/credit-notes/${pending.id}/approve`, {});
    assert.equal(r.status, 403, 'approving is manager rank');
  });

  test('and a manager cannot approve one they raised themselves', async () => {
    /* The point of an approval is that a second pair of eyes saw it. */
    const own = await req('POST', '/credit-notes', {
      saleId: sale.saleId, reason: 'a manager raising their own', refundMethod: 'cash',
      lines: [{ saleLineId: lines[1].id, qty: 1 }],
    }, mgr.token);
    assert.equal(own.status, 201, own.text);
    const r = await req('POST', `/credit-notes/${own.json.id}/approve`, {}, mgr.token);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /somebody other than the person who raised it/);

    await req('POST', `/credit-notes/${own.json.id}/decline`,
      { reason: 'raised by mistake' }, admin.token);
  });

  /* ── approving ────────────────────────────────────────────────────────── */

  test('approving numbers it, posts it, and gives the money back', async () => {
    const before = {
      sales: await bal('4000'), cash: await bal('1000'),
      tax: await bal('2100'), service: await bal('2110'),
    };
    const pending = (await get('/credit-notes')).json.notes
      .find((n) => n.state === 'waiting for approval');

    const r = await req('POST', `/credit-notes/${pending.id}/approve`, {}, mgr.token);
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.no, /-CN-/, 'a numbered document, per §21');
    assert.equal(r.json.state, 'approved');
    assert.equal(r.json.approvedBy, 'Duty Manager');

    /* Every leg of the sale, in proportion and in reverse. */
    assert.ok(await bal('4000') < before.sales, 'income reduced');
    assert.equal(await bal('1000'), Math.round((before.cash - r.json.amount) * 100) / 100,
      'the drawer is lighter by exactly the refund');
    assert.ok(await bal('2100') < before.tax, 'and the guest got their tax back');
    assert.ok(await bal('2110') < before.service, 'and the service charge with it');
  });

  test('the entry is in the ledger, named for the document', async () => {
    const j = await get(`/accounting/journals?from=${today}&to=${today}&source=credit_note`,
      mgr.token);
    assert.equal(j.status, 200, j.text);
    const e = j.json.journals[0];
    assert.match(e.memo, /Credit note .*-CN-/);
    assert.ok(e.lines.some((l) => l.account === '4000' && l.dr > 0), 'income debited');
    assert.ok(e.lines.some((l) => l.account === '1000' && l.cr > 0), 'cash credited');
  });

  test('the sale now shows what is left', async () => {
    const r = await get(`/sales/${sale.saleId}/credit`);
    const burger = r.json.lines.find((l) => l.itemId === 'BURGER');
    assert.equal(burger.credited, 1);
    assert.equal(burger.remaining, 2);
    assert.ok(r.json.notes.some((n) => n.state === 'approved'));
  });

  test('approving twice does not refund twice', async () => {
    const done = (await get('/credit-notes')).json.notes.find((n) => n.state === 'approved');
    const cash = await bal('1000');
    const again = await req('POST', `/credit-notes/${done.id}/approve`, {}, mgr.token);
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.already, true);
    assert.equal(await bal('1000'), cash);
  });

  /* ── the arithmetic ───────────────────────────────────────────────────── */

  test('crediting EVERYTHING returns exactly what was taken', async () => {
    /* The property that makes the pro-rata share the right choice: no rounding
       to argue about with a guest holding a receipt. */
    const basket = [['BURGER', 1], ['COLA', 1]];
    const priced = H.priceIt(ctx, basket);
    const s = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: today, channel: 'dine_in', covers: 1,
        lines: basket.map(([itemId, qty]) => ({ itemId, qty })),
        payments: [{ method: 'card', amount: priced.total / 100 }],
      },
    }]);
    const saleId = s.json.results[0].result.saleId;
    const all = await get(`/sales/${saleId}/credit`);

    const raised = await req('POST', '/credit-notes', {
      saleId, reason: 'the whole table walked out', refundMethod: 'card',
      lines: all.json.lines.map((l) => ({ saleLineId: l.id, qty: l.qty })),
    });
    assert.equal(raised.status, 201, raised.text);
    assert.equal(raised.json.amount, all.json.sale.total,
      'a full credit is the sale total, to the laari');

    const done = await req('POST', `/credit-notes/${raised.json.id}/approve`, {}, mgr.token);
    assert.equal(done.status, 200, done.text);
    assert.match(done.json.message, /refunded by card/);
  });

  test('the trial balance still balances', async () => {
    const r = await get(`/reports/trial-balance?from=${today}&to=${today}`, mgr.token);
    assert.equal(r.json.balanced, true, JSON.stringify(r.json.totals));
  });

  /* ── the tax return ───────────────────────────────────────────────────── */

  test('the return NETS the refunds off, and says how much it netted', async () => {
    /* A return filed from the sales side alone would declare tax on money that
       was handed back — and would then disagree with the ledger by exactly the
       month's refunds, which reads as a reconciliation failure rather than as
       the missing subtraction it is. */
    const r = await get(`/reports/tax?from=${today}&to=${today}`, mgr.token);
    assert.equal(r.status, 200, r.text);
    const band = r.json.bands[0];
    assert.ok(band.credited > 0, 'the refunds are stated');
    assert.ok(band.creditNotes >= 2);
    assert.equal(r.json.agrees, true,
      'and the ledger and the sales agree once they are netted: '
      + JSON.stringify({ ledger: r.json.outputTax, sales: r.json.checkedAgainstSales }));
  });

  /* ── declining ────────────────────────────────────────────────────────── */

  test('declining needs a reason, and takes no document number with it', async () => {
    const burger = lines.find((l) => l.itemId === 'BURGER');
    const raised = await req('POST', '/credit-notes', {
      saleId: sale.saleId, reason: 'the guest asked for a refund on the rest',
      refundMethod: 'cash', lines: [{ saleLineId: burger.id, qty: 1 }],
    });

    const bad = await req('POST', `/credit-notes/${raised.json.id}/decline`, {}, mgr.token);
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /say why/);

    const r = await req('POST', `/credit-notes/${raised.json.id}/decline`,
      { reason: 'they ate all three' }, mgr.token);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.state, 'declined');
    assert.equal(r.json.no, null, 'no number was spent on it');
    assert.match(r.json.message, /Nothing was refunded/);
  });

  test('a declined note frees the quantity again', async () => {
    const r = await get(`/sales/${sale.saleId}/credit`);
    const burger = r.json.lines.find((l) => l.itemId === 'BURGER');
    assert.equal(burger.credited, 1, 'only the approved one counts');
    assert.equal(burger.remaining, 2);
  });

  test('a declined note cannot then be approved', async () => {
    const dead = (await get('/credit-notes')).json.notes.find((n) => n.state === 'declined');
    const r = await req('POST', `/credit-notes/${dead.id}/approve`, {}, mgr.token);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /was declined/);
  });

  /* ── the goods ────────────────────────────────────────────────────────── */

  test('stock comes back only when somebody says it came back', async () => {
    const stockOf = async (id) => {
      const r = await H.q(ctx, 'SELECT on_hand FROM ingredient WHERE id = $1', [id]);
      return Number(r.rows[0].on_hand);
    };
    const before = await stockOf('BEEF');

    const cola = lines.find((l) => l.itemId === 'COLA');
    const notReturned = await req('POST', '/credit-notes', {
      saleId: sale.saleId, reason: 'a cola nobody drank, poured away',
      refundMethod: 'cash', lines: [{ saleLineId: cola.id, qty: 1, restock: false }],
    });
    await req('POST', `/credit-notes/${notReturned.json.id}/approve`, {}, mgr.token);
    assert.equal(await stockOf('BEEF'), before, 'nothing moved');

    const burger = lines.find((l) => l.itemId === 'BURGER');
    const returned = await req('POST', '/credit-notes', {
      saleId: sale.saleId, reason: 'a burger sent back untouched',
      refundMethod: 'cash', lines: [{ saleLineId: burger.id, qty: 1, restock: true }],
    });
    const done = await req('POST', `/credit-notes/${returned.json.id}/approve`, {}, mgr.token);
    assert.equal(done.status, 200, done.text);
    assert.ok(done.json.restockValue > 0, done.text);
    assert.ok(await stockOf('BEEF') > before, 'the beef went back on the shelf');
    assert.match(done.json.message, /went back on/);
  });

  test('and the ledger still balances after all of it', async () => {
    const r = await get(`/reports/trial-balance?from=${today}&to=${today}`, mgr.token);
    assert.equal(r.json.balanced, true, JSON.stringify(r.json.totals));
  });

  /* ── who may see it ───────────────────────────────────────────────────── */

  test('a kitchen session reaches none of it', async () => {
    const kds = await H.addStaff(ctx, 'Chef', 1);
    assert.equal((await get('/credit-notes', kds.token)).status, 403);
    assert.equal((await get(`/sales/${sale.saleId}/credit`, kds.token)).status, 403);
  });

  test('the list says what is waiting and what has been given back', async () => {
    const r = await get('/credit-notes', mgr.token);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.canApprove, true);
    assert.ok(r.json.totals.credited > 0);
    assert.equal((await get('/credit-notes')).json.canApprove, false,
      'and a cashier is told they cannot, rather than shown a button that fails');
  });
});
