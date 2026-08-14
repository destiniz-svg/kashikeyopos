-- Chart of accounts seeded into an outlet's own schema. Same codes across the
-- estate so consolidation lines up; balances never leave the outlet.
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
      ('6910','Cash rounding','expense','dr')
    ON CONFLICT (code) DO NOTHING
  $q$, p_schema);
END $fn$;
