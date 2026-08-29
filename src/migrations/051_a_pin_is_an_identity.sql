-- ═══ A PIN IS AN IDENTITY, SO IT BELONGS TO ONE PERSON ══════════════════════
--
-- Reported as "I cannot add staffs", and the staff path had three faults. This
-- is the one that mattered, and it was invisible from every screen.
--
-- `chain.pin_match()` ended in a bare `LIMIT 1` with no ORDER BY and no check
-- that the match was unique. Two people sharing four digits therefore both
-- matched, and Postgres returned whichever row the plan happened to yield —
-- which is not stable between calls. Measured on a real outlet: one cashier and
-- one owner given the same PIN, and three consecutive sign-ins with those four
-- digits returned
--
--     Dupe A Cashier | rank 2
--     Dupe B Owner   | rank 5
--     Dupe A Cashier | rank 2
--
-- So a cashier keying their own PIN was signed in AS THE OWNER — rank 5, the
-- estate read, GST registration, the store rename, the trade reset — and every
-- void, discount and drawer opening they made that shift was attributed to
-- somebody else. The whole point of a per-person PIN, stated on that screen in
-- those words, is that those acts are attributable. Nothing enforced it.
--
-- Two halves, and the build already keeps both rules one plane over:
--
--   · AMBIGUITY RESOLVES TO NOBODY. `chain.member_resolve()` (046) refuses two
--     members whose numbers normalise alike, and migration 018 refuses two
--     members on one email, for exactly this reason: take-one-silently is one
--     person acting as another. A duplicate PIN now matches NOTHING, so the
--     keypad refuses rather than guessing — and a store that already holds
--     duplicates keeps every row. Evicting a person from their own account is
--     not a migration's call; refusing to guess between them is.
--
--   · AND THE DOOR REFUSES A DUPLICATE BEFORE IT IS CREATED, so the state above
--     is one nobody new can enter. `chain.pin_taken()` answers it — the same
--     salt-per-row walk sign-in already does, because a hash is salted and
--     "is this PIN in use" cannot be asked any other way.
--
-- The hashes still never leave the database (038): the caller is handed salts,
-- hashes the candidate once per salt, and asks which rows match. It learns a
-- count, or an id.

-- ── ambiguity resolves to nobody ────────────────────────────────────────────
-- `LIMIT 1` is gone. The row comes back only where it is the ONLY row that
-- matched; two matches yield none, which the keypad reports as a PIN it cannot
-- act on rather than as a person.
CREATE OR REPLACE FUNCTION chain.pin_match(
  p_outlet int, p_ids uuid[], p_hashes text[])
RETURNS TABLE (id uuid, name text, rank int, role_key text)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  WITH hit AS (
    SELECT s.id, s.name, s.rank, s.role_key
      FROM chain.staff s
      JOIN unnest(p_ids, p_hashes) AS t(sid, h) ON t.sid = s.id
     WHERE s.active
       AND (s.outlet_id = p_outlet OR p_outlet = ANY (s.outlets))
       AND (s.locked_until IS NULL OR s.locked_until <= now())
       AND s.pin_hash = t.h
  )
  SELECT id, name, rank, role_key FROM hit
   WHERE (SELECT count(*) FROM hit) = 1
$$;

-- ── and how many people already key these four digits ───────────────────────
-- Counted across the outlet the same way sign-in matches, INCLUDING the locked
-- and the suspended: a PIN belonging to a suspended colleague is still theirs,
-- and handing it to somebody new is how the suspension gets undone by accident
-- the day they are reinstated. `p_except` is the person whose PIN is being
-- reset — re-setting it to what it already was is not a collision with itself.
CREATE OR REPLACE FUNCTION chain.pin_taken(
  p_outlet int, p_ids uuid[], p_hashes text[], p_except uuid DEFAULT NULL)
RETURNS int
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT count(*)::int
    FROM chain.staff s
    JOIN unnest(p_ids, p_hashes) AS t(sid, h) ON t.sid = s.id
   WHERE (s.outlet_id = p_outlet OR p_outlet = ANY (s.outlets))
     AND s.pin_hash = t.h
     AND (p_except IS NULL OR s.id <> p_except)
$$;

-- The salts to hash against, for the two callers above. `chain.pin_salts()`
-- filters to ACTIVE staff, which is right for signing in and wrong for asking
-- whether a PIN is spoken for — so the collision check gets its own view, and
-- it is the only difference between them.
CREATE OR REPLACE FUNCTION chain.pin_salts_all(p_outlet int)
RETURNS TABLE (id uuid, pin_salt text)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT s.id, s.pin_salt
    FROM chain.staff s
   WHERE s.outlet_id = p_outlet OR p_outlet = ANY (s.outlets)
$$;

REVOKE ALL ON FUNCTION chain.pin_match(int, uuid[], text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION chain.pin_taken(int, uuid[], text[], uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION chain.pin_salts_all(int) FROM PUBLIC;

-- Every outlet role that exists today, and chain.provision_outlet() grants the
-- new pair to every outlet made after this — a dropped-and-recreated function
-- takes its grants with it, which is the trap migration 019 paid for once.
-- Roles are discovered from the outlet_% SCHEMAS actually present rather than
-- from a list somebody maintains — migration 039 settled that rule, and a role
-- that serves no schema in this database is not this migration's to touch.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^outlet_[0-9]+$' LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.nspname || '_app') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION chain.pin_match(int,uuid[],text[]),'
        || ' chain.pin_taken(int,uuid[],text[],uuid), chain.pin_salts_all(int) TO %I',
        r.nspname || '_app');
    END IF;
  END LOOP;
END $$;
