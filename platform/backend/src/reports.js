'use strict';
/* Reports & Exports — 02-POS-SPEC.md §2 (`reports`): "Z-read, tax return, P&L,
 * trial balance, MIRA exports."
 *
 * 08-BUILD-STAGES.md §22 sets the acceptance criterion this whole file is built
 * to satisfy:
 *
 *   "A full month closes: P&L, trial balance and tax return agree with each
 *    other and with the sum of the day's Z-reads."
 *   "Prime cost and net margin are computed from posted journals, not from a
 *    parallel calculation."
 *
 * They can only agree if they are the same arithmetic over the same rows. So
 * every figure below comes from `journal_line`, through one function —
 * `balances()`. Nothing here sums the `sale` table to produce a revenue figure.
 *
 * Where a figure is CROSS-CHECKED against the operational tables — the tax
 * return against the tax recorded on each sale, the Z-read against the tender —
 * the check is reported, not silently reconciled. Two numbers that should agree
 * and do not is a finding. Averaging them, or preferring the prettier one, is
 * how a discrepancy survives to the audit.
 *
 * SIGN CONVENTION. Each account has a normal side. An asset or expense balance
 * is dr − cr; a liability, equity or income balance is cr − dr. That is what
 * makes `4090 Discounts given` — an INCOME account whose normal side is dr —
 * come out negative and reduce revenue, instead of being mistaken for a cost.
 */

const accounts = require('./accounts');

const mvr = (n) => Math.round(Number(n) * 100) / 100;

/* ── the one query everything else is built from ─────────────────────────── */

/**
 * Balances per account over a date range, from the posted ledger.
 * `from`/`to` are business dates on the journal (inclusive); omit both for
 * everything ever posted, which is what a balance-sheet trial balance wants.
 */
async function balances(c, from, to) {
  /* The date filter belongs to the SUBQUERY, not to the outer join.
     Written as `LEFT JOIN journal_line l ON … LEFT JOIN journal j ON j.id =
     l.journal_id AND j.entry_date >= $1`, every line still joins — only `j`
     goes NULL — so a P&L for January 2019 came back with the whole ledger in
     it. The range has to remove the LINE, which means resolving it before the
     accounts are joined at all. */
  const q = await c.query(
    'SELECT a.code, a.name, a.type, a.normal_side,'
    + ' coalesce(sum(l.dr),0) AS dr, coalesce(sum(l.cr),0) AS cr'
    + ' FROM account a'
    + ' LEFT JOIN ('
    + '   SELECT l.account_code, l.dr, l.cr'
    + '   FROM journal_line l JOIN journal j ON j.id = l.journal_id'
    + '   WHERE ($1::date IS NULL OR j.entry_date >= $1::date)'
    + '     AND ($2::date IS NULL OR j.entry_date <= $2::date)'
    + ' ) l ON l.account_code = a.code'
    + ' GROUP BY a.code, a.name, a.type, a.normal_side'
    + ' ORDER BY a.code', [from || null, to || null]);

  return q.rows.map((r) => {
    const dr = mvr(r.dr), cr = mvr(r.cr);
    return {
      code: r.code, name: r.name, type: r.type, normalSide: r.normal_side,
      dr, cr,
      // Signed the way the account's own side reads: positive means "as
      // expected", negative means the account is the wrong way round.
      balance: mvr(r.normal_side === 'dr' ? dr - cr : cr - dr),
      movement: mvr(dr - cr),
    };
  });
}

/* ── trial balance ───────────────────────────────────────────────────────── */

/* 09-TEST-PLAN.md §2 and 05-DATA-MODEL.md §107: "sum(dr) − sum(cr) = 0 across
   the whole outlet ledger". Shown as a figure rather than a tick, because a
   green tick is what a broken check also looks like. */
