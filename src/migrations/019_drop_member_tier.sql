-- ═══ A TIER IS DERIVED, SO THERE IS NOTHING TO STORE ═══════════════════════
-- `chain.member.tier` was a cache, and every surface stopped reading it when
-- the ladder became one ladder: `memberLive()` composes the seed row with what
-- the outlet has awarded since and works the tier out from POINTS against the
-- published thresholds, every time it is asked for. That is what lets a
-- merchant raise a threshold and demote exactly the members it should without
-- editing a soul.
--
-- A cache nothing reads is not harmless. It is a column that still holds
-- 'Platinum' for a guest sitting in Bronze, and the next person to write a
-- query will read it — which is precisely the defect that produced three
-- disagreeing tier ladders in the first place. The column goes.
--
-- The two functions that carried it out to a phone are recreated without it.
-- Neither return type can be changed in place, so each is dropped and rebuilt,
-- and the grants dropped with them are put back for every outlet that already
-- exists. `chain.provision_outlet()` grants them by signature, which has not
-- changed, so new outlets need nothing.
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS chain.member_code_take(text);

-- Read the challenge back and count the attempt in the same statement, so a
-- caller cannot try repeatedly without the counter moving.
CREATE FUNCTION chain.member_code_take(p_id text)
RETURNS TABLE (id uuid, code_hash text, code_salt text, code_exp timestamptz,
               code_tries int, name text, points numeric)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  UPDATE chain.member m SET code_tries = m.code_tries + 1
   WHERE (m.phone = p_id OR lower(m.email) = lower(p_id))
     AND m.code_hash IS NOT NULL
   RETURNING m.id, m.code_hash, m.code_salt, m.code_exp, m.code_tries,
             m.name, m.points;
END $$;

DROP FUNCTION IF EXISTS chain.member_card(uuid);

-- One member's own card, by id. No enumeration, no other row. The tier is not
-- here because the phone is TOLD the ladder and the points and reads the tier
-- off both — a figure sent from here could disagree with the one the counter
-- shows the same guest a second later.
CREATE FUNCTION chain.member_card(p_id uuid)
RETURNS TABLE (id uuid, name text, phone text, email text, points numeric,
               credit_limit numeric, joined_at timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT m.id, m.name, m.phone, m.email, m.points, m.credit_limit, m.joined_at
    FROM chain.member m WHERE m.id = p_id
$$;

REVOKE ALL ON FUNCTION chain.member_code_take(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chain.member_card(uuid) FROM PUBLIC;

DO $grant$
DECLARE o record;
BEGIN
  FOR o IN SELECT db_role FROM chain.outlet WHERE db_role IS NOT NULL LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION chain.member_code_take(text),'
      || ' chain.member_card(uuid) TO %I', o.db_role);
  END LOOP;
END $grant$;

-- Last, because the functions above still named it until a moment ago.
ALTER TABLE chain.member DROP COLUMN IF EXISTS tier;
