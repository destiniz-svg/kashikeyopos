# KashikeyoPOS — production go-live guide

This is the operator's checklist to take KashikeyoPOS from **Conditionally
Production Ready** to a confident production launch. It records what the
codebase now does (all done and CI-tested), and the handful of steps only *you*
can complete because they need production access or a business decision.

Companion docs: `docs/disaster-recovery.md` (backups/restore) and the audit
report (verdict + findings).

---

## 1. Where things stand

Every **release-blocking** finding from the audit is fixed in code and covered by
the automated suite (`npm test`, 31 tests, green in CI on every push/PR):

| Area | What now happens | Where |
| --- | --- | --- |
| **Money integrity** | Server recomputes each sale's totals/tax and **flags** (never rejects — offline-safe) any mismatch or below-catalogue price | `index.js auditSaleMoney` · FIN-01 |
| **Credit limits** | Enforced server-side; over-limit balances are applied but flagged for review | `index.js` ops cust-delta · FIN-02 |
| **Manager review** | `/back` → **Review** tab lists flagged sales, over-limit customers, and the audit trail; "Mark reviewed" clears without editing money | `site/back.html` |
| **Web hardening** | CSP + `X-Frame-Options`/`nosniff`/`Referrer-Policy`/HSTS; login throttling (8 fails → 429) | `index.js` · SEC-01/02 |
| **Offline visibility** | Till shows a live sync-status tray (Synced / Saving / **Offline · N saved here** / retry) | `guest-sync-patch.js` · SYNC-01 |
| **Audit trail** | Append-only `activity_log` (INSERT+SELECT grant only) for money flags, over-limit, reviews, refunds | `schema.sql`, `index.js` · FIN-03 |
| **Accounting export** | `GET /api/inv/ledger-export` → journal totals (revenue, GST, tenders, AR, COGS, gross profit) | `inventory.js` · FIN-04 |
| **API safety** | `/api/ops` validates shape + caps sizes; body limit tightened (25 MB only on OCR); correlation ids on every response | `index.js` · API-01/02, OPS-02 |
| **Scaling** | SSE fan-out over Postgres LISTEN/NOTIFY (multi-instance safe); boot serialised with an advisory lock + retry | `index.js` · ARCH-01 |
| **Data-loss guards** | Guest orders drop off-menu items; till reset refuses while sales are unsynced | `index.js`, `guest-sync-patch.js` |

**What this does NOT yet include** (owner-only — see §3): a *verified* backup
restore, a production-scale load test, a formal accessibility pass, a payment-
gateway decision, and an MFA/PIN policy call. None are code changes; each needs
your environment or a business decision.

---

## 2. Deploy the current build

1. **Merge / deploy `main`.** Railway builds the Dockerfile and runs `npm start`
   (which bakes the till bundle via `guest-sync-patch.js`, then starts the
   server). Health check: `GET /` and `GET /api/health` → `{ok:true,db:true}`.
2. **Confirm the schema migrated.** On boot the log shows `schema ready` then
   `connected as restricted role kashikeyo_app…`. The new `activity_log` table +
   grants apply automatically (idempotent).
3. **Bundle refresh.** The service-worker version bumped to `kashikeyo-2.9.100`;
   installed till PWAs pick up the new bundle on next load. If a till looks
   stale, hard-refresh once.

### Required environment variables (Railway → service → Variables)

| Variable | Purpose | Required |
| --- | --- | --- |
| `DATABASE_URL` (or `PG*`) | Postgres connection | **yes** |
| `JWT_SECRET` / `SECRET` | signs sessions/JWTs **and** derives the `kashikeyo_app` DB-role password — keep it stable and backed up | **yes** |
| `ALLOWED_ORIGINS` | comma-separated CORS allow-list for the sync API; leave unset only if the till is same-origin | recommended |
| `NODE_ENV=production` | enables secure cookies + HSTS | **yes** |
| `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` | seeds the `/dev` panel admin | if using `/dev` |
| `GOOGLE_CLIENT_ID` / `APPLE_CLIENT_ID` etc. | social sign-in (optional) | optional |
| `ANTHROPIC_API_KEY` | enables OCR delivery notes + AI assistant; degrades gracefully without it | optional |
| `OCR_MODEL` | overrides the OCR model id | optional |

> **Back up the Variables** (encrypted, in your secrets vault). The DB dump does
> not contain them, and losing `SECRET` invalidates every session.

---

## 3. Owner-only steps to reach full "Production Ready"

Do these before broad rollout. Each is the last mile the sandbox couldn't finish.

### 3.1 Verify a database restore  ·  *drill #1 PASSED — one confirmation left*
**Drill #1 executed 18 Jul** against a production-scale dataset (62,728 entities /
61,800 sales): dump 1.1 s, restore 2.9 s, schema + restricted role self-healed on
boot, all §4 checks passed, a restored org's original login worked, `npm test`
36/36 green on the restore — **end-to-end < 5 min** (full record:
`disaster-recovery.md` §7). **RPO ≤ 24 h and RTO ≤ 1 h are now adopted** in §2.
Remaining: run the same procedure once against the **staging** DB via
`docs/restore-drill.md` (validates the Railway backup layer + network path), and
**wire the nightly dump schedule** (§3) so the RPO is real.

