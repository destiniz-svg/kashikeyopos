-- ═══ A MEMBER SIGNS IN TO THEIR OWN CARD ═══════════════════════════════════
-- The member portal is the one surface where the person holding the phone is
-- neither staff nor anonymous. They must reach their OWN record and nothing
-- else — not the roster, not another member's points, not a price a cashier
-- has not rung.
--
-- The mechanism mirrors the PIN path exactly, and for the same reason: a code
-- has to be set and checked while `app.user_rank` is 0, which an RLS policy
-- cannot express without leaving chain.member permanently open. So it is three
-- SECURITY DEFINER functions with a narrow contract — set, take, clear —
-- none of which can enumerate members and none of which takes a rank.
--
-- The code itself is generated and hashed in the web tier (scrypt, per-row
-- salt), exactly like a PIN. What is stored here is never the code.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS code_hash  text;
ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS code_salt  text;
ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS code_exp   timestamptz;
ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS code_tries int NOT NULL DEFAULT 0;
ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS last_seen  timestamptz;

-- Set a fresh code on a member who exists. Returns their id, or NULL — and
-- the caller must answer identically either way, or this becomes a way to ask
-- whether a phone number is a customer here.
-- Postgres will not rename an input parameter through CREATE OR REPLACE, and
-- this file is re-applied whenever it changes, so drop first. The signature
-- below is the one the grants name.
DROP FUNCTION IF EXISTS chain.member_code_set(text, text, text, int);
DROP FUNCTION IF EXISTS chain.member_code_take(text);

-- `p_id` is whatever the member typed: the phone on the card or the email on
-- the membership. One lookup either way, because asking a guest which of the
-- two the restaurant filed them under is a question they cannot answer.
CREATE OR REPLACE FUNCTION chain.member_code_set(p_id text, p_hash text,
  p_salt text, p_mins int)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE m uuid;
BEGIN
  UPDATE chain.member
     SET code_hash = p_hash, code_salt = p_salt,
         code_exp = now() + (p_mins || ' minutes')::interval,
         code_tries = 0
   WHERE phone = p_id OR lower(email) = lower(p_id)
   RETURNING id INTO m;
  RETURN m;
END $$;

-- Read the challenge back and count the attempt in the same statement, so a
-- caller cannot try repeatedly without the counter moving.
CREATE OR REPLACE FUNCTION chain.member_code_take(p_id text)
RETURNS TABLE (id uuid, code_hash text, code_salt text, code_exp timestamptz,
               code_tries int, name text, points numeric, tier text)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  UPDATE chain.member m SET code_tries = m.code_tries + 1
   WHERE (m.phone = p_id OR lower(m.email) = lower(p_id))
     AND m.code_hash IS NOT NULL
   RETURNING m.id, m.code_hash, m.code_salt, m.code_exp, m.code_tries,
             m.name, m.points, m.tier;
END $$;

-- A used challenge is spent. It is cleared on success and on the try that
-- exhausts it, so neither a stale code nor an exhausted one stays live.
CREATE OR REPLACE FUNCTION chain.member_code_clear(p_id uuid, p_seen boolean)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE chain.member
     SET code_hash = NULL, code_salt = NULL, code_exp = NULL, code_tries = 0,
         last_seen = CASE WHEN p_seen THEN now() ELSE last_seen END
   WHERE id = p_id
$$;

-- One member's own card, by id. No enumeration, no other row.
CREATE OR REPLACE FUNCTION chain.member_card(p_id uuid)
RETURNS TABLE (id uuid, name text, phone text, email text, points numeric,
               tier text, credit_limit numeric, joined_at timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT m.id, m.name, m.phone, m.email, m.points, m.tier, m.credit_limit,
         m.joined_at
    FROM chain.member m WHERE m.id = p_id
$$;

REVOKE ALL ON FUNCTION chain.member_code_set(text, text, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION chain.member_code_take(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chain.member_code_clear(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION chain.member_card(uuid) FROM PUBLIC;

-- Outlets provisioned before this migration already have their role; grant the
-- four new functions to each of them. A migration that only fixes NEW outlets
-- is a migration that silently splits the estate in two.
DO $grant$
DECLARE o record;
BEGIN
  FOR o IN SELECT db_role FROM chain.outlet WHERE db_role IS NOT NULL LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION chain.member_code_set(text,text,text,int),'
      || ' chain.member_code_take(text), chain.member_code_clear(uuid,boolean),'
      || ' chain.member_card(uuid) TO %I', o.db_role);
  END LOOP;
END $grant$;
