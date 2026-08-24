'use strict';
/* ═══ THE TWO THINGS AN OPERATOR CHECKS, CHECKED ════════════════════════════
   The readiness audit left two items NOT TESTED that need no access this
   repository does not already have — they were simply never written:

     THE SHIFT. Ring a day's trade, close it, and reconcile gross → net → tax →
     cash variance → COGS against the raw tables, independently of the screen
     that reports it. This is the check an operator does on their first night,
     and if it does not tie there is no point discussing anything else.

     THE REVERSAL. A refund on a card sale nets off the next settlement that
     processor has NOT yet paid — never a batch the bank has already settled,
     because reopening one restates a banked figure. The comment says so; this
     asserts it.

   The first runs against a real Postgres through the API. The second is client
   arithmetic, so it runs the SHIPPED source in a vm rather than a retyped copy.
   ═══════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const H = require('./harness');

const r2 = (n) => Math.round(Number(n) * 100) / 100;

/* ═══ 1 · A REVERSAL NEVER REOPENS A FILED BATCH ═══════════════════════════ */

test('a reversal nets onto the next unpaid settlement, not a banked one', () => {
  const F = H.makeInstance({});
  const day = (n) => '2026-03-0' + n;

  /* Three days of card takings for one processor. Day 1 has been matched and
     filed — the bank has paid it. Days 2 and 3 are still awaiting. */
  F.state.settled = [1, 2, 3].map((n) => ({
    outletId: F.state.outletId, no: 'R-' + n, tender: 'card',
    bizDate: day(n), total: 1000, at: Date.now(), ref: 'AUTH' + n
  }));
  F.state.acqRuns = {};

  const batches = () => F.settlementBatches()
    .filter((b) => b.proc === 'term')
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const filedKey = batches()[0].key;
  F.state.acqRuns = { [filedKey]: { paid: 985, at: Date.now() } };

  // A credit note authorised on day 1 — the day whose batch is already filed.
  F.state.docs = [{
    kind: 'CN', outletId: F.state.outletId, tender: 'card',
    bizDate: day(1), at: Date.now(), T: { total: 300 }
  }];

  const after = batches();
  assert.strictEqual(after.length, 3, 'three days, three batches');
  assert.strictEqual(r2(after[0].reversed), 0,
    'the banked batch is untouched — reopening it would restate a figure the'
    + ' bank has already paid');
  assert.strictEqual(r2(after[1].reversed), 300,
    'the reversal lands on the next settlement that processor has not paid');
  assert.strictEqual(r2(after[2].reversed), 0, 'and no further forward');

  // And it reduces what is expected, rather than being lost.
  assert.ok(after[1].expected < after[2].expected,
    'the netted batch expects less than an identical unnetted one');
});

test('a reversal authorised after every open batch makes its own', () => {
  const F = H.makeInstance({});
  F.state.settled = [{
    outletId: F.state.outletId, no: 'R-1', tender: 'card',
    bizDate: '2026-03-01', total: 1000, at: Date.now(), ref: 'A1'
  }];
  const key = F.settlementBatches().filter((b) => b.proc === 'term')[0].key;
  F.state.acqRuns = { [key]: { paid: 985, at: Date.now() } };
  F.state.docs = [{
    kind: 'CN', outletId: F.state.outletId, tender: 'card',
    bizDate: '2026-03-09', at: Date.now(), T: { total: 250 }
  }];

  const own = F.settlementBatches().filter((b) => b.proc === 'term' && b.date === '2026-03-09');
  assert.strictEqual(own.length, 1,
    'a bucket is opened on the day it was authorised rather than reopening the filed one');
  assert.strictEqual(own[0].n, 0, 'it has no tickets — nothing was sold into it');
  assert.ok(own[0].expected < 0,
    'and it expects a NEGATIVE amount: the processor will debit the account');

  /* Which is why it must not read as money on its way in, and can never be
     overdue — nothing is arriving. */
  const t = F.settlementInTransit();
  assert.strictEqual(t.backBatches, 1, 'counted as owed BACK');
  assert.strictEqual(r2(t.owedBack), r2(Math.abs(own[0].expected)));
  assert.ok(!t.overdue.some((b) => b.date === '2026-03-09'),
    'a debit the processor will take is never an overdue receipt');
});

/* The shift reconciliation lives in test/api.test.js, where a real outlet has
   already been onboarded with ingredients, recipes and staff — running a shift
   needs all three, and a second copy of that setup would be a second thing to
   keep true. See "a full shift ties" there. */
