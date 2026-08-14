-- ═══ STOCK COUNTS THAT NEED APPROVING ══════════════════════════════════════
--
-- 02-POS-SPEC.md §2 (`counts`): "Count sheets by category; variance in units
-- and MVR; approval above a threshold."
--
-- A stock count is the one operation in the system where a member of staff
-- types a number and the accounts move to meet it. Everything else is derived —
-- a sale prices itself from the item master, a delivery from its invoice — but
-- a count simply asserts "there are 4 here", and the difference becomes a
-- posted expense. That makes it the easiest place in the whole platform to
-- write off a theft, so above a threshold it waits for somebody more senior.
--
-- THE THRESHOLD IS CONFIGURATION, NOT A CONSTANT. 0 means every count posts
-- immediately, and that is the honest default for a new outlet because nobody
-- has set a policy yet — the system must not invent a monetary one on their
-- behalf. See 10-NO-DEMO-DATA.md.
ALTER TABLE chain.outlet
  ADD COLUMN IF NOT EXISTS count_approval_laari int NOT NULL DEFAULT 0
    CHECK (count_approval_laari >= 0);

DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name FROM chain.outlet LOOP
    -- 'posted' is the default so every count that already exists reads as what
    -- it is: one that went straight through when there was no approval step.
    EXECUTE format($q$
      ALTER TABLE %1$I.stock_count
        ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'posted',
        ADD COLUMN IF NOT EXISTS note text,
        ADD COLUMN IF NOT EXISTS rejected_reason text,
        ADD COLUMN IF NOT EXISTS threshold numeric(12,2) NOT NULL DEFAULT 0;
      ALTER TABLE %1$I.stock_count DROP CONSTRAINT IF EXISTS count_status;
      ALTER TABLE %1$I.stock_count ADD CONSTRAINT count_status
        CHECK (status IN ('pending','posted','rejected'));
      -- An approved count names its approver; a pending one cannot.
      ALTER TABLE %1$I.stock_count DROP CONSTRAINT IF EXISTS count_approval_shape;
      ALTER TABLE %1$I.stock_count ADD CONSTRAINT count_approval_shape
        CHECK (status <> 'pending' OR (approved_by IS NULL AND approved_at IS NULL));

      -- The cost each line was valued at WHEN IT WAS COUNTED. A count that
      -- waits two days for a signature must post the figure that was approved,
      -- not a figure re-derived from whatever the average cost has drifted to
      -- since — otherwise the approver signed off one number and the ledger
      -- took another.
      ALTER TABLE %1$I.count_line
        ADD COLUMN IF NOT EXISTS unit_cost numeric(12,4) NOT NULL DEFAULT 0;

      CREATE INDEX IF NOT EXISTS count_pending ON %1$I.stock_count (status, at)
        WHERE status = 'pending';
    $q$, o.schema_name);
  END LOOP;
END $$;
