# Capacity test — findings

Harness: `test/load/loadtest.js`. Deploy config: `railway.loadgen.json`.
Runs: 12 Aug 2026.

## What was asked, and why the question needed reframing

The audit set a floor of **100 transactions/hour** and asked for behaviour at 2×,
5× and 10×. Taken literally that is 0.03 writes/second, which no server notices —
reporting a pass against it would say nothing.

A restaurant's load is not an hourly average anyway. It is a rush landing on
several tills at once, each flushing an offline outbox the moment WiFi returns.
So the harness ramps **concurrent tills** and reports what each level sustains,
driving the three paths a real terminal uses:

| Path | What it is |
| --- | --- |
| `POST /api/ops` | a settled sale — the write that must never be lost |
| `GET /api/pull` | the 5-second sync poll every till runs |
| `GET /api/app2/live` | the orders/KDS refresh, under write pressure |

Sales are priced through `web3/proto/money.js` — the same `billTotals()` the
terminal and server use — so the server's money audit sees clean bills and this
measures the happy path rather than the flagging path.

---

## The real result — staging, generator off-box

A throwaway service in the staging environment ran the harness against the
deployed staging app over Railway's private network, so the generator was on
different hardware from the server it measured. **This is the measurement that
counts**; the sandbox run further down is kept only for contrast.

| Concurrent tills | Sales/sec | Sales/hour | p50 | p95 | p99 | Errors | KDS refresh p95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 4.2 | 15,120 | 190 ms | 204 ms | 642 ms | 1 | 358 ms |
| 4 | 16.6 | 59,904 | 191 ms | 219 ms | 377 ms | 0 | 186 ms |
| 8 | 33.3 | 119,736 | 192 ms | 205 ms | 372 ms | 0 | 186 ms |
| 16 | 64.9 | 233,496 | 192 ms | 219 ms | 379 ms | 0 | 183 ms |
| 32 | 129.9 | 467,532 | 193 ms | 219 ms | 374 ms | 0 | 184 ms |
| 64 | 254.4 | 915,948 | 191 ms | 236 ms | 518 ms | 0 | 189 ms |
| **128** | **359.1** | **1,292,904** | 269 ms | 382 ms | 475 ms | 0 | 197 ms |
| 256 | 366.8 | 1,320,588 | 417 ms | 877 ms | 975 ms | 0 | 200 ms |
| 512 | 358.5 | 1,290,564 | 785 ms | 2,278 ms | 2,467 ms | 0 | 200 ms |
| 768 | 354.5 | 1,276,236 | 1,180 ms | 3,460 ms | 4,015 ms | 0 | 207 ms |

### Sustained ceiling: ~360 settlements/second, ~1.3 million sales/hour

Throughput scales **perfectly linearly to 64 tills** — each doubling of tills
doubles sales/second while p50 stays pinned at ~191 ms — then saturates at
**~360/second from 128 tills onward**. Past that point, added concurrency buys
nothing but queueing: throughput is flat while latency grows in proportion to
the number of waiting tills, exactly as a saturated queue should.

That ceiling is about **13,000× the audit's 100/hour floor**. Ten times the
floor — 1,000 sales/hour — consumes 0.08% of it.

### Three properties worth more than the headline number

**It degrades by queueing, not by failing.** Zero errors at every level, right
up to 768 simultaneous tills with p95 at 3.5 seconds. Nothing was dropped, no
5xx, no pool exhaustion. For a POS this is the correct failure mode: a slow sale
is recoverable, a lost sale is not.

**Reads stay fast while writes queue.** `GET /api/app2/live` — the KDS/orders
refresh — held at **183–207 ms across every level**, unmoved while settlement
latency went up twentyfold. The kitchen screen keeps updating during a rush even
if the till is waiting. The sync poll does not share that property: it queues
alongside the writes (456 ms → 4.4 s), which is expected, and the 5s poll plus
SSE gives it room to catch up.

**The ~190 ms floor is network, not server.** Railway placed the generator in
`asia-southeast1` and the app runs in `sfo`, so every measurement carries a
cross-Pacific round trip. Server-side service time is far smaller than these
numbers suggest. It is also incidentally realistic: a till in the Maldives
talking to a US-hosted instance sees much the same.

### The bottleneck is one Node process, not the hardware

During saturation the staging app peaked at **1.15 of its 8 vCPU (14%)** and
**0.38 GB of its 8 GB (4.7%)**.

A single Node process executes JavaScript on one thread, so ~1.15 cores is
essentially that thread saturated plus some libuv threadpool. **Seven of the
eight allocated vCPU cannot be used by a single replica.** The ceiling above is
therefore a *single-process* ceiling, not a hardware one.

The lever is horizontal: `numReplicas`. The instance already has the CPU budget
for roughly eight replicas, and since the sync design is stateless behind
Postgres — with `LISTEN/NOTIFY` already fanning `poke` out across instances —
throughput should scale close to linearly with them. `PG_POOL_MAX` (currently
node-postgres's default of 10) is the second lever, and would need raising in
step; `pool.waiting` in `/api/metrics` is the signal for when it binds.

None of this is urgent. It is the difference between ~13,000× the requirement
and ~100,000× it.

### Caveats

- 15–20 s per level; this is a saturation test, not a soak test.
- Small baskets (1–4 lines). Larger cheques move more bytes per write.
- Single replica, 8 vCPU / 8 GB, `PG_POOL_MAX` unset.
- One transient connection error in ~1,900 requests at the 1-till level. That is
  precisely what `/api/ops` idempotency and the till's retrying outbox exist for,
  and it is recorded rather than rounded away.
- Roughly 40,000 synthetic sales were written into the staging database, all
  inside throwaway orgs named `load-<timestamp>@loadtest.invalid`.

---

## Contrast: the sandbox run

Run first, in a 4-core sandbox with the app, Postgres **and** the generator all
on one box. Peak 391 sales/second at 8 tills, then apparent degradation.

That degradation was the harness competing with the server it was measuring —
which the staging run confirms, since real hardware scaled cleanly to 64 tills
where the sandbox had already "peaked" at 8. Kept here as a worked example of why
a load generator must not share a machine with its target.

| Tills | Sales/hour | p95 | Errors |
| ---: | ---: | ---: | ---: |
| 1 | 590,652 | 8 ms | 0 |
| 8 | 1,408,788 | 28 ms | 0 |
| 16 | 1,049,544 | 70 ms | 0 |
| 32 | 804,132 | 192 ms | 0 |
| 48 | 748,620 | 313 ms | 0 |

---

## Running it again

Locally:

```bash
node test/load/loadtest.js --base http://127.0.0.1:4000 --levels 1,4,8,16 --seconds 15
```

On Railway, off-box (how the staging numbers above were produced):

1. Create a service in the **staging** environment from this repo.
2. Point it at `railway.loadgen.json` (`railwayConfigFile`) — it builds the same
   image the app builds, so the harness is already inside, and starts the
   harness instead of the server with no healthcheck and no restart.
3. Set `LOADGEN_BASE` (comma-separated candidates; prefer
   `http://<app>.railway.internal:8080`), `LOADGEN_LEVELS`, `LOADGEN_SECONDS`.
4. Read the deploy logs. **Delete the service.**

Two failure modes already paid for: a plain `node:*` image execs the start
command as argv without a shell, so anything containing `;` or `&&` dies
silently — which is why configuration goes through `LOADGEN_*` variables; and
pointing `railwayConfigFile` at a file that does not exist fails the build
outright rather than falling back.

The harness refuses hosts it can identify as production, because it writes real
sales into a real ledger. That check is a courtesy, not a guarantee — read the
URL before you press enter.
