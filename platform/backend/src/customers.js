'use strict';
/* Customers & Credit — 02-POS-SPEC.md §2 (`customers`): "Chain-wide profiles,
 * loyalty tier, house-account credit ledger."
 *
 * THE PROFILE IS CHAIN-WIDE; THE DEBT IS NOT. A customer is recognised at any
 * outlet — that is what `chain.member` has been for since migration 001 — but
 * 1030 Customer receivable lives in each outlet's own schema, so a company
 * eating at three branches owes three balances and each branch's balance sheet
 * carries its own. A single number across the estate would be adding up money
 * from ledgers that never meet, and would be nobody's receivable.
 *
 * A HOUSE CHARGE IS NOT A PAYMENT. No money arrives; a promise does. It debits
 * 1030 and the drawer must be untouched by it — which is exactly why sale.js no
 * longer falls back to the cash account for a tender it does not recognise.
 *
 * AGEING IS BY ALLOCATION, NOT BY NET BALANCE, and this is the part that is
 * easy to get plausibly wrong. Age the net figure and a customer who pays every
 * month like clockwork appears further and further overdue for ever, because
 * their oldest INVOICE is always old while their balance is always current.
 * A receipt settles the oldest charge first, and what is left over is what
 * ages. Getting this wrong does not produce an error — it produces a statement
 * that puts a good customer on stop.
 *
 * NOUGHT IS NOT "NO LIMIT", IT IS NO CREDIT. Anybody at till rank can create a
 * customer record; extending credit is an admin's decision and has to be made
 * on purpose.
 */

const { post: postJournal } = require('./journal');

const toMVR = (laari) => (laari / 100).toFixed(2);
const toLaari = (mvr) => Math.round(Number(mvr) * 100);
const money = (n) => Math.round(Number(n) * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);

const PHONE = /^[0-9+][0-9 -]{4,19}$/;

/* ── profiles ────────────────────────────────────────────────────────────── */

/**
 * Everyone, with what they owe HERE. The balance comes from this outlet's
 * house_entry ledger, joined onto the chain-wide profile.
 */
async function list(c, opts) {
  const q = opts && opts.q ? String(opts.q).trim().toLowerCase() : '';
  const rows = await c.query(
    'SELECT m.*,'
    + '  coalesce(h.owed, 0) AS owed,'
    + '  coalesce(h.charges, 0) AS charges,'
    + '  h.last_at'
    + ' FROM chain.member m'
    + ' LEFT JOIN ('
    + '   SELECT member_id, sum(amount) AS owed,'
    + "     count(*) FILTER (WHERE kind = 'charge') AS charges,"
    + '     max(on_date) AS last_at'
    + '   FROM house_entry GROUP BY member_id'
    + ' ) h ON h.member_id = m.id'
    + (q ? ' WHERE lower(coalesce(m.name,\'\')) LIKE $1'
        + ' OR m.phone LIKE $1 OR lower(coalesce(m.company,\'\')) LIKE $1' : '')
    + ' ORDER BY coalesce(h.owed,0) DESC, m.name NULLS LAST LIMIT 300',
    q ? ['%' + q + '%'] : []);

  const members = rows.rows.map(shape);
  return {
    members,
    totals: {
      count: members.length,
      owed: money(members.reduce((s, m) => s + m.owed, 0)),
      onAccount: members.filter((m) => m.creditLimit > 0).length,
      overLimit: members.filter((m) => m.owed > m.creditLimit && m.creditLimit > 0).length,
    },
  };
}

function shape(r) {
  const owed = money(r.owed || 0);
  const limit = money(r.credit_limit || 0);
  return {
    id: r.id, phone: r.phone, name: r.name, company: r.company, email: r.email,
    note: r.note, tier: r.tier, points: money(r.points || 0),
    joinedAt: r.joined_at, consentAt: r.consent_at,
    creditLimit: limit, termsDays: r.terms_days, blocked: r.blocked,
    owed,
    /* What they could still put on the account today. The figure a cashier
       actually needs, and the one that is wrong if you compute it from the
       limit alone. */
    available: money(Math.max(0, limit - owed)),
    overLimit: limit > 0 && owed > limit,
    onAccount: limit > 0,
    charges: Number(r.charges || 0),
    lastAt: r.last_at || null,
  };
}

