# Data model

Full DDL: `backend/migrations/`. This file explains the shape and the
invariants; the SQL is the authority.

---

## 1. Two planes

**`chain` schema — the control plane.** One per chain. Holds identity and
configuration and *no transactional data*: `outlet`, `staff`, `device`,
`session`, `tax_version`, `doc_series`, `member`, `supplier`, `audit`.

**`outlet_<id>` schema — the data plane.** One per outlet, created by
`chain.provision_outlet()`. Holds everything transactional.

Why: an outlet's sales must be unreachable from another outlet's connection at
the engine level, and identity must be shared to be useful. See
`07-SECURITY-RLS.md`.

---

## 2. The chain of consequence

One sale touches these tables, in this order, in **one transaction**:

```
ticket ──┬─> sale ──┬─> sale_line
         │          ├─> payment ──> settlement_batch (later, on reconciliation)
         │          ├─> stock_move ──> ingredient.on_hand
         │          └─> journal ──> journal_line
         └─> kds_ticket
```

If any leg fails, none of it happened. A sale whose journal did not post is not
a sale; it is a bug that has already reached the accounts.

### The journal a cash sale posts

| Account | Dr | Cr |
|---|---|---|
| 1000 Cash in drawer | total | |
| 4000/4010 Sales | | gross − discount |
| 2100 GST payable | | tax |
| 2110 Service charge payable | | service |
| 6910 Cash rounding | rounding | (or credit) |
| 5000/5010 Cost of sales | cogs | |
| 1100/1110 Inventory | | cogs |

Card sales debit 1020 instead of 1000 and settle to 1010 with a fee to 6180 when
the acquirer batch matches. Points redemption debits 2200. Tips credit 2120 and
never touch income.

---

## 3. Key tables

### 3.1 `ticket` / `ticket_line`
Open on the floor. `status` is `open | held | closed | void`. A partial unique
index forbids two open tickets on the same `(table_no, split)`. A closed ticket
must have `closed_at`. Lines carry `sent_at` (fired to the kitchen), `void_at`
+ `void_by` + `void_reason`, and the staff and device that added them.

### 3.2 `sale` / `sale_line` / `payment`
`receipt_no` is unique and only `chain.next_doc_no()` mints it.
`tax_code` and `tax_rate` are **recorded on the row**, never re-derived from
current configuration — a rate change must not restate a filed return.
A check constraint enforces
`gross − discount + service + tax + rounding = total`.
`sale_line` carries `unit_cost` and `line_cost` captured at the moment of sale,
so margin is never recomputed from a later ingredient price.
`payment.amount` is always MVR; foreign tender additionally stores
`fx_amount`, `fx_rate` and its `currency`.

### 3.3 `ingredient` / `item` / `recipe_line` / `stock_move`
`item.yield_qty` is the recipe's yield — a sauce recipe that makes 8 portions
divides by 8, which is the fix for understated food cost.
`recipe_line` references **either** an `ingredient_id` **or** a `sub_item_id`
(a sub-recipe), enforced by a check constraint, with `waste_pct` per line.
`stock_move.qty` is signed; every move names a `reason` and, for a sale, the
`sale_id` that caused it.

### 3.4 `account` / `journal` / `journal_line`
29+ accounts seeded per outlet by `chain.seed_chart()`, same codes across the
estate so consolidation lines up. `journal_line` has a check that exactly one of
`dr`/`cr` is non-zero, and a **deferred constraint trigger** rejects any journal
that does not balance at `COMMIT`.

### 3.5 `op_log`
`op_id` (client-generated UUID) is the primary key. This is the whole of the
idempotency story: a replayed operation collides and returns the stored result
instead of doing the work twice.

### 3.6 `chain.doc_series`
`(outlet_id, kind)` → `prefix`, `next_no`. Allocation is an `UPDATE ...
RETURNING` under the row lock. Kinds: `SALE`, `CN`, `PO`, `GRN`, `JV`.

### 3.7 `chain.audit`
Append-only: no `UPDATE` or `DELETE` grant is ever issued. Every row carries
outlet, actor, rank, device, action, entity, before/after JSON, and scope.

---

## 4. Invariants (assert these in tests)

1. `sum(journal_line.dr) = sum(journal_line.cr)` for every journal, always.
2. `sum(dr) − sum(cr) = 0` across the whole outlet ledger — the trial balance
   balances.
3. No two sales share a `receipt_no` within an outlet.
4. `ingredient.on_hand` equals the sum of its `stock_move.qty`.
5. A sale's `cogs` equals the sum of its `sale_line.line_cost`.
6. Every settled sale has at least one payment, and payments sum to the total.
7. No `sale` row is ever deleted.
8. A ticket cannot go from `closed` back to `open`.
9. Every row in every outlet schema belongs to that outlet — there is no
   `outlet_id` column to get wrong, because the schema *is* the outlet.
