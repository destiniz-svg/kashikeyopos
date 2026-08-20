# KashikeyoPOS — developer reference

Read this before changing anything. It describes how this build actually works,
so you do not have to re-derive it from 31,000 lines.

This is a **rebuild**. The previous app (`index.js`, `web/`, `web2/`, `web3/`,
`inventory.js`, `schema.sql`) was removed in full, along with its database. If
you find a document describing `serveProto()`, `dc-template` under `web2/proto`,
`/v2`, `/admin`, `entities(org_id, kind, id, data JSONB)` or an org-scoped RLS
model, it describes the OLD app and none of it is true here.

## Stack

Node 22 / Express 4 / PostgreSQL 16. CommonJS. **Two runtime dependencies**
(`express`, `pg`) and nothing else — no ORM, no bundler, no build step. The
terminal, the onboarding panel and both guest portals are hand-written HTML in
`app/`, served from disk: what ships is the file that was read. Edit, restart,
reload.

```
server.js              headers, health, static, routes, boot
src/db.js              pools, per-request transaction context, checked commit
src/secrets.js         the three secrets, token signing, scrypt PINs
src/provision.js       creating an outlet's schema + login role
src/bootstrap.js       everything the terminal needs to come up, in one payload
src/apply.js           the 115 op kinds and what each one consequences
src/auth.js            rank gates
src/routes/            auth · onboarding · outlet · sync · guest · estate · pages
src/migrations/        001 control · 002 RLS · 003 outlet plane · 004 chart
                       005 sign-in · 006 statutory · 007 member access
app/index.html         the terminal (POS, KDS, back office) — one app, gated by rank
app/onboarding.html    the fourteen-step panel an empty install lands on
app/guest.html         the QR portal
app/member.html        the member card
app/kashikeyo-rules.js allergen + diet rules, loaded by BOTH browser and server
app/kashikeyo-data.js  structure that ships (chart, ranks, units, labels) — no trade
app/kashikeyo-api.js   the durable outbox and the API client
app/kpos-bridge.js     terminal ↔ API
app/guest-bridge.js    guest portal + member card ↔ API
```

## Isolation: two belts, and they are not the same belt

**Belt one — a schema and a login role per outlet.** `chain.provision_outlet()`
creates `outlet_<id>` and `outlet_<id>_app`, grants that role `USAGE` on that
schema alone, revokes `public`, and pins its `search_path`. Two outlets share an
instance and share no reachable object. The role's password is **derived, never
stored**:

```
password = hmac_sha256(OUTLET_ROLE_SECRET, "outlet:" + id)
```

Nothing readable inside the database yields another outlet's credentials. The
cost is a rotation step — see `npm run provision:outlet`.

**Belt two — `FORCE ROW LEVEL SECURITY` on the shared control plane** (`chain.*`:
company, outlet, staff, device, session, tax_version, doc_series, member,
supplier, setting, audit). The policies read the transaction's own context.

**The context is transaction-scoped.** Every request runs inside `withOutlet()` /
`withOutletRead()`, which `SET LOCAL app.outlet_id / app.user_rank / app.actor /
app.scope / app.device` via `set_config(..., true)`. It dies at COMMIT, so a
pooled connection cannot carry one request's identity into the next.

The owner connection (`owner()`) runs migrations and provisioning only. **No
request handler imports it** — the owner role bypasses both belts.

`npm run leak-test` makes thirteen crossing attempts (read another outlet's
sales, write its stock, forge a rank, reach the estate aggregate without rank 5,
…) and asserts every one fails. It runs in CI, inside `test/api.test.js`.

The one deliberate cross-outlet read is `chain.estate_day(date)`: aggregates
only, rank 5, group scope, through the read-only `kashikeyo_report` role, and
audited.

## Ranks

Kitchen 1 · Till 2 · Manager 3 · Admin 4 · Owner 5. That ladder is the **only**
gate. `atLeast()` enforces it on the route, and the RLS policies say
the same thing underneath, so a bug in a handler cannot get past the database.

A gated action REFUSES with wording — "this needs a manager" — rather than
vanishing. A screen that disappears teaches an operator the app is broken.

