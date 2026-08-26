-- ═══ A BACKUP NOBODY RECORDED IS A BACKUP NOBODY CAN FIND ═══════════════════
-- The app used to take none: `backup_run`, `backup_create` and `restore_run`
-- were audit-only ops that recorded the press and did nothing, and the Settings
-- cards said so out loud. It takes them now, so there has to be a shelf saying
-- what is on it.
--
-- IN THE REGISTRY, NOT IN THE BUSINESS. A business's own record of its backups
-- lives inside the database those backups exist to replace: the one moment you
-- need to read it is the moment it is gone. It also has to span businesses,
-- because one run backs up the whole fleet and the registry itself, and
-- "which customers did last night's run miss" is not a question any single
-- business database can answer.
--
-- WHAT IS DELIBERATELY NOT HERE: the archive. This table is a manifest, not a
-- store — bytes go to the destination src/backup.js was configured with, and
-- putting a customer's whole database inside the database would double every
-- install's size and make the backup share the fate of the thing it backs up.
--
-- A FAILED RUN IS A ROW. It is the row that matters most: a shelf showing only
-- successes reads as "backed up nightly" on an install whose last four nights
-- failed. Both states are written, and the watchdog reads `ok`.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chain.backup (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL means the registry itself, which is not a business and still has to
  -- be backed up: it holds the accounts, the directory and the handles, and a
  -- fleet of restored businesses nothing can route to is not a restore.
  business_id  bigint REFERENCES chain.business(id) ON DELETE SET NULL,
  db_name      text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  ok           boolean NOT NULL DEFAULT false,
  -- Where it went, in the words the driver uses: "file:/var/backups/x.dump",
  -- "s3://bucket/key". One string, so a person reading this table knows where
  -- to go without knowing which driver was configured that night.
  location     text,
  driver       text,
  bytes        bigint,
  -- What was written, so a restore can prove it read back what was written
  -- rather than a truncated upload. Checked on restore.
  sha256       text,
  -- The schema version the archive carries. A dump restored into a build that
  -- has moved on is not wrong, but it is BEHIND, and requireAtHead() will
  -- refuse the business until the fleet runner catches it up — which is a
  -- thing to know before the restore, not after.
  schema_version int,
  -- pg_dump's own version, because an archive is only readable by a
  -- pg_restore at least as new as the pg_dump that wrote it.
  tool_version text,
  -- Named, never rounded up: the same rule chain.business.build_state follows.
  why          text,
  by_whom      text
);

CREATE INDEX IF NOT EXISTS backup_recent
  ON chain.backup (business_id, started_at DESC);
-- The watchdog's question is "when did the last GOOD one finish", and it asks
-- it every sweep.
CREATE INDEX IF NOT EXISTS backup_good
  ON chain.backup (finished_at DESC) WHERE ok;

-- Nothing but the owner connection writes here, for the same reason migration
-- 033 grants no outlet role INSERT on chain.licence: a record a till can edit
-- is not a record. There is no grant statement because there is no role to
-- grant to — the registry refuses a session from every outlet role at the door
-- (control/003), so this is protection by absence of both.
