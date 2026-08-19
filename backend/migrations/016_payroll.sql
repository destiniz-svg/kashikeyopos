-- ═══ PAYROLL & PENSION ═════════════════════════════════════════════════════
--
-- 02-POS-SPEC.md §2 (`payroll`): "Runs, pension, posts to 6000 / 2300."
-- 08-BUILD-STAGES.md §19: "Payroll & pension: runs posting to 6000 / 2300."
--
-- This is the link that makes PRIME COST true. reports.js has been computing it
-- as cost-of-sales plus 6000/6010 and flagging `labourPosted: false` since the
-- Reports phase, because nothing had ever posted a wage. Prime cost without
-- labour is not a low prime cost, it is an incomplete one, and a restaurant
-- that manages against it is managing against half a number.
--
-- NOTHING IS ENTERED TWICE. A run reads the hours the time clock already
-- recorded (migration 015). Nobody retypes a timesheet.

-- ── 2310 Pension payable ───────────────────────────────────────────────────
--
-- Separate from 2300 Payroll payable because it is owed to a DIFFERENT PARTY.
-- Net pay goes to the member of staff on payday; pension goes to the pension
-- office on its own schedule. Lumped into one account the balance can never be
-- reconciled against either of them, and the first time somebody tries, they
-- find a figure that matches nothing.
CREATE OR REPLACE FUNCTION chain.seed_payroll_accounts(p_schema text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  EXECUTE format($q$
    INSERT INTO %1$I.account (code, name, type, normal_side) VALUES
      ('2310','Pension payable','liability','cr')
    ON CONFLICT (code) DO NOTHING
  $q$, p_schema);
END $fn$;

-- ── the pension rate is CONFIGURATION ──────────────────────────────────────
--
-- The Maldives Retirement Pension Scheme is 7% from the employee and 7% from
-- the employer of the pensionable wage — but that is the operator's fact to
-- state, not this file's to assume. A business that is not registered
-- contributes nothing, and defaulting to 7% would invent a liability and a
-- deduction from somebody's wages. 0 means "nobody has said yet"; the screen
-- says what the statutory figure is so an operator knows what to enter.
ALTER TABLE chain.outlet
  ADD COLUMN IF NOT EXISTS pension_employee_bp int NOT NULL DEFAULT 0
    CHECK (pension_employee_bp >= 0 AND pension_employee_bp <= 10000),
  ADD COLUMN IF NOT EXISTS pension_employer_bp int NOT NULL DEFAULT 0
    CHECK (pension_employer_bp >= 0 AND pension_employer_bp <= 10000);

DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name, db_role FROM chain.outlet LOOP
    PERFORM chain.seed_payroll_accounts(o.schema_name);

    EXECUTE format($q$
      -- ── what somebody is paid, versioned ────────────────────────────────
      --
      -- Effective-dated like the tax rate, and for the same reason: a rise
      -- agreed in March must not restate February's payroll. A run reads the
      -- rate in force on its own period, never "the current rate".
      --
      -- Rates are per OUTLET even though the person is chain-wide: somebody
      -- who works two sites can be on two different rates, and hours are
      -- already the outlet's cost.
      CREATE TABLE IF NOT EXISTS %1$I.pay_rate (
        id        bigserial PRIMARY KEY,
        staff_id  uuid NOT NULL,
        -- hourly: paid for the hours the clock recorded.
        -- monthly: paid a fixed amount, prorated by the days in the period.
        kind      text NOT NULL DEFAULT 'hourly' CHECK (kind IN ('hourly','monthly')),
        amount    numeric(12,2) NOT NULL CHECK (amount >= 0),
        effective_from date NOT NULL,
        set_by    uuid,
        set_at    timestamptz NOT NULL DEFAULT now(),
        UNIQUE (staff_id, effective_from)
      );
      CREATE INDEX IF NOT EXISTS pay_rate_person ON %1$I.pay_rate (staff_id, effective_from DESC);

      -- ── a run ───────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS %1$I.payroll_run (
        id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        period_from date NOT NULL,
        period_to   date NOT NULL,
        status    text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','posted','paid')),
        gross     numeric(12,2) NOT NULL DEFAULT 0,
        employee_pension numeric(12,2) NOT NULL DEFAULT 0,
        employer_pension numeric(12,2) NOT NULL DEFAULT 0,
        net       numeric(12,2) NOT NULL DEFAULT 0,
        run_by    uuid, run_at timestamptz NOT NULL DEFAULT now(),
        posted_by uuid, posted_at timestamptz,
        paid_at   timestamptz,
        note      text,
        CONSTRAINT payroll_period CHECK (period_to >= period_from)
      );
      -- One POSTED run per period. A second run over the same fortnight would
      -- pay everybody twice, and it is not the kind of mistake anybody notices
      -- from the ledger afterwards.
      CREATE UNIQUE INDEX IF NOT EXISTS payroll_one_per_period
        ON %1$I.payroll_run (period_from, period_to)
        WHERE status <> 'draft';

      CREATE TABLE IF NOT EXISTS %1$I.payroll_line (
        id        bigserial PRIMARY KEY,
        run_id    uuid NOT NULL REFERENCES %1$I.payroll_run(id) ON DELETE CASCADE,
        staff_id  uuid NOT NULL,
        kind      text NOT NULL,
        rate      numeric(12,2) NOT NULL,
        hours     numeric(10,2) NOT NULL DEFAULT 0,
        shifts    int NOT NULL DEFAULT 0,
        gross     numeric(12,2) NOT NULL DEFAULT 0,
        employee_pension numeric(12,2) NOT NULL DEFAULT 0,
        employer_pension numeric(12,2) NOT NULL DEFAULT 0,
        net       numeric(12,2) NOT NULL DEFAULT 0,
        UNIQUE (run_id, staff_id)
      );
    $q$, o.schema_name);

    -- The grant is the other half of adding a table. See migration 014.
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
    -- A draft run is deleted when it is abandoned; a posted one never is.
    EXECUTE format('GRANT DELETE ON %I.payroll_run, %I.payroll_line TO %I',
                   o.schema_name, o.schema_name, o.db_role);
  END LOOP;
END $$;
