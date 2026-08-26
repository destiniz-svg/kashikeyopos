-- ═══ A DATABASE IS NOT A LOBBY ═════════════════════════════════════════════
-- Postgres grants CONNECT on every database to PUBLIC. One app now serves many
-- customers off one cluster, so that default means any outlet's login role can
-- open a session on ANY business's database.
--
-- WHAT IT COULD NOT DO, and this matters for judging the size of it: read
-- anything. Measured against two real stores created the way a customer
-- creates one — chain.member, chain.staff, chain.outlet, chain.company and the
-- other business's own outlet schema were all refused, "permission denied for
-- schema", which is belt one holding exactly as designed. No money, no
-- members, no staff, no recipes.
--
-- WHAT IT COULD DO: sit inside another customer's database and read the system
-- catalogs, which Postgres makes world-readable. Schema names and object
-- counts — the existence and shape of somebody else's install. Metadata, not
-- data.
--
-- Closed anyway, for two reasons. The guarantee this build states is that an
-- outlet role is refused AT another business's database, and refusing it a
-- layer earlier is what makes that sentence literally true rather than true
-- about the rows. And a session that cannot be opened cannot be the starting
-- point of the next thing somebody finds.
--
-- ORDER IS THE WHOLE SAFETY OF THIS FILE. The grants come first and the revoke
-- last, in one transaction, so there is no instant at which a store's own role
-- has lost CONNECT and not yet been given it back. If it were the other way
-- round, a migration that failed halfway would take the shop off the air.
--
-- WHO KEEPS IT:
--   · every outlet_<id>_app whose schema is IN THIS DATABASE. Derived from the
--     schemas actually present, not from a list somebody has to maintain, and
--     not from chain.outlet — a role whose row was deleted but whose schema
--     survives still has to be able to reach it to be cleaned up.
--   · kashikeyo_report, the read-only estate role, if it exists yet. On a fresh
--     database the runner creates it AFTER the files, and grants CONNECT there
--     too, so either order arrives at the same place.
--   · the database owner and any superuser, implicitly and unrevokably — which
--     is what the application itself connects as.
--
-- The remedy if this ever goes wrong is the one /readyz already prints:
-- `npm run provision:outlet -- --all` re-runs chain.provision_outlet(), which
-- grants CONNECT along with every other grant. And /readyz would say so within
-- seconds, because it checks out each outlet's own login role.
-- ═══════════════════════════════════════════════════════════════════════════

DO $mig$
DECLARE
  db   text := current_database();
  r    text;
  kept int := 0;
BEGIN
  -- 1 · every outlet role with a schema here keeps its way in.
  FOR r IN
    SELECT 'outlet_' || substring(nspname FROM '^outlet_([0-9]+)$') || '_app'
      FROM pg_namespace
     WHERE nspname ~ '^outlet_[0-9]+$'
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', db, r);
      kept := kept + 1;
    END IF;
  END LOOP;

  -- 2 · and the estate read role, where it exists yet.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kashikeyo_report') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO kashikeyo_report', db);
  END IF;

  -- 3 · only now does the door close on everybody else.
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', db);

  RAISE NOTICE 'connect: % outlet role(s) keep %', kept, db;
END $mig$;
