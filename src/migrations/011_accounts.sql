-- ═══ THE ACCOUNT PLANE MOVED TO THE REGISTRY ════════════════════════════════
-- This migration used to create chain.account, chain.account_identity and
-- chain.account_outlet inside every install's database. That was right while
-- the product was sold one install per customer, and is wrong now that a
-- business is a DATABASE on a shared cluster:
--
--   one account may own several businesses, so sign-in in a business database
--   would have to search every database in the cluster to answer whether an
--   address is known — and "is this address registered" is the one question
--   src/routes/account.js promises twice over that it never reveals;
--
--   an account is authenticated ABOVE any outlet, before one has been chosen,
--   so there is nothing for it to be scoped to down here.
--
-- The tables are now in src/migrations/control/001_registry.sql, verbatim. This
-- file stays, under its own name and number, because a database that already
-- applied it has to be told to let them go — and because deleting a migration
-- is how two environments quietly stop being the same schema.
--
-- The drop is CASCADE so it takes chain.company.owner_account_id's foreign key
-- with it. The COLUMN survives on purpose: which account owns the business is
-- still a fact the business knows, it just points at a row in another database
-- now, the same way chain.outlet.slug points at the handle registry.
-- ═══════════════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS chain.account_outlet CASCADE;
DROP TABLE IF EXISTS chain.account_identity CASCADE;
DROP TABLE IF EXISTS chain.account CASCADE;

-- Re-asserted rather than assumed: 001 does not create it, and a business
-- restored from a backup taken before this must still end up with it.
ALTER TABLE chain.company ADD COLUMN IF NOT EXISTS owner_account_id uuid;
