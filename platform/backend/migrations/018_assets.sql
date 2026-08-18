-- ═══ ASSET REGISTER ════════════════════════════════════════════════════════
--
-- 02-POS-SPEC.md §2 (`assets`): "Asset register, depreciation posting, service
-- schedule." 08-BUILD-STAGES §20: "register, schedule, monthly posting to
-- 6300/1510."
--
-- 1500 Equipment, 1510 Accumulated depreciation and 6300 Depreciation have been
-- in the chart since day one with nothing able to reach them, and the Operating
-- Costs screen already refuses 6300 and tells the operator it comes from "the
-- asset register". This is that register.
--
-- AN OVEN IS NOT AN EXPENSE. Entered on the Operating Costs screen, sixty
-- thousand rufiyaa lands in one month: that month reads as a catastrophe, the
-- next five years read as better than they were, and the balance sheet never
-- knows the restaurant owns an oven. So buying one CAPITALISES to 1500 and is
-- charged to 6300 a month at a time over its life.
--
-- 6310 GAIN OR LOSS ON DISPOSAL is new. Selling a five-year-old fryer for
-- 2,000 when its net book value is 3,500 is a 1,500 loss, and it is not a
-- repair, not an FX difference and certainly not revenue. Declared expense/dr
-- like 6900 and 6920, so a gain credits it and reads as a negative expense —
-- which is right, because a gain on disposal must never reach the sales line.

-- The seed function, so every outlet provisioned from here on has it …
-- 6310 Gain or loss on disposal live in the ONE chart, migration 004.
-- This file used to redefine chain.seed_chart with its own complete copy of
-- the list — as did three others — so five files each held a growing
-- duplicate and only the last one to run had any effect. Adding an account
-- to the chart-of-accounts migration, which is where anybody would look,
-- did precisely nothing. Re-seeding the outlets that already exist is the
-- half that belongs here, and it is below.

-- … and every outlet that already exists. Both halves, in the same migration.
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^outlet_[0-9]+$'
  LOOP
    PERFORM chain.seed_chart(s);
  END LOOP;
END $$;

-- The register itself. Same shape as migration 017: the tables here, folded
-- into chain.provision_outlet() there, and BOTH grants — the CREATE and the
-- GRANT are two halves of adding a table, because provision_outlet grants ALL
-- TABLES IN SCHEMA only at the moment it runs.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name, db_role FROM chain.outlet LOOP
    EXECUTE format($q$
      CREATE TABLE IF NOT EXISTS %1$I.asset (
        id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tag       text,
        name      text NOT NULL,
        category  text,
        acquired_on date NOT NULL,
        cost      numeric(12,2) NOT NULL CHECK (cost > 0),
        -- How long it will earn its keep, and what it is worth at the end.
        -- Depreciation charges (cost - residual) across life_months.
        life_months int NOT NULL CHECK (life_months BETWEEN 1 AND 600),
        residual  numeric(12,2) NOT NULL DEFAULT 0 CHECK (residual >= 0),
        method    text NOT NULL DEFAULT 'credit'
                  CHECK (method IN ('cash','bank','credit')),
        supplier_id uuid, serial text, location text, note text,
        status    text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','disposed')),
        -- Same idempotency as a spread cost, and for the same reason: a
        -- month-end run pressed twice must charge the month once. The trial
        -- balance would still balance if it did — a duplicate is
        -- self-consistent — so nothing downstream could ever tell you.
        depreciated_months int NOT NULL DEFAULT 0,
        depreciated_upto text,
        disposed_on date,
        proceeds  numeric(12,2),
        by_staff  uuid,
        at        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT residual_below_cost CHECK (residual < cost)
      );
      CREATE INDEX IF NOT EXISTS asset_live ON %1$I.asset (status, acquired_on DESC);

      CREATE TABLE IF NOT EXISTS %1$I.asset_service (
        id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        asset_id  uuid NOT NULL REFERENCES %1$I.asset(id),
        kind      text NOT NULL DEFAULT 'service'
                  CHECK (kind IN ('service','repair','inspection')),
        -- NULL every_days is a one-off. A schedule generates its next row when
        -- the current one is completed, so a recurring service cannot be
        -- forgotten by the act of doing it.
        every_days int CHECK (every_days IS NULL OR every_days > 0),
        due_on    date NOT NULL,
        done_on   date,
        done_by   uuid,
        -- A service that cost money books ONE expense row — the same table the
        -- Operating Costs screen writes — and points at it. One figure, one
        -- place, reachable from either end. Two tables would mean two places to
        -- type the same repair and two answers for what repairs cost.
        expense_id uuid,
        note      text,
        at        timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS service_due ON %1$I.asset_service (due_on)
        WHERE done_on IS NULL;
    $q$, o.schema_name);

    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
    -- A service booked against the wrong machine is deleted; an asset that has
    -- been capitalised into the ledger is disposed of, never deleted.
    EXECUTE format('GRANT DELETE ON %I.asset_service TO %I', o.schema_name, o.db_role);
  END LOOP;
END $$;
