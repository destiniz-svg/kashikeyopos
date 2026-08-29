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
src/apply.js           the op kinds and what each one consequences
src/auth.js            rank gates
src/limit.js           the doorman: token buckets on the open doors
src/revoked.js         a revoked session or device is refused, not just recorded
src/routes/            auth · onboarding · outlet · sync · guest · estate · pages
src/routes/doc.js      a receipt or a statement, read by whoever was handed the link
src/setup.js           a store's setup, in a file its owner holds
src/migrations/        001 control · 002 RLS · 003 outlet plane · 004 chart
                       005 sign-in · 006 statutory · 007 member access
                       008 line identity · 009 GST registration · 010 currency
                       011 accounts · 012 store handle · 013 handle history
                       014 GST optional · 015 order stage
                       016 business date · 017 member invitation
                       018 member email · 019 drop member tier
                       020 invite token · 021 loyalty liability
                       022 sale knows redemption
                       023 wages are not tips · 024 device pushes
                       025 retention · 026 install identity
                       027 reserve panel · 028 credit outstanding
                       029 void a sale · 030 the polled tables
                       031 yield is an outlet fact · 032 a batch is an item
                       033 the licence plane · 034 reserve the mail names
                       035 an account belongs to no outlet
                       036 a device says what it runs
                       037 your own PIN is yours to change
                       038 a PIN hash never leaves the database
                       039 a database is not a lobby
                       040 a section is not one browser's opinion
                       041 heat is a property of the dish
                       042 a receipt has an address
                       043 a sale the till can name
                       044 an outlet has a face
                       045 a person has a number
                       control/004 the archive shelf
src/backup.js          taking a copy, and putting it back
src/routes/platform.js the one door an install opens to its seller — aggregates only
panel/                 Mission Control — the seller's panel, its own service
panel/railway.js       Provision: it builds the whole install, or says why it cannot
site/                  the public website — landing, docs, legal, store signup
src/apple.js           Apple's client secret, which is a JWT this app mints
src/handle.js          what a store address is, and where the base domain comes from
src/directory.js       where an address points — current or one a store gave up
app/index.html         the terminal (POS, KDS, back office) — one app, gated by rank
app/onboarding.html    the panel an empty install lands on — three application
                       steps, then ten that set the shop up
app/guest.html         the QR portal
app/member.html        the member card
app/kashikeyo-rules.js allergen + diet rules, loaded by BOTH browser and server
app/kashikeyo-yield.js  what a kilo plates — the estimate BOTH runtimes read
app/kashikeyo-invite.js the invitation's copy, loaded by BOTH browser and server
app/kashikeyo-share.js  what a shared bill says, and how a number reaches an app
app/kashikeyo-qr.js     a real QR encoder (ISO 18004, byte mode, v1–10) — one
                        composer, browser AND server, verified against jsQR
app/doc.html           a receipt or a statement, on a phone that has no account here
app/kashikeyo-data.js  structure that ships (chart, ranks, units, labels,
                       the section glyphs both apps draw) — no trade
app/kashikeyo-api.js   the durable outbox and the API client
app/kashikeyo-escpos.js ESC/POS bytes — one composer, browser AND server
app/kpos-print.js      how the bytes reach the paper: WebUSB · serial · LAN relay
app/kpos-bridge.js     terminal ↔ API
app/guest-bridge.js    guest portal + member card ↔ API
```

## The tenancy model: a business is a database

**One app, one Postgres cluster, a database per business.** A customer signs up
on the website and gets `kashikeyo_biz_<id>` carrying the schema this repo has
always had — company, staff, members, the outlet schemas and their login roles.
A REGISTRY database (`CONTROL_DB`) sits above them all and holds what has to be
true ACROSS businesses: accounts, the business directory, a global outlet id
sequence, and the handle registry.

**Why the boundary is the business and not the outlet.** `applySale()` moves
`chain.member.points` and `credit_used` in the SAME transaction as the sale, its
tenders, its stock moves and its journal. Postgres has no cross-database
transaction, so everything one sale touches has to live in one database or a
crash can take the money without the balance. A single-outlet café therefore
still gets exactly "its own database"; a chain gets one database with its
outlets as schemas, and points and credit stay chain-wide. **`src/apply.js` is
unchanged by any of this.**

**`CONTROL_DB` is named, never guessed.** Falling back to "whatever database
this connection happens to be on" would silently make a business database its
own registry on a misconfigured deploy — the tables would create, the accounts
would land in the wrong place, and nothing would say so until two customers had
signed up. `control()` throws instead.

**And an install that does not name one is refused at boot.** Three comments
here said that without `CONTROL_DB` this was simply a single-database install
behaving as it always had. That stopped being true when outlet ids and handles
moved to the registry: `provisionOutlet()` cannot allocate an id, the guest
portal cannot resolve a handle, and the outlet route cannot check or rename
one. The install booted, answered `/readyz` 200, took onboarding step 1 and
500'd on step 2. `registryNamed()` in `server.js` names it at boot with the
remedy in the message, and production exits — the same doctrine as a schema it
could not finish migrating. The database itself need not exist;
`ensureControlDb()` creates it. `test/fleet.test.js` is the only run in the
suite that happens without a registry, which is why this was invisible.

**The account plane moved to the registry** (011 is now a tombstone that drops
the tables). One account may own several businesses, so "is this address known"
cannot be asked of one business's database without searching every database in
the cluster — and that is the one question `src/routes/account.js` promises
twice over it never answers. The registry has an audit table of its own, for the
same reason migration 035 gave a business one: an account event has nowhere else
to be written, and a trail nothing can be written to is how "the code is in the
audit trail" became false the first time.

**Outlet ids are allocated globally.** `provision.js` took `max(id)+1` inside one
install, so every install had an outlet 1 — fine when a customer was a whole
install, a cross-tenant hazard the moment two share a cluster, because a session
token names an outlet and that name must resolve to exactly one store. Every
outlet is registered in `chain.outlet_directory` whether the id was allocated or
supplied: an outlet with no directory row has no route home and its handle
cannot even be claimed.

**A handle is one name on the internet, so the registry owns it.** A business
database only knows its own outlets, so asking it "who holds seaside" gets
"nobody" from every business that does not — which is how two stores print the
same address and only one gets the traffic. `control/002_handles.sql` holds the
rules, the reserved names, the claim, the rename and the history; uniqueness is
still enforced by a primary key and reservation still by a trigger, just in that
database rather than each business's. `chain.outlet.slug` is a local copy that
follows. `src/directory.js`, `guest.js` and `outlet.js` all resolve there.

**An owner whose business cannot be read is told so.** `session()` used to
swallow an unreadable business and return no outlets, which the browser renders
as "you have not set up a store yet" — and that screen's first action is to
create one. It returns `unreachable` with a reason and `next: 'unavailable'`
now; onboarding is only for an account that genuinely owns nothing.

`test/tenancy.test.js` is the gate: two businesses, and business A's outlet role
refused at B's database, at B's members, and at the registry where the accounts
live.

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

**A DATABASE IS NOT A LOBBY** (migration 039, and `control/003` for the
registry). Postgres grants `CONNECT` on every database to `PUBLIC`, so one app
serving many customers off one cluster meant an outlet's login role could open
a session on ANY business's database. It could read nothing there — every
schema answered "permission denied", belt one holding exactly as designed, no
money, no members, no staff, no recipes, measured against two real stores — but
it could sit inside another customer's database and read the world-readable
catalogs: schema names, object counts, the shape of somebody else's install.
Metadata, not data, and shut anyway, because the guarantee this build states is
refusal AT another business's database and refusing a layer earlier is what
makes that sentence true rather than true-about-the-rows.

The grants come first and the revoke last, in one transaction, so there is no
instant at which a store has lost its own way in. Roles are discovered from the
`outlet_%` schemas actually present rather than from a list somebody maintains;
`kashikeyo_report` keeps its way in, because the estate read is the one
deliberate crossing; and `chain.provision_outlet()` grants it for every new
outlet, which is also what makes `provision:outlet --all` — the remedy
`/readyz` prints — genuinely restore this.

**And `/readyz` was proving the GRANTS and calling that the credential.** A pool
authenticates once and then serves for as long as it holds the connection, so a
revoked `CONNECT`, a dropped role or a rotated `OUTLET_ROLE_SECRET` were
invisible to it. Measured: `CONNECT` revoked on a live outlet, the endpoint
green for three minutes, a fresh connection refused the whole time. `canConnect()`
in `src/db.js` opens one outside the pool and closes it — the half a warm pool
can never test — bounded by the probe's own ten-second positive cache.

**Belt two — `FORCE ROW LEVEL SECURITY` on the shared control plane** (`chain.*`:
company, outlet, staff, device, session, tax_version, doc_series, member,
supplier, setting, audit). The policies read the transaction's own context.

**The context is transaction-scoped.** Every request runs inside `withOutlet()` /
`withOutletRead()`, which `SET LOCAL app.outlet_id / app.user_rank / app.actor /
app.scope / app.device` via `set_config(..., true)`. It dies at COMMIT, so a
pooled connection cannot carry one request's identity into the next.

The owner connection (`owner()`) bypasses both belts, so where a request
handler reaches for it is a list, not a habit. There are six situations, and
every one of them is a question that CANNOT be asked from inside a single
outlet:

| Where | Why no outlet role can answer it |
| --- | --- |
| `account.js` | migration 011 revokes every privilege on the account plane from every outlet role. There is no policy to get wrong here, only this file. |
| `onboarding.js` | steps 1–3 run before an outlet, a staff record or a session exists. There is nothing to be scoped to yet. |
| `auth.js` — install state, merchant name | asked by the lock screen before anybody has signed in. |
| `guest.js` — `handle_points_at()` | resolves a handle TO an outlet; the outlet is the answer, so it cannot be the context. |
| `outlet.js` — handles and GST registration | handle uniqueness spans every outlet, and registration is a COMPANY fact that must reach all of them in one transaction. Rank 5. |

**The owner connection is a PRIVILEGE, not an ADDRESS — and only the first half
of that had ever been decided.** The table above says which handlers may bypass
the belts. `owner()` also picks a DATABASE: the one `DATABASE_URL` points at.
That was the same thing when a customer was a whole install. It is not now — in
a registry install the process's own database is one nobody trades in — and
three handlers went on using it after the boundary moved:

- **the lock screen** (`GET /api/auth/install`) returned an empty outlet list to
  every terminal. `loadRoster()` sees no outlets and returns early, so the till
  could sign **nobody** in; worse, an empty answer reads as "this install has
  not been set up", and the first action on that screen creates a second
  company;
- **GST registration** would have marked another database's company registered
  and left the real one unregistered — every outlet still `NONE`, charging
  nothing, while the screen said registered. A debt to MIRA nobody notices
  until an audit;
- **a handle rename** claimed the new name in the registry and renamed an
  outlet in the process's database, which is exactly the half-done rename
  `chain.rename_handle()` runs in one transaction to prevent.

`ownerForOutlet(outletId)` is the address, resolved through the registry, and it
has its own list in `test/wiring.test.js` for the same reason the other two do.

**The lock screen now asks the terminal which store it is.** The host cannot
answer — a store's subdomain serves the GUEST portal, and the till is on the
app's own hostname for every customer — and nobody is signed in to ask. So a
till carries `kashikeyo.outlet`: stamped after its first sign-in, or by
`/account` the moment its owner signs in there. With no store named, `/install`
answers `needStore` and the terminal goes to `/account` to be told, rather than
being handed some other install's state.
| `platform.js` | aggregates for the seller, guarded by `PLATFORM_KEY` and audited. |

`test/wiring.test.js` pins that list. A seventh has to justify itself there,
exactly like a sixth composer of manual journals does — which is the only thing
that keeps "six deliberate exceptions" from drifting into "wherever it was
convenient".

`npm run leak-test` makes thirteen crossing attempts (read another outlet's
sales, write its stock, forge a rank, reach the estate aggregate without rank 5,
…) and asserts every one fails. It runs in CI, inside `test/api.test.js`.

The one deliberate cross-outlet read is `chain.estate_day(date)`: aggregates
only, rank 5, group scope, through the read-only `kashikeyo_report` role, and
audited.

## Two planes: accounts and ranks

An **account** signs up on the website with an email address and **owns the
business**. A **staff member** taps their face at the till and keys four digits.
Different people, different moments, different credentials — conflating them is
how a waiter ends up able to change the company's TIN.

```
chain.account            an email address, scrypt password, verified state
chain.account_identity   a Google or Apple subject, matched on the SUBJECT
chain.account_outlet     what an account owns; one `owner` per outlet
chain.company.owner_account_id
```

Four ways in, all landing on one account row: email + password, a six-digit
code to the inbox, Google, Apple. `src/routes/account.js` is the whole of it,
running on the **owner connection**, because migration 011 revokes every
privilege on these tables from every outlet login role — there is no policy to
get wrong, only that file. `test/api.test.js` asserts an outlet role cannot
read `chain.account` at all.

Sign-up, code-request and sign-in **never reveal whether an address is known**.
The answers are byte-identical either way, or the endpoint enumerates the
customer list.

An account token carries an account id and nothing else — no rank, no outlet —
so it cannot read an outlet, and a staff session cannot read the account plane.
Both directions are asserted.

The flow is: `/account` → sign up → `/onboarding` (the panel carries
`x-account-token` on every step) → the account that completes it becomes the
outlet's **owner** and keeps the rank-5 staff record it created for the floor.

**And the token rides on every call, not on whoever remembers it.** `api()` in
`app/account.html` attached it only where a CALLER passed a header, and one of
eleven did (`/me`). The one that did not was `POST /api/account/business` —
made the instant a six-digit code verifies, to create the business the account
is about to onboard into — so it went out bare and was refused *sign in
again*. Every new customer hit it, at the moment they finished typing the
code, and it reads as the CODE being rejected: the last thing they did was
type six digits, and the screen said no. It was reported exactly that way.
`api()` composes the header itself now, and no call site hand-rolls one.

`test/e2e.test.js` walks this same road over HTTP and was blind to it, because
a test that writes its own headers cannot notice a page that forgets one.
`test/signup.test.js` drives the shipped page in real Chromium — form, six
boxes, code, landing on step one — and fails against the version that shipped.

Email goes through `src/email.js` — one seam, Resend as the driver. With no
transport configured the code is written to the audit trail and the call
**says so** (`sent: false`); it never pretends.

**WHY a message did not go is an install-wide fact, and the screen needs it.**
"not sent" collapsed three different situations into one word — no transport, a
dangling `${{reference}}`, and a transport that ANSWERED AND REFUSED — and
`/account` rendered all three as "No email is configured on this install yet".
That is false for the last two and sends whoever reads it to check variables
that are correct: a wrong key, an unverified From domain and a suppressed
recipient all look like a missing setting. `email.health()` carries the
transport's own words now.

**But not to whoever POSTed the address.** `/signup` and `/code` are open to
the internet, and the transport's own words were answered to every caller — a
stranger typing any address into the form was handed the provider's JSON,
naming the mail provider and quoting its error verbatim. That is the rule this
build already keeps for the database ("the error handler never returns a
database message") and had not kept for the mail provider. `health()` carries
two sentences now: `reason` is the class and the status
(`the email transport refused this install (HTTP 401)`), which is what the
person waiting can act on — it tells them it is the install and not their
address — and `detail` is the transport verbatim, for the operator. Nothing is
lost: `detail` goes to the three places an operator looks, and only there —
the trail (`account_code_failed`), the process log, and the boot line via
`watch.why()`.

**A REFUSAL PRINTED IN GREEN, which is the same defect wearing a colour.**
Found in a screenshot of the live install's own `/account`: the heading read
"Check your email", the subtitle read "We sent a six-digit code to …", the
label over six empty boxes read "The six digits we sent you", and underneath,
in the SUCCESS box, sat the mail provider's 401. Four statements of a send that
did not happen. The page had two message elements and `say()` wrote into
whichever it was NOT, so anything that was not an error became a success by
default. Three temperatures now — `.msg.err` · `.msg.warn` · `.msg.ok`, one
element, from the shared `--warn-*` tier — and a send that did not happen is
the middle one: the account WAS made and no code is coming, which is neither a
failure nor a success. The three sentences that state a fact read off `sent`,
which is derived from the answer rather than assumed, and say where the code
actually is. Measured in both themes: 9.1:1 light, 8.5:1 dark.

**And `delivered` was an account-enumeration oracle.** It was attached only on
the branches where an account EXISTS, so its mere presence answered "is this
address registered" to anybody who asked — in the two endpoints this file
promises twice over do not. The test that guards this compared two answers that
were BOTH missing it, and never compared either against the new-address answer
that had it. Every answer carries `delivered` now, derived from
`email.health()` — the install's own state, identical for every caller, which
is what lets the two answers stay byte-identical while still saying why nothing
arrived. A refusal is a property of the key and the domain, never of the
address that triggered it.

That fallback had never worked, and it is the one the whole doctrine rests on.
`chain.audit.outlet_id` was `NOT NULL`, and account events are written with
`NULL` — the account plane sits ABOVE every outlet, and the events that matter
most happen before one exists — so the insert failed on the constraint, was
swallowed by a `.catch(() => {})`, and **not one account event ever reached the
trail**. The code was not in the payload either. Both halves were false while
`/account` told the customer exactly where to look. Migration 035 makes the
column nullable (a NULL row is invisible to an outlet role and readable at
group scope, which is the account plane's own visibility), and the code is
attached **only where it could not be sent** — a delivered credential written
to a second place is a second place to steal it from. Found by creating an
account on a fresh install and going to fetch the code the screen promised.

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

A deferred `CONSTRAINT TRIGGER` refuses an unbalanced journal at COMMIT — and
the sync handler collapses that deferral **per op** (`SET CONSTRAINTS ALL
IMMEDIATE` inside each savepoint), because a deferred trigger fires at the batch
COMMIT where no savepoint can contain it: left alone, one unbalanced journal
poisoned the whole batch and the till retried it every five seconds forever.
One bad op fails alone; its neighbours commit.

`postJournal()` nets residual float dust (≤ five laari) onto 4900. A LARGER gap
is a component bug: a non-sale journal refuses outright, and a sale — which is
never refused, the money is taken — still posts but stamps `journal_imbalance`
in the audit trail and labels the line `IMBALANCE absorbed`. The old unlimited
netting is how an entire feature's money hid inside "Cash rounding" for months.

Eleven accounts are till-owned (1010, 1030, 1040, 1200, 2200, 2350, 4000, 4100,
4200, 4900, 6550) and a manual journal to any of them is refused.

**One author per journal, and the payload is the journal.** The sweep of every
`queue("post_journal")` in the terminal found that NO client screen had ever
successfully posted one: every call sent a label and no payload, so the server
refused each for want of a memo — including the manual journal form, which
validated the accounts and the memo and then queued neither. The real ops were
queued bare too, so `vendor_payment` minted zero-amount rows against no
supplier and journalled nothing. Supplier payments, credit settlements, bank
charges, repairs and short settlement batches were booked NOWHERE, and every
attempt left a poison op retrying from the outbox.

Now: the money ops carry their money (`vendor_payment`, `settle_credit`,
`grn_priced`, `acq_match`, `acq_reopen`, `stock_writeoff`), suppliers resolve
by name onto `chain.supplier` exactly as members do (a seed-era numeric id fed
to a uuid column was killing every payment that named an invoice), a card
credit-settlement lands on 1030 rather than pretending the acquirer pays
instantly, and `acq_match` books the ACTUAL deduction — fee plus shortfall —
for every batch, once, with a corrected advice file posting only its delta.
Five composers of manual journals remain, each carrying `lines` and `memo`,
and `test/wiring.test.js` pins the list: a sixth must justify itself there.

## Tips are held, not earned

A tip rides **outside the bill's identity**: `sale.total` is what the bill came
to, `sale.tip` is what the guest added, and a payment's `amt` is the sum — the
note that physically entered the drawer, which is what the drawer count
reconciles against. The sale journals `Cr 2450 Tips payable to staff` for the
tip, the tie-check compares the till's claimed figure against `total + tip`,
and paying the team out is a manual journal against 2450 — which is why 2450 is
deliberately **not** till-owned.

Before this, tips overshot the sale journal by exactly themselves and were
absorbed into 4900 as fake rounding — revenue nobody could ever pay out — while
**payroll credited net wages to 2450**, so the tips account carried every
salary in the company and neither figure could be reconciled. Net pay now lands
on **2400 Net wages payable** (migration 023). Historical payroll rows are not
restated: they are what was posted, and the trail says so.

## Money

**The books are kept in ONE currency**, chosen at onboarding — MVR or USD. Every
price, receipt, report and ledger figure is in it. A guest may hand over the
other currency at the counter: that is a **tender**, converted at a rate the
till records on the receipt, and it does not make the ledger bilingual.

There is one currency table, published by the outlet (`chain.setting`
`currencies`), carrying `minor` and `cashRound` per currency. **Cash rounding is
a property of the currency**: MVR settles to its 50-laari coin and the
difference posts to 4900; USD has cents and rounds to nothing. Rates are
re-based against the books, so the base is always 1.

Do not write `"MVR"` into a string. `MVR()` and `MVRc()` read the current
currency record; `this.base()` is the code of the books' currency.

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

**Registration is a COMPANY fact; the RATE is an outlet fact.** In the Maldives
the taxpayer registers with MIRA, not the shop — so `chain.company.gst_registered`
carries the decision and its TIN (nullable since migration 014: a business that
is not registered has none, and asking it to invent one puts a false statement on
every receipt). Which rate an outlet charges once the company is registered —
GGST or TGST — stays on `chain.outlet.tax_code`.

Two invariants live in the database rather than in the handlers, because "the
whole application behaves" is not something four route files can promise between
them:

- a registered business HAS a TIN (`company_tin_iff_registered`);
- an outlet cannot hold a tax code, or a rate version, that its company is not
  registered to collect (`chain.outlet_tax_guard`, `chain.tax_version_guard`).
  The statutory history — `outlet_id IS NULL` — is exempt: those are facts about
  the country, shipped whoever is reading them.

`chain.provision_outlet()` therefore takes its `tax_code` from
`chain.gst_registered()` rather than the column default, or a business below the
threshold could not create an outlet at all. `chain.register_for_gst()` is the
other direction, in one transaction: set the TIN, mark the company, and put the
rate on every outlet — because a company marked registered whose outlets still
say NONE charges nothing while believing it charges GST, and that is a debt to
MIRA nobody notices until an audit.

**`applySale()` reads the outlet's registration, not the till's claim.** A
terminal that has not caught up still sends a tax code and a rate. Believing it
records a liability the business does not owe. The sale is repaired rather than
rejected — a cashier has already taken the money — the over-collected amount
rides in `rounding` to 4900, and what the terminal claimed is stamped in
`sale.server_audit.unregistered`.

**GST registration is optional because it is conditional.** In the Maldives a
business registers once taxable supplies pass a threshold (migration 009:
MVR 1,000,000 over 12 months; tourism always). Below it, it charges nothing and
**no tax line prints at all** — a document showing one claims a registration the
business does not hold.

Every tax row asks `taxRegistered()` first. Never guard on truthiness: `"NONE"`
is a truthy string, and that is exactly the bug that shipped. The outlet
measures its own rolling turnover against the threshold and publishes it as
`GST_WATCH`; crossing it becomes a decision on the owner's Today list.
`test/tax.test.js` sweeps every screen and modal for a tax class printed next
to a rate.

**The registration flag was authoritative; the AMOUNT was not.** `applySale()`
now recomputes the expected tax from the outlet's own effective-dated
`chain.tax_version` rate, on the same base the till uses — net less any
redemption, plus the service billed — and stamps `server_audit.tax_mismatch`
when the RATE applied is wrong (a stale build carrying yesterday's rate through
a change). It flags a wrong non-zero rate, never a zero-tax sale: a registered
business has zero-rated and exempt supplies, and second-guessing every one
cries wolf until nobody reads the flag. Same doctrine as the registration
sweep — repair-and-flag, never reject, because the money is already taken.
`COGS` and the value of the stock it moved are the same money; a gap between
them stamps `server_audit.cogs_mismatch` (full recipe-and-WAC re-derivation of
COGS server-side is the deeper follow-up this leaves open).

## Stock and the ledger are one figure, not two

Account **1200** and the physical stock ledger were fed by two independent
client numbers: the journal credited 1200 with the till's `cogs`, while
`stock_move` carried the till's per-move `value`, and nothing compared them. A
till offline across a price rise valued its evening at last week's cost in one
place and this week's in the other, permanently, and the only symptom was a
margin that was quietly wrong.

**What a consumed portion is worth is the server's answer now.** `moveStock()`
re-values a `sale` move at the outlet's own weighted-average cost — the same
`avg_cost` a delivery re-averages — and everything downstream reads that one
figure: `stock_move.value`, the credit to 1200, and `sale.cogs`, which is
repaired to it. The till's claim survives in `server_audit.cogs_mismatch`, to be
answered for. Only a SALE is re-valued: a delivery's value is what the invoice
says, a write-off's is what somebody decided to write off, and a count variance
is valued by the count — those are facts the till was told, not estimates it
made. A sale's was the only one nobody was ever told.

The journal sums the **rounded** move values rather than rounding a sum, so it
agrees with the rows in `stock_move` to the laari. A tenth of a laari per move,
unchecked, is how a valuation and a ledger part company over a year.

**A divergence needs two numbers.** An outlet with no recipes at all — a café
costing its menu at a flat percentage, which is an ordinary way to run one —
sends a COGS estimate and NO stock moves, on every sale, for ever. Comparing
them there flags every bill in the shop, and a flag that fires on every bill is
one nobody reads by the second week. Same doctrine as the tax sweep: flag a
wrong figure, never the absence of one. So the comparison runs only when the
till actually moved stock; where it moved none the ledger books no cost of
sales (nothing left the shelf, and 1200 used to be credited anyway — that was
the defect), and the till's percentage estimate stays on the sale row as the
margin figure it is, so the food-cost card still reads.

**And HOW MUCH is the server's answer too, now.** The value was re-derived; the
quantity was still the till's word, computed against whatever menu that browser
was holding — so a device offline across a recipe change deducted yesterday's
recipe for ever, and the only symptom was a ledger that drifted a little every
service until a count found it weeks later with nothing to attribute it to.

`deriveConsumption()` in `src/apply.js` re-derives the expansion from the
outlet's own `recipe_line`, its own batches and its own measured yields — a
recursive walk in the database, bounded at twelve levels because a sauce whose
batch draws on itself does not error an unbounded `UNION ALL`, it hangs. Where
the outlet can answer, the outlet answers; the till's figures move to
`server_audit.qty_mismatch` **by ingredient**, and `recipe_drift` goes on the
trail, so a stale device names itself in the first bill it rings.

Three things it deliberately does not do. It does not reject — the money is
taken. It does not fire where there is nothing to compare: a dish with no
recipe moves no stock on either side, so the two agree at zero. And **a partial
derivation never replaces a whole one** — if any sold item is one this outlet
has never heard of, or the walk hit its cap, the till's figures stand and the
REASON is stamped (`qty_underived`), because overwriting them with a partial
answer would under-deduct the shelf.

The yield table is now **one file both runtimes read** — `app/kashikeyo-yield.js`,
loaded by the browser as a script and required by the server as a module,
exactly like `kashikeyo-rules.js`. It matters here for the same reason: a check
computed from a DIFFERENT table is not a check, it is a second opinion, and the
disagreement would present as a stock discrepancy on every bill in the shop.
`test/api.test.js` runs the SHIPPED terminal's `saleTrail()` in a vm against a
real outlet's bootstrap and the server's derivation against the same outlet, on
the same bill, and asserts they agree to six places.

Writing this found something else: the API fixtures had been sending the
PLATED quantity — 400 g of fish for two 200 g portions — which is not what any
real terminal has ever sent, because a kitchen takes a whole fish off the shelf
to plate a fillet and the till has always grossed up by the yield first. The
tests passed because the server accepted whatever it was given. They send what
the terminal sends now, computed from that same shared table.

**What a kilo actually plates is an OUTLET fact.** A recipe says how much of an
ingredient reaches the plate; what has to LEAVE THE SHELF to put it there is a
different figure, and the till divides by it on every sale —
`grossQty = net / (yield × (1 − waste))`. That factor lived in one browser's
`state.local`, never synced, with a regex matched against the ingredient's NAME
as the fallback. Three consequences, none visible from any screen: two tills at
one counter deducted DIFFERENT quantities for the same dish; clearing a
browser's storage reverted a measurement to a guess; and the server could never
reproduce what a sale consumed. The op meant to carry the measurement,
`yield_test`, was queued with **no payload at all**, so the trail recorded a
yield of zero against no ingredient while the screen said "Yield recorded".

Migration 031 puts it on `ingredient` (`yield_pct`, `waste_pct`, and who and
when). **NULL is a real answer** and is why they are nullable: "nobody has
assessed this" and "somebody measured it and it plates at 100%" are different
facts, and only the first may fall through to the shipped estimate. The
bootstrap publishes them at indices 13 and 14 — appended, because every reader
of that row is positional — as `null` rather than 1 where unassessed, so a
guess is never published as a measurement. A figure that is not a measurement
(zero, above 1, trim of more than everything) is refused by name rather than
stored.

`yieldOf()` reads three sources in order: this terminal's own un-synced
measurement, then the OUTLET's, then the shipped estimate. The local copy is a
**holding pen, not a private fork** — `seed()` drops it the moment the outlet
publishes an assessment for that ingredient, so a terminal that measured
offline keeps its figure until it syncs and then reads the same number as
everybody else.

This is also what was blocking the server from deriving consumed QUANTITIES for
itself: the factor the till divides by was not a fact the server held. That
derivation is still open — it now has its input.

**Selling what is not there is named, never blocked.** Two tills offline at one
counter can each sell the last portion, and on replay the second used to drive
`on_hand` negative in silence: no block, no warning, no trail. Blocking is the
wrong answer — the food left the kitchen and the money is in the drawer — so
the move is recorded and the SHORTFALL is stamped (`server_audit.stock_short`,
`stock_negative` on the trail), naming the ingredient and the balance it left
behind. What a manager needs is not a refusal three hours later; it is to be
told which ingredient the books now believe they have less than none of.

**Points granted by hand move the liability too.** `loyalty_update` changed
`chain.member.points` and journalled nothing, so 2350 tied to the member
balances only as long as nobody used the screen — a hope, not a guarantee.
It now posts `Dr 6550 / Cr 2350` for a grant and the reverse for a withdrawal,
at the same published redemption rate the sale path accrues at, and follows the
BALANCE rather than the request: `greatest(0, …)` means the points that moved
are not always the points asked for.

## Credit is a balance the server keeps

A house account has a limit, and it used to be decoration. The till told the
operator, in four places, that a Postgres trigger would reject an over-limit
charge "offline or not" — there was no trigger, no CHECK, and no per-member
outstanding balance anywhere. A credit sale just debited 1040 and two offline
tills could run one customer arbitrarily over.

`chain.member.credit_used` (migration 028) is the outstanding, **chain-wide**
because the limit is one figure across every outlet, maintained by the two ops
that move it: `applySale()` raises it by the credit tender, `settle_credit`
lowers it (floored at zero). An overrun is **stamped** in
`server_audit.credit_over` and logged as `credit_over_limit`, not rejected — a
sale that already happened is never thrown away, the same doctrine as tax — and
the till's own pay screen still blocks an over-limit charge before it is rung:
prevented at the counter, detected and recorded on replay. The bootstrap now
publishes `used` from `credit_used` (charges **minus** settlements), where the
old `on_account` summed only charges and left a paid-up customer reading as
still owing.

## Sync

Every mutation in the terminal goes through **one seam**, `queue()`, which
stamps a client-generated v4 `opId` and hands it to the durable outbox in
`app/kashikeyo-api.js` (IndexedDB, keyed by `opId`). `POST /api/outlet/:id/sync/
push` applies each op inside its own savepoint; `op_log.op_id` is the primary
key and the insert is `ON CONFLICT DO NOTHING RETURNING`, so a replay is a
no-op and a duplicate inside one batch cannot abort the batch.

118 op kinds are handled and 35 more are deliberately audit-only, **named** in
`AUDIT_ONLY`, so "not modelled yet" and "audit-only by design" stay
distinguishable. The counts drift upward as features land — the wiring test,
not this sentence, is what holds the two halves together, and it asserts they
meet on every run.

The network pill is a real switch (`KPOS_BRIDGE.setOffline`), not a simulation:
offline means nothing is POSTed and every write holds durably until it is
flipped back.

**Every delivered push stamps the device** (`chain.device.last_push_at`,
migration 024) — even a batch of pure replays proves the till can reach its
outlet. `last_seen` answers "when was somebody standing at it"; this answers
"when did it last deliver its writes", which is the question that matters when
a signed-in till is sitting on the only copy of the evening's sales behind a
dead link. The bootstrap carries it as `pushed`, and the Sync ribbon warns on
any writing device (not printers or displays — they never push) quiet for an
hour.

**One install's outbox never replays into another.** Outlet ids are small
serial integers, so staging's outlet 1 and production's outlet 1 are both
"1" — and the durable outbox keys its rows by that number. Migration 026
names every DATABASE with one uuid (`chain.setting` `install`), the bootstrap
publishes it as `INSTALL`, and every queued op is stamped with the install it
was queued against. An op whose stamp names a different install — or none —
PARKS with the reason instead of pushing; **Send it again** adopts it into the
current install because a person decided. A detected install change also
sheds the terminal's trade-local state (tickets, held bills, the settled
cache) with a toast that says so. This is the fence against the real
incident: demo ops queued on a test install replaying into a real store that
happened to share the outlet number.

**A refusal is not a network failure, and the eighth parks the op.** The outlet
answered and said no; retrying it every five seconds forever is how one poison
op used to keep a till's outbox hot for the life of the device. A parked op
stays durable and visible — on the Sync screen with the server's reason, on the
ribbon, on the Today list — and offers exactly two ways forward: **Send it
again** (fresh allowance, for after the cause is fixed) or **Discard it**
(manager rights; the op is deleted and an `op_discarded` audit op naming what
was given up, why it was refused and who decided replays in its place — it is
in `AUDIT_ONLY`). Network failures never count toward the eight: a dead link
says nothing about the op. `test/wiring.test.js` pins the whole loop.

### A drain is bounded work, not one long transaction

The only measured performance defect in the build, and the only error in the
whole load campaign. A push applied the ENTIRE batch inside one transaction, so
a till back from a dark evening asked the server to hold a pooled connection
for as long as the batch took. At 80 ops with eight outboxes draining together:
up to **16.9 s** — past the 8 s checkout bound the other seven tills were
waiting on, and past the 15 s statement timeout, which is what cancelled it.
One request in ~4,000 failed. Never a money defect (that run balanced every
journal and produced no duplicates), but the ceiling was real and it scaled
with how long a device had been dark.

Both halves are fixed, and the fix was measured on one box, before and after,
on the same data:

| | before | after |
| --- | --- | --- |
| p50 | 3,047 ms | 3,312 ms |
| p95 | 8,681 ms | 6,174 ms |
| **p99** | **17,615 ms** | **7,798 ms** |
| slowest | 17,615 ms | 7,798 ms |
| errors | 1 (statement timeout) | **0**, twice |

- **The server sorts the whole batch ONCE and then applies it in chunks of 25,
  each its own transaction**, so the connection goes back to the pool between
  them and a long drain queues behind itself rather than starving the shop.
  Three things already made that safe: `op_log` is keyed by `opId` with `ON
  CONFLICT DO NOTHING`, so a chunk that committed before a later one failed
  replays as a no-op rather than a double; each op was ALREADY its own
  savepoint, so per-batch atomicity was never what the guarantee rested on; and
  the sort happens before the split, so chunk two can only carry ops that come
  after chunk one. The seen-set spans the whole push, not one chunk — a
  duplicate `opId` is a duplicate whichever pieces it lands in.
- **The client asks for less per request and paces a working drain by whether
  the last push delivered anything.** Five seconds is the right politeness
  after a REFUSAL and a pure tax on a drain that is succeeding — it used to
  wait that long either way, so 4,000 ops took about three minutes, most of it
  idle. The fast gap is conditional on something having actually left the
  outbox, because without that a poison op spins at the fast interval, which is
  the hot outbox the parking lane exists to stop.

**The 200-op cap is unchanged on purpose.** Lowering it would 413 every
terminal in the field still slicing 100, and an op that cannot be delivered is
not safer than one applied in two transactions. The server's chunking closes
the ceiling for every client, old builds included.

p50 is ~9% worse, and that is the honest trade: the same work now commits in
more transactions, so the median request pays a little more. Live serving is
unaffected — 30 terminals at p50 147 / p95 293 / p99 383 ms, zero errors.

### One outlet, many terminals, one answer

Every signed-in terminal has always asked its outlet what changed every five
seconds. **The answer was dispatched and discarded** — the bridge fired
`kpos-tick` and no handler existed in any of the three app pages — so twelve
requests a minute per terminal were paid for and thrown away, and the only
thing that ever re-read the outlet was a BOOTSTRAP: on sign-in, after THIS
device's own material push, or on an explicit refresh.

So a floor was not shared at all. A table opened on the handheld was invisible
at the counter until the counter happened to write something of its own; a bill
settled on one till never reached the other till's takings; a dish priced in the
back office reached the till it was priced on and nowhere else. Measured in two
real browsers against one outlet before any of this was written: over twenty
seconds of polling, the second terminal saw **none** of a table, a dish, a
section or a sale rung on the first.

**`buildState()` is not the answer.** It is thirty queries and sixty days of
settled sales — 853 bytes a row, measured, so about 1.7 MB on a shop with two
thousand bills, on every terminal, twelve times a minute. What a shop actually
needs to share second by second is bounded and **none of it grows with trading
history**:

```
buildLive(ctx, {since})     the floor — every open or held ticket, WITH lines
                            today's takings — the business date, since `since`
                            the drawer, guest orders, guest requests
