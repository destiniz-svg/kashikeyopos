-- ═══ POINTS ARE A LIABILITY, SO THE CHART NEEDS THE ACCOUNT ════════════════
-- This file's own documentation said "redeeming releases 2300" for months.
-- 2300 is SERVICE CHARGE PAYABLE — the staff pool — and the chart carried no
-- loyalty account at all. The prose was wrong, the till believed the prose,
-- and three defects grew out of one sentence:
--
--   · the server's sale journal had no redemption line, so postJournal's
--     self-balancer absorbed every redemption as a fake "Cash rounding" debit
--     on 4900 — the redemption booked as a discount, invisibly, on card sales
--     too, which is the exact misstatement the doctrine forbids;
--   · the till queued its own manual journal, Dr 2300 / Cr 4000 — the wrong
--     liability, and a credit to a till-owned revenue account;
--   · which the server's own guard therefore refused, every time, leaving a
--     poison op retrying in the outbox for the life of the device. The guard
--     also, by accident, protected the staff pool from being debited.
--
-- Two accounts fix it, and both are TILL-OWNED — only the sale posts them, so
-- the liability ties to the ledger by construction and a manual journal
-- cannot un-tie it:
--
--   2350  Loyalty points liability   what the outstanding points are worth
--   6550  Loyalty points expense     the cost of granting them, at earn time
--
-- At EARN:    Dr 6550 / Cr 2350  for the points' redemption value
-- At REDEEM:  Dr 2350            releasing what prior visits accrued, while
--                                 revenue stays the full goods figure
--
-- DISCLOSED, NOT HIDDEN: points earned before this migration were never
-- accrued, so 2350 opens at zero and early redemptions will drive it into a
-- debit balance until new accruals wash through. That is a true statement
-- about the past — seeding an invented opening balance would be a false one.
-- Points are also chain-wide while ledgers are per-outlet: a guest may earn at
-- one outlet and redeem at another, so a single outlet's 2350 may legitimately
-- run negative while the estate's consolidated figure ties.
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
      ('2450','Tips payable to staff',         'Liability','cr', false, 13),
      ('2500','MRPS pension payable',          'Liability','cr', false, 14),
      ('2600','Employee withholding tax payable','Liability','cr', false, 15),
      ('4000','Food & beverage revenue',       'Revenue',  'cr', true,  16),
      ('4100','Delivery revenue',              'Revenue',  'cr', true,  17),
      ('4200','Discounts & allowances',        'Revenue',  'dr', true,  18),
      ('4900','Cash rounding',                 'Revenue',  'cr', true,  19),
      ('5000','Cost of goods sold',            'Expense',  'dr', false, 20),
      ('5100','Wastage & variance',            'Expense',  'dr', false, 21),
      ('5300','Wages & salaries',              'Expense',  'dr', false, 22),
      ('5310','Employer pension contribution', 'Expense',  'dr', false, 23),
      ('5400','Repairs & maintenance',         'Expense',  'dr', false, 24),
      ('5500','Depreciation',                  'Expense',  'dr', false, 25),
      ('5600','Bank & card charges',           'Expense',  'dr', false, 26),
      ('5700','Packaging & consumables',       'Expense',  'dr', false, 27),
      ('5800','Delivery commission',           'Expense',  'dr', false, 28),
      ('6100','Rent & premises',               'Expense',  'dr', false, 29),
      ('6200','Utilities',                     'Expense',  'dr', false, 30),
      ('6300','Administration',                'Expense',  'dr', false, 31),
      ('6400','Licences & insurance',          'Expense',  'dr', false, 32),
      ('6500','Marketing & promotion',         'Expense',  'dr', false, 33),
      ('6550','Loyalty points expense',        'Expense',  'dr', true,  34),
      ('6600','Travel & transport',            'Expense',  'dr', false, 35),
      ('6700','Professional & recruitment',    'Expense',  'dr', false, 36),
      ('6800','Cleaning, laundry & upkeep',    'Expense',  'dr', false, 37)
    ON CONFLICT (code) DO UPDATE
      SET name = excluded.name, type = excluded.type,
          normal_side = excluded.normal_side, till_owned = excluded.till_owned,
          pos = excluded.pos
  $q$, p_schema);
END $fn$;

-- Every outlet that already exists gets the two rows now. New outlets get
-- them through provision_outlet, which calls this same function.
DO $backfill$
DECLARE o record;
BEGIN
  FOR o IN SELECT id FROM chain.outlet LOOP
    PERFORM chain.seed_chart('outlet_' || o.id::text);
  END LOOP;
END $backfill$;
