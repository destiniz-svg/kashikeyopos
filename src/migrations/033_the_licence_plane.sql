-- ═══ WHAT THE INSTALL KNOWS ABOUT ITS OWN LICENCE ═══════════════════════════
-- The product is sold one install per customer, and until now the commercial
-- state of that customer — trial or paid, and when the trial runs out — lived
-- ONLY in the seller's registry (`panel.install`). The install itself had no
-- idea. So a trial ending was an event that happened in Mission Control, on a
-- screen the customer cannot see, and the first they heard of it was a phone
-- call.
--
-- This is the other end of that fact, and it is deliberately a SEPARATE PLANE
-- rather than a row in `chain.setting`, for one reason: `chain.setting` is
-- writable by any rank-4 admin. A licence a customer can edit is not a licence,
-- it is a text field — and while nothing here ever blocks a sale, an install
-- that quietly says "paid" because somebody changed it is a fact nobody can
-- rely on afterwards.
--
-- So it is READ by every outlet and WRITTEN by nobody inside one:
--
--   · SELECT is granted, with a read policy, because the till has to render
--     the countdown and the owner has to see what they are on;
--   · INSERT and UPDATE are granted to NO outlet role at all. The only writer
--     is the owner connection, reached through the platform door — which is
--     already guarded by PLATFORM_KEY, already constant-time compared, and
--     already audited on every read.
--
-- That is the second belt in this build's own vocabulary — protection by
-- absence of grant, the same shape migration 011 uses for the account plane —
-- and `test/api.test.js` holds it to the invariant either way.
--
-- NULL is a real answer here. An install nobody has sold has no licence, and
-- inventing a trial for it would put a countdown on a demo box and a deadline
-- in front of a developer. No row means no notice.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chain.licence (
  id          int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  kind        text NOT NULL DEFAULT 'trial'
                CHECK (kind IN ('trial', 'paid', 'internal')),
  -- Null on a paid or internal install: there is nothing to count down to.
  -- A trial with no end date is a trial nobody set a deadline on, which the
  -- till renders as "on trial" and no countdown rather than as expired.
  trial_ends  date,
  -- What the seller wants the customer to read, in their own words, when the
  -- notice appears. Optional: the shipped wording is written for the ordinary
  -- case and a blank note is not a missing one.
  note        text NOT NULL DEFAULT '',
  set_at      timestamptz NOT NULL DEFAULT now(),
  set_by      text NOT NULL DEFAULT 'platform'
);

ALTER TABLE chain.licence ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain.licence FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS licence_read ON chain.licence;
-- Anybody signed in to any outlet on this install may read it. There is one
-- licence per install and every outlet on it is under the same one, so there
-- is nothing to scope BY — but the transaction still has to say who it is,
-- which is what keeps a pooled connection with no context from reading it.
CREATE POLICY licence_read ON chain.licence FOR SELECT
  USING (app.current_outlet() IS NOT NULL);

-- Existing outlets, whose role was created before this table existed.
DO $mig$
DECLARE o record;
BEGIN
  FOR o IN SELECT db_role FROM chain.outlet WHERE db_role IS NOT NULL LOOP
    EXECUTE format('GRANT SELECT ON chain.licence TO %I', o.db_role);
    -- Said out loud, so a future blanket GRANT has to argue with this line.
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON chain.licence FROM %I', o.db_role);
  END LOOP;
END $mig$;
