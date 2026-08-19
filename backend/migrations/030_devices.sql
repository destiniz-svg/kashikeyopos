-- ═══════════════════════════════════════════════════════════════════════════
-- Devices — 02-POS-SPEC §2 (`sync`): "Outbox state, device pairing, remote
-- diagnostics." 08-BUILD-STAGES §28.
--
-- `chain.device` has existed since migration 001 and has never held a row. The
-- sign-in route takes `deviceId` from the request body and stamps it into the
-- session and the JWT WITHOUT CHECKING IT AGAINST ANYTHING — no such row need
-- exist, it need not belong to this outlet, and `revoked` was a column nothing
-- ever read. Meanwhile the terminal never sent one, so every row in every
-- `op_log` carries `device_id NULL` and no screen could tell one till from
-- another. Both halves of that are fixed here.
--
-- WHAT PAIRING IS, AND WHAT IT IS NOT. Pairing IDENTIFIES a device; it does not
-- authenticate one. The device id lives in that till's own local storage and is
-- not a secret — anyone holding the machine can read it, and anyone can invent
-- one. The credential is still the PIN. So:
--
--   · an UNKNOWN device id is treated as no device at all. It grants nothing,
--     it is not an error, and the till goes on working unpaired. Refusing it
--     would mean a new machine could not be used until somebody paired it,
--     which is the wrong failure on a Friday night.
--   · a REVOKED device id is refused outright, and revoking also kills every
--     open session bound to it. That is what makes revocation worth having: a
--     till left in a taxi stops mid-shift rather than at the next sign-in.
--   · the honest limit, stated here so no screen has to imply otherwise: a
--     dishonest holder of that machine can clear the storage and sign in again
--     as an unpaired device. Revocation stops an HONEST till and flags a
--     dishonest one. The PIN and the audit trail are the controls.
-- ═══════════════════════════════════════════════════════════════════════════

-- The pairing code and who did what to the record. `pair_code` and `paired_at`
-- were already there; everything a pairing flow actually needs was not.
ALTER TABLE chain.device ADD COLUMN IF NOT EXISTS pair_code_expires timestamptz;
ALTER TABLE chain.device ADD COLUMN IF NOT EXISTS paired_by  uuid;
ALTER TABLE chain.device ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE chain.device ADD COLUMN IF NOT EXISTS revoked_by uuid;
ALTER TABLE chain.device ADD COLUMN IF NOT EXISTS added_by   uuid;
ALTER TABLE chain.device ADD COLUMN IF NOT EXISTS added_at   timestamptz NOT NULL DEFAULT now();
-- What the device says it is. Reported, never trusted: it is useful for
-- telling two identical tills apart in a list and for nothing else.
ALTER TABLE chain.device ADD COLUMN IF NOT EXISTS app_version text;
ALTER TABLE chain.device ADD COLUMN IF NOT EXISTS platform    text;
ALTER TABLE chain.device ADD COLUMN IF NOT EXISTS note        text;

-- A live pair code has to be unique to be typed in. Expired and NULL ones are
-- not in the index, so a code can be reused years later without a collision
-- and a device with no code costs nothing.
CREATE UNIQUE INDEX IF NOT EXISTS device_pair_code_live
  ON chain.device (pair_code) WHERE pair_code IS NOT NULL;

-- ── who may do what ────────────────────────────────────────────────────────
--
-- The old policy was `FOR ALL` with a WITH CHECK that only pinned the outlet —
-- so it would have allowed any rank to write, if any rank had held the grant.
-- Reading is anyone in session: the till needs to know whether IT is paired,
-- and a cashier looking at "this device is not paired" is the person who will
-- fetch the manager. Writing is MANAGER, because adding, renaming and revoking
-- a till is a shift decision, not an admin one — the manager is who is standing
-- there when a machine dies.
DROP POLICY IF EXISTS device_scoped ON chain.device;
DROP POLICY IF EXISTS device_read ON chain.device;
CREATE POLICY device_read ON chain.device FOR SELECT
  USING (outlet_id = app.current_outlet() OR app.group_scope());
DROP POLICY IF EXISTS device_write ON chain.device;
CREATE POLICY device_write ON chain.device FOR ALL
  USING (outlet_id = app.current_outlet() AND app.current_rank() >= 3)
  WITH CHECK (outlet_id = app.current_outlet() AND app.current_rank() >= 3);

