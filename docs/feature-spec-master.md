# KashikeyoPOS — Master Feature Specification (the product to match)

**Purpose.** This is the single source of truth for **every feature our product
ships today**. The prototype (`Masterclass_App_Prototype_3`) has the stronger
*visual design*; our system has the stronger *feature set and real backend*. The
goal is **best-of-both**: keep the prototype's look, motion and layout, and bring
it up to **exact feature parity with everything below**. Nothing here is
aspirational — it is all implemented and running on `staging`.

**How to use this.** Each feature block states: **what it is**, **the exact
behaviour/rules** (states, math, edge cases), **the data** behind it, and the
**acceptance criteria** a screen must meet to be "at parity." A designer or an
implementer can build each screen against these without reading our code. §12 is
a prototype-screen → our-feature mapping so nothing is dropped.

> Money is always **laari** (MVR × 100, integer). Display = ÷100 with 2 decimals.
> All prices are **GST-inclusive**. Never trust the client for a total — the
> server computes money (see §9).

---

## 1. Product architecture — three surfaces + one backend

| Surface | Who | Where | Auth |
| --- | --- | --- | --- |
| **Till / Register** (`/app`) | cashier, waiter, kitchen, manager, admin, owner | on-counter tablet/phone, **offline-first** | per-staff **PIN** |
| **Back office** (`/back`) | manager, admin, owner | laptop/desktop cockpit | **PIN or owner email** login, role-scoped |
| **Guest / QR portal** (`/p/:slug` or `/?s=slug`) | diners | their own phone | none (public menu + member sign-in) |

All three read/write the **same cloud** over an offline-first sync contract
(§10). One org (a business) can run **multiple stores/outlets**.

**Non-negotiable foundations that must survive any redesign:**
1. **Offline-first** — a sale is committed locally and shown instantly; it syncs
   when the network returns. The UI never blocks on the server.
2. **Server-authoritative money** — totals, tax, service, discounts, change are
   recomputed and trusted only on the server.
3. **Multi-tenant isolation** — Postgres row-level security; a store can never
   see another's data.
4. **Append-only audit** — every sale, refund, void, price change, and role
   action is logged and cannot be edited or deleted.
5. **Bilingual EN ⇄ Dhivehi with full RTL**, and **5 themes** (light+dark each).

---

## 2. Cross-cutting foundations (apply to every screen)

### 2.1 Offline-first + network state
- **Network pill** in every header: **Online** (green), **Offline** (amber),
  **Syncing** (blue, spinner). Driven by real connectivity + an outbox depth.
- **Outbox**: writes that fail while offline are queued locally (IndexedDB) and
  replayed on reconnect + every 15 s. A synthetic success keeps the UI moving.
  A visible **"Saving N…"** / **"Synced"** pill shows outbox state.
- **Receipts printed offline** carry an `-OFF-` marker and a queued note.
- Never cache `/api/*` responses in the service worker (live data only).

### 2.2 Bilingual & RTL
- Language toggle **`EN` / `ދިވެހި`** in the header. Toggling flips the entire
  layout to **RTL mirroring** (not just text). Dhivehi uses the **Thaana** font
  (`MV_A_Waheed`). Every product carries `name`+`dv` (Dhivehi name), `desc`+
  `descDv`. Menu tiles, receipts, and the guest portal all render both.

