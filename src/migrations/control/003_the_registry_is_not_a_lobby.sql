-- ═══ AND LEAST OF ALL THE REGISTRY ═════════════════════════════════════════
-- Business 039 shuts the default CONNECT that Postgres grants to PUBLIC on
-- every business database. The registry is the same door on the room that
-- matters most: it holds chain.account — every customer's email address, their
-- password hash, their sign-in codes — plus the business directory and the
-- handle registry.
--
-- No outlet role has ever had a reason to open a session here. Migration 011
-- revokes every privilege on the account plane from every one of them, and
-- test/tenancy.test.js has asserted the refusal since the boundary moved; what
-- it asserted was refusal at the TABLE. This is refusal at the door.
--
-- Nothing legitimate is affected: the app, Mission Control and the website all
-- reach the registry on the owner connection, and an owner cannot be locked
-- out of a database it owns.
--
-- Deliberately not conditional. There is no role that both needs the registry
-- and is not its owner, so there is nothing to enumerate and keep — which is
-- why this file is three lines where the business one is fifty.
-- ═══════════════════════════════════════════════════════════════════════════

DO $mig$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
END $mig$;
