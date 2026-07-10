# Inventory & Pricing — Recipe-First, Periodic-Audit

Design document for the ingredient-level inventory module. Code lives in
`inventory.js` (business logic + `/api/inv/*` routes), `schema.sql`
(tables, RLS, indexes), and one hook in `index.js`'s `/api/ops` (sale →
deduction trigger).

## 1. Architectural analysis

### 1.1 Recipe-to-inventory lifecycle (real-time deduction)

Sales do not reach the server as API calls — the till is offline-first and
pushes an **op log** to `POST /api/ops`, where sale entities are upserted
into the `entities` table under RLS. That op batch is therefore the single
chokepoint every settled bill flows through, from every register, guest QR
order, and offline replay. The deduction trigger hooks exactly there:

```
till settles bill ──► /api/ops (op-dedup guard, RLS transaction, COMMIT)
                          │
                          └─► post-commit: inventory.processSales(orgId, sales)
                                 │  per sale, own withOrg transaction:
                                 │  1. look up recipe_lines for the sale's product ids
                                 │  2. Σ qty per ingredient (recipe qty × line qty)
                                 │  3. INSERT stock_moves (ref 'sale:<id>')
                                 │       ON CONFLICT (org_id, ref, ingredient_id) DO NOTHING
                                 │  4. decrement ingredients.current_stock
                                 │       ONLY for rows step 3 actually inserted
                                 └─ refunds: same flow, positive qty, ref 'refund:<id>'
```

Three properties make this safe:

- **Never blocks a sale.** Deduction runs *after* the sync transaction
  commits. A till sale can never be rejected because inventory math failed;
  failures land in the error ring buffer and the next stock check
  reconciles.
- **Idempotent end to end.** The offline op log replays; syncs retry. The
  partial unique index on `stock_moves (org_id, ref, ingredient_id)` means
  a replayed sale inserts nothing and therefore deducts nothing. A crash
  between commit and deduction at worst *skips* one deduction (audit
  catches it) — it can never double-deduct.
- **Tenancy by construction.** `processSales` runs inside `withOrg`, the
  same scope every request uses: Postgres RLS (`tenant_isolation` policies,
  FORCE, enforced on the non-owner `kashikeyo_app` role) filters every
  query by `app.org_id`. The `org_id` columns in the SQL are
  belt-and-braces, never the only guard. Verified: a second tenant sees
  zero rows of another tenant's ingredients/moves/audits under the
  restricted role.

Products **without** a recipe are untouched — the till's existing
product-level `stock` tracking keeps handling resale items (a canned
drink). Recipes are the opt-in layer for made items.

### 1.2 Periodic audit / reconciliation (COGS)

The module deliberately uses the **periodic inventory method** as the
source of financial truth, with the real-time ledger as an operational
estimate between checks:

```
COGS = Beginning inventory + Purchases during period − Ending inventory
```

- **Beginning** = the previous stock check's counted closing value (for a
  first-ever check, the system's current belief: Σ stock × avg cost).
- **Purchases** = Σ `stock_moves` of kind `purchase` since the previous
  check closed — invoices are the only write path that creates those.
- **Ending** = Σ counted qty × avg cost at close.

On close, each line's variance (counted − expected) is written to the
immutable ledger as an `audit` move and `current_stock` snaps to the
counted reality. The periodic result is *self-healing*: unrecorded waste,
over-portioning, a missed deduction — all surface as variance and roll
into COGS, so the books stay honest even when day-to-day tracking wasn't.

### 1.3 Unit conversions (Cases vs grams)

Every quantity **stored** anywhere — stock, recipe lines, ledger moves,
audit counts — is in the ingredient's single **base unit** (`g`, `ml`, or
`pcs`). Bulk units exist only at the two entry edges:

- `ingredient_units` holds per-ingredient factors: *"Case" = 7920 ml*
  (24 × 330 ml), *"Bag 25kg" = 25000 g*. Multi-level packaging collapses
  into one factor-to-base.
