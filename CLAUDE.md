# KashikeyoPOS — developer reference

Read this first. It captures how the app is actually built so you don't have to
re-derive it. Deeper design notes live in `docs/` (inventory-and-pricing,
multi-store-architecture, offline-first-transaction-path).

## Stack (not what specs assume)

Node/Express + PostgreSQL. **Not** Flutter/NestJS/Redis — if a spec says
otherwise, it's aspirational; build in this app. Deployed on Railway
(`railway.json`: Dockerfile build → `npm start`; Dockerfile does
`COPY package.json` then `npm install --omit=dev`, so a new runtime dep in
`package.json` installs on the next deploy — the lockfile isn't used by the
image). CommonJS, lean deps (express, pg, jsonwebtoken, bcryptjs, jose,
@anthropic-ai/sdk). Node 22 in the sandbox (has native `fetch`).

## The three UIs — all hand-written and directly editable

Every UI is now plain HTML/JS in this repo, served by `serveProto()` in
`index.js`. **There is no build step and no bundle to bake.** Edit the file,
restart, reload.

**Post-auth landing is `/v2`** (`web3/proto/index.html`, the current terminal —
POS, KDS, orders, accounting, inventory, branding). Owner login, onboarding
finish (`/api/onboard/finish`), the authed `/login`·`/signup`·`/welcome` bounce
and the landing "dashboard" button all send staff to `/v2`. `/app` (the legacy
offline register) is **not** redirected — installed offline tills still fetch it
directly — but nothing routes new users there. Staff-PIN sign-in still opens
`/admin`.

1. **Register / till** (`/app` → `web2/proto/index.html`) — PIN-gated,
   offline-first. Syncs via `/api/ops` push, `/api/pull`, the cookie-auth
   snapshot `/api/app2/pull` (5s poll, ETag/304) and SSE `/api/events`.
   Templating is `dc-template`: `{{ x }}` bindings, `<sc-if value="{{ b }}">`,
   `<sc-for list="{{ y }}" as="z">`.
2. **Admin cockpit** (`/admin` → `web2/proto/admin.html`) — the back office.
   Requires MANAGER rank or above. This is where inventory, reports, staff and
   configuration live.
3. **Guest / QR portal** — the *same* `web2/proto/index.html` run in a
   locked-down customer mode, reached at `/?s=<slug>` (`serveGuestPortal`, a
   different code path from `serveProto`) and `/p/:slug/...` for its APIs.

### What was retired (docs elsewhere may still describe it)

- **`/back` and `site/back.html` are gone.** `/back` 301-redirects to `/admin`.
  Anything describing a `S`/`TABS`/`render()` back office is obsolete.
- **The prebuilt minified Vite/React bundle under `web/dist` is no longer the
  till.** `guest-sync-patch.js` and its ~75 string-`.replace()` patches, the
  `PATCH_ONLY=1` bake and the `kashikeyo-2.9.NN` SW bump all applied to *that*
  bundle. `web/dist` survives only so already-installed legacy PWAs can still
  fetch their root-relative assets, and `npm start` still runs the patcher over
  it. **Do not add patches there** — change `web2/proto/*.html` instead.
- The register's own service worker is `web2/proto/sw.js` (`kashikeyo-app-1`),
  network-first, and it never touches `/api/` or `/p/`.

### Editing `web2/proto/*.html` safely

- **Mismatched string quotes** are the #1 self-inflicted bug (open `'`,
  accidentally close `"`). Always syntax-check after editing: extract the
  largest inline `<script>` block and `node --check` it.
- Also confirm `<sc-if>`/`<sc-for>` open and close counts still balance — an
  unbalanced tag renders as an empty screen with no error.
- Tailwind is not in play here; these files carry their own CSS.

## Data model

**Tenancy:** Postgres FORCE RLS. Every query runs in `withOrg(orgId, fn)`
(sets `app.org_id`) or `withSystem(fn)`. `bootPool` (postgres role) runs
migrations; request handling uses the restricted `kashikeyo_app` role. Schema
in `schema.sql` is applied on every boot; add columns via idempotent
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in the "Incremental migrations"
section at the end.

**Sync/entities:** `entities(org_id, kind, id, data JSONB, deleted, rowver
BIGSERIAL)` PK `(org_id, kind, id)`. The till's business objects (products,
sales, customers, waiterCalls, expenses, pords…) live here. Pull returns rows
`rowver > since` **including deleted ones** (so clients can remove them). The
back office writes entities too (e.g. deliveries book an `expenses` entity;
availability writes onto `products`) and calls `poke(orgId, rowver)` to nudge
SSE.

