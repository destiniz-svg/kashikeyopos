# 19 · Backup & recovery audit

**Application layer (built, drilled):** per-business `pg_dump` via
`src/backup.js` — tool-version checked by name, to-disk-then-destination,
sha256 manifest, registry-recorded (`chain.backup`, control/004, failures are
rows too), watchdog condition + `kpos_backup_age_hours` (−1 = never),
schedule `BACKUP_EVERY_HOURS`, retention with newest-good-never-aged-out.
Restore: **beside by default** into a new database, roles re-provisioned
(the drill's founding finding), `--adopt` renames rather than drops,
`--over` requires both flags. CI drill: trade → dump → DROP DATABASE →
restore → every figure compared — green in every run of this audit.

RPO/RTO as configured: RPO = backup interval (24 h default; tighter needs the
schedule turned down or platform PITR); RTO = minutes (restore-beside +
provision:outlet, measured in the drill).

**Production state (the honest part):**
- Backup destination **NOT CONFIGURED** on the production service — its boot
  log says so itself. Until `BACKUP_DIR` or the five `BACKUP_S3_*` variables
  are set, production RPO is whatever Railway's own volume snapshots give,
  which cannot restore ONE business.
- Railway PITR / snapshot enablement: dashboard-only, not verifiable from
  here. BLOCKED — ENVIRONMENT LIMITATION; owed to the operator along with
  creating the bucket (open task #99 also covers an in-app full-copy
  download).
- S3 driver live round trip untested against a real bucket (signer verified
  against AWS's published SigV4 test vector); first upload is the first proof
  and DEPLOYMENT.md says so.

**Verdict:** recovery machinery is real and drilled; the production
*configuration* of it is the one outstanding operator action, and nothing in
the product pretends otherwise (the Backup card, the boot line and the
watchdog all state it).
