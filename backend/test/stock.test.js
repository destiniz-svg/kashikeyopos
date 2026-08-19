'use strict';
/* Inventory and the stock ledger — §2 (`inventory`, `ledger`), §15 of the brief.
 *
 * §15 sets the test this file is built around: "Inventory should be
 * explainable. A user should be able to answer: «Why is this item showing 17.4
 * units?»" So the assertions are mostly about the LEDGER explaining the cache,
 * and about the accounts moving whenever value does.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('inventory and the stock ledger', () => {
  let ctx, mgr;
  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Storekeeper', 3);
  });
  after(() => H.teardown(ctx));

  const api = (method, p, body) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: mgr.token });
  const op = (kind, payload, token) =>
    H.push({ ...ctx, token: token || mgr.token }, [{ opId: H.uuid(), kind, at: Date.now(), payload }]);

  /* The invariant this whole module exists to hold. Asserted after every kind
     of operation below, not once at the end — the question is which operation
     breaks it, not whether something did. */
  const assertCacheMatchesLedger = async (why) => {
    const drift = await H.q(ctx,
      'SELECT i.id, i.on_hand, coalesce(sum(m.qty),0) AS moved'
      + ' FROM ingredient i LEFT JOIN stock_move m ON m.ingredient_id = i.id'
      + ' GROUP BY i.id, i.on_hand'
      + ' HAVING i.on_hand <> coalesce(sum(m.qty),0)');
    assert.equal(drift.rows.length, 0,
      'on_hand disagrees with its own ledger after ' + why + ': ' + JSON.stringify(drift.rows));
  };

  test('a cashier cannot see inventory', async () => {
    const r = await H.req('GET', `/api/outlet/${ctx.outletId}/inventory`, { token: ctx.token });
    assert.equal(r.status, 403);
  });

  test('opening stock lands, and credits EQUITY not payables', async () => {
    // What was already in the store when the system arrived is not a debt.
    const r = await op('stock_receive', {
      ingredientId: 'BEEF', qty: 5000, unitCost: 0.09, reason: 'opening', date: ctx.today,
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));

    const j = await H.q(ctx,
      "SELECT l.account_code, l.dr, l.cr FROM journal j JOIN journal_line l ON l.journal_id = j.id"
      + " WHERE j.source = 'stock' ORDER BY l.account_code");
    const codes = j.rows.map((x) => x.account_code);
    assert.ok(codes.includes('1100'), 'inventory debited');
    assert.ok(codes.includes('3000'), 'owner equity credited');
    assert.ok(!codes.includes('2000'), 'and nothing was owed to a supplier');
    await assertCacheMatchesLedger('opening stock');
  });

  test('a purchase credits ACCOUNTS PAYABLE', async () => {
    await op('stock_receive', { ingredientId: 'BUN', qty: 200, unitCost: 4.5, date: ctx.today });
    const j = await H.q(ctx,
      "SELECT DISTINCT l.account_code FROM journal j JOIN journal_line l ON l.journal_id = j.id"
      + " WHERE j.source = 'stock'");
    assert.ok(j.rows.map((x) => x.account_code).includes('2000'));
    await assertCacheMatchesLedger('a purchase');
  });

  test('WEIGHTED AVERAGE: receiving at a new price re-averages the cost', async () => {
    /* 08-BUILD-STAGES §12 from the stock side: a price captured on receipt
       updates the ingredient's average and therefore every dish using it. */
    const before = await H.q(ctx, "SELECT on_hand, avg_cost FROM ingredient WHERE id = 'BEEF'");
    const onHand = Number(before.rows[0].on_hand);
    const oldCost = Number(before.rows[0].avg_cost);

    await op('stock_receive', { ingredientId: 'BEEF', qty: 5000, unitCost: 0.15, date: ctx.today });

    const after = await H.q(ctx, "SELECT avg_cost FROM ingredient WHERE id = 'BEEF'");
    const expected = (onHand * oldCost + 5000 * 0.15) / (onHand + 5000);
    assert.equal(Number(after.rows[0].avg_cost).toFixed(4), expected.toFixed(4));
  });

  test('and every dish using it reprices itself', async () => {
    await H.req('PUT', `/api/outlet/${ctx.outletId}/recipes/BURGER`,
      { body: { lines: [{ ingredientId: 'BEEF', qty: 150 }] }, token: mgr.token });
    const a = await api('GET', '/recipes/BURGER');
    await op('stock_receive', { ingredientId: 'BEEF', qty: 10000, unitCost: 0.30, date: ctx.today });
    const b = await api('GET', '/recipes/BURGER');
    assert.ok(b.json.plateCost > a.json.plateCost,
      'the dish costs more because its ingredient does: ' + a.json.plateCost + ' → ' + b.json.plateCost);
  });

  test('WASTE needs a reason', async () => {
    // §23: wastage with no reason is an unexplained hole in the stock and in
    // the margin.
    const r = await op('stock_waste', { ingredientId: 'BEEF', qty: 100 });
    assert.match(r.json.results[0].error, /say why/i);
  });

  test('waste reduces stock and charges it to 5100, not to cost of sales', async () => {
    const r = await op('stock_waste', {
      ingredientId: 'BEEF', qty: 500, note: 'walk-in failed overnight', date: ctx.today,
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));

    const m = await H.q(ctx,
      "SELECT qty, reason FROM stock_move WHERE reason = 'waste' ORDER BY at DESC LIMIT 1");
    assert.equal(Number(m.rows[0].qty), -500);

    const j = await H.q(ctx,
      "SELECT l.account_code, l.dr, l.cr FROM journal j JOIN journal_line l ON l.journal_id = j.id"
      + " WHERE j.memo LIKE 'Wastage%' ORDER BY l.account_code");
    const by = Object.fromEntries(j.rows.map((x) => [x.account_code, x]));
    assert.ok(Number(by['5100'].dr) > 0, 'stock variance carries it');
    assert.ok(Number(by['1100'].cr) > 0, 'inventory goes down');
    assert.ok(!by['5000'], 'and it is NOT cost of sales — nobody sold it');
    await assertCacheMatchesLedger('waste');
  });

  test('the reason is on the audit trail', async () => {
    const a = await H.q(ctx,
      "SELECT after FROM chain.audit WHERE action = 'stock_waste' ORDER BY at DESC LIMIT 1");
    assert.match(a.rows[0].after.note, /walk-in failed/);
  });

  test('A COUNT makes the counted figure true and posts the difference', async () => {
    const before = await H.q(ctx, "SELECT on_hand FROM ingredient WHERE id = 'BUN'");
    const expected = Number(before.rows[0].on_hand);
    const counted = expected - 17;         // seventeen buns nobody can find

    const r = await op('stock_count', {
      lines: [{ ingredientId: 'BUN', counted }], note: 'Friday count', date: ctx.today,
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.results[0].result.lines[0].variance, -17);

    const after = await H.q(ctx, "SELECT on_hand FROM ingredient WHERE id = 'BUN'");
    assert.equal(Number(after.rows[0].on_hand), counted, 'the count is now the truth');
    await assertCacheMatchesLedger('a count');
  });

  test('a count that finds MORE debits inventory', async () => {
    const before = await H.q(ctx, "SELECT on_hand FROM ingredient WHERE id = 'SYRUP'");
    const counted = Number(before.rows[0].on_hand) + 250;
    await op('stock_count', { lines: [{ ingredientId: 'SYRUP', counted }], date: ctx.today });

    const j = await H.q(ctx,
      "SELECT l.account_code, l.dr, l.cr FROM journal j JOIN journal_line l ON l.journal_id = j.id"
      + " WHERE j.memo LIKE 'Stock count variance%' ORDER BY j.posted_at DESC, l.account_code LIMIT 2");
    const by = Object.fromEntries(j.rows.map((x) => [x.account_code, x]));
    assert.ok(Number(by['1100'].dr) > 0, 'found more: inventory up');
    assert.ok(Number(by['5100'].cr) > 0, 'and the variance is a credit');
    await assertCacheMatchesLedger('a count that found more');
  });

  test('a count that matches writes NO movement', async () => {
    /* A zero-quantity move would be noise in the very history somebody reads to
       explain a number. The count_line records that it was counted. */
    const before = await H.q(ctx, "SELECT on_hand FROM ingredient WHERE id = 'BUN'");
    const movesBefore = await H.q(ctx,
      "SELECT count(*)::int AS n FROM stock_move WHERE ingredient_id = 'BUN'");

    await op('stock_count', {
      lines: [{ ingredientId: 'BUN', counted: Number(before.rows[0].on_hand) }], date: ctx.today,
    });

    const movesAfter = await H.q(ctx,
      "SELECT count(*)::int AS n FROM stock_move WHERE ingredient_id = 'BUN'");
    assert.equal(movesAfter.rows[0].n, movesBefore.rows[0].n);

    /* Ordered by the count's own timestamp, not by count_id: the id is a uuid,
       so DESC on it sorts lexicographically and would happily return an older
       count than the one just taken. */
    const cl = await H.q(ctx,
      "SELECT cl.variance FROM count_line cl JOIN stock_count sc ON sc.id = cl.count_id"
      + " WHERE cl.ingredient_id = 'BUN' ORDER BY sc.at DESC LIMIT 1");
    assert.equal(Number(cl.rows[0].variance), 0, 'but the count itself is recorded');
  });

  test('WHY IS THIS ITEM SHOWING N UNITS — the ledger explains it', async () => {
    // §15's own test, asserted directly.
    const r = await api('GET', '/inventory/BEEF/ledger');
    assert.equal(r.status, 200);
    assert.equal(r.json.ledgerSum, r.json.ingredient.onHand,
      'the movements sum to exactly the figure on the shelf');

    const reasons = r.json.moves.map((m) => m.reason);
    assert.ok(reasons.includes('opening'), 'opening stock is in the history');
    assert.ok(reasons.includes('purchase'));
    assert.ok(reasons.includes('waste'));

    // Every row says what the balance was immediately after it.
    const newest = r.json.moves[0];
    assert.equal(newest.balance, r.json.ingredient.onHand);
  });

  test('a SALE appears in the ledger, pointing at its receipt', async () => {
    const sold = await H.push(ctx, [{
      opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'dine_in', covers: 1,
        lines: [{ itemId: 'BURGER', qty: 1 }],
        payments: [{ method: 'cash', amount: '93.50' }],   // 85.00 + 10% service
      },
    }]);
    const receipt = sold.json.results[0].result;
    assert.ok(receipt && receipt.receiptNo, JSON.stringify(sold.json.results[0]));

    const r = await api('GET', '/inventory/BEEF/ledger');
    const saleMove = r.json.moves.find((m) => m.reason === 'sale');
    assert.ok(saleMove, 'the sale consumed stock and said so');
    assert.equal(saleMove.source, receipt.receiptNo, 'and names the receipt that caused it');
    await assertCacheMatchesLedger('a sale');
  });

  test('a sale does NOT double-post cost of sales', async () => {
    /* The sale path already books 5000/1100. If the stock module posted again
       for the same consumption, cost of sales would be double for every dish
       sold — the kind of error that looks like a margin problem for months. */
    const j = await H.q(ctx,
      "SELECT count(*)::int AS n FROM journal WHERE source = 'stock'"
      + " AND memo LIKE '%Sale%'");
    assert.equal(j.rows[0].n, 0);
  });

  test('the inventory list values stock and flags what is below par', async () => {
    await H.req('PATCH', `/api/outlet/${ctx.outletId}/ingredients/BUN`,
      { body: { par: 100000 }, token: mgr.token });
    const r = await api('GET', '/inventory');
    assert.equal(r.status, 200);
    const bun = r.json.items.find((i) => i.id === 'BUN');
    assert.equal(bun.belowPar, true);
    assert.ok(r.json.belowPar >= 1);
    assert.ok(r.json.totalValue > 0, 'the stock is worth something, in laari');

    const beef = r.json.items.find((i) => i.id === 'BEEF');
    assert.equal(beef.value, Math.round(beef.onHand * beef.avgCost * 100));
  });

  test('THE TRIAL BALANCE STILL BALANCES after all of it', async () => {
    const tb = await H.q(ctx,
      'SELECT coalesce(sum(dr),0) - coalesce(sum(cr),0) AS delta FROM journal_line');
    assert.equal(Number(tb.rows[0].delta).toFixed(2), '0.00');
  });

  test('REPLAY: the same movement twice moves stock once', async () => {
    const opId = H.uuid();
    const body = [{
      opId, kind: 'stock_waste', at: Date.now(),
      payload: { ingredientId: 'SYRUP', qty: 10, note: 'spillage', date: ctx.today },
    }];
    const before = await H.q(ctx, "SELECT on_hand FROM ingredient WHERE id = 'SYRUP'");
    await H.push({ ...ctx, token: mgr.token }, body);
    const again = await H.push({ ...ctx, token: mgr.token }, body);
    assert.equal(again.json.results[0].replay, true);

    const after = await H.q(ctx, "SELECT on_hand FROM ingredient WHERE id = 'SYRUP'");
    assert.equal(Number(after.rows[0].on_hand), Number(before.rows[0].on_hand) - 10,
      'ten went, not twenty');
    await assertCacheMatchesLedger('a replayed waste');
  });

  test('a till cannot move stock', async () => {
    const r = await op('stock_waste',
      { ingredientId: 'BEEF', qty: 1, note: 'x' }, ctx.token);
    assert.match(r.json.results[0].error, /stock_waste needs rank 3/);
  });

  test('an unknown ingredient is refused', async () => {
    const r = await op('stock_receive', { ingredientId: 'NOPE', qty: 1, unitCost: 1 });
    assert.match(r.json.results[0].error, /no such ingredient/i);
  });

  test('a negative counted quantity is refused', async () => {
    const r = await op('stock_count', { lines: [{ ingredientId: 'BEEF', counted: -5 }] });
    assert.match(r.json.results[0].error, /cannot be negative/i);
  });
});
