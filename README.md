# KashikeyoPOS

A secure, offline-first, multi-outlet restaurant operating platform for the
Maldives: point of sale, kitchen display, inventory and real-time costing,
procurement, accounting, loyalty, and two guest-facing portals. Currency is MVR;
tax is GGST/TGST per outlet, MIRA-ready.

Every sale flows from **customer order → kitchen → payment → tax → inventory →
COGS → accounting → reconciliation → business intelligence**, and no link in
that chain is a dead end.

## Layout

```
backend/     API, migrations, provisioning, the leak test
apps/pos     37 modules — the till, the KDS and the back office
apps/guest   QR ordering portal
apps/member  loyalty portal
packages/    money (the one bill calculation), api-client, tokens, ui
docs/        the specification bundle — start at docs/README.md
design/      the HTML prototypes: the visual and behavioural reference
```

## Running it

Postgres 16+ and Node 20+. The server does **not** migrate on boot as a side
effect — migrating is its own step, so a deploy that cannot see its database
never goes healthy.

```
npm install
cp backend/.env.example backend/.env     # then fill it in
npm run migrate
npm -w backend start
```

## Before every commit

```
npm run lint && npm run test:unit && npm run test:integration && npm run leak-test -- 3 4
```

`leak-test` is not optional decoration: it provisions two outlets and tries, as
one of them, to read the other's rows through every door it can find. It blocks
a deploy.

## Two things to know before changing anything

**Tenancy is two belts.** Each outlet owns a Postgres schema (`outlet_3`) and
its own login role (`outlet_3_app`) granted USAGE on that schema alone, so
another outlet's tables are *unreachable*, not filtered. `FORCE ROW LEVEL
SECURITY` guards the shared `chain` schema. Identity comes from the database
role, never from a request-supplied setting.

**Money is integer laari** (MVR × 100) everywhere. Menu prices are
GST-inclusive and tax is *extracted*, never added on top. There is exactly ONE
bill calculation — `packages/money/money.js` — loaded by the browser as a script
and by the server via `require`. A second copy is the single failure this
codebase is most careful about.

`CLAUDE.md` holds the working notes for anyone, human or otherwise, picking this
up mid-stream.

## Branches

This application has its own history. It was built from scratch against
`docs/`, and its root commit has no parent and no ancestor in common with the
previous codebase that used to live in this repository — nothing merges between
the two by design.

| branch | what it is |
|---|---|
| `platform/main` | production |
| `platform/staging` | verified here first, then promoted to `platform/main` |
| `prod-backup-*`, `rollback/*` | the previous codebase, preserved |