```

Measured on the same outlet: `buildState` 100.7 KB in 30 ms · `buildLive` 43.4 KB
in 7 ms on the first tick, **21.4 KB steady**, all of it the open tickets, which
is what the poll exists for.

- **One merge path.** The tick is folded in through `KPOS_REAL.state` and the
  `kpos-live` event — the same two things a bootstrap uses — so the terminal
  grows no second way to absorb the same rows. `seed()` remains the one place
  tickets are mapped onto this floor's slots.
- **`settledToday` is deliberately not `settled`.** The bootstrap's `settled` is
  a wholesale refill and the client replaces its cache with it; this is the
  trading day only, arriving twelve times a minute, and a partial answer that can
  be mistaken for a complete one is how a terminal loses two months of history to
  a poll. It merges by id, and the outlet's row wins — a bill this device settled
  itself is a row the outlet has since repaired.
- **The floor is sent whole; the day is sent incrementally.** A terminal cannot
  tell "unchanged" from "closed and gone" out of a partial ticket list, so the
  tickets are always complete; a bill already delivered is not delivered again.
- **One clock, and a window that overlaps itself.** `since` is compared against
  `applied_at` and `sale.at`, which Postgres wrote, so the stamp is read off
  `clock_timestamp()` rather than the app's `Date.now()` — a few hundred
  milliseconds of skew would otherwise drop whatever landed in the gap, for ever,
  with nothing on any screen to say a bill went missing. And `now()` in Postgres
  is the TRANSACTION's start time, so a sale that opened before a stamp and
  committed after it would carry an `at` the next window had already passed: the
  window reaches back five seconds every time, and the client merges by id, so a
  row delivered twice is the same row.
- **What the slice does not carry, a bootstrap re-reads.** `TICK_COVERS` in
  `app/kpos-bridge.js` is the closed list of kinds whose whole consequence is
  already in the slice. It **fails open**: an unclassified kind falls through to
  a re-read, so the list can cost an extra read and can never cost staleness.
  Throttled to one read every ten seconds, and never two at once.
- **A slow floor.** A sale is covered — its takings, its ticket and its docket
  are all in the slice — but what it also did, to a member's points, the credit
  balance, the stock ledger and the journal, is not. Those ride a bootstrap every
  five minutes rather than making every terminal re-read the whole outlet twelve
  times a minute during service.

Measured after: a table opened on one browser reaches the other **with its
lines** in ~2.5 s; a section and a dish in ~5 s; a settled bill on the second
terminal's takings in ~5 s. `test/api.test.js` asks the endpoint the poll
actually calls; `test/wiring.test.js` pins the shape, the merge and the
fail-open, because a listener that was never there is exactly the thing that
disappears again without a word.

### The clock that orders one outlet's work

A Lamport clock means nothing unless it is RECEIVED as well as sent, and this
one never was. Each device numbered from its own outbox, starting at one — and
the number walked BACKWARDS every time that outbox drained or was trimmed. Two
tills therefore produced two independent sequences that both restarted, so the
server's `ORDER BY lamport` sorted a batch against numbers meaningless outside
the device that wrote them, and concurrent edits to one ticket resolved by
whichever connection was luckier.

Both halves are there now, in `app/kashikeyo-api.js`: `tick()` is monotonic and
**persisted**, so a drained outbox cannot walk it back, and `seen()` is the
receive rule — every poll raises this device's clock past the highest the
outlet has already accepted from anybody. `queue()` asks the bridge for it and
keeps its own outbox high-water mark only as a FLOOR, for a terminal with no
bridge (the harness, a page opened before the bridge loads).

The server's tiebreak is the **batch's own order**, and that is not cosmetic:
ops carrying no lamport all compare equal, and `Array.prototype.sort` is not
required to be stable about them. Sorted by anything else — an id, say — a line
is added to a ticket that has not been opened yet. The batch order is the order
the operator did the work in, which is the only tiebreak that means anything.

This does not make concurrent scalar edits MERGE. Two waiters retyping the
covers on one table still resolve last-write-wins; what changed is that "last"
now means the later event rather than the luckier connection. Per-field
versioning is the answer to the rest, and it is not here.

### The tables a poll reads every five seconds

Every signed-in terminal asks the outlet what changed every five seconds, and
four of those queries are "the open ones, oldest first". Three had an index.
`guest_order` and `guest_request` had nothing beyond their primary key, so both
were sequential scans on tables that only ever grow — every open terminal,
twelve times a minute, reading every order the store has ever taken to find the
four nobody has accepted. Migration 030 adds PARTIAL indexes, because the
predicate is the whole point: the index holds a handful of rows however large
the table grows, and a row leaves it the moment somebody accepts it. It costs
nothing on an install opened last week, which is exactly why it survived.

`stock_move` gained one too: a void reads back exactly the rows one sale wrote
in order to negate them, and the table was indexed by ingredient.

### An open ticket belongs to the outlet

A waiter's tablet takes the order, the counter settles it, the pass fires it —
so an open bill lives in the outlet's database, not on the device that opened
it. Two things make that work:

- **A line carries the id the till gave it** (`ticket_line.client_id`, unique
  per ticket). A line is created offline and cannot wait for a server id to be
  nameable; without a name, "void the second line" is unsendable. It also makes
  `add_line` idempotent — the same line replayed updates the quantity rather
  than ordering the dish again.
- **Ticket operations name their ticket by TABLE** when the device has no
  server id for it (`ticketRef()` in `src/apply.js`, `openTicket()` being
  find-or-create by table + split).

`seed()` in the terminal maps the outlet's table labels onto this floor's slots
and merges line by line; a bill open on this device wins, because its
un-replayed lines may not have reached the outlet yet. **Do not merge
`state.tickets` from a bootstrap anywhere else** — the server keys them
`"<label>:<split>"` and the floor keys them `"<outletId>:<slot>"`, and mixing
the two files a bill under a table that does not exist.

## The business date belongs to the outlet

`current_date` is whatever timezone the SESSION is in, and a container is in
UTC. Malé is UTC+5, so from 19:00 local — most of a restaurant's trading —
every business date, document number and settlement key was filed under
**yesterday**, while the clock in the terminal's own header said tonight. A GST
return keyed on that is wrong for roughly a third of every day's takings.

`chain.outlet.tz` has always been there and nothing read it. Now `setContext()`
sets it on every transaction, so **every `current_date` and `now()::date` inside
a request is the outlet's own local date** — one place, every handler at once,
and `SET LOCAL` so a pooled connection cannot carry one outlet's midnight into
another's request. `ctx.tz` is stamped alongside it, so `today(ctx)` in Node
computes on the clock Postgres just adopted.

In the terminal there is one day-key, `dayKey()`, and `today()` / `dayOf()` are
it. `dayKey()` had always used local parts while `today()` used `toISOString()`,
so the two disagreed inside one file.

Rows already written are repaired rather than left: migration 016 rewrites every
`business_date` from **its own timestamp in its own outlet's zone**, never from
"now" — stamping a week of history with today would be a worse lie than the one
being fixed. It is idempotent. The terminal does the same on read for persisted
`settled` rows, keeping the old value in `bizDateWas` so the change is
answerable.

The one date that is still UTC is the CSV export of epoch-DAY buckets, where
UTC is the correct reading and local parts would shift it back a day.

`test/api.test.js` asserts the transaction's zone and the refile; the wiring
test fails on any new UTC day-key in `app/index.html`. Run the suite under
`TZ=Indian/Maldives` as well as UTC — the bug only shows when the container's
zone differs from the outlet's.

## One number says where an order is

A ticket carries a **rung** — `ticket.stage`: 0 taking the order · 1 in the
kitchen · 2 ready at the pass · 3 served — and a fired line records the moment
the pass finished it (`ticket_line.ready_at`). That pair is the whole answer,
and every screen reads it: the KDS, Orders & Tickets, the ticket panel, the QR
tracker and the member card.

It is deliberately NOT `ticket.status`. That column is the bill's lifecycle —
open, held, closed, void — and where the food is and whether the money has been
taken are different questions. A served table that has not paid is exactly the
row a manager is looking for.

Both directions write here:

- the **pass** finishing food (`kds_bump`, `kds_bump_all`, `kds_recall`) marks
  the lines and recomputes the rung from them — 1 while anything is still up, 2
  when nothing is. **Rung 3 is never derived**: carrying the plates is a
  person's act, not the absence of one;
- the **floor** moving it by hand (`fulfil_stage`) sets the rung and cascades —
  Ready or later clears the pass, earlier puts the food back up, because
  dragging a stage backwards is a real correction and half of it is worse than
  neither;
- **firing a course** always returns the order to rung 1, or a later round tells
  the guest their food has arrived while it is on the grill.

The terminal derives the rung from its own lines only when nothing has written
one — a ticket adopted from the outlet, a session from an older build. An
explicit row always wins, because somebody pressed it and the lines were
cascaded in the same act.

What this replaced is worth knowing, because all four failure modes are the
same shape — a status nobody else could read:

- Orders & Tickets printed the literal string `"Open"` for every live ticket;
- the ticket panel kept `tk.flow`, a fifth idea nothing else ever read;
- `kds_bump` sent a **menu id** to a handler expecting a docket row, and
  `kds_bump_all` filtered on a station the payload never carried, so neither
  changed anything on the server;
- `fulfil_stage` updated **`dispatch`** — a stock transfer between outlets —
  with an id the op does not carry.

`ticket_status` still has a handler and no call site on purpose: a device that
was offline across this change may still be holding one in its outbox.

## The companies that move the money

A tender says how a guest paid. A **processor** is the contract that moves it —
its own rate, its own cycle, its own evidence. Card, wallet and QR used to be
blended into one daily batch checked against a single merchant rate, so a
gateway overcharging half a percent was indistinguishable from a terminal batch
landing a day early, and neither could be argued with a bank.

| id | Contract | Takes | Rate | Cycle | Sits in | Evidence | Batches |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `term` | BML Merchant Terminal | card | 1.5% | T+1 | 1030 | Approval code | yes |
| `wallet` | BML Pay | wallet | 1.0% | T+1 | 1030 | Wallet transaction id | yes |
| `gw` | Kashikeyo Online Gateway | qr | 2.4% | T+2 | 1030 | Gateway reference | yes |
| `direct` | Direct bank transfer | transfer | — | T+0 | 1020 | Transfer slip | **no** |

`cash` and `credit` have no processor: nobody stands between the guest and the
till. Rate, cycle and suspension are per-outlet overrides in `prefs().processors`;
the contract's shape is not, and a rate on a non-batching contract is **refused
by name**, because accepting a figure that never applies is worse.

**`batches: false` is load-bearing.** A direct transfer is routed but never
batched — no advice to match, no cycle to be late on. It posts its own bank
expectation on the day sent, which is a net gain: transfers were not on the
reconciliation screen at all.

One batch per **processor per day**, keyed `"<procId>|<YYYY-MM-DD>"`:

```
fee      = gross × rate
expected = gross − reversed − fee
variance = paid − expected          (flagged beyond a rufiyaa)
```

Sorted date desc, then processor — sorting on the composite key groups by
counterparty and scrambles the chronology. A batch filed under the bare date,
from before batches had processors, still resolves for `term`.

**A reversal never reopens a filed batch.** It nets off the next settlement that
processor has not yet paid, walking forward from the day it was authorised.
Reopening one the bank has already paid would restate a banked figure. A bucket
carrying only reversals has no tickets and a **negative** expected — the
processor will debit you — so it renders as a debit and can never be overdue,
because nothing is arriving. `settlementInTransit()` keeps the two apart.

The advice import offers **one dropdown of the batches still waiting**, labelled
by processor, date and expected net. The old form defaulted a typed date to
today while every open batch was dated differently, so the screen's primary
action failed on first use against the app's own default.

Suspending a contract takes its tender **off the till** rather than letting it
fail at the counter. Editing a rate re-checks every unmatched batch — `fee` and
`expected` are derived from the contract each time it is asked — and leaves
matched ones exactly as filed.

The till captures the evidence that processor issues, named the way it names it,
**typed by the operator off the slip the device printed** — this build has no
acquirer integration, so there is nothing that could fill it in. It USED to
pretend otherwise: a 780 ms "Waiting for the terminal…" spinner followed by a
six-digit code minted from Math.random and stamped into `ref` — fabricated
payment evidence that could never match any statement and silenced the
"Unreferenced card sales" exception lane on every card sale for ever. A blank
reference is the honest state: the sale settles, and the close chases it. The
reference lands on the settled row, which is what makes the settlement
screen's unreferenced count real rather than an artefact of never having asked.

## One place where money is taken

Settling goes through the till's pay screen — `modalVals()` under `kind: "pay"`.
It is the only implementation: cash tendering with quick notes and a keypad,
change due, foreign tender at a captured rate, even splits, tips, customer
credit against a limit, and cash rounding against the outlet's own `cashStep()`.

Orders & Tickets does NOT settle. Its **Take payment** sets `activeTable` and
opens that same screen on the ticket. The panel is for reading a bill, moving
its rung, and getting to the floor.

It used to close tickets itself, and the copy had drifted twice: first writing
eleven of twenty-four fields and booking the pre-discount subtotal as revenue,
and then — after that was repaired — still with **no tendering at all**. A
cashier taking cash could not say what the guest handed over, so the change was
never recorded and the drawer count at close was the first place anyone found
out. It also rounded cash at a hardcoded half-rufiyaa, which is wrong for a
dollar outlet, and carried a second tender list (`TENDER_SET`) that had no
wallet and called customer credit a "house account".

**A split bill remembers every share's tender.** Each share records its own
payment leg as it pays — method, amount, currency, rounding, reference — and
the sale op sends them all, so cash-then-card reaches the ledger as cash AND
card. It used to send one leg, the closing share's tender for the whole total:
wrong drawer, wrong receivable, wrong settlement batch. The share arithmetic
floors each share to the laari and the last share takes the remainder, so
nothing is lost between them — asserted against Postgres at 100.00 ÷ 3.
`cashTakings()` counts only the cash shares of a split, and the bill's cash
rounding is the SUM of what each cash share rounded, not the last one's.

If you are tempted to add a settle button somewhere new, open the pay screen
instead. `test/chain.test.js` asserts the panel exposes no `tkSettle` and no
tender list of its own.

## Points are a liability, not a discount

Redeeming **releases 2350 `Loyalty points liability` and recognises revenue**;
it does not reduce the sale. Get this wrong and the P&L understates revenue by
every point ever spent.

A CORRECTION THAT IS ALSO A WARNING: this paragraph used to say **2300**, which
is the SERVICE CHARGE pool, and the chart carried no loyalty account at all.
The till believed this file, queued `Dr 2300 / Cr 4000` on every redemption,
the server's till-owned guard refused it every time, and the redemption's value
was silently absorbed into 4900 as fake rounding. One wrong sentence here
became three defects in code. This file is a witness, not a source — when it
disagrees with the code, the code and the tests win, and the sentence gets
fixed the way this one just was.

The ledger legs are the server's, derived from the sale op
(`saleJournal` in `src/apply.js`) — the till composes no journal:

- at **earn**: `Dr 6550 Loyalty points expense / Cr 2350` for the granted
  points at the outlet's own redemption rate — tonight's promise is tonight's
  expense, not a surprise on the visit that spends it. A paused programme earns
  nothing and accrues nothing;
- at **redeem**: `Dr 2350` for `ptsValue`, while `4000` keeps the full goods
  figure. The sale row carries `pts` and `pts_value`, and `sale_adds_up` now
  reads `total = net + service + tax + rounding − pts_value` — the old
  constraint hard-coded the no-redemption identity, forcing a wrong total onto
  every redeemed sale (migration 022).

Both accounts are till-owned, so only the sale can move them, which is what
lets 2350 tie to the member balances. Disclosed: points earned before
migration 021 were never accrued, so 2350 opens at zero and early redemptions
can drive it negative until accruals wash through; points are also chain-wide
while ledgers are per-outlet, so one outlet's 2350 may run negative while the
estate's consolidated figure ties.

At the till: whole redemption blocks only — a half block is not something the
catalogue prices — never more than the bill, and taken off the **goods**, before
service and tax. A guest should not have service charged on money they did not
hand over, and the government should not be taxing a discount. One control steps
a block on and wraps back to none, so the same button spends and cancels.

Order of operations at close, and it matters:

1. debit the points spent;
2. **then** earn on what was actually charged for goods.

So a guest cannot earn points on the points they just spent. `applySale()` earns
on `net − ptsValue`, at the outlet's own rate, and a **paused** programme records
that nothing was earned rather than earning silently. Replay is already a no-op —
`op_log.op_id` is the primary key and a seen op short-circuits before the handler
runs — so a queued sale that replays twice cannot award twice.

Cash rounding is measured against **the figure actually being rounded**. It was
measured against the pre-points gross, so the redemption reappeared as a "cash
rounding" line worth exactly itself — on card sales, which are not rounded.

### One tier ladder

Thresholds are in **points**, and tier is **derived every time it is asked for**.
They were set on the spend scale while being measured in points, so every member
sat in Bronze while their row claimed Platinum — and the phone ranked on lifetime
spend against a *third* set again, so the same guest could read Platinum on their
phone and Bronze at the counter.

| Tier | Points | Lifetime goods |
| --- | --- | --- |
| Bronze | 0 | — |
| Silver | 500 | MVR 5,000 |
| Gold | 1,500 | MVR 15,000 |
| Platinum | 3,000 | MVR 30,000 |

That is the ladder the app SHIPS with, and an outlet that publishes its own
displaces it. Three copies of it had drifted apart — see "The books of a store
that has never traded" — and there is one now: `app/kashikeyo-data.js`,
`src/bootstrap.js` `DEFAULT_TIERS`, and the loyalty screen all read the same
four rungs.

**There is no `tier` column.** `chain.member.tier` was dropped in migration 019,
along with the two functions that carried it out to a phone — `member_code_take()`
and `member_card()`, each rebuilt without it, and re-granted to every outlet role
because a dropped function takes its grants with it. The till stopped sending one
on `member_upsert` at the same time: a value derived from what the outlet
published is not something the outlet needs told back.

A cache nothing reads is not harmless — it is a column still holding 'Platinum'
for a guest sitting in Bronze, waiting for the next person to write a query
against it. Which is exactly how three disagreeing ladders happened.

`memberLive()` composes the seed row with everything awarded since and works the
tier out, and every surface reads that one composition — the customers table, the
guest sheet, the pay screen, the published roster. Raising a threshold demotes
exactly the members it should without editing a soul. The shipped tier rows
survive only as presentation: the mark and the card gradient.

### What the till publishes to the phone

`publishGuest()` carries the **programme** (earn rate, redemption rate, live flag,
the ladder, the active rewards) and the **live roster** (points, visits, spend,
tier, last seen, credit, whether they may sign in). Settled rows carry `pts` and
`ptsValue`, so a receipt in the portal can say **why** the balance changed rather
than only that it did.

The phone quotes the merchant's published redemption rate, never a hard-coded
one — a hard-coded "10 points = MVR 1" quotes the guest a figure the till will
not honour the moment that rate is edited. A phone still awards itself nothing:
it is being told, not asked.

Portal sign-in is **gated on the invitation**. A revoked member keeps their
history and is refused with wording that says what to do. If no roster is
published at all the phone is offline, not withholding access — it falls through
to the code rather than locking a member out because the terminal is asleep.

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

## An empty pen is truthy, and a paid bill leaves the floor

Two reports in one sentence — *"still menu master addon is zero"* and *"qr
portal orders when settled shows received status"* — with nothing in common
but the shape: a local copy standing in front of the outlet's own answer.

**Menu Master read "Add-ons · 0"** on a store whose outlet publishes 115.
`modList()` answered `this.state.modifiers || K().MODIFIERS`, and **an empty
array is truthy** — so a terminal holding no un-synced add-on edit, which is
every terminal almost all the time, answered the outlet's whole catalogue with
nothing. A pen holding ONE row was worse than empty: it hid the other hundred
behind a single local edit, so the dish sheet offered one add-on and the CSV
export wrote one row. Every other local copy in this build is a **holding pen,
not a private fork** — a measured yield, a saved batch, a section's meta, the
loyalty programme — and this one had been written as the fork. It layers now:
the outlet is the floor, a held row replaces the outlet's copy of that same id
(this device's edit has not been delivered, so it is the later answer here),
and a held row the outlet has never published rides beside them.

**The QR tracker said "Received" for ever after the guest had paid.** The guest
snapshot's ticket query is `WHERE t.status = 'open'`, so the moment the counter
takes the money the table leaves the floor list the tracker reads — and
`stage()` fell through every live branch to its localStorage fallback, which is
this phone's own record of what it last SENT. `paidReceipt()` could not help:
it reads a CO-LOCATED till's localStorage, which only works when the phone and
the till share a browser, and a guest's phone never does.

Absence cannot be the answer, because an open list carries no reason — closed,
voided and moved all look identical from the phone. So the projection **says**
so: `settled`, a bounded window (two hours) joined through `sale.ticket_id` so
each row names the table the guest is sitting at, voided sales excluded, and
carrying nothing a guest may not see — no cost, no margin, no staff, no device,
no member id. `settledHere()` is the ladder's last rung, guarded the same way
`paidReceipt()` already guards its own: a settlement older than this phone's
last round belongs to an earlier sitting and is not this guest's.

**The rung states the exact total, through `money()` and never `fmt()`.**
`fmt()` rounds to whole units, which is right for a menu price and a lie on a
settled one — MVR 6.16 taken at the counter read "MVR 6" on the guest's own
record of what they paid. Measured on a phone at table 2: order, Received, the
counter opens the bill, the counter settles it, and the phone — untouched —
redraws the ladder ending on **Paid · Settled · MVR 6.16 · LOYC-R-010235**.

### And the add-ons had no door on a store that already had a menu

Reported straight after: *"menu master … addons is zero. I asked to bring all
addons list in that prot and add those."* Both halves were right, and the
second is a different defect from the pen above — that one made a store's OWN
add-ons unreadable, this one is a store that has none and no way to get them.

**"Load the pre-set menu" is drawn only while `MENU.length < 10`**, and that
gate is correct: it replays 301 `dish_upsert`s, which are exhaustive, so on a
store with a menu it would put the shipped name, price and description back
over everything the owner has since typed. But it was the ONLY door to the 112
add-ons. A store that reached its catalogue any other way — the CSV import, or
a build from before the add-ons were in the file — read "Add-ons · 0" for ever
with nothing on any screen to do about it.

`part: 'addons'` is the additive half, on the add-ons screen itself: the 112
groups and options and the 1,334 links that attach them to the dishes, and
**not one dish row**. Rank 5, idempotent, and offered only while the outlet is
still short of them.

**The links resolve by id and, failing that, by NAME.** They are composed
against the shipped catalogue's own ids, and a store only carries those if its
menu came from the pre-set load; a store that reached the same catalogue
through the CSV import holds every dish under an id its own terminal minted.
Measured before this was written, against a real outlet: 112 options landed and
**0 links**. Name is the key the rest of this build already resolves a menu on
— the CSV import matches sections, add-ons and dishes by name — compared
case- and space-insensitively, because a catalogue that went out through a
spreadsheet comes back with different capitalisation. **An ambiguous name
resolves to NOBODY**: two dishes under one name make "which one offers extra
cheese" a coin toss, and take-one-silently is what migration 018 and
`chain.member_resolve()` both exist to refuse.

**And an unknown dish is dropped, not a refusal.** `item_modifier.item_id` is a
foreign key, so a bare INSERT aborts the whole load on the first id this outlet
does not hold. It is guarded by an EXISTS now — the mirror of the rule
`dish_upsert` already keeps in the other direction, where an unknown add-on
group is dropped rather than making a dish unsaveable.

**`PRESET` is published in the bootstrap** (`presetCounts()`, counted from the
file) so no screen needs a literal 112 to know whether an outlet is short of
them, and the toast reports `links` — what actually **resolved at this outlet**,
never what the catalogue ships.

Measured by stripping outlet 39's add-ons and driving the shipped screen: Menu
Master reads 0, the whole-catalogue loader is correctly absent, **Load the
pre-set add-ons** lands 112 options in 112 groups with **1,334 links**, every
dish row is untouched, the dish reads its four back, the header reads 112, and
a second load converges.

### And the registry cannot be filed as one of its own customers

Found while running the suite for those two: `/api/account/signup` answering
`server error`, because `chain.account` was **missing from the registry** —
which also held `chain.company` and `chain.staff`, and listed ITSELF in
`chain.business` at 4 of 49.

`control()` has always refused to GUESS which database is the registry.
Nothing refused to **write** its name into `chain.business`, and
`businessForDb()` registers whatever database name it is handed — so an
ordinary path (a single-database install claiming itself, a provision
resolving the process's own database, an `adopt` run aimed at the wrong `--db`)
files the registry as customer N. The fleet then migrates it with the
**business** set, whose migration 011 is a tombstone that DROPS `chain.account`
and `chain.account_identity`: every account on the install, and the only record
of who owns each business, gone with no error anywhere. The first symptom is a
customer unable to sign up, three screens away from the cause.

Refused **by name** at both doors now — `refuseRegistry()` in `src/business.js`
and the same check in `src/scripts/adopt-install.js`, the latter *before* it
prints a dry run, because a plan that describes this is a plan somebody then
runs with `--apply`. `test/tenancy.test.js` asserts the refusal, that nothing
was written on the way to it, and that the CLI's guard precedes its own output.

## A row added on the till, and the bootstrap that ate it

Reported from a live store: a menu item added on the till disappeared from the
till grid AND the menu master the moment the first bill was rung. Two screens
at once, because both read `K().MENU`.

A back-office row created on the till lives in TWO places until the outlet
accepts it — `insertRow()` unshifts it into the live collection and holds a
copy in `state.local`. `applyLocal()` is what puts the held copy back after a
bootstrap replaces `window.KPOS` wholesale, and it was wired:

```js
if (!this.state.ready) window.addEventListener("kpos-data-ready", …);
else this.applyLocal();
```

`ready` starts as `!!window.KPOS`, and `kashikeyo-data.js` sets that and fires
`kpos-data-ready` before the component mounts — so the ELSE branch ran,
`applyLocal()` happened once, and **the listener was never registered**. Every
hydrate after that replaced the collections and nothing put the un-replayed
rows back. It is the same defect as the hidden/86 flags, the yields and the
batches, one level up: this time what was wiped was not a flag but the whole
row.

The trigger is the first BILL because that is the first push — a material push
fires `kpos-sync-done`, the bridge re-bootstraps, the menu is replaced.
Reloading brought it back, which is what made a lost row look like a display
glitch. It affected every collection in `COLLS`, not just dishes.

The listener is registered unconditionally now, and `applyLocal()` is
idempotent by construction (a row already present by key is skipped), so
replaying it on every bootstrap costs a comparison. **The server was never at
fault** — `dish_upsert` writes the row, and the bootstrap publishes it before
and after the sale; proved by pushing both against a real outlet.

## No dish is ever a blank tile

A menu starts life unphotographed, and every screen that renders one has to
survive that. What used to stand in was the dish's INITIALS on a short tinted
band — which reads as a placeholder rather than as a menu, and gave two dishes
in one section nothing to tell them apart but a colour.

**The section artifact** is the answer: the section's hue with the section's
glyph struck through it, composed from a seed so a dish's tile is stable
everywhere it appears and no two dishes in one section resolve to the same
one. `artSeed()` hashes the dish id (`h = (h*31 + c) % 99991`, then `% 4`) into
a rotation, a gradient angle and a ring offset.

Two variants, and the distinction is load-bearing. **Flat** in grids — one
resolved `color-mix`, no gradient — because a 300-dish menu means 300 plates
and a stacked gradient per plate is a rasterisation each. **Rich** on a single
tile (the editor's preview), where the gradient and the decorative ring cost
nothing.

**One masked span per tile, never an `<svg>` per tile.** Three hundred inline
SVGs plus three hundred gradient plates saturate the main thread on a section
switch; a mask is a single paint the compositor already knows. The style is
cached per `id|hue|icon|variant`, because the till repaints this grid on every
section switch and every line added.

**A SEMICOLON ENDS AN INLINE DECLARATION, and that is two silent defects.**
`data:image/svg+xml;utf8,…` truncates at its own semicolon when concatenated
into a style string, so the mask is dropped and the glyph paints as a SOLID
BLOCK of hue. `data:image/jpeg;base64,…` does the same in
`background-image:url(…)` and paints nothing at all. Neither errors anywhere.
So the mask URL is `data:image/svg+xml,` with the payload percent-encoded, and
a photograph is rendered from a **blob: URL** minted by `photoUrl()` — the data
URL is what persists, the blob is what CSS is given, cached per data URL for
the session. `test/menuvisuals.test.js` asserts no composed URL carries a
semicolon.

**One glyph set, in `app/kashikeyo-data.js`**, because the guest's phone draws
the same plates. A second copy is how the allergen table ended up with two key
vocabularies — "shellfish" in one and "crustacean" in the other — so a diet
that blocked one never blocked the other. The till reads `SECTION_GLYPHS` and
`SECTION_HUES` from there; neither app holds a path of its own, and the test
fails on any that does. The guest portal is told category NAMES and no icon
key, so `glyphFor()` matches by keyword — "Hedhikaa" gets the starter glyph
rather than a generic square.

**A dish photograph is downscaled on the device**: 720px on its longest side at
q0.82, which lands around 60–120 KB. A 4 MB camera JPEG in the offline cache
costs the terminal its whole storage budget. `item.image`, `dish_upsert` and
the bootstrap have carried `img` since the schema was written; what was missing
was every part of the client — the upload, the render and the editor block.

### The till tile is a record, not a poster

A 74px plate leads, the name and description sit beside it, and the trade facts
get a bar of their own: price, cost percentage, and a stepper. A dish is read
in one line of sight and the grid holds three times as many of them, where the
old media band across the top cost every card its height and told a cashier
nothing.

**A button cannot contain a button.** The card is a container, the face is the
+1 target, and the stepper sits outside it — nesting them makes the markup
invalid and the inner taps unreliable. The stepper is also what makes a
mis-tap a correction rather than a void: `qtyOnTicket()` reads what is already
on the share being served and `stepLine()` takes one off, refusing a line the
kitchen already has by name.

`content-visibility:auto` with `contain-intrinsic-size: auto 132px`, so the
tiles below the fold cost nothing until they are scrolled to.

### Both rails scroll; neither wraps

The till's section rail is **one scrolling row**. The selected tab is filled
with its own section's hue and drops its dot, because its whole field is
already that colour; an unselected tab leads with the dot instead, which is
what makes the hue readable across the whole rail rather than only on whichever
one is current. The count is a **bare numeral** — it read "19 dishes" on every
tab, so the word said nothing on any of them and cost the rail the width it
needed to show the next section.

The back-office strip is a **recessed track carrying one raised chip**. A black
filled pill in a row of outlined ones reads as a button that does something,
not as where you are.

**The native `<select>` picker is deleted.** Any strip past five tabs used to
collapse on a phone into a card with an invisible select over it — which hid
the counts and the section hues, showed nothing until it was tapped, and
replaced a rail somebody could read with a control they had to open. The track
scrolls at every width.

**The track is what yields.** `flex:1 1 auto; min-width:0` on the track and
`flex:0 0 auto; min-width:max-content` on the actions. The other way round let
the actions' nowrap buttons overflow leftwards, paint on top of the tabs and
swallow their taps — measured in a browser, and now asserted there.

### Long lists page

The till renders the first 60 of the filtered set and tables 100 rows (40 on a
phone, where each row is a stacked record and costs more). Both offer the same
dashed "load the rest", and the cap lifts for the session — it resets nothing.
Measured on the prototype: the till screen 9,230 → 2,123 DOM nodes, Menu Master
12,427 → 4,074.

### The guest side is one background layer per plate

Same composition, guest palette, and **no extra element**: the hue is baked
into the glyph's own `stroke`, so the artifact is a `background-image` plus a
`background-color` rather than a masked span over a tinted box. A phone
painting twenty of these while the guest scrolls has a frame budget the counter
does not. The dish hero stays a dark field whether or not there is a
photograph, because the phone's own white status bar and back button sit on top
of it.

## A refusal that names itself, or a till that dies quietly

Reported: *"while sharing a completed receipt, it says session expired."*
Three things were wrong on that path and not one of them was the share.

**The server writes a sentence for each case and the client threw both away.**
`session()` answers a revoked session with *"This session was signed out — key
your PIN to sign back in"* and a deregistered device with *"This terminal has
been deregistered — ask a manager to enrol it again"* — worded apart on purpose,
because one is fixed by keying four digits and the other is not fixed by
anything the person holding it can do. `_fetch()` replaced both with the words
"session expired". So the only report anybody could make carried the symptom
and destroyed the fact, which is why this one could not be diagnosed from it.
The body is read BEFORE the status is judged now — that ordering is the fix —
and the server's own words are what reach the screen.

**And `kpos-session-expired` was dispatched into an empty room.** No listener,
anywhere in the build: the same defect as the poll that fired `kpos-tick` and
was discarded. So a 401 dropped the token in SILENCE — the poll stopped, the
outbox stopped delivering, and the only thing on any screen was a toast on
whatever the operator happened to be doing. A side errand took the whole till
down without saying so. The terminal locks on it now, with the reason, and
names what it is holding: undelivered work is durable in the outbox and
survives this, and whoever is standing there needs telling it resumes when
somebody signs in — the same rule signing out by hand already follows.

**Measured**: a session revoked out from under a live till, which the poll
notices within its own thirty-second window. Before: "session expired", token
gone, no lock screen. After: *"This session was signed out — key your PIN to
sign back in"*, the keypad, and a `session` fault on Diagnostics naming the
call that hit it.

**What this does NOT explain**, and is stated as open: what made that share
return 401 in the first place. `atLeast()` answers 403 and never 401, the rate
limiter answers 429, `stillGood()` fails open on an unreachable database and
treats an absent session row as honest — so the only 401 left is a token that
failed `verify()`. The production logs show `/sync/pull` returning 200 on the
same token every five seconds either side of it, which is the one story that
does not fit. The path is instrumented rather than guessed at: the next
occurrence names itself.

## A fault says whose fault it is

Found on a live till's own Diagnostics screen: two caught faults, both
**"Failed to connect to MetaMask"** — a wallet extension injected into the page
— reported under the terminal's own copy, *"a fault that repeats on one action
is a bug to report, not a glitch to re-tap"*. Everything else on that screen was
green. So the one line drawing an operator's eye was pointing them at software
this project does not ship.

An extension throws into `window.onerror` and `unhandledrejection` exactly as
the terminal's own code does, and the scheme on the frame is the difference:
`chrome-extension://`, `moz-extension://`, `safari-web-extension://`. `faultFrom()`
reads it, so the origin is RECORDED rather than guessed at later from the
wording.

