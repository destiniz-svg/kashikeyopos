-- ═══ THE BOOKS ARE KEPT IN ONE CURRENCY ════════════════════════════════════
-- A business chooses its base currency when it opens and every figure it ever
-- reports is in that currency. A guest may hand over another one at the
-- counter — that is a TENDER, converted at a rate the till records on the
-- receipt — and it does not make the ledger bilingual.
--
-- Two facts were missing from the currency table, and the app was carrying
-- both as hardcoded constants:
--
--   minor      how many decimal places the currency actually has
--   cashRound  what CASH settles to. The rufiyaa settles to the 50-laari coin,
--              which is the smallest in circulation, and the difference posts
--              to 4900. A dollar has cents, so it rounds to nothing — the
--              till used to round dollars to the nearest 50 cents because the
--              rule was written as `Math.round(n * 2) / 2`.
--
-- `base` marks the currencies a business may keep its books in. The others
-- remain spendable at the counter.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO chain.setting (key, value) VALUES
  ('currencies', '[
     {"code":"MVR","name":"Maldivian rufiyaa","symbol":"MVR","base":true,
      "canBase":true,"rate":1,"minor":2,"cashRound":0.5},
     {"code":"USD","name":"US dollar","symbol":"$",
      "canBase":true,"rate":15.42,"minor":2,"cashRound":0,
      "note":"The rufiyaa is pegged to the dollar; 15.42 is the ceiling of the published band."},
     {"code":"EUR","name":"Euro","symbol":"€","rate":16.80,"minor":2,"cashRound":0},
     {"code":"GBP","name":"Pound sterling","symbol":"£","rate":19.60,"minor":2,"cashRound":0}
   ]'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = excluded.value;
