# Production-readiness audit — remediation status

Status of the master production-readiness, stress-test and security audit, as of
**11 Aug 2026**, at `main` = `0e954ac`.

This is a **status record, not a re-audit**. It says what was fixed, what
evidence backs each fix, and — the part that matters more — what is still
unverified and exactly which access is missing. It follows the audit's own
rules: nothing is called working because code for it exists, no failing result
is omitted, and anything unproven is marked **NOT TESTED** with the specific
missing access rather than assumed to pass.

> **Update, 12 Aug 2026 01:20 UTC — the deployment gate is CLEARED.** Railway
> access was granted and the production release was verified end to end (§4.1).
> One new customer-facing issue was found in the production logs (§4.7).
>
> **Update, 12 Aug 2026 03:35 UTC — capacity is now measured, not modelled.** A
> throwaway service in staging ran the harness against the deployed app from
> off-box: ceiling ~360 settlements/second, ~13,000× the audit's floor, zero
> errors to 768 concurrent tills (§4.6). Score **8.1 → 8.2**. Two caps remain.

## Score — 8.2 / 10

Weighted across ten dimensions, each scored on **evidence**, not on the existence
of code. Two dimensions are still held below their earned score, because the
evidence that would lift them needs access or accounts this review does not have.

| Dimension | Weight | Score | Note |
| --- | ---: | ---: | --- |
| Money & tax correctness | 15 | 9 | One `billTotals()`; 1,080-combination parity test |
| Tenancy & data integrity | 15 | 9 | FORCE RLS everywhere; cross-tenant restore refused |
| Offline & sync resilience | 12 | 8 | Durable outbox; a mid-sync till provably converges after restore |
| Security & access control | 12 | 8 | Fail-fast on weak `JWT_SECRET`; no external penetration test |
| Disaster recovery | 10 | 7 | **Capped** — managed-backup layer unverified |
| Observability | 10 | 7 | **Capped** — nothing scrapes `/api/metrics`, so nothing alerts |
| Performance & capacity | 8 | 9 | **Measured on the deployed app**: ~360 settlements/s, zero errors to 768 tills |
| Testing & verification | 8 | 8 | 117 cold-database tests reading the *shipped* files |
| Release & deploy process | 5 | 9 | Readiness probe **proven in production**: healthcheck 503'd, retried, passed |
| Restaurant operations fit | 5 | 8 | Some flows verified by screenshot rather than by test |

**Weighted total: 8.23 → 8.2**

The deployment gate that once sat outside this number is **closed** (§4.1): the
release built from the Dockerfile, applied its schema, swapped to the restricted
database role and passed its healthcheck. Capacity is no longer a projection
either (§4.6). What stays capped are the two things that are not engineering
problems at all — nobody has read the managed-backup settings off the dashboard,
and nothing scrapes the metrics endpoint.

## Where things stand

| | |
| --- | --- |
| Findings closed and in production | CRITICAL, HIGH and MEDIUM |
| Automated suite | **117 tests, 117 passing** on a cold database |
| Independent CI | GitHub Actions run **#181**, `postgres:16` service, `npm ci --omit=dev` + `npm test` — **success** on `0e954ac` |
| Production branch | `main` = `staging` = `0e954ac` |
| Deployment itself | **VERIFIED** — `e14de2a1`, boot 222 ms, healthcheck 503-then-pass |
| Capacity | **~360 settlements/s** measured off-box against staging |

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

## 4. Items — verified and still open

### 4.1 The production deployment — ✅ VERIFIED

Deployment `e14de2a1`, commit `0e954ac`, branch `main`, production environment:
**SUCCESS** (22:56:47 → 22:57:08 UTC). Boot log:

```
AI: {"provider":"gemini","model":"gemini-3-flash-preview","configured":true,"failover":false}
KashikeyoPOS Cloud on :8080
schema ready
connected as restricted role kashikeyo_app for request handling
ready to serve traffic (boot init 222ms)
poke listener connected (LISTEN/NOTIFY cross-instance fan-out)
```

`schema ready` is the migration: `schema.sql` is applied on every boot, so the
six new `stores` columns and their backfill are in the live database. The
restricted-role swap also completed, meaning RLS is enforced in production, not
just in test. No errors logged since deploy.

**The readiness probe earned its place, visibly.** From the build log:

```
Starting Healthcheck · Path: /api/health · Retry window: 1m40s
Attempt #1 failed with service unavailable. Continuing to retry for 1m39s
[1/1] Healthcheck succeeded!
```

Railway asked before boot init had finished, got the 503 the probe now returns,
waited, and passed on the retry. Before `4e32745` that first attempt would have
answered 200 while the schema was still being applied, and traffic would have
been routed at an instance that was not ready. This is the fix working in
production, not in a test.

