-- ═══════════════════════════════════════════════════════════════════════════
-- Settings — 02-POS-SPEC §2 (`settings`), 08-BUILD-STAGES §29.
--
-- An outlet's service charge, cash rounding, timezone, table count and GST rate
-- have been settable by nothing but psql since the first migration. There is no
-- endpoint, no screen, and `chain.tax_version` has carried a write policy the
-- whole time with NO GRANT BEHIND IT — the third time in this project that a
-- policy and its grant have been written in different places and only one of
-- them arrived.
--
-- THE OUTLET ROLE IS NOT GIVEN `UPDATE ON chain.outlet`, and that is the point
-- of this file. Four of that table's columns are the tenancy model itself:
--
--     id · schema_name · db_role · code
--
-- `schema_name` and `db_role` are what `withOutlet` resolves a connection
-- through. A role that can write them can point its own outlet row at another
-- outlet's schema, and RLS cannot help — a policy decides which ROWS you may
-- write, never which COLUMNS. So the grant is never issued, and the settings an
-- admin may change go through a SECURITY DEFINER function that can only touch
-- the columns that are genuinely settings.
--
-- A TAX RATE IS ADDED, NEVER EDITED. `chain.tax_version` is keyed by effective
-- date because a sale records the rate it was rung up at, and a filed return
-- must not change under a business that has already filed it. Editing a version
-- would restate every receipt since it took effect; backdating a new one would
-- do the same thing more quietly. So both are refused: a new rate takes effect
-- today or later, and yesterday's rate is a historical fact.
-- ═══════════════════════════════════════════════════════════════════════════

-- The registered identity of the business, which had nowhere to live. A GST
-- receipt in the Maldives carries the trader's name, address and TIN; there was
-- no column for any of them, so no receipt this system prints could be a
-- compliant one. Added here rather than in a later migration because this file
-- is the one that owns what an outlet's settings ARE.
ALTER TABLE chain.outlet ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE chain.outlet ADD COLUMN IF NOT EXISTS phone   text;
ALTER TABLE chain.outlet ADD COLUMN IF NOT EXISTS tin     text;

-- The five-argument shape this file first shipped with is dropped rather than
-- left beside the new one. Two overloads would both be grantable and only one
-- would ever be called, which is the same trap as two copies of a chart of
-- accounts: the dead one goes on looking maintained.
DROP FUNCTION IF EXISTS chain.set_outlet_settings(text,text,numeric,int,int);

CREATE OR REPLACE FUNCTION chain.set_outlet_settings(
  p_name text, p_tz text, p_service numeric, p_round int, p_tables int,
  p_address text, p_phone text, p_tin text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE o int := app.current_outlet();
BEGIN
  IF o IS NULL THEN RAISE EXCEPTION 'no outlet in session'; END IF;
  /* Rank 4. A service charge is a standing promise to every guest and to the
     staff it is owed to; changing it is not a shift decision. */
  IF app.current_rank() < 4 THEN
    RAISE EXCEPTION 'changing an outlet''s settings is an admin decision';
  END IF;
  IF p_service < 0 OR p_service > 100 THEN
    RAISE EXCEPTION 'a service charge is a percentage';
  END IF;
  IF p_round < 0 OR p_round > 100 THEN
    RAISE EXCEPTION 'cash rounding is between 0 and 100 laari';
  END IF;
  IF p_tables < 0 OR p_tables > 500 THEN
    RAISE EXCEPTION 'that is not a plausible number of tables';
  END IF;
  IF btrim(coalesce(p_name, '')) = '' THEN
    RAISE EXCEPTION 'an outlet needs a name';
  END IF;
  /* The eight columns that are settings. `id`, `code`, `schema_name` and
     `db_role` are not in this statement and are not reachable from any grant
     this role holds — see the header. */
  UPDATE chain.outlet
     SET name = btrim(p_name), tz = coalesce(nullif(btrim(p_tz), ''), tz),
         service_pct = p_service, cash_round_laari = p_round, tables = p_tables,
         address = nullif(btrim(coalesce(p_address, '')), ''),
         phone = nullif(btrim(coalesce(p_phone, '')), ''),
         tin = nullif(upper(btrim(coalesce(p_tin, ''))), '')
   WHERE id = o;
END $fn$;

-- ── the tax rate: a new version, dated, never an edit ──────────────────────
CREATE OR REPLACE FUNCTION chain.set_tax_rate(
  p_code text, p_rate numeric, p_from date)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE o int := app.current_outlet();
BEGIN
  IF o IS NULL THEN RAISE EXCEPTION 'no outlet in session'; END IF;
  IF app.current_rank() < 4 THEN
    RAISE EXCEPTION 'changing a tax rate is an admin decision';
  END IF;
  IF p_code IS NULL OR btrim(p_code) = '' THEN
    RAISE EXCEPTION 'a tax code is required';
  END IF;
  IF p_rate < 0 OR p_rate > 100 THEN
    RAISE EXCEPTION 'a tax rate is a percentage';
  END IF;
  /* Not backdatable. A rate that took effect last Tuesday would restate every
     receipt printed since — including any period already filed with MIRA. The
     rate on those sales is recorded on the sale rows themselves and stays
     whatever it was. */
  IF p_from < current_date THEN
    RAISE EXCEPTION 'a tax rate takes effect today or later — backdating one would restate receipts that have already been issued';
  END IF;
  INSERT INTO chain.tax_version (outlet_id, code, rate, effective_from)
  VALUES (o, upper(btrim(p_code)), p_rate, p_from)
  ON CONFLICT (outlet_id, code, effective_from) DO UPDATE SET rate = excluded.rate;
END $fn$;

DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT db_role FROM chain.outlet LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION'
      || ' chain.set_outlet_settings(text,text,numeric,int,int,text,text,text),'
      || ' chain.set_tax_rate(text,numeric,date) TO %I', o.db_role);
    /* The grant `tax_write` has been waiting for since migration 002. The
       policy is what decides; without this it decided nothing. Kept alongside
       the function above because a future rate correction on a version not yet
       in effect is a legitimate act and the policy already allows it. */
    EXECUTE format('GRANT INSERT, UPDATE ON chain.tax_version TO %I', o.db_role);
  END LOOP;
END $$;
