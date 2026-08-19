'use strict';
/* Dispatches — 02-POS-SPEC §2 (`dispatches`): "Inter-outlet transfers, both
 * sides of the move."
 *
 * THE SHAPE OF THIS FILE IS THE TENANCY MODEL. Malé cannot write into
 * Hulhumalé's schema — it holds no grant there and the tables are not in its
 * search_path — so a transfer is not one branch moving another's stock. It is
 * a row in `chain` that both can see, a movement the SENDER writes in its own
 * books, and a movement the RECEIVER writes in theirs when they confirm what
 * turned up. Neither side ever touches the other's tables, and a transfer sent
 * and never confirmed stays visibly in flight rather than quietly completing.
 *
 * WHAT ARRIVES IS WHAT IS RECEIVED. The receiver enters the quantity they
 * actually got, and a shortfall is not an error to argue with in a dialog: it
 * is a difference between two branches' books that belongs to somebody. The
 * sender's stock left at the sent quantity; the receiver's arrives at the
 * received one; and the gap sits in 1350 with the transfer's reference on it
 * until a human decides whose it is. Making the two agree automatically would
 * be inventing the answer to the only question worth asking.
 *
 * STOCK MOVES AT WHAT IT COST WHERE IT CAME FROM. A transfer is not a sale: it
 * must not create margin in one branch or destroy it in the other. The sender's
 * average cost travels with the goods.
 */

const stock = require('./stock');
const { post: postJournal } = require('./journal');

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const n4 = (x) => Math.round(Number(x) * 10000) / 10000;
const mvr = (n) => Math.round(Number(n) * 100) / 100;

const CLEARING = '1350';
const INVENTORY = '1100';

/* ── the board ───────────────────────────────────────────────────────────── */

/**
 * Everything moving to or from this branch.
 *
 * Split by DIRECTION rather than listed by date, because the two are different
 * jobs: what is coming needs confirming, what went needs chasing. A single
 * chronological list makes somebody read every row to find the two that are
 * theirs.
 */
async function board(c, ctx, q) {
  const days = Math.min(Math.max(Number(q.days) || 30, 1), 365);
  const rows = await c.query(
    'SELECT t.*, f.name AS from_name, f.code AS from_code,'
    + ' o.name AS to_name, o.code AS to_code,'
    + ' s.name AS sent_by_name, e.name AS settled_by_name'
    + ' FROM chain.transfer t'
    /* `chain.outlet_names()`, not `chain.outlet`. The table is guarded by a
       policy matching this outlet alone, so joining it directly would drop
       every row whose OTHER end is somebody else — which is every row. See
       migration 035 for why the policy is not widened instead. */
    + ' JOIN chain.outlet_names() f ON f.id = t.from_outlet'
    + ' JOIN chain.outlet_names() o ON o.id = t.to_outlet'
    + ' LEFT JOIN chain.staff s ON s.id = t.sent_by'
    + ' LEFT JOIN chain.staff e ON e.id = t.settled_by'
    + " WHERE t.sent_at > now() - ($1 || ' days')::interval"
    + ' ORDER BY t.sent_at DESC', [String(days)]);

  const mine = ctx.outletId;
  const all = rows.rows.map((t) => {
    const sent = Number(t.qty_sent);
    const got = t.qty_received === null ? null : Number(t.qty_received);
    return {
      id: t.id, ref: t.ref, state: t.state,
      direction: t.from_outlet === mine ? 'out' : 'in',
      from: { id: t.from_outlet, name: t.from_name, code: t.from_code },
      to: { id: t.to_outlet, name: t.to_name, code: t.to_code },
      item: t.item_name, unit: t.unit,
      fromIngredient: t.from_ingredient, toIngredient: t.to_ingredient,
      qtySent: sent, qtyReceived: got,
      /* Signed the way it reads: negative is short. Null while in flight —
         nobody has said what arrived, which is not the same as nothing did. */
      variance: got === null ? null : n4(got - sent),
      unitCost: Number(t.unit_cost),
      value: mvr(sent * Number(t.unit_cost)),
      note: t.note, reason: t.reason,
      sentAt: t.sent_at, sentBy: t.sent_by_name || null,
      settledAt: t.settled_at, settledBy: t.settled_by_name || null,
    };
  });

  const inbound = all.filter((t) => t.direction === 'in');
  const outbound = all.filter((t) => t.direction === 'out');
  const inFlight = all.filter((t) => t.state === 'sent');

  return {
    inbound, outbound,
    /* The two numbers a manager acts on. `waitingOnYou` is what this branch has
       to confirm; `notConfirmed` is what this branch sent and nobody has
       acknowledged — the second is the one that quietly becomes an argument
       three weeks later. */
    waitingOnYou: inbound.filter((t) => t.state === 'sent').length,
    notConfirmed: outbound.filter((t) => t.state === 'sent').length,
    inFlightValue: mvr(inFlight.reduce((a, t) => a + t.value, 0)),
    /* Said in the payload so no screen has to remember it. */
    clearing: {
      account: CLEARING,
      why: 'Every transfer debits 1350 as it leaves and credits it as it '
        + 'arrives, so across the estate the account nets to zero once both '
        + 'halves have posted. A balance left in it is a van still on the road '
        + 'or a delivery nobody confirmed.',
    },
    days,
  };
}

