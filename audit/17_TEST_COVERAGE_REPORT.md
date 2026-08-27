# 17 · Test coverage report

No coverage-percentage tooling ships (two-runtime-dependency rule; no dev
deps), so coverage is reported the way it is enforced here: **by surface,
with a test that fails when the surface grows unguarded.**

| Surface | Guard |
| --- | --- |
| Op kinds (153) | wiring test: queued ∪ handled ∪ AUDIT_ONLY must meet exactly |
| Owner-connection exceptions | pinned list; a 7th must justify itself in the test |
| Manual-journal composers | pinned list of 5 |
| Terminal screens/modals/forms/handlers | `test/harness.js` sweeps every generator, modal kind, form spec and exposed handler at every rank, empty + seeded |
| Ribbon/report figures | audit suite refuses any non-measured number, empty-install sweep |
| Copy vs behaviour | static vocabulary pins across all 5 pages + shared modules |
| Money identities | sale_adds_up in the DB; reconcile suite recomputes independently; loadtest verifies per stage |
| Isolation | leak-test 13 crossings in CI |
| A11y | contrast + keyboard + names measured in real Chromium, statically pinned too |
| Restore | dump→DROP→restore→compare, every CI run |

Numbers this pass: **503 tests** in `npm test` (486 pass, 0 fail, 17 skipped-with-
reason under no-browser env), +38 browser assertions when Chromium present;
both-TZ final regression 486/0 each. Critical paths (signup→sale→journal, offline replay,
void, split, redemption, credit, backup/restore, revocation) all have
end-to-end tests. Every defect ever fixed carries a named regression test —
grep "fails against the version that shipped" in CLAUDE.md for the lineage.
