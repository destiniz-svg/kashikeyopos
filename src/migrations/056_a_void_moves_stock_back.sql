/* ═══ 056 · A VOID MOVES STOCK BACK ═════════════════════════════════════════
   `H.void_sale` negates every stock_move the sale wrote, with reason 'void' —
   and the CHECK on `stock_move.reason` never listed 'void'. So voiding any sale
   that had moved stock raised 23514, the whole void rolled back, and the sale
   stayed live: journal, shelf, points and credit all unreversed, and the op
   parked. Only a sale that moved no stock could ever be voided, which is the
   one case the test exercised.

   003 now lists it for outlets provisioned from here on; this brings every
   existing outlet schema to the same rule. */
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'outlet\_%' LOOP
    CONTINUE WHEN to_regclass(format('%I.stock_move', s)) IS NULL;
    EXECUTE format('ALTER TABLE %I.stock_move'
      || ' DROP CONSTRAINT IF EXISTS stock_move_reason_check', s);
    EXECUTE format('ALTER TABLE %I.stock_move'
      || ' ADD CONSTRAINT stock_move_reason_check CHECK (reason IN'
      || ' (''purchase'',''sale'',''refund'',''audit'',''manual'',''waste'','
      || ' ''transfer'',''produce'',''prep'',''opening'',''void''))', s);
  END LOOP;
END $$;
