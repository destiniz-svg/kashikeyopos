'use strict';
/* Stage 1's acceptance criteria, against a real Postgres.
 *
 * "The invariants are database invariants; mocking them proves nothing." So
 * this boots the real server against a real database, provisions a real outlet
 * and sells through the real endpoint. Every assertion is a query, not a
 * return value — the question is what LANDED, not what was reported.
 *
 * The suite is deliberately weighted towards the things a client could lie
 * about, because the whole point of src/sale.js is that it no longer believes
 * a word the till says about money.
 *
 * Run:  npm test    (see test/helpers.js for the environment it needs)
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('the money chain', () => {
  let ctx;
  before(async () => { ctx = await H.bootOutlet(); });
  after(() => H.teardown(ctx));

  test('a cashier signs in with a PIN and gets a session', async () => {
    const r = await H.post('/api/auth/pin', { outletId: ctx.outletId, pin: ctx.tillPin });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.token, 'a token came back');
    assert.equal(r.json.rank, 2);
  });

  test('a wrong PIN is refused and counts against the lockout', async () => {
    const r = await H.post('/api/auth/pin', { outletId: ctx.outletId, pin: '0000' });
    assert.equal(r.status, 401);
    assert.match(r.json.error, /not recognised/i);
  });

  test('a sale posts, and every figure on it is the SERVER\'s', async () => {
    /* The till claims the bill was 1 rufiyaa with no tax. It sent real item ids
       and real quantities, which is all it is trusted for. */
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'dine_in', covers: 2,
        lines: [{ itemId: 'BURGER', qty: 2 }, { itemId: 'COLA', qty: 1 }],
        payments: [{ method: 'cash', amount: 0 }],
        gross: 1, tax: 0, total: 1, cogs: 0,                 // ← ignored
        journal: { date: ctx.today, memo: 'free lunch', lines: [] },  // ← ignored
      },
    }]);
    // The payment does not cover the server's bill, so the sale is refused
    // outright rather than posted at the client's figure.
    assert.equal(r.status, 200);
    assert.match(r.json.results[0].error, /do not equal the bill/i);

    const sales = await H.q(ctx, 'SELECT count(*)::int AS n FROM sale');
    assert.equal(sales.rows[0].n, 0, 'nothing was written for a refused sale');
  });

  test('a correctly tendered sale lands with server-derived tax and total', async () => {
    // BURGER 85.00 × 2 + COLA 25.00 = 195.00 goods, 10% service, 8% GGST within.
    const expected = H.priceIt(ctx, [['BURGER', 2], ['COLA', 1]]);
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'dine_in', covers: 2,
        lines: [{ itemId: 'BURGER', qty: 2 }, { itemId: 'COLA', qty: 1 }],
        payments: [{ method: 'cash', amount: (expected.total / 100).toFixed(2) }],
        clientTotal: (expected.total / 100).toFixed(2),
      },
    }]);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const res = r.json.results[0].result;
    assert.ok(res && res.receiptNo, JSON.stringify(r.json.results[0]));

    const s = await H.q(ctx,
      'SELECT gross, discount, service, tax, tax_code, tax_rate, rounding, total, cogs'
      + ' FROM sale WHERE receipt_no = $1', [res.receiptNo]);
    const row = s.rows[0];
    assert.equal(Number(row.total) * 100, expected.total);
    assert.equal(Number(row.tax) * 100, expected.tax);
    assert.equal(row.tax_code, 'GGST');
    assert.equal(Number(row.tax_rate), 8);
    assert.ok(Number(row.tax) > 0, 'the client asked for no tax and got taxed anyway');

    // The database's own constraint, re-checked as arithmetic.
    const lhs = Number(row.gross) - Number(row.discount) + Number(row.service)
      + Number(row.tax) + Number(row.rounding);
    assert.equal(lhs.toFixed(2), Number(row.total).toFixed(2));
  });

  test('the sale posted a BALANCED journal that nobody supplied', async () => {
    const j = await H.q(ctx,
      "SELECT j.id, j.jv_no, sum(l.dr) AS dr, sum(l.cr) AS cr"
      + ' FROM journal j JOIN journal_line l ON l.journal_id = j.id'
      + " WHERE j.source = 'sale' GROUP BY j.id, j.jv_no");
    assert.ok(j.rows.length >= 1, 'a journal was posted for the sale');
    for (const row of j.rows) {
      assert.equal(Number(row.dr).toFixed(2), Number(row.cr).toFixed(2),
        'journal ' + row.jv_no + ' does not balance');
    }
  });

  test('the journal credits the accounts a sale is supposed to credit', async () => {
    const l = await H.q(ctx,
      'SELECT l.account_code, sum(l.dr) AS dr, sum(l.cr) AS cr'
      + ' FROM journal j JOIN journal_line l ON l.journal_id = j.id'
      + " WHERE j.source = 'sale' GROUP BY l.account_code");
    const by = Object.fromEntries(l.rows.map((r) => [r.account_code, r]));
    assert.ok(by['1000'], 'cash in drawer was debited');
    assert.ok(by['4000'], 'sales was credited');
    assert.ok(by['2100'], 'GST payable was credited');
    assert.ok(by['2110'], 'service charge payable was credited');
    assert.ok(Number(by['2100'].cr) > 0, 'the GST credit is real money');
  });

  test('THE TRIAL BALANCE BALANCES', async () => {
    // Not "each journal balances" — the whole ledger. This is the query the
    // acceptance criterion names, and it is checked by query, not by eye.
    const tb = await H.q(ctx,
      'SELECT coalesce(sum(dr),0) - coalesce(sum(cr),0) AS delta FROM journal_line');
    assert.equal(Number(tb.rows[0].delta).toFixed(2), '0.00');
  });

  test('REPLAY: the same opId twice creates exactly one sale', async () => {
    const opId = H.uuid();
    const expected = H.priceIt(ctx, [['COLA', 1]]);
    const op = {
      opId, kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'takeaway', covers: 1,
        lines: [{ itemId: 'COLA', qty: 1 }],
        payments: [{ method: 'cash', amount: (expected.total / 100).toFixed(2) }],
      },
    };
    const first = await H.push(ctx, [op]);
    const again = await H.push(ctx, [op]);

    assert.ok(first.json.results[0].result.receiptNo);
    assert.equal(again.json.results[0].replay, true, 'the second was recognised as a replay');
    assert.equal(again.json.results[0].result.receiptNo,
      first.json.results[0].result.receiptNo, 'and returned the original result');

    const n = await H.q(ctx,
      "SELECT count(*)::int AS n FROM sale WHERE channel = 'takeaway'");
    assert.equal(n.rows[0].n, 1, 'exactly one sale exists');

    // And no second journal, no second stock move, no doubled receipt series.
    const jn = await H.q(ctx,
      "SELECT count(*)::int AS n FROM journal WHERE source_id = $1",
      [first.json.results[0].result.saleId]);
    assert.equal(jn.rows[0].n, 1, 'exactly one journal');
  });

  test('stock and COGS moved at the moment of sale', async () => {
    const m = await H.q(ctx,
      "SELECT ingredient_id, sum(qty) AS qty FROM stock_move WHERE reason = 'sale'"
      + ' GROUP BY ingredient_id');
    assert.ok(m.rows.length, 'the recipe was exploded into stock moves');
    for (const row of m.rows) {
      assert.ok(Number(row.qty) < 0, 'a sale consumes stock, so the move is negative');
    }

    /* on_hand is a cache of Σ stock_move.qty — including the opening move the
       harness now writes, so opening stock is IN the sum rather than added on
       top of it. Adding it again would double-count, and the assertion would
       then only pass while the fixture and the product were wrong together. */
    const drift = await H.q(ctx,
      'SELECT i.id, i.on_hand, coalesce(sum(m.qty),0) AS moved'
      + ' FROM ingredient i LEFT JOIN stock_move m ON m.ingredient_id = i.id'
      + ' GROUP BY i.id, i.on_hand');
    for (const row of drift.rows) {
      assert.equal(Number(row.on_hand).toFixed(4), Number(row.moved).toFixed(4),
        'on_hand for ' + row.id + ' does not equal the sum of its moves');
    }

    const cogs = await H.q(ctx, 'SELECT sum(cogs) AS c FROM sale');
    assert.ok(Number(cogs.rows[0].c) > 0, 'the sales carry a cost');
  });

  test("a sale's COGS equals the sum of its line costs", async () => {
    const bad = await H.q(ctx,
      'SELECT s.receipt_no, s.cogs, coalesce(sum(l.line_cost),0) AS lines'
      + ' FROM sale s LEFT JOIN sale_line l ON l.sale_id = s.id'
      + ' GROUP BY s.id, s.receipt_no, s.cogs'
      + ' HAVING round(s.cogs,2) <> round(coalesce(sum(l.line_cost),0),2)');
    assert.equal(bad.rows.length, 0,
      'these sales disagree with their own lines: ' + JSON.stringify(bad.rows));
  });

  test('an unknown item is refused, not silently priced at zero', async () => {
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'dine_in', covers: 1,
        lines: [{ itemId: 'NOT-A-REAL-ITEM', qty: 1 }],
        payments: [{ method: 'cash', amount: '0.00' }],
      },
    }]);
    assert.match(r.json.results[0].error, /unknown or inactive item/i);
  });

  test('a sale on a date no tax version covers is refused', async () => {
    // Silently applying today's rate to a historical date is how a filed
    // return gets restated by a till that was offline over a rate change.
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: '2001-01-01', channel: 'dine_in', covers: 1,
        lines: [{ itemId: 'COLA', qty: 1 }],
        payments: [{ method: 'cash', amount: '27.00' }],
      },
    }]);
    assert.match(r.json.results[0].error, /no tax version covers/i);
  });

  test('a till at rank 2 cannot hand-post a journal', async () => {
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'journal', at: Date.now(),
      payload: {
        date: ctx.today, memo: 'move the profit',
        lines: [{ account: '1000', dr: 1000 }, { account: '4000', cr: 1000 }],
      },
    }]);
    assert.match(r.json.results[0].error, /journal needs rank 3/i);
  });

  test('two terminals selling at once never mint the same receipt number', async () => {
    const expected = H.priceIt(ctx, [['COLA', 1]]);
    const amount = (expected.total / 100).toFixed(2);
    const ops = [];
    for (let i = 0; i < 12; i++) {
      ops.push(H.push(ctx, [{
        opId: H.uuid(), kind: 'sale', at: Date.now(),
        payload: {
          businessDate: ctx.today, channel: 'concurrent', covers: 1,
          lines: [{ itemId: 'COLA', qty: 1 }],
          payments: [{ method: 'cash', amount }],
        },
      }]));
    }
    const all = await Promise.all(ops);
    const nos = all.map((r) => r.json.results[0].result && r.json.results[0].result.receiptNo)
      .filter(Boolean);
    assert.equal(nos.length, 12, 'all twelve landed: ' + JSON.stringify(all.map((r) => r.json.results[0])));
    assert.equal(new Set(nos).size, 12, 'and every receipt number is distinct');
  });

  test('the ledger still balances after everything above', async () => {
    const tb = await H.q(ctx,
      'SELECT coalesce(sum(dr),0) - coalesce(sum(cr),0) AS delta FROM journal_line');
    assert.equal(Number(tb.rows[0].delta).toFixed(2), '0.00');

    const n = await H.q(ctx, 'SELECT count(*)::int AS n FROM sale');
    assert.ok(n.rows[0].n >= 14, 'and there were real sales in it: ' + n.rows[0].n);
  });

  test('a closed sale cannot be deleted, even by the outlet role', async () => {
    await assert.rejects(
      () => H.q(ctx, 'DELETE FROM sale'),
      /permission denied/i,
      'the financial record is corrected by credit note, never erased');
  });
});