Nothing is hidden — suppressing a fault would be the opposite lie, and an
extension that breaks a print or a camera is worth seeing. Both are counted and
both are shown. What changed is that only the terminal's OWN faults make the
line a warning, because only those are something anybody here can fix, and the
foreign ones say where they came from instead of asking for a bug report.

## An id minted on a device is unique across devices

Reported from a live store: three menu items added, two on one browser and one
on another, and neither browser showed all three.

`nextId()` counts the rows THAT BROWSER is holding and adds one. Two terminals
that have not yet seen each other's work therefore mint the SAME id — and
`dish_upsert` upserts on it, so the second one to reach the outlet **silently
destroys the first**. Measured in two real browsers against a real outlet
before this was written: three dishes added, **two rows left**, and the one
that vanished had a toast saying it was created.

Within one browser it is fine, and that is what made it invisible: `insertRow()`
unshifts the new row into the collection before queueing, so a terminal adding
two in a row gets `m4` then `m5`. Only the SECOND terminal collides, which is
exactly the case nobody tests by hand.

This build already answers this twice — `opId` is a v4 uuid from the platform
CSPRNG, and `ticket_line.client_id` is a uuid because a line created offline has
to be nameable before any server has seen it. A menu row is the same problem, so
`newId()` gives it the same answer: a readable prefix, a time component and five
CSPRNG bytes, minted locally and never from a count of what this device happens
to hold. A browser with no CSPRNG registers a **fault** rather than falling back
quietly, because a collision here costs a row.

**And the first version of that was itself too weak**, which is worth keeping
here because it is the same defect one layer down. Each byte was encoded as
`(b + 256).toString(36).slice(1)` — meant as zero-padding, except that
expression is ALWAYS two base36 digits for a byte and the slice threw the first
one away, collapsing 256 values onto 36. Four bytes became 1.68 million
combinations rather than 2^32, and two devices minting inside the same
millisecond collided about once in a thousand. The test draws twenty thousand
ids from two instances as fast as the loop runs — so nearly all of them share a
millisecond and the random half is what has to carry them — and it caught this
at 999 of 1000 before it shipped.

**The whole class went the same way, not just the dish that was reported.**
Fourteen call sites now mint; two still count, and they are the two whose id
never becomes a key at the outlet — an outlet row is replaced by the id the
REGISTRY allocates, and a supplier's op resolves by NAME and carries no id at
all. `test/wiring.test.js` pins that list, so a third has to justify itself
there.

**The item master was the worst of them, and it is not a lost row.**
`recipe_line.ingredient_id` and `stock_move.ingredient_id` both reference
`ingredient.id`, and the id was `max(existing) + 1` over the rows one browser
held. So two devices minting the same one does not merely overwrite a record:
it **re-points every recipe and every stock movement at a different
ingredient**, and the only symptom is a margin and a shelf that are quietly
wrong. Measured against a real outlet: two ingredients added from two devices,
**one row left** — "DEVICE A FLOUR" replaced by "DEVICE B SUGAR" under the same
id, with any recipe on it silently switched from one to the other.

**A batch's prefix is load-bearing.** `isSub()` tells a batch from an ingredient
by the FIRST CHARACTER, so a batch mints as `S…` and an ingredient as `i…`; the
test asserts two hundred of each are classified correctly, because an
ingredient that happened to start with an S would be costed as a batch nobody
has.

The clock-only ids went too — opex, assets, employees, modifiers and rewards
were `"e" + Date.now()` and friends. Two devices in the same millisecond is
unlikely and not impossible, and the cost is a row.

## A bill the outlet no longer lists has been closed

Reported: *"tickets do not disappear from the other device."*

`buildLive()` sends the floor **whole** — every open and held ticket, on every
tick — precisely so that absence is an answer. `seed()` read it as no answer at
all: `if (!there) { mine[k] = here; return; }` kept the local copy
unconditionally, so a table settled at the counter stayed on the tablet for
ever. The money was taken, the docket was gone from the pass, and the floor
plan still showed the table occupied until somebody reloaded.

Two cases are indistinguishable by absence alone and only one may be dropped:

- a bill this device **adopted** from the outlet, which the outlet has now
  stopped listing — closed, voided or moved, and it goes;
- a bill this device **opened**, which the outlet has never heard of, whose
  lines may still be in the outbox — dropping it would throw away a bill
  somebody is standing at.

`src: "outlet"` is stamped on every ticket `seed()` adopts, and it is the only
thing that separates them. A ticket this device opened acquires the mark the
moment the outlet starts listing it, which is exactly when it becomes safe to
drop later.

**And somebody may be standing at the one that went.** Dropping a settled table
out from under a waiter who has it open, leaving them on a bill with no rows,
is a screen that reads as broken rather than as moved. The panel and the pay
screen close and the operator is told the bill was settled on another terminal.

**A tick that carries nothing changes nothing.** `buildLive()` degrades to
`state: null` rather than failing the poll, and a floor emptied by a failed
read would be every table in the shop vanishing at once.

Measured in two real browsers on one outlet:

| | |
| --- | --- |
| a table opened with a line on A | reached B in **4.0 s** |
| that bill settled on A | left B's floor in **5.0 s** |

Before the fix the raw slice cleared on B and B's own floor still held
`39:5` — which is what a person sees.

## Everything the dish editor collects reaches the outlet

Reported: *"an item added shows, and its tags and heat are not recorded and
synced."* The form asks for eleven things and the op carried eight. Three
fields were collected, toasted as saved, and reached the outlet never — each
failing in a different way, which is why none of them looked like the others.

| field | column | handler wrote it | bootstrap published it | op SENT it |
| --- | --- | --- | --- | --- |
| `tags` | since 003 | yes | yes | **no** |
| `spice` | **none** | no | no | **no** |
| `addons` | `item_modifier` | only via `modifier_update` | no | **no** |

**Tags needed no schema at all.** The column was there from the first
migration, `H.dish_upsert` wrote `arr(p.tags)`, and `menuOf` published
`r.tags` — and `COLLECTION_OP.menu` never sent them, so every save arrived
with `tags` undefined, `arr()` made it an empty array, and the dish came back
with Chef's pick, New, Signature and Gluten free erased. Four correct pieces
and one missing line.

**Heat had nowhere to go.** `dishSpice()` reads `m.spice`, the editor collects
it on a four-rung scale, and no table in this build has ever had a column for
it — it lived in whatever object the modal was holding and died with it.
Migration 041 gives it one. Zero is a real answer and is the default, because
"not spicy" is a statement a kitchen makes rather than the absence of one, and
the CHECK is the editor's own scale.

**Silence preserves, for tags and heat as it already did for `off_menu`.**
`coalesce($13, item.tags)` means a caller that says nothing keeps what is
there and a caller that means "no tags" sends `[]`. Without it a bulk import
or an older build would strip a dish on every pass. A heat figure off the
scale is clamped rather than refusing the save: no money is involved and a
dish nobody can save is worse than one whose chilli count was rounded.

**Add-ons are three-state and the third is the default.** An array is exactly
these groups, an empty array is none, and `null` is "inherit the section" —
what the editor draws as *Section default* and what a dish nobody has chosen
for carries. So only an ARRAY is written, and writing one is exhaustive. An
unknown group is dropped rather than refusing the save, because a dish that
will not save over a stale add-on list is a dish nobody can edit.

**And the CSV import carried none of it.** `H.menu_import` has always existed
and loops `dish_upsert` over what it is given; the call site sent a label and
nothing else, so a menu imported from a spreadsheet was written into one
browser and reached the outlet never — the added rows would eventually go out
through the holding pen, and the UPDATED ones are patches and would not have
gone at all. It composes its payload through `opFor("menu", …)`, the one
mapping every dish write goes through, so an imported dish and a typed one
arrive in the same shape.

**And the import takes a FILE now, not only a paste.** The Import & export
modal had a paste box and a dry-run plan, and no way to hand it the `.csv`
the spreadsheet actually saved — and Menu Master's one button opened on the
EXPORT tab, so "import a CSV" began with a download screen. Menu Master
carries **Import CSV**, opening straight onto the import tab; *Choose a CSV
file…* reads the file into the SAME text the paste box feeds, so there is one
road to the plan however the rows arrive, and the plan still dry-runs first:
new dishes counted, updates counted, a bad row rejected BY NAME (row number,
dish, reason) before anything is written. Driven end to end in Chromium
through the real file chooser: the new dish landed at the outlet in its
section with its tags and heat, the existing dish's price was updated in
place, and the unknown-section row was refused on screen.
`test/wiring.test.js` pins the door, the picker and the one road.

**And ONE FILE carries the whole menu — sections and add-ons ride it too.**
The CSV leads with a `type` column (`section` · `addon` · `dish`; a file from
before the column has none and every row is a dish). A section row carries
its name, station and visibility; an addon row its price and the sections it
publishes to; matching is by NAME for all three, and three sweeps — sections,
then add-ons, then dishes — mean a dish may sit in a section defined
anywhere in the same file. **The queue order is the apply order**, and it is
not negotiable: sections first (a dish naming one that has not landed is
refused by `item_category_id_fkey` — the reconcileCats() lesson), add-on
GROUPS before the dishes (a dish naming a new add-on writes an
`item_modifier` row whose group must already exist), dishes, then the
section LINKS last, once every dish in the file exists to be linked. A new
section's id is a stable slug of its name, so two devices importing one file
converge; the import adds and updates and never removes.

Building it found the next bare op: **`setMods()` queued `modifier_update`
with a label and NO PAYLOAD**, so every add-on created, repriced or
republished on the till lived in one browser's session and reached the
outlet never — the section defect one collection over. `modWrite()` is the
seam now: the group (one per till-made add-on, under the add-on's own id,
and an outlet group holding several options keeps its own record), the
option, and the item links the bootstrap derives `cats` back out of.
Removing one queues `modifier_remove`, which the server honours (the group
goes with its last option). `state.modifiers` follows the pen rule —
`reconcileMods()` drops it once the outlet publishes every held id.
`test/wiring.test.js` drives the plan and the apply in a vm and pins the
queue order; the Chromium drive reads the section, the group, the option,
the dish and the link back out of the outlet's own tables.

Measured by driving the real editor — tick Chef's pick and Signature, set the
heat to Hot, Create dish:

```
A right after save:  {"tags":["chef","signature"],"spice":3}
A after a bootstrap: {"tags":["chef","signature"],"spice":3}
B (never touched):   {"tags":["chef","signature"],"spice":3}
outlet_39.item       MASALA TEA | {chef,signature} | 3 | mains
```

## Two honest kinds of menu item, and a third switch on every one

Most Maldivian outlets sell a mix: curries cooked in the kitchen, and hedhika,
pastry and bottled drinks that arrive READY TO SELL — from a supplier, or from
a person with a tray at seven in the morning. Migration 048 models it as one
nullable link on `item`: `buy_item` (an ingredient), `buy_vendor`, `buy_pack`.
NULL is made here, costed from the recipe; set, the dish costs the supplier's
last price ÷ pack, fires to the `counter` station (nothing is cooked), one
sale takes `1/buy_pack` of the linked item itself off the shelf, and setting
the link CLEARS the recipe — two answers to "what does this cost" is the
defect. `buy_pack` is the field most tills forget: the supplier delivers a
box, the guest buys a piece, and getting it wrong makes the count wrong from
the first delivery, quietly. A bought-in stock item is counted, costed and
sold in ONE unit (base = stock); the dish's pack does the sellable conversion.

**Both runtimes deduct it by the same rule** — `explodeSold()`/`saleTrail()`
on the till, the `bought` query in `deriveConsumption()` on the server — with
NO yield gross-up (nothing is trimmed off a can of Coke), so the drift check
stays a check. Proven: a sale pushed with the till's claim lands with no
`qty_mismatch` and the move re-valued at WAC.

**Portions is the shelf talking.** `dishPortions()` gives the three answers —
`null` (nothing to count from: no recipe and not bought in), `{n: null}` (it
counts from rows the item master does not hold), `{n}` (the measured figure,
floored to the tightest ingredient GROSS of trim, or units × pack). A measured
ZERO is a fact and is UNCAPPED in `eightySix()` — capping it was the shipped
prototype's own defect, 43 of 46 empty trays left on sale — while the recipe
heuristic stays capped because a guess that fires on every dish is a cry-wolf
list. `passCache()` memoises the consumption bag per render pass (a microtask
clears it, so a stale figure cannot outlive a write): the 301-row grid
recomputing it per row was a measured one-to-two seconds per tab tap. The
Menu Master grid carries a Portions column; the till tile carries a badge —
a tray always says what is left, a made dish speaks only below six. The
status chip ladder is Hidden → Sold out → 86'd → Till only → Live.

**Hidden, 86, and off-the-QR are three switches, not one** — three questions,
three lifespans, three people. `qr_off` on `item` AND on `menu_category`
takes a dish or a whole section off the GUEST's phone while the counter keeps
ringing it, which is what a tray you will not restock needs. It rides the
same seams every other fact does (`dish_upsert` and `menu_category_insert`,
silence-preserving) and is resolved SERVER-SIDE in the guest snapshot — the
projection's items query filters `qr_off` and hidden sections in one place,
so the table menu and the member portal can never disagree, and a reload
changes nothing because the row is the outlet's. A bought-in tray at zero
also sells ITSELF out there: the projection folds an empty shelf into
`sold_out_reason` so both portals read Sold out with nobody touching a
switch.

**The floor got the counter's tools.** A 420ms hold or right-click on a dish
tile — the same gesture as the table tiles, `_lp` flag so the sheet never
also rings a line — opens the dish sheet: what's left (naming the tightest
line), receive at the door, 86, the QR switch, and Edit for menu-edit ranks.
The section rail gains a **Counter** chip (bought-in only, lowest stock
first); the **Counter stock sheet** (`counterSheet()`, rank 2) carries the
trays with 86/QR buttons per row, section chips that take a whole section
off the phone, search over the whole menu, and — rank 3+ — the blind door
receipts still waiting to be priced. The Today list raises "Counter trays
running out" apart from the 86 warning, because the remedy is a delivery,
not a chef.

**The door delivery** (`door_receipt` + `door_priced`, tables in 048, DD
series in `chain.doc_series`). The gulha man is not a vendor invoice and a
GRN pad: a tray, a count and a price, taken in under a minute, and a CASHIER
may do it. A person is NOT a supplier record — the name is mandatory on the
receipt where MIRA can find it, and the master stays a list of accounts with
terms. BLIND RECEIVING IS ENFORCED WHERE THE OP APPLIES: a rate from a
rank-2 caller is refused by name ("Pricing a delivery needs a manager"),
because the count is only evidence if the person counting cannot see the
expected figure. Stock lands immediately; a priced receipt posts
`Dr 1200 / Cr 1010` for cash — CASH AT THE DOOR IS NEVER A PAYABLE, the
money already left the drawer — or `Cr 2100` plus a vendor invoice on
account; `door_priced` values a blind one afterwards with the same weighted
re-average a delivery gets.

**The CSV carries all of it.** Columns are now `type, id, name, section,
price, description, station, tags, spice, addons, visible, qr, source,
stock_item, pack, supplier`. The `id`, when present and it resolves, is the
match key — so a rename is a rename rather than a duplicate; a duplicate
dish name in one file is refused ("Appears twice in this file") rather than
last-wins; `source=bought` requires a `stock_item` that resolves (by code,
id or name) and a supplier that exists, each refused by name; `qr=no` takes
the dish (or a section row) off the guest channel on import. The download
carries a UTF-8 BOM (Excel on Windows reads BOM-less UTF-8 as the system
codepage) and `parseCsv()` strips one on the way in. Proven through the
shipped screen with the merchant's real catalogue: 9 sections, 112 add-ons
and 8 resale items landed through the real ops, then the 301-row
`menu-full.csv` planned clean (0 rejected), landed whole at the outlet with
the eight bought-in links and packs intact, and re-imported as 0 new / 301
updated / 0 rejected.

What this deliberately does not do: the handoff's REMOTE-stock answer (a
pale figure from "the main store") — stock here is per outlet by the
isolation model, so Portions answers for this outlet's own shelf and
`null` stays distinct from zero; and the handoff's rank-stripped
`GET /api/menu` — the bootstrap is this build's read, costs are gated on
screen by `can()`, and the guest plane (the only anonymous one) carries no
cost at all.

## The outlet does not always keep the id this device minted

Reported: *"when I add a customer I see a duplicate record, but when I log in
from another browser it shows correctly."*

A dish is upserted BY the id the till gave it, so the holding pen finds the
outlet's copy by that id. A **customer is not**: `member_upsert` ignores an id
that is not a uuid — which is every id a till invents — and the outlet issues
its own. So the row comes back under a DIFFERENT id, the pen never matches it,
and `applyLocal()` unshifts the local copy on top of the outlet's on every
bootstrap. Two rows, on the browser that added them and nowhere else.

Measured by driving Guests & Credit in two real browsers, before and after:

| | before | after |
| --- | --- | --- |
| the browser that added them | `cb7omh198c077a27i` **and** `c83f9160-…` | `f1fc0e0a-…` |
| a second browser, untouched | `c83f9160-…` | `f1fc0e0a-…` |

`NATURAL_KEY` names the field the outlet actually keys a collection on — a
customer by `phone`, a supplier by `name` — and `sameRow()` is what lets the
pen recognise its own row coming back wearing the id the outlet chose. It
**falls back to the id** where the natural key is missing on either side, so
two half-filled rows are never silently merged into one customer.

**And the outlet's suppliers reached no terminal at all.** `chain.supplier` has
been read and published as `KPOS.VENDORS` since the schema was written, and
**nothing has ever read `KPOS.VENDORS`** — every vendor screen, purchase form
and export reads `KPOS_RAW.vendors`, which the bootstrap published as a literal
`[]`. Same shape as `oset`, one collection along: a vendor added on one device
lived in that browser's pen for ever, and the outlet's own supplier list was
invisible everywhere. Only the columns `chain.supplier` actually has are
published — a kind, a credit limit and an address are fields the form collects
and the table has no column for, and inventing them would be worse than the
screen's own "not recorded".

## The first dish a store ever creates

This is the root of every *"I added menu items and the other device does not
show them"* report, and the reason three fixes before it did not help: they
made a lost row RECOVERABLE and said nothing about a row that could never land
in the first place.

The dish editor defaulted its section to `(cats[0] || {}).id || "mains"`. A
store that has not made a section yet has no `cats[0]` — so **every dish on a
brand-new store was created in a section called `mains` that nobody had ever
created**, and `item_category_id_fkey` refused it on every retry, for ever. The
toast said "Dish created", the holding pen re-drew the row on that browser
after every bootstrap, and no other terminal ever saw it. The AI menu builder
had the same literal fallback.

Measured by driving the SHIPPED SCREENS in two real browsers — sign in, Menu
Master, New dish, type a name and a price, Create dish:

| | before | after |
| --- | --- | --- |
| browser A | `MASALA TEA` | `Mains` · `MASALA TEA` |
| browser B, same account | **nothing** | `Mains` · `MASALA TEA` |
| `outlet_39.item` | **0 rows** | 1 row |
| `outlet_39.op_log` | **0 rows** | `menu_category_insert` then `dish_upsert` |

The op never survived its first apply, which is why nothing was parked and
nothing was visible anywhere: there was no evidence to find.

`ensureSection()` makes the section real BEFORE the dish is queued, through the
same one seam a section write already goes through — so it carries the lower
lamport and is applied first in the same push. The id is kept **stable**
(`mains`, `drinks`, …) rather than minted, because the write is an upsert keyed
by it and two devices that both need a Mains section must converge on one row;
that is the opposite rule from a DISH id, and deliberately so. A shipped id
gets its shipped NAME — a section called "mains" on the till rail and the
guest's menu is the same defect wearing a lower-case letter.

**Why the suite did not catch it.** Every test in it enqueued ops directly,
which skips the dish editor, `insertRow()` and `queue()` entirely — the whole
client half. `test/wiring.test.js` now drives the editor itself, on a store
with no sections, and fails against the version that shipped.

## A failure this shape has only one symptom, so the till says it

Reported three times in one day, each time in the same words — *"I still don't
see the menu items on the other device"* — and each time the symptom points at
the wrong device. A back-office row lives in two places until the outlet
accepts it, and the failure of that lane is **invisible by construction**: the
row is re-drawn on the browser that made it, on every bootstrap, so THAT screen
looks right while every other terminal in the shop shows nothing. Three
speculative fixes went out against a symptom nobody could see the cause of,
which is the argument for making the cause visible instead.

Sync & Devices leads with **Held on this device** now: what this terminal is
holding that the outlet has no record of, each row with the reason it is stuck,
and one control — **Ask the outlet again** — that clears this session's marks
and replays the pen. The reasons are different situations and only one of them
resolves on its own:

| reason | what it means |
| --- | --- |
| waiting to be delivered | the re-send will carry it; it goes on the next sign-in |
| its menu section has not reached the outlet either | nobody can save this dish until that section exists — it is held rather than parked again |
| this record has no write yet | an audit-only collection; there is nothing to send |

The count uses the same IDENTITY test `applyLocal()` uses, and for the same
reason: this device is what puts the held row into the collection, so a match
by key alone would report its own work as delivered. A row the outlet accepts
leaves the list, because a card that keeps counting delivered rows is one
nobody reads by the second week.

Measured in a browser, on a terminal holding two dishes — one whose section the
outlet has and one whose section is nowhere: the first is re-sent and lands,
the second is named on the card with its reason, and the count reads **1**.

## A second device is not a second customer

Reported: *"when I log in from another device from the browser, no menu item is
there."*

A browser that has never been told which store it belongs to answers
`needStore`, and the bridge sends it to `/account`. **Two completely different
errands arrive at that one door** — a new customer from the website, and an
owner whose second device needs telling — and the page opened on *Create your
account* for both, with **Create account** as the primary button. Following it
makes a second account, a second business and an empty store, silently, and the
till then points at it. That is the reported symptom exactly.

`needStore` has been in the install answer all along and the bridge never read
it: it treated "this install has never been set up" and "this browser has not
been told" as one state. It carries the errand in the address now
(`/account?store=1`), the page opens on **Sign in**, and the heading says
*"Which store is this terminal?"* rather than describing a sign-up. The front
door keeps its own default, because a customer arriving from the website IS
signing up.

Measured on a genuinely empty browser — no localStorage at all, which is the
state a second machine is really in — signing in with the same account: the
terminal is stamped with the outlet, the PIN screen comes up, and the menu is
there. Then, with both devices signed in from that one login and only one of
them touched:

| what moved on device A | reached device B in |
| --- | --- |
| a setting (`kdsSla`) | **1.0 s** |
| a new dish | **4.0 s** |
| a table opened with a line on it | **4.0 s** |

**What this does not explain.** A menu that is empty at the OUTLET is empty on
every device, and that is the holding-pen class above, not this. The two are
told apart by opening the till on the browser that created the items: if they
appear there and nowhere else, they are in that browser's pen; if they appear
nowhere, they never landed.

## Handing over and leaving are different decisions

