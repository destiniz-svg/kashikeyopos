'use strict';
/* WHOSE BILL, WHAT THE KITCHEN WAS TOLD, AND PUTTING IT DOWN —
 * 02-POS-SPEC.md §3.3 and §3.5.
 *
 * All three of these were designed for and then never built, and two of them
 * had the column sitting there the whole time:
 *
 *   · `ticket.status` has allowed 'held' since migration 003 and nothing ever
 *     wrote it, so §3.5's parked tickets did not exist. A party moving to the
 *     bar could only be settled or written off.
 *   · `ticket_line.note` has existed just as long. The kitchen path passes it
 *     through, the KDS prints it and the receipt shows it — and no screen could
 *     put one there, so "allergy — nuts" was said out loud and written nowhere.
 *   · A split had a number and no name, so four bills on one table read
 *     "Guest 2 / Guest 3 / Guest 4" to the person carrying two of them.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const snapshot = (ctx) =>
  H.req('GET', `/api/outlet/${ctx.outletId}/snapshot`, { token: ctx.token });

describe('a bill can say whose it is', () => {
  let ctx;
  before(async () => {
    ctx = await H.bootOutlet();
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T04', split: 1, covers: 1, lines: [{ itemId: 'BURGER', qty: 1 }] },
    }]);
  });
  after(() => H.teardown(ctx));

  test('a split starts unnamed — nobody is made to give a name', async () => {
    const s = await snapshot(ctx);
    const t = s.json.tickets.find((x) => x.table_no === 'T04');
    assert.equal(t.guest_name, null);
  });

  test('and takes one', async () => {
    const s = await snapshot(ctx);
    const t = s.json.tickets.find((x) => x.table_no === 'T04');
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_guest_name', at: Date.now(),
      payload: { ticketId: t.id, name: 'Daniel' },
    }]);
    assert.ok(r.json.results[0].result, JSON.stringify(r.json.results[0]));

    const again = await snapshot(ctx);
    assert.equal(again.json.tickets.find((x) => x.table_no === 'T04').guest_name, 'Daniel');
  });

  test('an empty name clears it rather than storing nothing-as-a-name', async () => {
    const s = await snapshot(ctx);
    const t = s.json.tickets.find((x) => x.table_no === 'T04');
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_guest_name', at: Date.now(),
      payload: { ticketId: t.id, name: '   ' },
    }]);
    const again = await snapshot(ctx);
    assert.equal(again.json.tickets.find((x) => x.table_no === 'T04').guest_name, null);
  });

  test('a closed bill cannot be renamed', async () => {
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_guest_name', at: Date.now(),
      payload: { ticketId: H.uuid(), name: 'Nobody' },
    }]);
    assert.match(r.json.results[0].error, /not open/i);
  });
});

describe('a line can carry what the kitchen needs to know', () => {
  let ctx;
  before(async () => {
    ctx = await H.bootOutlet();
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T06', lines: [{ itemId: 'BURGER', qty: 1 }] },
    }]);
  });
  after(() => H.teardown(ctx));

  test('a till may write one — it is not a manager’s signature', async () => {
    /* Waiting for a manager to record an allergy is the opposite of safe, which
       is why this is rank 2 while a void is rank 3. */
    const s = await snapshot(ctx);
    const line = s.json.tickets.find((x) => x.table_no === 'T06').lines[0];
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_line_note', at: Date.now(),
      payload: { lineId: line.id, note: 'allergy — nuts' },
    }]);
    assert.ok(r.json.results[0].result, JSON.stringify(r.json.results[0]));

    const again = await snapshot(ctx);
    assert.equal(again.json.tickets.find((x) => x.table_no === 'T06').lines[0].note,
      'allergy — nuts');
  });

  test('and the note reaches the kitchen’s own view of the ticket', async () => {
    const s = await snapshot(ctx);
    const t = s.json.tickets.find((x) => x.table_no === 'T06');
    assert.ok(s.json.stages.some((g) => g.ticket_id === t.id),
      'the round is still on the pass');
    assert.equal(t.lines[0].note, 'allergy — nuts',
      'and the KDS reads its lines from this same projection');
  });

  test('clearing it puts the line back to nothing, not to an empty string', async () => {
    const s = await snapshot(ctx);
    const line = s.json.tickets.find((x) => x.table_no === 'T06').lines[0];
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_line_note', at: Date.now(),
      payload: { lineId: line.id, note: '' },
    }]);
    const row = await H.q(ctx, 'SELECT note FROM ticket_line WHERE id = $1', [line.id]);
    assert.equal(row.rows[0].note, null);
  });
});

