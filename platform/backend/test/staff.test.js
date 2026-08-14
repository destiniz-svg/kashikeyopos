'use strict';
/* Staff & Time Clock — §2 (`staff`): "Roster, clock in/out, rank assignment."
 *
 * Rank is the ONLY gate in this system, so the screen that assigns it is the
 * most dangerous one in the build, and most of this file is about the ceiling:
 * nobody creates or promotes above their own rank. Without that, rank 4 is rank
 * 5 with one extra click and the whole ladder is decoration.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

describe('staff and the time clock', () => {
  let ctx, mgr, admin, newbieId;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
    admin = await H.addStaff(ctx, 'General Manager', 4);
  });
  after(() => H.teardown(ctx));

  const req = (method, p, body, token) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: token || mgr.token });
  const get = (p, token) => req('GET', p, undefined, token);
  const op = (kind, payload, token) =>
    H.push({ ...ctx, token: token || ctx.token }, [{ opId: H.uuid(), kind, at: Date.now(), payload }]);

  /* ── the roster ───────────────────────────────────────────────────────── */

  test('the roster lists who works here, by rank', async () => {
    const r = await get('/staff');
    assert.equal(r.status, 200, r.text);
    const names = r.json.roster.map((x) => x.name);
    assert.ok(names.includes('Test Cashier'));
    assert.ok(names.includes('Duty Manager'));
    // Highest rank first — a roster is read to find who is in charge.
    assert.ok(r.json.roster[0].rank >= r.json.roster[r.json.roster.length - 1].rank);
    assert.equal(r.json.roster.find((x) => x.name === 'Duty Manager').rankName, 'Manager');
  });

  test('the screen is told what THIS caller may do', async () => {
    const asMgr = await get('/staff');
    assert.equal(asMgr.json.canWrite, false, 'a manager reads the roster but does not write it');
    assert.equal(asMgr.json.maxRank, 3);
    const asAdmin = await get('/staff', admin.token);
    assert.equal(asAdmin.json.canWrite, true);
    assert.equal(asAdmin.json.maxRank, 4);
  });

  test('a cashier cannot read the roster at all', async () => {
    assert.equal((await get('/staff', ctx.token)).status, 403);
  });

  /* ── the rank ceiling, which is the point ─────────────────────────────── */

  test('an admin can add staff up to their own rank', async () => {
    const r = await req('POST', '/staff', { name: 'Aishath', rank: 3, pin: '4726' }, admin.token);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.rank, 3);
    assert.equal(r.json.rankName, 'Manager');
    assert.equal(r.json.pin, undefined, 'a PIN is never returned, ever');
    newbieId = r.json.id;
  });

  test('an admin CANNOT mint an owner', async () => {
    /* Without this, rank 4 is rank 5 with one extra click. */
    const r = await req('POST', '/staff', { name: 'Ghost Owner', rank: 5, pin: '7391' }, admin.token);
    assert.equal(r.status, 403);
    assert.match(r.json.error, /above your own/);

    const still = await H.q(ctx,
      "SELECT count(*)::int AS n FROM chain.staff WHERE name = 'Ghost Owner'");
    assert.equal(still.rows[0].n, 0, 'and nothing was written');
  });

  test('nor promote somebody INTO a rank above their own', async () => {
    const r = await req('PATCH', '/staff/' + newbieId, { rank: 5 }, admin.token);
    assert.equal(r.status, 403);
    const check = await H.q(ctx, 'SELECT rank FROM chain.staff WHERE id = $1', [newbieId]);
    assert.equal(check.rows[0].rank, 3);
  });

  test('a MANAGER cannot write the roster at all', async () => {
    assert.equal((await req('POST', '/staff', { name: 'X', rank: 1, pin: '5182' })).status, 403);
    assert.equal((await req('PATCH', '/staff/' + newbieId, { rank: 1 })).status, 403);
  });

  test('the database refuses it too, not just the route', async () => {
    /* The route check is for a readable message. The POLICY is what holds the
       line — a check in application code is a check somebody forgets to write
       on the next endpoint. Here the app is bypassed entirely and the write is
       attempted as the outlet role at rank 4. */
    const denied = await H.q(ctx,
      // The context is dropped to rank 4 inside the same statement, because the
      // test helper connects at rank 5 — which legitimately MAY create an
      // owner, and would prove nothing.
      "WITH ctx AS (SELECT set_config('app.user_rank','4',true))"
      + " INSERT INTO chain.staff (name, rank, outlet_id, pin_hash, pin_salt)"
      + " SELECT 'Policy Ghost', 5, $1, 'x', 'y' FROM ctx", [ctx.outletId])
      .then(() => 'written with no error').catch((e) => e.message);
    // Either the policy rejects the row, or the row simply never appears.
    const n = await H.q(ctx,
      "SELECT count(*)::int AS n FROM chain.staff WHERE name = 'Policy Ghost'");
    assert.equal(n.rows[0].n, 0,
      'the rank ceiling is in the policy, not only in the route: ' + denied);
  });

  /* ── PINs ─────────────────────────────────────────────────────────────── */

  test('a guessable PIN is refused at the point of setting', async () => {
    for (const pin of ['1111', '1234', '0000', '4321']) {
      const r = await req('POST', '/staff', { name: 'Weak', rank: 1, pin }, admin.token);
      assert.equal(r.status, 400, pin);
      assert.match(r.json.error, /too easy to guess/);
    }
  });

  test('a PIN that is not 4–12 digits is refused', async () => {
    for (const pin of ['12', 'abcd', '']) {
      const r = await req('POST', '/staff', { name: 'Weak', rank: 1, pin }, admin.token);
      assert.equal(r.status, 400, JSON.stringify(pin));
    }
  });

  test('the PIN that was set actually signs in, and is not stored in the clear', async () => {
    const r = await H.post('/api/auth/pin', { outletId: ctx.outletId, pin: '4726' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.name, 'Aishath');
    assert.equal(r.json.rank, 3);

    const row = await H.q(ctx, 'SELECT pin_hash, pin_salt FROM chain.staff WHERE id = $1',
      [newbieId]);
    assert.ok(!row.rows[0].pin_hash.includes('4726'));
    assert.ok(row.rows[0].pin_salt.length > 8, 'salted per row');
  });

  test('changing a PIN clears a lockout, because that is who is asking', async () => {
    await H.asOwner(ctx,
      "UPDATE chain.staff SET failed = 5, locked_until = now() + interval '15 minutes'"
      + ' WHERE id = $1', [newbieId]);
    let list = await get('/staff');
    assert.ok(list.json.roster.find((x) => x.id === newbieId).lockedUntil);

    const r = await req('PATCH', '/staff/' + newbieId, { pin: '8254' }, admin.token);
    assert.equal(r.status, 200, r.text);
    list = await get('/staff');
    assert.equal(list.json.roster.find((x) => x.id === newbieId).lockedUntil, null);
    assert.equal((await H.post('/api/auth/pin',
      { outletId: ctx.outletId, pin: '8254' })).status, 200);
  });

  test('an EXPIRED lockout is not reported as one', async () => {
    // A manager sent looking for a problem that solved itself is a manager who
    // stops believing the screen.
    await H.asOwner(ctx,
      "UPDATE chain.staff SET locked_until = now() - interval '1 hour' WHERE id = $1",
      [newbieId]);
    const list = await get('/staff');
    assert.equal(list.json.roster.find((x) => x.id === newbieId).lockedUntil, null);
  });

  test('a manager can release a lockout without knowing the PIN', async () => {
    await H.asOwner(ctx,
      "UPDATE chain.staff SET failed = 5, locked_until = now() + interval '15 minutes'"
      + ' WHERE id = $1', [newbieId]);
    const r = await req('POST', '/staff/' + newbieId + '/unlock', {}, mgr.token);
    assert.equal(r.status, 200, r.text);
    const list = await get('/staff');
    const row = list.json.roster.find((x) => x.id === newbieId);
    assert.equal(row.lockedUntil, null);
    assert.equal(row.failedAttempts, 0);
  });

  /* ── the clock ────────────────────────────────────────────────────────── */

  test('a CASHIER can clock themselves in — rank 1 by design', async () => {
    /* A system that needed a manager present to start a shift is a system
       people work around with a notebook. */
    const r = await op('clock_in', {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.results[0].result.name, 'Test Cashier');

    const me = await get('/staff/me', ctx.token);
    assert.equal(me.json.onShift, true);
  });

  test('clocking in twice is refused, and says since when', async () => {
    const r = await op('clock_in', {});
    assert.match(r.json.results[0].error, /already clocked in, since \d\d:\d\d/);
    const n = await H.q(ctx,
      'SELECT count(*)::int AS n FROM shift WHERE out_at IS NULL');
    assert.equal(n.rows[0].n, 1, 'one clock, not two');
  });

  test('the roster shows who is in the building, and for how long', async () => {
    const r = await get('/staff');
    const cashier = r.json.roster.find((x) => x.name === 'Test Cashier');
    assert.equal(cashier.onShift, true);
    assert.ok(cashier.onSince);
    assert.equal(cashier.runaway, false);
    assert.equal(r.json.day.stillOpen, 1);
  });

  test('a cashier cannot clock somebody ELSE in', async () => {
    const r = await op('clock_in', { staffId: newbieId });
    assert.match(r.json.results[0].error, /needs rank 3/);
  });

  test('a manager can, and it is recorded as the MANAGER\'s act', async () => {
    const r = await op('clock_in', { staffId: newbieId }, mgr.token);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const day = (await get('/staff')).json.day;
    const row = day.shifts.find((s) => s.staffId === newbieId);
    assert.equal(row.inBy, 'Duty Manager',
      'attribution matters when it is not the person themselves');
  });

  test('clocking out closes the shift and counts the hours', async () => {
    await H.asOwner(ctx,
      "UPDATE shift SET in_at = now() - interval '3 hours' WHERE staff_id = $1"
      + ' AND out_at IS NULL', [ctx.staffId]);
    const r = await op('clock_out', {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const worked = r.json.results[0].result.hours;
    assert.ok(worked >= 2.9 && worked <= 3.1, 'about three hours, got ' + worked);

    const me = await get('/staff/me', ctx.token);
    assert.equal(me.json.onShift, false);
  });

  test('clocking out with no open shift is refused, not silently ignored', async () => {
    const r = await op('clock_out', {});
    assert.match(r.json.results[0].error, /no open shift/);
  });

  test('the day totals the hours and names who is still on', async () => {
    const r = await get('/staff');
    assert.ok(r.json.day.totalHours >= 2.9);
    assert.equal(r.json.day.stillOpen, 1, 'the person the manager clocked in');
    const closed = r.json.day.shifts.find((s) => !s.open);
    assert.ok(closed.hours > 0);
    assert.equal(closed.name, 'Test Cashier');
  });

  test('a shift left running for a day and a night is FLAGGED, not closed for them', async () => {
    /* Guessing when somebody left is inventing a payroll figure. */
    await H.asOwner(ctx,
      "UPDATE shift SET in_at = now() - interval '20 hours' WHERE staff_id = $1"
      + ' AND out_at IS NULL', [newbieId]);
    const r = await get('/staff');
    const row = r.json.roster.find((x) => x.id === newbieId);
    assert.equal(row.runaway, true);
    assert.ok(row.onFor > 16);
    assert.equal(row.onShift, true, 'still open — nobody invented a leaving time');
  });

  test('somebody taken off the roster cannot clock in', async () => {
    await req('PATCH', '/staff/' + newbieId, { active: false }, admin.token);
    await op('clock_out', { staffId: newbieId }, mgr.token);
    const r = await op('clock_in', { staffId: newbieId }, mgr.token);
    assert.match(r.json.results[0].error, /taken off the roster/);
  });

  test('a week of hours is what the roster reports, not all of history', async () => {
    await H.asOwner(ctx,
      "INSERT INTO shift (staff_id, in_at, out_at)"
      + " VALUES ($1, now() - interval '60 days', now() - interval '60 days' + interval '8 hours')",
      [ctx.staffId]);
    const r = await get('/staff');
    const cashier = r.json.roster.find((x) => x.name === 'Test Cashier');
    assert.ok(cashier.weekHours < 8,
      'a running total since the beginning of time is a number nobody can act on');
  });

  test('an unknown person is 404 and a malformed id is not a 500', async () => {
    assert.equal((await req('PATCH', '/staff/' + H.uuid(), { active: true }, admin.token)).status, 404);
    assert.equal((await req('PATCH', '/staff/not-a-uuid', { active: true }, admin.token)).status, 404);
    assert.equal((await op('clock_in', { staffId: H.uuid() }, mgr.token))
      .json.results[0].error, 'nobody works here under that id');
  });

  test('a guest token reaches none of it', async () => {
    const g = await H.post(`/api/outlet/${ctx.outletId}/guest/session`, { table: '1' });
    assert.equal((await get('/staff', g.json.token)).status, 403);
    assert.equal((await get('/staff/me', g.json.token)).status, 403);
  });
});
