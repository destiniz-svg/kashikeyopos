-- ═══ ONE NUMBER SAYS WHERE AN ORDER IS ═════════════════════════════════════
-- The pass, the orders list, the ticket panel and the guest's phone were four
-- opinions about the same order. The kitchen bumped every line and finished the
-- table; Orders & Tickets still said "Open", because it read none of them — it
-- printed the literal word. The ticket panel had a fifth idea of its own,
-- `ticket.flow`, that nothing else wrote and nothing else read.
--
-- None of it survived a reload either. A bump lived in one browser's memory:
-- `ticket_line` recorded when a line was FIRED and never when it came back up,
-- so the second tablet on the floor, and the same tablet after a refresh, saw
-- the whole table still cooking.
--
-- So: a line records the moment the pass finished it, and the order carries the
-- rung it is on — the same four the guest's tracker reads. Whoever moves it
-- writes here, and everybody reads here.
--
--   0 taking the order · 1 in the kitchen · 2 ready at the pass · 3 served
--
-- `ticket.status` is untouched and stays what it was: the bill's LIFECYCLE,
-- open through closed. Where the food is and whether the money has been taken
-- are different questions, and a served table that has not paid is exactly the
-- row a manager is looking for.
-- ═══════════════════════════════════════════════════════════════════════════

DO $mig$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name FROM chain.outlet WHERE schema_name IS NOT NULL LOOP
    EXECUTE format('ALTER TABLE %I.ticket ADD COLUMN IF NOT EXISTS stage smallint'
      || ' NOT NULL DEFAULT 0', o.schema_name);
    EXECUTE format('ALTER TABLE %I.ticket ADD COLUMN IF NOT EXISTS stage_at'
      || ' timestamptz', o.schema_name);
    EXECUTE format('ALTER TABLE %I.ticket ADD COLUMN IF NOT EXISTS stage_by uuid',
      o.schema_name);
    -- Named, so it can be re-run and so a bad rung says which constraint refused.
    BEGIN
      EXECUTE format('ALTER TABLE %I.ticket ADD CONSTRAINT ticket_stage_rung'
        || ' CHECK (stage BETWEEN 0 AND 3)', o.schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    EXECUTE format('ALTER TABLE %I.ticket_line ADD COLUMN IF NOT EXISTS ready_at'
      || ' timestamptz', o.schema_name);
    EXECUTE format('ALTER TABLE %I.ticket_line ADD COLUMN IF NOT EXISTS ready_by uuid',
      o.schema_name);
    -- A line cannot be finished before it was fired. The pass bumping an
    -- unfired line is a bug on the device, and it should not reach the books.
    BEGIN
      EXECUTE format('ALTER TABLE %I.ticket_line ADD CONSTRAINT line_ready_was_fired'
        || ' CHECK (ready_at IS NULL OR sent_at IS NOT NULL)', o.schema_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    -- The pass asks one question over and over: what is still cooking?
    EXECUTE format('CREATE INDEX IF NOT EXISTS ticket_line_cooking'
      || ' ON %I.ticket_line(ticket_id) WHERE sent_at IS NOT NULL AND ready_at IS NULL',
      o.schema_name);
  END LOOP;
END $mig$;
