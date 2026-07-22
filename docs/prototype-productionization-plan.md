# Build Plan — Productionize the Prototype on our Backend

**Goal.** Turn `Masterclass_App_Prototype_3` (premium design, mock logic) into a
real product by **keeping its UI/UX exactly** — especially the **register, order
tab, and bill status** the owner likes — and wiring it to the **backend and
features we already shipped to production** (`main`). Reuse everything: sync,
RLS, AI engine, accounting, RBAC, inventory/FEFO, MIRA fiscal. Build **feature by
feature** against `main`'s code.

This is a **front-end rebuild on a proven backend**, *not* a new system. The
backend barely changes; the win is the prototype's design + finally getting the
till's logic into clean, editable source.

---

## 1. Research findings (why this is the right shape)

### 1.1 What the prototype is, technically
- Design reference authored in HTML on an in-house runtime (`support.js`, the
  `.dc.html` template + logic class). **Not production code** — the README says
  to *recreate*, not port the runtime.
- Its register is a **clean, self-contained logic class**: a flat `state`
  (`cart[], mod, sector, cat, query, held[], tables…`) with methods
  `totals()`, `sendKot()`, `holdOrder()`, `recallHeld()`, `seatTable()`,
  `finishPay()`, `renderVals()`. **This is straightforward to re-implement 1:1 in
  React/TS while keeping the exact behaviour.** → the owner's "keep the register
  as-is" is low-risk.
- Copy is finalized bilingual (the `T` object); tokens/spacing/motion are hifi
  and final.

### 1.2 What our backend already gives us (the reuse)
Our `main` backend is **client-agnostic** — the current baked till is just one
client of it. A new front-end talks to the same API:
- **Sync contract:** `POST /api/ops` (idempotent `opId` batches), `GET
  /api/pull?since=<rowver>` (rows incl. tombstones), SSE `GET /api/events`,
  `/api/register`, `/api/login`, `/api/back/login` (role sessions).
- **~55 `/api/inv/*` endpoints:** owner dashboard, accounting/GST, insights,
  reorder, menu generate/apply/import, **agent**, **assistant**, **ocr**,
  customers, settings, audits, invoices, expiring/FEFO, stores, ledger-export.
- **AI engine:** provider-agnostic (Anthropic **+ Gemini**) already wired and
  degrading gracefully.
- **Guest:** `/p/:slug/*`. **Data model:** `entities` + `stock_moves` + RLS +
  laari money, all done.

**Conclusion:** ~90% of the "missing" prototype features are **backend features
we already have** — the prototype just needs to *call* them. The real new work is
**client-side**: rebuild the UI + an offline-first sync client. Net backend
change is small (§5).

### 1.3 The one substantial new piece: the offline-first sync client
The current baked till has offline logic we **cannot edit** (minified). The new
front-end reimplements it in clean source — an IndexedDB mirror + outbox +
`ops/pull/events` engine. This is a feature, not a cost: it's the "native
frontend rebuild" our own `cloud-architecture.md` flagged as the long-term win.

---

## 2. Recommended architecture

| Layer | Choice | Why |
| --- | --- | --- |
| **Stack** | **React + TypeScript + Vite + Tailwind** | Prototype's recommended target; our baked till is already React; Tailwind maps cleanly to the prototype's token/utility style. |
| **State** | Lightweight store (Zustand) + a sync layer | Mirrors the prototype's flat `state`; keeps the register logic a direct port. |
| **Offline** | Dexie (IndexedDB) mirror + outbox + replay | Reimplements the proven `ops/pull/events` contract in source. |
| **Backend** | **Reuse `main` as-is** | Express + PG + RLS + AI + accounting — unchanged. New FE is just another client. |
| **Auth** | PIN sign-in (till) + `/api/back/login` (role sessions) | Already built. |
| **i18n/RTL/theme** | React i18n + RTL mirroring + the 5-palette tokens | Pull copy from the prototype `T`; tokens from its helmet. |