Two build facts worth recording, because the stored service config is misleading:
the service-level builder reads `RAILPACK`, but `railway.json` overrides it at
deploy time — the build log shows a five-step BuildKit Dockerfile build
(`[5/5] COPY . .`) exporting a docker image, matching this repo's Dockerfile
exactly. So the `npm ci` lockfile reproducibility **is** in effect. Likewise the
healthcheck path is not in the stored config but is demonstrably `/api/health`.

### 4.2 Railway managed backups — STILL NOT VERIFIED

Now with a precise reason rather than an access gap: **Railway's API does not
expose backup configuration.** Neither `get-service-config` nor Railway's own
agent can read schedule, retention or last-backup time; the agent's own words
were that the API "does not expose managed backup settings". It is a dashboard-only
panel (Postgres service → Backups).

So this stays open and needs a human to read it off the console. What *is* known:
the production database is `ghcr.io/railwayapp-templates/postgres-ssl:18` on a
persistent volume at `/var/lib/postgresql/data`, currently **1.99 GB** used,
single replica in `sfo`.

The RPO/RTO targets in `docs/disaster-recovery.md` §2 therefore remain unevidenced
at the infrastructure layer. The application-level restore path *is* proven (§2).

### 4.3 External monitoring — STILL NOT WIRED

`/api/metrics` exists and is tested; nothing scrapes it. Needs a third-party
account (Grafana, Better Stack, UptimeRobot) and its credential — not a Railway
setting, so Railway access does not close it.

### 4.4 AI provider — ✅ RESOLVED AT BOOT, one call still unobserved

The boot line above confirms it: `provider: gemini`, `configured: true`,
`failover: false` (no Anthropic key set, which is consistent).

**The model is `gemini-3-flash-preview`, not the `gemini-2.5-flash` default** —
`GEMINI_MODEL` is set. That matters, and the shim handles it correctly: its
thinking guard keys on `/2\.5-flash/`, so for a gemini-3 model it does *not* send
`thinkingBudget: 0` (which that model may reject) and instead raises the output
budget to at least 8,192 tokens so hidden reasoning and the answer both fit. That
is the intended branch for a non-2.5-flash model.

What is still unobserved is a **completed call**. The boot line proves the key is
present and the provider resolves; it does not prove the model id is valid or that
a response comes back. `GET /api/inv/ai-selftest` (back-office auth) settles it in
one request, or `AI_SELFTEST=1` prints the result into the deploy log at boot.

### 4.7 A guest-portal subdomain that resolves to nothing — NEW, customer-facing

Found in the production log at 01:16:50 UTC:

```
guest portal {"slug":"m","host":"m.kashikeyopos.com","resolved":false,"org":null,"storeName":null}
```

Subdomain routing is **live**: `PORTAL_BASE_DOMAIN` is set and the wildcard
`*.kashikeyopos.com` is a provisioned custom domain on the service. (CLAUDE.md's
claim that this ships inert is now stale.) But a request for handle `m` matched no
org and fell through.

This is worth a look because the failure mode is customer-facing: a QR code that
encodes `<handle>.kashikeyopos.com` keeps pointing at that subdomain after a store
renames its handle, and the guest gets a portal with no store rather than a
redirect or a clear message. Either this was a manual test of a handle that does
not exist, or a store's handle changed and its printed QR codes are now dead.
Worth confirming which before treating it as harmless.

### 4.5 The repository is public — CONFIRM INTENT

Noticed during this review; not part of the original audit. `destiniz-svg/kashikeyopos`
is publicly readable. Scoped honestly: **no secrets are committed** (the only
credential-shaped string is a localhost DSN gated on `NODE_ENV !== "production"`,
no `.env` is tracked) and the app refuses to boot against a real database without
a strong `JWT_SECRET`. So this is disclosure of implementation detail, not
credential exposure — it lowers an attacker's cost of finding a logic flaw in a
payment-handling system. This may be deliberate; it is flagged as a decision to
confirm, not a defect.

### 4.6 Capacity at 2× / 5× / 10× — ✅ MEASURED ON THE DEPLOYED APP

A throwaway service in the **staging** environment ran `test/load/loadtest.js`
against the deployed staging app over Railway's private network — generator off
the box it measured, which the earlier sandbox attempt could not manage. Full
write-up in `docs/load-test-findings.md`.

**Sustained ceiling: ~360 settlements/second — about 1.3 million sales/hour.**
Throughput scales perfectly linearly to 64 concurrent tills with p50 pinned at
~191 ms, then saturates at ~360/s from 128 tills on. That is roughly **13,000×
the audit's 100/hour floor**; ten times the floor consumes 0.08% of it.

Three properties matter more than the headline:

- **It degrades by queueing, not by failing.** Zero errors at every level up to
  768 simultaneous tills, with p95 at 3.5 seconds. Nothing dropped, no 5xx, no
  pool exhaustion. For a POS that is the correct failure mode — a slow sale is
  recoverable, a lost sale is not.