## The chain of consequence

```
ticket → sale → payment → tax → stock_move → journal → settlement
```

One transaction. `applySale()` in `src/apply.js` writes the sale, its lines, its
tenders, its stock moves at weighted average cost, and the full journal —
tender, revenue, discount, service, tax, rounding, COGS — derived from the sale
that just happened, never keyed by the till.

The server **never rejects a sale**: a cashier has already taken the money. It
recomputes from the components, repairs the row into a consistent one, and
stamps the discrepancy in `sale.server_audit` beside `sale.client_total` for
someone to answer for.

A deferred `CONSTRAINT TRIGGER` refuses an unbalanced journal at COMMIT. Nine
accounts are till-owned (1010, 1030, 1040, 1200, 2200, 4000, 4100, 4200, 4900)
and a manual journal to any of them is refused.

## Money

**GST is EXCLUSIVE in this build.** The menu price is the net; service is
charged on the net; tax is charged on net + service:

```
svc   = net × serviceRate
tax   = (net + svc) × taxRate
total = net + svc + tax
```

Cash rounds to the nearest 50 laari and the difference posts to 4900.

Note for anyone reading the handoff package: `03-THE-CHAIN.md` describes prices
as tax-INCLUSIVE. The shipped reference — the till, the QR app and the member
portal alike — computes tax on top. The files won, per the package's own "one
rule"; the prose is wrong. If that is ever changed it must change in all four
places at once, and `test/api.test.js` will tell you if it did not.

A store's tax rate is read from its own `chain.tax_version` row, effective-dated.
`NONE` is a real answer: a business that is not GST-registered charges nothing,
and `0 || 8` silently turning that into 8% is a bug this build refuses to ship.

## Sync

Every mutation in the terminal goes through **one seam**, `queue()`, which
stamps a client-generated v4 `opId` and hands it to the durable outbox in
`app/kashikeyo-api.js` (IndexedDB, keyed by `opId`). `POST /api/outlet/:id/sync/
push` applies each op inside its own savepoint; `op_log.op_id` is the primary
key and the insert is `ON CONFLICT DO NOTHING RETURNING`, so a replay is a
no-op and a duplicate inside one batch cannot abort the batch.

115 op kinds, all handled. 28 are deliberately audit-only and are **named** in
`AUDIT_ONLY`, so "not modelled yet" and "audit-only by design" stay
distinguishable. `test/wiring.test.js` asserts both halves meet.

The network pill is a real switch (`KPOS_BRIDGE.setOffline`), not a simulation:
offline means nothing is POSTed and every write holds durably until it is
flipped back. An op the server refuses stays queued, with the reason it gave.

## Allergens and diets

One table, in `app/kashikeyo-rules.js`, loaded by the browser as a script and by
the server as a module. **Do not add a second copy** — there were two, with
different key vocabularies ("shellfish" vs "crustacean"), so a diet that blocked
one never blocked the other.

A **guest device holds no recipe** (a recipe is a cost sheet). So the
declaration is derived where the recipe lives — `publishDeclaration()` in
`src/apply.js`, on every `dish_upsert`, `recipe_update` and `item_upsert` — and
published onto the item. A dish nobody has written a recipe for **claims
nothing**: silence beats an unearned "Vegetarian" on a reef fish.

## No invented figures

Every ribbon card is a number a manager acts on. `test/audit.test.js` walks
every ribbon at every rank on an empty install and fails on anything that is not
zero, an empty state, a statutory rate (MRPS 7% + 7%, the 99% service pool), an
account code, or a target the outlet configured.

The same rule applies to anything else on screen. If you cannot measure it, say
what is true — "Nothing counted on this outlet yet" — and never a plausible
number.

## The guest portal and the member card

`/g/<slug>?t=<table>` mints a **table token** scoped to one outlet and one
table, so a guest cannot retype a URL onto another table's bill. The projection
they read carries no cost, no margin, no staff record, no other table's ticket
and no other table's ticket in the kitchen.