Asked plainly — *"how to log out of the application"* — and the honest answer
was that you could not. The identity sheet in the top bar offered **Switch
user**, which clears who is on the screen and KEEPS the token. That is right
for a handover a dozen times a shift: the till is still the till, and its
outbox is still delivering behind the lock screen. It is not signing out.

Actually leaving was offered nowhere. `POST /api/auth/signout` has been written
since the API was, `KPOS_SYNC.signOut()` calls it and drops the token, and
**nothing had ever called that** — the bridge did not even expose it. So a copy
of a browser's storage stayed a way into the till until the token expired on
its own, and the one screen a person would look at for this had one row where
it needed two.

- **`lockTill()`** is the handover, under its own name so the two can never
  quietly become one. It keeps the token on purpose.
- **Sign out of this terminal** drops the token, stops the poll and revokes
  `chain.session.revoked_at`, which `src/revoked.js` reads on every
  authenticated request — so the refusal is immediate rather than "until it
  expires". Measured against a live outlet: the token is 200 before and **401
  after**, and no other session is touched.
- **Undelivered work is NAMED, not blocked.** The confirm counts what has not
  reached the outlet. Those ops are durable in IndexedDB and survive signing
  out; what changes is that nothing will deliver them until somebody signs in
  here again, and that is a fact whoever is walking away needs *before* they
  walk away. Two taps, because this sits on a touch sheet beside the theme
  toggle.
- **`/account` bounces a signed-in owner straight to the till**, so the only
  screen that can strand somebody is "One more thing" — signed in, one word
  short of a business, with nothing saying whose account that is. It carries
  **Not you? Sign out** now. There is no cookie and no server session on that
  plane: an account token is a signed blob that expires on its own, so dropping
  it is the whole of signing out there.

## A row the outlet has no record of has not been delivered

Reported straight after the section fix landed: *"I added three menu items, two
from one browser and one from another, and I still don't see them all."*

A back-office row lives in TWO places until the outlet accepts it — the live
collection and `state.local` — and `applyLocal()` is what puts the held copy
back after a bootstrap replaces `window.KPOS` wholesale. **It did only that.**
So a row whose op was refused (a dish whose section had never arrived),
overwritten (two devices minting the same id), or recorded as `unmodelled` was
re-drawn on the browser that made it on every bootstrap **for ever**, and
existed nowhere else. The screen said saved and the shop had no such dish. That
is why fixing the section and the id did not bring the earlier rows back: those
fixes stop new rows being lost and say nothing about the ones already sitting
in a pen.

`applyLocal()` is both halves of the holding-pen rule now, over every
collection rather than only the sections:

- **a held row the outlet does NOT have is queued again**, carrying the row —
  once per session per row, because the outbox owns retrying and queueing on
  every five-second poll is how a hot outbox is made, and only where the
  collection has a real op, so an audit-only collection stays audit-only;
- **a held row the outlet DOES have is dropped**, or the local copy shadows
  every later edit made anywhere else.

**Matched by IDENTITY, not by key.** This function is what puts the held row
into the collection, so a later pass finds an id it inserted itself — and
reading that as "the outlet has it" drops the row from the pen on the strength
of its own work. A bootstrap replaces the collection wholesale, so the outlet's
copy is always a different object and ours is always the same one.

**And nothing is asked for before the outlet has answered.** This is the fence,
and without it the whole lane is decoration — measured in a browser exactly
that way, on the first version: before a bootstrap the collections are still
the SHIPPED list, so every held row reads as missing, and `KPOS_SYNC` — the
durable outbox — is not loaded yet, so `queue()` records the op locally and
enqueues nothing. The op evaporates, the row is marked as asked for, and the
terminal never asks again. `outletAnswered()` is that fence, and
`reconcileCats()` had the same defect and now shares it.

**And the SECTION goes first.** A push is applied in lamport order, which is
the order the ops were queued in — so a dish queued before the section it sits
in is APPLIED before it, and `item_category_id_fkey` refuses it exactly as it
did the first time. Reported off a live Sync screen while the first version of
this had it the wrong way round:

```
Dish created · NESCAFE MILK at MVR 20 — insert or update on table "item"
violates foreign key constraint "item_category_id_fkey"
```

`reconcileCats()` runs at the TOP of `applyLocal()` now, so a held section
carries the lower lamport. A re-send lane that re-creates the refusal it exists
to clear is worse than none, because it parks a second op saying what the first
one said — which is also why `rowCanLand()` holds back a dish naming a section
that is neither at the outlet nor in this pen: nobody can save that dish, so it
waits on the screen instead of parking again.

**And the refusal is read by a person.** `e.message` went straight to the
parked lane, so what an operator opened quoted a constraint name and a table
name at them. `opSays()` in `src/routes/sync.js` translates a NAMED constraint
by name — the same rule `checkSays()` already keeps for the handle route — and
repeats anything a trigger RAISEd exactly as written, because a person composed
that sentence.

**The section pen had to survive a reload before any of this could work.**
`state.catMeta` and `state.catOrder` are the same class of thing as
`state.local` and `state.prefs` — this terminal's un-synced answer about a
section's name, colour, glyph, station and order — and neither was written to
the session nor read back from it. So a reload lost all of them and the
re-send had nothing left but the id: measured in a browser, a section reached
the outlet named `hot-drinks-mtb373zz`, on the till rail and on the guest's
menu. Both are persisted now, and the re-send composes the HELD ROW under any
later edit rather than asking `catMeta(id)`, which answers `{ id, name: id }`
for a section the outlet has never published.

Sending one the outlet was already about to accept costs a duplicate op and can
never cost a duplicate ROW: every one of these is an upsert keyed by the row's
own id, which is the same property that makes the outbox safe to replay at all.

Measured in two real browsers: a dish held on one with nothing left in the
outbox to deliver it — the state a live browser is actually in after the
defects that shipped — reaches the other, untouched, in **1.0 s**, and the
sender's pen empties on the same bootstrap.

**What this does not recover.** A row destroyed by the id collision is gone from
the outlet, and the browser that lost the race is the one still holding it — so
that copy is what re-sends, under the id it minted. Where BOTH browsers still
hold their copy, both re-send and both land, because `newId()` no longer lets
two devices mint the same one. Where the losing browser's storage was cleared,
there is nothing left to re-send and the row has to be typed again.

## A setting is the outlet's, unless it is named as this terminal's

The owner sits at home and changes a policy — how long until a till locks,
whether a void needs a PIN, whether costs show on the grid, what the acquirer
charges, what a dollar is worth today. Every terminal in the shop has to be
reading it by the next bootstrap. None of it travelled.

The outlet's `setting` table has been there since the schema was written and
`src/apply.js` wrote to it. **`src/bootstrap.js` read it into a local called
`oset` and used it NOWHERE**, so no terminal ever read a word of it back, and
the settings screen's one write went into `state.prefs` — one browser's
localStorage — beside a `setting_change` queued with **no payload**, so the
outlet was told a setting had changed and never which one.
`String(undefined)` would have filed it under the literal key `"undefined"`.

`PREFS` is published now, and `prefs()` reads three sources in the order that
settles a disagreement between two tills: the shipped default, then the
**OUTLET's** answer, then this device's own un-synced edit. Same shape a
measured yield, a saved batch and a published loyalty programme already follow.

**`DEVICE_PREFS` is the closed list of what does NOT travel** — the sidebar
pin, the KDS station, the print transport, the printer host and name, the paper
width, the copy count, auto-print, the theme, the shell, the device label.
Pushing "keep the menu pinned" would pin the sidebar on every till in the shop
because one person likes it that way, and pushing a paper width would re-point
somebody else's printer. It **fails closed on purpose**: a key not on the list
travels, because a policy that silently stayed on one browser is the defect this
exists to end. Pinning the sidebar now queues nothing at all rather than
queueing a `setting_change` about somebody else's screen.

**The local copy is a holding pen, not a private fork.** `reconcilePrefs()`
runs on every bootstrap beside `reconcileCats()` and drops a held key the moment
the outlet publishes it — **on the key, never on the value**. If the outlet's
answer differs, somebody edited it elsewhere and theirs is the later decision;
keeping the local copy BECAUSE it differs is exactly how a pen becomes a fork.
A device preference is never dropped, because it is never published.

**Four rate screens were writing keys nothing reads.** `mdr_set` wrote
`acquirer_rates_outlet`, `channel_rates` wrote `channel_rates`, `fx_rates` wrote
`fx_rates` — while the till read `prefs().processors`, `prefs().packCost`,
`prefs().aggCommission` and `prefs().fx`, none of which had ever left the
browser they were typed in. So a merchant rate edited in the back office was an
entry in an audit trail: every other terminal went on costing, converting and
reconciling at whatever it happened to hold. They write the keys the till reads
now. `mdr_set` also **merges** one contract into the map rather than writing it
over the whole setting, which is what made editing a second processor erase the
first. And `qr_banner_slot` was aliased to `banner_upsert` — a display toggle
sent to a handler that creates a banner out of a payload carrying none.

Measured in two real browsers against one outlet: the owner changes `autoLock`
and `showCost` on one, and the other — untouched — is reading the outlet's
answer **6.0 s** later; a dish repriced on the same browser reaches the other in
**2.0 s**. Before the change the second browser's `PREFS` was `{}`, on every
install, for ever. `test/api.test.js` walks it over HTTP, `test/wiring.test.js`
pins both the wiring and the behaviour on the shipped logic class.

## A menu section is the outlet's, not one browser's

Reported from a live store, and it arrived wearing the wrong face: the till
parked **"Bajiya updated · Short Eats & Snacks · MVR 120"** after the outlet
refused it eight times. Nothing was wrong with that dish. The SECTION it sits in
had never reached the outlet, so `item.category_id` pointed at a row that does
not exist and `item_category_id_fkey` refused the save — every retry, for ever.

Three screens created or edited a section and **every one of them queued its op
with no payload**: `queue(kind, label, entity)` against a signature of
`(kind, label, entity, payload)`. Two of the three named `menu_section`, which
is the grouping ABOVE a category and a different table from the `menu_category`
the bootstrap publishes. So the server refused each for want of a name, the
toast said "Section created", and the section existed in one browser. The
fourth, `menu_section_reorder`, walked an empty array and **answered success** —
a control that says it did something and did not.

Measured against a real database before any of it was written: the four ops the
shipped build sends, in the order it sends them, then the dish. Four refusals
and one false success, ending in the FK.

- **One seam.** `catWrite()` is the only place a section is written, and it
  carries the row. The kind is `menu_category_insert`, which upserts — creating
  and renaming are the same write against the same key.
- **The section carries what its editor collects** (migration 040). `name` was
  the only one of five that had a column; `icon`, `station` and `hidden` lived
  in `state.catMeta`, one browser's localStorage, and `colour` had a column that
  the bootstrap read as the GLYPH (`icon: r.colour || 'main'`) while the colour
  picker wrote nothing at all. So two tills drew one section in two colours
  under two glyphs, a section hidden on the manager's tablet was still on the
  rail at the counter, and a dish created on either inherited a different
  default station — which decides where the KOT prints.
- **Silence is preserved**, the same rule `item.off_menu` follows: a rename that
  says nothing about the colour, the glyph, the station or the position must not
  reset all four. `hidden: false` is a decision and is obeyed; `null` is silence.
- **A new section lands at the END of the rail.** `pos` is `NOT NULL`, and
  defaulting it to 0 would put every section a store adds in front of the ones it
  has already ordered.
- **The local copy is a holding pen, not a private fork.** `reconcileCats()`
  drops `catMeta[id]` the moment the outlet publishes that section — on the ID,
  not the value, so a colour changed elsewhere is the later answer. Same rule a
  measured yield and a saved batch already follow.
- **And a section the outlet never received is re-sent.** Every section write
  this build ever made was refused, so a store's sections are sitting in
  `state.local.menucats` with the outlet holding no row for them. A held section
  the outlet does not have has not been delivered, whatever the toast said, so it
  is queued again — once per session per section, because the outbox owns
  retrying and queueing on every five-second poll is how a hot outbox is made.
  This is what unsticks an install that already has parked dishes.
- **An empty op is refused BY NAME**, not with `null value in column "name"`. A
  parked op is read by a person. The `menu_section_*` handlers keep their
  refusals and their call sites are gone, for a device still holding one in its
  outbox — exactly like `ticket_status`.

`test/api.test.js` walks the whole road over HTTP: the empty ops refused in
English, the section landing whole, **the dish that was parked landing**, a
rename preserving what it did not mention, hiding reaching the row, and the
reorder actually reordering. `test/wiring.test.js` pins the payload and that no
client path writes `menu_section` again.

## Two ways a dish comes off sale, and neither survived a bootstrap

**Hiding a dish and 86-ing one are different decisions.** Hiding is a standing
menu decision that reaches the guest's phone too — the toggle says so: "till, QR
menu and printed list alike". An 86 is tonight's stock, and the dish stays on
the till's grid wearing its tag, which is what a cashier needs when a guest asks
for it.

The terminal has always spoken of `hidden` and `off`. The bootstrap published
neither — it published `offMenu` and `soldOutReason` — so both controls wrote a
local flag, queued an op, and were **wiped by the next bootstrap**: the dish
came back on the menu, the 86 came back on sale, and nothing on any screen said
why. `menuVisible()` filtered on `hidden`, a field no server-backed row ever
carried, so the filter was dead on real data.

The op made it worse. `COLLECTION_OP.menu` derived **both** `offMenu` and
`active` from `off`, and never sent `hidden` at all — so 86-ing a dish took it
off the menu AND deactivated it, while the "Hidden from every channel" toggle
sent nothing. On the server, `off_menu = excluded.off_menu` with an insert-time
`coalesce(…, false)` meant any save that did not mention it put a hidden dish
back on the menu.

Fixed as one round trip: the bootstrap publishes `hidden` and `off` in the words
the terminal reads; the op sends the decision it actually made; `off_menu` is
**preserved when the caller is silent** (`coalesce($15, item.off_menu)`) because
saying nothing is not the same as saying "show it again", while
`sold_out_reason` is the opposite by nature — null IS back on sale. `active` is
passed through rather than derived: a dish is deactivated by being deleted, not
by being out of prawns.

The guest snapshot filtered on `active` alone, which let a hidden dish onto a
phone — and, once batches existed, a litre of fish stock with it. It is
`active AND NOT off_menu AND NOT is_batch` now.

## The books of a store that has never traded

The three demo batches were found by opening a screen. Finding them was the
argument for sweeping the whole terminal the same way: every generator and
every tab rendered on an EMPTY dataset, with the server's own answer for an
untraded outlet folded in (`bank: []`, `bankOpen: null`, `periods: []`), so
what is measured is what a real customer sees after their first sync rather
than what an un-bootstrapped page shows.

Four screens were furnished, and the accounting module carried the largest
stand-in in the build.

**A trial balance that could not fail.** `OPENING()` seeded nine accounts with
literals — MVR 42,000 in the drawer, 186,400 of stock, 640,000 of equipment,
214,600 owed to suppliers — and derived retained earnings from them so the
total balanced. A store opened this morning read **dr 1,305,700 = cr
1,305,700** of money that does not exist, and the one report whose job is to
prove the books balance balanced BY CONSTRUCTION, which the comment above
`trialBalance()` says outright is worse than not having it. The comment above
`OPENING()` said the quiet part: the figures were there so the month "reads as
a real business rather than only the sales rung on this device". That is demo
mode shipped to a customer. A business genuinely migrating in does have
opening balances — and they are ENTERED; the bank one already has its form.

**A reconciliation screen that manufactured the thing it exists to find.**
`bankOpening()` returned 412,500 unset, and `BANKSEED()` supplied seven
statement lines with real-sounding counterparties — "BML MERCHANT SETTLEMENT
4471", "TRF REEF SUPPLIERS PVT LTD", a standing order for rent. So a brand-new
store opened on a statement balance of MVR 557,024, a ledger balance of
458,800, and **MVR 98,224 unexplained**, three of the lines flagged for a
manager to answer for. Both are nought now, and the seed is gone.

Two more defects were sitting under that seed, invisible while it stood. The
outlet publishes an opening balance as a ROW — `{acct, asOf, amt}` — and this
file read the row itself as a number, so a store that HAD set one got `NaN`.
And an imported line is published as `descr` while every reader here said
`desc`, so a line that round-tripped through the outlet came back with a blank
description, the auto-matcher stopped recognising a bank charge by its
wording, and the audit line read "undefined booked to 5600".

**Three months filed that nobody had closed.** `ACCPERIODS()` was four literal
month names ending in "August 2026" and `closedPeriods()` declared three of
them closed, so a store opened last week had three filed accounting periods,
and from September the live month would still have been August. The ladder is
derived from the outlet's own business date now (`today()`), and a month is
filed only where the outlet published a period row saying so. The reports tab
strip was the same four literals and follows the same two facts.

**Three printers nobody owned.** `PRINTERS()` named "Epson TM-m30 · USB", a
model number the store does not have, on the screen a manager opens to find
out why nothing is printing — while Settings said "Receipt printer | not
bound" one tab away. The role is real; the name is now the truth.

**A reward catalogue that reached the guest's phone.** `LOY()` shipped four
rewards — a complimentary dessert "taken 128" times, a reef platter taken 19 —
and three of them were `active`, so `publishGuest()` put them on the phone of
every member at every store. A guest holding 400 points was told they could
claim a free dessert their restaurant had never heard of. The redemption
counts were literals: nothing has ever incremented `taken`, so the column read
those four figures and zero for every reward a real store added. A figure
nobody measures is not a column, and it is gone with them.

**And a second tier ladder, which is the defect migration 019 exists to have
ended.** `LOY().tiers` ranked at 0/2000/6000/15000 while `tierFor()` — the
customers table, the guest sheet, the pay screen and the published roster —
ranked on `K().TIERS`. The server's own fallback was a THIRD at 0/3000/7000/
15000, and `app/kashikeyo-data.js` a fourth at 0/500/1500/3000. So the loyalty
screen counted a member at 600 points into Bronze while every other surface
called them Silver. One ladder now — 0/500/1500/3000, `spend` riding with each
rung because the member card quotes it — and `src/bootstrap.js` `DEFAULT_TIERS`
is that same ladder rather than an opinion of its own.

**"Points expire · 12 months" was a term the app does not keep.** No column,
no job, no handler; nothing in this build takes a point back. It was on the
programme card and collected on a form. The card says points do not expire.

### The programme is the outlet's, and now it can be

Taking the demo programme out exposed what it had been covering: the bootstrap
has ALWAYS published `TIERS` and `REWARDS` from `chain.setting`, and **nothing
has ever written either**, so every store on every install read the shipped
ladder and an empty catalogue for ever. The till filled the gap with a
programme of its own and its editors wrote `state.loyalty` — one browser's
localStorage — while queueing `loyalty_update`, whose handler moves a MEMBER's
points and has no idea what a tier is. "Reward added" was a toast over a write
that reached the outlet never.

Worse, the rates: `applySale()` reads `chain.setting` key `loyalty`
(`pointsPer`, `redeemPts`, `redeemValue`) and the bootstrap did not publish it,
so the till quoted the guest a redemption rate off its own defaults and the
outlet awarded at another the moment either moved. They agreed only by the
coincidence of sharing a default.

`H.loyalty_programme` is the write — rates, ladder and catalogue, each
optional, into `chain.setting`, which is where they belong because the ladder
and the points are chain-wide for the same reason `chain.member` holds the
balance. Its RLS policy requires **rank 4**, so the till asks the same rung
rather than letting a manager's op park after the toast said it was saved. A
rate at or below zero is refused **by name**: a point worth nothing prices the
whole catalogue at nothing.

`LOYALTY` is published beside `TIERS` and `REWARDS`, and `null` is a real
answer — nobody has set one — which is why the programme card says "Rate | not
set — the shipped default" rather than printing a figure it invented.

`LOY()` reads three sources in order, the same shape a measured yield and a
saved batch already follow: this terminal's un-synced edit, then the OUTLET's
published programme, then the shipped rates underneath. `state.loyalty` is a
**holding pen, not a private fork** — `applyLive()` drops each part of it the
moment the outlet publishes that part, so two tills cannot quote one guest two
different redemption rates.

`test/audit.test.js` pins all of it, and every one of the four new tests fails
against the version that shipped.

## A batch the kitchen makes is an item

`recipe_line`'s component has been either an `ingredient_id` or a
`sub_item_id REFERENCES item(id)` since migration 003. Nothing ever wrote the
second kind, so it was a foreign key with **no possible referent**: a dish
drawing on a batch could not be stored at all — the insert failed on the key,
confirmed against a live outlet.

The terminal carried a parallel model instead: three batches hard-coded into
`app/index.html` with ingredient ids from an old seed, plus whatever an operator
had edited into THAT BROWSER's `state.local`. `subrecipe_add` and
`subrecipe_update` had **no handler and no payload**, so a kitchen costing "the
backbone of six dishes" costed it for itself, on one device, while the screen
reported a price per kilo as though it were saved.

A batch is now written as the item the schema always said it was: off-menu,
`yield_qty` holding what the batch OUTPUTS net of reduction, `loss_pct` holding
why that is less than what went in (4 litres yielding 3.28 tells you what a
millilitre costs; 18% tells you why it costs more than the inputs over four),
and `is_batch` saying so out loud. **Said rather than inferred** — a batch and a
dish taken off the menu are both `off_menu`, and telling them apart by price,
category or yield is a guess that breaks the first time somebody prices a batch.

The bootstrap keeps batches out of `MENU` — the till's grid, the guest's menu
and the KDS all build from it, and nobody orders a litre of fish stock — and
publishes them as `SUBS`. `SUBS()` in the terminal layers the outlet's batches
under this browser's un-synced edits, the same three-source shape as yields.
The three shipped batches survive only as demo content for a store that has
saved none of its own.

Saving one re-publishes the declaration of **every dish that draws on it**: the
allergen walk already recursed through `sub_item_id`, it had never had a batch
to recurse into.

**And the server applied the reduction loss twice.** `yield_qty` already IS
the output net of loss (`subrecipe_update` stores `batch × (1 − loss)`), and
`deriveConsumption()` divided by `yield_qty × (1 − loss_pct)` — so the server
over-deducted every batch-drawing dish by 1/(1−loss) against the till, which
divides by the output once. Invisible while the drift test compared dishes
with plain recipes; the moment a batch-drawing dish deterministically became
the compared one, the vm test caught it — which is exactly the drift that
test exists to catch. The server divides by `yield_qty` alone now, and the
two runtimes agree to six places again.

## Six kinds were invisible to the sync contract

`test/wiring.test.js` exists so that a queued op kind cannot go unhandled
without somebody noticing. Its extractor was
`/this\.queue\(\s*"([a-z_]+)"/` — a literal at the opening bracket — so a kind
chosen by a **ternary** matched nothing and was excused entirely. Six were
hiding there: both sub-recipe writes, both guest signals and both discount
events. The check was quietly skipping exactly the calls most likely to be
forgotten.

It now takes the first ARGUMENT of every call — text to the comma at bracket
depth zero — and collects every string literal shaped like a kind. Comparison
operands are stripped first, or `x.kind === "member" ? …` contributes "member"
as an op nobody ever queued. Concatenated suffixes (`"_insert"`, `"_update"`)
start with an underscore and stay excluded: that is the generic back-office
fallback, a different contract. 124 kinds are visible now, up from 118.

Of the six, four were genuinely audit-only and are now **named** in
`AUDIT_ONLY`: a discount's consequence rides on the sale, and a guest signal
records that this terminal announced something to the floor. The two
sub-recipe writes were a real gap.

## No invented figures

Every ribbon card is a number a manager acts on. `test/audit.test.js` walks
every ribbon at every rank on an empty install and fails on anything that is not
zero, an empty state, a statutory rate (MRPS 7% + 7%, the 99% service pool), an
account code, or a target the outlet configured.

The same rule applies to anything else on screen. If you cannot measure it, say
what is true — "Nothing counted on this outlet yet" — and never a plausible
number.

**And DEMO CONTENT is not an exception to that rule; it is the most persuasive
way to break it.** Reported by a real customer on the day they opened their
store: Recipes & Costing → Yields and trim loss came up with EIGHT rows of data
on an install where nobody had entered anything —

```
Item #1 · 100% · 2% · 98% · MVR 0.00 / kg · MVR 0.00 / kg · +-100% · default
```

— a name that is a placeholder for a missing row, the shipped "nobody has
assessed this" fallback rendered as the ingredient's own yield, a cost of zero,
and an uplift of minus a hundred per cent from dividing by it. They came from
the three demo batches `SUBS()` showed any store that had saved none of its
own: the yields tab lists every ingredient a recipe or batch draws on, and
those lines carry ingredient ids from an old seed belonging to no real outlet.
`SUBS()` is the outlet's batches and this browser's un-synced edits now, and
nothing else; the yields table skips any ingredient the item master does not
have, because a recipe can still name one that was deleted. The empty state was
already written and correct — it just could not be reached.

`test/audit.test.js` asked this of the ribbon CARDS from the day it was
written and never of the screens behind them. It asks both now.

## Every store has an address

A store's public face is a subdomain, not a path:

```
https://<handle>.kashikeyopos.com          the QR ordering portal
https://<handle>.kashikeyopos.com/member   the customer's card
```

The handle IS `chain.outlet.slug` — one identifier, promoted from an internal
convenience to a DNS label a business prints on table cards. Migration 012 makes
it `NOT NULL`, constrains its shape (`chain.handle_shape_ok`: 3–40 characters,
`a-z0-9-`, no leading, trailing or doubled hyphen) and refuses a **reserved**
name through a trigger reading `chain.reserved_handle`. `www`, `mail`, `api`,
`webmail` and `demo` are infrastructure — the last two are probed by scanners on
the live domain daily, and before 012 a store could have claimed either.

**A wildcard means no name is obviously free**, which is the trap migration 034
closes. Stores are served by `*.kashikeyopos.com`, so every name under the base
domain already answers whether anybody meant it to or not — and the mail
transport wants some of them. SPF is published at `send`; click tracking wants
a CNAME at whatever the tracking subdomain is set to. Neither was reserved, so
a store could have taken `send` or `track`, laminated it onto forty table
cards, and had its portal broken the day somebody added the record the provider
asked for. A dead QR is bad; a QR that dies because of a change nobody
connected to it is worse, because nobody will look there. 034 reserves the
names an email provider reaches for, and a store already holding one keeps
trading — evicting a business that has printed its handle is not a migration's
call — but is named on the trail so somebody can have the conversation.

**Nothing spells a hostname.** `src/handle.js` is the only place that knows the
base domain (`PORTAL_BASE_DOMAIN`, falling back to the host of `PUBLIC_URL`),
and it is published to the terminal in the bootstrap as `PORTAL.base`. A domain
typed into a page is right in production and wrong in staging, and a QR card is
laminated onto forty tables before anyone scans one. `test/handle.test.js` fails
on a literal store hostname anywhere in `app/`.

**The page never guesses its store out of `location.hostname`.** Only the server
knows where the base domain ends — a page splitting on the first label reads
`kashikeyopos-staging` off a Railway URL. On a host-routed page the bridge calls
`GET /api/g/token` with no slug and the server resolves it from `Host`, answering
with the handle it settled on; every call after that is by handle again.

`server.js` resolves `req.storeHandle` once, before anything routes on it.
`express.static` is `index: false` so `/` is decided by host, not by a file, and
the 404 falls back to whichever app owns the hostname.

**The till's own home is the host of `PUBLIC_URL`** — `app.kashikeyopos.com` in
production, because the APEX belongs to the product's website. `appHost()` in
`src/handle.js` is the one place that knows it: `hostHandle()` refuses to read
it as a store called "app" (also reserved, migration 012/027), and the till's
own paths (`/pos`, `/kds`, `/admin`, `/onboarding`, `/account`) 308 from a
store's subdomain back to it — one sign-in, one set of cookies, not one per
store. The bare base domain and `www.` still resolve to the till when they
reach it, so a deploy mid-domain-move keeps working. The website, owning the
apex, forwards those same paths (plus the printed `/g/`, `/m/`, `/join/`
forms) 308 to `APP_URL`, and 301s `www.` onto the bare domain; `/signup` stays
on the site, where signing up means asking for a store.

A handle the business **chose** is honoured or refused **by name** — never
quietly swapped for a free one, because they are about to print it. A handle
merely **derived** from the outlet name is a suggestion, so it steps aside.
`chain.handle_why()` gives the reason, and the onboarding panel asks the same
function while somebody is typing, so a green tick cannot be followed by a
refusal on save.

The path forms `/g/<slug>` and `/m/<slug>` still answer everywhere, for as long
as the cards printed before a store took its handle stay stuck to the tables.

### A store may move, and its old address must not

Renaming is rank 5 — `PATCH /api/outlet/:id/handle` — because it changes what is
printed on every table card. `chain.rename_outlet()` does it in one transaction:
validate, retire the old handle into `chain.outlet_handle_history`, set the new
one. Half of that is worse than neither.

A retired handle then does two things for ever:

- it **redirects**, 301, keeping the path and the query — so
  `old.kashikeyopos.com/?t=7` lands on `new.kashikeyopos.com/?t=7` with the
  right thing in the guest's address bar. `src/directory.js` holds the map in
  memory (30s TTL, refreshed wholesale, a failed refresh keeps serving the last
  answer) because this is on the hot path of every guest request. The cache only
  ever decides whether to REDIRECT — every endpoint that resolves a store asks
  the database — so a stale entry costs one hop and never the wrong menu;
- it **cannot be claimed by anybody else**. `chain.handle_why()` refuses it to
  every outlet except the one that gave it up, which may take its own name back.
  A dead QR is bad; a QR pointing at a competitor's menu is worse.

Nothing expires. A card outlives the decision that renamed it, and a retired
handle costs a row.

The path form self-heals instead of redirecting: `/api/g/<old>/token` resolves
through `chain.handle_points_at()`, mints against the right outlet and answers
with the **current** handle, which the page then adopts — so one hop through a
retired address is the last one that device makes.

### The rank the server issued wins

`rank()` prefers `state.session.rank` — the rank the server put in the session —
and falls back to `RANKMAP()` only for a terminal that has not signed in against
a server yet. `RANKMAP()` used to be its own opinion, disagreeing with
`src/auth.js` on four of eight keys; it is the server's ladder now, key for key,
because it is not only read but WRITTEN: granting a role sends this number as
`chain.staff.rank`. See the copy sweep below for what that cost while it was
wrong.

## Both phone apps are one product, in three shells

`metrics()` is the same function in `app/guest.html` and `app/member.html`, and
everything else is inside it:

```js
const touch = matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
const framed = shell === "frame" || (shell === "auto" && vw >= 900 && !touch);
const scr    = framed ? (vw >= 1180 ? 430 : 392) : Math.min(vw, 720);
const h      = framed ? Math.min(846, Math.max(660, vh - 96)) : vh;
```

**Width alone cannot decide this.** It cannot tell an iPad in landscape from a
1024px laptop window and called both a desktop — so a guest holding a tablet got
a painted phone floating in a dark room. A **coarse pointer** settles it: whatever
the width, this is a device being held, and a device being held has its own
chrome.

The guest app had no `metrics()` at all: it was permanently framed at 392×812, so
a guest scanning the card in front of them got a picture of a phone inside their
phone — a drawn notch under the real one, a painted clock under the device's own,
and the actual app in what was left.

**Painted chrome is hidden, never shrunk**, and `display:none` rather than
`visibility:hidden` — a hidden element still has a box, so a measurement still
finds a battery under the real one. The notch inset it stood in moves onto the
screen as `padding-top: env(safe-area-inset-top)`, because that box is real even
when nothing is drawn in it.

`100dvh`, never `100vh`: the static viewport height puts the bottom nav behind
mobile Safari's address bar — the one control a guest needs, under the browser's.

**The backdrop is written to `documentElement` and `body` on mount and every
update.** `body` is the one element a template cannot reach and overscroll is the
one place its colour still shows; without it, iOS rubber-band reveals a near-black
band around a white app at both edges.

