# Prototype → Production — Build-Order Checklist

The **reverse** of `feature-spec-master.md`. That doc says *what* every feature is;
this says the **order to build them** so a Claude (or any implementer) can turn
the `Masterclass_App_Prototype_3` design into a production app that reaches
**exact feature parity** with KashikeyoPOS — keeping the prototype's visuals,
wiring to our contract.

**Rules of engagement**
- **Design is fixed** (hifi): match the prototype's tokens, type, spacing, radii,
  motion pixel-for-pixel. Pull copy from the `T` object (EN + Dhivehi).
- **Do not port the `.dc.html` runtime.** Rebuild in a real stack (React+TS
  recommended) on our **sync contract** (§10 of the master spec).
- **Every phase ends green:** it builds, it's usable offline, money reconciles on
  the server, and the acceptance checks pass. Ship phase-by-phase, never big-bang.
- Spec refs below (§) point into `feature-spec-master.md`.

---

## B0 — Foundations & contract (do first, nothing works without it)
- **State & data layer:** IndexedDB (Dexie) mirror + a sync engine implementing
  `POST /api/ops` (idempotent `opId`), `GET /api/pull?since=<rowver>` (merge incl.
  tombstones), SSE `GET /api/events` (poke). Offline outbox + replay (15 s / on
  reconnect) + synthetic-success. *(spec §2.1, §10)*
- **Auth:** PIN sign-in → per-staff session carrying **role**; store the cloud
  pairing in localStorage. *(§3.1, §8)*
- **Money rule baked in from day 1:** never compute a final total client-side —
  send the cart, trust the server's totals/tax/service/change. *(§9)*
- **i18n/RTL + theming primitives:** language store with full RTL mirroring +
  Thaana font; the 5-palette token system (light/dark). *(§2.2, §2.3)*
- **Accept:** app boots offline, signs in by PIN, pulls the catalogue, survives a
  network drop and replays a queued write.

## B1 — Global shell & chrome
- Icon rail (desktop) ↔ bottom tab bar (mobile); header (outlet dropdown, GST
  sector pill, clock, **network pill** Online/Offline/Syncing, EN/ދިވެހި toggle,
  Admin link, theme toggle). Responsive breakpoints via a `vw` state. *(§3, §2.1)*
- **Accept:** every breakpoint renders without clipping; network pill reflects
  real connectivity + outbox depth.

## B2 — Register (the flagship) *(§3.2)*
- Search + category chips + tile grid. **Tile** = image/emoji, EN + **Dhivehi**
  name, **tag chips**, **short description**, price, ★ best-seller, **sold-out**
  (from availability §5.4), on-tile stepper / coral +.
- Cart panel: order # + Hold/Clear, **order-type segmented (Dine/Take/Delivery)**,
  **table picker** (Dine-In), Add customer, line steppers, **discount chips**,
  totals with **service-charge-dine-in-only** + GST label, **Send to KOT** +
  **Charge**. Reset on new sale.
- **Accept:** a full dine-in order builds, totals match the server, KOT fires
  once, state resets cleanly.

## B3 — Hold / recall + parked-bills bar *(§3.3)*
- Hold parks the whole order; the strip shows bill#, table/customer tags, count,
  total, **in-kitchen dot**, **elapsed timer**, colour accent by type; tap=recall,
  ×=delete; persists until settled/deleted.
- **Accept:** park → recall restores everything; timers tick; settle removes it.

## B4 — Modifier / Custom-Order modal *(§3.4)*
- Photo + name/desc + qty stepper + **3×4 keypad** (synced), **Notes**
  (`dir=auto`, persists to line + KOT), options (variants/spicy/add-ons) with
  Free/price. Line total = (base + options) × qty. Empty-options items still open.
- **Accept:** options + notes flow into the cart line and the KOT ticket.

## B5 — Payment + Receipt *(§3.5, §3.6, §9)*
- Payment drawer: total due, **split (1–4)**, methods **Cash / Card / BML Gateway
  / Transfer / On tab**; cash quick-tender + **change due**; card/QR **reference**;
  on-tab → receivables. Confirm gated by method requirements.
- On confirm → success animation → **MIRA receipt** (TIN, doc badge, `MLE-R1-…`
  no., `-OFF-` offline, order type/table, discount/service/GST lines, Thaana
  thank-you, tear edge) → KDS ticket → totals update → outbox++ if offline.
- **Accept:** server total = drawer total; change correct; receipt fields exact;
  an offline sale queues + prints `-OFF-`.