- Invoice lines and audit counts accept `{qty, unitName}`; the server
  resolves the factor **at entry time** and stores `base_qty` (invoice
  lines also snapshot the factor used, so later pack-size edits can't
  rewrite history).
- An **unknown unit name is a hard 400**, never a silent factor-1 — a
  "Case" quietly counted as one bottle is precisely the corruption this
  module exists to prevent. (Covered by an integration test.)

All quantity/financial columns are `NUMERIC` (DECIMAL). Money stays in the
platform's integer sub-unit (laari) but unit costs carry 6 decimals,
because a per-gram cost is routinely a fraction of a laari.

### 1.4 UX strategy — operational language, guided flows

The owner never sees accounting vocabulary. The mapping:

| Accounting concept        | What the owner sees                          |
|---------------------------|----------------------------------------------|
| Periodic reconciliation   | **"Weekly stock check"**                      |
| Beginning/ending inventory| "Where you started" / "What you counted"      |
| COGS                      | "What your kitchen used (cost)"               |
| Shrinkage / variance      | "Difference" + a one-tap reason chip          |
| Weighted-average costing  | (invisible — happens on invoice entry)        |
| Journal adjustment        | (invisible — closing the check just fixes it) |

Guided beats flexible: the stock check is a wizard that walks storage
locations in order; entering an invoice is "what arrived, what did it
cost"; variance review is chips (*Spoilage · Staff meal · Waste · Count
error · Other*), not adjustment entries.

## 2. Schema (see `schema.sql`, applied idempotently at every boot)

| Table | Purpose | Key indexes |
|---|---|---|
| `ingredients` | name/SKU, base unit, `current_stock`, `min_stock`, weighted `avg_cost`, storage `location` | `(org_id, location) WHERE active`; unique `(org_id, sku)` |
| `ingredient_units` | bulk pack factors per ingredient | `(org_id, ingredient_id)` |
| `recipe_lines` | menu item (products entity id) → ingredient, qty per unit sold | unique `(org_id, product_id, ingredient_id)`; `(org_id, product_id)` |
| `stock_moves` | immutable signed ledger (`sale/refund/purchase/audit/manual`) | **unique `(org_id, ref, ingredient_id)`** ← idempotency; `(org_id, ingredient_id, created_at)`; `(org_id, kind, created_at)` |
| `audit_sessions` | one stock check: status, opening/purchases/closing values, COGS | `(org_id, started_at DESC)` |
| `audit_lines` | per-ingredient expected/counted/variance/flag/reason | unique `(org_id, session_id, ingredient_id)` |
| `suppliers` | vendor book | `(org_id) WHERE active` |
| `purchase_invoices` / `purchase_invoice_lines` | received invoices; lines snapshot unit factor + cost | `(org_id, received_at DESC)`; `(org_id, invoice_id)` |

All nine tables get the same `tenant_isolation` RLS policy
(ENABLE + FORCE) as the core tables, and DML grants to `kashikeyo_app`.
Every PK is composite on `org_id`, so tenancy filtering is index-leading
everywhere.

## 3. Backend business logic (`inventory.js`)

Factory `createInventory({withOrg, uid, wrap, recordError,
resolveAppSession, bearerAuth})` returns `{router, processSales}`.
Routes accept either the back-office session cookie or the till's bearer
JWT (`authAny`).

