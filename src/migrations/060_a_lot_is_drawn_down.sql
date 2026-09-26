/* === 060 . A LOT IS DRAWN DOWN ==============================================
   `batch.qty` is what is left of a lot, and until now nothing but closing the
   lot by hand ever lowered it: stock left the shelf through sales, prep and
   waste, and every lot still showed what arrived. The FEFO shelf was an ORDER
   a kitchen worked in, not an allocation.

   Now every move that takes stock OUT without naming its own lot is spread
   across the item's open lots, earliest use-by first (src/apply.js
   `drawDown()`), and each piece is written here: which move, which lot, how
   much. It is a record of WHERE stock came from, never of what it was worth —
   the move's value, avg_cost and the journal are exactly what they were.

   `undone_by` is the move that put it back (a void, a restocking refund).
   Nothing here is deleted: a draw that was reversed stays, marked, so the
   shelf's history reads the same way the stock ledger does.

   Follows 059's shape: every outlet\_% schema already provisioned gets the
   table here, and 003 gets it too so a new outlet is born with it. */
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'outlet\_%' LOOP
    CONTINUE WHEN to_regclass(format('%I.batch', s)) IS NULL;
    EXECUTE format($ddl$
      CREATE TABLE IF NOT EXISTS %1$I.batch_draw (
        move_id   bigint NOT NULL REFERENCES %1$I.stock_move(id),
        batch_id  uuid NOT NULL REFERENCES %1$I.batch(id),
        qty       numeric(14,4) NOT NULL CHECK (qty > 0),
        undone_by bigint,
        PRIMARY KEY (move_id, batch_id)
      );
      CREATE INDEX IF NOT EXISTS batch_draw_batch ON %1$I.batch_draw(batch_id);
    $ddl$, s);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %1$I.batch_draw TO %2$I',
      s, s || '_app');
  END LOOP;
END $$;