Framed gets the explainer column beside it — a phone alone in an empty room is a
screenshot — and its live line reads off what the till actually published, so
"live" is a fact rather than decoration. Bare gets neither: a column below the app
is a page nobody scrolls to.

`test/responsive.test.js` measures all three on both apps, and asserts no tap
target under 44px on its short axis.

## The member portal reads as the same product

It was Inter with `tabular-nums`, an 800 weight scale, a linear wash to brick, and
an accent CTA — beside a guest app in Instrument Sans on a cornered radial. Two
typefaces is the fastest way for one product to read as two.

- **Instrument Sans**, with **JetBrains Mono for every figure** — balances,
  points, prices, membership codes. A balance, a receipt and the till now share
  one face. Tracking on mono is `.02em`; tracking tuned for a proportional face
  reads as gaps, worst on the membership code, the one string a cashier reads
  aloud.
- **Weight 700**, not 800. 800 belongs on a poster.
- **The primary CTA is near-black** (`#141416`, radius 999, layered shadow). An
  accent CTA competed with every price on screen for the same red, so nothing read
  as primary.
- **The action bar is one shape at two temperatures**: accent while a round is in
  the guest's hands — something to send, something on its way — and near-black
  once the only thing left is to look at it.
- **Sheets rise from the bottom edge.** One that fades reads as a dialog; one that
  rises reads as a drawer.
- The **tier card** is kept: gradient, mark and membership code are a genuine
  membership device, restyled rather than replaced.

**Signing in cannot wait on the menu.** The sign-in panel was rendered after
`if (!this.K()) return V`, so on an outlet whose menu had not reached the browser
it came back with none of its values — an unstyled "Back" and a primary button
with no label and no size. Which is exactly the state a member is in the first
time they open their card, and a card is points, receipts and a tier, none of
which are a menu.

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

### How a customer gets in

A member is born at the counter. A waiter takes a name and a number in Guests &
Credit, `member_upsert` writes `chain.member`, and the customer signs in at
their store's own address. **The phone is the identity** — `NOT NULL UNIQUE`,
with the email nullable — so both the server (`phone = $1 OR lower(email) =
lower($1)`) and the card accept either half.

**Invite to the portal** is on the customer, not the list, and it is two things
a person hands across a counter: the address, and a code. `POST /api/outlet/:id/
member/:memberId/invite` mints one at rank 2, exactly like the one the guest
requests for themselves — four digits, salted hash, ten minutes, five tries,
spent on use. Not an outbox op: a code replayed three hours later is a code
nobody can use.

### An invitation is an event, not a boolean

It was a flag flipped in bulk: no channel, no time, no sender, no resend, no
revoke — and on a row where the field was simply ABSENT it claimed the customer
already had access. What support has to answer is "was this person invited, how,
by whom, when, and is that invitation still good", so migration 017 puts all six
on the row: `invited_via` · `invited_to` · `invited_by` · `invited_at` ·
`invite_count` · `revoked_at`/`revoked_by`.

Three channels — **email, Viber, WhatsApp** — and every one rides something the
customer has already given: email is on the membership, Viber and WhatsApp both
ride the mobile number. Nothing asks a guest for anything new, which is why the
invitation belongs on their row rather than behind a form.

- **A channel with no address on file is refused BY NAME** — "Hassan Moosa has no
  email address on file" — never silently swapped for one they did not choose.
  `chain.member_invite()` resolves the address and refuses, so both the handler
  and the till say the same sentence; the control stays on screen, because one
  that vanishes teaches an operator the app is broken.
- **Sending again reissues the code**, so the previous one stops working: an
  invitation forwarded to the wrong person cannot be used.
- **Revoking keeps the history.** The row reads "Revoked", never "Not invited" —
  a member who was let go and one who was never asked are different answers.
  `chain.member_revoke()` spends any live code in the same statement, and
  `chain.member_code_set()` refuses a revoked member, so the gate holds for the
  code the guest asks for themselves as well as the one the counter issues.
  Inviting again **restores** access, because a code that cannot work is not an
  invitation. Rank 3: withdrawing access is not a cashier's to make.

**Email is a real transport when one is configured** (`src/email.js`); WhatsApp
is a click-to-chat handoff (`wa.me/<number>?text=`) opened from the staff
member's own app, because that is the only WhatsApp send this build can honestly
make; Viber is recorded and not wired. Either way the answer carries `sent` and
the reason — a screen that reports a send it did not make is worse than one
offering no send at all.

### The invitation carries a link, and the link lands somewhere

The invitation used to BE the four-digit code, minted at the counter and read
out. That works across a counter and nowhere else: a code in an inbox is a
credential in an inbox. So it splits in two, which is also what makes it safe to
send (migration 020):

- **the TOKEN says WHO.** `MV-<22 chars of CSPRNG>-<minted at>`, single use,
  seven days, in the link. What is stored is its **hash**, never itself — the
  same discipline as a staff PIN. Tapping it proves possession of the message
  and nothing more;
- **the CODE says IT IS THEM.** Four digits, ten minutes, five tries, and it goes
  to the address **on the membership** — never one typed on the landing screen,
  so a link forwarded to somebody else cannot sign them in.

Neither half is enough alone, which is the point. Issuing a token invalidates the
last one, so a resend is an invalidation rather than a second live key, and
`chain.member_revoke()` kills the link with the code.

**All three channels carry the same link.** The channel decides only the
transport and which field it addresses.

**The message is composed by the system, not typed at the till.** A loyalty link
arriving cold reads as phishing, and a guest who suspects phishing does not tap
it — so the copy proves provenance with four things a bulk sender would not have:
the guest's own name, the **outlet's** name (not the chain's), their real points
balance, and the sender's display name. The balance does most of that work and is
**dropped at zero**, where it argues against the invitation rather than for it.
`{senderName}` is a person to ask for at the counter: "Sent by nashwa" is a
system talking about itself.

`app/kashikeyo-invite.js` is that copy, loaded by the browser as a script and by
the server as a module — **the same file both ways**, like `kashikeyo-rules.js`.
It matters more here than anywhere: the till shows the guest the message before
sending, and the server is what sends it. Two copies means a till that
proofreads one sentence and a guest who receives another. The invite form's foot
IS the message, verbatim, re-composed as the channel changes, with the address
and (for the app channels) the character count.

**The wording is audited separately from the send** (`member_invite_body` beside
`member_invite`). What a guest was told is a different fact from the fact that
they were told, and a support call three weeks later needs the wording, not the
timestamp. The token is replaced with `<link>` in that row: an audit trail is
read by more people than an inbox is. Reading it back is an owner-connection job
— an outlet's login role has INSERT on `chain.audit` and nothing else.

### An invitation is a link, so no address means no invitation

`joinUrl()` returns an absolute link or an **empty string** — never a path. Two
absolute forms: the store's own subdomain when the base domain is known, and
`PUBLIC_URL` with the slug on `?s=` when subdomains are deliberately off. And
**not** the request's `Host`: that header is client-supplied, so deriving the
link from it would let anyone who can reach the API put their own domain into an
invitation a guest has been told to trust.

Everything else in `src/handle.js` may fall back to a path form, because a path
is followable from a page the guest is already on. An invitation is not — it
travels to an inbox, where `/join/MV-...` resolves against nothing.

So `POST /member/:id/invite` **refuses with 503** when no link can be spelled,
and it refuses **before minting**: `chain.member_invite()` replaces the live
token, so a refusal after it would kill a working invitation in order to report a
broken one. The bootstrap publishes `PORTAL.origin` — where a link for THIS
outlet would actually point — so the till's preview says what the send will say.
A message that reads fine and then will not go is worse than one that says up
front it cannot.

Production sets `PUBLIC_URL` (or `PORTAL_BASE_DOMAIN`); with neither, the whole
invitation feature is off and says so by name.

### Reading the token, and why the parameter is never `t`

`/join/<token>` is canonical. `?invite=` / `?join=` are fallbacks, and where
there is no base domain the slug rides `?s=`.

**Read the path first, hold every branch to the shape, and never call the
parameter `t`.** The prototype read `?t=` first and shape-checked only the path,
so any `?t=` already in the address won, unvalidated — and `?t=` is the table on
the QR portal, the hosting environment's own session token, and the tracking
parameter most email click-wrappers append. The canonical path was unreachable
and a foreign credential went into a membership lookup. Every branch — prop,
path, query, hash — goes through one `cleanToken()` against
`/^MV-[A-Za-z0-9]+-\d+$/`, and nothing failing it reaches the server.

The phone **posts** the token and the server answers with that one membership.
The roster must never carry these: a roster that did would hand every device the
keys to every account.

Three states on the landing:

| State | Screen |
| --- | --- |
| Fresh | "Welcome back, {first}" and a card — name, tier, visits, balance, who invited them. One button: **Send my code**. Nothing to type, so it is never disabled |
| Expiring (≤2 days) | The same, plus an accent strip naming the deadline; "tomorrow" at one day |
| Lapsed (≥7 days) | **Not its own dead end.** Falls through to the ordinary sign-in with the explanation on top and the address **pre-filled** from the token — making somebody retype an address the app is holding is a small insult at the moment they have already been let down once |

That pre-fill is a **state write, so it happens in `componentDidUpdate`**, never
on the render path. "Not you?" steps around the invitation without clearing it:
the token stays in the address, so a guest who taps it by mistake gets the card
back by reloading, and a forwarded link leaves the second person a way in.

**The landing is told what points are worth**, from the outlet's own published
rate — the same figure the message quoted. Deriving it on the page quoted a guest
holding 1,842 points a worth of MVR 0.00, because a browser arriving cold on a
link has never been sent a programme.

### The address the Email channel needs

`member_upsert` has taken an email since it was written and **no screen ever
collected one**, so every row's was null, the Email channel could never be used
by anybody, and its refusal — "add one on the customer first" — pointed at a
field that did not exist. The `cust` form has it now, optional, because the
phone is the identity and a customer taken at a counter has given a name and a
number. A refusal for want of an address **opens that form on their record**: an
instruction to add one is only useful next to somewhere to add it.

**An email is a second identity, so it is unique** (migration 018). Both
`chain.member_code_set()` and `chain.member_code_take()` resolve a member with
`phone = $1 OR lower(email) = lower($1)` and take one row silently, so two
customers on one address is one guest signed into another's card, points and
credit balance. Stored lower-cased, because that is how it is read back. Rows
written before the index are repaired rather than dropped: the address stays with
whoever has held it longest and the loser's copy moves into their notes.

**`member_upsert` keys on the outlet's id when the till has one.** Keyed on the
phone alone — `ON CONFLICT (phone)` — correcting a mistyped number did not rename
the customer, it **created a second one** and left the visits, points and credit
facility on whichever of the two the next sale reached. The screen said
"updated". A number already belonging to somebody else is refused by name. Ids a
till invented for a customer created offline are not uuids and still fall through
to the insert, which is what creates them.

**The tier dropdown is gone**, and so is the column behind it (migration 019).
Tier is derived from points against the published ladder every time it is asked
for, so a manager who set Gold wrote a column no screen reads and watched the
panel keep saying Bronze. A control that cannot do what it appears to do is worse
than no control.

The whole of that was missing, and each piece failed silently:

- **nothing ever inserted a `chain.member` row.** The till's Add customer queued
  a kind with no handler and no payload, so `applyOp` recorded it as
  `unmodelled` and answered success — the toast said the customer was created
  and the row lived in one browser;
- **"Invite to portal" toasted "N invites sent by SMS"** while flipping a local
  flag and sending nothing. `test/wiring.test.js` now fails on any screen that
  claims a send this build cannot make;
- **the card demanded an email** to enable its button, so the normal customer —
  taken at the counter, no address on file — could never sign in and was never
  told why;
- **`memberUrl()` returned `/g/<handle>/member`**, which matches no route: a
  guest handed that address fell through the 404 onto the TERMINAL's sign-in
  screen. The card's path form is `/m/<handle>`;
- **the card printed "Member since 2023"** as a literal, for every member, on
  an install opened last week.

Points are awarded by the outlet from its own earn rate (`chain.setting`
`loyalty.pointsPer`), never from a number the terminal sent.

## The portals, driven as the people who use them

Asked directly — *do the customer and guest portals work end to end?* — so both
were driven in Chromium as a guest and as a member, against a real store with
a real menu, and three things fell out. The journeys themselves held: scan →
menu → round → `guest_order` on the outlet → on the till's five-second poll →
accepted; and phone → code → card → points, tier, house account, receipts.

**A member could not sign in with their own number.** The row held the
counter's spelling — `+960 7793216` — and the guest typed `7793216`, which is
how anyone types their own number. The resolver compared exact bytes, matched
nobody, and answered the enumeration-safe "a code is on its way" while minting
nothing: locked out by a space and a country code, with an answer that cannot
even say why. Migration 046 (`chain.msisdn()`, `chain.member_resolve()`) makes
both sign-in resolvers read the digits by the same rule `msisdn()` already
keeps in JS — and AMBIGUITY RESOLVES NOBODY: two members whose numbers
normalise to the same digits is the phone-side twin of the email defect 018
closed, and take-one-silently is one guest signed into another's card. Exact
spellings still name their own rows precisely.

**The card quoted a worth the till would not honour.** `programme()` preferred
the roster the till publishes and, where no roster had ever been published,
fell back to a hard-coded 100-points-for-MVR-25 — while the projection the
card had ALREADY LOADED carried the outlet's real loyalty setting as
`K().LOYALTY`. Measured: a store publishing 200-for-40 showed 36 points as
WORTH **MVR 9.00** against the **7.20** the till honours — a promise a quarter
too generous, on the one figure a guest walks to the counter holding. The
fallback reads the published setting now; the literals are the last resort of
a store that has never published anything, the same three-source order the
till's `LOY()` keeps.

**And a store's own ladder painted the card white on white.** A published
ladder carries THRESHOLDS; its rows have no colours, and the membership card's
gradient was composed from `tier.from`/`tier.to` that did not exist —
`linear-gradient(140deg,undefined…)`, which paints nothing, under white text.
The whole membership device rendered as a blank white rectangle. The doctrine
was already written — "the shipped tier rows survive only as presentation: the
mark and the card gradient" — and now it is wired: the bridge stashes the
shipped rows as `TIERS_SHIPPED` before the published ladder replaces them, and
`tierSkin()` gives a rung with no presentation the shipped skin for its key.
A rung that names its own colours keeps them; only one the ship has never
heard of falls to the plain member bronze.

One cosmetic finding stated rather than fixed: the two portal pages keep their
template as real DOM, so the browser validates `d="{{ a.icon }}"` before the
runtime compiles it and logs three SVG-path errors per load. The icons render
correctly the moment data binds; the noise is parse-time only.

### A member's round reaches the kitchen, and the kitchen's answer reaches the card

Asked as *"customer portal order processing does not reach floor"*, and it did
not — for three separate reasons, none visible from the phone:

- **`table: undefined` clobbered the bound table.** The card collects a table
  number, and the bridge composed the POST with
  `Object.assign({ table: state.table }, { table: seat ? … : undefined })` —
  so every round went out TABLE-LESS, the outlet refused it 400, and the toast
  still said "Order sent to the kitchen". A caller's table wins only where the
  caller names one now, and **sitting down IS minting**: picking a table chip
  re-mints the bridge's table token for that table (`bindTable()`), which is
  also what lets the card read its own round back — the menu projection
  filters the room to the token's table.
- **The membership never rode at all.** `guest_order.member_id` existed from
  the first migration and nothing wrote it. It comes **from the member token,
  never from a body field** — `x-member-token` on the order POST, verified for
  this outlet — because a client-claimed member id on an anonymous door would
  let anybody earn points on anybody's card. A forged token attributes nobody
  and the order still lands, anonymous.
- **Accepting the round now attaches the member to the TICKET.** `H.qr_order`
  reads the guest_order's member and stamps `ticket.member_id` (by the till's
  ticket id where the op carries one, else by the table — compared on the
  DIGITS, because the phone says "5" where the floor's label is "T05", the
  same normalisation `tableSlot()` does on the till). That is what the card's
  live tracker reads: `/member/me` finds the open ticket by member, so the
  round shows Received → In the kitchen → Ready → Served off the outlet's own
  record.
- **The table chips are the floor's own labels** where the outlet has
  published a floor; the numbered twelve survive only where it has not.

Measured in two real browsers — the card on a phone viewport, the till on a
desktop one: signed in with bare digits, bound table 5, ordered one dish; the
round landed 201 with the membership on it, the till ingested it onto ticket
T05 with the member attached, the pass fired and bumped it, and the card read
Served — every step off the database, none off a toast.

### The sign-in code goes to the inbox on the membership

The code was minted and put on the FLOOR BOARD for a server to read out —
which works across a counter and nowhere else: a member signing in from home
was asking a terminal nobody was standing at. Where the membership carries an
email and the install has a transport, the code is **sent** (same
`src/email.js` seam as every other send); the floor board stays as the
fallback for a member with no address and for the night the transport is
down. A DELIVERED code is deliberately not written to the board — a
credential sent to an inbox and also posted where every till can read it is a
second place to steal it from. The answer stays byte-identical for a stranger:
`via` is the INSTALL's transport, the same doctrine as `delivered` on the
account plane. The invitation landing's "Send my code" follows the same rule.

### A QR code is bytes, or it is decoration

*"This QR is not readable"* — correct: the Table QR modal drew a 13×13 grid
of `Math.random()` cells under the words "scan to order", beside a URL that
was real, and both buttons under it (**Print QR card**, **Rotate token**)
closed the modal and did nothing. A picture of a QR code is the "control does
what it says" defect wearing its most persuasive face, because a QR that is
subtly wrong looks exactly like one that is right.

`app/kashikeyo-qr.js` is a complete QR encoder — ISO 18004, byte mode,
versions 1–10, all four EC levels, GF(256) Reed–Solomon, all eight masks with
penalty selection — dependency-free, loaded by the browser and required by
the server like `kashikeyo-rules.js`. It was verified against an independent
decoder (jsQR, in a scratch harness, never a dependency) across fifty
payloads before it shipped; `test/qr.test.js` pins known-answer matrices from
that verified run, because a regression here cannot be seen by looking.
Getting it right took two corrections worth recording: the format-info
placement is NOT symmetric (the first draft transposed the two arms, which
decodes as garbage), and an alignment pattern whose centre falls on a timing
line (v7 up) is REQUIRED — "skip cells already painted" silently dropped
exactly those, so everything decoded to v6 and nothing at v7.

The modal draws the real matrix as one percent-encoded SVG data URL (never
the `;utf8,` form — a semicolon ends an inline declaration, the dish-glyph
trap). **Print this card** and **Print every table** open a print window —
one crisp vector path per card, the floor's own labels — which is the answer
to "how do I get table QR codes": Table actions → Table QR on any table, or
Settings → Print table QR codes for the whole floor. "Rotate token" is gone:
the QR encodes an address, not a credential, and a control offering a
rotation this build cannot perform is the defect this file refuses by name.

### One product, one plate — the member card too

The member card fed raw `data:` URLs straight into `background-image` — where
`image/jpeg;base64` truncates at its own semicolon and paints NOTHING — and
had no section artifact at all, so an unphotographed dish was a blank grey
box on the card while the guest portal and the till drew the section's plate.
The card now carries the same composition (photo → blob URL; no photo → the
section's hue and glyph from `kashikeyo-data.js`), through one `plate()`
helper over every dish image site — the grid, the usuals rail, the search
rows, the cart and the reward catalogue — and the grid's detail line falls
back to the allergen/Vegetarian line the guest portal prints where a dish has
no description. `test/wiring.test.js` pins all three: the real QR, the
member round's table-and-token, and the one plate.

### The ask carries the answer, and the shop sells with its own tenders

*"Ask for the bill isn't reaching the floor"* — reported exactly right, twice
over. `requestBill()` had existed on the guest portal since the bill tab was
written and **nothing called it**: a guest chose a split, a tip and a tender,
was told what they were paying, and the screen offered no way to say so. And
where the member card DID ask, the network path sent a kind and a line of
text — the whole decision survived only in the localStorage bridge, which
reaches a till only when the till shares the browser. The one path a real
restaurant uses delivered "ready to pay" and nothing else.

- **The CTA exists now** — accent while the ask is in the guest's hands,
  near-black once it is on its way, the member bar's own two temperatures.
- **`guest_request.pay` (migration 047)** carries the decision — tender, tip,
  due, split, parts, guestRef, promo, points — whitelisted **field by field**
  at the door, clamped and truncated, because an open door does not store
  whatever shape it is handed. The board's text stays in `detail`: a board is
  read by a person.
- **The poll hands it to the till** in the same fields the local bridge always
  used, so `ingestPayIntent()` pre-selects the tender and keeps the tip from
  any device — and exactly once: a server-sourced signal has no localStorage
  row for its ingest mark, so the mark is held in memory beside the acked map,
  or the intent op re-queued every five seconds for ever.
- **The tenders are the till's own.** The portals used to read a co-located
  till's localStorage and fall back to a hardcoded three, so a real guest's
  phone never offered QR or Transfer however the store took money. The guest
  projection publishes the till's tender set — suspending a contract takes its
  tender off the phone in the same act it comes off the till, and customer
  credit is named `memberOnly` so only the member card offers it, gated on the
  member's own headroom.

### An add-on's name feeds the kitchen; its money feeds the bill

The projection never carried the outlet's modifiers, so the guest dish sheet
fell back to the SHIPPED demo list — every store's guests offered somebody
else's extra cheese — and the member card had no add-on sheet at all. Worse,
the money: an add-on rode the line NOTE only ("Extra cheese +5" reached the
docket and never the total), so **every priced add-on was given away** — the
cart said 13, the ticket billed 8.

The projection publishes `modifiers` in the bootstrap's own shape (an add-on
price is a menu fact; no cost travels), both portals offer them — the member
card gained the same dish sheet, opening only for a dish the outlet actually
dresses — and the round's lines carry `addons` (the money) beside the note
(the names). The till's ingest prices the line `menu + addons`, measured:
Kalhu Sai 8 + extra cheese 5 landed on the ticket at 13.00. Two configurations
of one dish are two cart lines, so the member cart bumps by INDEX — a bump by
id moved the plain one and the dressed one together.

Both section rails wear the till's design now — the selected tab fills with
its section's hue, an unselected one leads with it (the guest's chips carry
the section plate, the member's a tinted leading edge), and the count is a
bare numeral. Driven at 320/390/430/768/1024 on both portals: no page scrolls
sideways at any width. `test/wiring.test.js` pins the ask, the whitelist, the
published tenders and the add-on money; `test/api.test.js` walks the door.

## A discount is on the receipt, or the receipt does not add up

Asked directly — *do discounts work, and do receipts reflect them?* — and the
first half held everywhere it was driven: the manager gate, the 25% cap, the
mandatory reason, service and tax following the DISCOUNTED goods, the sale row
carrying subtotal/discount/net apart, revenue booked GROSS on 4000 with the
discount as its own contra leg on 4200, the journal balanced, no tax flag. The
second half did not. Service and tax follow the discounted goods, so a receipt
printing Subtotal · Service · Tax · TOTAL without the discount row is a paper
whose own arithmetic overshoots its TOTAL by exactly the discount — and the
guest is never told one was given. Four surfaces had the gap, each differently:

- **the settled receipt modal** (and the paper "Print & close" maps from its
  rows) simply skipped the row;
- **the auto-printed receipt** carried the dish lines and NO TOTALS AT ALL —
  items with no figure to pay. It prints what the settled screen shows now:
  subtotal, the discount where one was given, service, tax, TOTAL, the tender
  and the change;
- **the Orders-reopened copy RECOMPUTED its total from the pre-discount
  subtotal**, so every discounted bill was overstated by exactly its discount
  on the one screen a guest asks to see again — and the refund figure with it.
  The STORED total is what prints;
- **the ticket panel's totals** listed Subtotal · Service · Tax · Total and
  nothing between.

The shared `/r/<token>` page was already right — `doc.html` had its Discount
row from the day it was written, fed from `sale.discount`.

**And the reason and the authoriser never left the till.** The form made the
reason mandatory and the applier passed a rank gate — then the sale op carried
neither, so `sale.discount_reason` and `discount_by` (there since the schema
was written) were NULL for every discount ever given, and the audit op that
did carry the reason lived only on the trail. The promo now stores the session
actor's uuid beside the display name, `saleTrail()` carries both, and the op
sends them under the names the server reads. `discount_by` is a uuid column
and a sale is NEVER refused, so `applySale()` drops a malformed claim rather
than failing the insert on a cast — the attribution is what a bad till build
costs, never the sale.

Driven in the real till: 10% WELCOME with reason "regular guest" on a 248.00
bill — bill panel `less 24.80 · Svc 22.32 · GGST 19.64`, cash settle, sale row
complete with code, reason and authoriser, Cr 4000 = 248.00, Dr 4200 = 24.80,
journal balanced, and the Discount row on the settled receipt, the reopened
copy, the ticket panel and the shared page. `test/wiring.test.js` pins the
four surfaces and the op's fields; `test/api.test.js` rings a discounted bill
carrying all three and one with a malformed authoriser, and asserts the
columns and the drop.

## The portals wear the store's face, and the banner is real

Reported as *"this banner I believe is not functional"* — correct, and worse
than not functional: the Promotions & Banners screen "published" its banners
into **this browser's localStorage** (`kashikeyo.promos.v1`), which only a
portal sharing the machine could ever read. A real guest's phone saw nothing,
ever, while the screen at the counter said what was live — and the banner form
asked for an "Image path" defaulting to `img/hero.jpg`, a file that resolves
to nothing on any phone. The member card read that same localStorage key; the
guest QR menu never drew a banner at all.

**The road is the projection now, end to end.** A banner rides `banner_upsert`
like any other write; the guest snapshot filters what a phone may see — live,
inside its own date window, and only while the slot is ON (`qr_banner_slot`
writes the outlet setting, and the snapshot reads it, so switching the slot
off empties the strip on every phone rather than hiding it client-side). Both
portals render the same rows: the guest QR menu as a swipeable strip above the
diet chips, the member card in its existing offers section. Tapping a coded
banner fills the promo field the bill tab already verifies at settlement — a
banner never discounts a bill on its own.

**Branding is a guided panel, not trial and error.** *Portal branding* (on the
Promotions screen, rank 4 — RLS on `chain.outlet` is the gate, and the handler
refuses by name when the policy matches no row, because RLS does not error a
hidden write, it silently updates nothing) offers two slots, each stating on
the holder what it takes: the **logo** (square PNG, transparency kept, scaled
to 320 px on the device) and the **cover** (wide photograph, scaled to
1200 px). The banner form's image is the same kind of slot. A slot is a
transparent file input covering the whole holder — which is what makes it BOTH
the tap target and the drop target: dropping a file onto a file input sets
`.files` natively, so there is no drag choreography to break. `readImage()` is
the one reader (validate, downscale, PNG stays PNG — re-encoding a logo as
JPEG puts a white box behind the mark on every dark surface).

The face lives on `chain.outlet.brand` (044), written by the new `outlet_brand`
op (silence preserves per key; an explicit null takes an image down; anything
past 600 KB is refused by name as a file the downscale never touched). The
bootstrap publishes the signed-in outlet's `brand` for the till's preview (a
`brandPen` holds this terminal's un-synced edit, dropped when the outlet
publishes the same answer); the snapshot publishes it to both portals, which
draw the cover as the QR menu's masthead with the store's name over its lower
edge, the logo on the guest header and on the membership card the way a bank
card wears the bank's. Data URLs render through `photoUrl()` blob URLs — the
semicolon trap — and a banner with no image is a tinted card, never a path to
a file that is not there.

`test/wiring.test.js` pins the whole road (the snapshot's filters, no typed
image path, no localStorage publish, both portals reading the projection);
`test/api.test.js` proves the slot and window filters and the rank-2 refusal
over HTTP; the Chromium drive sets all three images through the shipped
screens and reads them back on both portals.

## A bill somebody can be handed

A guest asks for the bill on WhatsApp, a house-account customer wants last
month, a receipt is needed for an expense claim a week later. All three are the
same shape — **a document, at an address, that a person with no account here
can open** — so there is one page for all three and one composer for the
message.

```
https://<handle>.kashikeyopos.com/r/<token>     a receipt
https://<handle>.kashikeyopos.com/st/<token>    an account statement
```

**A receipt is stored; a statement is signed.** They look alike and they are
not the same kind of thing:

- a **receipt** is one document that never changes and the guest KEEPS. So it
  is a token in the row (`sale.share_token`, migration 042), minted once and
  kept: a link that expires is a receipt you cannot produce at the moment you
  need it, and re-sending has to reach the SAME page or the guest's older
  message points at a document that no longer answers;
- a **statement** is DERIVED and it is a window into somebody's spending. So
  it is signed rather than stored — `typ: 'd'`, carrying an outlet, a member,
  the period and an expiry — and it lasts thirty days. A permanent link to
  "this customer's account" is a standing window nobody asked for.

**The host names the store.** A shared link is on the store's own subdomain, so
the token is looked for in the one store the reader is already on — narrower
and cheaper than searching every business in the cluster for it, which is what
a bare `/r/<token>` would have to do. `?s=<handle>` is the path form, for a
deploy with no base domain, and the PAGE forwards it: `docUrl()` spells that
form and `doc.html` dropped it, so every link of that kind landed on "that
receipt could not be found". **One named parameter, never the whole query
string** — a click-wrapper appends its own to anything that goes through an
inbox, and passing those on is the `?t=` defect the invitation landing already
paid for once.

**OLD IS NOT WRONG.** `verifyWith()` refuses an expired token exactly like a
forged one, which is right for every credential plane in this build and wrong
for this one: a guest whose statement link has aged out was told it could not
be FOUND, and goes to check their own copying — or concludes the store deleted
their record — rather than asking for a new one. The page already carried "This
link has expired" and the 410 that would reach it was unreachable code.
`sealed()` is the MAC and the plane without the clock; `docExpired()` is the
only caller allowed to ask, and `sealed()` is deliberately **not exported**,
because a "verify but ignore expiry" primitive on the module surface is one the
next reader reaches for on a session. Nothing is weakened: the signature and
the plane still have to hold, so a 410 is proof the store really did issue this
once.

**What the document carries is what the guest bought and paid, and not one
thing more.** No cost, no margin, no staff record, no device, no ticket, no
other bill, no member id, and no outlet totals. The test names each of them, on
the document and on every line.

### A sale the till can name

Every one of these was found by settling a bill in a browser and tapping the
control. None of them is reachable by reading the code, because every half of
each is individually correct.

**The Send control on a settled receipt never lit up.** It looked for the
outlet's copy of the bill by RECEIPT NUMBER — and there are two allocators.
The till mints `INV-<code>-<year>-0001` from `docNext()`, a counter persisted
in that browser; the outlet allocates from `chain.doc_series`. The two strings
are never equal, so `srvId` was always null and the control read *"Send it once
this bill reaches the outlet"* for ever, on every real sale. Measured: the bill
was in `outlet_39.sale` under two seconds after Close ticket, and the control
still said it was not.

The outlet allocating both the id and the number is right — a document number
is a statutory sequence and cannot be minted on a device that has been dark all
evening. What was missing is the other direction, and this build already
answers it one row up: **`ticket_line.client_id`**, because a line created
offline has to be nameable before any server has seen it. A settled bill is
exactly that. So `sale.client_id` (migration 043): the till mints it with
`newId("R")`, it rides on the sale op as `cid`, `applySale()` keeps it, and
`settledOf` publishes it back. **NULL is a real answer** and the column stays
nullable — a build older than 043 sends none, and inventing one would be worse
than a control that honestly waits. Unique, because it is the till's way of
saying "that bill" and two rows under one name make that ambiguous.

**The share sheet opened the TABLE sheet.** `shareDoc()` set
`modal: { kind: "actions", title, sub, acts }` — and `actions` is the table
sheet, whose branch composes its own title, subtitle and list from the active
table and ignores the modal state entirely. So "Send the receipt" opened
*"Table actions · Tnull · Loy Cafe · free · Parked bills · Table QR · Mark
reserved"*. `kind: "share"` renders what its caller composed and nothing of its
own.

