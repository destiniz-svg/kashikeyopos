# Test plan

The system's correctness is mostly *arithmetic and privilege*, so most of the
value is in integration tests against a real Postgres, not in unit tests with
mocks. Mocking the database would mock the thing being asserted.

---

## 1. Database invariants (integration, real Postgres)

Run against a provisioned throwaway outlet in CI.

| # | Assertion |
|---|---|
| 1 | Every journal balances: `sum(dr) = sum(cr)` per `journal_id`. |
| 2 | The outlet's trial balance balances: `sum(dr) − sum(cr) = 0`. |
| 3 | An unbalanced journal insert **fails at COMMIT**, not silently. |
| 4 | `receipt_no` is unique; 200 concurrent sales produce 200 distinct numbers. |
| 5 | `ingredient.on_hand` = `sum(stock_move.qty)` for every ingredient. |
| 6 | `sale.cogs` = `sum(sale_line.line_cost)` for every sale. |
| 7 | Payments sum to `sale.total` for every settled sale. |
| 8 | `gross − discount + service + tax + rounding = total` (the check fires). |
| 9 | `DELETE` on `sale`, `payment`, `journal*`, `op_log` is refused. |
| 10 | A second open ticket on the same `(table_no, split)` is refused. |
| 11 | A closed ticket cannot be reopened by a replayed op. |
| 12 | Every `chain` table has RLS enabled **and** forced. Fails when a new table is added without a policy. |

## 2. Isolation (integration)

`backend/scripts/leak-test.js`, wired into CI as a required check, with two
provisioned outlets. Any `LEAK` line fails the build. Add a case for every new
table.

Additional assertions:

- Transaction context does not survive: run a query with outlet 3's context,
  return the connection to the pool, take it again and confirm
  `current_setting('app.outlet_id', true)` is empty.
- `routes.js` does not import the owner pool (static check).
- A token for outlet 3 gets 403 on `/api/outlet/4/*`.
- Rank 2 gets 403 on a rank-4 route; rank 4 gets 403 on `/api/estate/day`.

## 3. Idempotency and offline (integration + e2e)

- Push the same `ops` array twice → the second returns `replay: true` for every
  op and creates nothing.
- Push 50 ops where #23 errors → 49 applied, #23 stays in the outbox with its
  error visible, ordering preserved.
- Playwright: go offline mid-service, complete five sales, come back online,
  assert exactly five sales and five journals.
- Kill the browser mid-sale and reload: the ticket is where it was, and no
  partial sale exists server-side.

## 4. Money (unit)

Pure functions, exhaustively:

- Tax at each configured rate, on inclusive and exclusive pricing.
- Service charge before tax, per the outlet's configuration.
- Cash rounding to MVR 0.50 in both directions, including the exact .25 case.
- Foreign currency: amount → MVR at the recorded rate, and the change given in
  MVR.
- Discount caps by rank, on **every** path (line, ticket, promo, member).
- Split: even (with remainder to the first payer, to the laari), by item, custom
  amount, and the case where custom exceeds the bill.
- Points: earn at the configured rate, redeem at the configured value.
- Recipe cost with yield, sub-recipes nested two deep, and waste %.

Property test: for any random basket, `gross − discount + service + tax +
rounding` equals `total` and the journal balances.

## 5. UI (component + e2e)

- Every module renders its **empty state** with no data, and the empty state's
  action reaches the screen that creates the first record.
- Rank: signing in at each rank shows exactly the modules that rank may view.
- Lockout: 5 wrong PINs locks the till and shows the countdown.
- Register guard: selling without an open register is refused **with an
  explanation**, and the message names the register, not a generic error.
- Responsive: 1440×900, 1024×768, 1440×600 (short viewport), 390×844. The short
  viewport must not put a keypad off-screen.
- Guest portal: order → accept → cook → serve → bill → split → pay, driven
  end-to-end against a real API.
- Accessibility: 44px minimum hit targets, focus visible on every control,
  contrast ratios hold in both POS themes, `prefers-reduced-motion` honoured.

## 6. What CI must run on every push

```
npm run lint            # includes the no-demo-data check (§10)
npm run test:unit
npm run test:integration   # spins Postgres, migrates, provisions 2 outlets
npm run leak-test -- 3 4
npm run test:e2e           # Playwright, all three apps
npm run build
```

A red leak test or a failing invariant blocks deploy. These are not advisory.
