# 09 · Security audit — re-verified 2026-08-27

## Live probes this pass (local instance)
- CSP (`default-src 'self'`, inline scripts hash-allowlisted, `unsafe-eval`
  only on the 3 template-runtime pages), nosniff, no-referrer, SAMEORIGIN,
  permissions-policy: **present**. HSTS added in production only.
- `/metrics` without `METRICS_KEY`: **404** (reconnaissance-closed).
- Error handler returns `{"error":"session required"}` — never a DB message.
- Account enumeration: `/code` byte-identical for known vs unknown address
  (verified again live), `delivered` derived from install state for every
  caller.
- `npm audit --omit=dev`: **0 vulnerabilities** across 2 runtime deps.

## Standing controls (each with its pinned test)
- Token planes: `typ` claim (`s/a/t/m/d`) checked on every verify; portal key
  derived, never borrowed; doc links: receipt stored+permanent, statement
  signed+30 d, expiry answers 410 (proof of issue) with `sealed()` unexported.
- Rate limiting: two-bucket (identity-hash + IP) token buckets on every open
  door incl. table-token mint; PIN two tiers (caller 6 → outlet 40);
  429 + Retry-After, enumeration-safe bytes.
- Revocation enforced (`src/revoked.js`) on every authenticated request;
  fail-open only on unreachable DB (documented choice).
- SSRF: print relay allow-lists RFC1918/CGNAT/ULA only, v4-mapped v6 unwrapped
  before judgment, port 9100 fixed; link-local (metadata) excluded.
- No SQL from user input (parameterised + `%I`); XSS held by React/DC
  text-node rendering (verified in-browser with hostile names); no cookies →
  CSRF structurally absent; secrets compared `timingSafeEqual`; credentials
  never in query strings; PIN hashes unreadable even to the outlet's own role
  (column REVOKE, 038).
- Cross-tenant: two belts + door policy + leak-test (13 refusals) in CI.
- Dangerous scripts: `reset:database` / `seed:demo` double-fenced
  (`yes-i-mean-it` + refuse on `RAILWAY_ENVIRONMENT_NAME=production`).
- Boot refuses: no `CONTROL_DB`, secrets < 32 chars, wildcard CORS in prod
  (dropped + logged), unpinned TLS when `PGSSL=verify`.

## This pass's finding
R-1 (fabricated approval codes) was an **integrity** defect, not an access
one — see 15_DEFECT_REGISTER. No new access-control defects found. The
open-by-design onboarding claim gate (`ONBOARDING_CLAIM_TOKEN` unset ⇒ open
first-owner claim on a fresh install, boot log names which) remains a
deliberate, logged posture for self-onboarding installs.

## Honest open items
The unexplained single production 401 on a share (logged, instrumented — next
occurrence names itself). No penetration test by an independent party has been
performed. Secrets management is Railway env vars (no vault, documented).