**And it threw the receipt away.** `state.modal` is one slot, so opening the
sheet REPLACES the settled receipt — Print button and all — and after a send
the cashier was back on the floor, one tap after taking the money and before
printing anything. The receipt is stashed and restored, so a second channel is
one tap away rather than a hunt through Orders.

**"Copy the link" demanded an email address.** It asked the outlet for an
`email` share and threw the answer away, so copying a link for a walk-in was
refused 409 — for a message nobody was going to send — and opened a form
asking for an address. Giving a document an address and DELIVERING it are two
acts: `link` is the channel that does the first and only the first. Nothing is
sent, so nothing is claimed, nothing is a failure and there is no app to hand
off to.

**And the address popup called a walk-in a customer.** It said *"This customer
has no email address on file yet"* over a promise that *"the address is saved
on the customer"* — for a takeaway bill rung on nobody. Nothing was saved and
nothing could be. The spec is built per render now and reads off whether there
IS a customer: a member is named and the address is kept; a walk-in is told the
bill was not rung on a record, the button says **Send it**, and the foot
promises no save it cannot make.

### Three channels, one message

Same shape as the member invitation, and for the same reason: the channel
decides the transport and which field it addresses, never the words.

| via | how it goes | addresses |
| --- | --- | --- |
| `email` | a real send through `src/email.js` | the customer's email |
| `whatsapp` | click-to-chat (`wa.me/<digits>?text=`), opened from the staff member's own app | their mobile |
| `viber` | `viber://forward?text=`, the same handoff | their mobile |

`app/kashikeyo-share.js` is the composer, **loaded by the browser as a script
and required by the server as a module** — like `kashikeyo-rules.js`, and it
matters here for the same reason: the till shows the cashier the message before
sending and the server is what sends it. Two copies means proofreading one
sentence and delivering another.

`msisdn()` is the one definition of a number an app can be handed: digits only,
leading zeros dropped, **960 prefixed to a bare 7-digit Maldivian mobile**, and
refused outside 8–15 digits rather than composing a link to nowhere.

**`sent` is derived, never assumed.** WhatsApp and Viber are handoffs and
answer `sent: false` with the composed URL — that is the only WhatsApp send
this build can honestly make, exactly as the invitation already says. Email
answers what the transport answered.

**A RECEIPT DOES NOT REQUIRE A CUSTOMER, and requiring one was this build's
own invention.** Most bills in a café are rung on nobody, and WhatsApp refused
every one of them — *"no usable mobile number on file"* — with the till telling
the cashier to add a number to a customer record that does not exist. Reported
exactly that way. Neither handoff has ever needed a recipient: Viber's forward
URL takes none at all, and **`wa.me/?text=` opens WhatsApp with the message
composed and lets the cashier pick the chat**, which is fewer taps than typing
a number into this app and then watching WhatsApp ask for it again. So `why()`
gates EMAIL alone, because a message cannot be posted to an inbox nobody named.

**A number read out at the counter has a field of its own.** The server has
always honoured a typed `to`; nothing in the till ever asked for one. *Type a
mobile number* sits in the sheet for the guest who reads one out, and for a
member who wants THIS bill on a different phone from the one on their record.
It needs no customer, holds the number to the same `msisdn()` the link is
composed from — so a number the screen accepts can never be one `wa.me`
refuses — and offers it back to the record only where there IS one.

**And a bill settled earlier is shareable too.** The Send control lived only on
the receipt that appears the instant a bill is closed, so a guest who asked ten
minutes later, or a house-account customer ringing the next morning, could be
sent nothing. The row reopened from Orders & Tickets came from the OUTLET, so
it already carries the outlet's own id — there was nothing to resolve and
nothing to wait for. A row this device settled but has not yet delivered has no
id, and says so rather than offering a control that cannot work.

