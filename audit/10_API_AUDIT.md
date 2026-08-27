# 10 · API audit

~127 endpoints across three services (counts per router in 02). Every door
falls into one of four postures, and the wiring test pins the exceptions:

| Posture | Doors | Guards |
| --- | --- | --- |
| Anonymous by design | signup/code/verify/signin, guest token mint, member start/join, `/install`, roster, doc pages `/r/ /st/`, `/healthz` `/readyz` | rate-limited (two buckets), enumeration-identical bytes, table/member/doc tokens typed, roster reads a narrow view with no credential columns |
| Staff session | outlet router, sync, estate | `session()` verify (typ `s`) → `revoked.js` → `atLeast(rank)` → RLS underneath; `outlet mismatch` 403 at route AND belt |
| Account token | account router, onboarding steps | typ `a`, header-only (no query-string fallback), business ownership checked by registry, refused-by-name for others' businesses |
| Operator key | `/api/platform/*` (PLATFORM_KEY ≥32, constant-time), `/metrics` (METRICS_KEY), panel admin (scrypt + HMAC) | 404 when unset; every platform read audited |

Properties tested (suite + this pass's probes): authn on every non-anonymous
door; authz never UI-only; input validation with refusals **by name**
(constraint 23514 translated, trigger RAISE repeated verbatim); output shape
pinned for the platform door (nothing can ride in later); idempotency on sync
push (op_id PK) and on every upsert; transaction boundaries per-op savepoints
+ one-transaction money; pagination/limits (200-op push cap, list caps, 48 MB
import limit); tenant isolation at DB level; concurrency via row locks
(doc_series under row lock, credit floored, advisory locks for DDL); malformed
JSON → 4xx with safe message; DB down → `stillGood` fails open for reads,
writes surface honestly; no IDOR (ids scoped by outlet context, uuids for
member-plane), no mass assignment (explicit column lists everywhere — no ORM).

Webhooks: none exist (no payment gateway integration) — nothing to verify,
and nothing pretends otherwise since R-1.
