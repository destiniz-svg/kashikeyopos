-- ═══ THE INVITATION CARRIES A LINK ═════════════════════════════════════════
-- Until now the invitation WAS the four-digit code: minted at the counter and
-- read out loud. That works across a counter and nowhere else — it cannot be
-- put in an email, because a code in an inbox is a credential in an inbox.
--
-- So the invitation splits in two, which is also what makes it safe to send:
--
--   the TOKEN says WHO. Long, single-use, seven days, in the link. Tapping it
--   proves possession of the message, and nothing more;
--   the CODE says IT IS THEM. Four digits, ten minutes, five tries — and it
--   goes to the address ON THE MEMBERSHIP, never one typed on the landing
--   screen, so a link forwarded to somebody else cannot sign them in.
--
-- Neither half is enough alone, which is the point. A forwarded link reaches a
-- landing card and a code that goes somewhere else; a guessed code has no
-- membership to attach to.
--
-- WHAT IS STORED IS THE HASH, never the token — the same discipline as a staff
-- PIN and a member code. A database dump is not a bag of live invitations.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS invite_token_hash text;
ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS invite_token_exp  timestamptz;
ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS invite_token_used timestamptz;

-- Two members cannot hold one token, for the same reason two cannot hold one
-- email: the lookup takes a row, and a lookup that can take the wrong one is a
-- guest signed into somebody else's card.
CREATE UNIQUE INDEX IF NOT EXISTS member_invite_token
  ON chain.member (invite_token_hash) WHERE invite_token_hash IS NOT NULL;

-- Inviting, now with the token. Everything migration 017 established holds:
-- the address is resolved here and a channel with none is refused BY NAME, the
-- count moves, and a revoked member is restored because handing someone a
-- fresh invitation IS restoring their access.
--
-- Issuing a token INVALIDATES the previous one — that is what makes a resend
-- an invalidation rather than a second live key, so an invitation forwarded to
-- the wrong person stops working the moment a good one is sent.
CREATE OR REPLACE FUNCTION chain.member_invite(p_id uuid, p_via text,
  p_to text, p_by uuid, p_token_hash text, p_days int)
RETURNS TABLE (id uuid, name text, phone text, email text, points numeric,
               invite_count int, invited_to text, was_revoked boolean,
               token_exp timestamptz)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE m chain.member%ROWTYPE;
        addr text;
BEGIN
  IF p_via IS NULL OR p_via NOT IN ('email','viber','whatsapp') THEN
    RAISE EXCEPTION 'not a channel this build can invite on: %', coalesce(p_via, 'none');
  END IF;

  SELECT * INTO m FROM chain.member WHERE chain.member.id = p_id;
  IF NOT FOUND THEN RETURN; END IF;

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
         revoked_at = NULL, revoked_by = NULL,
         invite_token_hash = p_token_hash,
         invite_token_exp = now() + (coalesce(p_days, 7) || ' days')::interval,
         invite_token_used = NULL
   WHERE u.id = p_id
  RETURNING u.id, u.name, u.phone, u.email, u.points, u.invite_count,
            u.invited_to, (m.revoked_at IS NOT NULL), u.invite_token_exp;
END $$;

DROP FUNCTION IF EXISTS chain.member_invite(uuid, text, text, uuid);

-- Revoking kills the link as well as the code. A revocation that leaves a
-- working link in somebody's inbox is not one.
CREATE OR REPLACE FUNCTION chain.member_revoke(p_id uuid, p_by uuid)
RETURNS TABLE (id uuid, name text) LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE chain.member
     SET revoked_at = now(), revoked_by = p_by,
         code_hash = NULL, code_salt = NULL, code_exp = NULL, code_tries = 0,
         invite_token_hash = NULL, invite_token_exp = NULL
   WHERE chain.member.id = p_id
  RETURNING chain.member.id, chain.member.name
$$;

-- ONE MEMBERSHIP, BY TOKEN. The phone posts the token it was handed and the
-- server answers with that row and no other. The roster must never carry these
-- — a roster that did would hand every device the keys to every account, which
-- is the opposite of what a token is for.
--
-- A lapsed token still resolves, and says so. The membership is real: dropping
-- someone with points on an account onto a dead end tells them there is
-- nothing here for them, which is false.
CREATE OR REPLACE FUNCTION chain.member_by_invite(p_hash text)
RETURNS TABLE (id uuid, name text, phone text, email text, points numeric,
               joined_at timestamptz, invited_at timestamptz,
               invited_by_name text, token_exp timestamptz,
               used boolean, revoked boolean)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT m.id, m.name, m.phone, m.email, m.points, m.joined_at, m.invited_at,
         s.name, m.invite_token_exp,
         (m.invite_token_used IS NOT NULL), (m.revoked_at IS NOT NULL)
    FROM chain.member m
    LEFT JOIN chain.staff s ON s.id = m.invited_by
   WHERE m.invite_token_hash = p_hash AND p_hash IS NOT NULL
$$;

-- Spent on use. The token opened the card once; the code is what signs anybody
-- in, and it went to the address on the membership.
CREATE OR REPLACE FUNCTION chain.member_invite_spend(p_hash text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE m uuid;
BEGIN
  UPDATE chain.member SET invite_token_used = now()
   WHERE invite_token_hash = p_hash AND p_hash IS NOT NULL
     AND invite_token_used IS NULL AND invite_token_exp > now()
     AND revoked_at IS NULL
   RETURNING id INTO m;
  RETURN m;
END $$;

REVOKE ALL ON FUNCTION chain.member_invite(uuid, text, text, uuid, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION chain.member_revoke(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION chain.member_by_invite(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chain.member_invite_spend(text) FROM PUBLIC;

DO $grant$
DECLARE o record;
BEGIN
  FOR o IN SELECT db_role FROM chain.outlet WHERE db_role IS NOT NULL LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION'
      || ' chain.member_invite(uuid,text,text,uuid,text,int),'
      || ' chain.member_revoke(uuid,uuid),'
      || ' chain.member_by_invite(text),'
      || ' chain.member_invite_spend(text) TO %I', o.db_role);
  END LOOP;
END $grant$;
