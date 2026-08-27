# 20 · Final sign-off

Every gate from the audit brief, with where its evidence lives:

| Gate | State | Evidence |
| --- | --- | --- |
| No P0 defects | ✅ none found | 15 |
| No unresolved P1 | ✅ R-1, R-6 fixed + pinned | 15, 16 |
| Accounting reconciles | ✅ | 07, reconcile suite, loadtest money checks |
| Database integrity | ✅ | 06 (live checks: 0 orphans, 0 unbalanced, 0 float money) |
| Tenant isolation | ✅ | leak-test 13/13 in CI; belts verified |
| AuthN/AuthZ | ✅ | 09, 10 |
| Offline transactions survive | ✅ | 05 |
| Sync idempotent; duplicates impossible | ✅ | op_id PK; loadtest "no duplicate op landed twice" |
| Payment state reliable | ✅ | one-op sale; R-1 made evidence honest |
| Inventory reconciles | ✅ | 08 (ledger-vs-1200 = 0.00) |
| Reports reconcile | ✅ | reports read the journal; audit suite refuses invented figures |
| Shift/day close reconcile | ✅ | drawer expectation recomputed in tests |
| No demo data in production | ✅ | double-fenced scripts; audit tests refuse seeded figures |
| No fake functionality | ✅ | R-1 removed the last; wiring pins the class |
| No dead buttons | ✅ | harness sweeps every handler; "control does what it says" tests |
| No known critical security defects | ✅ | 09; one unexplained prod 401 instrumented, stated |
| Critical-path automation passes | ✅ | 502 tests + 38 browser assertions, both TZs |
| Migrations work (cold + warm + concurrent) | ✅ | every CI run + migrate tests |
| Deployment works | ✅ | production deploy of `02371c7` observed SUCCESS today |
| Rollback understood | ✅ | 18 |
| Backup/recovery verified | ✅ machinery (CI drill) / ⚠️ production destination unset — operator action | 19 |
| Stress testing completed | ✅ this environment; Railway figures BLOCKED | 11 |
| Soak | ⚠️ 4-min max here; longer BLOCKED | 11, 15 |
| Browser/device workflows | ✅ Chromium-driven; SR pass open | 12 |
| Error handling tested | ✅ | refusals-by-name doctrine + tests |
| Production config reviewed | ✅ | 18 (via Railway API, no secret values read) |

**Signed off as PRODUCTION READY (89/100)** with the backup-destination
operator action and the BLOCKED items carried openly. Fable, auditing 2026-08-27.
