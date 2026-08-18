'use strict';
/* Accounting Flow — 02-POS-SPEC.md §2 (`accounting`): "The ledger itself:
 * journals, trial balance, P&L." 08-BUILD-STAGES §22.
 *
 * WHAT THIS IS NOT is a second trial balance, a second P&L or a second tax
 * return. `reports.js` has all three, computed from journal lines, and the
 * accounting screen reads them from there. Writing them again here is exactly
 * how this build came to charge a GST-exclusive price at the counter for months
 * while the guest's phone quoted the inclusive one, with a green suite the
 * whole time: two copies of an arithmetic agree until the day they do not, and
 * nothing is watching the seam. §2 lists trial balance and P&L under this
 * module because an operator wants them on this screen — that is a question of
 * which URL the screen calls, not of who owns the sum.
 *
 * WHAT IS ACTUALLY MISSING is the ledger as a ledger. Every module posts:
 * sales, payroll, depreciation, prepaid releases, stock variance, house
 * accounts, loyalty. Nothing has ever LISTED an entry. A book you cannot open
 * is a book nobody checks, and the deferred balance trigger does not help —
 * it proves each entry balances, and a set of individually balanced entries can
 * still describe a business that does not exist.
 *
 * AND THE TWO WRITES NOBODY ELSE OWNS:
 *
 * The opening position. A restaurant that existed before this system has real
 * balances on its first day; 10-NO-DEMO-DATA says to capture them "as a dated
 * opening journal, so the trial balance is right from day one and the first
 * month's P&L is not nonsense." Without a manual entry there is no way in, and
 * the alternative — seeding something plausible — is the thing that document
 * forbids.
 *
 * The correction. A mistake is answered by an equal and opposite entry that
 * names it, never by editing or deleting: there is no UPDATE or DELETE grant on
 * a journal anywhere in this system. `journal.reversed_by` has been in the
 * schema since the first migration with nothing to write it.
 */

const { post: postJournal } = require('./journal');

const money = (n) => Math.round(Number(n) * 100) / 100;
const toLaari = (mvr) => Math.round(Number(mvr) * 100);
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);

/* A range is a pair of business dates, inclusive at both ends, and both are
   required for an EXPORT. A file leaves the building; one whose period was
   silently defaulted is read as the month somebody meant rather than the month
   it covers. */
function range(q) {
  const from = String((q && q.from) || '').slice(0, 10);
  const to = String((q && q.to) || '').slice(0, 10);
  if (!isDate(from) || !isDate(to)) {
    throw Object.assign(new Error('a period needs a from and a to date (YYYY-MM-DD)'),
      { status: 400 });
  }
  if (from > to) {
    throw Object.assign(new Error('the period ends before it starts'), { status: 400 });
  }
  return { from, to };
}

/* ── the ledger, opened ──────────────────────────────────────────────────── */

/**
 * Journals, most recent first, each with its lines.
 *
 * Paged on posted_at rather than an offset: entries arrive while somebody is
 * reading, and an offset silently repeats or skips a row when they do. The
 * cursor is the last row on screen, so "older" means older than what is
 * actually there.
 */
async function journals(c, q) {
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
  const before = q.before ? String(q.before) : null;
  const source = q.source ? String(q.source).slice(0, 30) : null;
  const text = q.q ? String(q.q).trim().slice(0, 60) : null;
  const from = isDate(String(q.from || '')) ? String(q.from) : null;
  const to = isDate(String(q.to || '')) ? String(q.to) : null;

  const rows = await c.query(
    'SELECT j.id, j.jv_no, j.entry_date, j.memo, j.source, j.source_id,'
    + ' j.posted_at, j.reversed_by, r.jv_no AS reversed_by_no, s.name AS by_name'
    + ' FROM journal j'
    + ' LEFT JOIN journal r ON r.id = j.reversed_by'
    + ' LEFT JOIN chain.staff s ON s.id = j.posted_by'
    + ' WHERE ($1::timestamptz IS NULL OR j.posted_at < $1)'
    + '   AND ($2::text IS NULL OR j.source = $2)'
    + "   AND ($3::text IS NULL OR j.memo ILIKE '%' || $3 || '%'"
    + "        OR j.jv_no ILIKE '%' || $3 || '%')"
    + ' AND ($4::date IS NULL OR j.entry_date >= $4::date)'
    + ' AND ($5::date IS NULL OR j.entry_date <= $5::date)'
    + ' ORDER BY j.posted_at DESC LIMIT $6',
    [before, source, text, from, to, limit]);

  const ids = rows.rows.map((r) => r.id);
  const lines = ids.length ? await c.query(
    'SELECT l.journal_id, l.account_code, a.name, l.dr, l.cr'
    + ' FROM journal_line l JOIN account a ON a.code = l.account_code'
    + ' WHERE l.journal_id = ANY($1) ORDER BY l.id', [ids]) : { rows: [] };

  const byJournal = new Map();
  for (const l of lines.rows) {
    const at = byJournal.get(l.journal_id) || [];
    at.push({ account: l.account_code, name: l.name, dr: money(l.dr), cr: money(l.cr) });
    byJournal.set(l.journal_id, at);
  }

  return {
    journals: rows.rows.map((r) => {
      const ls = byJournal.get(r.id) || [];
      return {
        id: r.id, no: r.jv_no, date: day(r.entry_date), memo: r.memo,
        source: r.source, sourceId: r.source_id, at: r.posted_at,
        by: r.by_name || null,
        reversedBy: r.reversed_by, reversedByNo: r.reversed_by_no || null,
        /* The size of the entry is one side of it, not both added together —
           an entry of 100 is 100, not 200. */
        amount: money(ls.reduce((a, l) => a + l.dr, 0)),
        lines: ls,
      };
    }),
    next: rows.rows.length === limit ? rows.rows[rows.rows.length - 1].posted_at : null,
  };
}

