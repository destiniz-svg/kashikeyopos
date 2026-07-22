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
- [~] **P1 — Bilingual menu model.** DATA DONE: `dv`, `descDv`, `tags[]` flow
  through guest boot + till pull (verified). RENDER PENDING: showing short
  description + tag chips + Dhivehi on the baked till/guest tiles needs a
  `guest-sync-patch.js` bundle patch (fragile minified surgery) — held for a
  supervised pass / decision on approach.
- [ ] **P2 — AI Menu Builder (flagship).** Name + one line → full item (EN+dv
  copy, tags, add-ons, allergens, price hint, AI image); one-tap apply; NL modify.
  Reuse `@anthropic-ai/sdk` OCR/assistant path; graceful degrade w/o key.
- [ ] **P3 — Expiry & shelf-life.** `ingredient_lots`, use-by on delivery, FEFO
  depletion, tiered spoilage alerts.
- [ ] **P4 — Automated stock + Auto-PO.** Velocity reorder points from
  `stock_moves`; draft POs per supplier; PO → pre-filled delivery.
- [ ] **P5 — Automated accounting + Reports.** `journal` + `journal_lines`,
  auto-post on sale/expense/delivery/wastage/close; P&L, GST return draft, CSV/PDF.
- [ ] **P6 — Owner Panel + menu engineering.** Business-status hero, guided daily
  read, suggestions/alerts, multi-store compare, Magic Quadrant (popularity ×
  margin), price-fluctuation/COGS alerts.
- [ ] **P7 — Agentic control.** Guarded natural-language action layer over
  existing endpoints (86/price/hide, wastage, PO approve, reports); idempotent,
  RLS-scoped, confirm-diff, audit-logged. Command bar in Owner Panel + /back.
- [ ] **P8 — Manager cockpit gaps.** Customers, Staff & roles + auth codes,
  store-profile + tax/method config, sales history — on /back tabs.
- [ ] **P9 — Guided onboarding.** Maldivian defaults (MVR, GGST 8%, Dhivehi,
  island/atoll), AI-seeded starter menu, few-click resumable checklist.
- [ ] **P10 — Convenience & hardening.** Less-typing sweep, a11y (axe/Lighthouse
  on /back, /app, /p/:slug), 24 h soak, full regression, promote.

## Market notes (Lightspeed / AgenticPOS)
- Magic Menu Quadrant + live food-cost/price-fluctuation alerts → P6.
- "Run it in plain English" agentic actions → P7.
- Autonomous reorder → P4. Reservations → deferred/opt-in.