**A refusal names the field and still hands back the link.** No email on file
is a 409 saying so, with the address of the document attached — the document
EXISTS; only the delivery could not be made. The till reads that one sentence
and opens a popup asking for the address, because an instruction to add one is
only useful next to somewhere to add it; it saves onto the customer through
`patchRows("custs", …)` — the same one seam every customer edit goes through,
which is what makes the address reach every other terminal — and then sends,
so the next receipt asks nothing. An address already on somebody else's record
is refused by name (migration 018 makes an email a second identity, and two
customers on one address is one guest signed into another's card). The other
two channels need no address at all, which is what makes them the easy path: a
customer taken at a counter has given a name and a number.

Both doors are rank 2 (a cashier hands a guest their bill), rate-limited per
OUTLET like the invitation — this is about spend, not identity — and both land
on the trail.


## A store starts with a menu, or with the typing still to do

The onboarding menu step leads with a DECISION, not a table: **start with the
pre-set menu** (recommended) or **start empty**. The pre-set is the full
Maldivian café catalogue — 9 sections, 112 add-on options, 8 bought-in counter
items with their two suppliers, and 301 dishes carrying their tags, heat,
add-on links and buy links — so a dish picked at the till or on the QR menu
offers its add-on choices from the first order.

**The data is `src/data/preset-menu.json`, extracted from a real outlet's own
tables AFTER the catalogue had been driven through the shipped CSV import** —
what ships is the state the import provably lands, not a second reading of the
source file. `src/preset.js` replays it through the SAME handlers in
`src/apply.js` every till write goes through (one direction of truth, the
setup-file rule), in the order the FKs force: suppliers, sections, add-on
groups, stock items, dishes. Idempotent by construction — every kind is an
upsert keyed by the row's own id — so choosing it twice converges, which is
what makes the menu step `rewritable`.

Three doors, one apply: the onboarding panel's choice (`POST
/api/onboarding/menu-preset`; `/state` carries `preset` counts so the card's
sentence is counted, never typed), Menu Master's **Load the pre-set menu**
(`POST /api/outlet/:id/menu/preset`, rank 5, gated, on the trail as
`menu_preset_loaded` — drawn only while the menu holds fewer than ten dishes,
because on a mature store a 300-dish load is a decision for the import screen,
not a header tap), and the same road for a later outlet. The chooser's blank
dish grid is hidden while the pre-set is selected — a form asking to be filled
in under a decision already made.

`test/wiring.test.js` pins the file's internal references (every dish's
section, add-on group, stock item and supplier resolves) and the op order;
`test/e2e.test.js` lands it on a brand-new business over HTTP and proves the
idempotency and the bootstrap read-back; the Chromium drive proves both
shipped screens against real databases.

## The onboarding panel asks one fact once

Reported as *"onboarding has some repetitive fields"*, and the repetition was
real in three places. None of them errors, none of them loses anything, and
that is exactly why they survived: a customer simply types their own street
name into two boxes and answers the same tax question on two screens.

- **The address, the phone and the email** were asked on the company step and
  again on the outlet step. A single-outlet business trades at its registered
  address on its registered number, so the honest default is *the same*, said
  once and shown rather than typed again. **Same as the business** is a toggle
  on step 2, on by default, and the fields appear only when somebody says this
  store trades somewhere else. It reads off the RECORD — `/state` carries the
  company's own contact — because an offer that reads off what step 1 left in
  the page is an offer a reload turns into a control that sends nothing.
- **The tax class and the service charge** were asked on the outlet step and
  again on a tax step immediately after it. `servicePct` was literally the same
  field under the same label, twice.
- **The tax step was never doing anything.** `provisionOutlet()` writes
  `chain.tax_version` from the outlet step's own `taxCode`, `taxRate` and
  `taxFrom`, in the same transaction that creates the schema and the login
  role — so `/state` reported that step DONE before anybody reached it, and it
  could only ever open on *Saved · continue*. A step whose only possible state
  is "saved" is a step asking a question it has already been given the answer
  to. It is gone; the rate and the date it takes effect moved up beside the
  class that decides them. Thirteen steps, not fourteen.

**The first three are the APPLICATION.** The company, the store and the person
are what must be written before an install can do anything at all; the ten
after them are the shop being set up, which the till goes on nudging through on
its own Today list. So the two are shaped differently: a three-node pill
stepper over the application, the rail for the long sequence. A stepper is
legible at three and a smear at thirteen.

**The number is derived, never typed.** Every step used to carry its own `n`
and the screen its own literal 14, so folding one step into another was a
fourteen-place edit and a missed one reads as "step 5 of 14" over the fourth
card. `STEPS.forEach` sets it from the position.

**A field a form collects has to land somewhere.** The three steps now ask for
what a business actually hands over — a logo, a business type, a website, a
postal code, a mobile. `chain.company.brand` has carried exactly that shape
since the schema was written and nothing had ever asked for it;
`chain.outlet` had no equivalent, so **migration 044** gives it one. jsonb
rather than five columns for the same reason the company has one: these are
presentation, not predicates, and nothing joins on a website. A field
collected, toasted as saved and written nowhere is the defect this build
refuses by name, and the honest alternatives were to add the column or stop
asking.

Two things are deliberately NOT asked, though the form they were taken from
asks both. **An outlet TIN**: in the Maldives the taxpayer registers with MIRA,
not the shop — registration is a COMPANY fact, and a second TIN field invites a
business to invent one. **An activity registration document**: nobody reviews
an application here, because signing up creates the store, so a 10 MB PDF
nothing reads is a control that does nothing.

**A logo is scaled on the device that took it**, 320px on the longest side —
the same rule a dish photograph already follows, and for the same reason. A
PNG stays a PNG: a logo is the one image in this app that genuinely needs
transparency, and re-encoding it as JPEG puts a white box behind the mark on
every dark receipt header.

### The inventory pass against the reference form

Asked afterwards — *check if anything on the input is missing* — and an
element-by-element diff of the reference screens against the shipped panel
found five gaps, four of them real:

- **the admin's mobile** had nowhere to land: `chain.staff` carried no phone
  column, so the reference's step-3 field could not be inherited. Migration
  045 adds it (nullable — every earlier staff row asked nobody); `/owner`
  writes it after the claim so `chain.claim_first_owner()`'s SECURITY DEFINER
  signature stays exactly what 005 audited; the bootstrap deliberately does
  not publish it, because a roster any signed-in till reads does not need
  everybody's personal number. The reference's step-3 EMAIL is deliberately
  NOT inherited — the account signed in with one to get here, and asking it
  again is the ask-twice defect this panel just shed;
- **the legal foot** ("By submitting … Terms & Conditions") linked to nothing
  because nothing published where the legal pages live. `/state` carries
  `siteBase` now and the application steps draw absolute links to
  `/terms`, `/privacy` and `/docs` on the base domain — or nothing, the same
  absolute-or-nothing rule `joinUrl()` keeps, because a relative `/terms` on
  the app host answers 404 and a legal link that 404s is worse than none;
- **the stepper's icons** — building, storefront, person — replaced the bare
  numbers on the three pills; a done step still swaps to the tick;
- **the plan** appears in the step-3 summary only where `chain.licence`
  actually carries one (a seller-provisioned install); a self-serve signup
  has no licence yet and shows nothing, and no price is ever printed because
  the licence carries none — the reference's MVR 300/700 cards are another
  product's price list and inheriting them would be an invented figure;
- the business email prefills from the account's own address — offered, never
  asserted, editable in place, and the saved record wins on the way back.

Still deliberately not inherited: a required logo (blocking a signup for want
of a PNG costs a customer), the outlet TIN, and the activity-registration PDF
— each stated in the section above.

### Two defects found by driving it, neither reachable by reading it

**A tourism outlet was created charging 8%.** The rate box is filled with the
statutory rate for the class the step opens on — GGST, 8% — and the class is
chosen AFTER it has been filled. So picking TGST, which is 16%, left 8% sitting
beside it. Measured against a real database before the fix: `tax_code` TGST,
`tax_version` rate **8.00**. A tourism outlet at half its rate is a debt to
MIRA nobody notices until an audit, which is the failure `applySale()` already
refuses on the other side. The rate follows the class now, and STOPS following
the moment somebody types their own — a business whose rate genuinely differs
must not have it stomped by a select, the same rule the store address already
keeps: a suggestion steps aside for an answer, a decision never does.

**And the panel was reading the wrong outlet.** `state.outlet` came from
`/api/auth/install`, which resolves its outlet from the TERMINAL's own stamp
rather than from the business being set up. An owner standing at a machine
already signed into their first store, setting up their second, was shown the
first store's code, tax class and rate — and `pfx()` builds the document-series
prefix from that code. A series that has issued a number can never be
renumbered, so the second store's receipts would have carried the first store's
prefix for good. Every reader uses `state.outletRec` now, which the onboarding
plane resolves from the business this panel is actually configuring; the lock
screen's payload is deliberately not widened to carry a store's slug, kind and
brand, because it answers before anybody has signed in.

Going Back also shows what is STORED rather than an empty form under a chip
reading "done" — every answer still in the database and none of it on screen,
which reads as work lost. `/state` carries the saved company and the saved
outlet, including the rate actually in force rather than the statutory one for
the class.

Measured by driving the shipped panel in Chromium, twice: a business that is
not registered for GST (the TIN field appears and disappears with the toggle,
the outlet inherits the company's address, phone, email, website, postal code
and mobile while keeping a logo of its own) and one that is (TGST at 16.00 in
`chain.tax_version`, its own address, its own email). At 390px the page does
not scroll sideways and no control is under 44px on its short axis.

## A setup file is not a backup

Asked as one sentence — *"a local backup in case we reset, and let us set what
we need in it"* — and it is two requests. A **backup** must be COMPLETE or
restoring from it is a fiction: tick "menu and customers", skip the sales, and
the file cannot bring a store back. A **setup file** is the other thing, and
the picker belongs to it.

`src/setup.js` is that file. It carries what a shop CONFIGURED — sections,
dishes, recipes, ingredients, batches, add-ons, the floor plan, customers,
suppliers, settings — and no sales, no payments, no journal, no stock
movements and no member balances. So it answers the question actually asked:
we reset the store, give us our setup back. `src/backup.js` is the other one —
pg_dump, complete, restorable, all-or-nothing by nature — and the card says so
rather than letting one be mistaken for the other.

**One direction of truth.** The export emits OPS — the same `{kind, payload}`
the till queues — and the import replays them through the SAME handlers in
`src/apply.js`. An imported dish and a dish typed at the counter arrive by one
road: the same validation, the same allergen re-declaration, the same "silence
preserves" rules. A bespoke importer would be a second way to write a dish, and
the two would drift the first time either changed.

**The allowlist is the fence.** `IMPORTABLE` is the closed set of kinds a file
may carry. Without it the endpoint is "run any op you like against this
outlet", and a hand-edited JSON is a way to post a journal, ring a sale or
settle a credit balance under an owner's own token. Measured: a file naming
`post_journal`, `sale` and `settle_credit` is refused three times by name, and
the ledger does not move.

**Rank 5, and no owner connection.** This is the whole store's configuration
leaving the building, and putting one back rewrites all of it at once — an
admin runs the shop, the owner decides what the shop IS. Every table it touches
is one the outlet's own login role already reads under RLS, so the
six-exception list does not grow.

**What deliberately does not travel.** The install's own uuid (migration 026),
because copied into a second store it removes the fence that stops one
install's outbox replaying into another. Staff PIN hashes, for the reason
migration 038 exists. `points` and `credit_used`, which are what a guest earned
and what they owe — maintained by the sale path against 2350, so a balance set
from a file is a liability nobody posted. A supplier's uuid on an ingredient,
because the store a file lands in issues its own; the ingredient comes back
unlinked and the part says so. And `sold_out_reason`: 86-ing a dish is
tonight's stock, not setup.

**Idempotent by construction**, because every kind on the list is an upsert
keyed by the row's own id — which is what makes "try it again" a safe
instruction after a partial import. Each op runs in its own SAVEPOINT, so one
row the outlet refuses does not throw away the other four hundred, and what was
refused is REPORTED by name and by part: an import that silently drops a third
of a menu is worse than one that fails, because the operator believes it
worked.

**Two things the screen got wrong, both found by tapping it.** The form opened
BEFORE the parts arrived, and `openForm` seeds every field at the moment it
opens — so a form that gains its fields afterwards has none of them seeded, and
all ten parts read "Leave out" until the operator set them one at a time. The
parts are fetched first now, and everything is included by default: the
ordinary answer is "all of it", and leaving a part behind is the deliberate
act. And it was opened on `null`, so the form renderer — which shows a second
control only where there is a record to act on — never drew **Put a file
back**, which is half the feature.

Measured end to end in a browser: export from Settings → Device & data (8
records, `kashikeyo-setup-LOYC-2026-08-27.json`), the store's menu, sections,
settings and customer details deleted, then the file put back through the same
form. Everything returned exactly — the dish with its tags and heat, the
section with its colour and glyph, the customers with their addresses and
credit limits — and the 18 settled sales were never touched, because they were
never in the file.

**And `vendor_upsert` only ever inserted.** Named an upsert, called by the
till's supplier form on every save, and a bare INSERT — so editing a supplier's
phone number created a SECOND supplier under the same name while the purchase
orders stayed on the first. Found by writing the import, which replays this op
and would have duplicated a store's whole supplier list on the second run. It
resolves by NAME now, case-insensitively, as suppliers already do everywhere
else in this build; not a unique index, because an install may already hold two
rows under one name and a migration that refuses to apply is worse than a
handler that converges.

## The navigation is a rail

A **60px icon rail** at every width above a phone. Opening it floats a **236px
labelled panel over the content** with a scrim; nothing behind it moves.

Overlay rather than push, for two reasons a service terminal makes concrete: it
is touched, not pointed at, so hover-to-expand has nothing to read; and widening
the column reflows the floor grid, so the table a waiter is already reaching for
slides out from under their thumb mid-tap.

Two things here were real defects and both are invisible to a feature test:

- **The content is pinned to grid track 2.** With the aside `position: fixed` it
  leaves the grid, and without an explicit track the content auto-places into
  track 1 — the 60px rail — so the whole app collapses to 60px and only still
  looks right because it overflows.
- **The panel fades in; it is never transformed.** A transform-based entrance
  parks the element at `translateX(-100%)` — off screen — if the animation is
  throttled or never starts.

Rail targets state `min-height: 44px` with 4px of side padding on a 60px rail,
so the target is 51 × 44 and the scroller gutter is hidden rather than eating
into it. A rail whose whole justification is touch cannot ship 34 × 36 targets.

"Keep it open" pins the labelled panel and persists per terminal in
`prefs().navPinned`; pinned, the panel is part of the grid and there is nothing
to dim, so the scrim and the menu button both go away. One control always does
whatever the current state has left undone.

`test/responsive.test.js` measures both: a content box's `x` and width before
and after opening (they must be identical), and every button in the aside on its
short axis.

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

## The open doors have a doorman

`src/limit.js`. The endpoints anybody on the internet may call each either send
an email (which now costs real money, billed to the business) or burn a guess at
a credential. Each gets two token buckets, and **both must have room**: an
IDENTITY bucket keyed on who the request is ABOUT — the email, the phone,
hashed before it is held — so one address cannot be hammered from many IPs, and
an IP bucket several times wider, because a restaurant's wifi puts the whole
room behind ONE address and a doorman who cannot tell forty guests from one
attacker locks the room's members out of their own cards.

Gated: account signup/code/verify/signin, the guest portal's member
start/join/join-code/verify, and the counter's invite send (per OUTLET, 60 an
hour — that one is about spend, not identity). The refusal is a 429 with
Retry-After and the same bytes whether or not the address is a customer — the
doorman keeps the enumeration promise the endpoints themselves make. The
credential guards underneath (five tries per code, the outlet-wide PIN lockout)
never left; the door just makes reaching them expensive.

**In memory, on purpose.** One process, minutes-wide windows, fails open on a
restart — the correct failure. If this app ever runs as replicas, `limit.js` is
the one seam to move onto something shared. `RATE_LIMIT_SCALE` multiplies the
ceilings so the test suite's single loopback address does not read as an attack;
production ignores it.

## The two doors that had nothing behind them

**A wrong PIN cost the whole floor.** Five failures at an outlet locked EVERY
account there for fifteen minutes, and anybody who could reach the endpoint
could spend those five: no credential, no device, no cost, repeatable for as
long as somebody cared to keep going. It was a security guard that doubled as
a denial-of-service lever, and the lever was cheaper to pull than the attack it
defended against.

Two tiers now, and the difference between them is what the failures PROVE:

- **the caller** — six wrong PINs and THIS caller is refused for fifteen
  minutes: the till it was keyed on (`chain.device`), or the connection when
  the caller is not a paired till. Somebody fat-fingering their own PIN slows
  down and nobody else on the floor notices. An attacker can lock exactly one
  thing, and it is themselves. The refusal says *this terminal*, because
  telling an operator "the keypad is locked" while the till beside them takes
  money teaches them the app lies;
- **the outlet** — forty wrong PINs inside the same window is no longer
  mistyping. It is a distributed attempt on a four-digit space, the accounts
  are now at risk, and the original outlet-wide lockout engages exactly as it
  always did. Getting there costs seven distinct callers rather than one
  request.

The budget is spent **only on failure** (`room()` checks, `take()` charges), so
a counter signing its staff in correctly all evening never touches it — the
difference between a doorman and a turnstile. A device id is client-supplied
and forgeable, which only ever buys the forger more tier-one budget; what it
buys everyone else is that one till's mistakes are never charged to the till
beside it.

**A fresh install went to whoever got there first.** `chain.claim_first_owner()`
succeeds exactly ONCE in the life of an installation, and the three steps
before it — company, first outlet, first owner — cannot be behind a staff
session, because the staff session is what step 3 creates. So they were behind
nothing, and the starting gun is public: a new install's hostname reaches the
certificate transparency logs within minutes of its first TLS handshake, which
is well inside the gap between provisioning it and the customer sitting down.

`ONBOARDING_CLAIM_TOKEN` closes it, deliberately the same shape as Mission
Control's `PANEL_SETUP_TOKEN`: a secret set on the install at provisioning and
handed to the customer with their address, compared in constant time. The panel
asks for it **once, up front** rather than as a field on step 1 — it is not a
fact about the company, it is permission to create one, and putting it beside
the legal name invites somebody to invent it the way they might invent a TIN.

**Unset, the three steps stay open** — an install onboarding itself on a
counter has no seller to get a code from — and the boot log says which of the
two this install is, BY NAME. A fence that is silently absent is worse than no
fence, because somebody believes in it.

Mission Control holds the code (`panel.install.claim_code`) so a customer who
has lost it rings the seller rather than Railway, and reveals it on its own
request — never in the dashboard poll, because a credential that grants
ownership of an unclaimed install should be asked for, not delivered every
thirty seconds into a browser left open on a desk.

The anonymous roster keeps its doorman too. It is readable before sign-in on
purpose — the people on it are standing in front of the terminal — but "not a
secret" is not "free to harvest": one connection asking four hundred times an
hour is building a staff list, not opening a till.

## A control does what it says, or it is not a control

Found by running the restore drill `DEPLOYMENT.md` asks for. The **restore
works** — dumped, dropped the database entirely, restored, and every figure
came back identical: 18,014 bills, MVR 5,879,628.04 gross, trial balance
dr = cr = 5,879,675.32, 72,982 journal lines, 0 unbalanced, the same install
uuid. Repeated into a **fresh cluster**, where `pg_dump` of one database
carries no roles, `pg_restore` dropped 108 GRANT statements on the floor and
exited 1; `/readyz` still answered **200** while every outlet request failed
with `role "outlet_1_app" does not exist`. `npm run provision:outlet -- --all`
— the step the guide names — brought it back in full: sign-in, a 2.4 MB
bootstrap, 12 forced-RLS tables, 20 policies, no grant on the account plane,
`leak-test` 13/13.

What the drill actually found was the screen. **The app's own Backup and
Restore were a picture of a backup system.** `backup_run`, `backup_create` and
`restore_run` are all in `AUDIT_ONLY` — they record the press and do nothing;
`grep pg_dump` over this repo returns nothing and there is no route for
either. Yet the Restore card listed archives with dates and sizes, the form
demanded a typed RESTORE, and the toast said the tills would stay locked until
it finished. An operator who trusted that screen believed they had backups and
a way back, and had neither. Both cards say what is true now and name where
the work is done; the handlers stay in `AUDIT_ONLY` for a device still holding
one in its outbox, exactly like `ticket_status`.

The same shape ran through four more:

- **Removing or suspending a person did nothing.** Every write on Users &
  Roles went through `patchRows("users", …)`, which paints the local table and
  queues `users_update` — a kind with NO HANDLER, so `applyOp` recorded it as
  `unmodelled` and answered success. Proved against a live outlet:
  `chain.staff.active` was still true after the op the Remove button queues. A
  PIN reset reset nothing. And "Invite user" promised a magic link this build
  has never had, writing a local row reading "Invited" and creating no account
  at all — while `POST /api/auth/staff` and `PATCH /api/auth/staff/:id` sat
  there fully written, guarded at rank 4, with nothing calling them. All four
  go through one seam, `staffWrite()`, which calls the endpoint and refreshes
  from the server; there is deliberately **no offline path**, because granting
  or revoking access while unable to reach the outlet is precisely the write
  that must not be optimistic. A role change carries the **rank** as well as
  the key, or the server keeps gating on the old one. Verified end to end:
  created, signed in, suspended, and the same PIN is then refused.
- **"Sign out other sessions" signed out nobody** and toasted a "+2" it had
  invented, over a count of "3 active" on an install nobody had signed into
  twice. It calls `POST /api/auth/revoke` now and reports the number the
  server actually revoked; the bootstrap publishes `SESSIONS` so the chip is
  measured.
- **"Reset this store"** toasted "tills lock while it runs, then boot empty"
  over an audit-only op, and offered a pre-reset backup this build cannot
  take. It files a **request** now, and says so on the card, in the form and
  in the toast.
- **The Terminal card** printed an app version of `4.2.1` on a build numbered
  otherwise — the figure somebody rings support quoting — and an offline cache
  of "42 MB" nobody had measured. The version comes from `package.json`
  through the bootstrap (`APPVER`) and the cache from
  `navigator.storage.estimate()`, with "not measured" where the browser will
  not say. The Sync screen's "behind" was a verdict against that same literal.

The rule, pinned in `test/wiring.test.js`: **an `AUDIT_ONLY` kind may be
queued by a screen that says it is RECORDING something. It may never be queued
by a screen that reports the thing was DONE.** `test/audit.test.js` already
refused invented figures on the ribbons; this is the same rule for the cards
behind them.

## The matrix shows the ladder; it does not set it

The last of the "a control does what it says" class, and the one that was most
confidently wrong. Every cell on the permission matrix cycled on tap, wrote
`state.permOverride` — one browser's local object — and queued
`permission_change`, which is `AUDIT_ONLY`. Nothing per-ROLE is stored
anywhere: `chain.staff.perm_override` is per PERSON and nothing writes it
either. So a manager who took Purchasing away from Cashiers changed one tab
until it reloaded, and every other terminal in the shop carried on unchanged.

Worse than useless, because it implied a SECOND AUTHORITY. There is one gate
and it is the rank: `atLeast()` reads it on the route and the RLS policies read
it underneath. The note beside the matrix claimed each cell mapped to a policy
predicate and that changing one rewrote the role's grant — neither has ever
been true, and a screen saying so teaches an operator that access was withdrawn
when it was not.

It reads now, and says what it is reading. The local override layer is gone
with the switches that wrote it, so `roleFor()` returns what shipped and no two
screens can disagree with the server. To change what somebody reaches, change
their rank in Users — which is a real write, since the previous commit.

The copy around it went the same way, because fixing a control leaves the
sentences beside it: the header read "Role matrix enforced by Postgres RLS"
(the RANK is what Postgres enforces — a different sentence and the true one),
the guide walked through an email invite and a link that "activates the account
on a device" for a flow that has never existed, and the rank ladder listed
taking and restoring backups as things an Admin and an Owner do here.

Two more from the security pass closed at the same time. **A credential never
rides in a query string** — this build's own rule, written when an unused
`?at=` came off the account guard — and the guest guard still read
`req.query.t`, where `?t=` on the QR portal is the TABLE NUMBER: one parameter
meaning two things, which is the exact confusion that put a foreign credential
into a membership lookup on the phone side. Every client has always sent the
header. And **a wildcard `ALLOWED_ORIGINS` is refused in production**: the apps
are same-origin, so `*` buys nothing and hands every website the answers to
this install's anonymous endpoints. The wildcard is dropped and the boot log
says so — not a boot failure, because a CORS setting is not a half-migrated
schema and taking a restaurant off the air over one is worse than the setting.

## The three that were "accepted with reasons"

A reason is not an impossibility. The security audit listed three properties as
knowing trades; all three are closed.

**A PIN hash never leaves the database** (migration 038). `pin_candidates()`
handed the application every staff member's `pin_hash` and `pin_salt` at that
outlet on every sign-in attempt, and the comparison happened in Node. Not a
hole on its own — it is the outlet's own role reading its own rows — but a
four-digit PIN is ten thousand candidates, so anything that read this process's
memory or logs recovered every PIN at that outlet in seconds. The hash is what
makes a leak survivable; handing it out on every keypress spent that protection
before it was needed.

Two facts make the comparison movable without changing how a PIN is hashed. A
SALT is not a secret — it exists so two people with the same PIN do not share a
hash. And sign-in does not know WHO is signing in, so it has to try every
candidate, which it already did. So the app is handed the salts, hashes the
typed PIN once per salt, and asks `chain.pin_match()` which row matches. It
learns one id. scrypt stays in `src/secrets.js`: Postgres has no scrypt, and
swapping the KDF would mean re-hashing every PIN, which cannot be done without
the plaintext.

**And the COLUMN, or the function was theatre.** Every outlet role held SELECT
on `chain.staff` and `staff_scoped` returns the whole row, so the hashes were
one plain `SELECT pin_hash FROM chain.staff` away — verified by connecting AS
the role, before and after. Postgres has column-level privileges, so it is
exact: SELECT on every column but the two, INSERT and UPDATE left whole, since
writing a hash you generated is what a PIN reset does and reading somebody
else's is the amplifier. Two grants of the same table in `provision_outlet`
were the trap — the second handed it all back, which is what a second grant
always does, so they now sit together where the next reader sees both.

The anonymous **roster** was reading the sign-in function too, picking four
columns out of a row that also carried a hash. It has its own narrow view now:
the widest-open door in the build cannot reach a credential even by mistake.

**The print relay dials the shop LAN and nothing else.** The fence was a
DENY-list — it blocked what somebody had thought of and let the rest through,
which meant `0.0.0.0` (on Linux, loopback) and every public address on the
internet. A printer is never on a public address, so the question is turned
round: inside `10/8`, `172.16/12`, `192.168/16`, `100.64/10` or `fc00::/7`, or
refused. Link-local is deliberately not "private" here — `169.254.169.254` is
every cloud's metadata service. The whole SSRF surface is closed rather than
fenced, and an IPv4-mapped v6 address is unwrapped BEFORE it is judged, with
the unwrapped address the one that is dialled.

**`'unsafe-eval'` is a property of three pages, not of the product.** The
template runtime compiles with `new Function`, so the till and both phone apps
need it. `/account` and `/onboarding` are vanilla DOM, have never loaded the
runtime, and are the pages a stranger reaches first — the sign-up form and the
panel that claims an install. They get a header without it. Verified in a
browser: both render fully with no policy violations.

## A token says what plane it is for

A security pass found two holes with one root cause: a signed blob carrying no
TYPE is whichever credential the reader's field lookups happen to make it.

**`PORTAL_SECRET || SESSION_SECRET` collapsed two planes into one.** An install
that had not set the portal secret signed a stranger's table token with the
manager's key — and `GET /api/g/<slug>/token` needs no credential at all, it is
what a QR scan does. Proved on a live install: that anonymous token presented
as `Authorization: Bearer` verified as a **staff session** (`roleKey: Cashier`)
and returned the whole 2.6 MB bootstrap — every recipe, every cost, 2,000
settled sales, the staff roll, the device roll, the licence and the install
uuid. Production sets `PORTAL_SECRET`, so this needed a self-hosted, staging or
development install; the fallback was silent, which is what made it dangerous.

**A member token satisfied the table check.** A table token was recognised by
having been signed, not by saying what it is, so a member's thirty-day portal
token was an unrestricted table token for that outlet: it placed a guest order
onto table 7 while the table-1 token it was minted from correctly could not.
The stated guarantee — "a guest cannot retype a URL onto another table's bill"
— held for guests and not for members.

Closed twice over, because one fence is not a fence:

- **`typ` is a claim, checked on every verify** — `s` staff, `a` account,
  `t` table, `m` member. A token minted before this carries none and is
  refused, which costs one sign-in each: a till keys a PIN, a guest rescans, a
  member asks for a code. That is the right price;
- **the guest plane's key is DERIVED, never borrowed** —
  `hmac_sha256(SESSION_SECRET, "kashikeyo:portal:v1")` when `PORTAL_SECRET` is
  unset — so the two keys differ by construction and no configuration mistake
  can make them equal.

**The print relay's fence had a spelling gap.** It blocked `127.x`, `::1` and
`169.254.x` and let `0.0.0.0` through — and on Linux a connect to `0.0.0.0`
goes to loopback. Proved by dialling it: bytes arrived at a listener on
`127.0.0.1:9100` and the endpoint answered `{"sent": true}`. Every spelling of
the unspecified address is loopback now, an IPv4-mapped v6 address is unwrapped
BEFORE it is judged rather than pattern-matched twice, and the address dialled
is the one that was judged. Private LAN ranges stay open on purpose — that is
where printers live — and the port is still 9100 and not negotiable.

**The table-token mint had no doorman.** Every other anonymous door on the
guest router got one in the rate-limit pass; this one was missed, and it is the
only one that reaches the database. Gated per IP, generously: a room full of
guests all scanning at once is the ordinary case.

What the same pass checked and found sound, so nobody re-derives it: no SQL is
built from user input (every dynamic `SET` clause is hardcoded column names
with parameterised values, every migration identifier goes through `%I`); a
hostile item name and a hostile member name render as text, not markup — React
escaping holds through the DC runtime, verified in a browser; there are no
cookies anywhere, so CSRF is structurally absent; the error handler never
returns a database message; `npm audit` is clean over two runtime dependencies;
the security headers carry CSP, nosniff, no-referrer, SAMEORIGIN,
permissions-policy and HSTS in production; cross-outlet requests are refused at
the route (`outlet mismatch`, 403) and at the RLS belt underneath; and every
secret comparison is `timingSafeEqual`.

## Ready means an outlet request can be served

`/readyz` — the Railway healthcheck — asked the **owner** connection whether
`chain.outlet` had a row. The owner connection bypasses both isolation belts,
so it could never detect the one failure that takes an install off the air, and
did not: in the restore drill the app booted, answered **200**, and failed every
outlet request with `role "outlet_1_app" does not exist`. A drill that stops at
the health check reports green on an install that cannot take an order.

It checks out **each active outlet's own login role** now and reads a table in
that outlet's own schema — the derived password, the login, the pinned
`search_path` and the grants, which is the whole path a real request takes and
nothing the owner connection can stand in for.

- **A failing outlet is NAMED**, with `npm run provision:outlet -- --all` in the
  body. A 503 saying "not ready" leaves whoever is holding the pager exactly
  where the old 200 left them.
- **And a business whose DATABASE will not open is a different page from an
  outlet whose LOGIN ROLE will not serve.** They were one message under one
  remedy — the role one — which cannot do a thing about a missing database, so
  whoever read it at 2 a.m. would run it, watch nothing change, and still be
  holding the pager. Same defect the restore drill found in this endpoint's own
  remedy, one level up. They are counted apart now, each with the remedy that
  fits, and a placeholder for an unopenable database is no longer counted as an
  outlet — which is how "4 of 5 outlet(s)" once described an install with no
  such outlets in it.
- **No outlets is not a failure.** That is a fresh install on its way to
  onboarding, and a probe that never goes green there is an install that can
  never be set up.
- **Fail slow, recover fast.** A good answer is held for ten seconds
  (`READY_TTL_MS`, read per probe so a test can turn it off — `|| 10000` would
  read an explicit 0 as unset, which is the trap). A failing answer is never
  cached, so the probe goes green the moment the remedy runs, with no restart
  and no wait.
- Taking the instance out of rotation is deliberate, in the same spirit as
  production exiting rather than serving on a schema it could not migrate: this
  is not a state a restart fixes, and it is not a state to serve traffic in.

`test/api.test.js` proves it by taking the schema grant away from a live
outlet's role and asserting the 503, the named outlet and the remedy, then
granting it back and asserting the instant recovery.

## A revoked token is refused, not merely recorded

The sweep above found five screens claiming actions the build only recorded.
Finishing it found the floor underneath them: **two revocation columns existed
and nothing ever read either.**

`session()` in `src/auth.js` verified the JWT and touched no database. So
`chain.session.revoked_at`, set by "Sign out other sessions", meant nothing —
the signed-out terminals kept working for the twelve hours their tokens had
left, including immediately after that button was wired to its real endpoint.
And `chain.device.revoked`, set by deregistering a device, meant nothing
either: the device kept signing in and kept writing, which is exactly the
scenario the card's own copy invokes.

Underneath both, the device id bound into every token came from a **free-text
field** in Settings defaulting to `dev_CHA_T1`, so `chain.device` had no row
for it and nothing about a device could have been enforced even if it had been
checked.

- **`src/revoked.js`** asks both questions on every authenticated request, in
  the one place all three routers mount. The cost is bounded by a POSITIVE
  cache — a session known good is not asked about again for thirty seconds —
  and revocation is one-way, so a cached answer can only ever be stale in the
  harmless direction. The product is sold **one install per customer**, so
  there is a single process and `forget()` makes every revocation IMMEDIATE;
  the thirty seconds is the bound for replicas that do not exist. Same seam
  note as `src/limit.js`. It reads under the OUTLET role — the token names its
  own outlet and both policies allow it — so there is no seventh owner
  exception. An unreachable database **fails open**: refusing there would sign
  the whole floor out over a blip.
- **A deregistered device is refused at the keypad**, not three requests later.
  Without that the till signs in, has its next call refused for the same
  reason, signs in again, and loops, telling the person holding it nothing.
- **A device is enrolled by the outlet.** `POST /api/auth/devices` mints the
  six-character code, the card shows it while it is live, and the new screen
  keys it under Settings → Terminal (`POST /api/auth/devices/claim`, spent on
  use, fifteen minutes). The old form minted a code **in the browser** with
  `Math.random` and then asked the operator to confirm it matched the code on a
  screen that had no way of knowing it.
- **Signing a device out and deregistering it are different decisions**, so
  both are offered and both are real: one ends that device's sessions and
  leaves it enrolled, the other stops it writing until somebody enrols it
  again. "Ask it to replay now" is gone — there is no channel to push anything
  to a device, and every terminal drains its own outbox every five seconds.
- **Your own PIN is yours to change** (migration 037). Settings has offered
  this since the build began and it did nothing. It could not have used
  `PATCH /api/auth/staff/:id` either: that is rank 4, which is right for
  resetting somebody ELSE's PIN and wrong for your own, and `staff_write`
  requires rank ≥ 4 under RLS. So it is a SECURITY DEFINER pair, the same shape
  005 uses for sign-in: one row, `app.current_actor()`, no parameter naming a
  victim, and it verifies the current hash before writing. Hashing stays in the
  application; the database compares hashes and never sees a PIN. A wrong
  current PIN pays into the same two tiers every other wrong PIN pays into.
- **The password is not the till's to change.** It belongs to the account that
  owns the business, on a plane no outlet role can reach (011). The card says
  so and opens `/account`, where `POST /api/account/password` has always been.
- **The devices screen shows the outlet's roll.** It rendered seven hardcoded
  terminals belonging to outlet codes that exist on no real install, with
  invented pending counts and an invented version, while the real
  `chain.device` rows the bootstrap has always published went unread — on the
  screen a manager opens to find a lost tablet.
- **Version drift is measured.** Migration 036 adds `chain.device.app_version`,
  reported on every push (`x-app-version`), where the device already identifies
  itself. NULL is a real answer: a device that has not said is **not** behind.

Verified end to end against a live outlet: enrol → wrong code refused → claimed
→ code spent; sign a device out → its sessions die and other browsers are
untouched and it can sign back in; deregister → token refused AND keypad
refused; change a PIN → old refused, new works.

## How somebody finds out

The readiness audit's largest open item: this build had structured boot lines,
an audit trail, `/healthz` and a genuinely good `/readyz` — and no way at all
to LEARN that something had gone wrong. Nobody would discover a store had
stopped syncing except by the shop ringing up. `src/watch.js` is the answer,
and it is two different things.

**Counting is passive.** `/metrics` emits Prometheus text — process, request
counts by status CLASS (never by path: one series per outlet is how a scrape
melts), and the gauges the health probes already compute. No dependency: the
format is a handful of lines of string building. It is **guarded by
`METRICS_KEY` and a 404 until one is set**, because what it returns is the
shape of the install and an unguarded metrics endpoint is a reconnaissance
gift — the same doctrine as the platform door.

**Alerting is active, and it is the half that matters at 2 a.m.** Three
conditions, chosen because each is a fault nobody outside the shop would
otherwise see:

- **`/readyz` is not 200** — that probe checks out every outlet's own login
  role against its own schema, so a failure means no request for that outlet
  can be served;
- **a business is behind head or its migration failed** — that customer's till
  is talking to a schema the code does not expect, and `requireAtHead()`
  refuses its requests by name, silently as far as anyone else is concerned;
- **a writing device has gone quiet** — a signed-in till holding the only copy
  of an evening behind a dead link. `chain.device.last_push_at` has answered
  this for months with nobody watching. Printers and displays never push and
  are not counted, because a warning that fires on every printer in the shop
  is one nobody reads. **And a device that has never pushed is not a device
  that has stopped**: the predicate was `last_push_at IS NULL OR …`, whose NULL
  half fires the instant a till first signs in, so the only terminal on every
  brand-new store was reported quiet before anybody had rung anything. The
  clock starts from `coalesce(last_push_at, paired_at, last_seen)` — when the
  device began owing pushes — and the message says which of the two silences
  it is.

**An alert fires on a TRANSITION, never on a tick.** One message when a
condition goes bad, one when it clears, and a reminder only after
`ALERT_REPEAT_HOURS` (6) if it still holds. State is in memory and resets on a
restart, which is the correct failure — a fresh process re-evaluates.

Two things the first version got wrong, both the shape this file exists to
refuse. It **returned before logging** when no transport was configured, so an
install with no `ALERT_EMAIL` had a watchdog that saw the fault and told nobody
anywhere; the log is the channel of last resort and gets the whole body,
exactly as `src/email.js` writes a sign-in code to the trail where it could not
send it. And **recovery reused the alarm's own body**, so clearing read
"RECOVERED: 0 of 4 outlets cannot be reached" over "No request for these
outlets can be served" and an empty list — a message that states the opposite
of what happened, which sends somebody to check a shop that is fine.

The probes are **injected from `server.js`** rather than reimplemented, so an
alert can never disagree with the endpoint it is watching about the same fact.
Unconfigured, the boot log says so by name. `test/watch.test.js` pins all of
it: silence when healthy, fire once, no repeat inside the window, a repeat
after it, a true recovery, and the log-only path.

| Variable | Effect |
| --- | --- |
| `METRICS_KEY` | ≥16 chars. Unset, `/metrics` is a 404. |
| `ALERT_EMAIL` | Where alerts go. Falls back to `PLATFORM_ADMIN_EMAIL` — an install that named the person who runs it has named who to wake, and a second variable nobody set is a fence somebody believes in and does not have. Unset both, or a dangling `${{reference}}` (the third place that trap has been laid), and alerts are logged; the boot line says which variable it read, or which of the two states it is in. **Do not write `ALERT_EMAIL=${{PLATFORM_ADMIN_EMAIL}}`** — a platform resolves an unknown same-service reference to an EMPTY STRING rather than leaving the literal, so the copy silently vanishes and the watchdog boots off. Measured on the live install, twice. |
| `ALERT_WEBHOOK` | A URL that receives `{"text": "..."}` (Slack/Discord-compatible) beside every email and log line — never instead of them. A dangling `${{reference}}` is refused as an address. |
| `ALERT_REPEAT_HOURS` | Reminder interval while a condition holds (6). |
| `DEVICE_QUIET_MINUTES` | How long a writing device may go without delivering (60). |
| `WATCH_INTERVAL_SECONDS` | Sweep interval (60, floor 15). First sweep is delayed 20 s so a deploy does not alert on pools that have not opened. |

## A backup is bytes somewhere else, or it is a rehearsal

The app took none. `backup_run`, `backup_create` and `restore_run` were
audit-only ops that recorded the press and did nothing, and the Settings cards
said so out loud after an earlier pass found them claiming otherwise — an
archive list, a retention policy and a size, all literals, over a Restore
button that told the operator the tills would lock and then did nothing at all.

The platform's own volume snapshot is still the right tool for the CLUSTER and
should be on. What it cannot do is restore ONE customer: a snapshot is
all-or-nothing, so recovering a single shop from one rolls every other shop
back with it. The boundary of this product is the BUSINESS, and so is the
boundary of a copy.

**`pg_dump`, not something written here.** A dump has to survive every column
type, extension, default and constraint this schema has or will have.
Re-deriving that from the catalogs would be a second implementation of the one
tool the whole recovery story rests on, and it would drift silently the first
time a migration added a type it did not know. A backup that is subtly wrong is
worse than none, because it is trusted. The cost is a binary in the image that
must be **at least as new as the server** — pg_dump refuses a server newer than
itself — and nothing assumes it: `tools()` finds it, reads its version,
compares it to `SHOW server_version_num`, and refuses BY NAME with the remedy.
An image whose Alpine package name goes stale says so on the Backup card rather
than handing anybody a green tick over nothing.

**One seam, two drivers**, the shape `src/email.js` already has: `file` for a
mounted volume, `s3` for any S3-compatible bucket — signed with node's own
crypto, so the two-runtime-dependency rule holds. **Unconfigured, there is no
destination and it says so** at boot, in `npm run backup -- --check`, and on
the Settings card. A dump written to a container's ephemeral disk and lost on
the next deploy is not a backup, it is a rehearsal.

**To disk first, then to the destination.** Piping pg_dump straight into an
upload either holds the whole archive in memory or leaves a half-written object
when the dump fails on its last table, and neither is a thing to discover
during a restore. The temp file is bounded by disk, deleted in a `finally`, and
the sha256 is computed from the bytes that were actually written rather than
from the ones that were meant to be.

**`chain.backup` is in the REGISTRY** (control/004), for the reason the account
plane is: a business's own record of its backups lives inside the database
those backups exist to replace, and the one moment you need to read it is the
moment it is gone. It also spans businesses, and "which customers did last
night's run miss" is not a question any single business database can answer.

**A failed run is a row**, and it is the row that matters most. A shelf showing
only successes reads as "backed up nightly" on an install whose last four
nights failed. Both states are written and the watchdog reads `ok`.

### Beside by default, never over by accident

A restore into the live database destroys everything rung since the archive,
and it is the single most destructive act this system can perform. So
`npm run restore -- --db <name>` restores into a NEW database and re-applies
the outlet roles; the live one keeps trading while somebody checks the copy
holds what they think it holds. Pointing the business at it is a separate act
(`--adopt <businessId> --into <db>`), it renames rather than drops — the
database that was live an instant ago is the only copy of anything rung since
the archive — and it lands on the trail as `business_db_swapped`. Going
straight over needs `--into <db> --over`, both spelled out.

**The archive is verified before it is trusted.** A truncated upload restores
most of a database and reports success on the part that arrived, which is the
worst failure available here: the shape looks right and the tail of the trading
history is missing. sha256 against the manifest, before anything is created.

**And the roles are not in the dump.** This is the finding the original restore
drill produced and the one that makes an otherwise perfect restore useless: a
`pg_dump` of one database carries no cluster-wide roles, so into a fresh
cluster `pg_restore` drops every GRANT on the floor and the install answers
`/readyz` 200 while every outlet request fails with `role "outlet_1_app" does
not exist`. The archive is written `--no-owner --no-privileges` precisely so
the restore does not depend on them, and `chain.provision_outlet()` re-applies
them afterwards as part of the restore.

**There is still no button.** The rule `test/wiring.test.js` pins did not
soften when the feature became real — it sharpened. The record lives in the
registry, which an outlet login role is refused at the door of, so the till
cannot read whether a copy landed and still may not say. What the Backup card
says now is what is true of the install and where the answer actually is; it
prints no date, because it has no way to read one and inventing one would be
the old defect wearing the opposite claim.

### Watched, or it is the same defect one level up

A backup system nobody watches is an install believing it is protected because
something is scheduled — silent by construction, since nothing goes wrong on
the night a dump fails, only on the day somebody needs it. The watchdog's
fourth condition fires when a configured destination stops receiving copies,
names how stale, where they were meant to land, how many recent runs failed and
in whose words, and gives `npm run backup -- --check` as the remedy. `/metrics`
carries `kpos_backup_age_hours`, **-1 for never** — 0 hours old is the
healthiest possible answer, so it cannot also mean "never".

An install with NO destination is deliberately never alerted: that is a stated
choice, the boot line and the card both say it, and paging somebody every six
hours about their own decision is how an alert channel gets muted.

| Variable | Effect |
| --- | --- |
| `BACKUP_DIR` | A mounted path. The `file` driver. |
| `BACKUP_S3_BUCKET` + `_KEY` `_SECRET` `_REGION` `_ENDPOINT` `_PREFIX` | Any S3-compatible store — a Railway bucket, R2, B2, MinIO, AWS. Endpoint empty for AWS. A bucket with no key is refused by name rather than half-configured. |
| `BACKUP_S3_PATH_STYLE` | How the bucket is spelled into the URL, and it is **not cosmetic**: `host` is a signed header, so the wrong style fails every upload. Virtual-hosted (`<bucket>.<endpoint>`) is the default and the S3 standard — a Railway bucket, R2 and AWS all serve it. `1` switches to path-style (`<endpoint>/<bucket>`) for MinIO and for a Railway bucket issued before that change. Neither is derivable from the endpoint, since both are a bare host, so this is a named opt-in rather than a guess that fails on somebody's first real backup. This file used to assert the opposite. |
| `BACKUP_EVERY_HOURS` | Schedule interval (24). 0 turns the schedule off and leaves the CLI working. |
| `BACKUP_RETAIN_DAYS` | 30. A database's newest good copy is never removed by age, however old. |
| `BACKUP_STALE_HOURS` | When the watchdog says so (default: twice the interval). |
| `PG_BIN_DIR` | Where pg_dump lives, if not on PATH. |

`test/backup.test.js` runs the whole drill every CI run — trade, archive, **DROP
the database**, restore, and compare every figure — plus the SigV4 signer
against AWS's published test vector. **The S3 driver's live round trip is not
verified**: there is no bucket in CI to fail against, so the first real upload
is the first proof that a bucket's credentials, endpoint and permissions are
right. DEPLOYMENT.md says so rather than letting a green suite imply otherwise.

## A role is cluster-wide, and an advisory lock is not

`chain.provision_outlet()` creates and alters a LOGIN ROLE. A role lives in
`pg_authid`, which every database on the cluster shares — so two callers
provisioning from two different business databases touch the same catalog rows
and Postgres answers the loser **`tuple concurrently updated`**. Measured on
this suite: **two runs in five**, always inside `reprovision()`, which is the
RESTORE path — so it fired in the one piece of code somebody runs after losing
a database, which is the worst place for an intermittent failure to live.

`src/scripts/migrate.js` had already met this for `kashikeyo_report` and removed
the race by doing that role ONCE before any worker starts. `provision_outlet`
cannot be done once: it is called per outlet, from the fleet migration, from a
restore, from `provision:outlet --all`, and from a customer creating a second
store — concurrently, by construction. So the race is SERIALISED instead.

**The scope is the fix.** `pg_advisory_xact_lock` is scoped to the database the
session is connected to, so two callers take the same key in two different
databases and do not conflict at all. `withRoleLock()` in `src/db.js` takes it
in the MAINTENANCE database (`PG_MAINT_DB`, default `postgres`), which every
caller on the cluster can reach and none of them owns.

**Not the registry**, which was the first answer here and is wrong for exactly
the reason `dbPrefix()` exists: a cluster may host more than one estate, and two
estates have two registries. Locking in one of them serialises that estate and
leaves the other free to collide on the same `pg_authid` row.

**On a connection of its own**, not one of the pools the app trades on: a mutex
held for the length of a provision has no business inside a pool a till is
queueing for, and a long-lived pool to the maintenance database is one more
thing for shutdown and for a test that drops databases to trip over.

**And a lock is not enough on its own.** During a rolling deploy the old
container is still serving and holds no lock at all, so the DDL is also retried
when a peer got there first — the same forgiveness the migration runner already
extends to `kashikeyo_report`. Both statements are idempotent by construction
(the password is derived, so two writers write the same value), which is what
makes retrying correct rather than hopeful. Anything that is not a peer
collision is reported, not swallowed.

`test/migrate.test.js` asserts the scope (the lock is held in the maintenance
database), the exclusion (two holders started together never overlap), the
retry, and that an ordinary fault still surfaces. Six full suite runs after the
fix: zero. The test deliberately creates no databases of its own — an earlier
version did, and creating and dropping them beside five suites that are mid-run
disturbed those instead, which is trading one intermittent failure for another.

## History has a horizon, the trail does not

`chain.prune_history(op_days, guest_days)` (migration 025), called at boot and
daily from `server.js`. `op_log` is a replay window, not an archive — its
consequences live on in the rows each op wrote — and `guest_request` is a
floor board. Defaults 90 and 30 days (`RETAIN_OP_LOG_DAYS` /
`RETAIN_GUEST_REQUEST_DAYS`; 0 disables; floors of 30/7 are enforced in the
function, because a window short enough to eat live replays is a typo, not a
policy). **`chain.audit` is never pruned** — the trail is kept, not trimmed,
and archival if ever wanted is an export, not a DELETE. Owner-only EXECUTE, so
a compromised till cannot shred its own history; each prune that removed
anything is itself on the trail (`history_pruned`).

The terminal's persisted session has a **quota ladder** (`writeSession`):
settled history is capped at 800 rows in the primary write (an offline cache —
the server refills `settled` wholesale on every bootstrap), and on
QuotaExceeded it sheds history in two more rungs before persisting only live
state: open tickets, the unreplayed outbox, session, register. History is shed
before live state, never live state at all, and hitting the ladder registers a
fault.

## Printing is bytes on paper, or a spool that says so

`app/kashikeyo-escpos.js` composes ESC/POS — loaded by the browser and the
server like `kashikeyo-rules.js`, so both paths print byte-identical dockets.
ASCII only for now: outside 0x20–0x7E prints `?` (thermal printers speak code
pages, not UTF-8; Thaana cannot print yet and the screen stays the reference).
`test/print.test.js` asserts the bytes as bytes.

**Per printer, per terminal**, the transport is one of (`prefs().printConn`):

- `usb` / `serial` — the printer cabled to THIS till, over WebUSB/Web Serial
  (Chrome/Edge). Connecting is a browser permission prompt and only works in a
  user gesture, which is why the printers screen has the button and nothing
  prompts on its own; the grant survives reload and is reattached lazily.
- `net` — an Ethernet printer. The till cannot open a socket, so the SERVER
  relays to port 9100 (`POST /api/outlet/:id/print`) — only real when the
  server shares the printer's LAN. The relay is an SSRF primitive if left
  open, so the fence is explicit: port 9100 not negotiable, and the resolved
  ADDRESS must not be loopback or link-local (169.254.x is every cloud's
  metadata service). Private LAN ranges stay open — that is where printers
  live. `PRINT_ALLOW_LOOPBACK=1` opens loopback outside production, for tests.
- `spool` — the default. **No transport means state `spooled`, never `done`**:
  the old runJob marked every job printed on a 620ms timer, which is a claimed
  print no printer made.

**The drawer plugs into the receipt printer's RJ11, so opening it is a print**
(`ESC p`). Only a CASH receipt kicks it — a card receipt popping the drawer is
how cash walks. KOT dockets carry their station's lines in double-size type;
the bill, receipt and Z-report carry their real rows.

## The pages carry a Content-Security-Policy

Built in `server.js` from the files on disk: everything is `'self'` — local
scripts, local fonts, no CDN — and the two front doors' inline scripts
(`onboarding.html`, `account.html`; the theme snippet must run before first
paint) are allowlisted **by hash**, recomputed at boot (every 2s in
development), so editing a page moves the hash rather than requiring
`'unsafe-inline'`. `'unsafe-eval'` stays: the DC runtime compiles templates
with `new Function`. If you add an inline `<script>` to a page it is covered
automatically at the next boot; a CDN reference will be refused by design.

Also in `src/db.js`: every pool is `guarded()` — a pg pool EMITS `'error'`
when an idle connection dies under it (a Postgres restart, a failover), and
an unhandled `'error'` event kills the process. The guard logs and lets the
pool replace the corpse; `test/api.test.js` kills the pools' idle connections
mid-suite to prove the process survives.

## The product is sold one install per customer

Each customer gets their own app service and their own database — that is what
keeps every isolation guarantee in this file true per-customer by construction,
and it is the fence against the staging-into-production replay class: separate
databases, separate secrets, separate install uuids.

**The platform door** (`src/routes/platform.js`): `GET /api/platform/summary`,
guarded by `PLATFORM_KEY` (≥32 chars, constant-time compare). Unset, the door
is a 404 — an install that was never sold has no platform. It answers
AGGREGATES ONLY — company name, outlets, fourteen days of takings through the
report role, device staleness — never members, staff, or line items; the test
pins the exact response shape so nothing can ride in later. Every read lands
on the audit trail as `platform_read`.

**Mission Control** (`panel/`) is the seller's panel: a SEPARATE service
(`node panel/server.js`). Admin sign-in is scrypt + HMAC tokens, first-run
gated on `PANEL_SETUP_TOKEN`, the sign-in door rate-limited through
`src/limit.js`.

**It reads the REGISTRY now, and that is a change of premise rather than of
plumbing.** The panel was built for a product sold one install per customer:
the seller could reach neither the customer's app nor their database, so
everything arrived over HTTPS from each install's own
`/api/platform/summary` with a per-install `PLATFORM_KEY`. That premise is
gone — one app, one cluster, a database per business, and the panel beside
them. `chain.business` IS the customer list, and `panel/registry.js` reads it
and each business's own database directly. Probing over HTTP for figures one
query away was a control describing a world that no longer exists.

**The licence is ONE copy.** The old design kept the seller's registry
authoritative and pushed a copy to the install, reconciled on every dashboard
load — necessary only because they were two databases the seller could not
both reach. `chain.licence` in the business's own database is the record now,
written directly through the owner connection (no outlet role has INSERT or
UPDATE on it, migration 033), and there is nothing left to drift.

**The per-customer Railway provisioning is off by default.** Building a whole
project per customer is what the restructure exists to replace, and a button
that creates an install the registry has never heard of — one that cannot
sign a customer up, because signing up is what creates a business — is a
control that does the wrong thing confidently. `PANEL_DEDICATED_INSTALLS=1`
turns it back on for a seller who still sells installs on separate
infrastructure; off, every one of those doors **refuses by name** rather than
404ing, and the page does not draw the button at all. The page's vocabulary
follows the mode: a row is a *business* beside a registry and an *install* on
a dedicated deployment, because calling both "install" is how a screen ends
up describing the wrong world.

`src/routes/platform.js` went the same way: it answers about the database
this process dialled, which is right exactly when that database is itself a
business. `selfIsBusiness()` in `src/db.js` is the one definition of that
question, and the door now says so rather than serving the empty figures of a
database nobody trades in. The page (`panel/panel.html` + `panel.js`) is vanilla DOM through a
textContent-only builder (a customer's install name must not script the
seller's panel), wearing the terminal's tokens and fonts. Statuses are icon
AND label; trials carry their deadline; an unreachable install says why.
Trial enforcement is a person's decision, not automated — the panel monitors.

### The panel is the developer's, so it reads system data and never trade

The first cut of the outlet-wise report carried the businesses' MONEY — net,
bills, covers, average ticket — and that was the wrong report for this panel
to hold: a customer's takings are reported by their own back office to the
people entitled to read them, and an operator's panel has no business reading
a till. Every sales figure is gone from Mission Control — there is
deliberately no money formatter left in `panel.js`, and the panel test walks
the whole system report asserting no trade field (`net`, `total`, `covers`,
`avgTicket`, `tickets`, `currency`) ever appears in it.

What a developer actually needs is what replaced it. The overview leads with
**the app's own `/readyz`**, probed with its latency on every load (a failure
carries the endpoint's own body, which names the failing outlet and the
remedy). Each business card carries **sync-op traffic** (today's count and a
14-day sparkline out of `op_log` — every till write goes through that one
seam, so ops-per-day is the honest measure of how hard a business uses the
system, bucketed on the outlet's own clock), **live sessions**, **database
size**, device sync health, schema state and the backup shelf. **System** on
a live business opens the drill-in: per outlet, ops over 24h/7d/30d, QR-portal
orders over 24h/30d, a 30-day daily series, devices and last push; per
business, database size and live sessions. `?format=csv` hands the daily
traffic series back one row per outlet per day. Every read still lands on the
business's own trail as `platform_read` — a developer looking in is never
invisible either.

**Registry mode's Edit is the LICENCE sheet**, not the dedicated-install form
it used to open — base URL, platform key and setup code are fields that mean
nothing for a business whose database this panel opens directly, and they
stood around the four that do: kind, trial end, extending it (+7/+14/+30,
server-side "from today or where it stood, whichever is later"), and the note
the customer reads on their own Settings screen. The card also carries the two
fleet facts the registry can answer and one business cannot: **the backup
shelf** (`chain.backup` in the registry — last good copy and its age, a FAILED
last run named; no rows at all reads as fact, not alarm, because an install
with no destination is a stated choice) and **schema state** (version against
head, "behind head" as a warning, because a business behind head is one whose
requests `requireAtHead()` is refusing).

**And the card's fourteen days used to cost fourteen queries each.** `takings()`
asked each outlet one question per day, so a dashboard over this dev cluster's
63 businesses took 19 seconds to load; the database groups by day in one pass
now — one query per outlet — and the same load measures 0.2 s. The usage
report was written on the grouped shape from the start. `test/panel.test.js`
drives the whole road: a provisioned outlet, a rung bill, a paired till and a
shelf row, read back through `usage()`, over HTTP, and as CSV — and the drive
in Chromium proves an extension lands in the business's own `chain.licence`.

### The panel's own door is hardened, and its health has a memory

Compared against the operator panels behind comparable multi-tenant products,
Mission Control's two real deficits were its own front door — one password
between the internet and every licence and provision button — and a health
probe that was point-in-time: right during an incident, useless the morning
after. Both are closed, inside the two-runtime-dependency rule:

- **TOTP two-factor** (RFC 6238 over node's own crypto — thirty lines beat a
  dependency). Enrolment is TWO steps on purpose: the secret sits in
  `totp_pending` until a code from the authenticator proves it was actually
  scanned, because enabling 2FA on an unscanned secret locks the only admin
  out of their own panel. The otpauth secret is drawn as a real scannable QR
  by `app/kashikeyo-qr.js` — the app's own jsQR-verified encoder, served to
  the panel page. Turning it off requires a current code: a signed-in tab
  alone must not be able to strip the second factor. Codes allow one 30-second
  step of drift and every compare is `timingSafeEqual`; guesses ride the same
  doorman as passwords.
- **A second admin** (added by a signed-in admin; the two removals that end in
  a locked panel — yourself, and the last admin standing — are refused by
  name) and **sign out everywhere**: every token is signed under the admin's
  `token_epoch`, the check costs one indexed read per request, and bumping the
  epoch orphans every token signed before it — a stolen one included. The
  answer carries a fresh token so the session doing the signing-out survives.
- **The pulse** (`panel.pulse` / `panel.event`): one `/readyz` probe a minute,
  written down, 14 days kept. Uptime on the App tile is COMPUTED from the
  rows — measured, never asserted, and "no pulse history yet" is said rather
  than shown as a suspicious 100%. A TRANSITION (up→down, down→up) is an
  event on a timeline the dashboard renders; steady states are not, and a
  fresh process re-observes before it says anything changed. The first sweep
  is delayed 15 s so a deploy does not stamp its own boot window as an outage.
- **`ALERT_WEBHOOK`** on the app's watchdog (`src/watch.js`): a URL that
  receives `{"text": "..."}` — the shape Slack, Discord and most chat
  webhooks accept — fired beside the email and the log, never instead of
  them. A failure to deliver is logged and never fails the alert; a dangling
  `${{reference}}` is refused as an address, the same trap `ALERT_EMAIL`
  already refuses.

`test/panel.test.js` proves the whole ladder (a pending secret gates nothing;
wrong codes refused at confirm, sign-in and disable; the second admin; both
lock-out removals refused; the old token dead and the fresh one alive after
the epoch bump; three pulse sweeps yielding exactly the two transition events
and a measured uptime under 100%); `test/watch.test.js` catches the webhook
payload on a real local listener. The Chromium drive enrols 2FA through the
shipped sheet, QR and all.

### One stop: the platform's logs are a tab, and the page fits every screen

The dashboard is two views under one bar — **Overview** and **Logs** — because
the tab a developer otherwise keeps open beside this panel is Railway's own
deploy log. The panel runs ON Railway next to the services it watches, so the
platform injects its own project and environment ids; with the API token the
provisioner already holds, `panel/railway.js` lists the environment's services
and reads each latest deployment's log over the same GraphQL transport
(`logServices` / `deploymentLogs` — read-only, nothing here mutates anything).
The Logs view is one chip per service with its deploy status as a coloured
pip, the log underneath severity-coloured with a client-side line filter, and
it is honest when it cannot: no `RAILWAY_API_TOKEN`, or a panel not running on
Railway, refuses BY NAME rather than showing an empty pane somebody debugs.
Admin-gated like everything else; the live Railway call path is exercised in
`test/panel.test.js` against a local stub speaking the same GraphQL shapes —
composition and decision, never connectivity, the provisioning tests' rule.

The Overview gained the two things a fleet page needs at 63 businesses: a
**search box and status filter chips** (All · Needs attention · Live ·
Archived — "needs attention" is one predicate shared by the chip and the
sort: unreachable, behind schema head, or a failed last backup, and whatever
matches floats to the top). The filter bar lives OUTSIDE the repainted body,
so typing survives the 60-second refresh with focus and text intact — a
rebuilt input under a typing hand is the sort of defect a feature test never
sees. Archived businesses are hidden unless asked for.

And the page fits the screen it is read on, because a developer checks it
from wherever the alert found them: the top bar wraps, the tabs stretch
full-width on a phone, the KPI tiles and cards collapse to narrow columns,
the sheets keep their bottom-edge rise, and the Chromium drive asserts no
sideways scroll at 390 and 768 px.

### Provisioning is one button, and it never handles the password

Standing a store up was six manual acts before the panel was even opened —
create a service, create a database, generate three secrets and two keys, set
nine variables, point a domain — and then two of those values were typed BACK
into Mission Control by hand, where nothing compared them with what was
actually set. A secret typed twice is a secret that diverges, and the only
symptom is a customer refused at step one holding a code the panel swears is
right.

`panel/railway.js` does it instead, over Railway's GraphQL API with the
platform's built-in `fetch` — so the two-runtime-dependency rule survives. Set
`RAILWAY_API_TOKEN` and `INSTALL_REPO` on the panel and **Provision** creates
the project, the Postgres and its disk, the app service, its address and its
`/readyz` health check, mints every secret, waits for the first deploy, then
records the install and emails the customer. Unset, the automated path is OFF
and the panel names the missing variable rather than greying out a control for
an unstated reason; the manual sheet stays the whole feature underneath,
because an install built on somebody else's infrastructure has to stay
registrable.

Four properties, and each is the answer to a way this class of automation
usually goes wrong:

- **The token never reaches a browser.** It can create and destroy
  infrastructure, so it is held exactly like `PLATFORM_KEY` already is —
  server-side, never rendered, never in a response.
- **The database password is minted and never read back.** The app's
  `DATABASE_URL` is the reference `${{Postgres.DATABASE_URL}}`, resolved by
  Railway at deploy time, so the app's own configuration holds no credential.
  This was going to be "never handled at all" — the first version assumed
  Railway's Postgres image publishes `DATABASE_URL` by itself. **It does not**,
  and a throwaway rehearsal against the real API is what found that: a service
  created bare from `ghcr.io/railwayapp-templates/postgres-ssl:18` comes up with
  only Railway's own `RAILWAY_*` variables. `DATABASE_URL`, `POSTGRES_USER`,
  `POSTGRES_PASSWORD` and `PGDATA` all come from the TEMPLATE. Every run would
  have polled three minutes at step four and failed, and no stubbed suite could
  have found it. `pgVariables()` is the template's own wiring now, with `PGDATA`
  a SUBDIRECTORY of the mount — initdb refuses a data directory that is not
  empty, and a mounted volume already has a `lost+found`.
- **Progress is recorded BEFORE it is made.** Every step writes the install row
  first, so a panel that dies mid-run leaves a row saying how far it got and
  every id it created. The expensive failure here is not an error, it is an
  orphan: a service nobody knows about bills quietly for months, where a
  half-finished row is on the dashboard within thirty seconds.
- **A partial run is named, never rounded up.** The row carries which step
  failed, in the outlet's own words, and what exists. Rollback deletes only a
  project THAT RUN created, and only when a person asked — deleting a
  pre-existing project because our own later step failed is how automation
  earns its reputation.
- **The database is up before the app that dials it exists.** The second live
  run failed here, and the first passed only by luck. Once the wiring moved to
  creation, the step called "checking the database is addressable" was reading
  `DATABASE_URL` back off the database service — a variable this module had set
  four seconds earlier. It passed on the first ask, always, by construction:
  the label made a claim the check could not make, which is the same defect
  class as a control that lies. What has to be true is that
  `postgres.railway.internal` RESOLVES, and that happens when the database's own
  deployment goes live, so the DEPLOYMENT is what is waited for — a fact the
  platform owns rather than one we wrote. The first install survived because its
  app image had to be built from source and the build outlasted the database's
  start; the second found a warm build cache, started three seconds early,
  crash-looped four times on `ENOTFOUND` and had given up before the database
  was ready. A race whose outcome the build cache decides is not a race to leave
  in.

`test/provision.test.js` drives all of it against a stubbed transport: the
order (the database exists before the app that references it), the payloads
(the app is created WITH its secrets, because it refuses to migrate without
them and would look like a provisioning bug), `PUBLIC_URL` set only after the
domain exists, the wait for the database's own deployment to go live, a
GraphQL refusal answered 200 being an error rather than a success, and every
rollback branch. That proves composition and decision — never connectivity.
**The live call path is unverified until it is run once**, and DEPLOYMENT.md
says so rather than letting a green suite imply otherwise.

**What a panel HOLDS is not always what it can PASS ON.** Both mail variables
were read with a bare truthiness check, and a Railway variable may be written
as a reference to another service — `${{kashikeyopos.RESEND_API_KEY}}`. Where
the name inside the braces is right, the reference is substituted before the
panel's process sees it and a real key is copied forward. Where it is WRONG the
literal survives: non-empty, truthy, no warning from `ready()`, and copied
verbatim into a brand-new project whose only services are a database and the
app. It can never resolve there. The install comes up believing it has email,
answers every send with the honest "not configured" fallback, and the customer
sits on Check your email with a variable on the service that looks perfectly
correct — so whoever debugs it checks the key instead of the braces. The rule
that governs a send now governs a handover, imported from `src/email.js` rather
than re-spelled, because two definitions of "this is a dangling reference"
would eventually disagree. A value that cannot work THERE is not passed on: no
transport at all is a state the install describes accurately, and a dangling
one is a state it cannot.

### A trial the customer can see, and only the seller can move

The commercial state of a customer used to live ONLY in the seller's registry
(`panel.install`), on a screen the customer cannot open. So a trial ending was
an event that happened somewhere else, and the first they heard of it was a
phone call.

**The flow is: the seller provisions, the customer does everything else.** A
store request on the website lands in Mission Control; **Provision** creates
the install, links the request, and **emails the customer their address and
setup code in the same act** — the message deliberately carries no password,
because they set their own on their own install's `/account`. From there they
run the onboarding steps themselves and land on a live trial. A form
anybody on the internet can post still never spins up paid infrastructure;
what changed is that everything after the seller's one click is self-serve.

**`chain.licence` (migration 033) is a plane of its own**, and that is the
whole design. It is not a row in `chain.setting`, which any rank-4 admin can
write — a licence a customer can edit is a text field, not a licence. So:
SELECT is granted with a read policy, because the till has to render the
countdown; INSERT and UPDATE are granted to **no outlet role at all**. The only
writer is the owner connection, reached through the platform door. That is the
same "protection by absence of grant" belt migration 011 uses for the account
plane, and `test/api.test.js` asserts an outlet role's four attempts on it all
fail.

**The registry is authoritative and the install holds a copy.** Mission Control
pushes it — `POST /api/platform/licence`, same key, same constant-time compare,
same trail as the read — whenever the two disagree, on the same probe every
dashboard load already makes. That makes it **self-healing** rather than
scheduled: a push that fails is retried by the next load, and an install
restored from a backup is corrected the first time anybody looks. It is
idempotent by design — the install writes its trail only when something moved —
so reconciling on every load costs a request and never a row. An install whose
seller is unreachable keeps working and keeps saying the last true thing it was
told, which is what a cached copy does and a live check does not.

**Nothing here ever blocks a sale.** A restaurant mid-service is not where a
licence check gets to stop a cashier, and a customer who has not paid an
invoice yet has not stopped being a customer. The till warns **twice** before
the deadline (at seven days and at two) and carries a standing notice after it,
owner-only, each offering the one action the customer can take. `NULL` is a
real answer: an install nobody has sold shows nothing at all rather than a
countdown somebody invented, and a trial with no end date is on trial with
nothing to count down to.

**Asking for a plan grants nothing.** `plan_request` records who asked, when
and for what, in `chain.setting` (so the till can read it back and say "you
asked on the 3rd") and on the trail (so every ask survives, not just the
latest). The platform summary carries it, so the seller sees the request
without the install ever reaching out. There is no online payment in this
build and the form does not pretend there is.

Two things a date got wrong, both found by driving the whole flow rather than
by reading it. The panel had no `setTypeParser(1082)`, so a Postgres `date`
arrived as a JS Date and `String(d).slice(0, 10)` yielded `"Tue Sep 08"` — the
install refused the push, correctly, as not a date. And `daysUntil()` measured
to the end of the last day and rounded up, so a trial the customer's own till
called "2 days left" the seller's panel called three: the same trial, two
answers, on the two screens most likely to be open during the conversation
about it.

**The website** (`site/`) is the third service from the same image
(`node site/server.js`): landing, docs, legal, and the signup. A signup is a
STORE REQUEST — it writes `panel.signup` in the registry (advisory-locked
DDL, since both services boot against one database and concurrent
`CREATE IF NOT EXISTS` races Postgres's catalogs), rate-limited through
`src/limit.js`, one open request per address with byte-identical answers.
It does NOT provision: a form anybody can post must not spin up paid
infrastructure, so requests land on Mission Control, where **Provision**
pre-fills the install sheet (trial pre-set to 14 days) and links the request
to the install it became. The customer's credentials are never taken by the
website — they set their own on their own install's `/account`.

## Reachable, and measured rather than judged

Two accessibility properties are computable, so they are computed in a real
browser against the shipped pages — `test/a11y.test.js`, no axe, because this
repo ships two runtime dependencies and no dev ones.

**Contrast.** Every visible run of text against the background it is really
drawn on, walked up the ancestors. The walk stops at the first ancestor that
PAINTS — and a gradient paints exactly as opaquely as a colour does, which is
the trap: `/account`'s panel is a dark gradient with a transparent
`background-color`, so a naive walk fell through it to the light `body` and
reported near-white text at 1.08:1. Opaque gradient stops are collected and the
text is judged against the worst of them, which is a conservative bound rather
than a simulation.

What that measurement then found was real, and none of it was reachable by
reading the code: the two phone apps carried a muted ink ramp — `#8a8a8f`,
`#a8a8ad`, `#b0b0b5`, `#9c9ca1`, `#b6b6bb`, the `::placeholder` — sitting on
white sheets at **3.44:1 down to 1.89:1**. Every one of them is copy a guest
has to read: the table number, the tip note, the receipt lines, the reason
their code was refused. The ramp is now `#62626a` · `#6a6a72` · `#6e6e77`,
which clears AA on both the white sheets and the `#f5f5f6` cards and keeps
three perceptible steps. **AA on white simply does not permit light greys** —
if a step wants to be lighter, the surface under it has to get darker.

**The keyboard.** Tabbing must move focus, land on something visible, and never
trap. `button:focus-visible` had a ring; nothing else did, because every input,
select and textarea carries `outline:none` in its inline style and an inline
declaration beats a plain stylesheet rule. So tabbing into the top-bar search
put a keyboard user on a control they could not see. One `!important` rule
reaches past 22 inline styles without editing 22 inline styles, drawn inside
the field because a field sits in a bordered pill with no room outside it. The
two phone apps had no focus rule at all and now carry the same one in their own
accent.

The check itself is stricter than it started: the first version counted **any**
`box-shadow` as a focus ring, which passed every button in the app on the
strength of its decorative drop shadow. A shadow that is there whether focus is
or not indicates nothing. It now requires an outline AND `:focus-visible`.

`test/wiring.test.js` pins the rule statically as well, because the browser
measurement skips clean where there is no browser — which is most CI runs — and
a deleted focus block takes the keyboard's only cue with it silently.

**Still open, and stated as open:** the browser sweep visits each app's landing
state and every rail screen; it does not open every modal, sheet and form, and
no screen reader has been driven over any of it. `site/` and `panel/` are
separate services on their own ports and are not in this suite.

## The copy sweep, and the four things it found under the copy

The eleven lying controls were found BY ACCIDENT — by opening a screen and
reading it — and the finding rate had not dropped, which is the argument for
doing it systematically instead. Every user-visible string of 25 characters or
more was extracted from `app/index.html`, the ones asserting something checkable
were classified by what they claim (enforced · server-side · persisted · sent ·
acted · automatic · a figure), and each class was asked of a live database or of
the source that would have to keep the promise.

Most of what came back was stale vocabulary from the app that was deleted, and
it is now refused statically. But four were behaviour, and each was invisible
from the screen it broke.

**A grant wrote the wrong ladder.** There are two rank tables in the terminal
and the comment above them explains, correctly, why: `RANKMAP` is the CAPABILITY
ladder (what this rank may do) and `ROLERANK` is SENIORITY (who may act on
whom), and the seniority one must stay strictly ordered where the capability one
groups roles together. What nobody noticed is that Users & Roles sent the
SENIORITY number as `chain.staff.rank` — and there a Cashier sits at 1, because
a cashier is the most junior person on the floor. So a cashier created on that
screen landed at rank 1, which is **Kitchen**, and was refused from the Till rung
the job is made of: `/sales` and the member invitation both 403 "Rank 2 required
— Till or above". A kitchen account came out at rank 2 and could do both. Proved
end to end against a live outlet, before and after.

The capability table was also its own opinion, disagreeing with `src/auth.js` on
four of eight keys. It is the server's ladder now, key for key, and
`test/handle.test.js` asserts that against `ROLE_KEY_BY_RANK` rather than against
a copy of it. Seniority is unchanged and stays the terminal's alone: it answers a
question the server never asks.

**A refused write was deleted by the control that said it had won.** Nothing in
this build detects a write-write conflict: the server applies a batch in the
operator's own order and answers a refusal with a REASON. `state.conflicts` was
fed from those refusals, and a "Replay conflict" screen then told the operator a
story about them — that another terminal had written the same order line first,
with a clock value, a quantity and a time that were **literals**, identical on
every install and every refusal, printed beside their own write as the thing it
lost to. Then "Keep mine" marked the outbox row `sent`, re-pushed NOTHING, and
toasted "local write replayed over the server copy". A refused sale, payment or
credit charge, gone, under a green toast.

The lane that works was already here for the eighth refusal — `parkedActions()`,
which names the outlet's own reason and offers the two decisions that are real:
back into the replay with a fresh allowance, or out of the outbox with an
`op_discarded` audit op naming what was given up. A refusal runs from the first
one now, and `refusedOps()` is the one derivation of what was refused.

**An outlet's own prices had never reached a till.** Two shapes with nothing
between them. The bootstrap publishes this outlet's overrides keyed by ITEM —
`{ "d1": { price, why, at, by } }` — because a bootstrap is one outlet's, so
there is nothing else to key them by. The terminal keys them by OUTLET and then
by item, holding a bare number. `applyLive` assigned one straight onto the other,
so `state.priceOv[outletId]` was whatever row happened to sit under a key shaped
like an outlet id, and `priceOv()` came back `undefined` for every dish.

Both halves cost money: a price set on another till never arrived here, and the
assignment replaced this terminal's own map wholesale, so a price set on THIS
device reverted at the next poll — the op had reached the outlet, so the decision
survived, but the figure being charged did not. Verified against a live outlet
with `price_override` at 99.00 against a menu price of 145.00, and pinned in
`test/api.test.js` by feeding a real override row and this outlet's real
bootstrap to the SHIPPED terminal in a vm and asking what it would charge.
`foldPriceOv()` is the one shape now, and the outlet's answer wins — the same
holding-pen rule a measured yield and a saved batch already follow.

**Switching outlet showed the other outlet's name over this one's data.** A
session names ONE outlet: the token carries it, the API client puts it in every
path, and the server refuses any other with `outlet mismatch`. `goOutlet()`
changed `state.outletId` and nothing else, so every header, fascia and label
repainted with outlet B while the menu, the tickets and the takings stayed
outlet A's — worse than a refusal, because nothing on screen said so. There is no
endpoint that moves a session (`/api/auth/switch` is a hand-over at the same
outlet), so the way through is named: sign out, sign in there.

The role catalogue was the same defect one level up. It carried `scope:
"platform"` and `scope: "chain"` — a platform above the install and a chain of
them — and `scopedOutlets()` reads that field, so "anything but outlet" quietly
handed three roles every outlet in the switcher. Scope is `outlet` or `group`
now, the two values `src/auth.js` honours, and only the owner holds `group`,
because rank 5 is the only rank the estate read is granted to.

And the smaller ones, each the same shape:

- **"Schedule email"** on Reports described a pack "delivered 06:00 local to the
  outlet manager" and scheduling "set per report and per recipient", in the
  present tense. There is no scheduler (the one repeating job in `server.js` is
  `prune_history`), no recipient anywhere, and nothing that renders a pack to a
  message. The cadence column is what each report is worth READING at, and it
  says so; the export beside it is the delivery.
- **"device_id is bound into the token, so a ticket can only be inserted by the
  device that signed it"** — nothing enforces that. The outlet schema has no RLS
  and no insert anywhere is gated on the device. What `device_id` buys is
  ATTRIBUTION: it is stamped on the ticket, the sale, the payment and the trail.
  The revocation half of that sentence was true and stays.
- **"the chain price is untouched"** — there is no chain price. There is the menu
  price and this outlet's override on top of it.
- **"Only a role with edit rights on this module can change another person's
  role — Chain Admin and Super Admin"** — the gate is rank 4, and the server
  reads the rank, not the role name.

`test/wiring.test.js` pins the vocabulary statically across all five app pages
and both shared modules, so a screen cannot describe the deleted app again
without a test naming the word and why it is wrong.

## The seven small ones

Each was cheap, invisible from the screen it affected, and pinned in
`test/wiring.test.js` so it stays fixed.

- **A credential never rides in a query string.** `requireAccount` fell back to
  `?at=` and nothing has ever sent it — but a token in a URL is a token in the
  proxy's access log, the browser's history, the bookmark somebody shares, and
  every `Referer` a no-referrer policy does not happen to cover.
- **A check violation speaks English.** Two handlers passed a `23514` message
  straight through. A trigger's `RAISE` carries a sentence somebody wrote, and
  repeating it is the point; a DECLARATIVE check has none, so Postgres wrote
  `violates check constraint "outlet_slug_is_a_handle"` and that went to the
  browser. `e.constraint` present means translate it by name.
- **A declaration is complete or it is not published.** The recipe walk stopped
  at four levels. `seen` already terminates a cycle, so the cap was never about
  safety — a fifth level was simply dropped, and a dish whose deepest component
  is a reef fish came out claiming Vegetarian. Twelve now, and if the frontier
  is still not empty the previous declaration STANDS and the truncation goes on
  the trail: a partial declaration replacing a complete one is worse than no
  update at all.
- **The veg mark carries a word.** Colour and shape only, next to states that
  all carry text ("86'd", the cost percentage). A cashier asked across a
  counter needs the answer to survive a screen reader, a colour-blind eye and a
  grayscale print.
- **Voiding food that is already cooking asks twice.** The rank gate says who
  may; it does not say they meant to. This control sits a thumb's width from
  the quantity buttons — the one place where the destructive action and the
  routine one are neighbours. Two taps rather than a dialog, because a dialog
  on a touch terminal is dismissed by muscle memory before it is read; the arm
  expires in four seconds. An unfired line still goes on the first tap: asking
  about a keystroke teaches an operator to tap through the question that
  matters.
- **The outbox waits rather than pushing into an install it cannot name.** The
  fence read `if (inst)`, so before the first bootstrap it simply did not run —
  and signing in flushes, which happens before the first bootstrap. Ops are
  durable; holding them costs seconds, and pushing them blind is the incident
  the fence exists for.
- **`owner()` is a list, not a habit** — see the isolation section above.

## Tests

```
npm test                          # 498 tests
npm run leak-test                 # isolation, on its own
node src/scripts/loadtest.js ...  # stages A–G — see LOAD.md
```

`test/harness.js` loads the terminal's logic class into a vm and sweeps it:
every screen generator, every modal kind, every form spec, every handler any of
them expose — on an empty database, on a seeded one, and at every rank. The
handler sweep is the one nobody does, and it is where most defects were found;
several were not reachable by clicking.

Run the suite **without `CONTROL_DB` in the environment**: each suite calls
`freshControl()` and drops the registry it is about to use, and an inherited
name pointed at a long-lived scratch registry makes five tests fail on rows a
previous run left behind — a handle already claimed, a business database name
already taken, an install count of 54 where the panel expects one. Those are
the environment, not the build, and they look exactly like a regression.

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

**One boot migrates at a time.** A platform starts the replacement container
before it stops the old one, so two processes run `migrate()` at once on every
ordinary deploy — and the install provisioned after the ordering fix proved it
in its own log: both raced into 001 and one died on `duplicate key value
violates unique constraint "pg_extension_name_index"`, because `CREATE
EXTENSION IF NOT EXISTS` is not atomic against a concurrent creator. It
recovered only because the process exits and the restart found the extension
already there — luck, and production exits on a migration failure. Three more
collisions sat in the same window: the check-then-`CREATE ROLE` for
`kashikeyo_report`, the bare INSERT into `chain.migration`, and two boots
re-applying a changed file over each other. `panel/server.js` and
`site/server.js` both already hold an advisory lock for exactly this ("seen in
anger" is in one of those comments) and the runner every install boots through
never got one. It does now — session-scoped, held across the whole run on ONE
connection, because `pool.query` takes a different one per statement and holds
nothing. A holder that dies releases it, so a killed container cannot wedge the
next boot. `test/migrate.test.js` runs the real runner twice at once against a
cold database; without the lock it fails the way the install did.

**An install that already exists is ADOPTED, and the order is not negotiable.**
`npm run adopt -- --db <database> --name "<Business>"` copies an old install
into the registry, dry-run by default, `--apply` to do it. It must run BEFORE
the new code reaches that install: migration 011 is a tombstone that drops
`chain.account`, so a boot that gets there first destroys the only record of
who owns the business. An install whose account tables have already gone is
reported as a loss rather than adopted quietly.

Every install allocated outlets from 1, so two installs both have an outlet 1
and a session token would name two stores. The first adopted keeps its ids; a
later collision is REMAPPED — the row, every reference, the schema and the login
role, in one transaction. The references are discovered from the catalog rather
than listed, because two of them are not called `outlet_id` at all
(`chain.member.home_outlet`, `chain.outlet.parent_id`) and a list is something
somebody has to remember to update. The foreign keys come off and go back on
from `pg_get_constraintdef`, so a key a later migration added is replayed
without anybody having remembered it. The new id has to be free three ways —
unclaimed in the registry, no such schema in that database, no such role in the
CLUSTER — because a role is cluster-wide and colliding with one leaves a store
that cannot sign in.

A handle already held by somebody else is NAMED, never quietly changed: they
printed it on their table cards, so it is a conversation rather than a fixup.

**Every request opens the right database, and that was not free.**
`poolFor()` used the connection's default, so before this every outlet request
went to one database whatever customer it was for — the tenancy boundary
failing open at the busiest seam in the app. Pools are keyed by DATABASE and
outlet now, `withOutlet()`/`withOutletRead()` resolve the route first, and
onboarding — which runs before an outlet exists, so there is no outlet to route
by — resolves its business from the ACCOUNT that owns it. `provisionOutlet()`
is told which database to build in rather than inferring one: an outlet created
in the wrong database is the boundary failing at the only step that makes a
schema and a login role. `/readyz` walks every business's outlets, because
asking one database reports on one customer and calls the install healthy.

**`test/e2e.test.js` is what found all of that.** Every other suite proves a
part; that one walks the road a customer walks — sign up, confirm the address,
a database is created, onboard company/outlet/owner, sign in at the till, ring
a bill with a member, a redemption and a credit tender — and then checks the
money landed in that customer's database and nobody else's. Four separate
routing defects were invisible to every unit test and fell out of it in
sequence.

**An account that owns TWO businesses says which one it is setting up.**
Onboarding resolved the account's business with `ORDER BY b.id DESC LIMIT 1`
and offered no way to say otherwise. For the ordinary customer — one account,
one business — that is right and always will be. For a group that has signed
up a second company it is a coin toss that writes a company, an outlet and a
staff record into whichever database happened to be created last, silently,
with nothing on any screen naming it. `?business=<id>` (or `x-business-id`) is
honoured when the account actually owns it and **refused by name** when it does
not — an account naming somebody else's business is either a mistake worth
reporting or an attempt worth refusing, and neither may quietly fall back to
one of their own. `/state` carries `businessId` and every business the account
owns, and the panel names the one it is setting up **only where there is more
than one**, because naming it on every screen for the ordinary customer is
noise.

**Onboarding refuses an account that owns no business.** `/account` sent a
verified account straight to `/onboarding` and nothing had created a business,
so the route fell back to the connection's own database — the one every
business shares. The first customer to sign up would have written their
company, outlets and staff into it: the tenancy boundary failing open on the
first screen a customer sees. It shipped that way for one deploy.

Two halves, and they must agree: `/account` creates the business before it
redirects, and onboarding refuses an ACCOUNT with no business rather than
falling back. The refusal is MIDDLEWARE, not a throw inside a handler — these
handlers are async and express 4 does not catch a rejected promise, so a throw
deeper in left the request hanging with no response at all, which is what the
first version of this fix did. Anonymous onboarding still uses the connection's
own database: that is a single-database install claiming itself, fenced by
`ONBOARDING_CLAIM_TOKEN`, and it can reach no customer's data because that
database is not any business's.

**Signing up creates the database, and no seller is in the loop.** The website
takes the lead row it always took, then hands the customer to the app: creating
a business needs a VERIFIED address, and the only place an address can be
verified is where the code was sent. `POST /api/account/business` is the whole
door, and three things stand between the internet and `CREATE DATABASE` — a
token, a verified address (an unverified one is a string somebody typed, and
minting infrastructure for it means a bot with a wordlist mints
infrastructure), and a ceiling per account, because a verified address is still
one address and "as many as you like" is a bill somebody else pays. Rate-limited
per ACCOUNT rather than per IP: a restaurant's wifi is one address for a whole
room, and what is worth bounding here is spend, not identity.

No outlet is created with the business. Its name, timezone, currency and handle
are all things the customer is about to type in onboarding, and inventing them
so they can be overwritten is how a store ends up trading under "Outlet 1" in
UTC.

**Updates run per business, or across the fleet.** `npm run migrate` migrates
the registry and then every business database; `-- --business <id>` moves one;
`-- --dry-run` lists who is at what version. Boot does the same in-process when
`CONTROL_DB` is set. Four at a time, because a fleet migration opens a
connection per business and a hundred at once is a thundering herd against the
Postgres the shops are trading on.

**A business behind head is refused, not served.** One app serves many
databases now, so a deploy that moved the code but not every schema leaves
somebody's till talking to a database without the columns the code just started
using — wrong answers about money, silently. `requireAtHead()` answers 503 with
how far behind it is; the route's 30s route cache is the window, so a finished
migration is picked up without a restart. A business whose migration FAILED
does not stop the others: its row carries the reason, and only its own requests
are refused. One customer down and named beats a deploy that stopped halfway
with nobody knowing which half.

**The registry creates itself when it is named but absent.** Setting
`CONTROL_DB` on a service whose registry does not exist would otherwise fail at
boot, and production exits rather than serve on a schema it could not finish —
a crash loop over one `createdb` somebody had to remember. It is safe to create
because the name is NAMED: `control()` refuses to guess, so this can only make
the database an operator asked for, and the app already holds CREATEDB because
it makes one per business. A peer that got there first is success. That is the
third face of the `CREATE EXTENSION` defect — a DATABASE is cluster-wide too.

**A cluster-wide object is not protected by a per-database lock.** The advisory
lock above serialises two boots against ONE database, which is what it is for
and no help at all for `kashikeyo_report` — a ROLE, which is cluster-wide. The
fleet raced four workers into check-then-`CREATE ROLE` across four databases,
and two app processes booting together race on `ALTER ROLE` and get "tuple
concurrently updated". So the role is done ONCE per fleet run before any worker
starts, and both statements treat a peer having just done the same idempotent
thing as success rather than as an error. It is the `CREATE EXTENSION` defect
wearing two new faces, and it will wear a third: anything cluster-wide needs
this reasoning, not the database lock.

**A database that has not come up yet is not a broken schema.** That second
failed install printed `MIGRATION FAILED — the schema is not what this build
expects: getaddrinfo ENOTFOUND postgres.railway.internal`, which sends whoever
reads it to look at migrations that were fine. Worse than the wording, the
process exited on it at once: correct for a schema it could not finish, and for
a database thirty seconds behind it is a crash loop that outlives a platform's
restart budget, leaving the app down after the database comes up. That is not
only a provisioning race — it is every Postgres restart and every failover on a
live install. Boot now waits for the database separately and says so
(`DB_WAIT_MS`, 90s), and only what is left is a migration failure. Proved by
starting the app against a stopped cluster, starting the cluster, and watching
it migrate from nothing and answer `/readyz` 200 without a restart.

Database TLS: set `PGSSL_CA` (PEM) or `PGSSLROOTCERT` (path) and the server's
certificate is **verified**; `PGSSL=verify` refuses to boot without a pin, so a
lost variable fails loudly. TLS with no pin still works, encrypted but
unauthenticated, and the boot log says so.

Commit trailer: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` plus the
session link. Never put a model identifier in a commit message, a PR, a code
comment or anything else pushed to the repository.
