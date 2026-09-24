-- 057 · A revoked card is closed.
--
-- Revoking a member spent their live code and refused a new one, and left the
-- thirty-day member token they already held working: member_card() answered
-- for any id, so a revoked guest kept reading their card, and the order door
-- kept attributing rounds (and so points) to them. The row and its history
-- stay; the card simply stops answering for it.
--
-- Same signature, so CREATE OR REPLACE keeps every outlet role's grant.
CREATE OR REPLACE FUNCTION chain.member_card(p_id uuid)
RETURNS TABLE (id uuid, name text, phone text, email text, points numeric,
               credit_limit numeric, joined_at timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT m.id, m.name, m.phone, m.email, m.points, m.credit_limit, m.joined_at
    FROM chain.member m WHERE m.id = p_id AND m.revoked_at IS NULL
$$;
