-- ═══ A PIN HASH NEVER LEAVES THE DATABASE ═════════════════════════════════
-- chain.pin_candidates() handed the application every staff member's pin_hash
-- and pin_salt at that outlet, on every sign-in attempt, and the application
-- compared them in Node. Nothing about that was a vulnerability on its own —
-- it is the outlet's own role reading the outlet's own rows — but it is an
-- AMPLIFIER, and the security audit named it as one: a four-digit PIN is ten
-- thousand candidates, so anything that so much as reads the application's
-- memory or logs recovers every PIN at that outlet in seconds. The hash is
-- supposed to be the thing that makes a leak survivable, and handing it out on
-- every keypress spends that protection before it is needed.
--
-- The comparison moves in here, and the hashes stop travelling. Two facts make
-- that possible without changing how a PIN is hashed:
--
--   · a SALT is not a secret. It exists so two people with the same PIN do not
--     share a hash, and publishing it costs nothing — so the application can
--     still be handed the salts it needs;
--   · sign-in does not know WHO is signing in. It has to try every candidate,
--     which it already did. So the application hashes the typed PIN once per
--     salt — exactly the work it was doing — and asks the database which row,
--     if any, matches. It learns one id. It never learns a hash.
--
-- scrypt stays in the application (src/secrets.js): Postgres has no scrypt,
-- and swapping the KDF would mean re-hashing every PIN, which cannot be done
-- without the plaintext. Nothing about the stored rows changes.
--
-- chain.pin_candidates() is dropped rather than left in place. A function that
-- returns hashes, sitting granted to every outlet role with no caller, is the
-- next person's shortcut.

-- The salts to hash against, and the lockout state that decides whether a row
-- may be tried at all. No hash.
CREATE OR REPLACE FUNCTION chain.pin_salts(p_outlet int)
RETURNS TABLE (id uuid, pin_salt text, locked_until timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT s.id, s.pin_salt, s.locked_until
    FROM chain.staff s
   WHERE s.active
     AND (s.outlet_id = p_outlet OR p_outlet = ANY (s.outlets))
$$;

-- Which of the offered (id, hash) pairs is right, if any. The array arrives as
-- two parallel arrays because that is what a driver sends cleanly; the pairing
-- is by ordinal. A locked account never matches, so the lockout is enforced
-- here as well as read above — the caller cannot decide to ignore it.
CREATE OR REPLACE FUNCTION chain.pin_match(
  p_outlet int, p_ids uuid[], p_hashes text[])
RETURNS TABLE (id uuid, name text, rank int, role_key text)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT s.id, s.name, s.rank, s.role_key
    FROM chain.staff s
    JOIN unnest(p_ids, p_hashes) AS t(sid, h) ON t.sid = s.id
   WHERE s.active
     AND (s.outlet_id = p_outlet OR p_outlet = ANY (s.outlets))
     AND (s.locked_until IS NULL OR s.locked_until <= now())
     AND s.pin_hash = t.h
   LIMIT 1
$$;

-- The faces on the lock screen. This was reading chain.pin_candidates() too,
-- selecting the four columns it wanted out of a row that also carried a hash —
-- which worked, and meant the ANONYMOUS roster endpoint was one edited SELECT
-- away from serving hashes to the internet. It gets its own narrow view, so
-- the widest-open door in the build cannot reach a credential even by mistake.
CREATE OR REPLACE FUNCTION chain.roster(p_outlet int)
RETURNS TABLE (id uuid, name text, rank int, role_key text, locked_until timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT s.id, s.name, s.rank, s.role_key, s.locked_until
    FROM chain.staff s
   WHERE s.active
     AND (s.outlet_id = p_outlet OR p_outlet = ANY (s.outlets))
   ORDER BY s.rank DESC, s.name
$$;

REVOKE ALL ON FUNCTION chain.roster(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION chain.pin_salts(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION chain.pin_match(int, uuid[], text[]) FROM PUBLIC;

DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname ~ '^outlet_[0-9]+_app$' LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION chain.pin_salts(int),'
      || ' chain.pin_match(int, uuid[], text[]), chain.roster(int) TO %I', r);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS chain.pin_candidates(int);

-- AND THE COLUMN ITSELF, or the function was theatre. Every outlet role holds
-- SELECT on chain.staff, and `staff_scoped` returns the whole row — so the
-- hashes were still one `SELECT pin_hash FROM chain.staff` away and closing
-- the function changed nothing an attacker would care about. Verified before
-- and after by connecting AS the outlet role and asking.
--
-- Postgres has column-level privileges, so this is exact: SELECT on every
-- column except the two, and INSERT/UPDATE left whole. Writing a hash you
-- generated is ordinary — a PIN reset does it — and it is reading somebody
-- else's that is the amplifier.
DO $$ DECLARE r text; cols text; BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'chain' AND table_name = 'staff'
     AND column_name NOT IN ('pin_hash', 'pin_salt');

  FOR r IN SELECT rolname FROM pg_roles WHERE rolname ~ '^outlet_[0-9]+_app$' LOOP
    EXECUTE format('REVOKE SELECT ON chain.staff FROM %I', r);
    EXECUTE format('GRANT SELECT (%s) ON chain.staff TO %I', cols, r);
  END LOOP;
END $$;
