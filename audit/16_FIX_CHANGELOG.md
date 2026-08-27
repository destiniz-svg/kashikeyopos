# 16 · Fix changelog — this audit pass

1. **R-1 (P1)** `app/index.html`: removed the simulated acquirer round-trip
   (780 ms spinner, "Waiting for the terminal…", auto-advance) and the
   `Math.random` approval-code minter; the payment reference is only ever
   operator-keyed; copy now says what a blank one costs everywhere;
   `auto:` capability flags removed from the processor contracts; CLAUDE.md
   witness paragraph rewritten. Regression: `wiring — the till never
   fabricates an approval code`.
2. **R-2 (P2)** `test/api.test.js`: pool-guard kill sweep scoped to
   `current_database()` (was cluster-wide, shooting parallel suites).
3. **R-3 (P3)** `app/index.html` `opId()`, `app/kashikeyo-api.js`,
   `app/guest-bridge.js`: CSPRNG-absent fallback now *says so* (Diagnostics
   fault on the till, console.error in the libraries) instead of degrading
   silently.
4. **R-5 (P3)** CLAUDE.md stale counts corrected (op kinds, onboarding steps).
5. **R-6 (P1)** `src/provision.js`: the cluster role mutex now spans the
   WHOLE provision transaction (BEGIN→COMMIT via `provisionLocked()`), not
   just the `chain.provision_outlet()` statement — the lock used to free
   while the transaction still held the uncommitted ALTER ROLE tuple, so the
   next provisioner took the lock and died unretryably on "tuple concurrently
   updated". Deterministically reproduced (parallel-suite bisect, 105-failure
   cascade), caught in the act with `log_statement=ddl`, fixed, and verified
   green ×3. `src/scripts/migrate.js`'s report-role writer also takes the
   same lock (defence in depth). Static pin: `wiring — the provision lock
   wraps the transaction, not the statement`.
6. Audit deliverables `audit/01–20` added to the repository.

Verification: full suite under TZ=UTC and TZ=Indian/Maldives; browser suites
(a11y 6/6 incl. panel+site, responsive, signup, menuvisuals); leak-test in
pipeline; load stages A/C/F/G re-run with money checks green.
