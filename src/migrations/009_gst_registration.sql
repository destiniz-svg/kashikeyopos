-- ═══ WHEN GST STOPS BEING OPTIONAL ═════════════════════════════════════════
-- Registration in the Maldives is not a preference. Under the GST Act a person
-- must register once taxable supplies pass a threshold in a 12-month period,
-- and the tourism sector registers regardless of turnover. Below the threshold
-- a business charges NOTHING — and an app that quietly assumes 8% is telling a
-- small café to collect a tax it has no authority to collect and no return to
-- remit it on.
--
-- So the threshold is statutory data, kept beside the rates, and the app
-- MEASURES a business against it rather than asking the owner to remember.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO chain.setting (key, value) VALUES
  ('gst_registration', '{
     "threshold": 1000000,
     "currency": "MVR",
     "months": 12,
     "warnAt": 0.8,
     "tourismAlways": true,
     "note": "Taxable supplies over MVR 1,000,000 in any 12 months require GST registration. A business in the tourism sector registers regardless of turnover.",
     "authority": "Maldives Inland Revenue Authority · Goods and Services Tax Act 10/2011"
   }'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = excluded.value;