/** What a filter can offer, drawn from what has actually been posted. */
async function sources(c) {
  const r = await c.query('SELECT source, count(*)::int AS n FROM journal'
    + ' GROUP BY source ORDER BY n DESC');
  return r.rows.map((x) => ({ source: x.source, entries: x.n }));
}

/* ── a journal somebody typed ────────────────────────────────────────────── */

/**
 * A manual journal voucher: the opening position, and any correction that is
 * nobody else's module to make.
 *
 * It is the one place a person writes straight into the books, so the refusals
 * matter more than the write. Each one names what is wrong in a sentence,
 * because the alternative is a constraint violation quoting a foreign key an
 * operator has never heard of.
 */
async function manual(c, p, ctx) {
  const memo = String(p.memo || '').trim().slice(0, 200);
  if (memo.length < 4) {
    throw Object.assign(new Error('say what this entry is for — it is what somebody'
      + ' reads in the ledger a year from now'), { status: 400 });
  }
  const date = String(p.date || '').slice(0, 10);
  if (!isDate(date)) {
    throw Object.assign(new Error('an entry needs a date'), { status: 400 });
  }
  const raw = Array.isArray(p.lines) ? p.lines : [];
  if (raw.length < 2) {
    throw Object.assign(new Error('an entry has at least two sides'), { status: 400 });
  }

  let dr = 0, cr = 0;
  const lines = [];
  for (const l of raw) {
    const account = String(l.account || '').trim();
    const d = toLaari(l.dr || 0);
    const k = toLaari(l.cr || 0);
    if (d < 0 || k < 0) {
      throw Object.assign(new Error('a negative on one side is a positive on the other'
        + ' — put it there'), { status: 400 });
    }
    if ((d > 0) === (k > 0)) {
      throw Object.assign(new Error('every line is a debit or a credit, not both and'
        + ' not neither'), { status: 400 });
    }
    const known = await c.query('SELECT 1 FROM account WHERE code = $1', [account]);
    if (!known.rows.length) {
      throw Object.assign(new Error('no account ' + account + ' in the chart'),
        { status: 400 });
    }
    dr += d; cr += k;
    lines.push({ account, dr: d, cr: k });
  }
  if (dr !== cr) {
    /* The deferred trigger would refuse this at COMMIT with "journal does not
       balance" and no figures. Out-by is the number that lets somebody find the
       line they mistyped. */
    throw Object.assign(new Error('this does not balance: debits ' + (dr / 100).toFixed(2)
      + ', credits ' + (cr / 100).toFixed(2) + ' — out by '
      + (Math.abs(dr - cr) / 100).toFixed(2)), { status: 400 });
  }

  const jv = await postJournal(c, { date, memo, source: 'manual', sourceId: null, lines }, ctx);
  await c.query("SELECT chain.log('journal_manual','journal',$1,NULL,$2)",
    [jv.id, JSON.stringify({ memo, date, amount: money(dr / 100) })]);
  return { id: jv.id, no: jv.no, amount: money(dr / 100) };
}

/**
 * Reverse an entry: a NEW journal with the sides swapped, and the original
 * marked with the id of the one that undid it. Both stay in the ledger, which
 * is the difference between a ledger and a spreadsheet.
 */
