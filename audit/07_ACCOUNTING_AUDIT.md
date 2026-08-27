# 07 · Accounting audit

## The chain of consequence, and who composes it

`ticket → sale → payment → tax → stock_move → journal → settlement`, written
by `applySale()` in ONE transaction. **The till composes no journal for a
sale** — every leg is derived server-side from the sale op. A deferred
CONSTRAINT TRIGGER refuses an unbalanced journal at COMMIT, collapsed per-op
in sync so one bad op fails alone.

## Transaction → ledger map (as implemented)

| Event | Dr | Cr |
| --- | --- | --- |
| Sale, cash leg | 1010 Cash | 4000 Revenue (goods) |
| Sale, card/wallet/QR leg | 1030 In transit | 4000 |
| Sale, transfer leg | 1020 Bank | 4000 |
| Sale, house credit leg | 1040 Receivable | 4000 |
| Service charge | tender | 2300 Service pool |
| GST | tender | 2200 GST payable |
| Discount | 4100 contra | — |
| Cash rounding dust (≤5 laari) | ±4900 | |
| Tip | tender (rides on payment) | 2450 Tips payable |
| Points earned | 6550 Loyalty expense | 2350 Points liability |
| Points redeemed | 2350 | 4000 keeps the full goods figure; `sale_adds_up` reads `−pts_value` |
| COGS (only when stock moved) | 5000 COGS | 1200 Inventory, at server-derived WAC |
| Payroll net wages | 6xxx | 2400 Net wages payable (023 — **not** 2450) |
| Supplier payment / settle credit / GRN priced / acq match / write-off | carried IN the op (`lines`, `memo`) — five pinned composers | |
| Settlement batch | fee + shortfall booked once per batch via `acq_match`; reversals net forward, never reopen | |

Eleven till-owned accounts (1010 1030 1040 1200 2200 2350 4000 4100 4200 4900
6550) refuse manual journals; 2450 deliberately manual so tips can be paid out.

## Independent recomputation (golden tests, in CI)

- `test/reconcile.test.js` recomputes revenue, tax, service, COGS, drawer
  expectation and the trial balance from raw transactions and compares against
  the app's reports — passed in both TZ runs of this audit.
- Loadtest correctness block (every stage, re-run today): journals balance,
  revenue ties to the sales that made it, no duplicates, no repairs needed.
- Backup drill compares gross, trial balance (dr=cr), journal-line count and
  unbalanced-count across dump→drop→restore.

## Reversals

Voids (029) reverse money, stock, points and credit with negating rows tied to
the original — history is never deleted. Refund-exceeding-payment and
double-void are refused; a sale is never rejected at ingest (money already
taken) — repaired and flagged (`server_audit`).

## Findings this pass

1. **R-1 (P1, FIXED): fabricated approval codes.** Card/wallet settle held the
   operator on a fake 780 ms "Waiting for the terminal…" spinner, then stamped
   a `Math.random` six-digit code into `payment.auth_ref` — fabricated
   evidence that could never match an acquirer statement and permanently
   silenced the "Unreferenced card sales" exception lane. Removed: the
   reference is only ever what the operator keys off the real slip; blank is
   honestly flagged at close. Regression-pinned in `test/wiring.test.js`
   ("the till never fabricates an approval code"). CLAUDE.md corrected.
2. Historical payroll rows posted to 2450 before migration 023 are not
   restated (disclosed on the trail); 2350 can open negative for pre-021
   points (disclosed). Both are documented facts, not open defects.
3. Known open (stated): full recipe-and-WAC re-derivation of COGS server-side
   exists for quantity and value; the terminal's *percentage-estimate* margin
   on recipe-less outlets stays a client figure by design.
