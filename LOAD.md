# What this build does under a rush

Seven stages, run against a real install with a real Postgres behind it, using
`src/scripts/loadtest.js`. Every stage settles real bills through the real
`/sync/push` handler — no mock, no shortcut round the money path.

**Where these ran, and what that costs.** Locally, on the development
container: one Node process, one Postgres on the same box, loopback between
them. The staging install is unreachable from here (the outbound proxy refuses
the domain), so **the throughput figures below are hardware-bound and do not
predict Railway**. Re-run the same seven stages against staging before quoting a
capacity number to anybody.

What DOES transfer is the second half of every stage — the correctness checks.
Duplicate sales, unbalanced journals, revenue that does not tie to the sales
that made it, and repairs the server had to make are properties of the logic,
not of the machine, and they held at every stage including the one designed to
break things.

| Stage | Shape | Bills | p50 | p95 | p99 | Errors | Money |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A · baseline | 1 till, 15s | 2,449 | 6 ms | 8 ms | 11 ms | 0 | ✅ |
| B · busy service | 4 tills, 30s | 6,134 | 16 ms | 37 ms | 56 ms | 0 | ✅ |
| C · Friday peak | 8 tills, 30s | 6,243 | 29 ms | 95 ms | 139 ms | 0 | ✅ |
| D · spike | 8 outboxes draining, 60 ops a batch, 25s | 5,460 | 1,793 ms | 5,105 ms | 7,598 ms | 0 | ✅ |
| E · soak | 4 tills, 4 minutes | 50,289 | 16 ms | 36 ms | 54 ms | 0 | ✅ |
| F · stress | 40 concurrent tills, 30s | 5,779 | 179 ms | 305 ms | 386 ms | 0 | ✅ |
| G · recovery | back to 1 till, 15s | 2,414 | 6 ms | 8 ms | 12 ms | 0 | ✅ |

About 79,000 bills in total, every one of them written, journalled and read
back.

## What each stage actually says

**A, and then G.** The floor is 6 ms and the recovery is the same 6 ms, to the
millisecond, after 79,000 bills and a deliberate 40-way stress. Nothing was left
degraded — no pool exhausted, no connection leaked, no queue still draining.
Baseline-and-recovery is only worth running as a pair, and the pair is the
point.

**C is the real question and it is not close.** Eight tills at 29 ms p50 is a
restaurant with eight terminals all ringing continuously, and this install is
not noticing.

**D is the one with a number worth arguing about.** A till that has been offline
does not push a bill at a time — it drains, and the evening arrives as one batch
inside one transaction. Sixty ops in a batch is 1.8 s at the median and 7.6 s at
the worst. That is the till waiting, not the counter: the operator who is
standing at the terminal is not blocked by it, and nothing was lost or
duplicated. But it scales with the batch, so a device that has been down for a
whole service will sit there for the better part of ten seconds on reconnect,
and it is worth knowing that before somebody reports it as a hang. Splitting a
large drain into chunks is the obvious answer and is **not** implemented.

**E is the leak check.** Four minutes, 50,289 bills, and the server's resident
memory finished on exactly the number it started on — 149 MB, +0. p50 at minute
four is p50 at minute one.

**F is where it should have broken and did not.** Forty concurrent tills is five
times the peak any single outlet will ever see. Throughput is flat from 8
workers to 40 — roughly 700,000 bills an hour either way — so the limit here is
throughput-bound rather than error-bound: the extra concurrency queues, waits,
and still completes. Zero errors, zero duplicates, every journal balanced.

## The one thing the run found

The revenue tie-out failed on the first attempt, off by exactly MVR 100.00. It
was not the load and it was not the code: a row called `A-SECRET-SALE`, inserted
straight into the table by an isolation probe, which therefore has no journal
and never had one.

The fix was **not** to exclude sales without journals — that is precisely the
defect the check exists to catch. It takes a snapshot before the run and asserts
the DELTA is zero, so what this run did and what the install was already
carrying stay separate facts. The pre-existing gap is printed on every run,
by amount, rather than netted away.

## Running them

```bash
node src/scripts/loadtest.js --url <base> --outlet <id> --pin <pin> \
  --workers 8 --seconds 30 --label "C · Friday peak"

# the spike stage: whole outboxes draining
node src/scripts/loadtest.js ... --workers 8 --burst 60 --seconds 25
```

It writes real sales. Never point it at a store that is trading.