- **Reads stay fast while writes queue.** The KDS/orders refresh held at
  183–207 ms across *every* level, unmoved while settlement latency rose
  twentyfold. The kitchen screen keeps working during a rush even when the till
  is waiting.
- **The ~190 ms floor is network, not server.** Railway placed the generator in
  `asia-southeast1` and the app runs in `sfo`, so every figure carries a
  cross-Pacific round trip. Server-side service time is far below these numbers.

**The bottleneck is one Node process, not the hardware.** At saturation the app
peaked at **1.15 of its 8 vCPU (14%)** and 0.38 GB of 8 GB. A single Node
process runs JavaScript on one thread, so seven of the eight allocated vCPU
cannot be used by one replica — the ceiling above is a *single-process* ceiling.
The lever is `numReplicas` (the sync design is stateless behind Postgres and
`LISTEN/NOTIFY` already fans `poke` across instances), with `PG_POOL_MAX` raised
in step and `pool.waiting` in `/api/metrics` as the signal for when it binds.
Not urgent: it is the difference between ~13,000× the requirement and
~100,000× it.

Caveats kept on the record: 15–20 s per level, so this is a saturation test and
not a soak test; small 1–4 line baskets; one transient connection error in
~1,900 requests at the 1-till level, which is exactly what `/api/ops`
idempotency and the till's retrying outbox exist for; and ~40,000 synthetic
sales now sit in the staging database under throwaway
`load-<timestamp>@loadtest.invalid` orgs.

---

## 5. Recommended order

1. ~~Confirm the deployment and the schema migration.~~ **Done — §4.1.**
2. ~~Measure capacity against real hardware.~~ **Done — §4.6.**
3. Confirm a completed AI call (§4.4) — one request to `/api/inv/ai-selftest`.
   The provider resolves at boot; a round trip has still not been seen.
4. Check `m.kashikeyopos.com` (§4.7). If a live store's handle changed, its
   printed QR codes are pointing at nothing.
5. Read the managed-backup configuration off the dashboard (§4.2) and record it
   in `docs/disaster-recovery.md` §2 so RPO/RTO stop being aspirational. The API
   cannot answer this; a human has to look.
6. Point a monitor at `/api/metrics` (§4.3) using the §7b thresholds.
7. Confirm the repository's public visibility is intended (§4.5).

Nothing on this list is a code change. Steps 5 and 6 are the two remaining caps
on the score; the rest are confirmations.

## 6. Observed after the capacity run — pool exhaustion under ordinary polling

At 03:42 UTC, roughly two minutes after a routine staging redeploy and eight
minutes after the load test ended, the staging app logged a burst of ~30

```
request failed: GET /api/pull?since=0 timeout exceeded when trying to connect
request failed: GET /api/pull?since=681261 timeout exceeded when trying to connect
```

That is the connection pool exhausted — requests timing out waiting for one of
its ten slots, not Postgres refusing work.

**The app handled it correctly.** Those paths answer 503 + `Retry-After`, by
design ("saturation is temporary, not a bug"), so clients back off rather than
hang; the burst stopped on its own and nothing has errored since.

Two things make it worth recording anyway. It is the first sighting of
`PG_POOL_MAX`'s default of 10 binding under **ordinary sync polling** rather
than a synthetic 768-till stampede — on a database that now holds ~40,000 extra
sales. And it is exactly the condition `pool.waiting` in `/api/metrics` exists to
warn about, which nothing is watching yet (§4.3). Raising `PG_POOL_MAX` and
adding replicas (§4.6) is the same lever for both.

Honest limit: the client that generated those pulls cannot be identified from
the logs available here.

## 7. Housekeeping from the capacity run

- **Two throwaway services still exist and need deleting by hand:**
  `TEMP-loadgen-DELETE-ME` and `TEMP-loadgen2-DELETE-ME` in the staging
  environment. Railway's `removeServiceTool` reports `status: applied — marked
  for removal` but they persist; Railway's own agent concluded that finalising
  the deletion requires confirmation in the dashboard. Both are stopped (zero
  running replicas, restart policy `NEVER`), so they consume nothing and cannot
  generate load again on their own.
- `railway.loadgen.json` stays in the repo — it is the documented way to stand a
  generator up again, and affects nothing unless a service is explicitly pointed
  at it.
- Roughly **40,000 synthetic sales** were written into the **staging** database
  under throwaway orgs named `load-<timestamp>@loadtest.invalid`. They are
  isolated from every real staging store by RLS and can be dropped whenever
  convenient. Production was never touched. One statement clears them:

  ```sql
  DELETE FROM orgs WHERE email LIKE 'load-%@loadtest.invalid';
  ```

  (`entities`, `ops` and `stores` cascade from `orgs`.) This could not be run
  from the review environment: egress to the app is blocked by network policy,
  and the Railway connector returns variable *names* without values, so no
  database credential was available.
