-- ═══ A VOID HAS TO UNDO SOMETHING ═══════════════════════════════════════════
-- `sale.voided_at` and `voided_by` have been in the schema since 003, and five
-- readers depend on them: the estate aggregate, the member's visit history, the
-- credit back-fill, the settled list's status. NOTHING EVER WROTE THEM. A void
-- of a settled sale fell to the unmodelled path — recorded on the trail,
-- consequence-free — so the money stayed in revenue, the stock stayed consumed,
-- and the points stayed granted.
--
-- The handler that fixes that reverses from the SERVER'S OWN records: the
-- sale's journal legs swapped, the stock_move rows it wrote negated, the points
-- it granted taken back. Only one thing was never written down and so could not
-- be given back exactly — how many points the visit EARNED. It was computed
-- from a rate that can change before the void is asked for, and a reversal
-- struck at the new rate takes back a different number from the one the guest
-- was shown.
--
-- So the sale records what it granted. Rows written before this column exists
-- carry 0, and a void of one of those reverses the spend but not the earn —
-- which is stated in the audit stamp rather than guessed at.
-- ═══════════════════════════════════════════════════════════════════════════

DO $mig$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name FROM chain.outlet WHERE schema_name IS NOT NULL LOOP
    EXECUTE format('ALTER TABLE %I.sale ADD COLUMN IF NOT EXISTS pts_earned'
      || ' int NOT NULL DEFAULT 0', o.schema_name);
  END LOOP;
END $mig$;
