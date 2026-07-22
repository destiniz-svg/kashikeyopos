# Prototype → Production upgrade — build roadmap

Folding the prototype's advanced mechanics into the live, audited production app
(`main`), **additively**, keeping Production's UI/layout/effects, on the audited
offline-first + RLS backbone. Full rationale + design: the "Kashikeyo — Production
Upgrade Plan" artifact. This file is the working checklist Claude Code follows.

## Rules
1. **Additive, not a rebuild.** Graft onto the existing backbone.
2. **Production UI is law.** Re-express prototype ideas in the `ksh-*` system.
3. **Audit-grade invariants hold.** Server-authoritative money (FIN-01–04), RLS
   on every table, offline-safe (flag never reject), append-only `activity_log`.
4. **Owner-first.** Fewer clicks, less typing, plain language, AI does busywork.

## Flow
Branch each phase off `main` (the audited base). Verify on the local Postgres
harness + Playwright, keep `npm test` green, deploy to the **test env** for a
staging check, then promote to `main` only on explicit owner sign-off.
> Note: `origin/staging` is 71 commits divergent (pre-audit line) — reset it to
> `main` before using it as the test env, or verify via harness only.

## Phases

- [x] **P0 — Foundation: cost/uptime + pooler-safety.** Direct vs pooled
  connections (`DIRECT_DATABASE_URL`), `PG_POOL_MAX`, bootPool + LISTEN on direct,
  RLS confirmed transaction-pooler-safe. Docs: `docs/scaling-and-pooling.md`.
- [x] **P1 — Bilingual menu model.** DONE. DATA: `dv`, `descDv`, `tags[]` flow
  through guest boot + till pull. RENDER: a `guest-sync-patch.js` tile patch now
  paints the Dhivehi name (RTL) + up to three tag chips between the English name
  and the price on the register menu tiles; AI images (`f.img`) already rendered.
  Only shows for items that carry the fields, so English-only menus are
  unchanged; tile alignment preserved (name div + price row untouched).
  Idempotent bake, SW bumped. Verified on the harness: Dhivehi + chips render,
  zero console errors.
- [x] **P2 — AI Menu Builder (flagship).** DONE. `/menu/generate` +
  `/menu/apply` (inventory.js) + "✨ Create with AI" modal in /back → Menu &
  Recipes. Name + one line → full bilingual item (EN+dv copy, tags, add-ons,
  allergens, price band, flat SVG image); preview → one-tap apply; NL "Modify".
  Graceful degrade w/o key. /back = no bake/SW bump. Verified: apply round-trips
  to boot/pull; UI modal + preview render, zero console errors. Live Claude call
  needs ANTHROPIC_API_KEY (owner sets in Railway) — same as OCR/assistant.
- [x] **P3 — Expiry & shelf-life.** DONE. `ingredient_lots` (RLS, granted);
  use-by date per delivery line → lot; `/expiring` allocates current_stock
  across lots FEFO at read time (never touches the sale path) with tiered
  expired/today/soon/week/later; /back Deliveries "Use-by" column + expiry chips
  in the alert bar. Verified: FEFO depletion + UI, 37/37 tests.
- [x] **P4 — Automated stock + Auto-PO.** DONE. `/reorder/draft` turns the
  velocity reorder list (computeInsights) into draft POs grouped by each
  ingredient's usual supplier (learned from purchase history — no data entry);
  `/reorder/approve` writes them as `pords` entities (source:auto) so they land
  in the same PO list the till raises and receive as a pre-filled delivery.
  /back Deliveries "🔄 Auto-reorder" modal (editable qtys). PO `unit` now flows
  through receive so pack quantities convert correctly. Verified end-to-end.
