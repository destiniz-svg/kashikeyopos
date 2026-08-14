-- ═══ stock_move.value IS SIGNED ════════════════════════════════════════════
--
-- The column had two writers and they disagreed. The sale path stored a
-- POSITIVE value against a NEGATIVE quantity; every other path stored the value
-- signed to match its quantity. So `value` meant "what this movement was worth"
-- on some rows and "what left the store, as a positive number" on others, and
-- any sum over the column was meaningless — which is how it was found, when the
-- Stock Ledger's in/out totals came back with nothing in the out column.
--
-- src/sale.js now goes through stock.move() like everything else, so there is
-- one writer. This corrects the rows written before that.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name FROM chain.outlet LOOP
    EXECUTE format(
      'UPDATE %I.stock_move SET value = -abs(value) WHERE qty < 0 AND value > 0',
      o.schema_name);
    EXECUTE format(
      'UPDATE %I.stock_move SET value = abs(value) WHERE qty > 0 AND value < 0',
      o.schema_name);
  END LOOP;
END $$;
