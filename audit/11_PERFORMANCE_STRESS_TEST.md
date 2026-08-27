# 11 · Performance & stress — measured, this pass + recorded campaign

Hardware note (honest): local container, loopback Postgres. Figures are
hardware-bound and do NOT predict Railway; correctness findings transfer.

## Re-run today (commit 02371c7 + fixes), outlet 39, real /sync/push money path

| Stage | Shape | Requests | p50 / p95 / p99 | Errors | Money checks |
| --- | --- | --- | --- | --- | --- |
| A baseline | 1 till · 15 s | 1,245 | 12 / 17 / 24 ms | 0 | all ✓ |
| C peak | 8 tills · 30 s | 4,231 | 48 / 151 / 221 ms | 0 | all ✓ |
| F stress | 24 tills · 30 s | 4,107 | 160 / 345 / 484 ms | 0 | all ✓ |
| G recovery | 1 till · 15 s | 1,640 | 9 / 12 / 18 ms | 0 | all ✓ |

Server memory 108 → 141 MB across the rush, **back to 138 MB at recovery** —
no leak signal. Money checks each stage: no duplicate op, exactly one sale row
per bill, every journal balances, revenue ties, zero repairs needed.

## Recorded full campaign (LOAD.md, same environment)
Stages A–G, ~79,000 bills, error total 1 (the statement-timeout ceiling later
fixed by chunked drain: p99 17,615 → 7,798 ms measured before/after), soak
stage E = 4 min / 50,289 bills / flat memory. Live serving at 30 terminals:
p50 147 / p95 293 / p99 383 ms, 0 errors.

## Known ceilings
- The drain (stage D shape) is the slow path by design: chunked 25/txn, pool
  returned between chunks, bounded rather than fast.
- Breaking point on THIS hardware not reached at 24 concurrent tills; the
  earlier campaign's 40-till stage F held at p99 386 ms. Railway numbers
  require the staging run (BLOCKED — outbound proxy; see 15).
- Client render: 300-dish grid measured (DOM 9,230 → 2,123 nodes after
  paging; masked-span artifact, style cache, content-visibility).

## Soak
E (4 min) + today's sequence is the longest this environment allows; 2–4 h
soak: BLOCKED — ENVIRONMENT LIMITATION (needs dedicated staging).