### 2.1 Coexistence & cutover (zero risk to live production)
- Build the new app in-repo as `web2/` (source) → built bundle served at a **new
  route `/app2`** (and `/back2`), **alongside** the current `/app` + `/back`.
- Production keeps running on the current till the entire time. The new app is
  reachable only to those who opt in, on the same backend + data.
- When the new app passes the **parity checklist** (feature-spec-master §12) on
  staging, **flip `/app` → the new build** (one server route change) and retire
  the baked bundle. Instant rollback = flip the route back.
- This is the same safe staging→main flow we've been using.

---

## 3. Feature-by-feature build order (each phase = shippable + verified)

> Register/order/bill screens are **rebuilt to match the prototype exactly**;
> management/AI screens keep the prototype's look but are wired to our endpoints.

### PP0 — Foundations
Vite+TS+Tailwind scaffold; design tokens + fonts (incl. Thaana) from the
prototype; i18n + **RTL mirroring**; 5-theme system; **auth** (PIN + back-login);
the **offline-first sync client** (Dexie mirror, outbox, `POST /api/ops`, `GET
/api/pull`, SSE `/api/events`); network pill. Served at `/app2`.
*Accept: boots offline, signs in, pulls catalogue, replays a queued write.*

### PP1 — Register (keep the prototype's, wired) ⭐ owner's priority
Port the prototype register 1:1: tile grid (photo/emoji, name+**dv**+tags+
**desc**, best-seller, **sold-out** from availability), search + category chips,
cart panel (order-type segmented, **table picker**, on-tile steppers, **discount
chips**, **Send-to-KOT**, Charge), **parked-bills bar** (bill#, table/customer
tags, in-kitchen dot, **elapsed timer**, colour accent), **hold/recall**. Persist
as `sales`/`orders` entities via `/api/ops`; **server recomputes money** on
charge (our FIN invariant); `totals()` becomes display-only.
*Accept: a dine-in order builds, holds, recalls, fires KOT once; server total =
client total.*

### PP2 — Payment + Receipt
Payment drawer (split 1–4, Cash/Card/BML/Transfer/On-tab, quick-tender, change),
success animation, **MIRA receipt** (TIN, `MLE-R1-…`, `-OFF-` offline, discount/
service/GST lines, Thaana), on-tab → receivables.
*Accept: server total = drawer; offline sale queues + prints `-OFF-`.*

### PP3 — Floor + KDS (order tab & bill status the owner likes)
Live table map (occupied/free, running bill, **elapsed timer**, in-kitchen tag,
seat/recall, open-value header); KDS ticket grid (**age-tint**, source, MM:SS,
station tag, **Bump**). Backed by `orders` entities + SSE poke.
*Accept: Send-to-KOT + Charge both surface tickets; bump is idempotent.*

### PP4 — Back panel: Owner dashboard + Reports (**first back-panel win**)
Wire the prototype Dashboard → `/api/inv/owner` (KPIs, **Magic Quadrant**,
attention, guided read) and Analytics → `/api/inv/accounting` (P&L, **GST
return**, cash, tenders, CSV). Range chips.
*Accept: numbers reconcile with production's `/back`.*

### PP5 — AI engine (the owner's called-out gap) ⭐
Wire the four AI features to our provider-agnostic endpoints — **no new backend**:
**Menu Builder** (`/menu/generate`+`/menu/apply`), **Assistant** (`/assistant`),
**Agent** (`/agent/interpret`→confirm-diff→`/agent/execute`), **OCR** (`/ocr`).
Setup's "AI menu-import" → `/menu/import`+`/ocr`. Graceful-degrade UI when no key.
*Accept: with a Gemini/Anthropic key each returns real output; without, the
deterministic parts still work.*

### PP6 — Inventory & supply suite
Ingredients, Recipes/BOM, Stock Check (audit wizard → `/audits`), Deliveries
(`/invoices` + **use-by→lot** + **OCR** + **auto-reorder** `/reorder/*`),
Suppliers, Wastage/Adjust, Expenses. Wire sold-out to the availability engine.
*Accept: a sale draws stock via the ledger; a recipe product goes sold-out at 0.*