**Outlets/stores:** `stores(org_id, id, code, name, address, active, …)` plus
per-outlet configuration columns `tables`, `seats`, `table_seats JSONB`,
`region`, `manager`, `kind`. **The store row is the authority for its own floor
plan** — `buildV2RealForOrg` reads it per outlet, so a branch renders its own
table count instead of the old hardcoded 12/48. A NULL column means "never
configured": the primary store (`main`) falls back to the org settings entity's
`tableCount`/`seatCount`/`tableSeats`, every other outlet to 12/48. Writes go
through `POST`/`PATCH /api/app2/outlets[/:id]` (shared `outletConfigFields()`
validation), and a PATCH of `main` mirrors the floor back onto the settings
entity because the legacy `/app` register and the guest portal still read it
there. `KPOS_REAL.outlet` is `outlets[0]`, never a second source.

**Inventory** (`inventory.js`, mounted at `/api/inv`):
- `ingredients` — base_unit (g/ml/pcs), current_stock (cached), avg_cost
  (weighted, laari/base-unit), min_stock, location. **Role columns:**
  `sellable`+`sell_price`+`product_id` (resale), `producible` (prep).
- `ingredient_units` — pack conversions (factor = base units per pack).
- `recipe_lines(product_id, ingredient_id, qty)` — qty per 1 sold unit. **No FK
  on product_id**, so it's reused for two more things: a prep ingredient's build
  recipe (product_id = the ingredient's own id) and a stockable product's link.
- `stock_moves` — **immutable signed ledger**, the source of truth. kinds:
  `purchase|sale|refund|audit|manual|waste|transfer|produce|prep`. Has a
  `location` column (blank = the ingredient's home location). `current_stock` is
  a cache = Σ moves.qty; keep them in step.
- Money is **laari** (MVR×100), integer sub-unit. Display ÷100.

## Staff roles (two lists, and they are not the same list)

The **backend** roles are `owner|admin|manager|cashier|waiter|kitchen|rider`,
ranked by `APP_ROLE_RANK` (kitchen 1 · till 2 · manager 3 · admin 4 · owner 5);
`denyAppRole(req, res, APP_RANK.X, …)` enforces them per endpoint. Five are
assignable (`ASSIGNABLE_ROLES`), and `TERMINAL_ROLES` decides who may hold a
`/v2` session — admin, manager, cashier, waiter and **kitchen**; riders have no
screen to reach.

The **front-end** list is a permission catalogue in `kashikeyo-data.js` (`ROLES`
× `MODULES`, keys like `Cashier`, `KitchenDisplay`, `OutletManager`), and it is
what `can(mod, act)` and the nav read. `initialRoleKey()` in
`web3/proto/index.html` maps one to the other: cashier/waiter → `Cashier`,
kitchen → `KitchenDisplay`. **Anything unmapped falls through to `ChainAdmin`**
— the whole cockpit — so a new backend role needs a line there or it silently
grants everything.

A kitchen session is the narrow one: two nav items (the KDS and the orders board,
which runs on the live pipeline), and `kitchenScope()` in `index.js` trims what
the page even injects — it keeps menu/liveOrders/outlet and **empties** `orders`
(the CLOSED sales: receipts, tenders, guest names), customers, staff, expenses,
settlements, assets, inventory and stats. `passOnly()` in the terminal hides what
follows from that: the register banner, the float prompt, Z-report/export/history
actions, the settle and cancel controls, and the takings ribbon — which shows the
pass's own figures instead. `GET /api/app2/orders` is gated at TILL rank, since
it is the same receipt history by another door.
Empties, not deletes: `kashikeyo-data.js` only replaces a demo seed when the real
key is *present*, so a missing key leaves the seeded demo roster on screen.
`initialView()` opens on the first screen the role can see, never a blanket
"pos". Covered by `kitchen display session (KDS-ROLE)` in `test/audit.test.js`,
placed before the security suite because that one leaves the login throttle
blocked for the IP.

## Item-role graph (§6, all implemented)

One ingredient record can carry multiple roles, all on the existing tables:
- **Stockable** (default) — bought, counted, consumed.
- **Resale** (`sellable`) — sold as-is on the till. Links a `products` entity +
  a 1:1 self `recipe_line`; selling deducts its own stock. `syncResaleProduct()`.
- **Prep / producible** — built from components via `POST /produce` ("Make a
  batch"): consumes components (`prep` moves), stocks the item (`produce` move),
  rolls component cost into avg_cost. Build recipe = recipe_lines keyed by the
  ingredient's own id.
- **Stockable menu product** — mirror of resale, from the products side:
  `POST /products/:id/stockable` creates a backing ingredient, moves the
  product's raw recipe onto it (÷perSale), makes the product's recipe a single
  `perSale`-unit draw. Sell-from-stock + usable in other recipes. Demote reverses
  it (guarded if used elsewhere).

Availability engine: `recomputeAvailability(orgId, ingredientIds)` computes
servings per recipe product from stock and writes `recipeAvail`/`soldOutReason`
onto the product entity → till + guest disable sold-out items. Call it after any
stock change.

## Key back-office endpoints (`/api/inv`)

`ingredients` (GET/POST/DELETE), `recipes/:productId` (GET/PUT — generic, works
for prep recipes too), `invoices` (deliveries; `postInvoiceTx` = the one path
that raises stock + re-averages cost + books an expense entity), `audits`
(stock checks), `history/:id` (per-item timeline), `locations/:id` + `transfer`,
`adjust` (waste/manual correction), `produce`, `products/:id/stockable`,
`ocr` (§13 scan), `insights` + `assistant` (§18–19).

## External-service features (need an AI key — **production runs Gemini**)

- **OCR delivery notes** (`POST /ocr`) — vision + structured outputs reads a
  photo, maps lines to the ingredient catalogue, returns a draft the UI posts
  via `/invoices`.
- **AI assistant** (`POST /assistant`) — answers grounded on a digest from
  `computeInsights()`.
- **Provider-agnostic.** `aiClient()` picks Anthropic or Gemini from whichever
  key is set (`AI_PROVIDER` decides when both are, with failover if the
  preferred one throws). Gemini goes over its REST API through a shim built on
  native `fetch` — no extra dependency. Everything degrades gracefully with no
  key (`configured:false`); `insights` is deterministic and needs none.
- **Live production config** (verified 12 Aug 2026): `provider: gemini`,
  `model: gemini-3-flash-preview`, no Anthropic key. Note the shim's
  thinking-budget guard keys on `/2\.5-flash/`, so a gemini-3 model correctly
  takes the "don't send `thinkingBudget: 0`, give ≥8192 output tokens" branch.
- Diagnostics: the boot log always prints one `AI: {...}` line;
  `GET /api/inv/ai-selftest` makes one real call; `AI_SELFTEST=1` prints that
  result into the deploy log.
- Env vars: `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) + optional `GEMINI_MODEL`,
  or `ANTHROPIC_API_KEY` + optional `OCR_MODEL`; `AI_PROVIDER` to force one.
  Also: `DATABASE_URL`/PG*, `JWT_SECRET`, `ALLOWED_ORIGINS`, `GOOGLE_CLIENT_ID`,
  `PLATFORM_ADMIN_*`, `PUBLIC_ORIGIN`, `PORTAL_BASE_DOMAIN`, `RESEND_API_KEY`.

## Store storefront branding + subdomains

A store shapes its customer-facing (QR/guest) storefront from the v2 terminal
Settings → **Merchant branding** (name, tagline, brand colour, logo, receipt
footer, white-label) and **Store handle** cards. All persist on the settings
entity via `POST /api/app2/config` (`store.{tagline,accent,whiteLabel,logo,…}`)
except the handle, which renames `orgs.slug` via `POST /api/app2/handle`
(slugified, ≥3 chars, reserved-word blocked, unique). `serveGuestPortal` +
`liveStoreP` carry these; `buildV2Real` exposes `KPOS_REAL.brand`. The guest
portal (`web2/proto/index.html`) repaints to `storeP.accent` (a named swatch key
OR a `#rrggbb` — `accentVars()` synthesises the palette from a hex), prints the
tagline, and hides "Powered by KashikeyoPOS" when white-labelled.

**Subdomains** (`PORTAL_BASE_DOMAIN`, comma-separated apexes e.g.
`kashikeyopos.com`): when set, `<handle>.<domain>` serves that store's guest
storefront — `portalSlugFromHost()` maps the Host header's label to `?s=<slug>`
in the root handler; apex/www and a reserved-label set (`app`/`api`/`admin`/…)
stay the platform app; an unknown label falls back to the app. QR codes
(`/api/app2/qr.svg`) then encode `https://<handle>.<domain>/` (via
`portalOriginForSlug()`, honouring `x-forwarded-proto`). It is inert until
`PORTAL_BASE_DOMAIN` is set — but **it is set in production and live**:
`*.kashikeyopos.com` is a provisioned wildcard custom domain on the service, so
`<handle>.kashikeyopos.com` really does serve storefronts today.

**A handle a store has answered to keeps answering.** `org_slug_aliases(slug,
org_id)` holds every handle a store leaves behind; `orgBySlugOrAlias()` tries the
live `orgs.slug` first, then the aliases, and `serveGuestPortal` 301s an alias
hit to the current address carrying `?t=`/`?c=` with it — so a printed QR code
survives a rename instead of dying. A handle is owned from first use: `uniqueSlug`,
`uniqueSlugFor` and `handleTaken()` all treat an alias as taken, or the next store
to register could collect another business's scanned traffic. A handle retired
*before* this existed leaves no record of who owned it, so an admin claims it back
by hand — `POST /api/app2/handle/alias` (Settings → Store handle, second field).
That is the only repair for a code already stuck to a table. An address no store
has ever answered to is still a 404 (`STOREFRONT_NOT_FOUND_HTML`), never a
fallback into the app.

## Deploy (staging → production flow)

**Two Railway environments.** `staging` branch → the **test** environment (its
own Postgres); `main` branch → **production** (the live DB + real domain). All
feature/bug work lands on `staging` FIRST, is verified on the staging URL, and is
only promoted to `main` once confirmed. **Never push straight to `main`** — it is
live. Railway auto-deploys each environment when its tracked branch changes.

Default target for new work is `staging` (branch from it: `git checkout staging &&
git pull && git checkout -b <feature>`; small changes may commit on `staging`
directly). Then:
```
git add … && git commit
git push -u origin <branch>            # retry 2/4/8/16s on network fail
git checkout staging && git merge --ff-only <branch> && git push origin staging
```
Deploys to **test** for verification. After you confirm on staging, **promote to
production** (do this only when the change is signed off):
```
git checkout main && git merge --ff-only staging && git push origin main
git checkout staging
```
Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` +
`Claude-Session: …`. Don't put the model id in commits/PRs.

## Local test harness (sandbox)

Postgres 16 at `/usr/lib/postgresql/16/bin`, run as `postgres` user, TCP on
127.0.0.1 on a rotating port. Pattern:
```
sudo -u postgres $PGBIN/initdb -D /var/lib/postgresql/pgNNNN -A trust
sudo -u postgres $PGBIN/pg_ctl -D /var/lib/postgresql/pgNNNN -o "-p NNNN -k /tmp" -l /var/lib/postgresql/pgNNNN.log start
sudo -u postgres psql -h 127.0.0.1 -p NNNN -d postgres -c "CREATE DATABASE kash OWNER postgres;"
env PGHOST=127.0.0.1 PGPORT=NNNN PGDATABASE=kash PGUSER=postgres PGPASSWORD= PORT=40xx \
    NODE_ENV=development SECRET=testsecret ALLOWED_ORIGINS="*" \
    setsid node index.js >/var/lib/postgresql/appNNNN.log 2>&1 </dev/null & disown
```
(Log file must be in a postgres-writable dir; the scratchpad isn't. Use
`env -u ANTHROPIC_API_KEY` to test the not-configured paths. `pkill`/pg_ctl exit
code 144 in a compound command just means the shell got SIGTERM — harmless.)

Register a store: `POST /api/register {email,password,storeName,currency,pin}`.
Back office auth = `kashikeyo_session` cookie (from register/login). Till/ops
auth = Bearer token (from the same response) on `/api/ops` (op shape:
`{ops:[{opId,puts:[{kind,id,data}]}]}`; a sale is a `sales` entity with
`lines:[{pid,qty}]` and a `payments` array).

**Browser verify** (`/app` boots headless; it stops at the PIN gate unless you
set the session cookie):
```
import pkg from '/opt/node22/lib/node_modules/playwright/index.js';
const {chromium}=pkg;                // playwright is CJS — must destructure
// executablePath:'/opt/pw-browsers/chromium'; goto waitUntil:'domcontentloaded'
// (SSE breaks networkidle). Set the kashikeyo_session cookie to reach /admin.
```
The app's own state is closure-scoped — not injectable from the page. To test a
method's arithmetic, slice its source out of the HTML and run it with `new
Function` against a stub `this`; that exercises the shipped text rather than a
retyped copy.

`pkill -f "node index.js"` **kills this shell too** whenever the command line
you are running contains that same string (the pattern matches its own argv).
Use `pkill -f "[n]ode index[.]js"`, and run restarts as their own step.

## Conventions / gotchas

- Design tokens: kashikeyo palette (keyo-600 `#C7431D`, sand neutrals). Themeable
  via `.ksh-*` CSS vars driven by `window.__kpal`.
- **Money is integer laari everywhere** (MVR×100). Menu prices are
  GST-inclusive, and so is the delivery zone fee. GST is *extracted* as the tax
  fraction `rate/(1+rate)` of the inclusive amount — never re-grossed off a
  rounded exclusive base, which is not a round trip. Service charge applies to
  the goods (not the fee) and is itself taxable. Round each figure exactly once,
  from the figure itself. The invariant
  `subtotal − discount + service + GST = total` must hold on every bill.
- **There is ONE bill calculation: `web3/proto/money.js` (`billTotals`).** The
  terminal's `totals()`, the settlement path (`v2-bridge.js pushSale`) and the
  guest quote (`orderBreakdown()` in `index.js`) are all thin adapters onto it —
  the browser loads it as a script, Node `require`s the same file. Do NOT write a
  second copy. Three hand-written copies is exactly how the terminal drifted to a
  GST-EXCLUSIVE model and charged 8% (GGST) / 17% (TGST) more at the counter than
  the guest's own phone quoted, for months, with a green test suite —
  `auditSaleMoney()` only checks a sale against its own components, so it had
  nothing to compare against. `test/guest-quote.test.js` now pins the two
  adapters against each other across the rate/service/type/discount matrix.
- A store's GST rate must be read with `gstBpOf()`, never `Number(x || 800)` —
  onboarding offers `none: 0` for a business that is not GST-registered, and
  `0 || 800` silently turns that into 8%.
- Sale lines carry an explicit `amount` (the line, rounded once, NET of GST so
  the lines sum to the subtotal). `price` is the inclusive per-unit figure for
  display only — multiplying it back out drifts by laari.
- A sale's `subtotal` is goods net **before** the bill discount (plus the fee
  net). Pairing a post-discount subtotal with `billDisc` subtracts the discount
  twice and breaks the invariant on any discounted bill.
- Server money-integrity: `auditSaleMoney()` re-checks every incoming sale
  against its own declared components and stamps `data.serverAudit` on a
  mismatch. It never rejects — a cashier has already taken the money.
- SSE (`/api/events`, `/p/:slug/events`) goes through `openEventStream()`:
  `retry:` hint (jittered), `id:` = rowver, `Last-Event-ID` honoured,
  `X-Accel-Buffering: no`. On the client, `openStream()` re-opens on
  `readyState === 2` with backoff — EventSource does *not* retry a 401/503/502
  by itself. The 5s/8s polls are the safety net under it.
- Don't create PRs unless asked. Only push to the designated branch.

## Status

The Inventory & Ingredient Management revamp is fully shipped (availability,
guided overview, per-item timeline, wastage ledger, per-location + transfers,
the item-role graph, OCR delivery notes §13, AI assistant + insights §18–19).
An AI key **is** live in production (Gemini — see the External-service section);
what has not been observed is a completed round trip, which
`GET /api/inv/ai-selftest` answers in one request.

A 5-member production audit (offline/sync, accounting, restaurant operations,
ergonomics) has been worked through on `staging`. CRITICAL, HIGH and MEDIUM
findings are done, including the last three: per-outlet configuration (D-09),
paged receipt history (D-06) and the recovery/observability pair (D-04 — an
automated restore drill plus `/api/metrics`). What remains of D-04 is
unverifiable from here: Railway's managed-backup layer and the wiring of an
external monitor to the scrape endpoint both need console access.

That audit work is promoted: `main` = `staging` = `97c832c`, deployed green to
both Railway environments. Run the suite against a **fresh** Postgres before
shipping — it is 152 tests and a cold database is the CI path.

The menu carries three levels (group → category → subcategory). A CSV import is
the authority for its own taxonomy, and a manager can set a dish's section by
hand. Each surface draws a **chip row for the level below its own tab strip**,
which is not the same level on both: the till strip is GROUPS — `catGroupOf()`
guesses one from the category name, so every category has one and the strip is
never categories — so its row is the group's categories, with subcategories as a
third row once a category that uses them is picked. The guest strip is already
categories, so its one row is subcategories. A row that would filter nothing
(one section covering the whole tab, or none at all) is not drawn, and picking a
level clears the levels below it.
`settings.catGroups` is the *group* model (`[{name, subs: [<category names>]}]`);
subcategories live in `menuSubs` — don't overload the one key with the other's
meaning, which is what the importer used to do.
