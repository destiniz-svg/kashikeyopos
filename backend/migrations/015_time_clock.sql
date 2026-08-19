-- ═══ THE TIME CLOCK ════════════════════════════════════════════════════════
--
-- 02-POS-SPEC.md §2 (`staff`): "Roster, clock in/out, rank assignment."
--
-- A shift lives in the OUTLET's schema, not in `chain`, even though the person
-- who worked it lives in `chain`. That split is deliberate and it is the same
-- one loyalty uses: a member is chain-wide, their visits belong to the outlet
-- that served them. Hours are the outlet's cost, they feed that outlet's
-- payroll and its P&L, and a manager at one branch has no business reading
-- another branch's rota. The staff record is shared; the labour is not.
--
-- WHY NOT A SINGLE ROW PER SHIFT WITH BOTH TIMES. It is a single row, and the
-- open shift is the one with `out_at IS NULL` — but the constraint below is
-- what makes that safe. Two open shifts for one person means two clocks running
-- and hours counted twice, which is the whole failure mode of a paper book.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name, db_role FROM chain.outlet LOOP
    EXECUTE format($q$
      CREATE TABLE IF NOT EXISTS %1$I.shift (
        id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        staff_id  uuid NOT NULL,
        in_at     timestamptz NOT NULL DEFAULT now(),
        out_at    timestamptz,
        -- Who pressed the button. Usually the person themselves; a manager
        -- clocking somebody out at the end of a shift they forgot to close is
        -- an ordinary event and has to be attributable to the manager, not
        -- silently recorded as the worker's own act.
        in_by     uuid, out_by uuid,
        device_id uuid,
        note      text,
        CONSTRAINT shift_ends_after_it_starts CHECK (out_at IS NULL OR out_at >= in_at)
      );

      -- One clock per person at a time. A partial unique index rather than
      -- application logic, because two terminals can press the button in the
      -- same second and a read-then-write cannot see the other one.
      CREATE UNIQUE INDEX IF NOT EXISTS shift_one_open ON %1$I.shift (staff_id)
        WHERE out_at IS NULL;
      CREATE INDEX IF NOT EXISTS shift_by_day ON %1$I.shift (in_at DESC);
    $q$, o.schema_name);

    -- The grant is the other half of adding a table. See migration 014.
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
  END LOOP;
END $$;

-- ── writing the roster ─────────────────────────────────────────────────────
--
-- chain.staff has had a `staff_write` POLICY since migration 002 — rank 4, and
-- never above your own rank — but no outlet role was ever GRANTED the write.
-- A policy with no grant behind it is a rule guarding a door nobody can open:
-- every attempt failed with "permission denied for table staff" long before
-- the policy was consulted, and the policy has therefore never once been
-- exercised. The grant makes the second belt real; the policy still decides.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT db_role FROM chain.outlet LOOP
    EXECUTE format('GRANT INSERT, UPDATE ON chain.staff TO %I', r.db_role);
  END LOOP;
END $$;

-- ── releasing a lockout is a MANAGER's job ─────────────────────────────────
--
-- The usual cause of a lockout is five fat-fingered attempts on a wet screen
-- mid-service, and the person who can fix it is the manager standing there —
-- not an admin who is at another site. But writing chain.staff is rank 4 by
-- policy, and rightly so: that is the table that decides everybody's rank.
--
-- So this is a SECURITY DEFINER function that does ONE thing — clear the
-- counter and the lock, for one person, at this outlet — and checks rank 3 for
-- itself. Exactly the shape migration 007 already uses for the sign-in
-- counters, which have to be written before there is any rank at all. Widening
-- the policy to rank 3 instead would have handed managers the whole roster.
CREATE OR REPLACE FUNCTION chain.release_lock(p_staff uuid) RETURNS TABLE (id uuid, name text)
  LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  IF app.current_rank() < 3 THEN
    RAISE EXCEPTION 'releasing a lockout needs rank 3';
  END IF;
  RETURN QUERY
    UPDATE chain.staff s SET failed = 0, locked_until = NULL
      WHERE s.id = p_staff AND s.outlet_id = app.current_outlet()
      RETURNING s.id, s.name;
END $fn$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT db_role FROM chain.outlet LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION chain.release_lock(uuid) TO %I', r.db_role);
  END LOOP;
END $$;
