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

## External-service features (need `ANTHROPIC_API_KEY`)

- **OCR delivery notes** (`POST /ocr`) — Claude vision + structured outputs
  reads a photo, maps lines to the ingredient catalogue, returns a draft the UI
  posts via `/invoices`.
- **AI assistant** (`POST /assistant`) — answers grounded on a digest from
  `computeInsights()`.
- Both lazily `require("@anthropic-ai/sdk")` and **degrade gracefully** without
  the key (`configured:false` message). Model = `claude-opus-4-8`, override with
  `OCR_MODEL`. `insights` (reorder/watch, learned from `stock_moves`) is
  deterministic and works with **no key**.
- Env vars: `ANTHROPIC_API_KEY` (set in Railway → service → Variables),
  optional `OCR_MODEL`. Also: `DATABASE_URL`/PG*, `JWT_SECRET`,
  `ALLOWED_ORIGINS`, `GOOGLE_CLIENT_ID`, `PLATFORM_ADMIN_*`, `PUBLIC_ORIGIN`,
  `PORTAL_BASE_DOMAIN`.

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
`portalOriginForSlug()`, honouring `x-forwarded-proto`). **All of this is inert
until `PORTAL_BASE_DOMAIN` is set** — routing is unchanged otherwise — so the
code ships ahead of the wildcard DNS + TLS being provisioned on Railway.

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
  from the figure itself: `totals()` in `web2/proto/index.html` returns the
  integers in `.L` for the payment path to store verbatim. The invariant
  `subtotal − discount + service + GST = total` must hold on every bill.
- Sale lines carry an explicit `amount` (the line, rounded once). `price` is the
  per-unit figure for display only — multiplying it back out drifts by laari.
- `orderBreakdown()` in `index.js` is the guest-portal mirror of `totals()`.
  If you change one, change both, and check a guest quote against a till charge.
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
`ANTHROPIC_API_KEY` still needs turning on in Railway for the live model calls.

A 5-member production audit (offline/sync, accounting, restaurant operations,
ergonomics) is being worked through on `staging`: CRITICAL and HIGH findings are
done, MEDIUM is in progress. Production `main` has not been promoted since that
work started.
