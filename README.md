# KashikeyoPOS

A restaurant operating platform for multi-outlet operators: point of sale,
kitchen display, inventory and recipe costing, purchasing, accounting through to
a trial balance, payroll, a QR ordering portal and a member card — one
application, gated by rank.

Built for the Maldives: MVR in laari, GGST and TGST as effective-dated rate
histories, MRPS payroll rules, and a service charge that is charged on the goods
and is itself taxable.

## What makes it different

**Every outlet has its own database.** Not a tenant column — its own Postgres
schema and its own login role, whose password is derived from a secret the
database never sees. On top of that, `FORCE ROW LEVEL SECURITY` on the shared
control plane, with the policies reading a context that is set inside the
request's own transaction and dies at COMMIT. `npm run leak-test` makes thirteen
crossing attempts and asserts every one fails.

**A sale is one transaction, end to end.** Ticket → sale → payment → tax →
stock move → journal → settlement. The books are posted by the server from the
sale that happened, never keyed by the till, and an unbalanced journal cannot
exist: a deferred constraint trigger refuses it at COMMIT.

**It sells while the link is down.** Every mutation carries a client-generated
id and holds in a durable outbox until the outlet's database acknowledges it.
Replaying is a no-op the second time. The network switch is real, not a demo.

**Nothing on screen is invented.** A test walks every figure in the application
on an empty install and fails on anything that is not zero, an empty state, a
statutory rate or an account code.

## Running it

```bash
npm ci
cp .env.example .env          # then set the three secrets
npm start
```

Open the service. An empty install lands on the fourteen-step onboarding panel,
which ends with you signed in on the floor. There is no seed data and no demo
account.

```bash
npm test                      # 57 tests, against a fresh Postgres
npm run leak-test             # isolation, on its own
npm run migrate               # migrations, outside the boot path
npm run provision:outlet -- --all
```

Requires Node 20+ and PostgreSQL 16.

## Documentation

- `CLAUDE.md` — the developer reference: architecture, the money rules, the sync
  contract, and how to edit the hand-written pages without breaking them.
- `DEPLOYMENT.md` — first deploy, secret rotation, backup and restore, and
  rebuilding an environment from nothing.

## Stack

Node / Express / PostgreSQL, two runtime dependencies, no build step. The
terminal and both guest portals are hand-written HTML served from disk: what
ships is the file that was read.