async function save(c, p, ctx) {
  const phone = String(p.phone || '').trim();
  if (!PHONE.test(phone)) {
    throw Object.assign(new Error('a phone number, please'), { status: 400 });
  }
  const name = p.name ? String(p.name).trim().slice(0, 120) : null;

  if (p.id) {
    const q = await c.query(
      'UPDATE chain.member SET phone = $2, name = $3, company = $4, email = $5,'
      + ' note = $6 WHERE id = $1 RETURNING *',
      [p.id, phone, name, p.company ? String(p.company).slice(0, 120) : null,
        p.email ? String(p.email).slice(0, 160) : null,
        p.note ? String(p.note).slice(0, 300) : null]);
    if (!q.rows.length) throw Object.assign(new Error('no such customer'), { status: 404 });
    await c.query("SELECT chain.log('customer_save','member',$1,NULL,$2)",
      [p.id, JSON.stringify({ phone, name })]);
    return shape({ ...q.rows[0], owed: 0 });
  }

  const dup = await c.query('SELECT id FROM chain.member WHERE phone = $1', [phone]);
  if (dup.rows.length) {
    /* Not an error: the person is standing at the counter and the number is
       already known. Hand back who it is rather than making them try again
       with a number they cannot change. */
    const q = await c.query('SELECT * FROM chain.member WHERE id = $1', [dup.rows[0].id]);
    return { ...shape({ ...q.rows[0], owed: 0 }), already: true };
  }

  const ins = await c.query(
    'INSERT INTO chain.member (phone, name, company, email, note, home_outlet,'
    + ' consent_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [phone, name, p.company ? String(p.company).slice(0, 120) : null,
      p.email ? String(p.email).slice(0, 160) : null,
      p.note ? String(p.note).slice(0, 300) : null, ctx.outletId,
      p.consent ? new Date() : null]);
  await c.query("SELECT chain.log('customer_add','member',$1,NULL,$2)",
    [ins.rows[0].id, JSON.stringify({ phone, name })]);
  return shape({ ...ins.rows[0], owed: 0 });
}

/**
 * Extending credit. Admin only, and separate from editing a name on purpose:
 * a limit is a decision about money, not a detail about a person.
 */
async function setCredit(c, p, ctx) {
  const limit = toLaari(p.creditLimit || 0);
  if (limit < 0) throw Object.assign(new Error('a limit cannot be negative'), { status: 400 });
  const terms = Number(p.termsDays || 0);
  if (!Number.isInteger(terms) || terms < 0 || terms > 180) {
    throw Object.assign(new Error('terms of 0 to 180 days'), { status: 400 });
  }
  const q = await c.query(
    'UPDATE chain.member SET credit_limit = $2, terms_days = $3, blocked = $4'
    + ' WHERE id = $1 RETURNING *',
    [p.id, toMVR(limit), terms, !!p.blocked]);
  if (!q.rows.length) throw Object.assign(new Error('no such customer'), { status: 404 });

  await c.query("SELECT chain.log('customer_credit','member',$1,NULL,$2)",
    [p.id, JSON.stringify({ limit: toMVR(limit), terms, blocked: !!p.blocked })]);
  const owed = await balance(c, p.id);
  return {
    ...shape({ ...q.rows[0], owed: owed / 100 }),
    /* Said out loud, because lowering a limit below what is already owed does
       not claw anything back — it only stops the next charge. */
    message: limit > 0 && owed > limit
      ? 'They already owe ' + toMVR(owed) + ', which is over the new limit. Nothing'
        + ' is clawed back; they simply cannot charge any more until they pay.'
      : undefined,
  };
}

/* ── the credit ledger ───────────────────────────────────────────────────── */

/** What this outlet is owed by one customer, in laari, from the ledger. */
async function balance(c, memberId) {
  const q = await c.query(
    'SELECT coalesce(sum(amount),0) AS owed FROM house_entry WHERE member_id = $1',
    [memberId]);
  return toLaari(q.rows[0].owed);
}

/**
 * Can this customer put `amountL` more on the account? Called from the sale
 * path BEFORE the sale closes — a refusal after the money would have been a
 * receipt for a debt nobody agreed to.
 */
async function checkCredit(c, memberId, amountL) {
  const m = await c.query(
    'SELECT id, name, phone, credit_limit, blocked FROM chain.member WHERE id = $1',
    [memberId]);
  if (!m.rows.length) {
    throw Object.assign(new Error('a house charge needs a customer'), { status: 409 });
  }
  const r = m.rows[0];
  const who = r.name || r.phone;
  if (r.blocked) {
    throw Object.assign(new Error(who + ' is blocked from charging to the account'),
      { status: 409 });
  }
  const limit = toLaari(r.credit_limit);
  if (limit <= 0) {
    throw Object.assign(new Error(
      who + ' has no house account. An admin sets a credit limit before anything'
      + ' can be charged to it.'), { status: 409 });
  }
  const owed = await balance(c, memberId);
  if (owed + amountL > limit) {
    throw Object.assign(new Error(
      who + ' owes ' + toMVR(owed) + ' of a ' + toMVR(limit) + ' limit — '
      + toMVR(Math.max(0, limit - owed)) + ' left, and this is ' + toMVR(amountL)),
      { status: 409 });
  }
  return { member: r, owed, limit, available: limit - owed };
}

