-- ═══ THE SALE ROW COULD NOT SAY A REDEMPTION HAPPENED ══════════════════════
-- `sale` had no pts_value column, and `sale_adds_up` demanded
-- total = net + service + tax + rounding — the no-redemption identity. So the
-- schema itself FORCED the wrong total onto every redeemed sale: the server
-- had to store the gross figure while the guest paid less, the difference
-- disagreed with the till's own claim, and postJournal absorbed it as fake
-- "Cash rounding". A constraint is a sentence the schema insists on; this one
-- insisted on a lie whenever loyalty was involved.
--
-- Now the row carries the redemption — how many points, and what they were
-- worth — and the identity includes it:
--
--   total = net + service + tax + rounding − pts_value
--
-- Old rows have pts_value 0, where the new identity reduces to the old one,
-- so nothing already written is disturbed and nothing is restated.
-- ═══════════════════════════════════════════════════════════════════════════

DO $backfill$
DECLARE o record;
BEGIN
  FOR o IN SELECT id FROM chain.outlet LOOP
    EXECUTE format('ALTER TABLE %1$I.sale'
      || ' ADD COLUMN IF NOT EXISTS pts int NOT NULL DEFAULT 0,'
      || ' ADD COLUMN IF NOT EXISTS pts_value numeric(12,2) NOT NULL DEFAULT 0',
      'outlet_' || o.id::text);
    EXECUTE format('ALTER TABLE %1$I.sale DROP CONSTRAINT IF EXISTS sale_adds_up',
      'outlet_' || o.id::text);
    EXECUTE format('ALTER TABLE %1$I.sale ADD CONSTRAINT sale_adds_up CHECK ('
      || ' round(net + service + tax + rounding - pts_value, 2) = round(total, 2))',
      'outlet_' || o.id::text);
  END LOOP;
END $backfill$;
