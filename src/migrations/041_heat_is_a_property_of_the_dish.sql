/* ═══ 041 · HEAT IS A PROPERTY OF THE DISH, NOT OF ONE BROWSER ══════════════
   Reported: "an item added shows, and its tags and heat are not recorded and
   synced."

   Both halves were true and they failed differently.

   TAGS had a column from the first migration, the handler wrote it, and the
   bootstrap published it — but `COLLECTION_OP.menu` never SENT them, so every
   save reached the outlet with `tags` undefined, `arr(undefined)` made it an
   empty array, and the dish came back with its tags erased. Chef's pick, New,
   Signature, Gluten free: chosen, toasted as saved, gone by the next
   bootstrap. That one needs no schema.

   HEAT had nowhere to go at all. `dishSpice()` reads `m.spice`, the editor
   collects it on a four-rung scale, every menu export and the guest's menu
   print it — and no table in this build has ever had a column for it. It
   lived in whatever object the editor happened to be holding and died with
   the modal.

   Zero is a real answer and is the default, because "not spicy" is a
   statement a kitchen makes about a dish rather than the absence of one; the
   CHECK is the editor's own scale, so a figure off it is refused here rather
   than rendering as a blank chip on the guest's phone. */
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'outlet\_%' LOOP
    EXECUTE format(
      'ALTER TABLE %I.item ADD COLUMN IF NOT EXISTS spice smallint NOT NULL DEFAULT 0', s);
    -- Added separately and by name, so a re-run over a schema that already has
    -- the column does not fail on a duplicate constraint.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = s AND t.relname = 'item' AND c.conname = 'item_spice_scale'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.item ADD CONSTRAINT item_spice_scale CHECK (spice BETWEEN 0 AND 3)', s);
    END IF;
  END LOOP;
END $$;
