# 06 · Database audit — evidence collected 2026-08-27

Run live against the harness cluster (Postgres 16) and the traded scratch
business `kashikeyo_biz_68` / `outlet_39`, plus the suite's cold-migrated
databases (every `npm test` run migrates several from nothing).

## Structural checks

| Check | Result |
| --- | --- |
| Money columns typed `real`/`double precision` | **0** — all `numeric` |
| Nullable core money on `sale` (total/net/tax/service) | none nullable |
| Orphan sale_lines / payments / sale stock_moves | **0** |
| Duplicate `op_log.op_id` | **0** (primary key makes it impossible) |
| Journals unbalanced (Σdr ≠ Σcr per journal) | **0 of 18** live; **0** across every loadtest stage |
| `sale_adds_up` constraint present | yes — `total = net+service+tax+rounding−pts_value` |
| `company_tin_iff_registered` present | yes |
| Outlet/tax-version guards (company not registered ⇒ no rate) | migrations 009/014, asserted in tax tests |
| Business-date rows | rewritten per-outlet-TZ (016), suite runs both TZs |

## Keys, constraints, indexes

- Every table carries a PK; sale/ticket/journal relations are FK'd within the
  outlet schema; `ticket_line.client_id` unique per ticket; `sale.client_id`
  partial-unique (043); `chain.member.phone` NOT NULL UNIQUE, email UNIQUE (018).
- Partial indexes on the polled tables (`guest_order`, `guest_request` open
  rows; migration 030) and `stock_move(sale_id)` — added when the 5 s poll's
  seq-scans were measured.
- Retention: `op_log` 90 d, `guest_request` 30 d (floors enforced in the
  function); **`chain.audit` is never pruned**.

## Tenant isolation (tested at the database, not the UI)

- Belt 1: schema + LOGIN ROLE per outlet, derived password, PUBLIC revoked,
  `search_path` pinned. Belt 2: FORCE RLS on `chain.*` reading `SET LOCAL`.
- PUBLIC `CONNECT` revoked on every business database and the registry
  (039 / control 003) — an outlet role is refused **at another business's
  database**, not merely at its rows.
- `npm run leak-test`: 13 crossing attempts (cross-outlet reads/writes, forged
  rank, estate without rank 5, cross-business, registry reach) — all refused;
  runs inside `test/api.test.js` every CI run, passed in this audit's runs.
- PIN hashes: column-level REVOKE (038) — an outlet role cannot `SELECT
  pin_hash` even directly; comparison happens against salted scrypt via
  `chain.pin_match()`.

## Precision & rounding

- All arithmetic lands in `numeric`; client r2() rounds to 2 dp; journal sums
  **rounded move values** (not rounded sums) so the ledger ties to `stock_move`
  to the laari; float dust ≤ 5 laari nets to 4900, larger gaps refuse
  (non-sale) or flag (`journal_imbalance`).
- Cash rounding is a property of the currency (MVR 50-laari step, USD none),
  measured against the post-redemption figure; split shares floor to the
  laari with the remainder on the last share (asserted vs Postgres at 100/3).

## Migrations

- Deterministic, checksummed, run at boot under a session advisory lock (two
  concurrent boots proven safe in `test/migrate.test.js` against a cold DB);
  cluster-wide objects (roles, extensions, databases) treat a peer's win as
  success. Fleet runner migrates registry → businesses (4-way), per-business
  failure isolates that business (503 by name), `--dry-run` lists versions.
- Cold path proven every run: suites create databases from nothing → 001–044.
- Rollback: none per-migration by design (forward-only); recovery is
  restore-beside from backup + `provision:outlet --all` — drilled in
  `test/backup.test.js` (dump → DROP → restore → every figure compared).

## One flagged row, explained

`LOYC-R-000001` on the scratch store shows payments 142.56 vs total 10.56 —
that is a sale I deliberately pushed malformed in an earlier session being
**repaired**: server recomputed the total from components, stamped
`server_audit` ("terminal total did not tie to its own components", claimed
142.56, computed 10.56), and kept the payment as the cash that physically
entered the drawer. The gap is the evidence trail working, not a defect.
