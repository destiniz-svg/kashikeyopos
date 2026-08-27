# 04 · End-to-end test report

Evidence per journey, this pass unless noted. "Driven" = a real Chromium
session against the shipped pages on the local harness (Postgres 16, three
services), with the database inspected afterwards.

| ID | Journey | Result | Evidence |
| --- | --- | --- | --- |
| E2E-1 | Signup → email code → business database created → 3-step application → shop setup → till | PASS | `test/e2e.test.js` (12/12) + `test/signup.test.js` (real Chromium, drives the shipped form); driven twice more this week for the new onboarding (unregistered + TGST businesses, DB checked: TIN, brand jsonb, tax_version 16.00) |
| E2E-2 | Sign in at till (PIN), ring a bill with member + redemption + credit tender, journal balances in THAT business's DB and nobody else's | PASS | e2e suite; tenancy suite (2 businesses, cross-refusals) |
| E2E-3 | Order lifecycle: open table → lines → KOT → KDS bump → ready → served → pay (split, FX, tip, rounding) → receipt → close | PASS | chain/api suites; invalid transitions (pay paid, void voided, negative qty, over-limit credit) each refused or flagged by name |
| E2E-4 | Two terminals, one outlet: table w/ lines ~4 s, settle leaves the other floor ~5 s, dish ~4 s, setting ~1–6 s | PASS | measured 2-browser drives (CLAUDE.md tables); `buildLive` tests |
| E2E-5 | Offline evening: queue everything, reconnect, chunked drain, zero duplicates | PASS | stage-D drain measurements; replay tests |
| E2E-6 | Receipt/statement share: walk-in WhatsApp, member, typed number, closed ticket, expired statement = 410 not 404 | PASS | driven this week; api tests |
| E2E-7 | Staff lifecycle: create → sign in → suspend → same PIN refused; device enrol → claim → revoke → keypad refused | PASS | verified end-to-end against live outlet (task #48 record) |
| E2E-8 | Sign out ≠ handover: revocation immediate (200 → 401), undelivered work named | PASS | measured; session tests |
| E2E-9 | Session revoked under a live till: server's own sentence on the lock screen, outbox survives | PASS | driven (task this week); wiring test |
| E2E-10 | Setup file: export 8 records, delete store config, import restores exactly, 18 settled sales untouched; hostile file (post_journal/sale/settle_credit) refused 3× by name | PASS | driven + api tests |
| E2E-11 | Backup drill: trade → dump → **DROP DATABASE** → restore → every figure identical | PASS | `test/backup.test.js`, every CI run |
| E2E-12 | Restore into fresh cluster: roles absent → `/readyz` 503 **names the outlet + remedy**; `provision:outlet --all` → instant green | PASS | api test (grant revoked live, 503 asserted, recovery asserted) |
| E2E-13 | Guest QR: scan → table token → order → floor board; token cannot cross tables/planes | PASS | api tests incl. token-plane (`typ`) checks |
| E2E-14 | Rank boundaries: cashier vs manager vs owner at API level (not UI hiding) | PASS | leak-test + atLeast/RLS tests; 403 with wording |
| E2E-15 | Onboarding on a phone (390px): no sideways scroll, targets ≥44px, mobar orientation | PASS | responsive suite + driven this week |

Invalid/edge inputs exercised: zero/negative/huge price, decimal qty, deleted
ingredient in recipe (skipped by name), duplicate ids across devices
(CSPRNG ids; 20k-draw collision test), duplicate phone/email on members
(refused by name), hostile item/member names render as text (React escaping
verified in-browser), oversized logo (refused by name), wrong file type
(refused by name).
