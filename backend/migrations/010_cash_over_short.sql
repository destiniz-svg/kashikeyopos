-- ═══ 6920 CASH OVER OR SHORT ═══════════════════════════════════════════════
--
-- A drawer that counts short is not a rounding difference and it is not
-- nothing: it is a real loss, and it has to land somewhere or account 1000
-- (cash in drawer) drifts permanently away from the cash actually in the
-- drawer. From that point the balance sheet is decoration.
--
-- 6910 already exists for CASH ROUNDING, which is a different thing — the
-- deliberate few laari given up when a cash bill is rounded to the nearest
-- increment. Posting drawer variance there would blend an accepted cost with
-- an unexplained one, and the second is the only one worth investigating.
--
-- Declared expense/dr, so a drawer that comes up OVER credits it and reads as
-- a negative expense. That is right: an over is not revenue and must never
-- reach the sales line.

-- The seed function, so every outlet provisioned from here on has it …
-- 2310 Pension payable and 6920 Cash over or short live in the ONE chart, migration 004.
-- This file used to redefine chain.seed_chart with its own complete copy of
-- the list — as did three others — so five files each held a growing
-- duplicate and only the last one to run had any effect. Adding an account
-- to the chart-of-accounts migration, which is where anybody would look,
-- did precisely nothing. Re-seeding the outlets that already exist is the
-- half that belongs here, and it is below.

-- … and every outlet that ALREADY exists. Four times in this build a migration
-- patched the live outlets and forgot the function, or the function and forgot
-- the outlets, and the gap only showed up when somebody provisioned a branch
-- that was quietly missing a column. Both halves, in the same migration, every
-- time.
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^outlet_[0-9]+$'
  LOOP
    PERFORM chain.seed_chart(s);
  END LOOP;
END $$;
