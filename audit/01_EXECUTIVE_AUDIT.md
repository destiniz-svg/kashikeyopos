# 01 · Executive audit — KashikeyoPOS, 2026-08-27

Second full production-readiness pass over this build (the first ran earlier
in its life and drove ~100 recorded fix campaigns; CLAUDE.md is that ledger).
This pass re-derived the architecture from source at `02371c7`, re-ran every
executable check, swept again for fabricated functionality, and fixed what it
found before signing anything.

## What this pass found (all fixed, all regression-pinned)

1. **R-1 · P1 — the till fabricated payment evidence.** Card/wallet settle
   showed a fake 780 ms "Waiting for the terminal…" spinner, then stamped a
   `Math.random` six-digit approval code into the payment's reference — the
   field the settlement screen matches against the acquirer's statement, and
   the field the "Unreferenced card sales" exception lane polices. No acquirer
   integration exists; the control was permanently silenced by invented
   evidence. Removed; blank references now flag honestly at close.
2. **R-6 · P1 — the provisioning mutex released before its write committed.**
   Two outlets provisioning concurrently (or a signup's migration against a
   provision) made the *locked* party die with `tuple concurrently updated`,
   unretryably — a transient 500 during onboarding. Deterministically
   reproduced, caught in the act with DDL logging, fixed by making the lock
   span BEGIN→COMMIT. 3/3 green after; the whole-cluster race class now has a
   static pin.
3. **R-2 · P2** — the test suite's pool-guard proof killed backends
   cluster-wide, shooting parallel suites (the source of every "flaky test"
   this build had). Scoped; three consecutive full runs green.
4. **R-3 · P3** — CSPRNG-absent id fallback made loud, per the build's own
   "said, never silent" rule. **R-5 · P3** — stale doc counts corrected.

## What was verified sound (evidence in files 04–12)

Money: one-transaction sale chain, DB-enforced journal balance, independent
recomputation green, zero unbalanced journals across live data and four load
stages. Tenancy: two belts + registry, 13-crossing leak test in CI. Offline:
13 scenarios mechanised, replay idempotent under load, dead-letter lane real.
No demo data reachable from production (double-fenced scripts); no dead
buttons (harness sweeps every handler); no fake success left standing —
R-1 was the last, and the sweep that found it is now a pinned test.

## Verdict

**PRODUCTION READY — 89/100** (weighted, see 14) for its sold model, with
**one operator action outstanding**: production's backup destination is not
configured (the product's own boot line says so). The machinery is built and
CI-drilled; a destination nobody set protects nobody.

Honest remainders: Railway-hardware load numbers, multi-hour soak, S3 live
round-trip, screen-reader pass, independent pentest — each BLOCKED by
environment and named in 15, none concealed.