/** Where a branch can send to: the other active outlets, by name. This is the
 *  one list an outlet may read about the estate, and it carries a name and a
 *  code and nothing else — no takings, no staff, no stock. */
async function destinations(c, ctx) {
  const r = await c.query(
    'SELECT id, code, name FROM chain.outlet_names()'
    + ' WHERE active AND id <> $1 ORDER BY name', [ctx.outletId]);
  return r.rows;
}

/* ── sending ─────────────────────────────────────────────────────────────── */

async function send(c, body, ctx) {
  const to = Number(body.toOutlet);
  const ingredientId = String(body.ingredientId || '').trim();
  const qty = Number(body.qty);
  if (!to || to === ctx.outletId) throw bad('send it to another branch');
  if (!ingredientId) throw bad('send what?');
  if (!Number.isFinite(qty) || qty <= 0) throw bad('how much is going?');

  const ing = await c.query(
    'SELECT id, name, unit, on_hand, avg_cost FROM ingredient WHERE id = $1 FOR UPDATE',
    [ingredientId]);
  if (!ing.rows.length) throw Object.assign(new Error('no such ingredient'), { status: 404 });
  const it = ing.rows[0];

  const dest = await c.query(
    'SELECT id, code, name FROM chain.outlet_names() WHERE id = $1 AND active', [to]);
  if (!dest.rows.length) throw bad('that branch is not open');

  /* Its own series, not a goods-received number with the letters swapped. A
     transfer is a document somebody will look for by its reference, and
     borrowing another series' counter would leave gaps in that one. */
  const ref = await c.query("SELECT chain.next_doc_no('TRF') AS no");
  const unitCost = Number(it.avg_cost);

  const t = await c.query(
    'INSERT INTO chain.transfer (ref, from_outlet, to_outlet, item_name, unit,'
    + ' from_ingredient, qty_sent, unit_cost, note, sent_by)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, ref, sent_at',
    [ref.rows[0].no, ctx.outletId, to,
      it.name, it.unit, it.id, qty, unitCost,
      String(body.note || '').trim() || null, ctx.actor || null]);

  /* The sender's own books, written by the sender. Stock leaves at what it
     cost here; the value parks in 1350 until the other end confirms. */
  await stock.move(c, {
    ingredientId, qty: -qty, unitCostLaari: unitCost * 100, reason: 'transfer',
  }, ctx);

  const valueLaari = Math.round(qty * unitCost * 100);
  const posted = valueLaari ? await postJournal(c, {
    date: body.date || new Date().toISOString().slice(0, 10),
    memo: 'Transfer out — ' + it.name + ' to ' + dest.rows[0].name,
    source: 'transfer', sourceId: t.rows[0].id,
    lines: [
      { account: CLEARING, dr: valueLaari, cr: 0 },
      { account: INVENTORY, dr: 0, cr: valueLaari },
    ],
  }, ctx) : null;

  await c.query("SELECT chain.log('transfer_send','transfer',$1,NULL,$2)",
    [t.rows[0].id, JSON.stringify({ to, item: it.name, qty, value: mvr(valueLaari / 100) })]);

  return {
    id: t.rows[0].id, ref: t.rows[0].ref, sentAt: t.rows[0].sent_at,
    to: dest.rows[0], item: it.name, unit: it.unit, qty,
    value: mvr(valueLaari / 100), posted,
    /* Named, because a branch that sends stock it did not have has either
       miscounted or is about to. */
    short: Number(it.on_hand) < qty
      ? { onHand: Number(it.on_hand), sent: qty } : null,
  };
}

/* ── receiving ───────────────────────────────────────────────────────────── */