### PP7 — Customers/AR, Day-End/Z, Staff & Roles, Settings
Customers + receivables (`/customers`), **Day-End Z-report** (drawer count →
variance → journal animation over `/accounting`), **Staff & Roles** (permissions
matrix + **PIN back-login** + server-enforced gates), Settings (`/settings`,
GGST 8% / **TGST 17%**, service charge, loyalty, TIN, receipt).
*Accept: a manager session is 403'd server-side from owner/settings; Z-report
reconciles.*

### PP8 — Guest / QR portal
Rebuild the prototype guest phone app → real `/p/:slug`: menu, item-detail
(add-ons, notes, rating), order summary (**promo code**, payment summary) → drops
a `QR·T#` KDS ticket; member profile (rewards/tiers/**dues-pay**). Themed,
bilingual, honours sold-out.
*Accept: scan→order→kitchen with no re-keying.*

### PP9 — Onboarding + Setup
Maldives-defaulted resumable checklist (`/onboarding`), AI menu-import, GST
wizard. First live sale < 5 min.

### PP10 — Parity, hardening, cutover
a11y, offline/RTL/dark soak, 24 h soak, tick **every row of feature-spec §12**,
then **flip `/app` → the new build**. Retire the baked bundle.

---

## 4. Dependency / critical path
`PP0 → PP1 → PP2` = a sellable register fastest (the owner's priority screens).
`PP3` needs PP1's cart. `PP4/PP5` (dashboard + AI) are independent once PP0's
sync client exists — can run in parallel with PP2/PP3. `PP6` unblocks sold-out.
Do **PP0's sync client + PP2's server-total rule first** — the two places a
shortcut becomes a data bug.

---

## 5. Backend gap analysis (what's genuinely new — small)
The backend is ~done. New/small additions only:
1. **KDS station field** per product (`station`: HOT KITCHEN / DRINKS) + a
   settings toggle → for ticket routing. *(schema: add to product entity; ~S)*
2. **Promo codes** for the guest portal (validate + apply) → one endpoint +
   entity. *(~S)*
3. **Delivery status advance** (Preparing→On-the-way→Delivered) on `orders`.
   *(~S — orders already carry status)*
4. Everything else (AI, accounting, RBAC, inventory, FEFO, receipts, multi-store)
   is **already exposed** — the new FE just calls it.

*(S = small, ~1 endpoint/field each. No re-architecture.)*

---

## 6. Risks & mitigations
| Risk | Mitigation |
| --- | --- |
| Big front-end rebuild scope | Phase it (PP0–PP10), each shippable; register-first delivers the owner's priority early. |
| Disturbing live production | **Coexistence at `/app2`** on the same backend; flip only after parity sign-off; instant route rollback. |
| Offline correctness | Reuse the *proven contract* (`ops/pull/events`); server stays authoritative on money; soak-test offline before cutover. |
| Design drift from prototype | Tokens/copy pulled verbatim from the `.dc.html`; parity checklist gates cutover. |
| Two front-ends during transition | Same backend + data, so no divergence; the old one is read-only-safe and retired at cutover. |

---

## 7. Recommendation & sequencing
1. **PP0 + PP1 + PP2 first** — stand up the prototype register on our backend at
   `/app2`. This proves the whole approach and delivers the screens the owner
   most cares about, live on real data, without touching production.
2. Then **PP5 (AI) + PP4 (dashboard)** in parallel — the owner's called-out gaps,
   pure wiring to endpoints we already ship.
3. Then PP3, PP6–PP9; finish with PP10 parity + cutover.

**Effort:** a multi-phase front-end rebuild (the backend is done). Highest-value,
lowest-risk order is register-first at `/app2`. Nothing here touches `main` until
the final one-line route flip, and that's fully reversible.

> This plan is the concrete counterpart to `feature-spec-master.md` (what to
> build) and `prototype-build-order.md` (generic order) — specialized for
> *reusing our backend* and *keeping the prototype's register*.
