'use strict';
/* Reservations — §2 (`reservations`).
 *
 * What this file is really about:
 *
 *   · A BOOKING HOLDS A TABLE FOR A WINDOW. The failure this guards against is
 *     two parties meeting at the door, and it is refused by a constraint rather
 *     than by a screen remembering to look.
 *   · SEATING IS THE JOIN TO THE FLOOR. Arriving opens the ticket, with the
 *     covers and the name already on it — otherwise the host types the same
 *     four facts into the till thirty seconds later.
 *   · A NO-SHOW IS DATA. It is a status, never a deletion.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const res = require('../src/reservations');

describe('reservations', () => {
  let ctx, mgr, tonight;

  before(async () => {
    ctx = await H.bootOutlet();
    mgr = await H.addStaff(ctx, 'Duty Manager', 3);
    tonight = ctx.today;
  });
  after(() => H.teardown(ctx));

  const req = (method, p, body, token) =>
    H.req(method, `/api/outlet/${ctx.outletId}${p}`, { body, token: token || ctx.token });
  const get = (p, token) => req('GET', p, undefined, token);
  const book = (b) => req('POST', '/reservations', { onDate: tonight, ...b });

  /* ── the book ─────────────────────────────────────────────────────────── */

  test('an empty book is an empty evening, not an error', async () => {
    const r = await get('/reservations');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.reservations, []);
    assert.equal(r.json.totals.bookings, 0);
    assert.equal(r.json.totals.covers, 0);
    assert.deepEqual(r.json.heldTables, []);
  });

  test('a booking needs a name, a time and a number of people', async () => {
    assert.equal((await book({ at: '19:00', covers: 2 })).status, 400);
    assert.equal((await book({ name: 'Ali', covers: 2 })).status, 400);
    assert.equal((await book({ name: 'Ali', at: '19:00' })).status, 400);
    const bad = await book({ name: 'Ali', at: 'half seven', covers: 2 });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /like 19:30/);
  });

  test('a booking is taken, with or without a table', async () => {
    /* A host takes the name at eleven and decides the room at six. */
    const r = await book({ name: 'Ibrahim', at: '19:00', covers: 4, phone: '7771111' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.tableNo, null, 'no table yet, and that is normal');

    const withTable = await book({ name: 'Aishath', at: '19:30', covers: 2, tableNo: '5' });
    assert.equal(withTable.status, 201, withTable.text);
    assert.equal(withTable.json.tableNo, 'T05', 'and it comes back as the floor calls it');
  });

  test('the evening is counted in covers, not just in bookings', async () => {
    const r = await get('/reservations');
    assert.equal(r.json.totals.bookings, 2);
    assert.equal(r.json.totals.covers, 6, 'four and two');
    assert.deepEqual(r.json.heldTables, ['T05']);
  });

  /* ── the double-booking guard ─────────────────────────────────────────── */

  test('the same table across an overlapping window is REFUSED', async () => {
    /* Table 5 is held 19:30–21:00. A 20:00 booking on it is two parties
       meeting at the door, and it is refused by the schema — a check in the
       application would lose to two hosts on two terminals in the same
       second. */
    const clash = await book({ name: 'Hassan', at: '20:00', covers: 2, tableNo: '5' });
    assert.equal(clash.status, 409, clash.text);
    assert.match(clash.json.error, /already booked/);
    assert.match(clash.json.error, /20:00/, 'and it says which window');
  });

  test('the same table AFTER the window is fine', async () => {
    const later = await book({ name: 'Hassan', at: '21:00', covers: 2, tableNo: '5' });
    assert.equal(later.status, 201, later.text);
  });

  test('the same time on ANOTHER table is fine', async () => {
    const other = await book({ name: 'Mohamed', at: '19:30', covers: 2, tableNo: '6' });
    assert.equal(other.status, 201, other.text);
  });

  test('a shorter hold frees the table sooner', async () => {
    const quick = await book({
      name: 'Quick lunch', at: '12:00', covers: 2, tableNo: '7', mins: 30,
    });
    assert.equal(quick.status, 201, quick.text);
    const after = await book({ name: 'Next', at: '12:30', covers: 2, tableNo: '7' });
    assert.equal(after.status, 201, after.text);
  });

  test('an absurd hold is refused', async () => {
    const r = await book({ name: 'Forever', at: '12:00', covers: 2, mins: 4000 });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /15 to 480/);
  });

  test('a table\'s own evening can be read on its own', async () => {
    /* The question a host on the telephone is actually asking. */
    const r = await get('/reservations/table/5');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.bookings.length, 2);
    assert.equal(r.json.bookings[0].at, '19:30');
    assert.equal(r.json.bookings[0].until, '21:00');
    assert.equal(r.json.bookings[1].at, '21:00');
  });

  /* ── arrival ──────────────────────────────────────────────────────────── */

  test('seating a party OPENS THEIR TICKET — the covers and the name with it',
    async () => {
      /* The whole reason this is a module and not a diary. */
      const day = await get('/reservations');
      const ibrahim = day.json.reservations.find((x) => x.name === 'Ibrahim');
      assert.equal(ibrahim.tableNo, null);

      const r = await req('POST', `/reservations/${ibrahim.id}/seat`, { tableNo: '2' });
      assert.equal(r.status, 200, r.text);
      assert.ok(r.json.ticketId, 'a ticket exists now');
      assert.match(r.json.message, /table T02/);

      const t = await H.q(ctx,
        'SELECT table_no, covers, status, server_name FROM ticket WHERE id = $1',
        [r.json.ticketId]);
      assert.equal(t.rows[0].table_no, 'T02',
        'the floor\'s own label, so the tile lights up');
      assert.equal(t.rows[0].covers, 4, 'the covers came with them');
      assert.equal(t.rows[0].status, 'open');
      assert.equal(t.rows[0].server_name, 'Ibrahim', 'and so did the name');
    });

  test('a party cannot be seated at no table', async () => {
    const day = await get('/reservations');
    const mohamed = day.json.reservations.find((x) => x.name === 'Mohamed');
    /* This one HAS a table, so use a booking without one. */
    const nowhere = await book({ name: 'Nowhere', at: '18:00', covers: 2 });
    const r = await req('POST', `/reservations/${nowhere.json.id}/seat`, {});
    assert.equal(r.status, 400);
    assert.match(r.json.error, /which table/);
    void mohamed;
  });

  test('seating twice is refused', async () => {
    const day = await get('/reservations');
    const ibrahim = day.json.reservations.find((x) => x.name === 'Ibrahim');
    assert.equal(ibrahim.status, 'seated');
    const r = await req('POST', `/reservations/${ibrahim.id}/seat`, { tableNo: '2' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /already sitting/);
  });

  test('seating a table that already has an open ticket REUSES it', async () => {
    /* A walk-in the host is moving, or a table nobody closed. Losing that race
       would fail the arrival of a party standing at the door. */
    const before = await H.q(ctx,
      "SELECT id FROM ticket WHERE table_no = 'T02' AND status = 'open'");
    assert.equal(before.rows.length, 1);

    const second = await book({ name: 'Later party', at: '22:00', covers: 2 });
    const r = await req('POST', `/reservations/${second.json.id}/seat`, { tableNo: '2' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ticketId, before.rows[0].id, 'the same ticket');

    const after = await H.q(ctx,
      "SELECT count(*)::int AS n FROM ticket WHERE table_no = 'T02' AND status = 'open'");
    assert.equal(after.rows[0].n, 1, 'and still only one');
  });

  /* ── what did not happen ──────────────────────────────────────────────── */

  test('a no-show is recorded, not deleted', async () => {
    const day = await get('/reservations');
    const hassan = day.json.reservations.find((x) => x.name === 'Hassan' && x.status === 'booked');
    const r = await req('POST', `/reservations/${hassan.id}/no-show`, { reason: 'never came' });
    assert.equal(r.status, 200, r.text);

    const after = await get('/reservations');
    const still = after.json.reservations.find((x) => x.id === hassan.id);
    assert.ok(still, 'the booking is still there');
    assert.equal(still.status, 'no_show');
    assert.equal(still.reason, 'never came');
    assert.equal(after.json.totals.noShows, 1);
  });

  test('a no-show releases the table for somebody else', async () => {
    /* The constraint only counts bookings that are still holding the room. */
    const day = await get('/reservations');
    const gone = day.json.reservations.find((x) => x.status === 'no_show');
    const r = await book({ name: 'Walk in', at: gone.at, covers: 2, tableNo: gone.tableNo });
    assert.equal(r.status, 201, r.text);
  });

  test('a seated party cannot be marked a no-show', async () => {
    const day = await get('/reservations');
    const seated = day.json.reservations.find((x) => x.status === 'seated');
    const r = await req('POST', `/reservations/${seated.id}/no-show`, {});
    assert.equal(r.status, 409);
    assert.match(r.json.error, /never arrived/);
  });

  test('a cancelled booking releases its table too', async () => {
    const made = await book({ name: 'Cancels', at: '15:00', covers: 2, tableNo: '9' });
    const c = await req('POST', `/reservations/${made.json.id}/cancel`,
      { reason: 'changed their mind' });
    assert.equal(c.status, 200, c.text);
    const again = await book({ name: 'Takes it', at: '15:00', covers: 2, tableNo: '9' });
    assert.equal(again.status, 201, again.text);
  });

  test('finishing frees the booking; the ticket is the till\'s business', async () => {
    const day = await get('/reservations');
    const seated = day.json.reservations.find((x) => x.status === 'seated');
    const r = await req('POST', `/reservations/${seated.id}/finish`, {});
    assert.equal(r.status, 200, r.text);
    const after = await get('/reservations');
    assert.equal(after.json.reservations.find((x) => x.id === seated.id).status, 'done');
    /* The ticket is untouched: a party that has left may still owe for it. */
    const t = await H.q(ctx, 'SELECT status FROM ticket WHERE id = $1', [seated.ticketId]);
    assert.equal(t.rows[0].status, 'open');
  });

  /* ── moving one ───────────────────────────────────────────────────────── */

  test('a booking can be moved, and the guard still holds', async () => {
    const made = await book({ name: 'Moves', at: '16:00', covers: 2, tableNo: '11' });
    const ok = await req('PATCH', `/reservations/${made.json.id}`, { at: '16:30', covers: 4 });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.at, '16:30');
    assert.equal(ok.json.covers, 4);

    await book({ name: 'Blocks', at: '18:00', covers: 2, tableNo: '12' });
    const clash = await req('PATCH', `/reservations/${made.json.id}`,
      { at: '18:00', tableNo: '12' });
    assert.equal(clash.status, 409);
    assert.match(clash.json.error, /already booked/);
  });

  test('a closed booking cannot be moved', async () => {
    const day = await get('/reservations');
    const gone = day.json.reservations.find((x) => x.status === 'cancelled');
    const r = await req('PATCH', `/reservations/${gone.id}`, { at: '20:00' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /closed/);
  });

  /* ── the clock ────────────────────────────────────────────────────────── */

  test('the book says WHO IS LATE and by how long, not merely "overdue"',
    async () => {
      /* Four minutes and forty minutes are different decisions about a table. */
      const early = await book({ name: 'Early bird', at: '00:05', covers: 2 });
      assert.equal(early.status, 201, early.text);
      const r = await get('/reservations');
      const late = r.json.late.find((x) => x.name === 'Early bird');
      assert.ok(late, 'it is on the late list');
      assert.ok(late.lateBy > 0, 'with a number of minutes');
    });

  test('another day is another book', async () => {
    const r = await get('/reservations?date=2099-06-01');
    assert.deepEqual(r.json.reservations, []);
    assert.equal(r.json.date, '2099-06-01');
  });

  test('a nonsense date is refused', async () => {
    const r = await get('/reservations?date=tonight');
    assert.equal(r.status, 400);
  });

  /* ── who may work the book ────────────────────────────────────────────── */

  test('the whole book is TILL rank — the host is on the shift', async () => {
    assert.equal((await get('/reservations', mgr.token)).status, 200);
    assert.equal((await get('/reservations', ctx.token)).status, 200,
      'and the person who answers the telephone');
  });

  test('a kitchen session reaches none of it', async () => {
    const kds = await H.addStaff(ctx, 'Chef', 1);
    assert.equal((await get('/reservations', kds.token)).status, 403);
  });

  /* ── the arithmetic, without a database in the way ────────────────────── */

  test('"2" and "T02" are ONE table, or the guard guards nothing', async () => {
    /* The floor draws its tiles T01…Tn; the guest portal's QR carries a bare
       number; a host types whichever is in their head. Left alone those are
       different tables to an exclusion constraint, so two bookings — one typed
       each way — would both be accepted on the same physical table and the
       guard would have enforced nothing. Found by seating a party on "2" and
       watching the floor go on showing T02 as free. */
    const a = await book({ name: 'Typed bare', at: '10:00', covers: 2, tableNo: '8' });
    assert.equal(a.status, 201, a.text);
    assert.equal(a.json.tableNo, 'T08', 'normalised on the way in');

    const b = await book({ name: 'Typed long', at: '10:30', covers: 2, tableNo: 'T08' });
    assert.equal(b.status, 409, 'the same table, and the guard sees it');
    assert.match(b.json.error, /already booked/);

    const c = await book({ name: 'Lower case', at: '10:30', covers: 2, tableNo: 't8' });
    assert.equal(c.status, 409, 'however it is written');
  });

  test('a table with a NAME rather than a number is left alone', () => {
    /* A restaurant that calls a table the Terrace is not making a typing
       mistake. */
    assert.equal(res.tableName('Terrace'), 'Terrace');
    assert.equal(res.tableName('2'), 'T02');
    assert.equal(res.tableName('T2'), 'T02');
    assert.equal(res.tableName('t02'), 'T02');
    assert.equal(res.tableName('12'), 'T12');
    assert.equal(res.tableName(''), null);
  });

  test('a time of day survives the round trip', () => {
    assert.equal(res.toMin('19:30'), 1170);
    assert.equal(res.toMin('00:00'), 0);
    assert.equal(res.toMin('9:05'), 545);
    assert.equal(res.toMin('24:00'), null, 'there is no such time');
    assert.equal(res.toMin('19:60'), null);
    assert.equal(res.hhmm(1170), '19:30');
    assert.equal(res.hhmm(0), '00:00');
    assert.equal(res.hhmm(res.toMin('07:05')), '07:05');
  });
});