/**
 * Confirm what turned up.
 *
 * The receiver names their OWN ingredient — ids are per-outlet and Malé's
 * `BEEF` is not Hulhumalé's — and enters the quantity that actually arrived.
 *
 * READ WITHOUT `FOR UPDATE`, and this is not a detail. A locking read has to
 * satisfy the UPDATE policy as well as the SELECT one, and `transfer_settle`
 * is `USING (state = 'sent' …)` — so `SELECT … FOR UPDATE` on a transfer that
 * has already been received matches NO ROW and the caller is told "no such
 * transfer". A settled transfer becoming invisible to its own participants is
 * a worse answer than the true one. The race is closed at the UPDATE instead,
 * which names the state it expects and reports when it finds nothing.
 */
async function receive(c, id, body, ctx) {
  const t = await c.query('SELECT * FROM chain.transfer WHERE id = $1', [id]);
  if (!t.rows.length) throw Object.assign(new Error('no such transfer'), { status: 404 });
  const tr = t.rows[0];
  if (tr.to_outlet !== ctx.outletId) throw bad('that transfer was not sent here');
  if (tr.state !== 'sent') throw bad('that transfer has already been settled');

  const toIngredient = String(body.ingredientId || '').trim();
  if (!toIngredient) throw bad('which of your own ingredients is this?');
  const got = body.qty === undefined || body.qty === ''
    ? Number(tr.qty_sent) : Number(body.qty);
  if (!Number.isFinite(got) || got < 0) throw bad('how much arrived?');

  const ing = await c.query(
    'SELECT id, name, unit, on_hand, avg_cost FROM ingredient WHERE id = $1 FOR UPDATE',
    [toIngredient]);
  if (!ing.rows.length) throw Object.assign(new Error('no such ingredient here'), { status: 404 });
  const mine = ing.rows[0];
  if (mine.unit !== tr.unit) {
    /* Refused rather than converted. Grams into millilitres is a conversion
       nobody can do without knowing what the thing is, and guessing it would
       put a wrong quantity into a real store. */
    throw bad(tr.item_name + ' was sent in ' + tr.unit + ' and ' + mine.name
      + ' is counted in ' + mine.unit + ' — they have to match');
  }

  const unitCost = Number(tr.unit_cost);
  /* The state is named in the statement, so two people confirming the same
     delivery at once end with one of them told it was already done rather than
     with two sets of stock arriving. */
  const claimed = await c.query(
    "UPDATE chain.transfer SET state = 'received', qty_received = $2,"
    + ' to_ingredient = $3, settled_at = now(), settled_by = $4, reason = $5'
    + " WHERE id = $1 AND state = 'sent' RETURNING id",
    [id, got, toIngredient, ctx.actor || null,
      String(body.reason || '').trim() || null]);
  if (!claimed.rows.length) {
    throw Object.assign(new Error('somebody else confirmed that transfer first'),
      { status: 409 });
  }

  let posted = null;
  if (got > 0) {
    /* Arrives at the SENDER's cost. A transfer is not a sale; it must not make
       margin in one branch or destroy it in the other. Then the receiver's own
       average moves the way a delivery would move it. */
    await stock.move(c, {
      ingredientId: toIngredient, qty: got, unitCostLaari: unitCost * 100,
      reason: 'transfer',
    }, ctx);

    const prevQty = Number(mine.on_hand);
    const prevCost = Number(mine.avg_cost);
    const newAvg = prevQty + got > 0
      ? (prevQty * prevCost + got * unitCost) / (prevQty + got) : unitCost;
    await c.query('UPDATE ingredient SET avg_cost = $2 WHERE id = $1',
      [toIngredient, Math.round(newAvg * 10000) / 10000]);

    const valueLaari = Math.round(got * unitCost * 100);
    posted = valueLaari ? await postJournal(c, {
      date: body.date || new Date().toISOString().slice(0, 10),
      memo: 'Transfer in — ' + tr.item_name + ' (' + tr.ref + ')',
      source: 'transfer', sourceId: id,
      lines: [
        { account: INVENTORY, dr: valueLaari, cr: 0 },
        { account: CLEARING, dr: 0, cr: valueLaari },
      ],
    }, ctx) : null;
  }

  await c.query("SELECT chain.log('transfer_receive','transfer',$1,NULL,$2)",
    [id, JSON.stringify({ qty: got, sent: Number(tr.qty_sent), toIngredient })]);

  const variance = n4(got - Number(tr.qty_sent));
  return {
    id, ref: tr.ref, received: got, sent: Number(tr.qty_sent), variance, posted,
    /* Reported, never reconciled. The clearing account keeps the difference
       with this transfer's reference on it until a person decides whose it is
       — a shortfall is a fact about two branches, not a rounding error. */
    settlement: variance === 0 ? null : {
      value: mvr(Math.abs(variance) * unitCost),
      account: CLEARING,
      why: variance < 0
        ? 'Less arrived than left. That difference stays in 1350 with this '
          + 'transfer against it until somebody says whose it is — the branch '
          + 'that sent it, the one that received it, or the road in between.'
        : 'More arrived than left, which is worth as much attention as less: '
          + 'either the sender miscounted or somebody else\'s stock is here.',
    },
  };
}

