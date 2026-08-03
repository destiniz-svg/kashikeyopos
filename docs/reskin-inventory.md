# Re-skin screen inventory

Phase 0 deliverable. Maps the handoff's 27 screens onto what exists today.
Read `STACK.md` first.

**Verdicts**

| Verdict | Meaning |
|---|---|
| **Restyle** | The screen exists and works. Re-skin only; behaviour untouched |
| **Restyle + feature** | The screen exists, and gains a prototype feature we don't have |
| **New** | Build it. Data exists or is cheap |
| **Hold** | Needs schema we don't have. Decide as a feature on its own merits, not as a side effect of a re-skin |

Scope per instruction: adopt the prototype's design **as delivered, with its own
palette**; add only features that **do not overlap** what we already do; improve
where we can. Menu Builder gets a real AI item generator.

---

## Front of house

| # | Design screen | Exists today as | Verdict | Non-overlapping feature to add |
|---|---|---|---|---|
| 1 | POS Floor | `/app` → Register + Floor screens | **Restyle + feature** | **Per-guest tickets** (guest array per table, line→guest index, settle one guest, table keeps trading). Today `splitWays` only divides the total for display. **Per-line fire state** (`FIRED · 24m` / `NOT SENT`) — today one `kotSent` boolean for the whole ticket. **86 list** strip — we compute `recipeAvail`/`soldOutReason` but never show the floor what's off in one glance. **Park → `HOLD-nnnn` tray** with resume refusing a re-occupied table |
| 2 | Kitchen Display | `/app` KDS screen + `/admin` Kitchen | **Restyle** | — (station routing, bump, ticket age all exist) |
| 3 | Orders & Tickets | `/admin` Sales (Register / QR Orders / Delivery) | **Restyle** | — |
| 4 | Delivery & QR | `/admin` Sales › Delivery + Online Store › QR Ordering | **Restyle + feature** | **5-stage order tracking bar** (Received · In the kitchen · Ready · With the rider · Delivered). **Live QR session cards** — item count, session age, cart value for a table mid-order |
| 5 | Customers & Credit | `/admin` Customers + Receivables | **Restyle** | — credit limits already enforced server-side with an over-limit audit event |
| 6 | Reservations | — | **Hold** | New entity kind + floor integration. Real feature, own ticket |

## Chain

| # | Design screen | Exists today as | Verdict | Non-overlapping feature to add |
|---|---|---|---|---|
| 7 | Chain Overview | `/admin` Outlets › Overview / Compare | **Hold** | Needs cross-outlet consolidation. Adopt the **"chain total must equal the sum of the outlet rows"** invariant when built |
| 8 | Outlets | `/admin` Outlets | **Restyle** | — (stock locations and transfers exist) |
| 9 | Menu Master | `/admin` Menu › Items | **Restyle + feature** | **Per-outlet price override** — highest-value item in the package. We run TGST tourism outlets at 16/17% and cannot price them differently. **Cost-price masking by role** — cashiers currently see food cost and GP%. **GP% colour thresholds** (green ≥70, amber ≥60, else red) |
| 10 | AI Menu Builder | OCR menu import + grounded assistant | **New** | **AI item generator** (explicitly requested): propose dishes with recipe lines, costed amounts, theoretical food cost, GP and a rationale — grounded on our real ingredient catalogue and avg costs. Guardrail from the handoff: **it proposes, it never publishes**; "Push to menu master" is a separate, explicit action. Backed by the `@anthropic-ai/sdk` + `ANTHROPIC_API_KEY` we already have, and degrades to `configured:false` without a key |
| 11 | Users & Roles | `/admin` Staff & Roles (Team/Roles/Permissions) | **Restyle** | — permission matrix already exists |
| 12 | Audit Log | `/admin` Staff › Activity (`activity_log`) | **Restyle** | — already insert-only with UPDATE/DELETE revoked |

## Supply chain