- [x] **P5 — Automated accounting + Reports.** DONE. Computed (not posted) —
  `/accounting` derives P&L, GST return & cash position from source at read time
  (same offline-safe model as ledger-export; no fragile journal to keep in sync).
  Perpetual COGS so inventory purchases aren't double-counted; expenses split
  purchases (→COGS) vs opex. /back "Reports" tab: range chips, P&L / GST / cash
  cards, CSV export. Verified: revenue/COGS/gross/opex/net + GST + tenders all
  correct on a real scenario; 37/37 tests.
- [x] **P6 — Owner Panel + menu engineering.** DONE. `/owner`: KPIs vs previous
  period (revenue Δ, gross/net margin, orders, avg, food-cost %, cash, AR);
  Magic Quadrant (Kasavana-Smith popularity × contribution margin → stars/
  plowhorses/puzzles/dogs); price-fluctuation alerts; merged actionable alerts
  (reorder+expiry+margin+tabs); per-outlet revenue; deterministic guided read
  (AI-key-free). New /back "Owner" tab = default landing: KPI hero, read banner,
  attention list, quadrant grid, outlet cards. Verified end-to-end; 37/37 tests.
- [x] **P7 — Agentic control.** DONE. Two-phase + guarded: `/agent/interpret`
  (Claude structured output → ONE concrete action against this store's own
  catalogue; server resolves to explicit targets — never lets the model write)
  → confirm-diff → `/agent/execute` (86/restore, hide/show, reprice single or by
  category-%; RLS-scoped, audit-logged; reports answer read-only). Command bar on
  the Owner dashboard. Graceful degrade w/o key. Fixed an audit-log bug (wrong
  signature + nested withOrg) that also silently affected P2/P4 logging.
  Verified: execute persists (soldOut survives reprice) + writes activity_log;
  UI confirm-diff renders; 37/37 tests.
- [~] **P8 — Manager cockpit gaps.** Customers + Settings DONE. `/customers`
  (list + owing/owed) + `/customers/:id` (balance, points, payments, orders);
  `/settings` GET/PUT (store profile, GST sector 8/16%, 10% service charge,
  loyalty, TIN, receipt footer) → settings entity + poke so the till follows.
  /back "Customers" (list + detail modal) and "Settings" (profile + tax form)
  tabs. Verified. DEFERRED: Staff & roles (needs the till PIN/auth model
  designed first — a separate decision).
- [x] **P9 — Guided onboarding.** DONE. `/onboarding` computes a resumable
  first-run checklist from live data (profile / menu / ingredients / first sale
  → done N of 4, dismissible); `/onboarding/dismiss` persists the skip on the
  settings entity. /back Owner tab shows a "Getting started" card at the top:
  per-step ✓/todo, plain-language hints, "Do it →" deep-links (`go(tab)`),
  "Open the till", and "skip". Maldivian defaults (MVR, GGST 8%) already seed on
  register; starter-menu seeding rides the P2 AI Menu Builder. Verified:
  fresh store returns 2/4 → checklist renders, deep-links + skip work, zero
  console errors; 37/37 tests.
- [~] **P10 — Convenience & hardening.** CODE DONE. a11y sweep across all 12
  /back tabs: DOM audit found the surface already strong (role=dialog + focus
  trap + Escape + focus-restore + auto-label via `a11yEnhance`/MutationObserver,
  modals autofocus their primary field — less-typing already covered); fixed the
  two gaps — `aria-label` on the delivery-line `<select>` and active-tab
  scroll-into-view so the 12-tab bar never hides the current section on
  tablet/mobile (verified: last tab visible + no page jump at 1280/1024/768/
  390 px). Full regression: 37/37 tests green, zero console errors walking every
  tab. REMAINING (owner/deploy-gated, not code): 24 h soak on the test env,
  axe/Lighthouse on the baked till `/app` + guest `/p/:slug` (those need a
  browser run against a deployed build), and promote to `main` on sign-off.

## Market notes (Lightspeed / AgenticPOS)
- Magic Menu Quadrant + live food-cost/price-fluctuation alerts → P6.
- "Run it in plain English" agentic actions → P7.
- Autonomous reorder → P4. Reservations → deferred/opt-in.
