-- ═══ 6920 CASH OVER OR SHORT ═══════════════════════════════════════════════
--
-- A drawer that counts short is not a rounding difference and it is not
-- nothing: it is a real loss, and it has to land somewhere or account 1000
-- (cash in drawer) drifts permanently away from the cash actually in the
-- drawer. From that point the balance sheet is decoration.
--
-- 6910 already exists for CASH ROUNDING, which is a different thing — the
-- deliberate few laari given up when a cash bill is rounded to the nearest
-- increment. Posting drawer variance there would blend an accepted cost with
-- an unexplained one, and the second is the only one worth investigating.
--
-- Declared expense/dr, so a drawer that comes up OVER credits it and reads as
-- a negative expense. That is right: an over is not revenue and must never
-- reach the sales line.

-- The seed function, so every outlet provisioned from here on has it …
CREATE OR REPLACE FUNCTION chain.seed_chart(p_schema text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  EXECUTE format($q$
    INSERT INTO %1$I.account (code, name, type, normal_side) VALUES
      ('1000','Cash in drawer','asset','dr'),
      ('1010','Bank','asset','dr'),
      ('1020','Card receivable','asset','dr'),
      ('1100','Inventory - food','asset','dr'),
      ('1110','Inventory - beverage','asset','dr'),
      ('1200','Prepaid expenses','asset','dr'),
      ('1500','Equipment','asset','dr'),
      ('1510','Accumulated depreciation','asset','cr'),
      ('2000','Accounts payable','liability','cr'),
      ('2100','GST payable','liability','cr'),
      ('2110','Service charge payable','liability','cr'),
      ('2120','Tips payable','liability','cr'),
      ('2200','Loyalty liability','liability','cr'),
      ('2300','Payroll payable','liability','cr'),
      ('3000','Owner equity','equity','cr'),
      ('3100','Retained earnings','equity','cr'),
      ('4000','Food sales','income','cr'),
      ('4010','Beverage sales','income','cr'),
      ('4090','Discounts given','income','dr'),
      ('5000','Food cost','expense','dr'),
      ('5010','Beverage cost','expense','dr'),
      ('5100','Stock variance','expense','dr'),
      ('6000','Wages','expense','dr'),
      ('6010','Staff benefits','expense','dr'),
      ('6100','Rent','expense','dr'),
      ('6110','Utilities','expense','dr'),
      ('6120','Marketing','expense','dr'),
      ('6130','Travel','expense','dr'),
      ('6140','Uniforms','expense','dr'),
      ('6150','Pest control','expense','dr'),
      ('6160','Packaging','expense','dr'),
      ('6170','Aggregator commission','expense','dr'),
      ('6180','Card fees','expense','dr'),
      ('6190','Repairs','expense','dr'),
      ('6200','Licences','expense','dr'),
      ('6300','Depreciation','expense','dr'),
      ('6900','FX gain or loss','expense','dr'),
      ('6910','Cash rounding','expense','dr'),
      ('2310','Pension payable','liability','cr'),
      ('6920','Cash over or short','expense','dr')
    ON CONFLICT (code) DO NOTHING
  $q$, p_schema);
END $fn$;

-- … and every outlet that ALREADY exists. Four times in this build a migration
-- patched the live outlets and forgot the function, or the function and forgot
-- the outlets, and the gap only showed up when somebody provisioned a branch
-- that was quietly missing a column. Both halves, in the same migration, every
-- time.
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^outlet_[0-9]+$'
  LOOP
    PERFORM chain.seed_chart(s);
  END LOOP;
END $$;
