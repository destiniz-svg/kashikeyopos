-- ═══ NOT EVERY BUSINESS IS REGISTERED FOR GST ══════════════════════════════
-- Migration 009 established that registration is CONDITIONAL: in the Maldives a
-- business registers once taxable supplies pass a threshold, and below it
-- charges nothing. The app honoured that at the till — `NONE` is a real tax
-- code and every tax row asks taxRegistered() first — but you could not GET
-- there from onboarding, because the company row demanded a TIN:
--
--     tin text NOT NULL
--
-- A business that is not registered for GST has no TIN to give. It was being
-- asked to invent one, and a made-up TIN on a receipt is a false statement to a
-- tax authority — the exact thing the onboarding panel says it refuses to do.
--
-- So registration becomes an explicit fact, and it sits where the real one
-- sits. In the Maldives the TAXPAYER registers with MIRA, not the shop: that
-- is the company. Which rate an outlet charges once the company is registered
-- — general or tourism — is a fact about the outlet, and already lives there.
--
--     chain.company.gst_registered   did this business register? (+ its TIN)
--     chain.outlet.tax_code          GGST / TGST / NONE, per outlet
--
-- Two invariants, in the database rather than in a handler, because "the whole
-- application behaves" is not something four route files can promise:
--
--   1. a registered business HAS a TIN, and an unregistered one has none;
--   2. an outlet cannot charge GST that its company is not registered to
--      collect. Not a preference — collecting tax you are not registered for
--      is the failure mode this whole feature exists to prevent.
-- ═══════════════════════════════════════════════════════════════════════════

-- A TIN is what a REGISTERED business has. Nothing else about the company row
-- changes: it is still one row, still required, still the thing every receipt
-- reads its identity back from.
ALTER TABLE chain.company ALTER COLUMN tin DROP NOT NULL;

ALTER TABLE chain.company
  ADD COLUMN IF NOT EXISTS gst_registered boolean NOT NULL DEFAULT true;

-- An install that predates this column has a TIN (it was NOT NULL), so it was
-- registered. Say so explicitly rather than leaving it to the default.
UPDATE chain.company
   SET gst_registered = (tin IS NOT NULL AND btrim(tin) <> '')
 WHERE id = 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'company_tin_iff_registered'
                    AND conrelid = 'chain.company'::regclass) THEN
    ALTER TABLE chain.company ADD CONSTRAINT company_tin_iff_registered
      CHECK (NOT gst_registered OR (tin IS NOT NULL AND btrim(tin) <> ''));
  END IF;
END $$;

/* Is this business registered? One answer, asked by every guard below and by
   the app, so "registered" cannot mean one thing in a route and another in a
   report. An install with no company row yet is not registered — nothing has
   claimed otherwise. */
CREATE OR REPLACE FUNCTION chain.gst_registered() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT gst_registered FROM chain.company WHERE id = 1), false)
$$;

/* An outlet may not charge what the company is not registered to collect.
   Refused by name: "invalid" would send somebody hunting through the outlet
   when the answer is one step above it. */
CREATE OR REPLACE FUNCTION chain.outlet_tax_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tax_code IS DISTINCT FROM 'NONE'
     AND EXISTS (SELECT 1 FROM chain.company WHERE id = 1)
     AND NOT chain.gst_registered() THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('this business is not registered for GST, so %s cannot charge %s',
                       NEW.name, NEW.tax_code),
      HINT = 'Register the company for GST in Settings first, or leave this outlet at NONE';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS outlet_tax_guard ON chain.outlet;
CREATE TRIGGER outlet_tax_guard
  BEFORE INSERT OR UPDATE OF tax_code ON chain.outlet
  FOR EACH ROW EXECUTE FUNCTION chain.outlet_tax_guard();

/* And the same for a rate VERSION, which is the thing a receipt actually
   quotes. Guarding only the outlet would leave the door open to writing a
   history the outlet never points at but a report still reads. */
CREATE OR REPLACE FUNCTION chain.tax_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- outlet_id IS NULL is the STATUTORY history — the rates in force in the
  -- country. Those are facts about the Maldives, not about this business, and
  -- they are shipped whether or not anybody here is registered.
  IF NEW.outlet_id IS NOT NULL
     AND NEW.code IS DISTINCT FROM 'NONE'
     AND EXISTS (SELECT 1 FROM chain.company WHERE id = 1)
     AND NOT chain.gst_registered() THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'this business is not registered for GST, so it cannot hold a '
                || NEW.code || ' rate',
      HINT = 'Register the company for GST in Settings first';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tax_version_guard ON chain.tax_version;
CREATE TRIGGER tax_version_guard
  BEFORE INSERT OR UPDATE OF code, rate ON chain.tax_version
  FOR EACH ROW EXECUTE FUNCTION chain.tax_version_guard();

/* Registering LATER is the expected path, not an edge case: a business starts
   below the threshold, grows past it, and GST_WATCH puts that on the owner's
   Today list. One transaction, because a company marked registered whose
   outlets still say NONE charges nothing while believing it charges GST — and
   that is a debt to MIRA nobody notices until an audit. */
CREATE OR REPLACE FUNCTION chain.register_for_gst(p_tin text, p_code text DEFAULT 'GGST',
                                                  p_rate numeric DEFAULT NULL,
                                                  p_from date DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r numeric; d date := coalesce(p_from, current_date);
BEGIN
  IF p_tin IS NULL OR btrim(p_tin) = '' THEN
    RAISE EXCEPTION 'a TIN is required to register for GST' USING ERRCODE = '23514';
  END IF;
  IF p_code = 'NONE' THEN
    RAISE EXCEPTION 'NONE is not a registration' USING ERRCODE = '23514';
  END IF;

  UPDATE chain.company SET tin = btrim(p_tin), gst_registered = true, updated_at = now()
   WHERE id = 1;

  r := coalesce(p_rate, (SELECT rate FROM chain.tax_version
                          WHERE outlet_id IS NULL AND code = p_code
                            AND effective_from <= d
                            AND (effective_to IS NULL OR effective_to >= d)
                          ORDER BY effective_from DESC LIMIT 1), 0);

  UPDATE chain.outlet SET tax_code = p_code WHERE tax_code = 'NONE';
  INSERT INTO chain.tax_version (outlet_id, code, rate, effective_from, authority_ref)
  SELECT o.id, p_code, r, d, 'Registered for GST'
    FROM chain.outlet o
   ON CONFLICT (outlet_id, code, effective_from) DO UPDATE SET rate = excluded.rate;
END $$;

-- The rate history is readable by every outlet role already; the guards above
-- run as the definer of the trigger, so nothing new is granted here.
GRANT EXECUTE ON FUNCTION chain.gst_registered() TO PUBLIC;