async function reverse(c, id, p, ctx) {
  const j = await c.query('SELECT * FROM journal WHERE id = $1 FOR UPDATE', [id]);
  if (!j.rows.length) throw Object.assign(new Error('no such entry'), { status: 404 });
  const o = j.rows[0];
  if (o.reversed_by) {
    throw Object.assign(new Error('that entry has already been reversed'), { status: 409 });
  }
  if (o.source === 'reversal') {
    /* Reversing a reversal is a re-posting wearing a disguise, and it reads in
       the ledger as two entries that cancel while the original stands. If the
       reversal was itself the mistake, post the entry again and say so. */
    throw Object.assign(new Error('that entry is itself a reversal — post the'
      + ' original again rather than reversing the undo'), { status: 409 });
  }
  const why = String(p.reason || '').trim().slice(0, 160);
  if (why.length < 4) {
    throw Object.assign(new Error('say why it is being reversed'), { status: 400 });
  }
  const ls = await c.query(
    'SELECT account_code, dr, cr FROM journal_line WHERE journal_id = $1 ORDER BY id', [id]);

  const back = await postJournal(c, {
    /* Dated today by default, not back on the original's date: reversing a
       March entry in April is an April event, and a filed month must not move
       under a return already submitted. An explicit date is honoured for the
       case where the correction really does belong in the open period. */
    date: isDate(String(p.date || '')) ? String(p.date) : day(new Date()),
    memo: 'Reversal of ' + o.jv_no + ' — ' + why,
    source: 'reversal', sourceId: o.id,
    lines: ls.rows.map((l) => ({
      account: l.account_code, dr: toLaari(l.cr), cr: toLaari(l.dr),
    })),
  }, ctx);

  await c.query('UPDATE journal SET reversed_by = $2 WHERE id = $1', [id, back.id]);
  await c.query("SELECT chain.log('journal_reverse','journal',$1,NULL,$2)",
    [id, JSON.stringify({ reversal: back.id, reason: why })]);
  return {
    id: back.id, no: back.no, of: o.jv_no,
    message: 'Reversed by ' + back.no + '. Both entries stay in the ledger.',
  };
}

/* ── what leaves the building ────────────────────────────────────────────── */

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  /* A leading =, +, - or @ is a formula to a spreadsheet, and a memo somebody
     typed is not a formula — that is how a CSV export becomes a way to run
     something on an accountant's machine. */
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
  return /[",\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
};
const csv = (head, rows) =>
  [head.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';

/**
 * The MIRA export. One row per POSTING, not per journal: a return is checked
 * line by line against the accounts, and every row names the document it came
 * from, because the first question asked of any line is "what is this".
 */
async function exportCsv(c, q, reports) {
  const kind = String(q.kind || 'journal');

  if (kind === 'journal') {
    const { from, to } = range(q);
    const r = await c.query(
      'SELECT j.jv_no, j.entry_date, j.memo, j.source, l.account_code, a.name,'
      + ' l.dr, l.cr, s.name AS by_name'
      + ' FROM journal j JOIN journal_line l ON l.journal_id = j.id'
      + ' JOIN account a ON a.code = l.account_code'
      + ' LEFT JOIN chain.staff s ON s.id = j.posted_by'
      + ' WHERE j.entry_date BETWEEN $1 AND $2'
      + ' ORDER BY j.entry_date, j.jv_no, l.id', [from, to]);
    return {
      filename: 'journal-' + from + '-to-' + to + '.csv',
      rows: r.rows.length,
      body: csv(['Voucher', 'Date', 'Account', 'Account name', 'Debit', 'Credit',
        'Memo', 'Source', 'Posted by'],
      r.rows.map((x) => [x.jv_no, day(x.entry_date), x.account_code, x.name,
        money(x.dr).toFixed(2), money(x.cr).toFixed(2), x.memo, x.source,
        x.by_name || ''])),
    };
  }

  if (kind === 'tax') {
    const { from, to } = range(q);
    /* Voided sales excluded, the same rule the return itself uses. A void that
       appears in the supporting schedule but not in the return is the first
       thing an inspection finds. */
    const r = await c.query(
      'SELECT receipt_no, business_date, tax_code, tax_rate, gross, discount, service,'
      + ' tax, total FROM sale WHERE voided_at IS NULL'
      + ' AND business_date BETWEEN $1 AND $2'
      + ' ORDER BY business_date, receipt_no', [from, to]);
    return {
      filename: 'tax-' + from + '-to-' + to + '.csv',
      rows: r.rows.length,
      body: csv(['Receipt', 'Date', 'Tax code', 'Rate', 'Goods', 'Discount', 'Service',
        'Taxable value', 'Tax', 'Total'],
      r.rows.map((x) => [x.receipt_no, day(x.business_date), x.tax_code, x.tax_rate,
        money(x.gross).toFixed(2), money(x.discount).toFixed(2),
        money(x.service).toFixed(2),
        money(Number(x.gross) - Number(x.discount) + Number(x.service)).toFixed(2),
        money(x.tax).toFixed(2), money(x.total).toFixed(2)])),
    };
  }

  if (kind === 'trial') {
    /* Delegated, so the exported trial balance is the same arithmetic as the
       one on screen rather than a second opinion about it. */
    const { from, to } = range(q);
    const t = await reports.trialBalance(c, from, to);
    return {
      filename: 'trial-balance-' + from + '-to-' + to + '.csv',
      rows: t.accounts.length,
      body: csv(['Account', 'Name', 'Type', 'Debit', 'Credit', 'Balance'],
        t.accounts.map((a) => [a.code, a.name, a.type,
          a.dr.toFixed(2), a.cr.toFixed(2), a.balance.toFixed(2)])
          .concat([['', 'TOTAL', '', t.totals.dr.toFixed(2), t.totals.cr.toFixed(2),
            t.totals.difference.toFixed(2)]])),
    };
  }

  throw Object.assign(new Error('nothing exports as ' + kind), { status: 400 });
}

module.exports = { journals, sources, manual, reverse, exportCsv };
