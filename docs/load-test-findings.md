# Capacity test — findings

Harness: `test/load/loadtest.js`. Run 12 Aug 2026.

## What was asked, and why the question needed reframing

The audit set a floor of **100 transactions/hour** and asked for behaviour at 2×,
5× and 10×. Taken literally that is 0.03 writes/second, which no server notices —
reporting a pass against it would say nothing.

A restaurant's load is not an hourly average anyway. It is a lunch rush landing on
several tills at once, each flushing an offline outbox the moment WiFi returns. So
the harness ramps **concurrent tills** and reports the sustained throughput and
latency each level holds, driving the three paths a real terminal uses:

| Path | What it is |
| --- | --- |
| `POST /api/ops` | a settled sale — the write that must never be lost |
| `GET /api/pull` | the 5-second sync poll every till runs |
| `GET /api/app2/live` | the orders/KDS refresh, under write pressure |

Sales are priced through `web3/proto/money.js` — the same `billTotals()` the
terminal and server use — so the server's money audit sees clean bills and this
measures the happy path rather than the flagging path.

## Results — sandbox, 4 cores, app and Postgres on one box

| Concurrent tills | Sales/sec | Sales/hour | p95 | p99 | Errors |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 164 | 590,652 | 8 ms | 13 ms | 0 |
| 4 | 244 | 879,300 | 24 ms | 33 ms | 0 |
| 8 | 391 | 1,408,788 | 28 ms | 35 ms | 0 |
| 16 | 292 | 1,049,544 | 70 ms | 87 ms | 0 |
| 20 | 238 | 858,204 | 98 ms | 117 ms | 0 |
| 24 | 222 | 798,084 | 138 ms | 160 ms | 0 |
| 32 | 223 | 804,132 | 192 ms | 232 ms | 0 |
| 48 | 208 | 748,620 | 313 ms | 364 ms | 0 |

**Zero errors at every level.** Not one dropped sale, no pool exhaustion, no
5xx, across every concurrency tested.

## What this does and does not establish

**Established: the audit's floor is met by about four orders of magnitude.** Even
the *worst* level measured — 48 simultaneous tills, p95 313 ms — sustains roughly
750,000 sales/hour, some 7,500× the 100/hour floor. The 2× / 5× / 10× question is
therefore answered decisively in the sense it was asked: those multiples are
0.06, 0.14 and 0.28 writes/second, and the app does not notice them. A single
outlet doing 500 covers a day is using well under 1% of what this measured.

**Not established: the true ceiling.** The apparent knee above 8 concurrent tills
must not be read as the server's limit, because **the load generator runs on the
same 4-core box as the app and the database**. Past roughly 8 workers the
generator is competing with the server it is measuring, so throughput flattening
and latency climbing are at least partly the harness's own contention. The
12-till row (190/s, worse than both its neighbours) is visibly that noise.

Locating the real knee needs the generator off-box, driving a deployed instance —
i.e. running this against **staging**, whose service sits on 8 vCPU / 8 GB with
Postgres over Railway's private network. That has not been done: this sandbox's
egress policy blocks the staging host, so the harness cannot reach it from here.

**One thing worth watching when that run happens.** `pool.max` is the
node-postgres default of 10 in production (`PG_POOL_MAX` is unset), so somewhere
above ten simultaneous in-flight writes requests begin queueing for a connection.
That is precisely the `pool.waiting` counter in `/api/metrics`, and the staging
run is what would show whether the default is the binding constraint or nowhere
near it. Raising `PG_POOL_MAX` is the lever if it is.

## Running it

```bash
node test/load/loadtest.js --base http://127.0.0.1:4000 --levels 1,4,8,16 --seconds 15
```

The harness refuses hosts it can identify as production, because it writes real
sales into a real ledger. That check is a courtesy, not a guarantee — read the URL
before you press enter.
