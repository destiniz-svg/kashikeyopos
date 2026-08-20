-- ═══ CHART OF ACCOUNTS ═════════════════════════════════════════════════════
-- Thirty-five codes, seeded into every outlet's own schema. Same codes across
-- the estate so consolidation lines up; balances never leave the outlet.
--
-- The codes are LOAD-BEARING: the auto-posting rules, the P&L grouping and the
-- GST return all read them. Do not renumber.
--
-- `till_owned` marks the accounts a manual journal must REFUSE. The ledger
-- reconciles to the POS by construction, and only stays that way if nobody can
-- hand-key cash, revenue, discount, tax or stock.
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
      ('2450','Tips payable to staff',         'Liability','cr', false, 12),
      ('2500','MRPS pension payable',          'Liability','cr', false, 13),
      ('2600','Employee withholding tax payable','Liability','cr', false, 14),
      ('4000','Food & beverage revenue',       'Revenue',  'cr', true,  15),
      ('4100','Delivery revenue',              'Revenue',  'cr', true,  16),
      ('4200','Discounts & allowances',        'Revenue',  'dr', true,  17),
      ('4900','Cash rounding',                 'Revenue',  'cr', true,  18),
      ('5000','Cost of goods sold',            'Expense',  'dr', true,  19),
      ('5100','Wastage & variance',            'Expense',  'dr', false, 20),
      ('5300','Wages & salaries',              'Expense',  'dr', false, 21),
      ('5310','Employer pension contribution', 'Expense',  'dr', false, 22),
      ('5400','Repairs & maintenance',         'Expense',  'dr', false, 23),
      ('5500','Depreciation',                  'Expense',  'dr', false, 24),
      ('5600','Bank & card charges',           'Expense',  'dr', false, 25),
      ('5700','Packaging & consumables',       'Expense',  'dr', false, 26),
      ('5800','Delivery commission',           'Expense',  'dr', false, 27),
      ('6100','Rent & premises',               'Expense',  'dr', false, 28),
      ('6200','Utilities',                     'Expense',  'dr', false, 29),
      ('6300','Administration',                'Expense',  'dr', false, 30),
      ('6400','Licences & insurance',          'Expense',  'dr', false, 31),
      ('6500','Marketing & promotion',         'Expense',  'dr', false, 32),
      ('6600','Travel & transport',            'Expense',  'dr', false, 33),
      ('6700','Professional & recruitment',    'Expense',  'dr', false, 34),
      ('6800','Cleaning, laundry & upkeep',    'Expense',  'dr', false, 35)
    ON CONFLICT (code) DO UPDATE
      SET name = excluded.name, type = excluded.type,
          normal_side = excluded.normal_side, till_owned = excluded.till_owned,
          pos = excluded.pos
  $q$, p_schema);
END $fn$;
