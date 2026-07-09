# KashikeyoPOS Cloud

Postgres-backed KashikeyoPOS cloud sync for Railway.

This build serves the existing POS/PWA from `web/dist` and adds a Node/Express sync server. Tills pair from Admin -> Cloud Sync, push menu/tables/zones/customers to Postgres, pull remote orders in real time, and expose public customer/table links at `/p/:slug/...`.

## What This Build Supports

- Create workspace / sign in from the POS Cloud Sync screen.
- Multi-store companies: one workspace can operate multiple physical stores/branches.
- Store-scoped sync for orders, payments, tables, zones, waiter calls and branch-specific products/stock.
- Shared customer/settings data across stores where appropriate.
- Sync products, customers, tables, zones, settings, orders, shifts, stock and logs through `/api/ops` and `/api/pull`.
- Queue till changes offline in the browser and flush them when the till comes back online.
- Customer and table links load menu/catalog data from Postgres.
- Guest orders are written as synced `orders` entities, so the main POS pulls them into Orders/Kitchen.
- Guest waiter calls are written as synced `waiterCalls` entities and trigger the till through SSE/polling.
- Guest profile boot returns name, visits, spent, points, credit balance and recent orders.

See `docs/multi-store-architecture.md` for the multi-store API and data model.

## Railway Walkthrough

1. Create or open the Railway project.
2. Set the region to Singapore if your users are in Maldives/South Asia.
3. Add a Postgres database service in the same Railway project.
4. Open the web service -> Variables.
5. Confirm the web service has either `DATABASE_URL`, `POSTGRES_URL`, `RAILWAY_DATABASE_URL`, or the standard `PGHOST` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` variables from the Postgres service.
6. Add `JWT_SECRET` with a long random value.
7. Deploy from GitHub branch `main`.
8. Railway liveness healthcheck should use `/`, not `/api/health`.
9. After deployment, open `/api/health` manually and confirm it returns `ok: true` and `db: true`.

Healthy response:

```json
{ "ok": true, "service": "kashikeyo-cloud", "db": true, "dbEnv": { "databaseUrl": true, "pgEnv": false } }
```

If `/api/health` returns `db: false` or a phone shows `order failed: ECONNREFUSED`, the web service cannot reach Postgres. Attach a Railway Postgres service to the same project, then add or reference its database URL in the web service variables and redeploy.

Expected monthly Railway cost is roughly USD 15-27 depending on usage and database size.

## Free Testing Alternative

For free testing only, this same server can run on Render with a Neon Postgres database:

1. Create a Neon project in Singapore and copy its Postgres connection string.
2. Create a Render web service from this GitHub repo.
3. Add `DATABASE_URL` with the Neon connection string and add `JWT_SECRET`.
4. Deploy and open the Render URL.

Render free services sleep after idle time, so this is not suitable for a live cafe till.

## Test Flow

After deployment:

1. Open the POS.
2. Go to Admin -> Cloud Sync -> Create workspace.
3. Confirm the POS shows a workspace slug and register.
4. Add or confirm products, tables, zones and customers.
5. Open a customer/table link on a phone.
6. Confirm the guest portal loads the menu and customer stats.
7. Place an order from the phone.
8. Confirm the main POS receives the order in Orders/Kitchen without manual import.
9. Press the guest call button and confirm the till receives the waiter call.
10. Create/select another store through the API and confirm pulls are isolated by `storeId`.

You can also run:

```bash
BASE=https://your-service.up.railway.app node smoke.js
```

The smoke test covers workspace creation, catalog sync, second-register pull, guest boot, guest order, POS pull, order status sync, guest status polling, waiter-call sync, numeric customer IDs and multi-store isolation.

## GitHub Pages Standalone Build

The Railway build is the cloud/server build. Your GitHub Pages standalone POS can still work separately, but it does not provide multi-device cloud sync unless it is pointed at the Railway backend through Cloud Sync.

To update a Pages-only site, upload the standalone Pages `index.html`, `sw.js`, manifest and icons to the Pages repository. Do not use the Railway `Dockerfile`, `index.js` or `schema.sql` in the Pages repo.

## Notes

- Do not run a Vite build for this package. The frontend is already built in `web/dist`.
- The server initializes `schema.sql` automatically on boot.
- `npm start` runs `guest-sync-patch.js`, which patches the uploaded static bundle so guest checkout posts to `/p/:slug/order`, then starts `index.js`.
