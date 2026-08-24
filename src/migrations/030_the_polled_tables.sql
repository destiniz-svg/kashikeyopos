-- ═══ THE TABLES A POLL READS EVERY FIVE SECONDS ═════════════════════════════
-- Every signed-in terminal asks the outlet what has changed every five seconds,
-- and four of the queries in that answer are "the open ones, oldest first".
-- Three of the four had an index. These two did not:
--
--   guest_order    WHERE accepted_at IS NULL AND rejected_reason IS NULL
--   guest_request  WHERE ack_at IS NULL
--
-- Both had nothing beyond their primary key, so both were sequential scans —
-- on tables that only ever grow. On a busy QR outlet that is every open
-- terminal, twelve times a minute, reading every order the store has ever
-- taken in order to find the four nobody has accepted yet. It costs nothing on
-- an install opened last week, which is exactly why it survives to production.
--
-- PARTIAL indexes, because the predicate is the whole point: only the OPEN
-- rows are ever looked for, so the index holds a handful of rows however large
-- the table grows, and a row leaves it the moment somebody accepts or
-- acknowledges. Ordered by `at`, which is the order both queries ask for, so
-- the scan is the sort.
--
-- And stock_move by sale: a void reads back exactly the rows a sale wrote in
-- order to negate them, and stock_move is indexed by ingredient, not by sale.
-- Voiding one bill read the whole movement history of the outlet.
-- ═══════════════════════════════════════════════════════════════════════════

DO $mig$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name FROM chain.outlet WHERE schema_name IS NOT NULL LOOP
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS guest_order_open ON %1$I.guest_order(at)'
      || ' WHERE accepted_at IS NULL AND rejected_reason IS NULL', o.schema_name);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS guest_request_open ON %1$I.guest_request(at)'
      || ' WHERE ack_at IS NULL', o.schema_name);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS stock_move_sale ON %1$I.stock_move(sale_id)'
      || ' WHERE sale_id IS NOT NULL', o.schema_name);
  END LOOP;
END $mig$;
