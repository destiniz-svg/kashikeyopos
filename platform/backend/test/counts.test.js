'use strict';
/* Stock Counts and the Stock Ledger — §2 (`counts`, `ledger`):
 *   "Count sheets by category; variance in units and MVR; approval above a
 *    threshold."
 *   "Every movement with its reason and source document."
 *
 * A stock count is the one operation in the platform where a person types a
 * number and the accounts move to meet it. Everything else is derived — a sale
 * prices itself from the item master, a delivery from its invoice — so this is
 * the easiest place in the whole system to write off a theft, and the approval
 * rules are the point of this file rather than a detail of it.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('stock counts and the stock ledger', () => {
  let ctx, mgr, admin, pendingId;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Storekeeper', 3);
    admin = await H.addStaff(ctx, 'General Manager', 4);
  });
  after(() => H.teardown(ctx));

  const get = (p, token) =>
    H.req('GET', `/api/outlet/${ctx.outletId}${p}`, { token: token || mgr.token });
  const op = (kind, payload, token) =>
    H.push({ ...ctx, token: token || mgr.token }, [{ opId: H.uuid(), kind, at: Date.now(), payload }]);
  const onHand = async (id) =>
    Number((await H.q(ctx, 'SELECT on_hand FROM ingredient WHERE id = $1', [id])).rows[0].on_hand);

  /* ── with no threshold set, nothing changes ───────────────────────────── */

  test('with no threshold configured a count posts straight away', async () => {
    /* The honest default for a new outlet: the system has not been told a
       policy, so it does not invent one. */
    const r = await op('stock_count', { lines: [{ ingredientId: 'BUN', counted: 480 }] });
    const res = r.json.results[0].result;
    assert.equal(res.status, 'posted');
    assert.equal(await onHand('BUN'), 480, 'the stock moved to what was counted');
  });

  test('a count that found exactly what was expected writes no movement', async () => {
    const before = (await H.q(ctx, 'SELECT count(*)::int AS n FROM stock_move')).rows[0].n;
    await op('stock_count', { lines: [{ ingredientId: 'BUN', counted: 480 }] });
    const after = (await H.q(ctx, 'SELECT count(*)::int AS n FROM stock_move')).rows[0].n;
    assert.equal(after, before, 'a zero variance is noise in the history, not a movement');
    // …but the sheet still records that it was checked.
    const sheets = (await get('/counts')).json.counts;
    assert.equal(sheets[0].lines, 1);
    assert.equal(sheets[0].differed, 0);
  });

  /* ── the threshold ────────────────────────────────────────────────────── */

  test('above the threshold, NOTHING moves until it is approved', async () => {
    await H.asOwner(ctx, 'UPDATE chain.outlet SET count_approval_laari = 10000 WHERE id = $1',
      [ctx.outletId]);   // MVR 100.00

    const before = await onHand('BEEF');
    // BEEF at 0.085/unit — 3,000 units short is MVR 255.00, well over the limit.
    const r = await op('stock_count', {
      lines: [{ ingredientId: 'BEEF', counted: before - 3000 }], note: 'monthly freezer check',
    });
    const res = r.json.results[0].result;
    assert.equal(res.status, 'pending');
    assert.match(res.message, /Nothing has moved/);

    assert.equal(await onHand('BEEF'), before,
      'a count held for approval that had already adjusted the stock would be'
      + ' an approval of something that had happened anyway');
    const j = await H.q(ctx,
      "SELECT count(*)::int AS n FROM journal WHERE source = 'stock' AND source_id = $1",
      [res.countId]);
    assert.equal(j.rows[0].n, 0, 'and nothing posted to the accounts either');
    pendingId = res.countId;
  });

  test('the sheet says so, in units and in money', async () => {
    const r = await get(`/counts/${pendingId}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.count.status, 'pending');
    assert.equal(r.json.count.applied, false, 'stated, not left to be inferred from a status');
    assert.equal(r.json.count.note, 'monthly freezer check');
    const line = r.json.lines[0];
    assert.equal(line.variance, -3000, 'the variance in units');
    assert.equal(line.value.toFixed(2), '-255.00', 'and the same variance in MVR');
    assert.equal(line.name, 'Beef mince');
  });

  test('it is the first thing on the manager\'s morning list', async () => {
    const t = await H.req('GET', `/api/outlet/${ctx.outletId}/today?date=${ctx.today}`,
      { token: mgr.token });
    const item = t.json.items.find((i) => i.id === 'count-awaiting-approval');
    assert.ok(item, 'a count waiting for a signature is a decision waiting');
    assert.equal(item.severity, 'now');
    assert.equal(item.where.module, 'counts');
    assert.match(item.detail, /255\.00/);
  });

  test('a MANAGER cannot approve it — that is what the threshold is for', async () => {
    const r = await op('stock_count_approve', { countId: pendingId }, mgr.token);
    assert.match(r.json.results[0].error, /rank 4/);
  });

  test('and neither can the person who took it, whatever their rank', async () => {
    /* An admin counting their own freezer has still not had a second pair of
       eyes on it, and the rank gate alone would let them through. */
    const own = await op('stock_count', {
      lines: [{ ingredientId: 'SYRUP', counted: 0 }],
    }, admin.token);
    // The admin's own count is not held at all — a rank that could approve it
    // anyway is not made to ask itself for permission.
    assert.equal(own.json.results[0].result.status, 'posted',
      'ceremony that changes nothing is ceremony people learn to click through');

    const mine = await H.asOwner(ctx,
      "SELECT id FROM stock_count WHERE status = 'pending' LIMIT 1");
    await H.asOwner(ctx, 'UPDATE stock_count SET by_staff = ('
      + ' SELECT id FROM chain.staff WHERE outlet_id = $2 AND rank = 4 LIMIT 1)'
      + ' WHERE id = $1', [mine.rows[0].id, ctx.outletId]);
    const r = await op('stock_count_approve', { countId: pendingId }, admin.token);
    assert.match(r.json.results[0].error, /somebody else has to approve/);
    await H.asOwner(ctx, 'UPDATE stock_count SET by_staff = ('
      + ' SELECT id FROM chain.staff WHERE outlet_id = $2 AND rank = 3 LIMIT 1)'
      + ' WHERE id = $1', [mine.rows[0].id, ctx.outletId]);
  });

  test('approving it moves the stock and posts the variance, once', async () => {
    const before = await onHand('BEEF');
    const r = await op('stock_count_approve', { countId: pendingId }, admin.token);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.results[0].result.status, 'posted');

    assert.equal(await onHand('BEEF'), before - 3000, 'now the stock moves');
    const j = await H.q(ctx,
      'SELECT l.account_code, l.dr, l.cr FROM journal j JOIN journal_line l'
      + " ON l.journal_id = j.id WHERE j.source = 'stock' AND j.source_id = $1"
      + ' ORDER BY l.account_code', [pendingId]);
    const byCode = Object.fromEntries(j.rows.map((x) => [x.account_code, x]));
    assert.equal(Number(byCode['5100'].dr).toFixed(2), '255.00', 'shrinkage is an expense');
    assert.equal(Number(byCode['1100'].cr).toFixed(2), '255.00', 'and inventory came down');

    // Cache and ledger still agree — the invariant the whole stock module holds.
    const drift = await H.q(ctx,
      'SELECT i.id FROM ingredient i LEFT JOIN stock_move m ON m.ingredient_id = i.id'
      + ' GROUP BY i.id, i.on_hand HAVING i.on_hand <> coalesce(sum(m.qty),0)');
    assert.equal(drift.rows.length, 0);
  });

  test('what the sheet was worth is what the ledger posted, to the laari', async () => {
    /* This failed. BEEF costs 0.0850 a gram — 8.5 laari — and the approval path
       rounded the per-unit cost to whole laari before writing the movement, so
       a 3,000 g shortfall showed −255.00 on the sheet that was signed and
       −270.00 in the stock ledger. Six per cent, on every gram-denominated
       line, silently. The per-unit cost must never be rounded; only the value
       is, once, at the end. */
    const sheet = await get(`/counts/${pendingId}`);
    const sheetValue = sheet.json.count.varianceValue;

    /* The sheet has one line, on BEEF, so the movement it produced is the most
       recent count adjustment against that ingredient. */
    const led = await H.q(ctx,
      "SELECT value FROM stock_move WHERE reason = 'count' AND ingredient_id = 'BEEF'"
      + ' ORDER BY id DESC LIMIT 1');
    assert.equal(Number(led.rows[0].value).toFixed(2), sheetValue.toFixed(2));

    const jrnl = await H.q(ctx,
      "SELECT coalesce(sum(l.dr),0) AS dr FROM journal j JOIN journal_line l"
      + " ON l.journal_id = j.id WHERE j.source = 'stock' AND j.source_id = $1"
      + " AND l.account_code = '5100'", [pendingId]);
    assert.equal(Number(jrnl.rows[0].dr).toFixed(2), Math.abs(sheetValue).toFixed(2),
      'and the accounts agree with both');
  });

  test('an approved count cannot be approved again', async () => {
    const r = await op('stock_count_approve', { countId: pendingId }, admin.token);
    assert.match(r.json.results[0].error, /no count is waiting/);
  });

  test('the variance posted is the one that was COUNTED, not one re-derived later', async () => {
    /* The subtle one. If stock moved by M between the count and the signature,
       on-hand is now expected+M, and the true adjustment is (counted+M) −
       (expected+M) — which is the original variance. Re-deriving against
       today's figure would silently absorb every sale made in between into the
       shrinkage. */
    const start = await onHand('BUN');
    const held = await op('stock_count', { lines: [{ ingredientId: 'BUN', counted: start - 60 }] });
    const id = held.json.results[0].result.countId;
    assert.equal(held.json.results[0].result.status, 'pending');   // 60 × 4.50 = 270.00

    // A burger sells while the sheet waits: one bun leaves the store.
    await H.push({ ...ctx, token: ctx.token }, [{ opId: H.uuid(), kind: 'sale', at: Date.now(),
      payload: {
        businessDate: ctx.today, channel: 'takeaway', covers: 1,
        lines: [{ itemId: 'BURGER', qty: 1 }],
        payments: [{ method: 'cash', amount: H.priceIt(ctx, [['BURGER', 1]]).total / 100 }],
      } }]);
    const afterSale = await onHand('BUN');
    assert.equal(afterSale, start - 1);

    await op('stock_count_approve', { countId: id }, admin.token);
    assert.equal(await onHand('BUN'), afterSale - 60,
      'the sale is still a sale and the shortfall is still the shortfall');
  });

  test('a count can be REFUSED, and refusing needs a reason', async () => {
    const start = await onHand('SYRUP');
    const held = await op('stock_count', { lines: [{ ingredientId: 'SYRUP', counted: start + 20000 }] });
    const id = held.json.results[0].result.countId;
    assert.equal(held.json.results[0].result.status, 'pending');

    const noReason = await op('stock_count_reject', { countId: id }, admin.token);
    assert.match(noReason.json.results[0].error, /say why/);

    const r = await op('stock_count_reject',
      { countId: id, reason: 'counted the delivery twice' }, admin.token);
    assert.equal(r.json.results[0].result.status, 'rejected');
    assert.equal(await onHand('SYRUP'), start, 'nothing moved');

    // The sheet is kept, not deleted: a refused count is evidence.
    const sheet = await get(`/counts/${id}`);
    assert.equal(sheet.json.count.status, 'rejected');
    assert.equal(sheet.json.count.rejectedReason, 'counted the delivery twice');
    assert.equal(sheet.json.count.approvedBy, 'General Manager', 'and who refused it');
  });

  test('pending sheets sort above everything else, whatever the date', async () => {
    const start = await onHand('BEEF');
    await op('stock_count', { lines: [{ ingredientId: 'BEEF', counted: start - 4000 }] });
    const r = await get('/counts');
    assert.equal(r.json.counts[0].status, 'pending',
      'the only row on this screen anybody has to do sorts first');
    assert.equal(r.json.threshold, 100, 'and the screen is told the policy in force');
    assert.equal(r.json.approveRank, 4);
  });

  /* ── count sheets by category ─────────────────────────────────────────── */

  test('a blank sheet lists what to go and count, in the kitchen\'s own words', async () => {
    await H.asOwner(ctx, "UPDATE ingredient SET category = 'Freezer' WHERE id = 'BEEF'");
    await H.asOwner(ctx, "UPDATE ingredient SET category = 'Bar' WHERE id = 'SYRUP'");
    // BUN is left uncategorised on purpose.

    const all = await get('/counts/sheet');
    assert.equal(all.status, 200, all.text);
    assert.deepEqual(all.json.categories.map((c) => c.name).sort(), ['Bar', 'Freezer']);
    assert.equal(all.json.uncategorised, 1);
    assert.equal(all.json.items.length, 3, 'no categories chosen means the whole store');

    const freezer = await get('/counts/sheet?categories=Freezer');
    const ids = freezer.json.items.map((i) => i.id).sort();
    assert.deepEqual(ids, ['BEEF', 'BUN'],
      'the freezer, plus everything nobody has filed — an unfiled item still has'
      + ' to be counted, and dropping it lets it go years without appearing');
    assert.ok(!ids.includes('SYRUP'));
  });

  test('the sheet does NOT tell the counter what to expect', async () => {
    /* A sheet that says "there should be 4,000 g" is a sheet that gets agreed
       with rather than counted, and an independent check is the entire value of
       a stock count. */
    const r = await get('/counts/sheet');
    for (const i of r.json.items) {
      assert.equal(i.expected, undefined);
      assert.equal(i.onHand, undefined);
      assert.ok(i.name && i.unit, 'it says what and in what unit, and stops there');
    }
  });

  test('a sheet records the categories it was taken over', async () => {
    const start = await onHand('SYRUP');
    const r = await op('stock_count', {
      lines: [{ ingredientId: 'SYRUP', counted: start }], categories: ['Bar'],
    });
    const sheet = await get(`/counts/${r.json.results[0].result.countId}`);
    assert.deepEqual(sheet.json.count.categories, ['Bar']);
  });

  /* ── the ledger ───────────────────────────────────────────────────────── */

  test('the ledger shows every movement with its reason and source document', async () => {
    const r = await get('/ledger');
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.moves.length > 0);

    const sold = r.json.moves.find((m) => m.reason === 'sale');
    assert.ok(sold, 'the sale is in the ledger');
    assert.match(sold.source, /-R-\d+$/, 'and it names its receipt');
    assert.ok(sold.qty < 0);

    const counted = r.json.moves.find((m) => m.reason === 'count');
    assert.ok(counted, 'so is the count adjustment');
    assert.ok(counted.by, 'named by the person who made it — for a manual move the person IS the document');

    assert.ok(r.json.moves.every((m) => m.name), 'every row names its ingredient');
    // Newest first: this screen answers "what happened yesterday", not "how did
    // this item get here" — that is the per-item view in Inventory.
    for (let i = 1; i < r.json.moves.length; i++) {
      assert.ok(new Date(r.json.moves[i - 1].at) >= new Date(r.json.moves[i].at));
    }
  });

  test('it filters by item and by reason, and the totals follow the filter', async () => {
    const all = await get('/ledger');
    const beef = await get('/ledger?ingredient=BEEF');
    assert.ok(beef.json.moves.every((m) => m.ingredientId === 'BEEF'));
    assert.ok(beef.json.page.count < all.json.page.count);

    const sales = await get('/ledger?reason=sale');
    assert.ok(sales.json.moves.every((m) => m.reason === 'sale'));
    assert.ok(sales.json.moves.every((m) => m.qty < 0), 'a sale only ever takes stock out');
    // A filtered total that still showed the whole store would be a number
    // nobody could act on.
    assert.equal(sales.json.value.in, 0);
    assert.ok(sales.json.value.out < 0);
  });

  test('an unknown reason is ignored rather than returning nothing', async () => {
    /* Silently empty is the worst answer: it reads as "no stock ever moved". */
    const r = await get('/ledger?reason=nonsense');
    assert.equal(r.status, 200);
    assert.ok(r.json.moves.length > 0);
  });

  test('paging returns a page and counts the whole ledger', async () => {
    const r = await get('/ledger?limit=2');
    assert.equal(r.json.moves.length, 2);
    assert.ok(r.json.page.count > 2);
    const p2 = await get('/ledger?limit=2&offset=2');
    assert.notEqual(p2.json.moves[0].id, r.json.moves[0].id);
    assert.equal(p2.json.page.count, r.json.page.count);
  });

  test('a bad date range is refused, and a huge limit is clamped', async () => {
    assert.equal((await get('/ledger?from=whenever')).status, 400);
    assert.ok((await get('/ledger?limit=99999')).json.page.limit <= 500);
  });

  test('a cashier reaches neither screen', async () => {
    assert.equal((await get('/counts', ctx.token)).status, 403);
    assert.equal((await get('/ledger', ctx.token)).status, 403);
    assert.equal((await get(`/counts/${pendingId}`, ctx.token)).status, 403);
  });

  test('an unknown count is 404 and a malformed id is not a 500', async () => {
    assert.equal((await get(`/counts/${H.uuid()}`)).status, 404);
    assert.equal((await get('/counts/not-a-uuid')).status, 404);
  });
});
