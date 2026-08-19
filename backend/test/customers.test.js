'use strict';
/* Customers & Credit — §2 (`customers`).
 *
 * What this file is really about:
 *
 *   · A HOUSE CHARGE IS NOT CASH. It must debit 1030 and leave the drawer
 *     alone, or the till comes up over at close by exactly the account sales.
 *   · An unknown tender must be REFUSED, not guessed. It used to fall back to
 *     the cash account, which is the same bug arriving by a different door.
 *   · The house ledger and account 1030 must always agree. Two sources for one
 *     debt is how a customer gets a statement the books do not recognise.
 *   · AGEING IS BY ALLOCATION. Age the net balance instead and a customer who
 *     pays every month reads as further overdue every month.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('customers and credit', () => {
  let ctx, mgr, admin, villa, walkIn;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
    admin = await H.addStaff(ctx, 'General Manager', 4);
  });
  after(() => H.teardown(ctx));

  const req = (method, p, body, token) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: token || admin.token });
  const get = (p, token) => req('GET', p, undefined, token);
  const bal = async (code) => {
    const r = await get('/reports/trial-balance');
    return r.json.accounts.find((a) => a.code === code)?.balance ?? 0;
  };
  /* A sale through the real till path, so every assertion below is about what
     actually happens when a cashier presses the button — including the ageing
     history, which is built from BACKDATED SALES rather than rows poked into
     the ledger. Injected history would have quietly broken the one assertion
     this file exists for: that the house ledger and account 1030 agree. */
  const bill = (qty) => H.priceIt(ctx, [['BURGER', qty]]);
  const sellOn = (businessDate, payments, memberId) => H.push(ctx, [{
    opId: H.uuid(), kind: 'sale', at: Date.now(),
    payload: {
      businessDate, channel: 'dine_in', covers: 2,
      lines: [{ itemId: 'BURGER', qty: 1 }],
      payments, memberId,
    },
  }]);
  const one = () => (bill(1).total / 100).toFixed(2);
  const sell = (method, memberId, on) =>
    sellOn(on || ctx.today, [{ method, amount: one() }], memberId);
  const dayOf = (back) =>
    new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
  /* Phone numbers unique to this run. chain.member is CHAIN-WIDE by design — a
     member earns at one outlet and spends at another — so a fresh test outlet
     is born already able to see every customer the chain knows, including the
     ones a previous run of this file created. */
  const num = (n) => String(7000000 + (ctx.outletId % 90000) * 10 + n);

  /* ── the profile ──────────────────────────────────────────────────────── */

  test('a new outlet is owed nothing, even by customers the chain already knows',
    async () => {
      /* The profile is chain-wide and the DEBT is not: 1030 lives in this
         outlet's schema, so a branch that opened this morning starts at nought
         however long the chain has been trading. */
      const r = await get('/customers', mgr.token);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.totals.owed, 0);
      assert.deepEqual(r.json.ageing.rows, []);
      for (const m of r.json.members) assert.equal(m.owed, 0, m.phone);
    });

  test('a cashier can put a name to a phone number without fetching anybody',
    async () => {
      const r = await req('POST', '/customers',
        { phone: num(1), name: 'Aishath', consent: true }, ctx.token);
      assert.equal(r.status, 201, r.text);
      walkIn = r.json.id;
      assert.equal(r.json.creditLimit, 0, 'and no credit by default');
      assert.equal(r.json.onAccount, false);
    });

  test('the same number again hands back who it is rather than refusing', async () => {
    /* The person is at the counter and cannot change their phone number. */
    const r = await req('POST', '/customers', { phone: num(1) }, ctx.token);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.id, walkIn);
    assert.equal(r.json.already, true);
    assert.equal(r.json.name, 'Aishath', 'and does not wipe what was known');
  });

  test('a phone number that is not one is refused', async () => {
    const r = await req('POST', '/customers', { phone: 'no' }, ctx.token);
    assert.equal(r.status, 400);
  });

  /* ── credit is an admin's decision ────────────────────────────────────── */

  test('nought is not "no limit", it is NO CREDIT', async () => {
    const r = await sell('account', walkIn);
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.results[0].error, /no house account/);
    assert.match(r.json.results[0].error, /admin sets a credit limit/);
  });

  test('a manager cannot extend credit', async () => {
    const r = await req('POST', `/customers/${walkIn}/credit`,
      { creditLimit: 5000 }, mgr.token);
    assert.equal(r.status, 403);
  });

  test('an admin opens a house account', async () => {
    const c = await req('POST', '/customers',
      { phone: num(2), name: 'Villa Group', company: 'Villa Group Pvt Ltd' },
      ctx.token);
    villa = c.json.id;
    const r = await req('POST', `/customers/${villa}/credit`,
      { creditLimit: 5000, termsDays: 30 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.creditLimit, 5000);
    assert.equal(r.json.available, 5000);
    assert.equal(r.json.onAccount, true);
  });

  /* ── the charge ───────────────────────────────────────────────────────── */

  test('a house charge debits 1030 and LEAVES THE DRAWER ALONE', async () => {
    /* The failure this guards against does not look like a bug: the sale
       balances, the P&L is right, and the only symptom is the drawer coming up
       over at close by exactly the account sales — posted to 6920 as if
       somebody had put money in. */
    const cashBefore = await bal('1000');
    const r = await sell('account', villa);
    assert.ok(r.json.results[0].result, r.text);

    assert.equal((await bal('1030')).toFixed(2), one(), 'they owe us');
    assert.equal((await bal('1000')).toFixed(2), cashBefore.toFixed(2),
      'and not one laari reached the drawer');
  });

  test('the house ledger and account 1030 agree, because they must', async () => {
    const s = await get(`/customers/${villa}`);
    assert.equal(s.status, 200, s.text);
    assert.equal(s.json.owed.toFixed(2), one());
    assert.equal(s.json.owed.toFixed(2), (await bal('1030')).toFixed(2));
    assert.equal(s.json.entries.length, 1);
    assert.equal(s.json.entries[0].kind, 'charge');
    assert.ok(s.json.entries[0].docNo, 'and it names the receipt it came from');
  });

  test('a charge over the limit is refused BEFORE the sale exists', async () => {
    /* Refusing afterwards would mean a printed receipt for a debt nobody
       approved. */
    const before = await get(`/customers/${villa}`);
    await req('POST', `/customers/${villa}/credit`, { creditLimit: 120, termsDays: 30 });
    const r = await sell('account', villa);
    assert.match(r.json.results[0].error, /limit/);
    await req('POST', `/customers/${villa}/credit`, { creditLimit: 5000, termsDays: 30 });
    const after = await get(`/customers/${villa}`);
    assert.equal(after.json.owed, before.json.owed, 'nothing moved');
    assert.equal(after.json.entries.length, before.json.entries.length);
  });

  test('a house charge with nobody on it is refused', async () => {
    const r = await sell('account');
    assert.match(r.json.results[0].error, /whose account/);
  });

  test('a blocked account cannot be charged', async () => {
    await req('POST', `/customers/${villa}/credit`,
      { creditLimit: 5000, termsDays: 30, blocked: true });
    const r = await sell('account', villa);
    assert.match(r.json.results[0].error, /blocked/);
    await req('POST', `/customers/${villa}/credit`, { creditLimit: 5000, termsDays: 30 });
  });

  test('an UNKNOWN tender is refused rather than treated as cash', async () => {
    /* The same failure by another door: it used to fall back to 1000, so a
       typo put money in the drawer that was never there. */
    const cashBefore = await bal('1000');
    const r = await sell('Cash');
    assert.match(r.json.results[0].error, /unknown tender/);
    assert.equal((await bal('1000')).toFixed(2), cashBefore.toFixed(2));
  });

  test('a split bill can be part cash, part account', async () => {
    const cashBefore = await bal('1000');
    const owedBefore = await bal('1030');
    const total = Number(one());
    const onAccount = 40;
    const r = await sellOn(ctx.today, [
      { method: 'cash', amount: (total - onAccount).toFixed(2) },
      { method: 'account', amount: onAccount.toFixed(2) },
    ], villa);
    assert.ok(r.json.results[0].result, r.text);
    assert.equal((await bal('1000')).toFixed(2), (cashBefore + total - onAccount).toFixed(2));
    assert.equal((await bal('1030')).toFixed(2), (owedBefore + onAccount).toFixed(2));
  });

  /* ── paying it back ───────────────────────────────────────────────────── */

  test('a payment against the account credits 1030 and takes the money', async () => {
    const owed = await bal('1030');
    const cashBefore = await bal('1000');
    const r = await req('POST', `/customers/${villa}/receipt`,
      { amount: 40, method: 'cash' }, mgr.token);
    assert.equal(r.status, 201, r.text);
    assert.ok(r.json.docNo, 'a numbered document, so a dispute has something to show');
    assert.equal(r.json.owed, Number((owed - 40).toFixed(2)));
    assert.equal((await bal('1030')).toFixed(2), (owed - 40).toFixed(2));
    assert.equal((await bal('1000')).toFixed(2), (cashBefore + 40).toFixed(2));
  });

  test('paying more than is owed is refused, not credited', async () => {
    /* A receivable that goes negative is a liability wearing an asset's code. */
    const r = await req('POST', `/customers/${villa}/receipt`,
      { amount: 999999, method: 'cash' }, mgr.token);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /more than the/);
  });

  test('paying an account that owes nothing is refused', async () => {
    const r = await req('POST', `/customers/${walkIn}/receipt`,
      { amount: 10, method: 'cash' }, mgr.token);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /nothing owing/);
  });

  test('a cashier cannot take a payment against an account', async () => {
    const r = await req('POST', `/customers/${villa}/receipt`,
      { amount: 10, method: 'cash' }, ctx.token);
    assert.equal(r.status, 403);
  });

  /* ── ageing, which is the part that is easy to get plausibly wrong ────── */

  test('a receipt clears the OLDEST charge first', async () => {
    /* Age the net balance instead and a customer who pays every month reads as
       further overdue every month, because their oldest invoice is always old
       — even though it was paid months ago. A statement like that puts a good
       customer on stop. */
    const c = await req('POST', '/customers', { phone: num(3), name: 'Regular Co' },
      ctx.token);
    const id = c.json.id;
    await req('POST', `/customers/${id}/credit`, { creditLimit: 100000, termsDays: 0 });

    // An old charge, paid four months ago; and a recent one, not.
    await sell('account', id, dayOf(120));
    await req('POST', `/customers/${id}/receipt`,
      { amount: Number(one()), method: 'cash', on: dayOf(115) }, mgr.token);
    await sell('account', id, dayOf(5));

    const s = await get(`/customers/${id}`);
    assert.equal(s.json.owed.toFixed(2), one());
    assert.equal(s.json.ageing.over60, 0,
      'the 120-day-old charge was PAID and must not still be ageing');
    assert.equal(s.json.ageing.upTo30.toFixed(2), one(),
      'only the recent one is outstanding');
  });

  test('a charge past its terms ages into the right bucket', async () => {
    const c = await req('POST', '/customers', { phone: num(4), name: 'Slow Co' },
      ctx.token);
    const id = c.json.id;
    await req('POST', `/customers/${id}/credit`, { creditLimit: 100000, termsDays: 30 });
    const each = Number(one());

    await sell('account', id, dayOf(10));    // inside terms
    await sell('account', id, dayOf(50));    // 20 days past due
    await sell('account', id, dayOf(140));   // 110 days past due

    const s = await get(`/customers/${id}`);
    assert.equal(s.json.ageing.termsDays, 30);
    assert.equal(s.json.ageing.notYetDue, each);
    assert.equal(s.json.ageing.upTo30, each);
    assert.equal(s.json.ageing.over60, each);
    assert.equal(s.json.owed, Number((each * 3).toFixed(2)));
  });

  test('the aged book totals what the statements total, because it is the same sum',
    async () => {
      const r = await get('/customers', mgr.token);
      let fromStatements = 0;
      for (const row of r.json.ageing.rows) {
        const s = await get(`/customers/${row.id}`);
        assert.equal(row.owed, s.json.owed, row.name);
        fromStatements += s.json.owed;
      }
      assert.equal(r.json.ageing.total.owed, Number(fromStatements.toFixed(2)));
    });

  test('over-limit customers are flagged rather than left to be spotted', async () => {
    await req('POST', `/customers/${villa}/credit`, { creditLimit: 1, termsDays: 30 });
    const r = await get('/customers', mgr.token);
    const v = r.json.members.find((m) => m.id === villa);
    assert.equal(v.overLimit, true);
    assert.equal(v.available, 0, 'and there is nothing left to charge');
    assert.equal(r.json.totals.overLimit >= 1, true);
  });

  test('lowering a limit below what is owed says what it does and does not', async () => {
    const r = await req('POST', `/customers/${villa}/credit`,
      { creditLimit: 1, termsDays: 30 });
    assert.match(r.json.message, /Nothing is clawed back/);
  });

  /* ── giving up on a debt ──────────────────────────────────────────────── */

  test('a write-off needs a reason — it is the entry that makes money vanish',
    async () => {
      const r = await req('POST', `/customers/${villa}/writeoff`, { amount: 10 });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /say why/);
    });

  test('a write-off charges 6400 Bad debt and clears the receivable', async () => {
    const owed = await bal('1030');
    const s = await get(`/customers/${villa}`);
    const r = await req('POST', `/customers/${villa}/writeoff`,
      { reason: 'company dissolved' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.amount, s.json.owed);
    assert.equal(r.json.owed, 0);
    assert.equal((await bal('6400')).toFixed(2), s.json.owed.toFixed(2));
    assert.equal((await bal('1030')).toFixed(2), (owed - s.json.owed).toFixed(2));
  });

  test('a manager cannot write a debt off', async () => {
    const r = await req('POST', `/customers/${walkIn}/writeoff`,
      { reason: 'nope' }, mgr.token);
    assert.equal(r.status, 403);
  });

  /* ── the whole book, against the ledger ───────────────────────────────── */

  test('every house balance together equals account 1030, to the laari', async () => {
    /* Two sources for one debt is how a customer receives a statement the books
       do not recognise. This is the assertion that keeps them one. */
    const r = await get('/customers', mgr.token);
    const sum = r.json.ageing.total.owed;
    assert.equal(sum.toFixed(2), (await bal('1030')).toFixed(2));
  });

  test('the trial balance still balances', async () => {
    const r = await get('/reports/trial-balance');
    assert.equal(r.json.totals.difference, 0, JSON.stringify(r.json.totals));
  });

  test('a kitchen session reaches none of it', async () => {
    const kds = await H.addStaff(ctx, 'Chef', 1);
    assert.equal((await get('/customers', kds.token)).status, 403);
  });
});
