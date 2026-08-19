'use strict';
/* Settlement reconciliation — 08-BUILD-STAGES §17: "acquirer batches matched to
 * payments, fees to 6180, variance surfaced."
 *
 * A CARD SALE IS NOT MONEY YET, and this system has been pretending otherwise.
 * The till takes a card, the sale debits 1020 Card receivable, and there it has
 * stayed since the first day of trading: 1020 is now the sum of every card
 * payment ever taken, and the bank account it eventually arrived in is counted
 * nowhere at all. The tables to fix that — `settlement_batch`, and `batch_id`
 * on every payment row — have been in the schema from the first migration with
 * nothing writing them.
 *
 * WHAT A MATCH POSTS:
 *
 *   Dr 1010 Bank                what actually arrived
 *   Dr 6180 Card fees           what the acquirer kept
 *   Dr/Cr 6185 variance         the difference, if there is one
 *   Cr 1020 Card receivable     WHAT THE MATCHED PAYMENTS ARE WORTH
 *
 * The credit is the PAYMENTS and not the batch. Those are the receivables being
 * discharged, and they are worth what the till recorded when the card was
 * taken. Where the acquirer's own figure disagrees, that difference is a real
 * event — a chargeback, a payment settled in a different batch, an amount
 * mistyped at the counter — and it gets its own account so somebody chases it,
 * rather than being folded into the fee where it would look like the cost of
 * doing business.
 *
 * THE SCREEN'S REAL JOB IS FINDING THE PAYMENTS. An acquirer sends a figure and
 * a date; a restaurant has three hundred card payments that week. Asking a
 * manager to tick the right forty boxes is asking them to do the reconciliation
 * by hand and then type it in, so `suggest()` proposes the set — every
 * unsettled card payment up to the value date, oldest first — and says plainly
 * whether it adds up. Ticking is for the exceptions.
 *
 * NOTHING IS EVER UNMATCHED. A batch matched in error is corrected the way
 * every other posting in this system is: the journal is reversed and the
 * payments are released, both leaving a trail. There is no edit.
 */

const { post: postJournal } = require('./journal');

const money = (n) => Math.round(Number(n) * 100) / 100;
const toMVR = (laari) => (laari / 100).toFixed(2);
const toLaari = (mvr) => Math.round(Number(mvr) * 100);
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

/* The tenders an acquirer settles. Cash is in the drawer and a house charge is
   a debt; neither arrives in a batch, and offering them here would invite
   somebody to reconcile the drawer against a card statement. */
const CARD_METHODS = ['card', 'wallet'];

/* ── what is still owed to us ────────────────────────────────────────────── */

/**
 * Every card payment with no batch, which is exactly what account 1020 is made
 * of. Grouped by business date, because that is the shape an acquirer's
 * statement arrives in.
 */
async function outstanding(c, q) {
  const to = isDate(q && q.to) ? q.to : null;
  const r = await c.query(
    'SELECT s.business_date AS date, p.method,'
    + ' count(*)::int AS n, coalesce(sum(p.amount + p.tip),0) AS amount'
    + ' FROM payment p JOIN sale s ON s.id = p.sale_id'
    + ' WHERE p.batch_id IS NULL AND p.method = ANY($1)'
    + ' AND ($2::date IS NULL OR s.business_date <= $2::date)'
    + ' GROUP BY s.business_date, p.method ORDER BY s.business_date, p.method',
    [CARD_METHODS, to]);

  const days = r.rows.map((x) => ({
    date: day(x.date), method: x.method, payments: x.n, amount: money(x.amount),
  }));
  return {
    days,
    total: money(days.reduce((a, d) => a + d.amount, 0)),
    payments: days.reduce((a, d) => a + d.payments, 0),
    /* How far back the unsettled money goes. An acquirer pays out in two or
       three days; a payment sitting here from six weeks ago is not waiting, it
       is lost, and the age is the only thing on the screen that says so. */
    oldest: days.length ? days[0].date : null,
  };
}

/** The payments themselves, for the day somebody is looking at. */
async function payments(c, q) {
  const batchId = q && q.batchId ? String(q.batchId) : null;
  const to = isDate(q && q.to) ? q.to : null;
  const r = await c.query(
    'SELECT p.id, p.method, p.amount, p.tip, p.auth_ref, p.batch_id,'
    + ' s.business_date, s.receipt_no'
    + ' FROM payment p JOIN sale s ON s.id = p.sale_id'
    + ' WHERE p.method = ANY($1)'
    + '   AND ($2::uuid IS NULL OR p.batch_id = $2::uuid)'
    + '   AND ($2::uuid IS NOT NULL OR p.batch_id IS NULL)'
    + '   AND ($3::date IS NULL OR s.business_date <= $3::date)'
    + ' ORDER BY s.business_date, s.receipt_no LIMIT 500',
    [CARD_METHODS, batchId, to]);
  return r.rows.map((x) => ({
    id: x.id, method: x.method,
    /* The tip travels with the payment: the acquirer settles what was charged
       to the card, and a tip added at the terminal was charged to the card. */
    amount: money(Number(x.amount) + Number(x.tip)),
    tip: money(x.tip), authRef: x.auth_ref || null,
    date: day(x.business_date), receipt: x.receipt_no,
    batchId: x.batch_id,
  }));
}

