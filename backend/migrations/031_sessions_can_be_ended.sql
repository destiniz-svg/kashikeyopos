-- ═══════════════════════════════════════════════════════════════════════════
-- A session could be revoked, and revoking it did nothing.
--
-- `chain.session` has carried `revoked_at` since migration 001 and every row
-- of it has always been decoration. `auth.js` verifies the JWT's signature and
-- expiry and STOPS THERE — it never looks the session up — so the column was
-- written by nothing and read by nothing. There has never been a way to sign
-- anybody out of this system. A staff member walking out with a phone, a till
-- left in a taxi, a PIN shared with somebody who has since been dismissed: all
-- of them held a working session until it expired on its own, up to twelve
-- hours later.
--
-- Migration 030 needed exactly this to be true and found it was not: revoking a
-- device marks its sessions, and the marks meant nothing.
--
-- THE CHECK GOES IN THE STATEMENT THAT IS ALREADY THERE. Every request opens a
-- transaction and sets its context in one round trip (`withOutlet` in db.js);
-- this function is called in that same SELECT, so a live session costs no
-- additional trip to the database. That matters more than it sounds: a check
-- with a latency cost is a check somebody eventually caches, and a cached
-- revocation is not a revocation.
--
-- SECURITY DEFINER, taking the ids as ARGUMENTS rather than reading the GUCs —
-- it is called in the same SELECT as the `set_config` calls that establish
-- them, and expression evaluation order inside one SELECT is not something to
-- build an authorisation check on.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION chain.session_live(p_session uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  /* NULL is live. A session id is not on every token — the guest tokens and
     the older staff tokens issued before this migration carry none — and
     refusing those would sign out every terminal in the estate at deploy time
     to enforce a rule none of them had yet broken. They keep working until
     they expire on their own, which is at most one session's length. */
  SELECT p_session IS NULL
      OR EXISTS (SELECT 1 FROM chain.session s
                  WHERE s.id = p_session
                    AND s.revoked_at IS NULL
                    AND s.expires_at > now())
$$;

DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT db_role FROM chain.outlet LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION chain.session_live(uuid) TO %I', o.db_role);
  END LOOP;
  -- The estate connection asks the same question about the same session.
  EXECUTE 'GRANT EXECUTE ON FUNCTION chain.session_live(uuid) TO kashikeyo_report';
END $$;