async function trialBalance(c, from, to) {
  const rows = await balances(c, from, to);
  const used = rows.filter((r) => r.dr !== 0 || r.cr !== 0);
  const dr = mvr(used.reduce((a, r) => a + r.dr, 0));
  const cr = mvr(used.reduce((a, r) => a + r.cr, 0));
  return {
    from: from || null, to: to || null,
    accounts: used,
    totals: { dr, cr, difference: mvr(dr - cr) },
    balanced: mvr(dr - cr) === 0,
  };
}

/* ── profit and loss ─────────────────────────────────────────────────────── */

/* What counts as cost of sales, and what counts as labour, is `accounts.js` —
   one list, shared with the CFO screen and the estate, because prime cost
   reading 31% on one and 34% on the other is not a discrepancy anybody can
   resolve from the screen they are looking at. */
async function profitAndLoss(c, from, to) {
  const rows = await balances(c, from, to);
  const pick = (t) => rows.filter((r) => r.type === t && (r.dr !== 0 || r.cr !== 0));

  const income = pick('income');
  const expenses = pick('expense');
  const cogsRows = expenses.filter((r) => accounts.isCostOfSales(r.code));
  const opexRows = expenses.filter((r) => !accounts.isCostOfSales(r.code));

  const revenue = mvr(income.reduce((a, r) => a + r.balance, 0));   // 4090 is dr-normal → negative
  const cogs = mvr(cogsRows.reduce((a, r) => a + r.balance, 0));
  const opex = mvr(opexRows.reduce((a, r) => a + r.balance, 0));
  const gross = mvr(revenue - cogs);

  return {
    from: from || null, to: to || null,
    revenue: { lines: income, total: revenue },
    costOfSales: { lines: cogsRows, total: cogs },
    grossProfit: gross,
    grossMarginPct: revenue ? mvr((gross / revenue) * 100) : null,
    operatingCosts: { lines: opexRows, total: opex },
    netProfit: mvr(gross - opex),
    // §22's "prime cost" — cost of sales plus labour, the figure a restaurant
    // actually runs on. Zero until payroll exists, and shown as zero rather
    // than hidden, so nobody reads prime cost as complete.
    primeCost: mvr(cogs + accounts.sumWhere(expenses, accounts.isLabour)),
    labourPosted: expenses.some((r) => accounts.isLabour(r.code) && r.dr !== 0),
  };
}

/* ── the tax return ──────────────────────────────────────────────────────── */

/**
 * GST output for a period, from the ledger — and cross-checked against the tax
 * recorded on each sale row, which is the figure the receipts carry and the one
 * MIRA would see in an inspection. If those two disagree, the return is wrong
 * whichever way round it is, and the difference is reported.
 */
