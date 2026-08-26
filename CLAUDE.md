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
src/limit.js           the doorman: token buckets on the open doors
src/revoked.js         a revoked session or device is refused, not just recorded
src/routes/            auth · onboarding · outlet · sync · guest · estate · pages
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
src/routes/platform.js the one door an install opens to its seller — aggregates only
panel/                 Mission Control — the seller's panel, its own service
panel/railway.js       Provision: it builds the whole install, or says why it cannot
site/                  the public website — landing, docs, legal, store signup
src/apple.js           Apple's client secret, which is a JWT this app mints
src/handle.js          what a store address is, and where the base domain comes from
src/directory.js       where an address points — current or one a store gave up
app/index.html         the terminal (POS, KDS, back office) — one app, gated by rank
app/onboarding.html    the fourteen-step panel an empty install lands on
app/guest.html         the QR portal
app/member.html        the member card
app/kashikeyo-rules.js allergen + diet rules, loaded by BOTH browser and server
app/kashikeyo-yield.js  what a kilo plates — the estimate BOTH runtimes read
app/kashikeyo-invite.js the invitation's copy, loaded by BOTH browser and server
app/kashikeyo-data.js  structure that ships (chart, ranks, units, labels) — no trade
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

115 op kinds, all handled. 28 are deliberately audit-only and are **named** in
`AUDIT_ONLY`, so "not modelled yet" and "audit-only by design" stay
distinguishable. `test/wiring.test.js` asserts both halves meet.

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

The till captures the evidence that processor issues, named the way it names it.
Card and wallet **fill their own approval code in**: the device approved the
payment and knows the code, so a cashier retyping it is one figure entered twice.
The reference lands on the settled row, which is what makes the settlement
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
  is one nobody reads.

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
| `ALERT_REPEAT_HOURS` | Reminder interval while a condition holds (6). |
| `DEVICE_QUIET_MINUTES` | How long a writing device may go without delivering (60). |
| `WATCH_INTERVAL_SECONDS` | Sweep interval (60, floor 15). First sweep is delayed 20 s so a deploy does not alert on pools that have not opened. |

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
run the fourteen onboarding steps themselves and land on a live trial. A form
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
npm test                          # 343 tests
npm run leak-test                 # isolation, on its own
node src/scripts/loadtest.js ...  # stages A–G — see LOAD.md
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
