-- ═══ PIN SIGN-IN ═══════════════════════════════════════════════════════════
--
-- Two problems with the handed-over sign-in, both found by trying to use it.
--
-- 1. IT COULD NOT WORK. The route does `UPDATE chain.staff SET failed = 0` to
--    clear the counter and `UPDATE ... failed + 1` to count a bad attempt, but
--    an outlet role is granted SELECT on chain.staff and nothing more, so every
--    sign-in died with "permission denied for table staff".
--
--    Granting UPDATE would be worse than the bug. The staff_write policy allows
--    a write only at rank >= 4, and a caller signing IN has no rank yet — so
--    the grant would have to be paired with a policy loose enough to let an
--    unauthenticated request modify staff rows, which is the opposite of what
--    is wanted. A lockout counter and a staff record are different things with
--    different rules, and they were sharing one privilege.
--
--    So the counters move behind a SECURITY DEFINER function that can touch
--    `failed` and `locked_until` and NOTHING else. chain.staff keeps its
--    SELECT-only grant; a rank-4 admin editing people still goes through RLS.
--
-- 2. IT WAS O(n) SCRYPT PER ATTEMPT. The route pulled every active staff row at
--    the outlet and ran scrypt against each until one matched. Scrypt is
--    deliberately expensive, so a 40-person outlet did 40 KDF passes for one
--    wrong PIN — a free denial-of-service from an unauthenticated endpoint, and
--    a timing signal that leaks how far down the list a PIN sits.
--
--    `pin_lookup` is a fast keyed digest of (outlet, PIN) that narrows the
--    candidates to the one or two staff who share a PIN, and scrypt then
--    verifies only those. The digest is keyed with a pepper held in the
--    environment, never in the database, so reading every row of chain.staff
--    still gives no way to test a PIN offline. It is a lookup key, not a
--    credential: pin_hash + pin_salt remain the thing that authenticates.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE chain.staff ADD COLUMN IF NOT EXISTS pin_lookup text;
CREATE INDEX IF NOT EXISTS staff_pin_lookup ON chain.staff(outlet_id, pin_lookup)
  WHERE active AND pin_lookup IS NOT NULL;

-- Candidates for a PIN, at one outlet. SECURITY DEFINER because an
-- unauthenticated caller has no rank and so cannot pass the staff_scoped
-- policy; the function is the boundary instead, and it returns only what the
-- verifier needs — never the whole row, and never anybody else's.
CREATE OR REPLACE FUNCTION chain.pin_candidates(p_outlet int, p_lookup text)
RETURNS TABLE (id uuid, name text, rank int, pin_hash text, pin_salt text,
               locked_until timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT s.id, s.name, s.rank, s.pin_hash, s.pin_salt, s.locked_until
    FROM chain.staff s
   WHERE s.outlet_id = p_outlet AND s.active AND s.pin_lookup = p_lookup
   LIMIT 8
$$;

-- Record the outcome of an attempt. The ONLY thing that may change `failed` or
-- `locked_until`, and it can change nothing else — no rank, no PIN, no name.
--
-- A failure counts against every unlocked account at the outlet, not just a
-- guessed one: with PIN-only sign-in the attacker does not name an account, so
-- counting per-account would let them walk the space one account at a time
-- while no single counter ever climbed.
CREATE OR REPLACE FUNCTION chain.note_pin_attempt(
  p_outlet int, p_staff uuid, p_ok boolean, p_tries int, p_lock_mins int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_ok THEN
    UPDATE chain.staff SET failed = 0, locked_until = NULL WHERE id = p_staff;
  ELSE
    UPDATE chain.staff
       SET failed = failed + 1,
           locked_until = CASE WHEN failed + 1 >= p_tries
                               THEN now() + make_interval(mins => p_lock_mins)
                               ELSE locked_until END
     WHERE outlet_id = p_outlet AND active
       AND (locked_until IS NULL OR locked_until <= now());
  END IF;
END $$;

-- Sessions are written by the sign-in path before any rank exists, so the same
-- reasoning applies: the row is created through a definer function that sets
-- only what a session is, rather than by granting an unauthenticated caller
-- INSERT on the table.
CREATE OR REPLACE FUNCTION chain.open_session(
  p_staff uuid, p_outlet int, p_device uuid, p_rank int, p_ttl_hours int)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO chain.session (staff_id, outlet_id, device_id, rank, expires_at)
  VALUES (p_staff, p_outlet, p_device, p_rank,
          now() + make_interval(hours => p_ttl_hours))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- An audit row for a sign-in is written before the actor has a rank, so the
-- INSERT policy on chain.audit (which resolves against app.current_outlet())
-- cannot be satisfied from a bare connection. Same treatment.
CREATE OR REPLACE FUNCTION chain.log_signin(p_outlet int, p_staff uuid, p_ok boolean)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO chain.audit (outlet_id, actor, rank, action, entity, entity_id, scope)
  VALUES (p_outlet, p_staff, 0,
          CASE WHEN p_ok THEN 'signin' ELSE 'signin_failed' END,
          'staff', p_staff::text, 'outlet')
$$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT db_role FROM chain.outlet LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION chain.pin_candidates(int,text),'
      || ' chain.note_pin_attempt(int,uuid,boolean,int,int),'
      || ' chain.open_session(uuid,int,uuid,int,int),'
      || ' chain.log_signin(int,uuid,boolean) TO %I', r.db_role);
  END LOOP;
END $$;