async function taxReturn(c, from, to) {
  const ledger = await c.query(
    'SELECT coalesce(sum(l.cr - l.dr), 0) AS output'
    + ' FROM journal_line l JOIN journal j ON j.id = l.journal_id'
    + " WHERE l.account_code = '2100'"
    + ' AND ($1::date IS NULL OR j.entry_date >= $1::date)'
    + ' AND ($2::date IS NULL OR j.entry_date <= $2::date)', [from || null, to || null]);

  /* Per rate and code, because a period can span a rate change and a return is
     filed per rate. `tax_rate` is stamped on the sale, so a rate change does
     not restate a filed month. */
  const bands = await c.query(
    'SELECT tax_code, tax_rate, count(*)::int AS sales,'
    + ' coalesce(sum(gross - discount + service),0) AS taxable,'
    + ' coalesce(sum(tax),0) AS tax'
    + ' FROM sale WHERE voided_at IS NULL'
    + ' AND ($1::date IS NULL OR business_date >= $1::date)'
    + ' AND ($2::date IS NULL OR business_date <= $2::date)'
    + ' GROUP BY tax_code, tax_rate ORDER BY tax_code, tax_rate',
    [from || null, to || null]);

  /* CREDIT NOTES COME OFF THE RETURN. A note approved against a sale gives the
     guest their tax back and debits 2100, so the ledger figure already reflects
     it — and the sales figure would not, which would make the two disagree by
     exactly the month's refunds and look like a reconciliation failure. Worse,
     a return filed from the sales side alone would declare tax on money that
     was handed back.

     Only APPROVED notes count: a pending one has posted nothing and is not yet
     a document. They are grouped by the SALE's rate, so a refund of a sale made
     before a rate change is credited at the rate it was charged at. */
  const credits = await c.query(
    'SELECT s.tax_code, s.tax_rate, count(*)::int AS notes,'
    + ' coalesce(sum(cn.goods + cn.service),0) AS taxable,'
    + ' coalesce(sum(cn.tax),0) AS tax'
    + ' FROM credit_note cn JOIN sale s ON s.id = cn.sale_id'
    + ' WHERE cn.approved_at IS NOT NULL'
    + ' AND ($1::date IS NULL OR cn.business_date >= $1::date)'
    + ' AND ($2::date IS NULL OR cn.business_date <= $2::date)'
    + ' GROUP BY s.tax_code, s.tax_rate', [from || null, to || null]);

  const creditFor = new Map(credits.rows.map(
    (r) => [r.tax_code + '|' + Number(r.tax_rate), r]));

  const bandRows = bands.rows.map((r) => {
    const cr = creditFor.get(r.tax_code + '|' + Number(r.tax_rate));
    creditFor.delete(r.tax_code + '|' + Number(r.tax_rate));
    return {
      code: r.tax_code, rate: Number(r.tax_rate), sales: r.sales,
      // Taxable value NET of tax — the base the rate was applied to. Menu
      // prices are tax-INCLUSIVE, so this is not the money taken; it is the
      // money taken less the government's share.
      taxableValue: mvr(Number(r.taxable) - Number(cr ? cr.taxable : 0)),
      tax: mvr(Number(r.tax) - Number(cr ? cr.tax : 0)),
      /* Stated separately as well as netted, because "we sold 400,000 and gave
         back 6,000" is the sentence, and a single net figure hides the second
         half of it. */
      credited: mvr(cr ? cr.tax : 0),
      creditNotes: cr ? cr.notes : 0,
    };
  });
  /* A credit note against a sale from an EARLIER period has no band of its own
     this month; it still reduces what is owed, so it gets a row. */
  for (const cr of creditFor.values()) {
    bandRows.push({
      code: cr.tax_code, rate: Number(cr.tax_rate), sales: 0,
      taxableValue: mvr(-Number(cr.taxable)), tax: mvr(-Number(cr.tax)),
      credited: mvr(cr.tax), creditNotes: cr.notes,
    });
  }

  const fromSales = mvr(bandRows.reduce((a, r) => a + r.tax, 0));
  const fromLedger = mvr(ledger.rows[0].output);

  return {
    from: from || null, to: to || null,
    bands: bandRows,
    outputTax: fromLedger,
    checkedAgainstSales: fromSales,
    difference: mvr(fromLedger - fromSales),
    agrees: mvr(fromLedger - fromSales) === 0,
  };
}

/* ── the Z-read ──────────────────────────────────────────────────────────── */

/**
 * The end of a trading day: what was sold, how it was tendered, what the drawer
 * counted, and whether the ledger agrees with all of it.
 *
 * Three independent statements of the same day, printed side by side:
 *   · the sales — what the tickets say was billed
 *   · the tender — what the payments say was taken
 *   · the ledger — what the journals say was posted
 * A Z-read whose three columns agree is worth signing. One that only shows the
 * first is a receipt for the manager's own arithmetic.
 */
