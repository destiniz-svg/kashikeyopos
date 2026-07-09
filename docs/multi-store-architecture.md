# Multi-Store Architecture

KashikeyoPOS now supports one company/workspace with multiple physical stores or branches. Existing single-store installs continue to use the default store id `main`.

## Model

- `orgs` = company/workspace/account.
- `stores` = physical stores/branches inside one org.
- `entities` = synced business objects. Store-scoped rows carry `data.storeId`.
- Shared rows omit `storeId` or use `global`.

Shared by default:

- `settings`
- `customers`
- `units`
- `categories`
- `vendors`

Store-scoped when `storeId` is present:

- `orders`
- `payments`
- `tables`
- `zones`
- `waiterCalls`
- `products` when branch-specific stock/catalog is needed
- operational entities such as shifts, expenses, wastage, GRNs and purchase orders

## API

### List Stores

```http
GET /api/stores
Authorization: Bearer <token>
```

### Create or Update Store

```http
POST /api/stores
Authorization: Bearer <token>
Content-Type: application/json

{ "id": "airport", "code": "AIR", "name": "Airport Cafe", "address": "Terminal" }
```

### Select Store

Returns a new token scoped to the selected store.

```http
POST /api/select-store
Authorization: Bearer <token>
Content-Type: application/json

{ "storeId": "airport" }
```

Response:

```json
{ "token": "...", "register": "R2", "storeId": "airport" }
```

### Sync Ops

`POST /api/ops` accepts a root `storeId` and each op can also carry `storeId`.

```json
{
  "storeId": "airport",
  "ops": [
    {
      "opId": "uuid",
      "storeId": "airport",
      "puts": [
        { "kind": "orders", "id": "order-id", "data": { "id": "order-id", "storeId": "airport" } }
      ]
    }
  ]
}
```

### Pull Store Slice

```http
GET /api/pull?since=0&storeId=airport
Authorization: Bearer <store-scoped-token>
```

The pull response includes global/shared entities plus entities for the selected store. Store A orders do not appear in Store B pulls.

### Guest Links

Guest endpoints accept a store selector:

```text
/?s=<workspace>&storeId=airport&t=A1
/?s=<workspace>&storeId=airport&c=<customerId>
/p/<workspace>/boot?storeId=airport
/p/<workspace>/order
```

Guest order bodies can include `storeId`:

```json
{ "storeId": "airport", "items": [{ "pid": "p2", "qty": 1 }], "table": "A1" }
```

## Offline Frontend

The source modules under `frontend/offline` and `frontend/transactions` now carry `storeId` through:

- IndexedDB tables and indexes
- auth/session storage
- queued ops
- push headers via `X-Store-Id`
- pull query params via `storeId`
- local order/payment records
- stock/customer deltas

The runtime `web/dist/offline-bridge.js` also preserves store context for queued writes from the current minified POS shell. It checks, in order:

1. request body `storeId`
2. URL `storeId`, `store`, or `st`
3. `X-Store-Id` header
4. `window.KashikeyoStoreId`
5. `localStorage.kashikeyo.storeId`
6. fallback `main`

A future store switcher in the UI can call:

```js
window.KashikeyoOffline.setStoreId("airport");
```

## Smoke Test

`smoke.js` now includes an 11th check:

- create `airport` store
- select store and receive store-scoped token
- push airport catalog/table
- place airport guest order
- confirm airport register pulls it
- confirm main store pull does not receive it