/* ── the batch ───────────────────────────────────────────────────────────── */

async function list(c, q) {
  const from = isDate(q && q.from) ? q.from : null;
  const to = isDate(q && q.to) ? q.to : null;
  const r = await c.query(
    'SELECT b.*, e.name AS entered_by_name, m.name AS matched_by_name,'
    + ' (SELECT count(*)::int FROM payment p WHERE p.batch_id = b.id) AS payments,'
    + ' (SELECT coalesce(sum(p.amount + p.tip),0) FROM payment p WHERE p.batch_id = b.id)'
    + '   AS matched_amount'
    + ' FROM settlement_batch b'
    + ' LEFT JOIN chain.staff e ON e.id = b.entered_by'
    + ' LEFT JOIN chain.staff m ON m.id = b.matched_by'
    + ' WHERE ($1::date IS NULL OR b.value_date >= $1::date)'
    + '   AND ($2::date IS NULL OR b.value_date <= $2::date)'
    + ' ORDER BY b.value_date DESC, b.acquirer LIMIT 200', [from, to]);

  const batches = r.rows.map(shape);
  return {
    batches,
    totals: {
      unmatched: batches.filter((b) => !b.matchedAt).length,
      /* The figure a finance manager is actually watching: money the acquirer
         says it sent that has not been tied to anything. */
      unmatchedValue: money(batches.filter((b) => !b.matchedAt)
        .reduce((a, b) => a + b.net, 0)),
      variance: money(batches.reduce((a, b) => a + b.variance, 0)),
    },
  };
}

/* One batch, read the same way the list reads them.
 *
 * A create or a match returns the row it just wrote, and an INSERT ... RETURNING
 * carries no joined staff name — so the response said `enteredBy: null` about an
 * entry the caller had that moment made, and a screen drawing from it showed a
 * blank where the person's name belongs until the next refresh. Reading it back
 * through the same query means every response describes the batch the same way. */
async function one(c, id) {
  const r = await c.query(
    'SELECT b.*, e.name AS entered_by_name, m.name AS matched_by_name,'
    + ' (SELECT count(*)::int FROM payment p WHERE p.batch_id = b.id) AS payments,'
    + ' (SELECT coalesce(sum(p.amount + p.tip),0) FROM payment p WHERE p.batch_id = b.id)'
    + '   AS matched_amount'
    + ' FROM settlement_batch b'
    + ' LEFT JOIN chain.staff e ON e.id = b.entered_by'
    + ' LEFT JOIN chain.staff m ON m.id = b.matched_by'
    + ' WHERE b.id = $1', [id]);
  if (!r.rows.length) throw Object.assign(new Error('no such batch'), { status: 404 });
  return shape(r.rows[0]);
}

function shape(b) {
  return {
    id: b.id, acquirer: b.acquirer, batchNo: b.batch_no,
    valueDate: day(b.value_date),
    gross: money(b.gross), fee: money(b.fee), net: money(b.net),
    variance: money(b.variance),
    matchedAt: b.matched_at, matchedBy: b.matched_by_name || null,
    enteredAt: b.entered_at, enteredBy: b.entered_by_name || null,
    note: b.note || null, journalId: b.journal_id,
    payments: b.payments === undefined ? null : b.payments,
    matchedAmount: b.matched_amount === undefined ? null : money(b.matched_amount),
    state: b.matched_at ? (Number(b.variance) === 0 ? 'matched' : 'matched with a difference')
      : 'waiting to be matched',
  };
}

/**
 * Enter what the acquirer says it paid.
 *
 * Typed from a statement, so the arithmetic is checked here rather than
 * trusted: gross less fee is net, and a statement that does not say that has
 * been mistyped. Catching it now is worth more than catching it at the match,
 * when it would look like a variance in the trade rather than a typo.
 */
