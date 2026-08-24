-- ═══ A BATCH THE KITCHEN MAKES IS AN ITEM ═══════════════════════════════════
-- `recipe_line`'s component has been either an `ingredient_id` or a
-- `sub_item_id REFERENCES item(id)` since 003. The second half was a foreign
-- key with no possible referent: nothing ever wrote an item to be referenced,
-- so a dish drawing on a batch could not be stored — the insert failed on the
-- key. Confirmed against a live outlet before this was written.
--
-- The terminal carried its own parallel model instead: three batches hard-coded
-- into app/index.html with ingredient ids from an old seed, plus whatever an
-- operator had edited into THAT BROWSER's local state. The ops meant to record
-- one — `subrecipe_add` / `subrecipe_update` — had no handler and no payload,
-- and were invisible to the sync contract test because the kind is chosen by a
-- ternary and the test only ever read a literal at the opening bracket. So a
-- kitchen costing "the backbone of six dishes" costed it for itself, on one
-- device, while the screen reported a price per kilo as though it were saved.
--
-- An item already carries the output of a batch (`yield_qty`) and can be kept
-- off the till's grid (`off_menu`) — nobody orders a litre of fish stock. What
-- it had nowhere to put is the REDUCTION LOSS, which is not the same fact as
-- the output and cannot be recovered from it: 4 litres yielding 3.28 tells you
-- what a millilitre costs, and 18% tells you why it costs more than the inputs
-- divided by four. The costing screen says the second out loud, so the column
-- exists to hold it.
-- ═══════════════════════════════════════════════════════════════════════════

DO $mig$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name FROM chain.outlet WHERE schema_name IS NOT NULL LOOP
    EXECUTE format(
      'ALTER TABLE %I.item ADD COLUMN IF NOT EXISTS loss_pct numeric(5,4)'
      || ' NOT NULL DEFAULT 0 CHECK (loss_pct >= 0 AND loss_pct < 1),'
      -- SAID, not inferred. A batch and a dish taken off the menu are both
      -- off_menu, and telling them apart by price, category or yield would be
      -- a guess that breaks the first time somebody prices a batch or hides a
      -- free dish. The till's grid and the guest's menu both read this.
      || ' ADD COLUMN IF NOT EXISTS is_batch boolean NOT NULL DEFAULT false',
      o.schema_name);
    -- The dishes a batch feeds are found by walking backwards from it, on
    -- every save and every declaration re-publish.
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS recipe_line_sub ON %I.recipe_line(sub_item_id)'
      || ' WHERE sub_item_id IS NOT NULL', o.schema_name);
  END LOOP;
END $mig$;
