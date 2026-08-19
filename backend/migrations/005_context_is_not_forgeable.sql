-- ═══ THE REQUEST CONTEXT MUST NOT BE SELF-ASSERTED ═════════════════════════
--
-- Found by the rewritten leak test: an outlet's own role could set
-- `app.scope = 'group'` and `app.user_rank = 5` on its own connection and read
-- the whole estate's registry and staff, and could set `app.outlet_id` to a
-- number that was not its own and read that outlet's staff through RLS.
--
-- Four probes leaked:
--   forge group scope       → every outlet in chain.outlet, every row of chain.staff
--   forge group scope       → chain.estate_day() returned the estate's takings
--   claim another outlet id → that outlet's staff
--
-- The original design trusted `current_setting('app.*')` for identity. But a GUC is
-- set BY the connection, so it can only ever record what the caller claims, and
-- an RLS policy that resolves against a claim is a filter, not a boundary. It
-- held only while the application layer was the sole holder of the outlet role
-- passwords AND had no bug that let a rank travel wrong — which is exactly the
-- single point of failure the two-belt design exists to remove.
--
-- The fix: identity comes from the DATABASE ROLE, which the client cannot
-- change without already holding another role's password.
--
--   · An outlet connects as `outlet_<id>_app`. That role name IS the outlet id,
--     so app.current_outlet() reads it from current_user and ignores the GUC.
--     Claiming to be outlet 4 over outlet 3's connection now changes nothing.
--   · Group scope additionally requires connecting as `kashikeyo_report`, the
--     read-only role that holds no table grants at all and can only EXECUTE the
--     aggregate function. An outlet role saying "scope = group" is now just a
--     string in a variable nothing consults.
--
-- The GUCs still carry rank and actor for audit and for the rank gates. Those
-- are set from a verified session token and are not identity claims about which
-- TENANT is asking — which is the thing that must never be self-asserted.
-- ═══════════════════════════════════════════════════════════════════════════

-- The outlet a connection IS, read from the role it authenticated as.
-- NULL for the owner and report roles, which are not any one outlet.
CREATE OR REPLACE FUNCTION app.role_outlet() RETURNS int
  LANGUAGE sql STABLE AS $$
  SELECT nullif(substring(current_user from '^outlet_([0-9]+)_app$'), '')::int $$;

-- Identity: the role wins. The GUC is consulted only for connections that are
-- not an outlet role (migrations, provisioning, the estate reporting role),
-- which are the connections that legitimately act for an outlet they are not.
CREATE OR REPLACE FUNCTION app.current_outlet() RETURNS int
  LANGUAGE sql STABLE AS $$
  SELECT coalesce(app.role_outlet(),
                  nullif(current_setting('app.outlet_id', true), '')::int) $$;

-- Group scope: rank 5, asking for it, AND connected as the read-only reporting
-- role. All three, so no outlet connection can reach it however it sets its
-- variables. `kashikeyo_report` has no table grants, so even here the only
-- thing reachable across outlets is the aggregate function itself.
CREATE OR REPLACE FUNCTION app.group_scope() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT current_user = 'kashikeyo_report'
     AND coalesce(current_setting('app.scope', true) = 'group', false)
     AND app.current_rank() >= 5 $$;

-- chain.audit was INSERT-only for an outlet role, so the audit-log screen the
-- spec puts at Manager+ could not read a single row of its own outlet's trail.
-- Grant SELECT: the audit_read policy already restricts it to this outlet at
-- rank >= 3, and no UPDATE or DELETE grant is issued here or anywhere else —
-- append-only is enforced by the absence of the privilege, not by a policy.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT db_role FROM chain.outlet LOOP
    EXECUTE format('GRANT SELECT ON chain.audit TO %I', r.db_role);
  END LOOP;
END $$;