### 2.3 Theming
- **5 palettes** (orange/keyo-coral, green, watermelon, mango, strawberry), each
  **light + dark**, glassy translucent surfaces. Theme is per-store and syncs to
  the till + guest portal. Token set (map the prototype's `--coral/--ink/--line/
  --green/--amber/--red` onto ours): primary, on-primary, ink/ink2/ink3,
  surface/surface2, line, and soft variants.

### 2.4 Roles (see §8 for the full model)
Six roles: **waiter, cashier, kitchen, manager, admin, owner**. What a user sees
is gated by role — enforced **client-side (hide) AND server-side (403)**.

---

## 3. Surface A — The Till / Register (`/app`)

PIN-gated. Top nav: **Sell · Orders · Dashboard · Reports · Admin** (Admin is a
panel of management cards). Every screen must degrade to phone width (rail →
bottom bar, cart → slide-up sheet).

### 3.1 Sign-in (PIN gate)
- Store name + a list of staff avatars (name + role). Tap a user → numeric PIN
  pad → unlock. PIN is a **shift selector**, not a hard security boundary
  (sensitive actions re-verify — §8). "(you)" marks the signed-in user.

### 3.2 Register (Sell) — the core screen
**Left:** search (name/barcode, "Enter" quick-adds) + **category chips** (All +
each category) + a responsive **tile grid** (`minmax(126px,1fr)`).
Each **menu tile** shows:
- Product **image** (AI-generated or uploaded) or a tinted **emoji/glyph** fallback.
- **Name** (EN) + **Dhivehi name** (RTL) + up to 3 **tag chips** + a short
  **description** *(description is the one register polish to add from proto)*.
- **Price**, unit, a **★ Best seller** badge, and **Sold-out** state (dimmed +
  "Sold out" when stock/recipe availability ≤ 0 — driven by the availability
  engine, §5.4).
- **On-tile quantity stepper** (−/qty/+) once the item is in the cart; a coral
  **+** before that. Items with modifiers show an **amber dot** and open the
  modifier modal instead of quick-adding.

**Right — cart / order panel:**
- Header: **"Order" + sequential number** (`#0047`), **Hold**, **Clear**.
- **Order-type segmented control: Dine-In / Takeaway / Delivery.** Dine-In
  reveals a **table picker** (T1–Tn grid; chosen table shown on the button).
- **Add customer** (loyalty / on-tab).
- Each line: thumbnail, name, modifier subtext, −/qty/+ stepper, line amount.
- **Discount chips** (None / 5 / 10 / 15 / 20%) *(add from proto)* → a bill-level
  discount.
- Totals: **Subtotal**, Discount (if any), **Value excl. GST**, **Service charge
  (%)**, **GST (rate label)**, **Total** (large). **Service charge applies to
  Dine-In only** — dropped for Takeaway/Delivery.
- Footer: **Send to KOT** (fire a kitchen ticket mid-order without payment; label
  flips to "Fired to kitchen"; prevents a duplicate ticket at Charge) *(add from
  proto)* and **Charge** (opens payment). Also Park (hold) + split/void icons.
- Order type, table, discount, customer, and KOT state **reset on New sale**.

### 3.3 Parked bills / hold & recall
- **Hold** parks the whole order (lines + type + table + discount + customer)
  into a `held` list and clears the counter.
- **Parked-bills bar** (persistent strip above search): each parked order shows
  **bill number**, **table tag** (Dine-In), **customer tag**, item count + total,
  an **"In kitchen"** dot if its KOT fired, and **elapsed time**; a left accent
  bar colour-coded by type (coral Dine-In / amber Takeaway / green Delivery).
  **Tap to recall**, **×** to delete. Bills persist until **settled** (charged)
  or **deleted**. *(We have open-bills; add the timers + in-kitchen dot + colour
  accent polish.)*

### 3.4 Modifier / Custom-Order modal
Centred glass sheet, two-column on wide / stacked on narrow.
- **Left:** dish photo, EN/DV name, description, base price, a **qty stepper**,
  and a **3×4 numeric keypad** (1–9, quick-adds +10/+15/+20, `C` clear-to-1,
  backspace) kept in sync with the stepper.
- **Right:** a **Notes** textarea (`dir="auto"`, persists to the cart line + KOT)
  and the **options** list — variants / spicy level / add-ons as checkboxes with
  Free/price tags. Items with no options open the same modal (empty list).
- **Line total = (base + selected option prices) × qty.**

### 3.5 Payment drawer
Right-side drawer. **Total due** (large) + a **split** control (1–4 guests → per-
guest amount). **Method grid: Cash, Card, BML Gateway, Transfer, On tab.**
- **Cash:** quick-tender chips (Exact / next 50 / 100 / 500) → **change due**
  (green). **Card/QR/Transfer:** capture a **reference/approval code** (optional,
  for reconciliation).
- **On tab:** customer picker → posts to **receivables** (see §5/§6 tabs).
- **Confirm** enabled only when the method's requirements are met.
- On confirm → **success animation**, generate a receipt + a kitchen ticket,
  update all running totals, and (offline) increment the outbox.

### 3.6 Receipt (MIRA-compliant)
Thermal-style: outlet, address, **TIN**, doc-type badge (**RECEIPT**), receipt
no. `MLE-R1-YYYYMMDD-####` (`-OFF-` when offline), date, **order type (+ table
for Dine-In)**, line items, Subtotal / **Discount** / excl. / Service / GST /
**Total**, "Prices are GST-inclusive" + method, offline note, **Thaana thank-you**,
zig-zag tear edge. Buttons **Print** / **New sale**.

### 3.7 Floor / Tables
Live **table map** (grid). A table is **occupied** when a dine-in order is parked
or active there; each occupied tile shows **item count**, **running bill**, a
**live elapsed timer**, and an **In-kitchen** tag once its KOT fired. **Tap a
free table to seat** (starts a dine-in order → Register); **tap an occupied table
to recall** its bill. Header: **Occupied / Free** counts + total **Open value**.
An **"Other open orders"** list tracks held Takeaway/Delivery.

### 3.8 Kitchen Display (KDS) — the **Orders** tab
Ticket grid. Each ticket: header **tinted by age** (green <5 min, amber <10, red
10+), number + **source** (`POS · T<n>`, `Takeaway`, `Delivery`, `QR · T#`),
**live MM:SS timer**, item lines, **station tag** (HOT KITCHEN / DRINKS & COLD),
**Bump ✓** (removes + toasts). Empty = "all caught up". Tickets arrive from
**Send to KOT** (mid-order) or automatically at Charge. Accepting/bumping is
idempotent and can't be resurrected by an in-flight sync.

### 3.9 Shifts
Open a shift before taking payments ("No shift open — tap to open one"). Any
sell-capable role can open/close their shift; shift totals feed **Day End**.

### 3.10 Admin panel (management cards, role-gated)
Cards, each gated by permission: **Products & Inventory, Customers, Users & PINs
(owner/admin), Tables, Delivery Zones, Wastage Log, Purchase Orders, Kitchen
Supplies, Expenses, Store Settings (owner/admin), Cloud Sync (owner), Data &
Backup (owner)**. These mirror the deeper `/back` modules (§4) for on-counter use.

---

## 4. Surface B — Back office (`/back`) — 12 modules

Desktop cockpit. Header: greeting, one-line narrative, outlet pill, date-range
chips (Today/7d/30d…), theme toggle. **Nav is role-gated** (manager: no
Owner/Settings; admin/owner: all). Every module is real, wired to the backend.

1. **Owner dashboard** *(owner/admin)* — KPI hero vs previous period (revenue Δ,
   gross/net margin, orders, avg ticket, food-cost %, cash, AR); **menu Magic
   Quadrant** (Kasavana-Smith: popularity × contribution margin → Stars /
   Plowhorses / Puzzles / Dogs); **price-fluctuation** alerts; a merged
   **attention** list (reorder + expiry + margin + overdue tabs); per-outlet
   revenue; a deterministic **guided read**; and a **plain-English command bar**
   (agent — §7).
2. **Overview** — operational snapshot (sales, low stock, today's activity).
3. **Review** — **flagged** sales/credit needing attention (offline-safe
   "flag-never-reject"); acknowledge to clear.
4. **Assistant** — grounded AI Q&A over a live inventory digest + the reorder/
   watch lists (works without an AI key using the deterministic lists).
5. **Ingredients** — base unit (g/ml/pcs), current stock (cached from the
   ledger), weighted avg cost (laari/base-unit), min-stock, location, and
   **roles**: sellable (resale), producible (prep), stockable-menu-product.
6. **Menu & Recipes** — products + per-product **recipe/BOM** editor (qty per
   sold unit); the **✨ AI Menu Builder** (name + one line → full bilingual item
   with tags, add-ons, allergens, price band, flat SVG image; preview → apply;
   NL "Modify"); import/export XLSX.
7. **Stock Check** (audits) — guided count wizard by location → variance →
   posts adjustments to the ledger.
8. **Deliveries** — supplier invoices raise stock + re-average cost + book an
   expense; **use-by date per line → FEFO lot** (§5.5); **OCR scan** a photo of a
   delivery note → draft lines; **🔄 Auto-reorder** → draft POs by learned
   supplier; receive till-raised POs as pre-filled deliveries.
9. **Suppliers** — supplier records; learned from purchase history.
10. **Customers** — CRM: list with **owing/owed**, per-customer balance, loyalty
    points, payment history, order history.
11. **Reports** — computed at read-time (no fragile journal): **P&L** (revenue,
    perpetual COGS, gross, opex, net), **GST return** (output − input = payable),
    **cash position**, tender breakdown; range chips; **CSV export**.
12. **Settings** *(owner/admin)* — store profile (name, currency, **TIN**,
    address, receipt footer), **GST sector** (GGST 8% / TGST — §9), **service
    charge %** (dine-in), **loyalty %**. Plus Cloud Sync + Data/Backup (owner).

---

## 5. Inventory & supply engine (powers §3 tiles + §4 modules)

- **`stock_moves`** — immutable signed ledger, source of truth. Kinds:
  `purchase | sale | refund | audit | manual | waste | transfer | produce |
  prep`. `current_stock` is a cache = Σ moves; kept in step.
- **Item-role graph** — one ingredient can be: **stockable** (bought/counted),
  **resale** (sold as-is on the till), **prep/producible** ("Make a batch"
  consumes components, stocks the item, rolls cost), **stockable menu product**
  (sell-from-stock + usable in recipes).
- **Per-location** stock + **transfers** between locations.
- **Availability engine** — computes servings per recipe product from stock and
  writes `recipeAvail`/`soldOutReason` onto each product → the till and guest
  portal disable sold-out items automatically.
- **Expiry / FEFO** — `ingredient_lots` (use-by per delivery line); `/expiring`
  allocates stock across lots first-expiry-first and tiers expired/today/soon/
  week/later → expiry alerts. Never touches the offline sale path.
- **Auto-reorder** — velocity-learned reorder list → draft POs grouped by each
  ingredient's usual supplier.

---

## 6. Surface C — Guest / QR portal (`/p/:slug`)

Public, per-store, themed to the store. Views:
1. **Menu** — greeting + table, search, category chips, dish grid with photos,
   name/blurb/price, **sold-out** honoured, bilingual.
2. **Item detail** — hero photo, verified tick, tagline, rating, description,
   **Add-ons** steppers, **Notes**, sticky **Total + Add**.
3. **Order summary** — line steppers, **promo code**, **Payment Summary**
   (Subtotal, Tax & Service, Promo, Total), **Order & Pay / Order Now** → drops a
   `QR · T#` ticket onto the KDS with no re-keying.
4. **Member profile** — rewards, tiers, order-again, **dues/payments** (view +
   settle an on-tab balance).

---

## 7. The AI layer (4 features, provider-agnostic)

Single client picks **Anthropic Claude _or_ Google Gemini** by whichever key is
set (`ANTHROPIC_API_KEY` / `GEMINI_API_KEY`, `AI_PROVIDER` to force, `GEMINI_MODEL`
override). **All four degrade gracefully** without a key (a "not set up yet"
message; the deterministic parts still work).
1. **AI Menu Builder** — name + one line → full bilingual menu item (EN+Dhivehi
   copy, tags, add-ons, allergens, price band, flat SVG illustration) + NL Modify.
2. **AI Assistant** — grounded Q&A over the live inventory digest.
3. **Plain-English Agent** — a two-phase **guarded** action: interpret → resolve
   to explicit targets against *this store's* catalogue → **confirm-diff** →
   execute (86/restore, hide/show, reprice one item or a whole category %) —
   RLS-scoped and audit-logged. The model proposes; the server disposes.
4. **OCR delivery-note** — photo → structured lines mapped to the catalogue →
   draft delivery.

---

## 8. RBAC & staff model

- **Roles & permissions** (client hides + **server enforces**):

| Permission | waiter | cashier | kitchen | manager | admin | owner |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| Sell / take orders | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| Kitchen tickets (KDS) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Customers | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| Inventory (wastage/PO/supplies) | — | ✅ | — | ✅ | ✅ | ✅ |
| Refunds / comps (FOC) | — | — | — | ✅ | ✅ | ✅ |
| Dashboard / Reports | — | — | — | ✅ | ✅ | ✅ |
| Products & prices | — | — | — | ✅ | ✅ | ✅ |
| **Manage staff & PINs** | — | — | — | — | ✅ | ✅ |
| **Store settings** | — | — | — | — | ✅ | ✅ |
| Cloud sync · Data/Backup | — | — | — | — | — | ✅ |

- **Staff sign-in to `/back` by store + PIN** (managers+ only; waiter/cashier/
  kitchen are sent to the till). Session **carries the role**; `/api/inv` gates
  admin-tier endpoints (owner dashboard, settings-write, agent) server-side.
- **No privilege escalation** — only an owner can appoint/edit admin/owner
  accounts; an admin manages operational roles only.
- **Permissions matrix UI** (Refunds/Discounts/Voids/Reports/Stock × roles) with
  tappable toggles, reflecting the enforced model. **Actor-stamped** — every
  sale, refund and shift records who did it.
- **Manager elevation** — sensitive till actions (refunds) re-verify with the
  **store password** (short-lived elevation token), because the PIN is a shift
  selector, not a security boundary.

---

## 9. Fiscal & compliance (Maldives / MIRA)

- **GST is tax-inclusive.** **Sector switch: GGST 8%** (general, MVR) / **TGST
  17%** (tourism, USD). *(Note: MIRA TGST is now **17%** — update our stored
  `gstBp` from 1600 → 1700 when adopting this spec.)* GST shown with its rate
  label; the excl-GST value is derived.
- **Service charge 10%, Dine-In only** (configurable; dropped for Takeaway/
  Delivery).
- **Discounts** applied at bill level before tax display.
- **MIRA receipt** with TIN + doc badge + receipt-number scheme (§3.6).
- **GST return draft** (Analytics/Reports): output GST − input GST = net payable,
  with a filing-due chip.
- **Day End / Z-Report** — gross sales by method + GST + service; **cash-drawer
  count** (−/+ stepper) → **variance** (green if reconciled); **Close day** →
  posts an **auto double-entry journal** (debits/credits + JE reference).
- **Ledger export** — accountant-ready export at read time.

---

## 10. Data model & sync contract (build the UI against this)

- **`entities(org_id, kind, id, data JSONB, deleted, rowver)`** — every business
  object. Kinds: **products, sales, orders, payments, customers, expenses, pords
  (POs), users, settings, waiterCalls, shifts, tab/waste**.
- **Sync:** `POST /api/ops` (idempotent `opId` batches) · `GET /api/pull?since=
  <rowver>` (returns rows incl. tombstones) · SSE `GET /api/events` (realtime
  poke). A sale = a `sales` entity with `lines:[{pid,qty}]` + a `payments` array.
- **Inventory/back-office API** (`/api/inv/*`, ~55 routes) covers everything in
  §4–§7 (ingredients, recipes, invoices, audits, transfer, adjust, produce,
  stockable, ocr, insights, assistant, owner, agent, accounting, customers,
  settings, expiring, reorder, menu generate/apply/import/export, onboarding,
  stores, ledger-export, me, back-login).
- **Multi-store** — `/stores`, per-store `storeId` scoping on entities + moves,
  active-store + prefs.
- Money server-authoritative; audit append-only; RLS on every table.

---

## 11. Onboarding

Guided, Maldives-defaulted (MVR, GGST 8%, Dhivehi, island/atoll), resumable
**checklist** (profile / menu / ingredients / first sale → done N of 4,
dismissible); an **AI menu-import** (snap → scan-line animation → detected EN/DV
items + prices → Add to menu); a **GST setup wizard** (business/TIN → sector →
ready). Goal: **first live sale in < 5 minutes**.

---

## 12. Prototype-screen → our-feature parity map

For each prototype register/admin screen, the feature it must be wired to. **Keep
the prototype's visuals; wire to these.**

| Prototype screen | Wire to our feature | Status vs ours |
| --- | --- | --- |
| Register (tiles+cart) | §3.2 Sell | ✅ have; add tile **descriptions**, **discount chips**, **Send-to-KOT** |
| Parked bills strip | §3.3 held/recall | ✅ have; add **timers + in-kitchen dot + colour accent** |
| Custom Order modal | §3.4 modifiers/notes | ✅ have (modifier modal) |
| Payment drawer | §3.5 | ✅ have; add **BML gateway/on-tab** methods, quick-tender chips |
| Receipt | §3.6 MIRA | ✅ have |
| Floor / Tables | §3.7 | ✅ have; add **live timers + open-value header** |
| Kitchen (KDS) | §3.8 Orders | ✅ have; add **age-tint + station tags** |
| QR Ordering | §6 guest portal | ✅ have; add **item-detail + promo + ratings** |
| Outlets | §10 multi-store | ✅ have |
| Delivery | zones + status | ✅ have (zones); add **status advance** |
| Dashboard | §4.1 Owner | ✅ have (richer) |
| Analytics | §4.11 Reports + **GST return** | ✅ have |
| Inventory | §4.5/§5 | ✅ have (deeper) |
| Expenses & Procurement | §4.8 + wastage | ✅ have |
| Receivables (Tabs) | §4.10 customers/AR | ✅ have |
| Day End (Z) | §9 | ✅ have (Reports/accounting); add **journal animation** |
| Staff & Roles | §8 | ✅ have (server-enforced); add **matrix UI** |
| Setup / Onboarding + AI import | §11 | ✅ have (P9 + Menu Builder) |
| Admin cockpit | §4 all modules | ✅ have |

**Bottom line for the design:** we already have **every feature** the prototype
shows, plus real offline sync, RLS multi-tenancy, dual-provider AI, server-
enforced RBAC, FEFO expiry, multi-store and MIRA fiscal that the prototype only
mocks. To reach parity, the prototype needs the ~10 small register/floor/KDS
polish items marked "add" above — **not** a new backend. Build its beautiful UI
on top of the contract in §10 and the rules in §2–§11.