/** The other outcome: it did not arrive, or it should not have gone. Either
 *  way the sender's stock has to come back, because it never left in fact. */
async function settleBack(c, id, body, ctx, kind) {
  /* Not `FOR UPDATE` — see `receive` for why a locking read cannot see a row
     the UPDATE policy would refuse. */
  const t = await c.query('SELECT * FROM chain.transfer WHERE id = $1', [id]);
  if (!t.rows.length) throw Object.assign(new Error('no such transfer'), { status: 404 });
  const tr = t.rows[0];
  if (tr.state !== 'sent') throw bad('that transfer has already been settled');
  const isSender = tr.from_outlet === ctx.outletId;
  if (kind === 'cancelled' && !isSender) throw bad('only the sending branch can cancel');
  if (kind === 'rejected' && tr.to_outlet !== ctx.outletId) {
    throw bad('only the receiving branch can turn it away');
  }
  const reason = String(body.reason || '').trim();
  if (!reason) throw bad('say why');

  const claimed = await c.query(
    'UPDATE chain.transfer SET state = $2, settled_at = now(), settled_by = $3,'
    + " reason = $4 WHERE id = $1 AND state = 'sent' RETURNING id",
    [id, kind, ctx.actor || null, reason]);
  if (!claimed.rows.length) {
    throw Object.assign(new Error('that transfer has already been settled'),
      { status: 409 });
  }

  /* THE SENDER'S STOCK IS NOT PUT BACK HERE, and it cannot be: only the sending
     branch can write to the sending branch's books, and a rejection is
     recorded by the receiver. So the row goes back to the sender's board as
     something to take back in, with the reason on it. Reaching across to undo
     their movement is exactly the thing this design does not do. */
  await c.query("SELECT chain.log(concat('transfer_', $2::text),'transfer',$1,NULL,$3)",
    [id, kind, JSON.stringify({ reason })]);

  return {
    id, ref: tr.ref, state: kind, reason,
    /* Said rather than left to be discovered. */
    next: isSender && kind === 'cancelled'
      ? 'Take it back into stock at this branch to close the loop — the sending '
        + 'movement stands until you do.'
      : 'The sending branch has to take it back into their own stock. Nothing '
        + 'here can write to their books, which is the point.',
  };
}

/** Take back what came home. The sender's own act, in the sender's own books —
 *  the mirror of the send, and the only way a cancelled or rejected transfer
 *  ever closes. */
async function takeBack(c, id, body, ctx) {
  /* Plain read. This one could not lock the row even if it wanted to: the
     transfer is `cancelled` or `rejected` by now and the UPDATE policy only
     matches `sent`. Nothing here writes to chain.transfer — taking stock back
     is a movement in the sender's OWN books, which is the whole point. */
  const t = await c.query('SELECT * FROM chain.transfer WHERE id = $1', [id]);
  if (!t.rows.length) throw Object.assign(new Error('no such transfer'), { status: 404 });
  const tr = t.rows[0];
  if (tr.from_outlet !== ctx.outletId) throw bad('only the branch that sent it can take it back');
  if (tr.state !== 'cancelled' && tr.state !== 'rejected') {
    throw bad('that transfer has not come back');
  }
  const qty = body.qty === undefined || body.qty === ''
    ? Number(tr.qty_sent) : Number(body.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw bad('how much came back?');

  const unitCost = Number(tr.unit_cost);
  await stock.move(c, {
    ingredientId: tr.from_ingredient, qty, unitCostLaari: unitCost * 100,
    reason: 'transfer',
  }, ctx);
  const valueLaari = Math.round(qty * unitCost * 100);
  const posted = valueLaari ? await postJournal(c, {
    date: body.date || new Date().toISOString().slice(0, 10),
    memo: 'Transfer returned — ' + tr.item_name + ' (' + tr.ref + ')',
    source: 'transfer', sourceId: id,
    lines: [
      { account: INVENTORY, dr: valueLaari, cr: 0 },
      { account: CLEARING, dr: 0, cr: valueLaari },
    ],
  }, ctx) : null;

  await c.query("SELECT chain.log('transfer_taken_back','transfer',$1,NULL,$2)",
    [id, JSON.stringify({ qty, value: mvr(valueLaari / 100) })]);
  return { id, ref: tr.ref, qty, value: mvr(valueLaari / 100), posted };
}

module.exports = { board, destinations, send, receive, takeBack, settleBack, CLEARING };