async function record(c, p, ctx) {
  const acquirer = String(p.acquirer || '').trim().slice(0, 60);
  if (!acquirer) {
    throw Object.assign(new Error('which acquirer sent this?'), { status: 400 });
  }
  const batchNo = String(p.batchNo || '').trim().slice(0, 60);
  if (!batchNo) {
    throw Object.assign(new Error('a batch needs the reference from the statement'
      + ' — it is what anybody rings the acquirer about'), { status: 400 });
  }
  if (!isDate(p.valueDate)) {
    throw Object.assign(new Error('what date did it land?'), { status: 400 });
  }
  const gross = toLaari(p.gross || 0);
  const fee = toLaari(p.fee || 0);
  const net = p.net === undefined || p.net === null ? gross - fee : toLaari(p.net);
  if (!(gross > 0)) {
    throw Object.assign(new Error('a batch of nothing is not a batch'), { status: 400 });
  }
  if (fee < 0) {
    throw Object.assign(new Error('a fee is what they kept — it is not negative'),
      { status: 400 });
  }
  if (gross - fee !== net) {
    throw Object.assign(new Error('gross ' + toMVR(gross) + ' less fee ' + toMVR(fee)
      + ' is ' + toMVR(gross - fee) + ', not ' + toMVR(net)
      + ' — check the statement'), { status: 400 });
  }

  try {
    const q = await c.query(
      'INSERT INTO settlement_batch (acquirer, batch_no, value_date, gross, fee, net,'
      + ' entered_by, note) VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8) RETURNING *',
      [acquirer, batchNo, p.valueDate, toMVR(gross), toMVR(fee), toMVR(net),
        ctx.actor, p.note ? String(p.note).slice(0, 200) : null]);
    await c.query("SELECT chain.log('settlement_enter','settlement_batch',$1,NULL,$2)",
      [q.rows[0].id, JSON.stringify({ acquirer, batchNo, net: toMVR(net) })]);
    return one(c, q.rows[0].id);
  } catch (e) {
    if (e.code === '23505') {
      /* The same statement entered twice is the commonest mistake on this
         screen, and the one that would double-count a day's card takings. */
      throw Object.assign(new Error(acquirer + ' batch ' + batchNo
        + ' is already on the books'), { status: 409 });
    }
    throw e;
  }
}

/**
 * Which payments this batch is probably made of.
 *
 * Every unsettled card payment up to the value date, oldest first, and then the
 * arithmetic said out loud: what they come to, what the acquirer says, and the
 * difference. It does not silently pick a subset that happens to add up —
 * choosing forty payments out of three hundred because their total matches is
 * how a reconciliation looks right and is wrong.
 */
async function suggest(c, batchId) {
  const b = await c.query('SELECT * FROM settlement_batch WHERE id = $1', [batchId]);
  if (!b.rows.length) throw Object.assign(new Error('no such batch'), { status: 404 });
  const batch = b.rows[0];
  if (batch.matched_at) {
    throw Object.assign(new Error('that batch is already matched'), { status: 409 });
  }

  const rows = await payments(c, { to: day(batch.value_date) });
  const total = rows.reduce((a, r) => a + toLaari(r.amount), 0);
  const gross = toLaari(batch.gross);

  return {
    batch: shape(batch),
    payments: rows,
    total: money(total / 100),
    difference: money((gross - total) / 100),
    /* Said plainly rather than as a tick: an operator matching a batch is
       deciding whether to accept a difference, and the number is the decision. */
    agrees: gross === total,
    message: gross === total
      ? 'These add up to exactly what ' + batch.acquirer + ' says it paid.'
      : 'These come to ' + toMVR(total) + ' and the batch says ' + toMVR(gross)
        + '. The difference posts to 6185 and stays visible until somebody'
        + ' explains it.',
  };
}

/**
 * Match, and post.
 *
 * The payment ids are named by the caller — the suggestion is a suggestion —
 * and claimed with the batch guard in the WHERE clause, so a payment cannot be
 * settled into two batches by two people pressing at once.
 */
