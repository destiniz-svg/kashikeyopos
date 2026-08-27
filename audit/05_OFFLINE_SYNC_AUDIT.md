# 05 · Offline & synchronization audit

The offline architecture: every mutation → `queue()` → durable IndexedDB
outbox (keyed by client v4 `opId`) → `POST /sync/push`, applied per-op in its
own savepoint, chunked 25 per transaction; `op_log.op_id` is the primary key
with `ON CONFLICT DO NOTHING`, so replay is structurally a no-op. The network
pill (`KPOS_BRIDGE.setOffline`) is a real switch, not a simulation.

## The thirteen scenarios

| # | Scenario | Mechanism | Proof |
| --- | --- | --- | --- |
| 1 | Online create→pay→close | ordinary path | api/chain/e2e suites; loadtest money checks |
| 2 | Fully offline service, reconnect | outbox holds durably; drain on reconnect; server repairs/flags, never rejects a sale | sync tests; two-browser drives (CLAUDE.md measured tables) |
| 3 | Disconnect before payment, reconnect | ops idempotent by `opId`; ticket ops name tickets by table (`ticketRef`) so an offline-created ticket is find-or-create, not duplicate | api tests: replayed batch = no-op |
| 4 | Disconnect during payment | the sale op is one op: applied whole or not at all (savepoint); retry replays the same `opId` → no double charge, no duplicate sale | loadtest "no duplicate op landed twice / exactly one sale row" at every stage |
| 5 | Two devices offline, both sell | both drain; lamport orders; last portion oversell is **named** (`stock_short`), never blocked or lost | api test "a sale that oversells says which ingredient went short" |
| 6 | Conflicting menu edits | upserts keyed by device-minted CSPRNG ids (collision class closed, 20k-draw test); scalar conflicts resolve LWW by lamport — *documented limitation, not silent* | wiring id tests |
| 7 | Flapping link | outbox paces on delivery; refusals park after 8 (never network failures); nothing double-applies | sync/wiring tests |
| 8 | Kill during sync | server committed chunks are replay-safe; client marks rows only on 200; restart re-pushes remainder | chunked-drain design + tests |
| 9 | Kill after local commit, before sync | IndexedDB is durable; op survives restart and even sign-out (named, not blocked) | wiring tests; sign-out flow |
| 10 | Duplicate sync request | `op_id` PK; seen-set spans the whole push | api test: same batch twice → second all no-ops |
| 11 | Replay cannot duplicate accounting | seen op short-circuits before the handler runs — no journal, no points, no stock | loadtest + api replay tests |
| 12 | Device clock changes | server stamps `clock_timestamp()`; lamport is causal, not wall-clock; `sale.at` ordering server-side | tick-window tests |
| 13 | Timezone changes | business date = outlet TZ via `SET LOCAL`, one place; suite runs under UTC **and** Indian/Maldives | both-TZ full runs (final: 486/0 under both, after the kill-sweep and lock-scope fixes) |

## Cross-install and cross-device fences

- **Install uuid** (migration 026) stamped on every queued op; a mismatched op
  PARKS with the reason. Sheds trade-local state on install change.
- **A refusal is not a network failure**: 8 refusals park; parked lane offers
  resend (fresh allowance) or discard (rank-gated, `op_discarded` audit op).
- **Holding pen** (`state.local`, `catMeta`, prefs, loyalty edits): re-sent
  once per session when the outlet lacks the row, dropped the moment the
  outlet publishes it — matched by identity, fenced on `outletAnswered()`,
  sections before dishes.

## Verified limits (stated, not hidden)

- Concurrent scalar edits are last-write-wins by lamport (per-field merge not
  built). The losing write is the earlier event, deterministically.
- The 5 s live slice carries floor + takings; points/credit/stock ride the
  5-minute bootstrap (documented "slow floor").
- IndexedDB quota: `writeSession` sheds history before live state, ladder
  registers a fault; settled cache is a refillable copy (server refills).

## Re-audit finding

The one intermittent in the matrix (`57P01` in random suites) was **the test
harness, not the app**: `test/api.test.js`'s pool-guard proof killed every
`kashikeyo-%` backend cluster-wide and shot parallel suites' connections.
Scoped to `datname = current_database()` in this pass; three subsequent full
runs green.
