'use strict';
/* Vendors and Purchases — §2 (`vendors`, `purchases`), 08-BUILD-STAGES §12.
 *
 * §12's promise, from the buying end: "a price captured on a GRN updates the
 * ingredient's average cost and therefore every dish that uses it". The
 * interesting cases are all about the UNPRICED delivery, which is the normal
 * one in a kitchen: fish arrives, the driver leaves, the invoice turns up on
 * Thursday. The stock has to rise the moment it is in the walk-in, and the
 * value has to be corrected later without anybody re-keying anything.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('vendors and purchases', () => {
  let ctx, mgr, admin, supplierId, unpricedId;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Head Chef', 3);
    admin = await H.addStaff(ctx, 'General Manager', 4);
  });
  after(() => H.teardown(ctx));

  const req = (method, p, body, token) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: token || mgr.token });
  const get = (p, token) => req('GET', p, undefined, token);
  const op = (kind, payload, token) =>
    H.push({ ...ctx, token: token || mgr.token }, [{ opId: H.uuid(), kind, at: Date.now(), payload }]);
  const cost = async (id) =>
    Number((await H.q(ctx, 'SELECT avg_cost FROM ingredient WHERE id = $1', [id])).rows[0].avg_cost);
  const onHand = async (id) =>
    Number((await H.q(ctx, 'SELECT on_hand FROM ingredient WHERE id = $1', [id])).rows[0].on_hand);

  /* ── the supplier master ──────────────────────────────────────────────── */

  test('a manager can read the supplier list but not write it', async () => {
    assert.equal((await get('/vendors')).status, 200);
    const r = await req('POST', '/vendors', { name: 'Malé Fish Co' });
    assert.equal(r.status, 403, 'terms are how long the restaurant holds somebody else\'s money');
  });

  test('an admin adds a supplier with payment terms', async () => {
    const r = await req('POST', '/vendors',
      { name: 'Malé Fish Co', trn: 'T1234', termsDays: 14 }, admin.token);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.termsDays, 14);
    supplierId = r.json.id;
  });

  test('nonsense terms are refused rather than stored', async () => {
    const r = await req('POST', '/vendors', { name: 'X', termsDays: 4000 }, admin.token);
    assert.equal(r.status, 400);
    assert.match(r.json.error, /between 0 and 365/);
  });

  test('a cashier reaches neither the list nor a supplier', async () => {
    assert.equal((await get('/vendors', ctx.token)).status, 403);
    assert.equal((await get('/vendors/' + supplierId, ctx.token)).status, 403);
  });

  /* ── a priced delivery ────────────────────────────────────────────────── */

  test('a priced GRN raises stock, re-averages cost, and owes the supplier', async () => {
    const beforeQty = await onHand('BEEF');
    const beforeCost = await cost('BEEF');

    const r = await op('delivery_receive', {
      supplierId,
      lines: [{ ingredientId: 'BEEF', qty: 10000, unitPrice: 0.10 }],
      invoiceNo: 'INV-001',
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const res = r.json.results[0].result;
    assert.equal(res.priced, true);
    assert.match(res.grnNo, /-GRN-\d{6}$/, 'a delivery has a number a supplier can be phoned about');
    assert.equal(res.total, '1000.00');

    assert.equal(await onHand('BEEF'), beforeQty + 10000);
    const after = await cost('BEEF');
    assert.ok(after > beforeCost && after < 0.10,
      'weighted average: between the old cost and the new price, not either of them');

    // §12: every dish using it recosts. Nothing to do — costing reads avg_cost.
    const recipes = await get('/recipes');
    const burger = recipes.json.items.find((x) => x.itemId === 'BURGER');
    assert.ok(burger.plateCost > 0);
  });

  test('the delivery posts ONE journal, not one per line', async () => {
    const r = await op('delivery_receive', {
      supplierId,
      lines: [
        { ingredientId: 'BUN', qty: 100, unitPrice: 5 },
        { ingredientId: 'SYRUP', qty: 5000, unitPrice: 0.02 },
      ],
    });
    const id = r.json.results[0].result.deliveryId;
    const j = await H.q(ctx,
      "SELECT count(*)::int AS n FROM journal WHERE source = 'stock' AND source_id = $1", [id]);
    assert.equal(j.rows[0].n, 1,
      'an accountant looking at accounts payable should see a delivery, not a shopping list');

    const lines = await H.q(ctx,
      'SELECT l.account_code, l.dr, l.cr FROM journal j JOIN journal_line l'
      + " ON l.journal_id = j.id WHERE j.source = 'stock' AND j.source_id = $1"
      + ' ORDER BY l.account_code', [id]);
    const byCode = Object.fromEntries(lines.rows.map((x) => [x.account_code, x]));
    // 100 × 5 + 5000 × 0.02 = 600.00
    assert.equal(Number(byCode['1100'].dr).toFixed(2), '600.00');
    assert.equal(Number(byCode['2000'].cr).toFixed(2), '600.00');
  });

  test('an invoice is due on the supplier\'s own terms, not a typed date', async () => {
    const p = await get('/purchases');
    const inv = p.json.ageing.invoices.find((x) => x.invoiceNo === 'INV-001');
    assert.ok(inv, 'the invoice is outstanding');
    const days = Math.round(
      (new Date(inv.dueDate).getTime() - new Date(inv.invoiceDate).getTime()) / 86400000);
    assert.equal(days, 14, 'terms are the supplier\'s; a hand-keyed date is a date keyed wrongly');
    assert.equal(inv.outstanding.toFixed(2), '1000.00');
  });

  /* ── the unpriced delivery, which is the normal one ───────────────────── */

  test('a delivery with no invoice still raises the stock', async () => {
    /* The stock has to rise the moment it is in the walk-in or the next sale
       oversells it. */
    const beforeQty = await onHand('BEEF');
    const beforeCost = await cost('BEEF');

    const r = await op('delivery_receive', {
      supplierId, lines: [{ ingredientId: 'BEEF', qty: 4000 }], note: 'no docket with the driver',
    });
    const res = r.json.results[0].result;
    assert.equal(res.priced, false);
    assert.match(res.message, /valued at what it was already worth/);
    unpricedId = res.deliveryId;

    assert.equal(await onHand('BEEF'), beforeQty + 4000, 'the fish is on the shelf');
    assert.equal((await cost('BEEF')).toFixed(4), beforeCost.toFixed(4),
      'and valued at what the shelf already thought it was worth — not at zero,'
      + ' which would make every dish using it look free');
  });

  test('a PART-priced delivery counts as unpriced', async () => {
    const r = await op('delivery_receive', {
      supplierId,
      lines: [{ ingredientId: 'BUN', qty: 10, unitPrice: 6 }, { ingredientId: 'SYRUP', qty: 100 }],
    });
    assert.equal(r.json.results[0].result.priced, false,
      'otherwise the missing line sits at the old average for ever');
    await H.asOwner(ctx, 'DELETE FROM delivery WHERE id = $1',
      [r.json.results[0].result.deliveryId]);
  });

  test('it is on the manager\'s morning list, by name', async () => {
    const t = await H.req('GET', `/api/outlet/${ctx.outletId}/today?date=${ctx.today}`,
      { token: mgr.token });
    const item = t.json.items.find((i) => i.id === 'delivery-unpriced');
    assert.ok(item, '§2 names "unpriced deliveries" literally');
    assert.equal(item.where.module, 'purchases');
  });

  test('pricing it corrects the cost and settles what is owed', async () => {
    const beforeCost = await cost('BEEF');
    const r = await op('delivery_price', {
      deliveryId: unpricedId,
      lines: [{ ingredientId: 'BEEF', unitPrice: 0.15 }],
      invoiceNo: 'INV-002',
    }, admin.token);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const res = r.json.results[0].result;
    assert.equal(res.priced, true);
    assert.equal(res.total, '600.00');       // 4,000 × 0.15

    assert.ok(await cost('BEEF') > beforeCost,
      'the real price was higher than the guess, so the shelf is worth more');

    const p = await get('/purchases');
    const inv = p.json.ageing.invoices.find((x) => x.invoiceNo === 'INV-002');
    assert.ok(inv, 'and the supplier is now owed a figure somebody has agreed');
  });

  test('a priced delivery cannot be priced twice', async () => {
    const r = await op('delivery_price', {
      deliveryId: unpricedId, lines: [{ ingredientId: 'BEEF', unitPrice: 0.20 }],
    }, admin.token);
    assert.match(r.json.results[0].error, /already priced/);
  });

  test('pricing refuses to leave a line unanswered', async () => {
    const d = await op('delivery_receive', {
      supplierId,
      lines: [{ ingredientId: 'BUN', qty: 20 }, { ingredientId: 'SYRUP', qty: 200 }],
    });
    const id = d.json.results[0].result.deliveryId;
    const r = await op('delivery_price',
      { deliveryId: id, lines: [{ ingredientId: 'BUN', unitPrice: 5 }] }, admin.token);
    assert.match(r.json.results[0].error, /still missing: SYRUP/);
  });

  test('a MANAGER can receive but not price — pricing moves money', async () => {
    const r = await op('delivery_price',
      { deliveryId: unpricedId, lines: [] }, mgr.token);
    assert.match(r.json.results[0].error, /rank 4/);
  });

  test('a price correction on stock ALREADY SOLD hits cost of sales, not inventory', async () => {
    /* The subtle one, and the reason the correction is split in two. If the
       fish has been eaten, the shelf is empty — putting the correction on 1100
       would inflate an inventory figure against stock that is not in the
       building, and nobody would ever find it. */
    const d = await op('delivery_receive', {
      supplierId, lines: [{ ingredientId: 'SYRUP', qty: 1000 }],
    });
    const id = d.json.results[0].result.deliveryId;

    // Drink the lot, and then some, so on-hand is zero or below.
    await H.asOwner(ctx, "INSERT INTO stock_move (ingredient_id, qty, unit_cost, value, reason)"
      + " SELECT 'SYRUP', -on_hand, avg_cost, 0, 'waste' FROM ingredient WHERE id = 'SYRUP'");
    await H.asOwner(ctx, 'UPDATE ingredient SET on_hand ='
      + " (SELECT coalesce(sum(qty),0) FROM stock_move WHERE ingredient_id = 'SYRUP')"
      + " WHERE id = 'SYRUP'");
    assert.equal(await onHand('SYRUP'), 0);

    const r = await op('delivery_price', {
      deliveryId: id, lines: [{ ingredientId: 'SYRUP', unitPrice: 0.05 }],
    }, admin.token);
    const res = r.json.results[0].result;
    assert.equal(res.correction.onShelf, '0.00', 'nothing left to revalue');
    assert.ok(Number(res.correction.alreadySold) > 0);

    const j = await H.q(ctx,
      'SELECT l.account_code, l.dr FROM journal j JOIN journal_line l'
      + " ON l.journal_id = j.id WHERE j.source = 'stock' AND j.source_id = $1"
      + " AND l.dr > 0", [id]);
    assert.ok(j.rows.some((x) => x.account_code === '5100'),
      'the correction is a cost-of-sales one');
    assert.ok(!j.rows.some((x) => x.account_code === '1100' && Number(x.dr) > 600),
      'and not a phantom addition to the shelf');
  });

  /* ── ageing and payment ───────────────────────────────────────────────── */

  test('ageing buckets from the DUE date, not the invoice date', async () => {
    /* An invoice on 60-day terms is not overdue at 45 days, and an ageing
       report that counts from the invoice date says it is. */
    await H.asOwner(ctx,
      "UPDATE vendor_invoice SET due_date = current_date - 40 WHERE invoice_no = 'INV-001'");
    const p = await get('/purchases');
    const inv = p.json.ageing.invoices.find((x) => x.invoiceNo === 'INV-001');
    assert.equal(inv.bucket, 'd60');
    assert.equal(inv.daysOver, 40);
    assert.ok(p.json.ageing.totals.d60 >= 1000);
    assert.ok(p.json.ageing.overdue >= 1000);
    assert.ok(p.json.ageing.owed >= p.json.ageing.overdue);
  });

  test('an overdue supplier is on the morning list too', async () => {
    const t = await H.req('GET', `/api/outlet/${ctx.outletId}/today?date=${ctx.today}`,
      { token: mgr.token });
    const item = t.json.items.find((i) => i.id === 'supplier-overdue');
    assert.ok(item, '§2 names "overdue suppliers" literally as well');
    assert.match(item.detail, /40 days over/);
    assert.equal(item.where.module, 'purchases');
  });

  test('paying an invoice clears the payable and moves the money', async () => {
    const p = await get('/purchases');
    const inv = p.json.ageing.invoices.find((x) => x.invoiceNo === 'INV-001');
    const r = await op('invoice_pay', { invoiceId: inv.id, amount: 400, method: 'bank' }, admin.token);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.results[0].result.outstanding, '600.00');
    assert.equal(r.json.results[0].result.settled, false);

    const j = await H.q(ctx,
      'SELECT l.account_code, l.dr, l.cr FROM journal j JOIN journal_line l'
      + " ON l.journal_id = j.id WHERE j.source = 'stock' AND j.source_id = $1", [inv.id]);
    const byCode = Object.fromEntries(j.rows.map((x) => [x.account_code, x]));
    assert.equal(Number(byCode['2000'].dr).toFixed(2), '400.00', 'the payable comes down');
    assert.equal(Number(byCode['1010'].cr).toFixed(2), '400.00', 'and the bank pays it');
  });

  test('overpaying an invoice is refused', async () => {
    const p = await get('/purchases');
    const inv = p.json.ageing.invoices.find((x) => x.invoiceNo === 'INV-001');
    const r = await op('invoice_pay', { invoiceId: inv.id, amount: 5000 }, admin.token);
    assert.match(r.json.results[0].error, /more than is outstanding/);
  });

  test('settling it in full takes it off the ageing', async () => {
    const p = await get('/purchases');
    const inv = p.json.ageing.invoices.find((x) => x.invoiceNo === 'INV-001');
    const r = await op('invoice_pay', { invoiceId: inv.id, amount: inv.outstanding }, admin.token);
    assert.equal(r.json.results[0].result.settled, true);
    const after = await get('/purchases');
    assert.ok(!after.json.ageing.invoices.some((x) => x.invoiceNo === 'INV-001'));
  });

  /* ── price history ────────────────────────────────────────────────────── */

  test('a supplier shows what this outlet has been charged, and which way it moved', async () => {
    const r = await get('/vendors/' + supplierId);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.deliveries.length >= 3);

    const beef = r.json.priceHistory.find((x) => x.ingredientId === 'BEEF');
    assert.ok(beef, 'the price history §2 asks for');
    assert.ok(beef.prices.length >= 2, 'more than one price means a direction');
    // Newest first: 0.15 then 0.10 — up 50%.
    assert.equal(beef.latest, 0.15);
    assert.equal(beef.previous, 0.10);
    assert.equal(beef.changePct, 50,
      '"they have put the tuna up" should be a thing somebody can see, not suspect');
  });

  test('the trial balance still balances after all of that', async () => {
    const r = await get('/reports/trial-balance', admin.token);
    assert.equal(r.json.balanced, true);
    assert.equal(r.json.totals.difference, 0);
  });

  test('every table in the outlet schema is reachable by the outlet role', async () => {
    /* This is here because a migration added `delivery_line` and forgot the
       grant. provision_outlet grants on ALL TABLES IN SCHEMA at the moment it
       runs, so a table added LATER is invisible to every outlet that already
       exists — while a freshly provisioned one works perfectly. Every test
       outlet is freshly provisioned, so the suite went green and the first
       screen to ask for it got "permission denied for table delivery_line".
       Adding a table is two statements, and this is the test that says so. */
    const tables = await H.q(ctx,
      'SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename',
      [ctx.schema]);
    assert.ok(tables.rows.length > 10);
    const denied = [];
    for (const t of tables.rows) {
      try {
        await H.q(ctx, 'SELECT 1 FROM ' + ctx.schema + '.' + t.tablename + ' LIMIT 1');
      } catch (e) {
        denied.push(t.tablename + ': ' + e.message);
      }
    }
    assert.deepEqual(denied, [], 'tables the outlet cannot read');
  });

  test('an unknown supplier or delivery is 404, not a 500', async () => {
    assert.equal((await get('/vendors/' + H.uuid())).status, 404);
    assert.equal((await get('/vendors/not-a-uuid')).status, 404);
    assert.equal((await get('/purchases/' + H.uuid())).status, 404);
  });

  test('a delivery against an unknown supplier is refused', async () => {
    const r = await op('delivery_receive', {
      supplierId: H.uuid(), lines: [{ ingredientId: 'BUN', qty: 1, unitPrice: 1 }],
    });
    assert.match(r.json.results[0].error, /no such supplier/);
  });
});
