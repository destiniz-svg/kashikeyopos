# STACK.md — how KashikeyoPOS is built (for the guest-ordering handoff)

Written for the `handoff_guest_ordering` build. Maps the production stack the two
guest surfaces plug into, and the deployment shape decided for them.

## Framework / runtime

- **Server:** Node 22 + Express, CommonJS, single `index.js` (~5.5k lines). Lean
  deps (express, pg, jsonwebtoken, bcryptjs, jose, @anthropic-ai/sdk). Native
  `fetch`. Deployed on Railway via Dockerfile (`npm install --omit=dev` → `npm start`).
- **DB:** PostgreSQL with FORCE RLS. Every query runs inside `withOrg(orgId, fn)`
  (sets `app.org_id`) or `withSystem(fn)`. Schema in `schema.sql`, applied on boot;
  incremental migrations are idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS`.
- **No build step, no bundler, no framework on the client.** Every UI is
  hand-written HTML/JS served by `serveProto()`/`serveGuestV3()` from `index.js`.
  Edit the file, restart, reload.

## Styling / component layer

- Plain CSS in each HTML file (no Tailwind here). Design tokens as `.ksh-*` /
  `--*` CSS custom properties driven by `window.__kpal`.
- The UIs use a bespoke `dc-template` runtime: `{{ x }}` bindings,
  `<sc-if value="{{ b }}">`, `<sc-for list="{{ y }}" as="z">`, backed by a
  `class Component extends DCLogic` logic object. This is **the production
  pattern in this repo** (the terminal `web3/proto/index.html`, the guest
  `web3/proto/guest.html`) — NOT the prototype's `support.js` runtime, which we
  do not import. New guest screens are written in this same idiom.

## Router / state / auth

- **Routing:** Express routes in `index.js`. Guest surface today:
  - Entry `GET /?s=<slug>` → `serveGuestPortal` → `serveGuestV3` → `buildGuestReal`.
  - Subdomain `<handle>.<PORTAL_BASE_DOMAIN>` → `portalSlugFromHost` injects `?s`.
  - APIs `/p/:slug/{events,boot,order,orders,account,call,reserve}` (public,
    throttled, slug-scoped).
- **State:** server = Postgres `entities(org_id, kind, id, data JSONB, rowver)`;
  the till/guest business objects (products, sales, orders, waiterCalls,
  customers, reservations, settings…) all live here. Client state is closure-scoped
  in the logic class + `localStorage` for device-local (cart, table, prefs).
- **Auth:**
  - Staff/back-office: `kashikeyo_session` cookie; till ops: Bearer JWT on `/api/ops`.
  - Guest: **anonymous** — `?s=<slug>` (store), `?t=<table>` (plain, guessable),
    `?c=<custId>` (opaque link id). **No table token, no customer OTP today.**

## Realtime transport

- SSE via `openEventStream()`: guest stream `GET /p/:slug/events`, till stream
  `GET /api/events`. `id:` = rowver, `Last-Event-ID` honoured, `retry:` hint,
  `X-Accel-Buffering: no`. Client `openStream()` re-opens on error with backoff.
- Safety-net polls (5s/8s) sit under SSE. `poke(orgId, rowver)` nudges streams
  after an entity write.

## How the POS exposes guest data today

- `buildGuestReal(orgId)` → `{ guest, outlet, outlets, categories, menu, brand, fiscal }`;
  `serveGuestV3` adds `slug`, `table`, `customer`, injects as `window.KPOS_REAL`.
- Money: `orderBreakdown(order, settings)` is the guest mirror of the till's
  `totals()` (tax-inclusive, service on goods, GST extracted). `normalizeOrder`,
  `guestOrders`, `orderTotal` wrap it. Guarded by `test/guest-quote.test.js`.
- Availability: `inventory.js recomputeAvailability()` writes `recipeAvail` +
  `soldOutReason` onto product entities; sold-out rule is
  `soldOut===true || (recipeAvail!=null ? recipeAvail<=0 : stock<=0)`.
- Guest order ingest: `POST /p/:slug/order` re-prices server-side and writes an
  `orders` entity `source:"qr"`; the till surfaces it via the orders stream
  (`channel:"qr"`) and `waiterCalls` via `/api/app2/orders`.

## Gaps the handoff requires us to close (net-new)

1. **Money on the phone is currently client-side demo logic** (pay/points/rewards
   in `guest.html`). The new contract forbids this — the till must be truth.
2. **No table QR token** — `?t=` is plain. Handoff needs a signed, short-lived,
   per-table token that scopes reads/writes and is not guessable.
3. **No customer OTP auth** — needed for the member portal (email OTP only).
4. **No Promotions/Banners module**, no `qrBanners/qrOrdering/qrAutoAccept/
   memberOrdering/tipPresets` settings, no published `/guest/promos` payload.
5. **Order status is prep-time-guessed client-side**, not derived from real
   `fired`/`done` KDS fields; and the **bill-merge rule** (POS lines + unaccounted
   sent rounds) is not implemented.

## Deployment shape (decided)

Given no build step and the hand-written-HTML convention, the two surfaces ship
as **routes/pages on the existing app**, not separate bundles or a monorepo:

- **Guest QR app** → rebuild in place of `web3/proto/guest.html`, served by the
  existing `serveGuestV3`/`serveGuestPortal` path (`/?s=<slug>`, subdomains).
- **Member portal** → a new `web3/proto/member.html` served at its own route
  (e.g. `/m` or the `rewards.` handle), same `dc-template` idiom + shared CSS tokens.
- New guest endpoints added under `/p/:slug/*` (or `/guest/*` aliases) in `index.js`,
  reusing `orderBreakdown`/availability. Contract tests live in `test/`.

Reference (do not port the runtime): `handoff_guest_ordering/` in the scratchpad
upload — docs + `reference/*.dc.html` prototypes read for values/behaviour only.
