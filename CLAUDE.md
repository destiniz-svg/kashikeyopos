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
                       008 line identity · 009 GST registration · 010 currency
                       011 accounts · 012 store handle · 013 handle history
                       014 GST optional · 015 order stage
                       016 business date
src/apple.js           Apple's client secret, which is a JWT this app mints
src/handle.js          what a store address is, and where the base domain comes from
src/directory.js       where an address points — current or one a store gave up
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

Email goes through `src/email.js` — one seam, Resend as the driver. With no
transport configured the code is written to the audit trail and the call
**says so** (`sent: false`); it never pretends.

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

If you are tempted to add a settle button somewhere new, open the pay screen
instead. `test/chain.test.js` asserts the panel exposes no `tkSettle` and no
tender list of its own.

## Points are a liability, not a discount

Redeeming **releases 2300 and recognises revenue**; it does not reduce the sale.
Get this wrong and the P&L understates revenue by every point ever spent.

At the till: whole redemption blocks only — a half block is not something the
catalogue prices — never more than the bill, and taken off the **goods**, before
service and tax. A guest should not have service charged on money they did not
hand over, and the government should not be taxing a discount. One control steps
a block on and wraps back to none, so the same button spends and cancels.

Order of operations at close, and it matters:

1. debit the points spent, and journal `Dr 2300 / Cr 4000`;
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

Any column called `tier` is a cache. `memberLive()` composes the seed row with
everything awarded since and works the tier out, and every surface reads that one
composition — the customers table, the guest sheet, the pay screen, the published
roster. Raising a threshold demotes exactly the members it should without editing
a soul. The shipped tier rows survive only as presentation: the mark and the card
gradient.

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
the 404 falls back to whichever app owns the hostname. The till's own paths
(`/pos`, `/kds`, `/admin`, `/onboarding`, `/account`) 308 back to the apex: one
sign-in, one set of cookies, not one per store.

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

`app/index.html`'s own `RANKMAP()` does not agree with `src/auth.js`: it reads
`ChainAdmin` as 5 where the ladder says 4, and `OutletManager` as 4 where it
says 3. `rank()` now prefers `state.session.rank` — the rank the server put in
the session — and falls back to the map only for a terminal that has not signed
in against a server yet. Gating on the map would offer an admin controls the API
then refuses, and a button that 403s is worse than no button.

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

**Email is a real transport when one is configured** (`src/email.js`); Viber and
WhatsApp are recorded but not wired. Either way the answer carries `sent` and the
reason, and the code comes back for the counter to read out — a screen that
reports a send it did not make is worse than one offering no send at all.

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

## Tests

```
npm test                          # 162 tests
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