| # | Design screen | Exists today as | Verdict | Non-overlapping feature to add |
|---|---|---|---|---|
| 13 | Inventory | `/admin` Inventory › Stock levels | **Restyle** | — auto-indent is covered by `/api/inv/reorder/draft` |
| 14 | Stock Ledger | `stock_moves` + per-item timeline | **Restyle** | — |
| 15 | Stock Counts | `/admin` Inventory audits | **Restyle + feature** | **Blind count** — today the counter sees the expected quantity, which is the mode that cannot detect shrinkage |
| 16 | Purchases / GRN | `/admin` Procurement › Purchase orders / Vendor bills | **Restyle** | — |
| 17 | Indent Requests | — | **Hold** | Needs the outlet parent hierarchy; our `stores` table is flat |
| 18 | Dispatches | Partial — Inventory › Transfers | **Hold** | Same hierarchy dependency |
| 19 | Production | `/api/inv/produce` ("Make a batch") | **Restyle** | — |
| 20 | Recipes & Costing | `/admin` Inventory › Recipes | **Restyle + feature** | **Recost from latest GRN** as one action — we re-average cost on invoice posting but never re-run menu GP off it |
| 21 | Batches & Expiry | `ingredient_lots` + Inventory › Expiring | **Restyle + feature** | **FEFO pick list** — we allocate FEFO at read time (`inventory.js:2579`) but never produce a picking list, so the physical pick is unguided |
| 22 | Vendors | `/admin` Procurement › Suppliers | **Restyle** | — |

## Finance

| # | Design screen | Exists today as | Verdict | Non-overlapping feature to add |
|---|---|---|---|---|
| 23 | Accounting Flow | Day-end journal + Reports › P&L / GST / Z | **Restyle + feature** | **Chart of accounts** and the **auto-posting rules** made visible (source event → journal → timing). We post a real journal with real COGS; the rules are currently invisible |
| 24 | Reports & Exports | `/admin` Reports (6 sub-tabs) | **Restyle** | — |

## Platform

| # | Design screen | Exists today as | Verdict | Non-overlapping feature to add |
|---|---|---|---|---|
| 25 | Sync & Devices | Outbox exists; **no UI at all** | **New** | **Outbox inspection** (op, entity, operation, captured, state). **Device registry** — app version, last seen, pending ops; today only a "sign out all devices" kill switch. **Conflict resolution modal** — zero occurrences of "conflict" in either front-end, so when the staleness guard rejects a write, nobody is told. Present *our* mechanism (`rowver` + `xid8`), not the prototype's Lamport/IndexedDB |
| 26 | Architecture | — | **Hold** | Documentation screen. Low operational value; skip unless wanted |
| 27 | Settings | `/admin` Configurations | **Restyle** | — |

---

## Totals

| Verdict | Count |
|---|---|
| Restyle | 13 |
| Restyle + feature | 8 |
| New | 2 |
| Hold | 4 |

21 of 27 screens already have working data behind them, which is why this is a
re-skin and not a rebuild.

## Two invariants worth adopting (rules, not features)

1. **Stat strip** — "any average shown as a sub-label must divide out against the
   figures on the same strip." Compute the total and the divisor once and derive
   the average from them.
2. **Chain rollup** — "the chain total must equal the sum of the outlet rows."

Both are the same class of defect as the day-end journal that balanced
tautologically until it was made capable of being wrong. Cheap to adopt, and
they are what keeps the numbers honest.

## Carried constraints (do not lose these in the re-skin)

- **Dhivehi + RTL** on every screen. The prototype has none; we have two full
  dictionaries.
- **GST-inclusive money.** The prototype's ticket adds GST on top. Every total
  keeps calling `totals()`; no figure is copied from the prototype.
- **Touch targets ≥ 44px**, focus rings, and the contrast floor the audit set.
- **One token set**, replacing the two we have — not a third alongside them.

## Open decision before Phase 1

The handoff's tokens have two measured contrast failures in their own light
theme: `--text-faint` (2.82 dark / 2.34 light — and it is the colour of every
empty-state message) and light-theme `--amber` (2.68 on canvas, 2.94 on panels,
failing even the 3:1 UI threshold). Its own Phase 7 requires ≥4.5 body and ≥3
micro-labels in both themes.

Adopting the palette as delivered means **fixing those two values** while keeping
the hue. Flagged rather than silently changed.
