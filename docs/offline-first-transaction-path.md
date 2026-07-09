# Offline-First Transaction Path

This is the front-end migration path for a Plattoo-style POS flow: the cashier can create orders and payments without internet, the UI updates instantly from IndexedDB, and the cloud sync engine pushes changes when the connection returns.

## New Source Modules

- `frontend/offline/db.js` - Dexie IndexedDB schema and cloud session helpers.
- `frontend/offline/syncQueue.js` - idempotent operation queue helpers that match the existing `/api/ops` backend contract.
- `frontend/offline/syncManager.js` - push `/api/ops`, pull `/api/pull`, and merge remote entities by row version.
- `frontend/transactions/createTransaction.js` - local-first Save Order / Create Transaction path.

These files are a source-level reference implementation. The current deployed app is a prebuilt/minified `web/dist` bundle, so this code should be wired into the real frontend source project before producing the next `web/dist` build.

## Save Order Flow

The old online-first flow is:

1. Cashier taps order/pay.
2. Frontend calls server.
3. Server writes order.
4. UI updates only if the request succeeds.

The new offline-first flow is:

1. Cashier taps order/pay.
2. `createTransaction()` writes order and payments to IndexedDB immediately.
3. UI renders from IndexedDB, so the order appears instantly.
4. Stock/customer points are updated locally.
5. Sync ops are queued in `syncQueue`.
6. `syncNow()` pushes queued ops when online.
7. Server responds with row versions; pull sync merges canonical cloud state back into IndexedDB.

## Example Integration

```js
import { createTransaction } from "./frontend/transactions/createTransaction.js";
import { startSyncLoop } from "./frontend/offline/syncManager.js";
import { saveCloudSession } from "./frontend/offline/db.js";

await saveCloudSession({
  serverUrl: "https://kashikeyopos-production.up.railway.app",
  token: cloudToken,
  slug: workspaceSlug,
  register: "R1"
});

startSyncLoop({ intervalMs: 15000 });

async function onPayAtCounter(cart, customer, table, settings) {
  const tx = await createTransaction({
    cart,
    customer,
    table,
    orderType: "dinein",
    payments: [{ method: "counter", amount: cartTotal }],
    settings,
    register: "R1"
  });

  showOrder(tx.order);
}
```

## Backend Compatibility

The existing backend already supports the core shape:

- `POST /api/ops` accepts idempotent `opId` batches.
- `GET /api/pull?since=<rowver>` returns ordered entity changes.
- `ops` table prevents replay.
- `entities.rowver` acts as the pull cursor.
- Stock and customer balances can use server-arbitrated deltas.

## Important Rules

- Use UUIDs for all client-created entities.
- Never wait for the server before showing a locally created order.
- Use temporary `LOCAL-R1-...` numbers while offline.
- Let the server assign canonical numbers later if required.
- Store auth/session data locally, but pause sync if the cloud token is missing or invalid.
- Do not cache `/api` or `/p` responses in the service worker.

## Next Implementation Step

Replace the current POS checkout handler with `createTransaction()` and make Orders/Kitchen screens render from IndexedDB first. After that, migrate product/customer/table/settings reads to IndexedDB and use `syncManager` to keep them fresh.
