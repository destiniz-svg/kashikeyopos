/* ═══ 052 · A SHELF LIFE, AND A BATCH THAT SAYS WHERE ITS DATE CAME FROM ════
   Two nullable columns, and between them they are the whole reason the
   Batches & expiry tab has never had a row to draw on any store.

   `ingredient.shelf_life_days` — the item form has asked for a shelf life
   since it was written and there has never been a column for it, so it was
   written into the item row's index 9, WHICH IS THE COST PER BASE UNIT. A
   store creating rice at MVR 32 a kilo sent the outlet `cost: 180` and
   `factor: 0.177` — MVR 180 a GRAM, five and a half thousand times what the
   kitchen paid, on every recipe drawing on it for ever. Correcting an
   existing item's price was the same defect from the other side: the form
   presented that item's own cost per base unit under the label "Shelf life
   (days)", so whatever the operator did with that box rewrote the conversion
   factor every recipe divides by. Measured on a real outlet's own published
   row before this was written. NULL is a real answer here for the same
   reason it is on `yield_pct`: "nobody has said how long this keeps" and
   "this keeps three days" are different facts, and only the first may fall
   through to no date at all.

   `batch.use_by_derived` — a batch's use-by is now offered from that shelf
   life where a receiver did not read one off the box, and a derived date is
   MARKED as derived rather than presented as a measurement. The FEFO screen
   already has the vocabulary for both: four dated tiers and an undated one
   whose whole copy is "Received without a use-by — go and read the box".
   Publishing an estimate as though somebody had read it is how that screen
   would start lying the day it finally had rows in it.

   Nothing is back-filled. An ingredient nobody has assessed keeps NULL, and
   every batch written before this was written with a date somebody gave or
   with none at all — which is exactly what `false` says. */
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'outlet\_%' LOOP
    EXECUTE format('ALTER TABLE %I.ingredient'
      || ' ADD COLUMN IF NOT EXISTS shelf_life_days integer', s);
    EXECUTE format('ALTER TABLE %I.batch'
      || ' ADD COLUMN IF NOT EXISTS use_by_derived boolean NOT NULL DEFAULT false', s);
    /* A named CHECK has no IF NOT EXISTS, and this file is re-applied
       whenever its checksum moves, so the second run has to be a no-op
       rather than an error that stops a fleet migration on its first
       business. */
    BEGIN
      EXECUTE format('ALTER TABLE %I.ingredient'
        || ' ADD CONSTRAINT ingredient_shelf_life_is_a_span'
        || ' CHECK (shelf_life_days IS NULL OR (shelf_life_days > 0'
        || ' AND shelf_life_days <= 3650))', s);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;
