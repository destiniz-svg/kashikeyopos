-- ═══ ONE SPELLING OF A TABLE ═══════════════════════════════════════════════
-- A physical table had four names. The floor drew `T05`. A round sent from a
-- guest's phone opened a ticket called `5`. The reservations book normalised
-- its own way, because it had to — an EXCLUDE constraint that sees `2` and
-- `T02` as two tables stops no double booking. And the member portal's bill
-- screen asks for "my open ticket", which the cashier's own tile then could not
-- open, because the tile and the ticket were not the same string.
--
-- src/tables.js is now the one spelling and every path that writes or reads a
-- ticket's table goes through it. THAT ALONE IS NOT ENOUGH: a database that has
-- been trading already holds rows under the old spelling, and the moment the
-- new code looks for `T03` every one of them becomes invisible — open tickets
-- orphaned mid-service, a guest's phone showing an empty bill for food on the
-- table in front of them. So the existing rows move too.
--
-- WHERE MOVING ONE WOULD COLLIDE, IT IS LEFT ALONE. `ticket_open_table` is a
-- unique index on (table_no, split) for open tickets; if both `5` and `T05` are
-- open then the same table already has two tickets, which is a thing for a
-- manager to settle and not for a migration to guess at. Renaming one onto the
-- other would fail the whole deploy, and picking a winner would silently merge
-- two parties' bills.
DO $$
DECLARE o record; n int;
BEGIN
  FOR o IN SELECT schema_name FROM chain.outlet LOOP
    EXECUTE format($q$
      UPDATE %1$I.ticket t
         SET table_no = 'T' || lpad(substring(t.table_no from '^[Tt]?0*([1-9][0-9]{0,2})$'), 2, '0')
       WHERE t.table_no ~ '^[Tt]?0*[1-9][0-9]{0,2}$'
         AND t.table_no <> 'T' || lpad(substring(t.table_no from '^[Tt]?0*([1-9][0-9]{0,2})$'), 2, '0')
         AND NOT EXISTS (
           SELECT 1 FROM %1$I.ticket x
            WHERE x.split = t.split AND x.status = 'open' AND t.status = 'open'
              AND x.table_no = 'T' || lpad(substring(t.table_no from '^[Tt]?0*([1-9][0-9]{0,2})$'), 2, '0')
         )
    $q$, o.schema_name);
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE NOTICE 'renamed % ticket(s) to the canonical table name in %', n, o.schema_name;
    END IF;

    -- The guest's own orders name a table too, and the tracker matches them.
    EXECUTE format($q$
      UPDATE %1$I.guest_order g
         SET table_no = 'T' || lpad(substring(g.table_no from '^[Tt]?0*([1-9][0-9]{0,2})$'), 2, '0')
       WHERE g.table_no ~ '^[Tt]?0*[1-9][0-9]{0,2}$'
         AND g.table_no <> 'T' || lpad(substring(g.table_no from '^[Tt]?0*([1-9][0-9]{0,2})$'), 2, '0')
    $q$, o.schema_name);
  END LOOP;
END $$;
