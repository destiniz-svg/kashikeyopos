/* ═══ 053 · A DELIVERY LANDS SOMEWHERE ══════════════════════════════════════
   The GRN form has one "Receiving location" select, the op has always carried
   it, and `moveStock()` has always written it onto every `stock_move` row the
   delivery produced. `delivery` itself had no column for it — so the Purchases
   screen's own "Receiving location" column had nothing to read and rendered
   `p.branch`, the OUTLET, which is the same name on every row of a list that
   is already scoped to one outlet. A column that prints one constant is a
   column that says nothing.

   NULL is a real answer and is the default: "the store, no separate location"
   is what a café that has never divided its store receives into, and it is the
   answer `locName(null)` already gives in words. A location that was named and
   has since been retired keeps its id here — the delivery landed where it
   landed, and rewriting history to the nearest surviving shelf would be worse
   than an id the screen resolves to itself.

   No foreign key, for the reason `stock_move.location_id` has none: a
   location may be deactivated, and a delivery from before that is a fact
   rather than a dangling reference to repair. */
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'outlet\_%' LOOP
    EXECUTE format('ALTER TABLE %I.delivery'
      || ' ADD COLUMN IF NOT EXISTS location_id text', s);
  END LOOP;
END $$;
