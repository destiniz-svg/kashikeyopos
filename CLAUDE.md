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

## The three UIs

1. **Till** (`/app`) — an **editable Vite + React + TS app** whose source lives
   in **`till-src/`**; it builds to a single self-contained
   `web/dist/index.html` (via `vite-plugin-singlefile`). PIN-gated and
   offline-first (syncs via `/api/ops` push + `/api/pull` + SSE `/api/events`).
   The same bundle also renders the **guest QR portal** when the URL carries
   `?s=<slug>` (see `till-src/src/guest.tsx`).
2. **Back office** (`/back` → `site/back.html`) — plain hand-written HTML/JS,
   **fully editable, server-served** (no build). Inventory/back-office work
   lives here; the till's Admin tab deep-links into it.
3. **Guest/QR portal** (`/p/:slug` or `/?s=slug&t=table`) — served from the
   same built bundle, guest view (no token).

### Building the till (critical)

The till is compiled from source, not string-patched (the old
`guest-sync-patch.js` / `favicon-patch.js` bake is **retired** — those files
targeted the previous minified bundle and are no longer in the boot path).

- Edit under `till-src/src/` (App.tsx = shell + register + PIN/shift/pay/
  receipt/refund; screens.tsx = Orders/Dashboard/Reports/Admin; guest.tsx =
  QR portal; store.ts + api.ts = the offline-first sync engine; tokens.css =
  design tokens + self-hosted fonts).
- Build: `cd till-src && npm install && npm run build`, then copy
  `till-src/dist/index.html` → `web/dist/index.html` and commit it (the deploy
  image runs **no build** — `npm start` is just `node index.js`).
- **Bump the SW version** in `web/dist/sw.js` (`kashikeyo-3.0.N`) whenever you
  change the bundle, so installed PWAs pick up the build. The till registers
  `/sw.js` itself (see `till-src/index.html`).
- The build is self-contained (React + CSS inlined; fonts referenced at
  `/fonts/*` and shipped in `web/dist/fonts`). No purged-Tailwind constraint —
  it's normal React with inline styles + `tokens.css`.
- The sync contract it speaks (unchanged): token from
  `localStorage["kashikeyo-cloud"]`, `GET /api/pull?since=` →
  `{rowver, entities, more}`, `POST /api/ops {ops:[{opId,puts,dels}]}`,
  `X-Elevation` header for SEC-03 refunds, SSE `/api/events`.
- `/back`-only changes need no build and no SW bump (server-served,
  network-first).

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
  `ALLOWED_ORIGINS`, `GOOGLE_CLIENT_ID`, `PLATFORM_ADMIN_*`.

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

**Browser verify** (the till is PIN-gated and heavy; it may not fully boot
headless — verify `/back` instead where possible):
```
import pkg from '/opt/node22/lib/node_modules/playwright/index.js';
const {chromium}=pkg;                // playwright is CJS — must destructure
// executablePath:'/opt/pw-browsers/chromium'; goto waitUntil:'domcontentloaded'
// (SSE breaks networkidle). Set the kashikeyo_session cookie to reach /back.
```
`window.S` (back-office state) is closure-scoped — not injectable from the page.

## Conventions / gotchas

- **Mismatched string quotes** are the #1 self-inflicted bug in `site/back.html`
  (open `'`, accidentally close `"`). Always syntax-check after editing:
  extract the single `<script>` block and `node --check` it.
- `site/back.html` render: `S` state, `TABS`, `render()` switches on `S.tab`,
  `api(path,opts)` → `/api/inv`, `go(tab)`, `loadAll()`. Modals go in
  `#modalHost`. Reuse existing CSS (`.card/.cards`, `.suggest/.s`, `.badge`,
  `.chips`, `.adj-preview`, `.seg`, `.flow/.st`).
- Design tokens: kashikeyo palette (keyo-600 `#C7431D`, sand neutrals). Themeable
  via `.ksh-*` CSS vars driven by `window.__kpal`. Injected helpers on the till:
  `__kpal, __ksnd, __ksChart, __kstatus, __kshexSvg, __ksOut, __ksDismissedCalls`.
- Waiter calls: accepting adds the id to `window.__ksDismissedCalls` (patch #75)
  so an in-flight pull can't resurrect it; the server delete clears it elsewhere.
- Don't create PRs unless asked. Only push to the designated branch.

## Status: the Inventory & Ingredient Management revamp is fully shipped

Availability/out-of-stock, guided overview, per-item timeline, clearer
stock-count wording, wastage/adjustments ledger, per-location + transfers, the
full item-role graph, OCR delivery notes (§13), and the AI assistant +
behaviour-learning insights (§18–19) — all on `main`. Deferred/none pending
except turning on `ANTHROPIC_API_KEY` in Railway to enable the live model calls.
