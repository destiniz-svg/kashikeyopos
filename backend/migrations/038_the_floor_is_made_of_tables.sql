-- ═══════════════════════════════════════════════════════════════════════════
-- The floor plan — 02-POS-SPEC.md §3.1.
--
-- A TABLE HAS NEVER BEEN A THING IN THIS SYSTEM. `chain.outlet.tables` is an
-- INTEGER, and the floor screen drew T01…Tn by counting to it. That is why a
-- restaurant cannot say it has a Terrace, cannot call one "Cabana 1", and
-- cannot tell the till that table six seats eight. §3.1 asks for all three:
--
--   "20px/700 monospace label (T04, OR THE OPERATOR'S OWN NAME — 'Cabana 1'
--    reads that way on the KDS ticket, the parked strip and the printed bill,
--    not just here), a status chip top-right, and covers + elapsed time
--    beneath."
--
-- and a "zone rail across the top: pill buttons with the zone name and a
-- monospace count".
--
-- KEYED BY THE NAME, for the same reason menu_section is (migration 037).
-- `ticket.table_no` is text and every reader of the floor — the KDS, the
-- orders board, the receipt, the guest's QR card — already speaks that text.
-- A surrogate id would have meant migrating all of them to learn a new
-- concept, for no gain: a table's name IS its identity to everyone who works
-- there, and renaming one is a rename of the thing itself.
--
-- THE COUNT STAYS, AND STAYS AUTHORITATIVE WHEN THIS IS EMPTY. An outlet that
-- has never opened this editor has no rows here, and the floor keeps drawing
-- T01…Tn off `outlet.tables` exactly as it does today. That is not a fallback
-- bolted on; it is what "empty is a first-class state" means for this screen
-- (docs/10-NO-DEMO-DATA.md). Naming tables and grouping them into zones is an
-- enrichment a merchant opts into, not a migration they are forced through,
-- and nothing about the till changes on the day they do.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^outlet_[0-9]+$' LOOP
    EXECUTE format($ddl$
      CREATE TABLE IF NOT EXISTS %1$I.dining_table (
        -- What the operator calls it, and what ticket.table_no holds.
        name    text PRIMARY KEY,
        -- Which part of the room. NULL is a real answer: a small café has one
        -- room and no use for zones, and the rail hides itself when there is
        -- nothing to choose between.
        zone    text,
        -- How many it seats. Drives nothing yet and is shown on the tile,
        -- because "can we fit six" is a question asked at the door twenty
        -- times a service and currently answered from memory.
        seats   int NOT NULL DEFAULT 2 CHECK (seats > 0 AND seats <= 99),
        sort    int NOT NULL DEFAULT 0,
        -- Retired rather than deleted: a table taken out of the room still
        -- appears on every sale that was rung against it.
        active  boolean NOT NULL DEFAULT true
      );
      CREATE INDEX IF NOT EXISTS dining_table_zone ON %1$I.dining_table (zone, sort, name);
    $ddl$, s);
  END LOOP;
END $$;

-- ── grants ─────────────────────────────────────────────────────────────────
-- Adding a table is two statements, not one (migration 014). DELETE because a
-- table added by a typo should be removable; one that has traded is retired
-- instead, and the app enforces that rather than the grant — a name with sales
-- against it is still resolvable from ticket.table_no whether the row is here
-- or not, which is the property that made keying by name safe in the first
-- place.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name, db_role FROM chain.outlet LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
    EXECUTE format('GRANT DELETE ON %I.dining_table TO %I', o.schema_name, o.db_role);
  END LOOP;
END $$;