async function zRead(c, date, drawer) {
  const [sales, tender, journals, ledgerRevenue] = await Promise.all([
    c.query(
      'SELECT count(*)::int AS tickets, coalesce(sum(covers),0)::int AS covers,'
      + ' coalesce(sum(gross),0) AS gross, coalesce(sum(discount),0) AS discount,'
      + ' coalesce(sum(service),0) AS service, coalesce(sum(tax),0) AS tax,'
      + ' coalesce(sum(rounding),0) AS rounding, coalesce(sum(total),0) AS total,'
      + ' coalesce(sum(cogs),0) AS cogs,'
      + ' count(*) FILTER (WHERE voided_at IS NOT NULL)::int AS voided'
      + ' FROM sale WHERE business_date = $1::date', [date]),
    c.query(
      'SELECT p.method, count(*)::int AS n, coalesce(sum(p.amount),0) AS amount,'
      + ' coalesce(sum(p.tip),0) AS tip'
      + ' FROM payment p JOIN sale s ON s.id = p.sale_id'
      + ' WHERE s.business_date = $1::date GROUP BY p.method ORDER BY p.method', [date]),
    c.query(
      'SELECT j.source, count(DISTINCT j.id)::int AS n'
      + ' FROM journal j WHERE j.entry_date = $1::date GROUP BY j.source ORDER BY j.source',
      [date]),
    c.query(
      'SELECT coalesce(sum(l.cr - l.dr), 0) AS revenue'
      + ' FROM journal_line l JOIN journal j ON j.id = l.journal_id'
      + ' JOIN account a ON a.code = l.account_code'
      + " WHERE a.type = 'income' AND j.entry_date = $1::date", [date]),
  ]);

  const s = sales.rows[0];
  const takings = mvr(tender.rows.reduce((a, r) => a + Number(r.amount), 0));
  const billed = mvr(s.total);
  const revenuePosted = mvr(ledgerRevenue.rows[0].revenue);
  // The sale's own goods figure, net of tax and after the bill discount — which
  // is what the income accounts hold once 4090 has taken the discount back out.
  const revenueBilled = mvr(Number(s.gross) - Number(s.discount));

  const sessions = drawer || [];
  const counted = sessions.filter((x) => x.counted !== null);

  return {
    date,
    sales: {
      tickets: s.tickets, covers: s.covers, voided: s.voided,
      gross: mvr(s.gross), discount: mvr(s.discount), service: mvr(s.service),
      tax: mvr(s.tax), rounding: mvr(s.rounding), total: billed, cogs: mvr(s.cogs),
      average: s.tickets ? mvr(Number(s.total) / s.tickets) : 0,
    },
    tender: tender.rows.map((r) => ({
      method: r.method, count: r.n, amount: mvr(r.amount), tip: mvr(r.tip),
    })),
    drawer: {
      sessions,
      float: mvr(sessions.reduce((a, x) => a + (x.float || 0), 0)),
      expected: mvr(counted.reduce((a, x) => a + (x.expected || 0), 0)),
      counted: mvr(counted.reduce((a, x) => a + (x.counted || 0), 0)),
      variance: mvr(counted.reduce((a, x) => a + (x.variance || 0), 0)),
      unclosed: sessions.filter((x) => x.stillOpen).length,
    },
    journals: journals.rows.map((r) => ({ source: r.source, count: r.n })),
    /* The three checks that make the sheet worth signing. Each is a plain
       difference, so a reader can see BY HOW MUCH rather than only that
       something is wrong. */
    checks: [
      {
        name: 'What was taken equals what was billed',
        a: takings, b: billed, difference: mvr(takings - billed), ok: takings === billed,
      },
      {
        name: 'Revenue posted to the ledger equals the goods sold',
        a: revenuePosted, b: revenueBilled,
        difference: mvr(revenuePosted - revenueBilled),
        ok: mvr(revenuePosted - revenueBilled) === 0,
      },
      {
        name: 'Every register opened today was counted and closed',
        a: sessions.length, b: counted.length,
        difference: sessions.length - counted.length,
        ok: sessions.length === counted.length,
      },
    ],
  };
}

module.exports = { balances, trialBalance, profitAndLoss, taxReturn, zRead };
