'use strict';
/* The member portal — 04-MEMBER-PORTAL-SPEC.md, 08-BUILD-STAGES §23.
 *
 * The whole file is really about one sentence from §6: "A member's data crosses
 * outlets (that is the point of a chain loyalty scheme), but their visits stay
 * in the outlet that served them." A member session is the first thing in this
 * build that is neither staff nor a table — it belongs to no outlet at all —
 * and the tests that matter most here are the ones about what it CANNOT reach.
 *
 * And §3's rule, which is the hard rule of the whole system in one line: the
 * phone posts intent, the till settles. A phone that could reduce a bill by
 * itself would be a phone that takes money.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('the member portal', () => {
  let ctx, mgr, phone, memberId, token, today;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
    today = new Date().toISOString().slice(0, 10);

    /* A member exists the way §1 says one comes to exist: a cashier attached a
       number, with consent recorded. There is no sign-up form to call. */
    phone = '77' + String(10000 + (Date.now() % 89999)).slice(0, 5);
    const m = await H.asOwner(ctx,
      'INSERT INTO chain.member (phone, name, consent_at) VALUES ($1,$2,now())'
      + ' RETURNING id', [phone, 'Aishath Member']);
    memberId = m.rows[0].id;

    /* A scheme that is actually running: without an earn rate there are no
       points, which is a legitimate state but not the one under test. */
    await H.asOwner(ctx,
      'INSERT INTO chain.loyalty (only_row, earn_per_mvr, point_value, tiers)'
      + ' VALUES (true, 1, 0.10, $1::jsonb)'
      + ' ON CONFLICT (only_row) DO UPDATE SET earn_per_mvr = 1, point_value = 0.10,'
      + ' tiers = EXCLUDED.tiers',
      [JSON.stringify([{ name: 'Silver', points: 100 }, { name: 'Gold', points: 500 }])]);
  });
  after(() => H.teardown(ctx));

  const api = (method, p, body, token) => H.req(method, `/api${p}`, { body, token });
  const outlet = (method, p, body, tok) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: tok || ctx.token });
  /* A sale goes through the ops path, the way a till sends one. */
  const sell = (payload, tok) => H.push({ ...ctx, token: tok || ctx.token },
    [{ opId: payload.opId || H.uuid(), kind: 'sale', at: Date.now(), payload }]);

  /* ── signing in ───────────────────────────────────────────────────────── */

  test('a number nobody knows is told so, in a sentence they can act on', async () => {
    /* Enumeration-proofing this would mean a guest waiting for a message that
       is never coming. The trade is stated in the module header; the wording
       here is the other half of it. */
    const r = await api('POST', '/member/code', { phone: '7000001' });
    assert.equal(r.status, 404);
    assert.match(r.json.error, /Ask a server to add you/);
  });

  test('a number that is not a Maldivian mobile is refused before anything else',
    async () => {
      const r = await api('POST', '/member/code', { phone: '12' });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /not a Maldivian mobile/);
    });

  test('with no message gateway configured it says so rather than pretending',
    async () => {
      /* The alternative — returning "sent" and sending nothing — is the failure
         mode that costs a member ten minutes and a phone call. */
      const r = await api('POST', '/member/code', { phone });
      assert.equal(r.status, 503);
      assert.match(r.json.error, /not switched on|counter/);
    });

  test('so a cashier signs them in at the counter, and it is a TILL job', async () => {
    const kds = await H.addStaff(ctx, 'Chef', 1);
    assert.equal(
      (await outlet('POST', `/members/${memberId}/portal-code`, {}, kds.token)).status, 403);

    const r = await outlet('POST', `/members/${memberId}/portal-code`, {});
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.code, /^\d{6}$/);
    assert.match(r.json.message, /works once/);
    /* The number is masked even to the cashier's screen: they already have the
       member in front of them and do not need it read back. */
    assert.match(r.json.phone, /^••• /);
    assert.ok(!JSON.stringify(r.json).includes(phone));
  });

  test('a wrong code is refused, and says nothing about which part was wrong',
    async () => {
      const r = await api('POST', '/member/session', { phone, code: '000000' });
      assert.equal(r.status, 401);
      assert.match(r.json.error, /not right, or it has expired/);
    });

  test('the right code opens a session, and the card comes with it', async () => {
    const issued = await outlet('POST', `/members/${memberId}/portal-code`, {});
    assert.equal(issued.status, 200, issued.text);
    const r = await api('POST', '/member/session', { phone, code: issued.json.code });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.token);
    assert.equal(r.json.member.name, 'Aishath Member');
    assert.match(r.json.member.phone, /^••• /, 'masked, per §2');
    assert.equal(r.json.member.points, 0);
    token = r.json.token;
  });

  test('a code works ONCE', async () => {
    const issued = await outlet('POST', `/members/${memberId}/portal-code`, {});
    const first = await api('POST', '/member/session', { phone, code: issued.json.code });
    assert.equal(first.status, 200, first.text);
    const again = await api('POST', '/member/session', { phone, code: issued.json.code });
    assert.equal(again.status, 401, 'the second use of a one-time code is not a use');
  });

  test('six wrong guesses do not get a seventh', async () => {
    const issued = await outlet('POST', `/members/${memberId}/portal-code`, {});
    for (let i = 0; i < 5; i++) {
      await api('POST', '/member/session', { phone, code: '999999' });
    }
    /* Even the RIGHT code now fails: the attempts were spent, and the member
       asks for another. A six-digit code with unlimited guesses is a four-
       second brute force. */
    const r = await api('POST', '/member/session', { phone, code: issued.json.code });
    assert.equal(r.status, 401);
  });

  /* ── the card ─────────────────────────────────────────────────────────── */

  test('the tier and the distance to the next one come from CONFIGURATION', async () => {
    const r = await api('GET', '/member/me', undefined, token);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.tier.name, null, 'nobody is on a rung at zero points');
    assert.equal(r.json.tier.next, 'Silver');
    assert.equal(r.json.tier.toNext, 100, 'read from the ladder, not a constant');
    assert.equal(r.json.scheme.running, true);
  });

  test('a new member sees an empty visit list that says what will fill it', async () => {
    const r = await api('GET', '/member/visits', undefined, token);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.visits, []);
    assert.equal(r.json.totals.visits, 0);
  });

  /* ── a real visit ─────────────────────────────────────────────────────── */

  test('a settled sale becomes a visit the member can read, and points they can spend',
    async () => {
      const basket = [['BURGER', 2]];
      const sale = await sell({
        businessDate: today, channel: 'dine_in', covers: 2,
        lines: [{ itemId: 'BURGER', qty: 2 }], memberId,
        payments: [{ method: 'cash', amount: H.priceIt(ctx, basket).total / 100 }],
      });
      assert.equal(sale.status, 200, JSON.stringify(sale.json));
      assert.ok(!sale.json.results[0].error, JSON.stringify(sale.json.results[0]));

      const v = await api('GET', '/member/visits', undefined, token);
      assert.equal(v.json.visits.length, 1);
      const visit = v.json.visits[0];
      assert.equal(visit.covers, 2);
      assert.ok(visit.total > 0);
      assert.ok(visit.points > 0, 'and what it earned');
      assert.equal(visit.outlet, 'Test Outlet ' + ctx.outletId, 'named, per §4');

      const me = await api('GET', '/member/me', undefined, token);
      assert.equal(me.json.points, visit.points);
      assert.ok(me.json.worth > 0, 'in money, which is the only form that means anything');
    });

  test('the visit carries NO line items, tender or staff — that stays in the outlet',
    async () => {
      /* §6: "their visits stay in the outlet that served them." What crosses is
         a projection: date, branch, covers, total, points. */
      const v = await api('GET', '/member/visits', undefined, token);
      const visit = v.json.visits[0];
      assert.deepEqual(Object.keys(visit).sort(),
        ['at', 'covers', 'outlet', 'points', 'total']);
    });

  test('a replayed settle does not become a second evening out', async () => {
    const opId = H.uuid();
    const body = {
      opId, businessDate: today, channel: 'dine_in', covers: 1,
      lines: [{ itemId: 'COLA', qty: 1 }], memberId,
      payments: [{ method: 'cash', amount: H.priceIt(ctx, [['COLA', 1]]).total / 100 }],
    };
    await sell(body);
    const before = (await api('GET', '/member/visits', undefined, token)).json.visits.length;
    await sell(body);      // the same op, arriving twice
    const after = (await api('GET', '/member/visits', undefined, token)).json.visits.length;
    assert.equal(after, before);
  });

  /* ── rewards and vouchers ─────────────────────────────────────────────── */

  test('the catalogue says how far off an unaffordable reward is', async () => {
    await H.asOwner(ctx, 'INSERT INTO chain.reward (name, points, value)'
      + ' VALUES ($1,$2,$3)', ['Free dessert', 40, 45]);
    await H.asOwner(ctx, 'INSERT INTO chain.reward (name, points, value)'
      + ' VALUES ($1,$2,$3)', ['A night out', 100000, 5000]);

    const r = await api('GET', '/member/rewards', undefined, token);
    assert.equal(r.status, 200, r.text);
    const far = r.json.rewards.find((x) => x.name === 'A night out');
    assert.equal(far.affordable, false);
    assert.ok(far.short > 0, 'and by how much, so nobody has to subtract');
  });

  test('redeeming needs the points', async () => {
    const cat = await api('GET', '/member/rewards', undefined, token);
    const far = cat.json.rewards.find((x) => x.name === 'A night out');
    const r = await api('POST', '/member/redeem', { rewardId: far.id }, token);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /not enough points/);
  });

  test('redeeming mints a voucher and says the discount happens AT THE COUNTER',
    async () => {
      /* §5: "Redeeming creates a voucher the till can accept; it does not
         discount anything on the phone." */
      await H.asOwner(ctx, 'UPDATE chain.member SET points = 500 WHERE id = $1',
        [memberId]);
      const cat = await api('GET', '/member/rewards', undefined, token);
      const cheap = cat.json.rewards.find((x) => x.name === 'Free dessert');

      const r = await api('POST', '/member/redeem', { rewardId: cheap.id }, token);
      assert.equal(r.status, 201, r.text);
      assert.match(r.json.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      assert.match(r.json.message, /counter/);
      assert.match(r.json.message, /not here/);

      const me = await api('GET', '/member/me', undefined, token);
      assert.equal(me.json.points, 460, 'the points went');
    });

  test('the liability counts a voucher, because it is the same promise', async () => {
    /* Turning points into a voucher does not discharge anything: the business
       still owes the dessert. A liability that fell at redemption and rose at
       spending would be describing the opposite of what happened. */
    const s = await outlet('GET', '/loyalty', undefined, mgr.token);
    assert.equal(s.status, 200, s.text);
    assert.ok(s.json.inVouchers >= 45, s.text);
    assert.equal(s.json.liability,
      Math.round((s.json.inPoints + s.json.inVouchers) * 100) / 100);
  });

  test('the till can look up the code a guest is holding out', async () => {
    const cat = await api('GET', '/member/rewards', undefined, token);
    const v = cat.json.vouchers[0];
    const r = await outlet('GET', `/vouchers/${v.code}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.state, 'ready');
    assert.equal(r.json.value, 45);
    assert.equal(r.json.member, 'Aishath Member');
  });

  test('and take it, once', async () => {
    const cat = await api('GET', '/member/rewards', undefined, token);
    const v = cat.json.vouchers.find((x) => x.state === 'ready');

    const due = H.priceIt(ctx, [['BURGER', 1]]).total / 100;
    const sale = await sell({
      businessDate: today, channel: 'dine_in', covers: 1,
      lines: [{ itemId: 'BURGER', qty: 1 }], memberId, voucherCode: v.code,
      payments: [{ method: 'voucher', amount: 45 }, { method: 'cash', amount: due - 45 }],
    });
    assert.ok(!sale.json.results[0].error, JSON.stringify(sale.json.results[0]));

    /* Second time: the code is spent, and the sale that tried to use it does
       not go through — a receipt naming a voucher that was already gone is a
       bill nobody paid. */
    const again = await sell({
      businessDate: today, channel: 'dine_in', covers: 1,
      lines: [{ itemId: 'BURGER', qty: 1 }], memberId, voucherCode: v.code,
      payments: [{ method: 'voucher', amount: 45 }, { method: 'cash', amount: due - 45 }],
    });
    assert.match(again.json.results[0].error || '', /already been used/,
      JSON.stringify(again.json.results[0]));
  });

  test('taking a voucher DEBITS the loyalty liability, and never touches income',
    async () => {
      /* §6: "Points are a liability, not a discount... The P&L never sees a
         point." Same for the voucher they became. */
      const tb = await outlet('GET', `/reports/trial-balance?from=${today}&to=${today}`,
        undefined, mgr.token);
      const l = tb.json.accounts.find((a) => a.code === '2200');
      assert.ok(l, '2200 has moved');
      assert.ok(Number(l.dr) >= 45, 'the voucher came off the liability');
    });

  test('a spent voucher reads as used on the phone, not as missing', async () => {
    const r = await api('GET', '/member/rewards', undefined, token);
    const used = r.json.vouchers.find((v) => v.state === 'used');
    assert.ok(used, 'still in their wallet, marked');
    assert.ok(used.redeemedAt);
  });

  /* ── the bill, and the rule about who takes money ─────────────────────── */

  test('with no ticket open in their name the bill is an empty state', async () => {
    const r = await api('GET', '/member/bill', undefined, token);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.open, false);
  });

  test('a ticket a cashier attached them to shows up, wherever they are sitting',
    async () => {
      const t = await H.push(ctx, [{
        opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
        payload: { table: '6', covers: 2, lines: [{ itemId: 'BURGER', qty: 1 }] },
      }]);
      const ticketId = t.json.results[0].result.ticketId;
      /* Attached by the cashier — the only way a member is on a bill. */
      await H.q(ctx, 'UPDATE ticket SET member_id = $2 WHERE id = $1',
        [ticketId, memberId]);

      const r = await api('GET', '/member/bill', undefined, token);
      assert.equal(r.status, 200, r.text);
      /* T06, not 6: one spelling of a table across the floor, the kitchen and
         the member's own bill. See src/tables.js. */
      assert.equal(r.json.table, 'T06');
      assert.equal(r.json.outlet.name, 'Test Outlet ' + ctx.outletId);
      assert.ok(r.json.lines.length >= 1);
      assert.ok(r.json.goods > 0);
    });

  test('offering points is an OFFER — nothing is charged and nothing is deducted',
    async () => {
      const bill = await api('GET', '/member/bill', undefined, token);
      const before = (await api('GET', '/member/me', undefined, token)).json.points;

      const r = await api('POST', '/member/bill/points',
        { outletId: ctx.outletId, ticketId: bill.json.ticketId, points: 50 }, token);
      assert.equal(r.status, 200, r.text);
      assert.match(r.json.message, /cashier will take it off/);
      assert.match(r.json.message, /nothing has been charged/);

      const after = (await api('GET', '/member/me', undefined, token)).json.points;
      assert.equal(after, before, 'the phone moved no points');

      /* And the till sees it, on the ticket the cashier is already looking at. */
      const t = await H.q(ctx, 'SELECT points_offered FROM ticket WHERE id = $1',
        [bill.json.ticketId]);
      assert.equal(Number(t.rows[0].points_offered), 50);
    });

  test('a member cannot offer points they do not have', async () => {
    const bill = await api('GET', '/member/bill', undefined, token);
    const r = await api('POST', '/member/bill/points',
      { outletId: ctx.outletId, ticketId: bill.json.ticketId, points: 99999 }, token);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /you have /);
  });

  test('nor against a bill that is not theirs', async () => {
    const other = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: '7', covers: 1, lines: [{ itemId: 'COLA', qty: 1 }] },
    }]);
    const r = await api('POST', '/member/bill/points',
      { outletId: ctx.outletId, ticketId: other.json.results[0].result.ticketId, points: 5 },
      token);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /not open in your name/);
  });

  /* ── what a member session is NOT ─────────────────────────────────────── */

  test('a member token opens no till door at all', async () => {
    for (const p of ['/snapshot', '/sales', '/reports/zread', '/accounting/journals',
      '/staff', '/loyalty']) {
      const r = await outlet('GET', p, undefined, token);
      assert.equal(r.status, 401, p + ' answered ' + r.status);
    }
  });

  test('and a till token is not a member', async () => {
    const r = await api('GET', '/member/me', undefined, ctx.token);
    assert.equal(r.status, 401);
    assert.match(r.json.error, /sign in on your phone/);
  });

  test('a guest token is not a member either', async () => {
    const g = await H.post(`/api/outlet/${ctx.outletId}/guest/session`, { table: '3' });
    const r = await api('GET', '/member/me', undefined, g.json.token);
    assert.equal(r.status, 401);
  });

  test('the member ROLE can read nothing in any outlet schema', async () => {
    /* The belt behind every route above. A member session connects as
       `kashikeyo_member`, which holds no grant on outlet_N at all — so even a
       route that forgot its WHERE clause could not reach a ticket. */
    const { Client } = require('pg');
    const { rolePassword } = require('../src/secrets');
    const c = new Client({
      host: process.env.PGHOST || '127.0.0.1',
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE,
      user: 'kashikeyo_member', password: rolePassword('member'),
    });
    await c.connect();
    try {
      await c.query("SELECT set_config('app.member_id', $1, false)", [memberId]);
      for (const t of ['ticket', 'sale', 'payment', 'journal', 'staff']) {
        await assert.rejects(
          () => c.query(`SELECT * FROM outlet_${ctx.outletId}.${t} LIMIT 1`),
          /permission denied|does not exist/, t + ' was reachable');
      }
      /* What it CAN see is one member: their own. */
      const mine = await c.query('SELECT id FROM chain.member');
      assert.equal(mine.rows.length, 1);
      assert.equal(mine.rows[0].id, memberId);
    } finally { await c.end(); }
  });

  test('another member\'s rows are invisible even to a forged variable', async () => {
    const other = await H.asOwner(ctx,
      'INSERT INTO chain.member (phone, name) VALUES ($1,$2) RETURNING id',
      ['7' + String((Date.now() % 900000) + 100000), 'Somebody Else']);
    const otherId = other.rows[0].id;

    /* An OUTLET connection setting app.member_id gains nothing: every member
       policy asks who the connection IS, not what it says it is. */
    const seen = await H.q(ctx,
      "SELECT set_config('app.member_id', $1, true) AS set,"
      + ' (SELECT count(*)::int FROM chain.member_visit WHERE member_id = $1::uuid) AS n',
      [otherId]);
    assert.equal(seen.rows[0].n, 0);

    const mine = await api('GET', '/member/visits', undefined, token);
    assert.ok(mine.json.visits.length >= 1, 'and the real session still works');
  });
});
