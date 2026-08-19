'use strict';
/* What the chart's codes MEAN, in one place.
 *
 * The chart itself is seeded once (migrations/004) and that was already the
 * lesson of one bad afternoon: five migrations restated the whole list, only
 * the last one ran, and a code added to any of the other four simply did not
 * exist. This file is the same lesson one layer up. A code list is not a chart
 * — it is a JUDGEMENT about the chart, and the judgements were scattered:
 *
 *   - `COST_OF_SALES` was declared in reports.js and again in analytics.js,
 *     with a comment in the second one promising it matched the first.
 *   - Labour was a Set in analytics.js and an inline `code === '6000' ||
 *     code === '6010'` in reports.js, twice, in the same function.
 *   - The estate view about to be built needs all of them again.
 *
 * A promise in a comment is not a mechanism. Three copies is how prime cost
 * comes out at 31% on the CFO screen and 34% on the P&L for the same week, and
 * the person reading them has no way to tell which is lying. So: one list, one
 * import, and `backend/test/deployable.test.js` fails if a module starts
 * declaring its own again.
 *
 * Everything here is a CODE, never an account name. Names are display text and
 * an outlet may localise them; the code is the identity.
 */

/* Cost of sales is food, beverage and the stock variance that wastage and
   counts post. Wastage IS a cost of sale: excluding it flatters gross profit by
   exactly the amount somebody threw away, which is the number a kitchen most
   needs to see. */
const COST_OF_SALES = Object.freeze(['5000', '5010', '5100']);

/* Wages and staff benefits. Payroll may never have been run, in which case this
   is zero — and zero is shown rather than hidden, so nobody reads a prime cost
   with no labour in it as a complete one. */
const LABOUR = Object.freeze(['6000', '6010']);

/* A variance trend is made of stock that went missing and a drawer that
   miscounted. Each is a loss nobody decided on, which is what makes a trend in
   them worth watching. */
const VARIANCE = Object.freeze(['5100', '6920']);

/**
 * The money position: what the business is holding, and how much of it is
 * somebody else's.
 *
 * The last four are NOT the business's money. GST is collected for MIRA,
 * service charge and tips are owed to the people who earned them, and the
 * supplier balance is an invoice waiting. A cash figure that adds them in reads
 * healthy on the morning the payroll run empties it, so they are named
 * separately here and labelled as held-for-someone-else on the screen.
 */
const POSITION = Object.freeze({
  cashInDrawer: '1000',
  bank: '1010',
  cardAwaitingSettlement: '1020',
  houseAccount: '1030',
  gstHeld: '2100',
  serviceChargeOwed: '2110',
  tipsOwed: '2120',
  owedToSuppliers: '2000',
  payrollOwed: '2300',
  pensionOwed: '2310',
});

/* Sets for the hot paths; the arrays above stay the readable declaration. */
const COST_OF_SALES_SET = new Set(COST_OF_SALES);
const LABOUR_SET = new Set(LABOUR);
const VARIANCE_SET = new Set(VARIANCE);

const isCostOfSales = (code) => COST_OF_SALES_SET.has(code);
const isLabour = (code) => LABOUR_SET.has(code);
const isVariance = (code) => VARIANCE_SET.has(code);

/** Sum the `balance` of every row whose code passes `pred`. Rounded to laari
 *  once, at the end — summing already-rounded figures is the one place this
 *  arithmetic can drift. */
function sumWhere(rows, pred) {
  const total = rows.reduce((a, r) => (pred(r.code) ? a + Number(r.balance || 0) : a), 0);
  return Math.round(total * 100) / 100;
}

/** One account's balance from a `balances()` result, 0 when never posted. */
function balanceOf(rows, code) {
  const r = rows.find((x) => x.code === code);
  return r ? Number(r.balance) : 0;
}

module.exports = {
  COST_OF_SALES, LABOUR, VARIANCE, POSITION,
  isCostOfSales, isLabour, isVariance,
  sumWhere, balanceOf,
};
