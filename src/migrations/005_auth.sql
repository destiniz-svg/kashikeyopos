-- ═══ SIGN-IN, WITHOUT A POLICY HOLE ════════════════════════════════════════
-- A PIN has to be checked before a rank exists, and the failure counter has to
-- move on a wrong PIN — both while `app.user_rank` is still 0. Doing that with
-- an RLS policy would mean a permanently open door on chain.staff.
--
-- Instead the two operations are SECURITY DEFINER functions with a narrow
-- contract: one returns the candidate rows for one outlet (hash and salt, no
-- other column), the other records the outcome. Neither can be used to read a
-- staff list, and neither takes a rank.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION chain.pin_candidates(p_outlet int)
RETURNS TABLE (id uuid, name text, rank int, role_key text,
               pin_hash text, pin_salt text, locked_until timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT s.id, s.name, s.rank, s.role_key, s.pin_hash, s.pin_salt, s.locked_until
    FROM chain.staff s
   WHERE s.active
     AND (s.outlet_id = p_outlet OR p_outlet = ANY (s.outlets))
$$;

-- LOCK_TRIES failures at one outlet lock every unlocked account there for
-- LOCK_MINS. Brute force locks the door rather than probing it, and the lock
-- is recorded so a manager can see it happened.
CREATE OR REPLACE FUNCTION chain.pin_failed(p_outlet int, p_tries int, p_mins int)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE n int;
BEGIN
  UPDATE chain.staff SET failed = failed + 1,
    locked_until = CASE WHEN failed + 1 >= p_tries
      THEN now() + (p_mins || ' minutes')::interval ELSE locked_until END
   WHERE active AND (outlet_id = p_outlet OR p_outlet = ANY (outlets));
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM chain.log_anon(p_outlet, 'pin_failed', 'staff', NULL,
                         jsonb_build_object('accounts', n));
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION chain.pin_ok(p_staff uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE chain.staff SET failed = 0, locked_until = NULL WHERE id = p_staff
$$;

-- The very first owner. Callable only while no staff row exists at all, which
-- is exactly once in the life of an installation; after that it refuses and
-- accounts are created through the normal rank-4 path.
CREATE OR REPLACE FUNCTION chain.claim_first_owner(
  p_outlet int, p_name text, p_hash text, p_salt text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM chain.staff) THEN
    RAISE EXCEPTION 'an owner already exists';
  END IF;
  INSERT INTO chain.staff (name, rank, role_key, outlet_id, pin_hash, pin_salt)
  VALUES (p_name, 5, 'SuperAdmin', p_outlet, p_hash, p_salt)
  RETURNING id INTO v;
  PERFORM chain.log_anon(p_outlet, 'owner_claimed', 'staff', v::text, NULL);
  RETURN v;
END $$;

-- Is this installation still empty? The front door asks before deciding
-- between onboarding and the PIN pad, and it asks anonymously.
CREATE OR REPLACE FUNCTION chain.install_state()
RETURNS TABLE (outlets bigint, staff bigint, company bigint)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT (SELECT count(*) FROM chain.outlet),
         (SELECT count(*) FROM chain.staff),
         (SELECT count(*) FROM chain.company)
$$;

REVOKE ALL ON FUNCTION chain.pin_candidates(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION chain.pin_failed(int,int,int) FROM PUBLIC;
REVOKE ALL ON FUNCTION chain.pin_ok(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION chain.claim_first_owner(int,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chain.install_state() FROM PUBLIC;
