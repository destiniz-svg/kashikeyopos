-- ═══ EVERY INSTALL HAS A NAME, SO A TERMINAL CAN TELL THEM APART ════════════
-- Outlet ids are small serial integers, so "outlet 1" on a staging database
-- and "outlet 1" on the production database are the same number — and a
-- browser's durable outbox keys its rows by that number. A till that queued
-- demo ops against one install and later signed into another whose outlet
-- happened to share the id would replay the demo into the real store, which
-- is not hypothetical: it is the incident this migration exists to end.
--
-- One uuid per DATABASE, minted once, published in every bootstrap. The
-- terminal stamps every queued op with it and refuses to replay an op whose
-- stamp names a different install — those park, visibly, for a person to
-- adopt or discard. An id is not a secret; it is a name.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO chain.setting (key, value)
SELECT 'install', jsonb_build_object('id', gen_random_uuid(), 'at', now())
WHERE NOT EXISTS (SELECT 1 FROM chain.setting WHERE key = 'install');