## B6 — Floor / Tables + KDS *(§3.7, §3.8)*
- **Floor:** live table map, occupied = held/active dine-in, per-tile count +
  running bill + **elapsed timer** + in-kitchen tag; seat free / recall occupied;
  header Occupied/Free + **Open value**; Other-open-orders list.
- **KDS (Orders):** ticket grid, **age-tint** (green<5/amber<10/red10+), source
  (`POS·T#`/Takeaway/Delivery/`QR·T#`), MM:SS timer, **station tags**, **Bump ✓**.
  Idempotent bump (survives in-flight pull).
- **Accept:** Send-to-KOT and Charge both surface tickets; ages tint correctly;
  bump can't be resurrected.

## B7 — Guest / QR portal *(§6)*
- Three views (Menu / Item-detail with add-ons+notes+rating / Order-summary with
  **promo code** + payment summary) → drops a `QR·T#` ticket onto B6's KDS. Member
  profile: rewards/tiers/order-again + **dues/pay**. Themed per store, bilingual,
  honours sold-out.
- **Accept:** scan→order→kitchen with zero re-keying; promo applies; sold-out hidden.

## B8 — Inventory & supply engine *(§5)*
- Ingredients (base unit, cached stock, weighted avg cost, min, location, roles);
  **stock_moves** ledger as source of truth; recipes/BOM; per-location + transfers;
  **availability engine** → sold-out; **FEFO lots** + `/expiring`; **auto-reorder**
  → draft POs by learned supplier. Wire the till's sold-out state to this.
- **Accept:** a sale draws stock via the ledger; a recipe product goes sold-out at
  0 servings; expiring lots surface FEFO.

## B9 — Management modules (back office) *(§4)*
Build in this order (each reuses B8 + the sync contract):
1. Owner dashboard (KPIs vs prev, **Magic Quadrant**, attention list, guided read,
   **agent command bar**).
2. Reports (P&L / **GST return** / cash / tenders, CSV). *(§9)*
3. Deliveries (invoice → stock+cost+expense, **use-by→lot**, **OCR scan**,
   auto-reorder, receive POs).
4. Menu & Recipes (+ **AI Menu Builder**), Stock Check (audit wizard),
   Suppliers, Customers/AR, Expenses, Wastage, Settings.
- **Accept:** each module round-trips to the same entities the till uses; numbers
  reconcile with Reports.

## B10 — AI layer *(§7)*
- Provider-agnostic client (**Anthropic or Gemini** by key; `AI_PROVIDER`,
  `GEMINI_MODEL`). Four features: **Menu Builder**, **Assistant** (grounded),
  **Agent** (guarded interpret→confirm-diff→execute), **OCR**. All degrade
  gracefully with no key.
- **Accept:** with a key each returns real output; with none, the deterministic
  parts still work and show "not set up yet".

## B11 — RBAC & staff *(§8)*
- Six roles; **client hide + server 403**; **PIN sign-in to /back** (managers+);
  no-escalation (only owner appoints admin/owner); **permissions-matrix UI**;
  actor-stamping; **manager elevation** (store password) for refunds.
- **Accept:** a manager session is 403'd from owner/settings endpoints, not just
  hidden; a waiter can't reach /back.

## B12 — Fiscal, Day-End & compliance *(§9)*
- Sector switch **GGST 8% / TGST 17%**; service-charge dine-in-only; MIRA receipt;
  **GST return draft**; **Day-End Z-report** (method/GST/service breakdown, cash
  count → variance, **Close day → double-entry journal** + JE ref); ledger export.
- **Accept:** Z-report reconciles to the day's sales; journal balances; GST return
  = output − input.

## B13 — Onboarding *(§11)*
- Maldives defaults, resumable **checklist**, **AI menu-import** (snap→scan→add),
  **GST setup wizard**. Target: first live sale < 5 min.
- **Accept:** a fresh store reaches first sale via the checklist without docs.

## B14 — Hardening & parity sign-off
- a11y (labels/roles/focus/contrast), 24 h soak, full regression, offline soak,
  RTL pass, dark-mode pass on every screen. Tick every row of the master spec §12.
- **Accept:** the §12 parity map is 100% green; nothing in the feature spec is
  missing.

---

### Dependency order (critical path)
`B0 → B1 → B2 → B5` gets you a sellable till fastest. `B8` unblocks sold-out +
B9. `B6/B7` need B2's cart + B8's availability. `B10/B11/B12` layer on top. Do
**B0 and B5's server-total rule first** — they're the two places a shortcut
becomes a data-integrity bug later.
