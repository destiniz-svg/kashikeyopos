# Tenancy, RLS and isolation

Reference: `backend/migrations/001_control.sql`, `002_rls.sql`,
`003_outlet_provision.sql`, and `design/KashikeyoOps Deploy Readiness.dc.html`.

Two belts. Neither depends on the application remembering to filter.

---

## Belt one — schema and role per outlet

Outlet 3's data is in schema `outlet_3`. The server connects to it as role
`outlet_3_app`, which was granted `USAGE` on `outlet_3` **and nothing else**.

```sql
GRANT USAGE ON SCHEMA outlet_3, chain, app TO outlet_3_app;
ALTER ROLE outlet_3_app SET search_path = outlet_3, chain, public;
REVOKE ALL ON SCHEMA public FROM outlet_3_app;
```

Outlet 4's tables are not filtered out for that connection — they are
unreachable objects. No forgotten `WHERE`, no injected string and no ORM
mistake reaches them, because the privilege was never granted. The role holds no
`CREATE`, so it cannot add an object that escapes its own grants.

**One pool per outlet.** `backend/src/db.js` keys a `pg.Pool` by outlet id and
authenticates each as that outlet's role. Two outlets never share a connection.

**Passwords are derived, never stored:**
`password = hmac_sha256(OUTLET_ROLE_SECRET, "outlet:" + id)`.
Reading every row in outlet 3 yields no way to authenticate as outlet 4. Rotate
by changing the secret and re-running provisioning.

---

## Belt two — RLS on the control plane

Identity, the outlet registry, devices, sessions, tax versions, document series,
members and audit must be shared. They carry `ENABLE` **and** `FORCE ROW LEVEL
SECURITY` — without `FORCE`, the table owner bypasses every policy.

Policies resolve against three functions:

```sql
app.current_outlet()  -- nullif(current_setting('app.outlet_id', true),'')::int
app.current_rank()    -- 0 when unset
app.group_scope()     -- scope = 'group' AND rank >= 5
```

Set per transaction, transaction-locally:

```sql
SELECT set_config('app.outlet_id', $1, true),
       set_config('app.user_rank', $2, true),
       set_config('app.actor',     $3, true),
       set_config('app.scope',     $4, true);
```

**`true` is the whole point.** It makes the setting transaction-scoped, so it
dies at `COMMIT` and a pooled connection cannot carry one outlet's context into
the next request. That is the classic RLS leak in a Node application.

Policy summary:

| Table | Read | Write |
|---|---|---|
| `outlet` | own, or group scope | — |
| `staff` | own outlet, or group scope | rank ≥ 4, and never above own rank |
| `device` | own outlet, or group scope | own outlet |
| `session` | own outlet | own outlet |
| `tax_version` | own outlet, or group scope | rank ≥ 4 |
| `doc_series` | own outlet | own outlet |
| `audit` | own outlet at rank ≥ 3, or group scope | INSERT only |
| `member` | any signed-in outlet (chain loyalty) | rank ≥ 2, points ≥ 0 |

**Never add a table to `chain` without a policy.** Add a test that fails when a
`chain` table has RLS disabled.

---

## The one cross-outlet read

`chain.estate_day(date)`, `chain.estate_ledger(from, to)`,
`chain.estate_series(from, to)`, `chain.estate_alerts(date)` and
`chain.estate_last_trading(date)` — all `SECURITY DEFINER`, all refusing unless
`app.group_scope()`, all returning **aggregates only**, all reached through the
read-only `kashikeyo_report` role which has `EXECUTE` on them and no table
grants at all. Each read is stamped in `chain.audit` with `scope = 'group'`, by
the reporting connection itself: written on the owner's own outlet connection
the entry would be stamped `outlet`, and a trail that records the one
cross-outlet read as an ordinary local one is worse than no trail.

None of them returns an id of anything, so there is nothing to drill through
to. There is no code path that returns another outlet's rows to anyone.

`app.group_scope()` tests **`session_user`**, not `current_user`. Inside a
`SECURITY DEFINER` function `current_user` is the function's owner, so the
original test refused the reporting role along with everybody else and the
estate endpoint was a 500 for every owner who opened it. `session_user` is the
role that connected; `SET ROLE` cannot change it, which makes the test strictly
narrower than the one it replaced.

---

## Proving it

```
npm run leak-test -- 3 4
```

Connects as outlet 3's own role and makes ten attempts to reach outlet 4: direct
reads of its sales, tickets and ledger; catalogue probing for readable tables;
RLS on staff, document series and audit; forging group scope; claiming a
different outlet in the request context; and DDL escalation into the other
schema. Any `LEAK` line exits non-zero.

**Run it in the deploy pipeline**, not as a checklist item. Add a case whenever
you add a table.

---

## Application-level rules that still matter

- The outlet in a request path must equal the outlet in the token
  (`sameOutlet`), so a client bug cannot ask for a site it is not signed in to.
- Rank gates are server-side. The UI hiding a button is a courtesy, not a
  control.
- The owner connection (`DATABASE_URL`) is for migrations and provisioning only.
  `routes.js` does not import it, and a test should assert that.
- Guest origins and till origins are separate entries in `ALLOWED_ORIGINS`, and
  guest endpoints are the only ones a guest origin may call.
- PIN hashing is scrypt with a per-user salt. Lockout is 5 attempts / 15 minutes,
  enforced in the database, not in the client.
