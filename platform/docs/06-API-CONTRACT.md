# API contract

Implemented in `backend/src/routes.js`. Base path `/api`. JSON in, JSON out.
Auth is `Authorization: Bearer <token>` on everything except `/auth/pin`.

---

## Health

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | Liveness. Always 200 if the process is up. |
| GET | `/readyz` | **Railway healthcheck.** 503 unless the control plane answers. |

## Auth

**POST `/api/auth/pin`** → `{ outletId, pin, deviceId? }`

```json
{ "token": "…", "name": "Aishath", "rank": 4, "outletId": 3 }
```

401 on failure. A wrong PIN increments the failed count on every unlocked
account at that outlet; 5 failures lock for 15 minutes. The token carries
`{ o: outletId, r: rank, s: staffId, d: deviceId, exp }` and is HMAC-signed with
`SESSION_SECRET`.

**GET `/api/me`** → the decoded context.

## Snapshot — what the guest portals read

**GET `/api/outlet/:outletId/snapshot`**

```json
{
  "v": 4, "at": 1755100000000,
  "outlet": { "id": 3, "name": "…", "currency": "MVR", "service_pct": 10, "tables": 12 },
  "tax":    { "code": "GGST", "rate": 8 },
  "items":  [ { "id": "…", "name": "…", "category": "…", "price": 0, "off_menu": false } ],
  "tickets":[ { "id": "…", "table_no": "4", "split": 0, "covers": 2, "status": "open",
                "lines": [ { "name": "…", "qty": 1, "price": 0, "sent": true } ] } ],
  "stages": [ { "ticket_id": "…", "station": "grill", "stage": "In the kitchen",
                "target_mins": 12, "fired_at": "…" } ]
}
```

`cache-control: no-store`. **No costs, no margins, no staff records** — the
projection does not contain them, so a compromised guest device cannot leak
them. The tax rate is the version effective today, resolved by date.

Version this shape. `v` exists so a portal can refuse a shape it does not
understand rather than silently reading a fossil.

## Guest intent

**POST `/api/outlet/:outletId/guest/order`**
→ `{ table, lines[], promo?, name?, phone?, opId }`
→ `201 { id, at, status: "awaiting till" }`

Idempotent on `opId`. Creates a `guest_order` row; it does **not** create a
ticket. The till accepts it.

**POST `/api/outlet/:outletId/guest/request`** → `{ table, kind, detail? }`
`kind` ∈ `server | bill | water | help`. → `201 { id, at }`

## Sync

**POST `/api/outlet/:outletId/sync/push`** (rank ≥ 2)
→ `{ ops: [ { opId, kind, payload, at } ] }`
→ `{ results: [ { opId, result } | { opId, replay: true, result } | { opId, error } ] }`

Ops are applied in order, each in the enclosing transaction. `kind` ∈
`sale | journal | stock_count | guest_order_accept`. An unknown kind is an
error, not a silent skip.

The `sale` op is the whole chain in one payload: header, lines, payments,
stock moves and the journal. The server allocates the receipt number — the
client never sends one.

**GET `/api/outlet/:outletId/sync/pull?since=<ms>`** (rank ≥ 2)
→ `{ now, ops[], guestOrders[], guestRequests[] }`

## Settings, access and the trail

**GET `/api/outlet/:outletId/settings`** (rank ≥ 3) · **PUT** (rank ≥ 4)
→ `{ outlet, tax[], fixed: { fields, why }, canEdit }`

`fixed.fields` are `id`, `code`, `schema_name` and `db_role`: the tenancy model
itself. The outlet role is never granted UPDATE on `chain.outlet` — a policy
decides which ROWS you may write, never which COLUMNS — so the settings a
manager may change go through `chain.set_outlet_settings()`.

**POST `/api/outlet/:outletId/settings/tax`** (rank ≥ 4)
`{ code, rate, from }`. A rate is ADDED with an effective date, never edited,
and never backdated: every sale records the rate it was rung up at, so a rate
that took effect last week would restate receipts already issued.

