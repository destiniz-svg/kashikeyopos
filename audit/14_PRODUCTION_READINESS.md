# 14 · Production readiness — scored 2026-08-27

Scores are argued from evidence recorded in these twenty files, not vibes.
The gate rule applies: the weighted average cannot override a category with a
standing critical defect. No P0 stands; every P1 found in this pass is fixed
and regression-pinned.

| Category | Weight | Score | Basis |
| --- | --- | --- | --- |
| Architecture | 10% | 92 | Two-belt isolation, registry tenancy, one-seam writes, pinned exception lists; LWW merge is the stated ceiling |
| Functionality | 15% | 88 | Full journey matrix green; deliberate absences honest (no acquirer/gateway integration) |
| Accounting | 15% | 93 | One-transaction chain, DB-enforced balance, independent recompute green, repair-and-flag; R-1 (fabricated evidence) found and fixed THIS pass |
| Database | 10% | 92 | Constraints/RLS/precision verified live; forward-only migrations with drilled restore |
| Offline / sync | 15% | 90 | 13 scenarios mechanised + tested; idempotency proven under load; LWW documented |
| Security | 10% | 88 | Controls verified live; no vault, no external pentest, one unexplained prod 401 instrumented |
| Performance | 10% | 85 | 0-error load at 24 tills, drain ceiling measured & bounded; Railway-hardware numbers BLOCKED |
| UX / UI | 5% | 90 | Measured a11y across 3 services; workflow speed engineered; SR pass open |
| Reliability / ops | 5% | 84 | Watchdog, readyz, drills; production backup destination still unset (operator action) |
| Testing / CI | 5% | 92 | 502 tests + browser suites, per-surface guards, both TZs; suite's own cross-suite races found & fixed this pass |

**Weighted: 89.6 → reported 89 / 100.**

**Verdict: PRODUCTION READY** for its sold model (direct, small/multi-outlet,
Maldives), **conditional on one operator action**: set the production backup
destination (BACKUP_S3_* or BACKUP_DIR) — the machinery is built, drilled and
watchdogged, but a destination nobody configured protects nobody, and the
product itself says so on its own boot line and Backup card.
