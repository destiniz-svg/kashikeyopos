-- ═══ KITCHEN STATIONS ══════════════════════════════════════════════════════
--
-- 02-POS-SPEC.md §4: "Per-station targets come from configuration, not a
-- constant." So a station is a row an outlet owns, with its own target, and not
-- a string literal in a switch somewhere.
--
-- A station belongs to an OUTLET, not to the chain: the Malé kitchen may run a
-- grill and a cold larder while Hulhumalé runs one pass, and a target of 12
-- minutes on a wood oven is not a target of 12 minutes on a salad station.
--
-- `sort` orders the columns on the display. It is separate from the name so a
-- kitchen can reorder its own pass without renaming anything the item master
-- points at.
CREATE TABLE IF NOT EXISTS chain.station (
  outlet_id   int  NOT NULL REFERENCES chain.outlet(id) ON DELETE CASCADE,
  name        text NOT NULL,
  target_mins int  NOT NULL DEFAULT 12 CHECK (target_mins > 0),
  sort        int  NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  PRIMARY KEY (outlet_id, name)
);

ALTER TABLE chain.station ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain.station FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS station_scoped ON chain.station;
CREATE POLICY station_scoped ON chain.station FOR SELECT
  USING (outlet_id = app.current_outlet() OR app.group_scope());
-- Configuring the kitchen is a Manager act, like every other piece of outlet
-- configuration. A cashier cannot retarget the grill.
DROP POLICY IF EXISTS station_write ON chain.station;
CREATE POLICY station_write ON chain.station FOR ALL
  USING (outlet_id = app.current_outlet() AND app.current_rank() >= 3)
  WITH CHECK (outlet_id = app.current_outlet() AND app.current_rank() >= 3);

-- Which station cooks a dish. On the ITEM, because that is the fact — a burger
-- goes to the grill whoever rings it. NULL means nobody has routed it yet, and
-- the KDS shows those in a catch-all column rather than dropping the ticket:
-- a dish that reaches the pass with no station is a configuration gap, and the
-- kitchen must see the order regardless.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name FROM chain.outlet LOOP
    EXECUTE format('ALTER TABLE %I.item ADD COLUMN IF NOT EXISTS station text', o.schema_name);
    -- The KDS reads tickets by stage constantly; without this it is a seq scan
    -- of every ticket the outlet has ever fired, every few seconds, all service.
    EXECUTE format('CREATE INDEX IF NOT EXISTS kds_live ON %I.kds_ticket'
                   || ' (stage, fired_at) WHERE served_at IS NULL', o.schema_name);
  END LOOP;
END $$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT db_role FROM chain.outlet LOOP
    EXECUTE format('GRANT SELECT ON chain.station TO %I', r.db_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON chain.station TO %I', r.db_role);
  END LOOP;
END $$;
