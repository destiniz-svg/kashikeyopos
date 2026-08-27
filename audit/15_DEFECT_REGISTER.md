# 15 · Defect register — re-audit of 2026-08-27 (commit `02371c7` baseline)

Every defect from THIS pass. The full historical register (the eleven lying
controls, the three accepted-risk closures, the four P1 money fixes, the
holding-pen family, the id-collision family, …) lives in CLAUDE.md as
narrative with its measured evidence; each historical fix carries a pinned
regression test and is not repeated here.

| ID | Sev | Title | Root cause | Fix | Regression test | Status |
| --- | --- | --- | --- | --- | --- | --- |
| R-1 | **P1** | Card/wallet settle fabricated approval evidence | `payProc.auto` drove a 780 ms fake "Waiting for the terminal…" spinner, then stamped `Math.random()` six digits into `payment.auth_ref` — no acquirer integration exists, so this was theatre plus fabricated evidence that silenced the "Unreferenced card sales" exception lane on every card sale | Spinner + `approvalCode()` + `auto` flags removed; reference is only ever operator-keyed off the real slip; blank flags honestly at close; CLAUDE.md witness corrected | `wiring: the till never fabricates an approval code` | **FIXED** |
| R-2 | **P2** | Intermittent false-red suite failures (57P01 / "Connection terminated unexpectedly") migrating between files | `test/api.test.js` pool-guard proof killed every `kashikeyo-%` backend **cluster-wide**, shooting parallel suites' live connections | Kill scoped to `datname = current_database()` | 3 consecutive full runs green (both TZ) | **FIXED** |
| R-3 | P3 | CSPRNG-absent uuid fallback fell through to `Math.random` silently (opId = idempotency key) in 3 files | Fallback predates the "said, never silent" rule `newId()` keeps | Fallback still mints (refusing mid-service costs a bill) but registers a `fault("entropy", …)` on the till and `console.error`s in the two libraries — unreachable on any browser that can run this app, and named if it ever isn't | syntax-checked; fault channel exercised by existing fault tests | **FIXED** |
| R-4 | P4 | `member.html` local guest-signal list ids use `Date.now()+rand(1000)` | Device-local ephemeral list, never a server key, ack-pruned | None needed — collision cost is one localStorage row on one device; recorded so nobody "fixes" it into the server-key class by accident | — | ACCEPTED, documented |
| R-6 | **P1** | Concurrent outlet provisions (or provision vs business-migration) 500 with "tuple concurrently updated" — INSIDE the role lock | **The mutex released before its critical section became visible.** `withRoleLock` wrapped only the `chain.provision_outlet()` statement; the advisory lock freed the moment that statement resolved, while the outer transaction held the uncommitted `ALTER ROLE` catalog tuple open through the registry round-trips that follow. The next provisioner took the freed lock, ran its own ALTER against the same cluster-wide `pg_authid` row, met the still-open transaction and died — inside the lock, where a mid-transaction caller cannot retry. Caught in the act with `log_statement=ddl`: two `ALTER ROLE outlet_1_app PASSWORD …` from two business databases, loser's CONTEXT naming the function. Production shape: two customers provisioning outlets near-simultaneously, or a signup's migration against a provision | Lock now spans BEGIN→COMMIT of the whole provision transaction (`provisionLocked()`); the migration runner's report-role work also takes the same lock (defence in depth) | api+backup pair deterministic 105-failure cascade → 144/0 ×3; static pin in `test/wiring.test.js`; full both-TZ regression | **FIXED** |
| R-5 | P3 | CLAUDE.md stale counts ("115 op kinds", "fourteen-step panel") vs code (118/153, 13 steps) | Prose drift; the wiring test, not prose, is authoritative | Sentences corrected; architecture doc records the rule | — | **FIXED** |

## Blocked — environment limitation

| Item | What is missing |
| --- | --- |
| Soak > ~4 min sustained + multi-hour memory profile | Shared dev container; stage E (4 min, 50k bills) + today's A/C/F/G show flat memory with post-rush recovery, but a true 2–4 h soak needs a dedicated staging box |
| Load figures on Railway hardware | Outbound proxy refuses the staging domain from this container; local figures are hardware-bound (LOAD.md says so in its own header) |
| S3 backup driver live round-trip | No bucket reachable from CI; signer verified against AWS's published SigV4 test vector; first real upload is the first proof (DEPLOYMENT.md states this) |
| Real thermal printer / cash drawer hardware | No device attached; byte-composition proven (`test/print.test.js`), transport claims are honest (spooled ≠ done) |
| PITR / Railway volume snapshot enablement | Dashboard-only actions; still owed to the operator (see 19) |
| Screen-reader driven pass | No AT available here; computable a11y (contrast, keyboard, names) measured green on all 3 services |
