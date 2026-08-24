-- ═══ WHAT A KILO OF FISH ACTUALLY PLATES ════════════════════════════════════
-- A recipe says how much of an ingredient reaches the plate. What has to LEAVE
-- THE SHELF to put it there is a different figure: a whole reef fish is filleted
-- and trimmed, and the difference between the two is the yield. The till divides
-- by it on every sale — `grossQty = net / (yield × (1 − waste))` — so this
-- number decides how much stock a bill deducts and what the plate cost.
--
-- IT LIVED IN ONE BROWSER. `yieldOf()` read `state.local.yields`, which is
-- per-device state that is never synced, and fell back to a regex table matched
-- against the ingredient's NAME. Three consequences, none visible from any
-- screen:
--
--   · two tills at one counter deducted DIFFERENT quantities for the same dish,
--     because only the one the kitchen measured on knew the answer;
--   · clearing a browser's storage silently reverted a measured yield to a
--     guess made by pattern-matching a name;
--   · the server could never reproduce or audit what a sale consumed, which is
--     what blocks it from deriving COGS quantities for itself.
--
-- And the op that was supposed to carry the measurement — `yield_test` — was
-- queued with NO PAYLOAD, so the audit trail recorded a yield of zero against
-- no ingredient. The screen said "Yield recorded".
--
-- NULL IS A REAL ANSWER and is why these are nullable rather than defaulted to
-- 1. "Nobody has assessed this ingredient" and "somebody measured it and it
-- plates at 100%" are different facts: the first falls through to the shipped
-- estimate and says so on screen, the second is a measurement that must not be
-- second-guessed. A DEFAULT 1 would erase that distinction on every existing
-- row at the moment this runs.
-- ═══════════════════════════════════════════════════════════════════════════

DO $mig$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name FROM chain.outlet WHERE schema_name IS NOT NULL LOOP
    EXECUTE format(
      'ALTER TABLE %I.ingredient'
      || ' ADD COLUMN IF NOT EXISTS yield_pct numeric(6,4)'
      || '   CHECK (yield_pct IS NULL OR (yield_pct > 0 AND yield_pct <= 1)),'
      || ' ADD COLUMN IF NOT EXISTS waste_pct numeric(6,4)'
      || '   CHECK (waste_pct IS NULL OR (waste_pct >= 0 AND waste_pct < 1)),'
      || ' ADD COLUMN IF NOT EXISTS yield_by text,'
      || ' ADD COLUMN IF NOT EXISTS yield_at timestamptz',
      o.schema_name);
  END LOOP;
END $mig$;