-- ── claiming a code, before anybody has signed in ──────────────────────────
--
-- A device claims its code from the PAIRING SCREEN, which is reachable before a
-- PIN has been entered — that is the point of it, the machine has to be usable
-- before it is trusted. So there is no rank in the transaction and the policy
-- above matches nothing. SECURITY DEFINER, doing the whole thing at once, with
-- the checks inside it:
--
--   · the code must exist, be for THIS outlet, be unexpired and unrevoked
--   · it is consumed on use — a pairing code is single-use or it is a password
--   · the returned id is the record's own id, so there is no second identifier
--     for the two sides to disagree about
CREATE OR REPLACE FUNCTION chain.claim_device(
  p_outlet int, p_code text, p_platform text, p_version text)
RETURNS TABLE (id uuid, label text, kind text)
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE d chain.device%ROWTYPE;
BEGIN
  SELECT * INTO d FROM chain.device
   WHERE outlet_id = p_outlet AND pair_code = upper(btrim(p_code))
     AND NOT revoked
     AND (pair_code_expires IS NULL OR pair_code_expires > now())
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that pairing code is not valid here';
  END IF;
  UPDATE chain.device
     SET pair_code = NULL, pair_code_expires = NULL, paired_at = now(),
         last_seen = now(),
         platform = coalesce(nullif(btrim(p_platform), ''), platform),
         app_version = coalesce(nullif(btrim(p_version), ''), app_version)
   WHERE chain.device.id = d.id;
  RETURN QUERY SELECT d.id, d.label, d.kind;
END $fn$;

-- ── the heartbeat ──────────────────────────────────────────────────────────
--
-- Called on sign-in and on every replay push. SECURITY DEFINER for the same
-- reason: sign-in has no rank yet, and a device that only updated `last_seen`
-- once somebody had a session would go quiet exactly when a diagnostics screen
-- most needs it. It touches one column on one row and can do nothing else.
--
-- Returns the device's state so the caller can act on it: `revoked` is what
-- sign-in refuses on.
CREATE OR REPLACE FUNCTION chain.device_seen(p_outlet int, p_device uuid)
RETURNS TABLE (known boolean, revoked boolean, label text)
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE d chain.device%ROWTYPE;
BEGIN
  IF p_device IS NULL THEN
    RETURN QUERY SELECT false, false, NULL::text;
    RETURN;
  END IF;
  SELECT * INTO d FROM chain.device
   WHERE chain.device.id = p_device AND outlet_id = p_outlet;
  IF NOT FOUND THEN
    /* Unknown is not an error. See the header: an unpaired till works. */
    RETURN QUERY SELECT false, false, NULL::text;
    RETURN;
  END IF;
  IF NOT d.revoked THEN
    UPDATE chain.device SET last_seen = now() WHERE chain.device.id = d.id;
  END IF;
  RETURN QUERY SELECT true, d.revoked, d.label;
END $fn$;

-- ── revoking a device kills what it is holding ─────────────────────────────
--
-- Marking the row and leaving the open sessions alive would mean a till lost at
-- 19:00 keeps selling until its token expires at midnight. Revocation has to
-- reach the sessions or it is a note in a table.
CREATE OR REPLACE FUNCTION chain.revoke_device(p_device uuid, p_by uuid)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE n int; o int;
BEGIN
  SELECT outlet_id INTO o FROM chain.device WHERE id = p_device;
  IF o IS NULL OR o <> app.current_outlet() THEN
    RAISE EXCEPTION 'no such device here';
  END IF;
  IF app.current_rank() < 3 THEN
    RAISE EXCEPTION 'revoking a device is a manager decision';
  END IF;
  UPDATE chain.device
     SET revoked = true, revoked_at = now(), revoked_by = p_by,
         pair_code = NULL, pair_code_expires = NULL
   WHERE id = p_device;
  UPDATE chain.session SET revoked_at = now()
   WHERE device_id = p_device AND revoked_at IS NULL AND expires_at > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

-- ── grants ─────────────────────────────────────────────────────────────────
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT db_role FROM chain.outlet LOOP
    -- SELECT was already granted in 003; the writes are new. No DELETE: a
    -- device that existed is part of the record of who rang what up, and
    -- deleting the row would orphan every op_log entry that names it.
    EXECUTE format('GRANT INSERT, UPDATE ON chain.device TO %I', o.db_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION chain.claim_device(int,text,text,text),'
      || ' chain.device_seen(int,uuid), chain.revoke_device(uuid,uuid) TO %I', o.db_role);
  END LOOP;
END $$;
