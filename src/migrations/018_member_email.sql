-- ═══ AN EMAIL IS A SECOND IDENTITY, SO IT HAS TO BE UNIQUE ═════════════════
-- `chain.member_code_set()` and `chain.member_code_take()` both resolve a
-- member with `phone = $1 OR lower(email) = lower($1)`, and both take the
-- result with `RETURNING ... INTO`, which on a multi-row match takes ONE row
-- and says nothing. So two customers sharing an address means a sign-in code
-- minted against whichever of them the planner reached first — one guest let
-- into another's card, points, receipts and credit balance.
--
-- That was survivable only because the email could not be entered: no screen
-- in the terminal had the field, so every row's email was null. It is being
-- added now, which makes this a real door rather than a theoretical one.
--
-- The phone already carries NOT NULL UNIQUE. This gives the email the same
-- promise, partial because the column is nullable and a business that takes
-- names and numbers at the counter will leave most of them empty.
-- ═══════════════════════════════════════════════════════════════════════════

-- Rows written before the constraint existed are REPAIRED rather than left to
-- break the index: the address stays with the member who has held it longest,
-- and the loser's copy moves into their notes rather than being deleted. An
-- address a business collected is not this migration's to throw away, and a
-- support answer of "it was on the record until an upgrade" is worse than a
-- messy note. Idempotent: a second run finds nothing to move.
DO $repair$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id, email, joined_at,
           row_number() OVER (PARTITION BY lower(email) ORDER BY joined_at, id) AS n
      FROM chain.member
     WHERE email IS NOT NULL
  LOOP
    IF r.n > 1 THEN
      UPDATE chain.member
         SET notes = concat_ws(E'\n', nullif(notes, ''),
               'Email ' || r.email || ' cleared on upgrade: another customer,'
               || ' registered earlier, already held it. Confirm with the guest'
               || ' which record is theirs.'),
             email = NULL
       WHERE id = r.id;
      RAISE NOTICE 'member %: duplicate email % moved to notes', r.id, r.email;
    END IF;
  END LOOP;
END $repair$;

CREATE UNIQUE INDEX IF NOT EXISTS member_email
  ON chain.member (lower(email)) WHERE email IS NOT NULL;