async function match(c, batchId, p, ctx) {
  const b = await c.query('SELECT * FROM settlement_batch WHERE id = $1 FOR UPDATE',
    [batchId]);
  if (!b.rows.length) throw Object.assign(new Error('no such batch'), { status: 404 });
  const batch = b.rows[0];
  if (batch.matched_at) {
    throw Object.assign(new Error('that batch is already matched'), { status: 409 });
  }

  const ids = Array.isArray(p.paymentIds) ? p.paymentIds.map(String) : [];
  if (!ids.length) {
    throw Object.assign(new Error('which payments does this batch settle?'),
      { status: 400 });
  }

  const claimed = await c.query(
    'UPDATE payment SET batch_id = $1 WHERE id = ANY($2::uuid[]) AND batch_id IS NULL'
    + ' AND method = ANY($3) RETURNING id, amount, tip', [batchId, ids, CARD_METHODS]);
  if (claimed.rows.length !== ids.length) {
    /* Deliberately the whole thing or none of it. A partial match is a batch
       reconciled against some of its payments, which balances and is wrong. */
    throw Object.assign(new Error(
      (ids.length - claimed.rows.length) + ' of those payments were already settled'
      + ' in another batch — nothing has been changed'), { status: 409 });
  }

  const matched = claimed.rows.reduce(
    (a, r) => a + toLaari(r.amount) + toLaari(r.tip), 0);
  const gross = toLaari(batch.gross);
  const fee = toLaari(batch.fee);
  const net = toLaari(batch.net);
  const variance = gross - matched;

  const lines = [{ account: '1010', dr: net, cr: 0 }];
  if (fee) lines.push({ account: '6180', dr: fee, cr: 0 });
  if (variance > 0) lines.push({ account: '6185', dr: 0, cr: variance });
  if (variance < 0) lines.push({ account: '6185', dr: -variance, cr: 0 });
  lines.push({ account: '1020', dr: 0, cr: matched });

  const jv = await postJournal(c, {
    date: day(batch.value_date),
    memo: batch.acquirer + ' batch ' + batch.batch_no
      + ' — ' + claimed.rows.length + ' payments',
    source: 'settlement', sourceId: batch.id, lines,
  }, ctx);

  await c.query(
    'UPDATE settlement_batch SET matched_at = now(), matched_by = $2, variance = $3,'
    + ' journal_id = $4 WHERE id = $1 RETURNING *',
    [batchId, ctx.actor, toMVR(variance), jv.id]);

  await c.query("SELECT chain.log('settlement_match','settlement_batch',$1,NULL,$2)",
    [batchId, JSON.stringify({
      payments: claimed.rows.length, matched: toMVR(matched),
      gross: toMVR(gross), variance: toMVR(variance), jv: jv.no,
    })]);

  return {
    ...(await one(c, batchId)),
    matchedCount: claimed.rows.length,
    matchedAmount: money(matched / 100),
    jvNo: jv.no,
    message: variance === 0
      ? claimed.rows.length + ' payments settled. ' + toMVR(net) + ' to the bank, '
        + toMVR(fee) + ' in fees.'
      : claimed.rows.length + ' payments settled with a difference of '
        + toMVR(Math.abs(variance)) + ' — it is on 6185 and will stay in the P&L'
        + ' until somebody explains it.',
  };
}

/**
 * Undo a match that should not have happened.
 *
 * The journal is REVERSED, not deleted, and the payments go back to unsettled.
 * A batch matched against the wrong week is a real mistake with a real fix, and
 * the fix leaves both the error and the correction on the record.
 */
async function unmatch(c, batchId, p, ctx) {
  const why = String(p.reason || '').trim().slice(0, 160);
  if (why.length < 4) {
    throw Object.assign(new Error('say why it is being unmatched'), { status: 400 });
  }
  const b = await c.query('SELECT * FROM settlement_batch WHERE id = $1 FOR UPDATE',
    [batchId]);
  if (!b.rows.length) throw Object.assign(new Error('no such batch'), { status: 404 });
  const batch = b.rows[0];
  if (!batch.matched_at) {
    throw Object.assign(new Error('that batch was never matched'), { status: 409 });
  }

  const ls = await c.query(
    'SELECT account_code, dr, cr FROM journal_line WHERE journal_id = $1 ORDER BY id',
    [batch.journal_id]);
  const back = await postJournal(c, {
    date: new Date().toISOString().slice(0, 10),
    memo: 'Unmatched ' + batch.acquirer + ' batch ' + batch.batch_no + ' — ' + why,
    source: 'reversal', sourceId: batch.journal_id,
    lines: ls.rows.map((l) => ({
      account: l.account_code, dr: toLaari(l.cr), cr: toLaari(l.dr),
    })),
  }, ctx);
  await c.query('UPDATE journal SET reversed_by = $2 WHERE id = $1',
    [batch.journal_id, back.id]);

  const freed = await c.query(
    'UPDATE payment SET batch_id = NULL WHERE batch_id = $1 RETURNING id', [batchId]);
  await c.query(
    'UPDATE settlement_batch SET matched_at = NULL, matched_by = NULL, variance = 0,'
    + ' journal_id = NULL WHERE id = $1', [batchId]);

  await c.query("SELECT chain.log('settlement_unmatch','settlement_batch',$1,NULL,$2)",
    [batchId, JSON.stringify({ reason: why, freed: freed.rows.length, reversal: back.no })]);

  return {
    id: batchId, freed: freed.rows.length, reversal: back.no,
    message: freed.rows.length + ' payments are unsettled again, and ' + back.no
      + ' reverses the posting. Both entries stay in the ledger.',
  };
}

module.exports = { outstanding, payments, list, record, suggest, match, unmatch, CARD_METHODS };
