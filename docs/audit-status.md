# Production-readiness audit — remediation status

Status of the master production-readiness, stress-test and security audit, as of
**11 Aug 2026**, at `main` = `0e954ac`.

This is a **status record, not a re-audit**. It says what was fixed, what
evidence backs each fix, and — the part that matters more — what is still
unverified and exactly which access is missing. It follows the audit's own
rules: nothing is called working because code for it exists, no failing result
is omitted, and anything unproven is marked **NOT TESTED** with the specific
missing access rather than assumed to pass.

## Score — 8.0 / 10

Weighted across ten dimensions, each scored on **evidence**, not on the existence
of code. Three dimensions are held below their earned score because the evidence
that would lift them needs access this review did not have.

| Dimension | Weight | Score | Note |
| --- | ---: | ---: | --- |
| Money & tax correctness | 15 | 9 | One `billTotals()`; 1,080-combination parity test |
| Tenancy & data integrity | 15 | 9 | FORCE RLS everywhere; cross-tenant restore refused |
| Offline & sync resilience | 12 | 8 | Durable outbox; a mid-sync till provably converges after restore |
| Security & access control | 12 | 8 | Fail-fast on weak `JWT_SECRET`; no external penetration test |
| Disaster recovery | 10 | 7 | **Capped** — managed-backup layer unverified |
| Observability | 10 | 7 | **Capped** — nothing scrapes `/api/metrics`, so nothing alerts |
| Performance & capacity | 8 | 7 | **Capped** — 2×/5×/10× modelled locally, never measured |
| Testing & verification | 8 | 8 | 117 cold-database tests reading the *shipped* files |
| Release & deploy process | 5 | 8 | ff-only staging→main, CI on both, `npm ci` reproducibility |
| Restaurant operations fit | 5 | 8 | Some flows verified by screenshot rather than by test |

**Weighted total: 8.02 → 8.0**

**This is not a score of the running system.** Nothing has confirmed the
production deployment (§4.1). That is a binary gate, so it is deliberately left
out of the number rather than averaged into it: read 8.0 as *ready to deploy*,
never as *deployed and well*. Closing steps 1–4 of §5 — none of which is a code
change — would put it near 8.8.

## Where things stand

| | |
| --- | --- |
| Findings closed and in production | CRITICAL, HIGH and MEDIUM |
| Automated suite | **117 tests, 117 passing** on a cold database |
| Independent CI | GitHub Actions run **#181**, `postgres:16` service, `npm ci --omit=dev` + `npm test` — **success** on `0e954ac` |
| Production branch | `main` = `staging` = `0e954ac` |
| Deployment itself | **NOT VERIFIED** — see *Open items* |

The suite grew from 78 effectively-running tests to 117 over this remediation.
Four test files are new, each pinning a specific finding rather than the feature
in general: `outlets.test.js`, `orders-history.test.js`, `restore-drill.test.js`,
`metrics.test.js`.

---

## 1. The finding that mattered most

**Cross-surface tax divergence** — `c509ef1`

The bill was computed three times: `totals()` in the terminal (what the cashier
saw), `pushSale()` in `v2-bridge.js` (what was persisted and audited), and
`orderBreakdown()` in `index.js` (what a QR guest was quoted). Two extracted GST
from a GST-inclusive price; the terminal added it on top. **The same dish cost
MVR 11,000 on a guest's phone and MVR 11,880 at the counter** — exactly the tax
rate apart — and had for months.

Nothing detected it because each surface satisfied its own
`subtotal − discount + service + GST = total` invariant. `auditSaleMoney()`
checks a sale against its own declared components, not against a canonical tax
model, so it had nothing to compare against. The test suite was green throughout.

Fixed by making `web3/proto/money.js` the single `billTotals()` — loaded as a
script by the browser and `require`d by Node, so there is one implementation, not
three that agree by convention. `test/guest-quote.test.js` now pins the two
adapters against each other across 1,080 rate/service/type/discount combinations,
and `test/money.test.js` slices `totals()` out of the *shipped* HTML rather than
testing a retyped copy.

**The lesson worth keeping:** a self-consistent invariant is not a correctness
check. Every surface passed its own audit while disagreeing with every other one.

Two further money defects found alongside it:

- **`Number(x || 800)` on the GST rate** silently converted a legitimately
  zero-rated business (onboarding offers `none: 0`) into 8%. Replaced with
  `gstBpOf()` at five call sites.
- **A sale's `subtotal` paired a post-discount figure with `billDisc`**,
  subtracting the discount twice and breaking the invariant on every discounted
  bill.

---

## 2. Closed findings

| Finding | Commit | Evidence |
| --- | --- | --- |
| Cross-surface tax divergence | `c509ef1` | 1,080-combination parity test; 20,000 randomised carts |
| Readiness probe missing | `4e32745` | `/api/health` 503s until boot init finishes. Root cause of **17 tests silently cancelled** on a cold database — CI's normal path reported 78/95 as if healthy |
| Unstorable money accepted | `d7300a8` | `sanitizeSaleMoney()` coerces before audit; negative/non-numeric quantities flagged |
| Orders board total wrong | `d7300a8` | Board priced through `orderBreakdown()`; a cashier reading MVR 200 had been collecting MVR 220 |
| Accounting/trial-balance cost | `83b36c2` | 801→477 ms and 827→531 ms |
| Image ≠ tested dependency tree | `83b36c2`, `0e954ac` | Dockerfile and CI both `npm ci --omit=dev` against the lockfile |
| Negative stock invisible | `2cfc7b2` | Surfaced in `/alerts` and ranked above "low" in insights |
| **D-09** per-outlet configuration | `48e6e6d` | 8 tests; browser-verified — a branch at 40 tables/160 seats renders its own floor while the main store keeps 12/48 |
| **D-06** receipt history capped at 200 | `e26b376` | 5 tests; 520 sales reachable in four pages, no duplicates, cursor advances through an all-voided page |
| **D-04** recovery + observability | `54fe611` | 4 + 5 tests; automated restore drill and `/api/metrics` |