### 3.2 Load-test on production infrastructure  ·  *throughput verified — soak pending*
**Status (18 Jul):** the ramp was run on staging (Railway). Result: **0 errors**
through **100 → 1000 tx/hr** (10× the realistic peak), server memory flat at
**~40 MB**, CPU peaking **< 1 vCPU**, warm-connection p95 **~294 ms**, and the
credit-limit path (FIN-02) fired correctly under load. Throughput is verified.
**Remaining:** the **24 h soak** (memory-leak check) — run it and confirm memory
returns to baseline; and confirm **staging's instance size matches production**
(Railway → service → Settings → Resources) so the numbers transfer 1:1.

The harness ships in the repo — **`scripts/loadtest.mjs`** (zero deps,
drives the real `/api/ops` sale path with valid audit-passing sales, reports
p50/p95/p99, throughput and an error breakdown per stage). By default it
**registers its own throwaway store**, so run it against **staging** first:

```
# realistic ramp (each stage 5 min); watch Railway CPU/mem/DB-connections live
node scripts/loadtest.mjs --url https://kashikeyopos-staging.up.railway.app \
     --stages 100,250,500,1000 --stage-secs 300

# find the ceiling (50 concurrent workers, fire as fast as possible)
node scripts/loadtest.mjs --url <staging> --stress 50 --stress-secs 120

# 24 h soak at your expected peak
node scripts/loadtest.mjs --url <staging> --rate 400 --soak-hours 24
```

Targets: **p95 ≤ 500 ms and error rate ≤ 0.5 %** at your peak (the script prints
an OK/WATCH/FAIL verdict per stage). Tune the Postgres pool + instance size to
your peak. Confirm zero duplicate/lost sales (the idempotent op-log + `npm test`
already protect this logic). The script prints the throwaway store's slug —
delete it from `/dev` (or leave it; it's isolated) when done. Point it at
production only deliberately, with `--token` of a disposable store.

### 3.3 Accessibility pass
Run axe/Lighthouse over `/back`, `/app`, and `/p/:slug`; fix contrast, focus
order, labels, and touch-target sizes. `/back` is hand-written HTML and fully
fixable; the till is a prebuilt bundle — patch what you can via
`guest-sync-patch.js`, and note any residuals.

### 3.4 Payments decision
See the full brief: **`docs/payments-decision.md`**. In short — there is **no
payment gateway**; card/QR/transfer are recorded labels, cash-safe, with no
cardholder data in the app (PCI scope minimal). **Recommended: launch on manual
reconciliation** (Option A) using the daily `ledger-export` + audit-trail routine
in the brief; consider integrating a gateway (Option B) only later if non-cash
volume justifies it. Pick an option, record it, and this gate is satisfied.

### 3.5 Authentication policy
See the full brief: **`docs/auth-policy.md`** (with a fill-in checklist). In short:
the real boundaries (store + platform-admin logins) are bcrypt + rate-limited and
solid; the till **PIN is convenience, not security**. **Refunds are now server-enforced**
— the till asks for the store password and the server stamps `managerApproved`
(unapproved refunds sync but are flagged into Review). Keep the remaining
sensitive actions (price edits, reports) behind the manager password. Decisions to
record: a **minimum password length** (recommend ≥ 8 — a ~5-line change if you want
it enforced), the sensitive-action policy, platform-admin hardening, session/
device-loss posture (sessions are 365 d, no per-device revocation), and whether to
add **MFA** (recommend for `/dev` first). Foundations are in place; this gate is
policy + a couple of optional builds.

### 3.6 Multi-instance note
If you scale beyond one instance: SSE now fans out via LISTEN/NOTIFY and boot is
lock+retry protected, so it's safe — but prefer **staggered/rolling** deploys
(Railway's default) so nodes don't cold-boot the schema at the exact same instant.

---

## 4. Post-launch operations

- **Watch the Review tab** daily: flagged sales and over-limit customers surface
  real issues; the audit trail answers "who/what/when".
- **Reconcile** with `GET /api/inv/ledger-export?from=<ms>&to=<ms>` (per store
  via `&storeId=`) against cash counted + provider settlement.
- **Errors / tracing:** every response carries `X-Request-Id`; server errors log
  it and the `/dev` health view shows the recent-error ring. For deeper coverage,
  ship these logs to a metrics/alerting backend (still recommended — OPS-02).
- **Backups:** confirm the scheduled dump is running and off-site (DR runbook §3),
  and re-run the restore drill quarterly.

## 5. Rollback

- **Bad app release:** `git revert` the commit (or redeploy the previous green
  commit); Railway rebuilds. Schema is additive-only, so no DB rollback needed.
- **Bad till bundle:** re-bake from a known-good commit and bump the SW version
  (`CLAUDE.md` → "Patching the till bundle") so PWAs update.
- **Bad data:** targeted undelete (entities are soft-deleted) or a scoped restore
  — DR runbook §5c/§5a.

## 6. Go / no-go

Launch when all are true:

- [ ] `npm test` green in CI on the deploy commit
- [ ] Env vars set; `SECRET` backed up; `NODE_ENV=production`
- [ ] Health check green in production
- [ ] **Restore drill run and passed** (§3.1)
- [x] Load test — throughput verified (0 err to 10× peak); [ ] 24 h soak pending (§3.2)
- [ ] Accessibility pass done or residuals accepted (§3.3)
- [ ] Payments approach decided + staff trained (§3.4)
- [ ] Auth policy set (§3.5)
- [ ] Backups scheduled + off-site; RPO/RTO recorded
- [ ] On-call + incident runbook filled in (DR runbook §8)

When §3.1–3.5 are complete, the audit's remaining gates are satisfied and the
system is **Production Ready**.
