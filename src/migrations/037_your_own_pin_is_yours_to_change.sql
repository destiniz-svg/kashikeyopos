-- ═══ YOUR OWN PIN IS YOURS TO CHANGE ══════════════════════════════════════
-- Settings offered "Reset floor PIN", took the current PIN and a new one,
-- validated the shape, toasted "PIN reset — use it at the next terminal
-- unlock", and queued `pin_reset`, which is AUDIT_ONLY. Nothing changed. The
-- old PIN kept working, and the person most likely to press that button is
-- somebody who has just watched a colleague read theirs over a shoulder.
--
-- It could not have been wired to PATCH /api/auth/staff/:id either: that is
-- rank 4, which is correct for resetting SOMEBODY ELSE's PIN, and wrong for
-- your own — a cashier changing their own credential should not need an
-- administrator, and `staff_write` requires rank >= 4 under RLS, so no policy
-- would have let the row through.
--
-- So this is a SECURITY DEFINER function, the same shape 005 uses for sign-in
-- and for the same reason: an act that must reach chain.staff before a rank
-- allows it. Its safety comes from what it will not do rather than from who
-- may call it:
--
--   · it changes exactly ONE row, `app.current_actor()`, which the transaction
--     set from the caller's own token. There is no parameter naming a victim;
--   · it verifies the CURRENT hash the caller supplies against the stored one
--     before writing, so holding a session is not enough — you have to know
--     the PIN you are replacing;
--   · it refuses a locked-out account, or the lockout would be a way to try
--     PINs at leisure;
--   · hashing stays in the application (scrypt, src/secrets.js). The database
--     compares hashes and never sees a PIN.
--
-- It returns false rather than raising on a wrong PIN: the handler charges the
-- attempt to the same two-tier budget every other wrong PIN pays into.
CREATE OR REPLACE FUNCTION chain.staff_pin_change(
  p_current_hash text, p_new_hash text, p_new_salt text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE me chain.staff%ROWTYPE;
BEGIN
  SELECT * INTO me FROM chain.staff WHERE id = app.current_actor();
  IF NOT FOUND OR NOT me.active THEN RETURN false; END IF;
  IF me.locked_until IS NOT NULL AND me.locked_until > now() THEN RETURN false; END IF;
  IF me.pin_hash IS DISTINCT FROM p_current_hash THEN RETURN false; END IF;

  UPDATE chain.staff SET pin_hash = p_new_hash, pin_salt = p_new_salt,
                         failed = 0, locked_until = NULL
   WHERE id = me.id;
  PERFORM chain.log('pin_reset', 'staff', me.id::text, NULL,
                    jsonb_build_object('self', true));
  RETURN true;
END $$;

-- The salt the caller must hash the current PIN with. Its own row only, so
-- this hands nobody anything they did not already have: they are holding a
-- session as this person.
CREATE OR REPLACE FUNCTION chain.staff_pin_salt()
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT pin_salt FROM chain.staff WHERE id = app.current_actor()
$$;

REVOKE ALL ON FUNCTION chain.staff_pin_change(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chain.staff_pin_salt() FROM PUBLIC;

DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname ~ '^outlet_[0-9]+_app$' LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION chain.staff_pin_change(text,text,text),'
      || ' chain.staff_pin_salt() TO %I', r);
  END LOOP;
END $$;
