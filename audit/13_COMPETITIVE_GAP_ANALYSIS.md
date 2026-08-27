# 13 · Competitive gap analysis

Capability comparison against Toast, Square for Restaurants, Lightspeed
Restaurant, Oracle MICROS Simphony, TouchBistro — from their public capability
sets, not their UIs. Positioning is for this product's actual market: small
and multi-outlet F&B in the Maldives (MVR/GST/MIRA), sold direct.

## Ahead of the class (differentiators)
- **Offline depth**: durable per-op outbox, idempotent replay, install fence,
  dead-letter lane with human-readable refusals, chunked drains, offline
  SIGN-IN and full trading. Toast/Square offline modes queue payments with
  documented loss windows; this build's model is stronger and *stated*.
- **Accounting as construction**: full double-entry journal per sale in the
  same transaction, till-owned accounts, DB-level balance trigger, server-side
  tax/COGS/quantity re-derivation with repair-and-flag. Competitors export to
  QuickBooks/Xero; none keeps books this way natively.
- **Jurisdiction fit**: GGST/TGST, MIRA registration threshold logic, TIN
  invariants, MVR cash rounding, MRPS payroll — none of the majors ships this.
- **Tenancy honesty**: DB-per-business + schema-per-outlet + derived role
  passwords is stronger isolation than typical row-scoped multitenancy.
- **Evidence culture**: audit trail never pruned, every claim on screen backed
  or removed (the "control does what it says" doctrine), 500+ tests, restore
  drill in CI.

## Comparable
POS floor/KDS/QR ordering/loyalty/inventory-recipe costing/multi-outlet/
reports; backup+restore (now real, per-business); observability (metrics +
4-condition watchdog).

## Behind / missing (ranked by business value)
1. **Integrated card acquiring** — no terminal integration; references are
   operator-keyed (R-1 made this honest). High value, hardware+bank dependent.
2. **Online payment collection** (gateway for QR ordering) — recorded intent
   only today.
3. Delivery-platform integrations (no marketplace APIs).
4. Public developer API / webhooks for third parties (internal API only).
5. Native mobile apps (PWA-shaped web only; works, but no store presence).
6. Advanced labor scheduling/forecasting; CRM campaigns beyond loyalty.
7. Per-field concurrent merge (LWW today, documented).
8. Points expiry / gift cards.

Recommendation: 1–2 are the commercially meaningful gaps; 3–8 are
market-dependent. None blocks production for the current direct-sold market.
