/* ═══ A NUMBER IS ITS DIGITS ════════════════════════════════════════════════
   Found by driving the member card as a member: the row held "+960 7793216" —
   the counter's own spelling — and the guest typed 7793216, which is how
   anyone types their own number. The resolver compared exact bytes, matched
   nobody, and answered the enumeration-safe "a code is on its way" while
   minting nothing. A member locked out of their own card by a space and a
   country code, with an answer that cannot even say why.

   The build already has ONE definition of a number — msisdn() in
   app/kashikeyo-share.js: digits only, leading zeros dropped, 960 prefixed to
   a bare 7-digit Maldivian mobile. This is that rule in SQL, and both
   sign-in resolvers now read through it. IMMUTABLE, because a number's digits
   do not depend on anything but the number.

   TWO MEMBERS ON ONE NUMBER RESOLVE NOBODY. "+960 7793216" and "7793216" as
   two rows are the phone-side twin of the email defect 018 closed — and
   take-one-silently is one guest signed into another's card. Exact spellings
   keep working (each row can still name itself precisely); only the
   normalised fallback refuses on ambiguity, silently, in the same bytes as an
   unknown address, because whether a number is two customers here is not a
   stranger's question to ask.

   CREATE OR REPLACE on the same signatures, so the EXECUTE grants the outlet
   roles hold survive — a dropped function takes its grants with it, which is
   the lesson 019 already paid for. */

CREATE OR REPLACE FUNCTION chain.msisdn(p text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE d text;
BEGIN
  d := regexp_replace(coalesce(p, ''), '\D', '', 'g');
  d := regexp_replace(d, '^0+', '');
  IF length(d) = 7 THEN d := '960' || d; END IF;
  IF length(d) < 8 OR length(d) > 15 THEN RETURN NULL; END IF;
  RETURN d;
END $$;

/* Who p_id names: an exact phone or email first — the cheap, unambiguous
   read — then the digits. Returns NULL for unknown AND for ambiguous, on
   purpose: the callers' answers must not distinguish the two. */
CREATE OR REPLACE FUNCTION chain.member_resolve(p_id text)
RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE ids uuid[]; norm text;
BEGIN
  SELECT array_agg(id) INTO ids FROM chain.member
   WHERE phone = p_id OR lower(email) = lower(p_id);
  IF array_length(ids, 1) = 1 THEN RETURN ids[1]; END IF;
  IF array_length(ids, 1) > 1 THEN RETURN NULL; END IF;
  norm := chain.msisdn(p_id);
  IF norm IS NULL THEN RETURN NULL; END IF;
  SELECT array_agg(id) INTO ids FROM chain.member
   WHERE chain.msisdn(phone) = norm;
  IF array_length(ids, 1) = 1 THEN RETURN ids[1]; END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION chain.member_code_set(p_id text, p_hash text,
  p_salt text, p_mins int)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE m uuid;
BEGIN
  UPDATE chain.member
     SET code_hash = p_hash, code_salt = p_salt,
         code_exp = now() + (p_mins || ' minutes')::interval,
         code_tries = 0
   WHERE id = chain.member_resolve(p_id)
     AND revoked_at IS NULL
   RETURNING id INTO m;
  RETURN m;
END $$;

CREATE OR REPLACE FUNCTION chain.member_code_take(p_id text)
RETURNS TABLE (id uuid, code_hash text, code_salt text, code_exp timestamptz,
               code_tries int, name text, points numeric)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  UPDATE chain.member m SET code_tries = m.code_tries + 1
   WHERE m.id = chain.member_resolve(p_id)
     AND m.code_hash IS NOT NULL
   RETURNING m.id, m.code_hash, m.code_salt, m.code_exp, m.code_tries,
             m.name, m.points;
END $$;
