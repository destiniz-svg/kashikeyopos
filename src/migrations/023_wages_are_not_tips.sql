-- ═══ WAGES ARE NOT TIPS ════════════════════════════════════════════════════
-- Payroll credited net pay to 2450 "Tips payable to staff" — the chart had no
-- wages-payable account at all, so the tips liability carried every salary in
-- the company and neither figure could ever be reconciled: the tip float in
-- the drawer against a balance that included the whole payroll.
--
-- 2400 Net wages payable takes the wages. 2450 keeps the tips, which the sale
-- now actually posts (Cr 2450 at settle). Neither is till-owned: paying
-- either out is a manual journal — Dr 2400 or 2450, Cr the bank or the drawer
-- — with a memo, by a person, which is what a payout is.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION chain.seed_chart(p_schema text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  EXECUTE format($q$
    INSERT INTO %1$I.account (code, name, type, normal_side, till_owned, pos) VALUES
      ('1010','Cash on hand',                  'Asset',    'dr', true,   1),
      ('1020','Bank — BML MVR',                'Asset',    'dr', false,  2),
      ('1030','Card settlement receivable',    'Asset',    'dr', true,   3),
      ('1040','Customer credit receivable',    'Asset',    'dr', true,   4),
      ('1200','Inventory — raw',               'Asset',    'dr', true,   5),
      ('1210','Inventory — finished',          'Asset',    'dr', false,  6),
      ('1500','Equipment at cost',             'Asset',    'dr', false,  7),
      ('1510','Accumulated depreciation',      'Liability','cr', false,  8),
      ('2100','Accounts payable',              'Liability','cr', false,  9),
      ('2200','GST payable (GGST/TGST)',       'Liability','cr', true,  10),
      ('2300','Service charge payable',        'Liability','cr', false, 11),
      ('2350','Loyalty points liability',      'Liability','cr', true,  12),
      ('2400','Net wages payable',             'Liability','cr', false, 13),
      ('2450','Tips payable to staff',         'Liability','cr', false, 14),
      ('2500','MRPS pension payable',          'Liability','cr', false, 15),
      ('2600','Employee withholding tax payable','Liability','cr', false, 16),
      ('4000','Food & beverage revenue',       'Revenue',  'cr', true,  17),
      ('4100','Delivery revenue',              'Revenue',  'cr', true,  18),
      ('4200','Discounts & allowances',        'Revenue',  'dr', true,  19),
      ('4900','Cash rounding',                 'Revenue',  'cr', true,  20),
      ('5000','Cost of goods sold',            'Expense',  'dr', false, 21),
      ('5100','Wastage & variance',            'Expense',  'dr', false, 22),
      ('5300','Wages & salaries',              'Expense',  'dr', false, 23),
      ('5310','Employer pension contribution', 'Expense',  'dr', false, 24),
      ('5400','Repairs & maintenance',         'Expense',  'dr', false, 25),
      ('5500','Depreciation',                  'Expense',  'dr', false, 26),
      ('5600','Bank & card charges',           'Expense',  'dr', false, 27),
      ('5700','Packaging & consumables',       'Expense',  'dr', false, 28),
      ('5800','Delivery commission',           'Expense',  'dr', false, 29),
      ('6100','Rent & premises',               'Expense',  'dr', false, 30),
      ('6200','Utilities',                     'Expense',  'dr', false, 31),
      ('6300','Administration',                'Expense',  'dr', false, 32),
      ('6400','Licences & insurance',          'Expense',  'dr', false, 33),
      ('6500','Marketing & promotion',         'Expense',  'dr', false, 34),
      ('6550','Loyalty points expense',        'Expense',  'dr', true,  35),
      ('6600','Travel & transport',            'Expense',  'dr', false, 36),
      ('6700','Professional & recruitment',    'Expense',  'dr', false, 37),
      ('6800','Cleaning, laundry & upkeep',    'Expense',  'dr', false, 38)
    ON CONFLICT (code) DO UPDATE
      SET name = excluded.name, type = excluded.type,
          normal_side = excluded.normal_side, till_owned = excluded.till_owned,
          pos = excluded.pos
  $q$, p_schema);
END $fn$;

-- Historical payroll rows already credited to 2450 are NOT restated: they are
-- what was posted, and the trail says so. From this migration on, the two
-- liabilities part ways and each can be reconciled against its own reality.
DO $backfill$
DECLARE o record;
BEGIN
  FOR o IN SELECT id FROM chain.outlet LOOP
    PERFORM chain.seed_chart('outlet_' || o.id::text);
  END LOOP;
END $backfill$;