### D-09 — per-outlet configuration

A chain could add outlets but never configure them. Tables, seats, per-table
capacity, region, manager and type lived only on the org settings entity — one
object describing one store — so every outlet rendered the same hardcoded 12/48,
and the "Tables & seats" editor rewrote the **main** store's floor regardless of
which outlet was selected. The store row is the authority now, with the primary
store still mirroring onto settings because the legacy `/app` register reads it
there.

### D-06 — paged receipt history

At the 100 transactions/hour this app is sized for, 200 receipts is two hours of
trading; yesterday's ticket could not be opened, reprinted or refunded. There was
no page two to request, because the projection lived inline in the page inject.
Now cursor-paged — not offset, which a till writing during a scroll would make
skip or repeat rows.

### D-04 — recovery and observability

Two halves. `test/restore-drill.test.js` destroys a seeded store with the
account-wide reset and restores it, asserting the inventory tables come back (they
live outside `entities`) and that a till holding a pre-disaster sync cursor is
served the restored rows rather than an empty delta. `/api/metrics` reports pool
saturation, a latency histogram, status classes, error rate and POS-specific
counters; `docs/disaster-recovery.md` §7b lists thresholds.

---

## 3. Withdrawn finding

**D-07 — "four empty inventory modules": FALSE.** Inferred from
`hydrateInventory()` clearing `raw.reqs/disp/prod/batches` without checking each
view's separate real-mode branch. Screenshots showed Batches rendering real FEFO
lots and Indent Requests working as the reorder desk. Struck; no code change.

Recorded deliberately. An audit that never withdraws anything is not being
checked either.

---

## 4. Open items — NOT TESTED

Each states the exact missing access, per the audit's rules.

### 4.1 The production deployment — NOT VERIFIED

`main` is at `0e954ac` on GitHub and CI is green on that SHA, but **nothing has
confirmed the deployment**: not that the image built, not that the container
booted, and not that this release's six new `stores` columns and their backfill
applied to the production database.

Missing access, two independent blocks:

- Railway MCP tools return `requires approval` and never reach Railway. The grant
  must come from the Claude Code client's permission layer.
- Outbound HTTPS to `kashikeyopos.com` and `kashikeyopos-staging.up.railway.app`
  is rejected at the egress proxy (`connect_rejected`, org policy denial on
  CONNECT), so the deployed instance cannot be probed directly.

Either one alone is sufficient to close this. **This is the highest-priority open
item** — the schema migration is idempotent and was exercised against four cold
databases, but this is its first production boot. `/api/health` reports
`phase: "boot-failed"` with the error if it did not apply.

### 4.2 Railway managed backups — NOT TESTED

Whether the managed-backup layer is enabled, its schedule and its retention are
unknown, so the RPO/RTO targets in `docs/disaster-recovery.md` §2 remain
unevidenced at the infrastructure layer. The application-level restore path *is*
now proven (§2 above). Missing: Railway console or MCP access.

### 4.3 External monitoring — NOT WIRED

`/api/metrics` exists and is tested; nothing scrapes it. This needs a third-party
account (Grafana, Better Stack, UptimeRobot) and its credential — not a Railway
setting, so Railway access alone will not close it.

### 4.4 AI provider — CONFIGURED, UNOBSERVED

A Gemini key has reportedly been set. The code supports it (`GEMINI_API_KEY` or
`GOOGLE_API_KEY`, model defaulting to `gemini-2.5-flash`, with failover if an
Anthropic key is also present), but **no call has been observed resolving**.
`GET /api/inv/ai-selftest` makes one real call and reports the provider, model
and a sample; setting `AI_SELFTEST=1` prints the same into the deploy log at boot.

### 4.5 The repository is public — CONFIRM INTENT

Noticed during this review; not part of the original audit. `destiniz-svg/kashikeyopos`
is publicly readable. Scoped honestly: **no secrets are committed** (the only
credential-shaped string is a localhost DSN gated on `NODE_ENV !== "production"`,
no `.env` is tracked) and the app refuses to boot against a real database without
a strong `JWT_SECRET`. So this is disclosure of implementation detail, not
credential exposure — it lowers an attacker's cost of finding a logic flaw in a
payment-handling system. This may be deliberate; it is flagged as a decision to
confirm, not a defect.

### 4.6 Capacity at 2× / 5× / 10× — PARTIALLY MODELLED

The 100 transactions/hour floor is met with headroom in sandbox measurement. The
multiples were modelled locally, not measured against production hardware —
`get-service-metrics` (CPU/memory headroom) is the missing input, and it needs the
same Railway access as §4.1.

---

## 5. Recommended order

1. Confirm the deployment and the schema migration (§4.1). Everything else can
   wait; this cannot.
2. Confirm the AI provider resolves (§4.4) — one endpoint call, and it also
   proves outbound network from the container.
3. Read the managed-backup configuration (§4.2) and record it in
   `docs/disaster-recovery.md` §2 so RPO/RTO stop being aspirational.
4. Point a monitor at `/api/metrics` (§4.3) using the §7b thresholds.
5. Re-run the capacity model against real service metrics (§4.6).
6. Confirm the repository's public visibility is intended (§4.5).
