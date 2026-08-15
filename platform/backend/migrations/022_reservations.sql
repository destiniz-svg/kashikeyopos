-- ═══ RESERVATIONS ══════════════════════════════════════════════════════════
--
-- 02-POS-SPEC.md §2 (`reservations`): "Tonight's book, table assignment,
-- arrival state."
--
-- One line of spec, and three decisions fall out of it.
--
-- A BOOKING HOLDS A TABLE FOR A WINDOW, not for a moment. "Seven o'clock,
-- table 4" means table 4 is not available at half past seven either, and a book
-- that stores only a start time will cheerfully sell the same table twice to
-- two parties who then meet at the door. So a reservation carries how long the
-- table is held, and an overlapping booking on the same table is refused by a
-- constraint rather than by the screen remembering to check.
--
-- ARRIVAL STATE IS A LIFECYCLE, AND A NO-SHOW IS PART OF IT. A booking that
-- never arrived is DATA — the pattern is what a restaurant wants to know about
-- a name that does it twice a month — so it is a status and never a deletion.
--
-- THE BOOK IS PER OUTLET, unlike a member or a promotion. Table 4 belongs to a
-- branch, and so does the evening.
--
-- WHAT THIS DELIBERATELY DOES NOT DO is check the party against the table's
-- size, because this build has no seat counts: `chain.outlet.tables` is a
-- count of tables and nothing knows that table 4 seats two. Inventing a
-- capacity to validate against would be a rule with nothing behind it, and the
-- honest thing is to record the covers, show them to the host, and let the
-- person who can see the room decide.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name, db_role FROM chain.outlet LOOP
    EXECUTE format($q$
      CREATE TABLE IF NOT EXISTS %1$I.reservation (
        id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        at        timestamptz NOT NULL DEFAULT now(),
        on_date   date NOT NULL,
        -- Minutes from midnight. A booking is a time of day on a date, not an
        -- instant: "seven o'clock" survives a timezone the same way a shift
        -- does, and the outlet is the only clock that matters.
        at_min    int NOT NULL CHECK (at_min >= 0 AND at_min < 1440),
        -- How long the table is held for. The default is a decision an
        -- operator can change per booking, not a rule.
        mins      int NOT NULL DEFAULT 90 CHECK (mins > 0 AND mins <= 480),
        covers    int NOT NULL CHECK (covers > 0 AND covers <= 200),
        name      text NOT NULL,
        phone     text,
        member_id uuid,
        note      text,
        -- A booking may have no table yet. A host takes the name at eleven in
        -- the morning and decides the room at six, and a system that demanded
        -- the table up front would have them inventing one.
        table_no  text,
        status    text NOT NULL DEFAULT 'booked'
                  CHECK (status IN ('booked','seated','done','no_show','cancelled')),
        seated_at timestamptz,
        ticket_id uuid REFERENCES %1$I.ticket(id),
        done_at   timestamptz,
        reason    text,
        by_staff  uuid
      );
      CREATE INDEX IF NOT EXISTS reservation_day ON %1$I.reservation (on_date, at_min);
    $q$, o.schema_name);

    /* THE DOUBLE-BOOKING GUARD, in the database rather than in a screen.
       Two hosts on two terminals can both look at an empty slot in the same
       second; only one of them can win an exclusion constraint. `btree_gist`
       is what lets a table number (equality) and a time range (overlap) sit in
       one constraint.

       Only 'booked' and 'seated' rows take part: a cancelled or no-show
       booking has released the table, and a finished one has left. */
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS btree_gist';
    EXECUTE format($q$
      ALTER TABLE %1$I.reservation
        DROP CONSTRAINT IF EXISTS reservation_no_double_book;
      ALTER TABLE %1$I.reservation
        ADD CONSTRAINT reservation_no_double_book EXCLUDE USING gist (
          table_no WITH =,
          on_date WITH =,
          int4range(at_min, at_min + mins) WITH &&
        ) WHERE (table_no IS NOT NULL AND status IN ('booked','seated'));
    $q$, o.schema_name);

    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
    -- A booking is cancelled, never deleted: what was promised and did not
    -- happen is the part worth keeping.
    EXECUTE format('REVOKE DELETE ON %I.reservation FROM %I', o.schema_name, o.db_role);
  END LOOP;
END $$;