describe('a bill can be put down and picked back up', () => {
  let ctx;
  before(async () => {
    ctx = await H.bootOutlet();
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T08', covers: 2, lines: [{ itemId: 'BURGER', qty: 2 }] },
    }]);
  });
  after(() => H.teardown(ctx));

  let ref;

  test('parking mints a HOLD reference from its own series', async () => {
    const s = await snapshot(ctx);
    const t = s.json.tickets.find((x) => x.table_no === 'T08');
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_park', at: Date.now(), payload: { ticketId: t.id },
    }]);
    const out = r.json.results[0].result;
    assert.ok(out, JSON.stringify(r.json.results[0]));
    ref = out.ref;
    assert.match(ref, /HOLD-\d+$/, 'its own counter, not the receipt series');
  });

  test('and FREES THE TABLE — the partial index stops covering it', async () => {
    /* This is the whole reason parking is worth having: the next party can be
       seated on T08 immediately. */
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T08', covers: 4, lines: [{ itemId: 'COLA', qty: 1 }] },
    }]);
    assert.ok(r.json.results[0].result, 'a new party sits down: '
      + JSON.stringify(r.json.results[0]));

    const open = await H.q(ctx,
      "SELECT count(*)::int AS n FROM ticket WHERE table_no = 'T08' AND status = 'open'");
    assert.equal(open.rows[0].n, 1, 'exactly one open bill on the table');
  });

  test('the parked bill is still reachable — it has no table to be found by', async () => {
    const s = await snapshot(ctx);
    const held = s.json.tickets.find((x) => x.hold_ref === ref);
    assert.ok(held, 'a bill nobody can reach is a bill nobody can settle');
    assert.equal(held.status, 'held');
    assert.equal(held.lines.length, 1);
  });

  test('a guest’s phone cannot read parked bills', async () => {
    const g = await H.post(`/api/outlet/${ctx.outletId}/guest/session`, { table: '8' });
    const s = await H.req('GET', `/api/outlet/${ctx.outletId}/snapshot`, { token: g.json.token });
    assert.ok(!s.json.tickets.some((x) => x.status === 'held'),
      'a parked bill belongs to no table, so it belongs to no phone');
  });

  test('resuming onto a taken table is refused, not silently merged', async () => {
    /* Two open bills on one (table, split) is exactly what ticket_open_table
       exists to prevent, and it is how one table's food reaches another
       table's receipt. */
    const s = await snapshot(ctx);
    const held = s.json.tickets.find((x) => x.hold_ref === ref);
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_resume', at: Date.now(),
      payload: { ticketId: held.id, table: 'T08' },
    }]);
    assert.match(r.json.results[0].error, /open bill on it/i);
  });

  test('and onto a free one puts it back, reference cleared', async () => {
    const s = await snapshot(ctx);
    const held = s.json.tickets.find((x) => x.hold_ref === ref);
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_resume', at: Date.now(),
      payload: { ticketId: held.id, table: 'T09' },
    }]);
    assert.ok(r.json.results[0].result, JSON.stringify(r.json.results[0]));

    const row = await H.q(ctx,
      'SELECT table_no, status, hold_ref FROM ticket WHERE id = $1', [held.id]);
    assert.equal(row.rows[0].table_no, 'T09');
    assert.equal(row.rows[0].status, 'open');
    assert.equal(row.rows[0].hold_ref, null, 'the reference is spent, not kept');
  });

  test('an empty bill is given back, not parked', async () => {
    /* A HOLD reference for nothing puts a row on the parked strip that resumes
       to an empty ticket. ticket_void already does the right thing. */
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T11', lines: [{ itemId: 'COLA', qty: 1 }] },
    }]);
    const s = await snapshot(ctx);
    const t = s.json.tickets.find((x) => x.table_no === 'T11');
    const line = t.lines[0];
    const mgr = await H.addStaff(ctx, 'Test Manager', 3);
    await H.push({ ...ctx, token: mgr.token }, [{
      opId: H.uuid(), kind: 'ticket_line_void', at: Date.now(),
      payload: { lineId: line.id, reason: 'keyed twice' },
    }]);
    const r = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_park', at: Date.now(), payload: { ticketId: t.id },
    }]);
    assert.match(r.json.results[0].error, /nothing on this bill/i);
  });

  test('parking twice returns the reference it already minted', async () => {
    /* Idempotent, like everything that arrives over the replay path. */
    await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_send', at: Date.now(),
      payload: { table: 'T12', lines: [{ itemId: 'BURGER', qty: 1 }] },
    }]);
    const s = await snapshot(ctx);
    const t = s.json.tickets.find((x) => x.table_no === 'T12');
    const a = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_park', at: Date.now(), payload: { ticketId: t.id },
    }]);
    const b = await H.push(ctx, [{
      opId: H.uuid(), kind: 'ticket_park', at: Date.now(), payload: { ticketId: t.id },
    }]);
    assert.equal(b.json.results[0].result.ref, a.json.results[0].result.ref);
    assert.equal(b.json.results[0].result.already, true);
  });
});