| Endpoint | What it does |
|---|---|
| `GET/POST/DELETE /api/inv/ingredients` | CRUD + pack units + low-stock flag (soft delete) |
| `GET /api/inv/recipes/:productId` | lines + live cost/**margin preview** from the same `avg_cost` the COGS math uses |
| `PUT /api/inv/recipes/:productId` | replace recipe lines |
| `GET/POST /api/inv/suppliers` | vendor book |
| `POST /api/inv/invoices` | the single stock-in path: converts units, writes ledger (`invoice:<inv>:<line>` refs), **re-averages cost** — `new = (on-hand value + delivery value) / total units`, guarded against negative on-hand |
| `POST /api/inv/audits` | open a stock check: snapshot every active ingredient's expected qty + opening value; one open check at a time |
| `GET /api/inv/audits/:id` | lines **grouped by storage location** with each ingredient's pack units (feeds the wizard) |
| `PUT /api/inv/audits/:id/counts` | incremental count entry, any unit, optional reason |
| `POST /api/inv/audits/:id/close` | variance per line, **>5% flagged `review`**, stock snapped to counted via ledgered audit moves, periodic COGS computed and stored |
| `GET /api/inv/alerts` | below-min ingredients + review-flagged lines still missing a reason |

Uncounted lines on close keep the system figure (skipped, not zeroed) —
the owner only answers for what they actually walked past.

## 4. Frontend UX plan

New **Back Office** page (`site/back.html` → `/back`, gated by
`requireAppSession`, Lovable theme) rather than till-bundle patches — the
till bundle is minified and string-patched, fine for surgical tweaks,
wrong for whole new screens. Component structure:

```
BackOffice
├─ NavTabs: Menu & Recipes · Stock Check · Deliveries · Ingredients · Suppliers
│
├─ RecipeTab (per menu item, opened from a searchable product list)
│  ├─ IngredientSearch     — type-ahead over /api/inv/ingredients,
│  │                          enter qty in the ingredient's base unit
│  ├─ RecipeLineList       — qty steppers, remove, per-line cost
│  └─ MarginPreview        — sticky footer: Cost · Price · Profit · Margin %
│                             re-rendered from the PUT response on every edit,
│                             green ≥60% · amber 40–60% · red <40%
│
├─ StockCheckWizard  ("Weekly stock check")
│  ├─ StepIntro            — "Last check: {date}. ~{n} items, {locations}."
│  ├─ StepLocation ×N      — one screen per location (Fridge → Dry → Bar),
│  │    CountRow           — expected qty shown in friendly units, input +
│  │                          unit picker (Cases / Bottles / base), instant
│  │                          per-row difference badge as you type
│  ├─ StepReview           — only lines >5% off: variance + reason chips
│  │                          (Spoilage · Staff meal · Waste · Count error)
│  └─ StepDone             — "Kitchen used MVR X this period" (the COGS,
│                             never called that) + biggest differences
│
├─ DeliveryEntry ("What arrived?")
│  ├─ SupplierPicker (+ inline add) · InvoiceNoField
│  ├─ DeliveryLineList     — ingredient search, qty, unit picker, line cost;
│  │                          shows the resulting per-unit cost as you type
│  └─ PostButton           — one tap: stock up, costs re-averaged
│
└─ AlertsStrip (top of every tab) — low-stock chips + unreviewed variances
```

Design decisions & deferred items:

- **Ingredient stock is org-wide in v1** (one kitchen). Multi-store
  splitting = a `store_id` dimension on `ingredients` later; `stock_moves`
  already records `store_id` so history survives the split.
- Refunds restock ingredients only when the till emits a distinct
  `type:"refund"` sale; a refund that merely flags the original sale is
  reconciled by the next stock check (by design — the check is the truth).
- Purchase-order lifecycle (draft PO → receive) is deferred; the invoice
  flow is the receiving path v1. `purchase_invoices` is the natural anchor
  for a `status` column when POs arrive.

## 5. Verification

Integration-tested against a real Postgres 16 cluster (`schema.sql`
applied twice — idempotent): bulk-unit conversion, weighted-average
costing across two deliveries, unknown-unit rejection, sale deduction,
triple-replay idempotency, refund restock, no-recipe no-op, margin
preview math, RLS isolation under the restricted `kashikeyo_app` role,
audit open/duplicate-block/count-in-cases/close, >5% review flagging,
COGS identity, stock snap, ledgered adjustments, low-stock alerts.
