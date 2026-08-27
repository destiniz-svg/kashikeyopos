# 03 · Feature audit matrix — verified 2026-08-27, commit `02371c7`

Classification legend: **WORKING** (proven by automated test and/or a driven
browser run recorded in CLAUDE.md), **PARTIAL**, **AUDIT-ONLY BY DESIGN**
(op recorded on the trail, no state change — named in `AUDIT_ONLY`, screens
say so), **NOT BUILT** (honestly absent, screen states it). Nothing below is
MOCKED: the fake-success class (fake print success, invented backup shelf,
demo trial balance, "invite by SMS", permission matrix that wrote nothing)
was found in earlier audit rounds and each is either real now or says what is
true — pinned by `test/wiring.test.js` / `test/audit.test.js`.

## Service

| Feature | Where | Server side | Status | Evidence |
| --- | --- | --- | --- | --- |
| Floor plan, tables, zones, merge/split shares | POS Floor | `ticket*` ops, `openTicket` find-or-create by table+split | WORKING | api/chain tests; 2-browser floor share ≈4 s |
| Order lifecycle (rung 0–3, KDS bump/recall, fire course) | POS/KDS/Orders | `kds_*`, `fulfil_stage`, `ticket_line.ready_at` | WORKING | api tests; stage cascade pinned |
| Settle: cash/card/wallet/QR/transfer/credit, FX tender, tips, split shares, rounding | Pay screen (only settle path) | `applySale()` one transaction | WORKING | chain/api/reconcile tests; split-penny vs Postgres |
| Void settled sale / refund w/ stock return | Orders | migration 029, negating moves | WORKING | api test 134/135 class |
| Receipt/KOT printing + drawer kick | kpos-print | WebUSB/serial/LAN relay (SSRF-fenced), spool state honest | WORKING / spool honest | print tests, byte-level |
| Receipt & statement sharing (email/WhatsApp/Viber/link, walk-ins, closed tickets, typed number) | Settle + Orders | `share_token`, `client_id` (043), `/r/ /st/` doc pages | WORKING | driven in Chromium this week; api tests |
| Guest QR portal (menu, order, requests, tracker) | guest.html | table-scoped token, projection carries no cost/staff | WORKING | api + responsive tests |
| Member card (sign-in code, invitations, points, receipts) | member.html | migrations 017/018/020, rate-limited | WORKING | api/e2e/limit tests |
| Reservations | Service | reservation ops | WORKING (basic) | harness sweep |

## Kitchen & stock

| Feature | Status | Evidence |
| --- | --- | --- |
| Menu master: sections (040), dishes, tags/heat (041), photos, add-ons, batches (032), CSV import | WORKING | round-trip drives in CLAUDE.md; menuvisuals tests |
| Recipes & costing, yields per outlet (031), server-side qty re-derivation | WORKING | vm-vs-server agreement to 6 places |
| Inventory: WAC, GRN, counts, transfers, write-offs, negative-stock naming | WORKING | reconcile tests |
| Purchasing: PO→GRN→invoice match, supplier resolve-by-name, vendor_upsert converges | WORKING | api tests; import replay proof |
| Production/batches | WORKING | 032 + tests |

## Business

| Feature | Status | Evidence |
| --- | --- | --- |
| Accounting: journal per sale, trial balance, bank rec (real opening), periods from business date | WORKING | audit.test.js empty-state sweep; golden reconcile |
| Settlement: 4 processors, per-day batches, advice import, reversals never reopen | WORKING | chain tests |
| Payroll: MRPS 7+7, net wages to 2400 (023), service pool | WORKING | reconcile tests |
| Reports & CSV exports | WORKING | reports reconcile to journal in tests |
| Analytics/CFO cards | WORKING (measured, zero on empty) | audit.test.js "no invented figures" |
| Loyalty programme: outlet-published rates/ladder/rewards, liability 2350 | WORKING | audit tests (4 added at fix time) |
| Credit: chain-wide `credit_used`, till pre-block, overrun stamped | WORKING | api tests |
| Staff & roles: real staff writes via endpoints, PIN self-change (037), device enrol/claim/revoke | WORKING | end-to-end verified |
| Permission matrix | READ-ONLY BY DESIGN (rank is the only gate; screen says so) | wiring test pins copy |
| Backups | WORKING server-side (file/S3, registry-recorded, watchdog); **no in-till button by design**; store setup file export/import shipped | backup.test.js drill; task #99 (full copy download in-app) still open |
| Reset / restore from till | Files a request / names where done | wiring test rule |

## Platform

| Feature | Status | Evidence |
| --- | --- | --- |
| Signup → verified email → business database created → 3-step application → shop setup | WORKING | e2e + signup browser test; driven twice this week |
| Multi-business accounts (`?business=`), refused-by-name for others' | WORKING | e2e test |
| Handles: registry-owned, rename+301, reserved names | WORKING | handle tests |
| Fleet migrations, `requireAtHead` 503, adopt-install | WORKING | fleet/migrate/adopt tests |
| Mission Control: registry-read dashboard, licence push, provision (Railway API, off by default) | WORKING | panel/provision tests |
| Watchdog + /metrics | WORKING | watch tests |

## Deliberately absent (screens say so)

Viber transport (recorded, not wired) · SMS (none — copy pinned against
claiming it) · online payment collection · points expiry · per-field CRDT merge
(LWW by lamport documented) · scheduled report emails · in-till whole-database
restore button. `ticket_status` and `menu_section_*` handlers kept for old
outboxes; call sites gone.