`/m/<slug>` is the member card. Signing in is a four-digit code hashed with a
per-row salt exactly like a staff PIN — ten minutes, five tries, spent on use —
traded for a member token that names one member and carries no rank. Whether a
phone number is a customer here is not a question a stranger gets to ask, so
`/member/start` answers identically either way.

**There is no SMS or email transport in this build.** The code is delivered the
way a restaurant already verifies a person: it appears on the floor board for a
server to read out, and it is in the audit trail either way. To wire a real
channel, send `code` from the `member/start` handler down it; nothing else
changes. `MEMBER_CODE_ECHO=1` returns the code in the response and is
**development only** — it turns a phone number into a login.

Points are awarded by the outlet from its own earn rate (`chain.setting`
`loyalty.pointsPer`), never from a number the terminal sent.

## Editing `app/*.html` safely

- **Mismatched string quotes** are the most common self-inflicted bug. Always
  syntax-check after editing: extract the largest inline `<script>` and
  `node --check` it.
- Confirm `<sc-if>` / `<sc-for>` open and close counts still balance — an
  unbalanced tag renders an empty screen with no error.
- The DC runtime is `{{ x }}`, `<sc-if value="{{ b }}">`, `<sc-for list="{{ y }}"
  as="z">`. Logic classes extend `DCLogic`.
- The app's state is closure-scoped and not injectable from the page. To test a
  method's arithmetic, slice its source out of the HTML and run it with
  `new Function` against a stub `this` — that exercises the shipped text rather
  than a retyped copy. `test/harness.js` does this properly, in a vm.

## Tests

```
npm test                          # 57 tests
npm run leak-test                 # isolation, on its own
```

`test/harness.js` loads the terminal's logic class into a vm and sweeps it:
every screen generator, every modal kind, every form spec, every handler any of
them expose — on an empty database, on a seeded one, and at every rank. The
handler sweep is the one nobody does, and it is where most defects were found;
several were not reachable by clicking.

`test/api.test.js` runs against a **real Postgres, created fresh and migrated
from nothing**, because that is the path a deploy takes. Run the suite against a
cold database before shipping.

`test/responsive.test.js` measures 390 / 924 / 1440 in a real browser: the top
bar never wraps, the page never scrolls sideways, nothing overflows a container
it did not ask to, and no tap target on a phone is under 40px.

## Local harness

```bash
PGBIN=/usr/lib/postgresql/16/bin
sudo -u postgres $PGBIN/initdb -D /var/lib/postgresql/pgNNNN -A trust
sudo -u postgres $PGBIN/pg_ctl -D /var/lib/postgresql/pgNNNN -o "-p NNNN -k /tmp" \
  -l /var/lib/postgresql/pgNNNN.log start
sudo -u postgres psql -h 127.0.0.1 -p NNNN -d postgres \
  -c "CREATE DATABASE kash OWNER postgres;"

env PGHOST=127.0.0.1 PGPORT=NNNN PGDATABASE=kash PGUSER=postgres PGPASSWORD= \
    PORT=4090 NODE_ENV=development \
    OUTLET_ROLE_SECRET=test-outlet-role-secret-at-least-32-chars \
    SESSION_SECRET=test-session-secret-at-least-32-characters \
    PORTAL_SECRET='test-portal-secret-at-least-32-characters!' \
    ALLOWED_ORIGINS="*" setsid node server.js \
    >/var/lib/postgresql/app4090.log 2>&1 </dev/null & disown
```

The log file must live in a postgres-writable directory. `pkill -f "node
server.js"` **kills this shell too** when the command line contains that string
— use `pkill -f "[n]ode server.js"` and run the restart as its own step.

Browser checks: Chromium at `/opt/pw-browsers/chromium`, Playwright at
`/opt/node22/lib/node_modules/playwright/index.js` (CJS — destructure
`chromium`). Use `waitUntil: 'domcontentloaded'`.

## Deploy

See `DEPLOYMENT.md`. Short version: Railway builds the Dockerfile, `/readyz` is
the health check, migrations run at boot inside the process, and **production
exits rather than serving on a schema it could not finish migrating**.

Commit trailer: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` plus the
session link. Never put a model identifier in a commit message, a PR, a code
comment or anything else pushed to the repository.
