-- ═══ THE PANEL'S NAMES ARE NOT A STORE'S TO CLAIM ═══════════════════════════
-- Mission Control (panel/) is real infrastructure now. The wildcard domain
-- routes every subdomain to the POS today, but the moment the panel is given
-- a subdomain of its own, a store already holding that handle would be
-- standing on it — so the names are reserved the day the service exists,
-- not the day the collision is found.

INSERT INTO chain.reserved_handle (name, why) VALUES
  ('panel', 'the platform'),
  ('mission-control', 'the platform'),
  ('control', 'the platform'),
  ('seller', 'the platform'),
  ('platform', 'the platform')
ON CONFLICT (name) DO NOTHING;
