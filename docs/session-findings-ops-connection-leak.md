# Session findings — `/api/ops` connection leak + audit-suite triage

Date: 2026-08-04. Branch: `claude/restaurant-pos-platform-94qeoj` (off `staging`).

This session began from a full end-to-end verification of the running app
(register → push sale → pull) and a run of the `test/audit.test.js` production
audit suite. The suite was failing/cancelling wholesale; tracing *why* uncovered
one critical production bug plus a set of test-quality issues.

## CRITICAL — `/api/ops` leaked a pooled connection on every successful write

`app.post("/api/ops")` takes a client with `pool.connect()` and manages
`BEGIN/COMMIT` itself. The **success path fell out of the `try` with no
`client.release()`** — release existed only in the `catch` and the two
early-return branches. Every sync that wrote anything leaked one pooled
connection (idle at Postgres, but never returned to node-pg's pool, so never
reaped by `idleTimeoutMillis`). After `pool.max` successful writes the pool was
exhausted and **every till + admin request hung on a 4s connect-timeout → 503
"Busy" until the process restarted.**

- Regressed in commit `8e416b9`, which removed the success-path
  `client.release()` while adding the rowver-probe block. Present on `staging`,
  **not yet promoted to production `main`.**
- Reproduced deterministically: 12 sequential `/api/ops` calls drove
  `kashikeyo_app` connections 3→12 and flipped `/api/health` to `db:false`;
  Postgres showed the connections `idle` post-`COMMIT` (the node-pg leak
  signature).
- Fix: a single `finally { client.release(); }` guarantees release on every
  exit (success, error, early return). 40 sequential writes now hold steady at
  3 connections.

## FIN-01 — discount flagged AT the limit instead of PAST it

`if (discPct >= moneyCtx.discLimitPct)` flagged a discount exactly equal to the
store's ceiling for manager review, though the intent ("past the ceiling") and
the reason text ("discount X% **over** Y%") are strictly-greater. A store with a
50% limit ringing exactly 50% got a spurious review flag on every such sale.
Fixed to `>`.

## Test-quality fixes (implementation verified correct)

- **Back-office writes used the bearer till token, not the manager cookie.**
  `PUT /recipes/:id`, `POST /flags/:kind/:id/ack` are `requireBackOffice(1)`
  (cookie/manager only, correct per SEC-2). Five call sites in the suite used
  `o.token` → 403 → recipe never saved / ack refused, which then cascaded
  (stock never deducted, sold-out never triggered, audit-log ack never logged).
  Switched to `{ cookie: o.cookie }`. Verified with cookie auth the stock ledger
  deducts 1000→800 and the events land.
- **Immediate read-back after write is not guaranteed under concurrent load.**
  The sync pull's never-skip visibility guard
  (`txid < pg_snapshot_xmin(pg_current_snapshot())`) can transiently hide a
  freshly-committed row while an unrelated concurrent transaction holds the
  cluster snapshot xmin down. This is **safe** (the cursor never advances past
  the row; the till's 5s poll / SSE re-poke picks it up with no loss) but the
  suite asserted on single immediate pulls. Hardened the affected read-backs to
  poll (`H.until` / new `H.pullEntity`) and to assert on the snapshot the poll
  validated rather than a separate re-read.
- **`npm test` ran the integration files concurrently.** `appshell.test.js` and
  `audit.test.js` each boot a server on the fixed port 4199; run in parallel,
  the first file's `after(stopServer)` killed the server out from under the
  other → mass cancellations. Set the test script to
  `node --test --test-concurrency=1` so server-owning files run serially.

## Result

`npm test` → **120 pass / 0 fail / 0 cancelled** (stable across repeated runs).
`node tools/census.js --check` clean. `smoke.js` passes. The `/api/ops` leak is
the one change that must reach production `main`.
