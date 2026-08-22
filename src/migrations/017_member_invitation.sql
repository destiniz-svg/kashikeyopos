-- ═══ AN INVITATION IS AN EVENT, NOT A BOOLEAN ══════════════════════════════
-- The invite was a flag flipped in bulk: no channel, no time, no sender, no
-- resend, no revoke — and on a row where the field was simply absent it
-- claimed the customer already had access.
--
-- What support actually needs to answer is "was this person invited, how, by
-- whom, when, and is that invitation still good". So the row records it:
--
--   invited_via   email · viber · whatsapp
--   invited_to    the address it actually went to, as it was then
--   invited_by    the staff member who handed it over
--   invited_at    when
--   invite_count  how many times (a resend reissues the code, so the previous
--                 link stops working — an invitation forwarded to the wrong
--                 person cannot be used)
--   revoked_at    withdrawn, and by whom. The history STAYS: a revoked row
--   revoked_by    reads "Revoked", never "Not invited".
--
-- The invitation is what makes a membership a login: `chain.member_code_set()`
-- refuses a revoked member, so the gate is in the database rather than in a
-- phone choosing to respect it.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS invited_via  text;
ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS invited_to   text;
ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS invited_by   uuid;
ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS invited_at   timestamptz;
ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS invite_count int NOT NULL DEFAULT 0;
ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS revoked_at   timestamptz;
ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS revoked_by   uuid;

DO $c$
BEGIN
  ALTER TABLE chain.member ADD CONSTRAINT member_invited_via_known
    CHECK (invited_via IS NULL OR invited_via IN ('email','viber','whatsapp'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $c$;

-- A revoked member cannot be issued a sign-in code at all. Enforced here
-- rather than in a handler: this is the one function every sign-in path goes
-- through, and a gate with two doors is a gate with one door.
CREATE OR REPLACE FUNCTION chain.member_code_set(p_id text, p_hash text,
  p_salt text, p_mins int)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE m uuid;
BEGIN
  UPDATE chain.member
     SET code_hash = p_hash, code_salt = p_salt,
         code_exp = now() + (p_mins || ' minutes')::interval,
         code_tries = 0
   WHERE (phone = p_id OR lower(email) = lower(p_id))
     AND revoked_at IS NULL
   RETURNING id INTO m;
  RETURN m;
END $$;

-- Inviting: resolves the address for the channel, records the event and bumps
-- the count. Un-revokes, because handing someone a fresh invitation IS
-- restoring their access — doing one without the other would leave a member
-- holding a code that cannot work.
--
-- A channel the customer has no address for is refused BY NAME rather than
-- falling back to one they did not choose. Viber and WhatsApp both ride the
-- mobile number already on file; email carries no per-message fee and the
-- address is already on the membership. Nothing here asks the guest for
-- something they have not already given, which is the point of inviting from
-- that row.
--
-- The refusal lives here rather than in the handler because both the count and
-- the address come off the same row: a handler that read the row, decided, and
-- then wrote could invite on an address that changed in between.
CREATE OR REPLACE FUNCTION chain.member_invite(p_id uuid, p_via text,
  p_to text, p_by uuid)
RETURNS TABLE (id uuid, name text, phone text, invite_count int,
               invited_to text, was_revoked boolean)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE m chain.member%ROWTYPE;
        addr text;
BEGIN
  IF p_via IS NULL OR p_via NOT IN ('email','viber','whatsapp') THEN
    RAISE EXCEPTION 'not a channel this build can invite on: %', coalesce(p_via, 'none');
  END IF;

  SELECT * INTO m FROM chain.member WHERE chain.member.id = p_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- p_to lets the counter correct an address at the moment of inviting; with
  -- nothing passed it is whatever the membership already holds.
  addr := nullif(btrim(coalesce(p_to,
    CASE WHEN p_via = 'email' THEN m.email ELSE m.phone END, '')), '');

  IF addr IS NULL THEN
    RAISE EXCEPTION '% has no % address on file — add one on the customer first',
      coalesce(m.name, m.phone, 'this customer'),
      CASE WHEN p_via = 'email' THEN 'email' ELSE 'mobile' END;
  END IF;

  RETURN QUERY
  UPDATE chain.member u
     SET invited_via = p_via, invited_to = addr, invited_by = p_by,
         invited_at = now(), invite_count = u.invite_count + 1,
         revoked_at = NULL, revoked_by = NULL
   WHERE u.id = p_id
  -- m is the row as it was BEFORE this statement, so the caller can say
  -- "restored" rather than "invited". RETURNING would give the new value,
  -- which is never revoked and therefore never worth reporting.
  RETURNING u.id, u.name, u.phone, u.invite_count, u.invited_to,
            (m.revoked_at IS NOT NULL);
END $$;

-- Revoking: stops the sign-in, spends any live code, and KEEPS the history.
-- The row reads "Revoked", never "Not invited" — support has something to read
-- either way, and a member who was let go can be told why.
CREATE OR REPLACE FUNCTION chain.member_revoke(p_id uuid, p_by uuid)
RETURNS TABLE (id uuid, name text) LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE chain.member
     SET revoked_at = now(), revoked_by = p_by,
         code_hash = NULL, code_salt = NULL, code_exp = NULL, code_tries = 0
   WHERE chain.member.id = p_id
  RETURNING chain.member.id, chain.member.name
$$;

REVOKE ALL ON FUNCTION chain.member_invite(uuid, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION chain.member_revoke(uuid, uuid) FROM PUBLIC;

DO $grant$
DECLARE o record;
BEGIN
  FOR o IN SELECT db_role FROM chain.outlet WHERE db_role IS NOT NULL LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION chain.member_invite(uuid,text,text,uuid) TO %I', o.db_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION chain.member_revoke(uuid,uuid) TO %I', o.db_role);
  END LOOP;
END $grant$;
