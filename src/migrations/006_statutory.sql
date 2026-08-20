-- ═══ STATUTORY STRUCTURE ═══════════════════════════════════════════════════
-- What ships with the product because it is law or definition, not because it
-- is a demo figure. A tax VERSION is law: a rate change next year must not
-- restate last year's receipts, so every rate that has ever been in force is
-- here with the date it took effect.
-- ═══════════════════════════════════════════════════════════════════════════

-- Maldives GST. TGST is the tourism rate, GGST the general rate. outlet_id
-- NULL means "the statute", readable by every outlet; an outlet's own row
-- (written at onboarding) is the version it actually charges.
INSERT INTO chain.tax_version (outlet_id, code, rate, effective_from, effective_to, authority_ref)
VALUES
  (NULL, 'TGST',  3.5, DATE '2011-01-01', DATE '2011-12-31', 'Act 10/2011'),
  (NULL, 'TGST',  6.0, DATE '2012-01-01', DATE '2012-12-31', 'Act 10/2011'),
  (NULL, 'TGST',  8.0, DATE '2013-01-01', DATE '2014-10-31', 'Act 10/2011'),
  (NULL, 'TGST', 12.0, DATE '2014-11-01', DATE '2022-12-31', 'Act 10/2011'),
  (NULL, 'TGST', 16.0, DATE '2023-01-01', NULL,              'Act 25/2022'),
  (NULL, 'GGST',  3.5, DATE '2011-10-02', DATE '2011-12-31', 'Act 10/2011'),
  (NULL, 'GGST',  6.0, DATE '2012-01-01', DATE '2022-12-31', 'Act 10/2011'),
  (NULL, 'GGST',  8.0, DATE '2023-01-01', NULL,              'Act 25/2022')
ON CONFLICT (outlet_id, code, effective_from) DO NOTHING;

-- Chain-level structure the terminals read. Definitions, not trade.
INSERT INTO chain.setting (key, value) VALUES
  ('currencies', '[
     {"code":"MVR","name":"Maldivian rufiyaa","symbol":"MVR","base":true,"rate":1},
     {"code":"USD","name":"US dollar","symbol":"$","rate":15.42},
     {"code":"EUR","name":"Euro","symbol":"€","rate":16.80},
     {"code":"GBP","name":"Pound sterling","symbol":"£","rate":19.60}
   ]'::jsonb),
  ('payroll_rules', '{
     "pensionEmployeePct":7, "pensionEmployerPct":7,
     "pensionMinAge":16, "pensionMaxAge":65,
     "otMultiplier":1.25, "standardHours":48,
     "serviceChargeStaffShare":100
   }'::jsonb),
  ('units', '[
     {"code":"g","name":"gram","base":"g","factor":1},
     {"code":"kg","name":"kilogram","base":"g","factor":1000},
     {"code":"ml","name":"millilitre","base":"ml","factor":1},
     {"code":"l","name":"litre","base":"ml","factor":1000},
     {"code":"pcs","name":"piece","base":"pcs","factor":1},
     {"code":"doz","name":"dozen","base":"pcs","factor":12},
     {"code":"box","name":"box","base":"pcs","factor":1},
     {"code":"pkt","name":"packet","base":"pcs","factor":1},
     {"code":"btl","name":"bottle","base":"pcs","factor":1},
     {"code":"can","name":"can","base":"pcs","factor":1}
   ]'::jsonb),
  ('count_frequencies', '["daily","weekly","fortnightly","monthly","quarterly"]'::jsonb),
  ('expense_categories', '[
     "Rent & premises","Utilities","Administration","Licences & insurance",
     "Marketing & promotion","Travel & transport","Professional & recruitment",
     "Cleaning, laundry & upkeep","Packaging & consumables","Repairs & maintenance",
     "Bank & card charges","Delivery commission"
   ]'::jsonb),
  ('waste_reasons', '["Spoiled","Expired","Dropped","Over-prepped","Returned by guest","Staff meal","Training","Damaged in transit"]'::jsonb),
  ('void_reasons', '["Wrong item rung","Guest changed mind","Kitchen out of stock","Quality issue","Duplicate line","Training"]'::jsonb),
  ('discount_reasons', '["Manager approval","Loyalty reward","Promotion","Service recovery","Staff meal","Corporate rate"]'::jsonb),
  ('doc_series_defs', '[
     {"kind":"SALE","label":"Sales receipt","suffix":"R"},
     {"kind":"CN","label":"Credit note","suffix":"CN"},
     {"kind":"PO","label":"Purchase order","suffix":"PO"},
     {"kind":"GRN","label":"Goods received note","suffix":"GRN"},
     {"kind":"PR","label":"Indent / purchase request","suffix":"PR"},
     {"kind":"DSP","label":"Dispatch note","suffix":"DSP"},
     {"kind":"JV","label":"Journal voucher","suffix":"JV"}
   ]'::jsonb),
  ('acquirer_rates', '[
     {"acquirer":"BML","scheme":"Visa/Mastercard","mdrPct":2.5,"settleDays":1},
     {"acquirer":"MIB","scheme":"Visa/Mastercard","mdrPct":2.5,"settleDays":1},
     {"acquirer":"Ooredoo m-Faisaa","scheme":"Wallet","mdrPct":1.5,"settleDays":1},
     {"acquirer":"Dhiraagu Pay","scheme":"Wallet","mdrPct":1.5,"settleDays":1}
   ]'::jsonb),
  ('kds_stations', '["main","grill","cold","bar","dessert","expo"]'::jsonb),
  ('recon_tolerance', '{"exactMvr":1, "nearPct":3, "nearDays":2}'::jsonb)
ON CONFLICT (key) DO NOTHING;
