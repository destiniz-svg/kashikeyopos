# 18 · Deployment readiness

- **Build**: Dockerfile (node:22-alpine + postgres18-client fallback chain),
  `npm ci --omit=dev`, no build step, runs as `node` user, nothing written to
  the image at runtime.
- **Boot**: migrations in-process under an advisory lock; production **exits**
  rather than serving a half-migrated schema; DB-wait separated from migration
  failure (DB_WAIT_MS 90 s) so a Postgres restart is not a crash loop.
- **Health**: `/readyz` proves each outlet's own login role can serve (not the
  owner connection), names failures with remedies, fail-slow/recover-fast;
  Railway healthcheck wired to it; restart ON_FAILURE ×3.
- **Secrets**: env only, none in source (swept); refused when short; dangling
  `${{ref}}` detected (email + panel handover); model of record in
  DEPLOYMENT.md. No secret values appear in logs or this audit.
- **Rollback**: forward-only migrations; rollback = redeploy previous image +
  restore-beside if schema moved; documented.
- **Fleet**: `requireAtHead` 503s a stale business; per-business failure
  isolates; adopt path ordered before code reaches an install.
- **Production today** (observed via Railway API this session): deploy of
  `02371c7` SUCCESS 19:15Z, migrated "1 business database(s) at head 44",
  watchdog alerting to the owner address, tills pulling 200s. **Gap**: backup
  destination unset on production (`[backup] no destination configured` in its
  own boot log) — see 19.