/** Record the charge itself. Called by sale.js once the sale exists. */
async function charge(c, p, ctx) {
  await c.query(
    'INSERT INTO house_entry (on_date, member_id, kind, amount, sale_id, doc_no,'
    + " method, note, by_staff) VALUES ($1::date,$2,'charge',$3,$4,$5,'account',$6,$7)",
    [p.onDate, p.memberId, toMVR(p.amount), p.saleId || null, p.docNo || null,
      p.note || null, ctx.actor]);
}

/**
 * A customer settles some of what they owe. Dr the money, Cr 1030.
 *
 * p = { memberId, amount, method, on?, note? }
 */
async function receipt(c, p, ctx) {
  const amount = toLaari(p.amount || 0);
  if (!(amount > 0)) {
    throw Object.assign(new Error('an amount above zero, please'), { status: 400 });
  }
  const method = ['cash', 'bank', 'card'].includes(p.method) ? p.method : 'cash';
  const on = String(p.on || iso(new Date()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) {
    throw Object.assign(new Error('a date, YYYY-MM-DD'), { status: 400 });
  }

  const owed = await balance(c, p.memberId);
  if (owed <= 0) {
    throw Object.assign(new Error('there is nothing owing on that account'), { status: 409 });
  }
  if (amount > owed) {
    /* Refused rather than credited: money taken beyond a debt is a deposit, and
       a receivable account that goes negative is a liability wearing an asset's
       code. Whatever this is, it is not this. */
    throw Object.assign(new Error(
      'that is more than the ' + toMVR(owed) + ' owed — take the difference as a'
      + ' separate payment rather than turning the account negative'), { status: 409 });
  }

  const no = await c.query('SELECT chain.next_doc_no($1) AS no', ['RCT']);
  const docNo = no.rows[0].no;

  await postJournal(c, {
    date: on, memo: 'Account payment — ' + docNo,
    source: 'house', sourceId: p.memberId,
    lines: [
      { account: method === 'cash' ? '1000' : method === 'card' ? '1020' : '1010',
        dr: amount, cr: 0 },
      { account: '1030', dr: 0, cr: amount },
    ],
  }, ctx);

  await c.query(
    'INSERT INTO house_entry (on_date, member_id, kind, amount, doc_no, method,'
    + " note, by_staff) VALUES ($1::date,$2,'receipt',$3,$4,$5,$6,$7)",
    [on, p.memberId, toMVR(-amount), docNo, method,
      p.note ? String(p.note).slice(0, 200) : null, ctx.actor]);

  await c.query("SELECT chain.log('house_receipt','member',$1,NULL,$2)",
    [p.memberId, JSON.stringify({ docNo, amount: toMVR(amount), method })]);

  const left = owed - amount;
  return {
    docNo, amount: money(amount / 100), method, on,
    owed: money(left / 100),
    message: left === 0 ? 'Settled in full.' : toMVR(left) + ' still outstanding.',
  };
}

/**
 * Giving up on a debt. Dr 6400 Bad debt, Cr 1030 — an expense, taken
 * deliberately, on a date, by somebody named. Admin only.
 */
async function writeOff(c, p, ctx) {
  const owed = await balance(c, p.memberId);
  if (owed <= 0) {
    throw Object.assign(new Error('there is nothing owing on that account'), { status: 409 });
  }
  const amount = p.amount ? toLaari(p.amount) : owed;
  if (amount <= 0 || amount > owed) {
    throw Object.assign(new Error('write off up to the ' + toMVR(owed) + ' owed'),
      { status: 400 });
  }
  const on = String(p.on || iso(new Date()));
  const why = p.reason ? String(p.reason).slice(0, 200) : '';
  if (why.length < 3) {
    /* A write-off with no reason is indistinguishable from a mistake, and it is
       the one entry here that makes money disappear. */
    throw Object.assign(new Error('say why it is being written off'), { status: 400 });
  }

  await postJournal(c, {
    date: on, memo: 'Bad debt — ' + why,
    source: 'house', sourceId: p.memberId,
    lines: [
      { account: '6400', dr: amount, cr: 0 },
      { account: '1030', dr: 0, cr: amount },
    ],
  }, ctx);
  await c.query(
    'INSERT INTO house_entry (on_date, member_id, kind, amount, note, by_staff)'
    + " VALUES ($1::date,$2,'writeoff',$3,$4,$5)",
    [on, p.memberId, toMVR(-amount), why, ctx.actor]);
  await c.query("SELECT chain.log('house_writeoff','member',$1,NULL,$2)",
    [p.memberId, JSON.stringify({ amount: toMVR(amount), why })]);

  return { amount: money(amount / 100), owed: money((owed - amount) / 100), reason: why };
}

/* ── the statement ───────────────────────────────────────────────────────── */

/**
 * One customer's account: every entry, and what is outstanding by age.
 *
 * The ageing allocates receipts against the OLDEST charges first. Ageing the
 * net balance instead would show a customer who pays every month as further
 * and further overdue for ever — their oldest invoice is always old, even
 * though it was paid — and a statement like that puts a good customer on stop.
 */
async function statement(c, memberId) {
  const m = await c.query('SELECT * FROM chain.member WHERE id = $1', [memberId]);
  if (!m.rows.length) throw Object.assign(new Error('no such customer'), { status: 404 });

  const q = await c.query(
    'SELECT h.*, s.receipt_no, st.name AS by_name FROM house_entry h'
    + ' LEFT JOIN sale s ON s.id = h.sale_id'
    + ' LEFT JOIN chain.staff st ON st.id = h.by_staff'
    + ' ORDER BY h.on_date, h.id');
  const mine = q.rows.filter((r) => r.member_id === memberId);

  const entries = mine.map((r) => ({
    id: Number(r.id), on: r.on_date, kind: r.kind,
    amount: money(r.amount), docNo: r.doc_no || r.receipt_no || null,
    method: r.method, note: r.note, by: r.by_name || null,
  }));

  /* Allocation. Charges in date order; every credit (receipt or write-off)
     knocks out the oldest open charge first. */
  const open = [];
  for (const r of mine) {
    const amountL = toLaari(r.amount);
    if (amountL > 0) { open.push({ on: r.on_date, left: amountL }); continue; }
    let credit = -amountL;
    for (const ch of open) {
      if (credit <= 0) break;
      const take = Math.min(ch.left, credit);
      ch.left -= take; credit -= take;
    }
  }

  const terms = Number(m.rows[0].terms_days || 0);
  const today = new Date(iso(new Date()) + 'T00:00:00Z');
  const buckets = { notYetDue: 0, upTo30: 0, upTo60: 0, over60: 0 };
  for (const ch of open) {
    if (ch.left <= 0) continue;
    const due = new Date(new Date(ch.on).getTime() + terms * 86400000);
    const late = Math.floor((today - due) / 86400000);
    if (late <= 0) buckets.notYetDue += ch.left;
    else if (late <= 30) buckets.upTo30 += ch.left;
    else if (late <= 60) buckets.upTo60 += ch.left;
    else buckets.over60 += ch.left;
  }

  const owed = open.reduce((s, ch) => s + Math.max(0, ch.left), 0);
  return {
    customer: shape({ ...m.rows[0], owed: owed / 100 }),
    entries,
    ageing: {
      notYetDue: money(buckets.notYetDue / 100),
      upTo30: money(buckets.upTo30 / 100),
      upTo60: money(buckets.upTo60 / 100),
      over60: money(buckets.over60 / 100),
      termsDays: terms,
    },
    owed: money(owed / 100),
  };
}

/**
 * What the whole book looks like, aged — the figure an owner chases. Built from
 * the same allocation as one statement, so the two can never disagree.
 */
async function ageing(c) {
  const who = await c.query(
    'SELECT DISTINCT member_id FROM house_entry');
  const rows = [];
  const total = { notYetDue: 0, upTo30: 0, upTo60: 0, over60: 0, owed: 0 };
  for (const r of who.rows) {
    const s = await statement(c, r.member_id);
    if (s.owed <= 0) continue;
    rows.push({
      id: s.customer.id, name: s.customer.name || s.customer.phone,
      company: s.customer.company, owed: s.owed, ...s.ageing,
      creditLimit: s.customer.creditLimit, overLimit: s.customer.overLimit,
    });
    for (const k of ['notYetDue', 'upTo30', 'upTo60', 'over60']) total[k] += s.ageing[k];
    total.owed += s.owed;
  }
  rows.sort((a, b) => b.over60 - a.over60 || b.owed - a.owed);
  for (const k of Object.keys(total)) total[k] = money(total[k]);
  return { rows, total };
}


module.exports = {
  list, save, setCredit, balance, checkCredit, charge, receipt, writeOff,
  statement, ageing,
};