**GET `/api/outlet/:outletId/access`** (rank ≥ 3)
→ `{ ladder[], sessions[], lockedOut[], canEnd, myRank }` — who is signed in
right now, on which device, and for how much longer.

**POST `/api/outlet/:outletId/access/sessions/:id/end`** (rank ≥ 3)
Takes effect on that terminal's next request, not when its token expires.

**GET `/api/outlet/:outletId/audit`** (rank ≥ 3)
`?action=&entity=&actor=&scope=&from=&to=&text=&before=&limit=`
→ `{ entries[], nextBefore, appendOnly }`. Paged by CURSOR, not offset: a trail
is read newest-first while rows are still arriving at the top of it.

**GET `/api/outlet/:outletId/audit/facets`** (rank ≥ 3) — the filter values that
are actually present.

**GET `/api/outlet/:outletId/audit.csv`** (rank ≥ 3) — the export, which is
itself written to the trail.

## Devices

**GET `/api/outlet/:outletId/devices`** (rank ≥ 2)
→ `{ devices[], paired, silent[], unpairedOpsToday, opsByKind[], opsByHour[],
outbox: { known: false, why }, kinds[], canManage, thisDevice }`

`outbox.known` is always false and that is the point: writes waiting to be
replayed are held on each till until it reconnects, so the server cannot count
them. `silent[]` is the honest signal — paired devices not heard from while
others are talking.

**POST `/api/outlet/:outletId/devices`** · **POST `…/:id/code`** ·
**PATCH `…/:id`** · **POST `…/:id/revoke`** · **POST `…/:id/restore`** (rank ≥ 3)

Revoking ends every open session bound to that device, immediately.

**POST `/api/outlet/:outletId/devices/claim`** — **no session**
`{ code, platform?, appVersion? }` → `{ id, label, kind }`

Deliberately unauthenticated: a machine has to be usable before it is trusted,
so the pairing screen sits in front of the PIN pad. The code is single-use, 30
minutes, manager-issued and scoped to one outlet. Pairing IDENTIFIES a device;
it does not authenticate one, and whoever claims it still needs a PIN.

## Estate

**GET `/api/estate/day?date=YYYY-MM-DD`** (rank 5)
→ `{ date, outlets: [ { outlet_id, outlet, code, takings, revenue, covers,
bills, cogs, tax, discount, service, last_sale_at } ] }`

`takings` is what the guests paid, tax inclusive; `revenue` is goods net of tax
and net of the discount, which is what the P&L recognises. Both are returned
because they are different numbers and calling either of them "sales" is how
the estate table and the P&L come to disagree by exactly the GST. `covers` is
PEOPLE — it was the count of bills until the estate was built, which made every
per-head figure wrong by the average party size.

**GET `/api/estate/overview?date=YYYY-MM-DD`** (rank 5)
→ the whole Owner Dashboard (`11-OWNER-DASHBOARD-SPEC.md`): `{ date, fellBack,
target, briefing, figures, series, outlets[], pnl, position, waiting[],
controls[], reconciliation }`. `date` is the day the server had figures for and
`fellBack` says whether that differs from the day asked for.

**GET `/api/estate/targets`** (rank ≥ 3) · **PUT `/api/estate/targets`** (rank 5)
→ `{ foodCostTargetPct, labourTargetPct, primeTargetPct, weights, setAt }`.
The yardstick the dashboard scores by, readable by anyone it judges. A null
food cost target means nobody has chosen one, and the score does not deduct for
food cost while it is null.

Aggregates only, through the read-only `kashikeyo_report` role, audited as
group scope. There is no endpoint that returns another outlet's rows.

## Errors

`{ "error": "message" }` with the status. 5xx never returns the database
message — it names schemas and roles. Log it server-side instead.

## Client

`design/kashikeyo-api.js` implements all of this: `signIn`, `onSnapshot`,
`queue`, `flush`, `pending`, `guestOrder`, `guestRequest`, `estateDay`,
`canApprove`, `local`. Port it to TypeScript; keep the semantics exactly —
particularly that `queue()` returns instantly and only acknowledged ops leave
the outbox.
