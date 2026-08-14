# KashikeyoPOS — build instructions

A secure, offline-first, multi-location restaurant operating platform with cloud
management, local edge resilience, MVR multi-currency accounting, MIRA-ready tax
and document controls, real-time ingredient costing, inventory and procurement,
KDS, QR ordering, CRM, loyalty, payment and cash reconciliation, and business
intelligence.

Full specification: `docs/` (the handoff bundle). Read `README.md` there first,
then `08-BUILD-STAGES.md`.

## The governing principle

Every sale flows from **customer order → kitchen → payment → tax → inventory →
COGS → accounting → reconciliation → business intelligence.**

- No screen is a dead end. A financial or stock consequence must be visible and
  reachable from where it was caused.
- Nothing is entered twice. A figure captured once travels the chain.
- Every link is attributable — person, rank, timestamp, device. That is what
  makes it auditable to MIRA.
- Offline is the normal case. The chain completes locally and reconciles on
  replay, never overwriting a closed ticket.
- Costing is real-time: a dish that sells moves its ingredients and its COGS at
  the moment of sale, not in a nightly batch.

## Hard rules

- **No demo data, no hardcoded configuration.** See `docs/10-NO-DEMO-DATA.md`.
  Empty is a first-class state.
- **One rank ladder**: Kitchen 1, Till 2, Manager 3, Admin 4, Owner 5. Gate
  through `canApprove()` / `canReceive()`. Never by name or job title.
- **The phone never takes money.** Guest devices post intent; the till settles.
- **Currency is MVR**; tax is GGST/TGST per outlet, versioned by effective date
  and recorded on the sale row.
- Design values are literal. Use the exact hex, px and weight from
  `docs/01-DESIGN-TOKENS.md`.

## Tenancy — two belts

- Each outlet owns a Postgres schema (`outlet_3`) and its own login role
  (`outlet_3_app`) granted USAGE on that schema alone. Another outlet's tables
  are unreachable, not filtered.
- RLS with `FORCE ROW LEVEL SECURITY` guards the shared `chain` schema. Never
  add a table there without a policy.
- Request context is `SET LOCAL app.outlet_id / app.user_rank / app.actor /
  app.scope` — transaction-scoped, so a pooled connection cannot carry context
  forward.
- Per-outlet role passwords are derived
  (`hmac(OUTLET_ROLE_SECRET, "outlet:" + id)`), never stored. The owner
  connection is for migrations only and must never be imported by a route.
- The only cross-outlet read is `chain.estate_day()`: aggregates, rank 5,
  read-only role, audited as group scope.
- `backend/scripts/leak-test.js` proves it. It runs in CI and blocks deploy.

## Hosting

Railway: the API service builds from `platform/Dockerfile` with **root
directory `platform`** — not `backend`, which cannot see `packages/money` and
dies on the first require. Postgres is a plugin; the front-ends are static
sites built with `VITE_API_ORIGIN` set to the API's public origin. Every screen
reaches the API through `api.authed()`; a hard-coded `/api` only resolves behind
the dev proxy. `backend/test/deployable.test.js` enforces both. Runbook in
`docs/DEPLOYMENT.md`.

## Layout

```
backend/        API, migrations, provisioning, leak test
apps/pos        till + 30 back-office modules
apps/guest      QR portal
apps/member     loyalty portal
packages/       api-client, tokens, ui
docs/           this handoff bundle
design/         the HTML prototypes — the visual and behavioural reference
```

## Before every commit

```
npm run lint && npm run test:unit && npm run test:integration && npm run leak-test -- 3 4
```
