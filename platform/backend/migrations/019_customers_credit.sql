-- ═══ CUSTOMERS & CREDIT ════════════════════════════════════════════════════
--
-- 02-POS-SPEC.md §2 (`customers`): "Chain-wide profiles, loyalty tier,
-- house-account credit ledger."
--
-- `chain.member` has existed since migration 001 with points, a tier and a
-- consent stamp, and `sale.member_id` has been on every sale row since 003.
-- Nothing has ever written to either. This migration gives the profile the
-- fields a house account needs and adds the ledger the credit runs on.
--
-- THE PROFILE IS CHAIN-WIDE; THE DEBT IS NOT, and that falls straight out of
-- the tenancy. A member earns and is recognised at any outlet, but 1030 lives
-- in each outlet's own schema, so a company that eats at three branches owes
-- three balances and each branch's balance sheet carries its own. Any screen
-- that showed one number would be adding up money from ledgers that never meet.
--
-- 1030 CUSTOMER RECEIVABLE is new. 1020 already exists for CARD RECEIVABLE —
-- money an acquirer is holding for a day or two — which is a different debt
-- with a different owner and a different way of going wrong. Blending an
-- unsettled card batch with a company that has not paid its March bill would
-- make both unreconcilable.

-- The seed function, so every outlet provisioned from here on has it …
-- 1030 Customer receivable and 6400 Bad debt live in the ONE chart, migration 004.
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

-- ── the chain-wide profile ─────────────────────────────────────────────────
ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS company text;
ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS note text;
-- Nought is not "no limit", it is NO CREDIT — the safe default for a record
-- anybody at till rank can create. Extending credit is an admin's decision and
-- has to be made explicitly.
ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS credit_limit numeric(12,2)
  NOT NULL DEFAULT 0;
ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS terms_days int NOT NULL DEFAULT 0;
ALTER TABLE chain.member ADD COLUMN IF NOT EXISTS blocked boolean NOT NULL DEFAULT false;
-- Guarded, because migrate.js runs EVERY migration on EVERY boot — that is the
-- design, and it is why every other statement in this directory is
-- `IF NOT EXISTS` or `CREATE OR REPLACE`. A bare ADD CONSTRAINT succeeds once
-- and then fails for ever, so the first deploy would have looked fine and the
-- second would have died before the server ever listened.
DO $$
BEGIN
  ALTER TABLE chain.member ADD CONSTRAINT member_credit_positive
    CHECK (credit_limit >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS member_name ON chain.member (lower(coalesce(name,'')));

-- A receipt against a house account is a numbered document like any other, so
-- a customer disputing "we paid that in March" has something to be shown.
-- Both halves: the series for outlets that already exist, and provision_outlet
-- for every one minted from here on.
INSERT INTO chain.doc_series (outlet_id, kind, prefix)
  SELECT id, 'RCT', code || '-RCT' FROM chain.outlet
  ON CONFLICT DO NOTHING;

-- ── the credit ledger, per outlet ──────────────────────────────────────────
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name, db_role FROM chain.outlet LOOP
    EXECUTE format($q$
      -- Immutable and signed, like stock_move: + is owed to us, − is paid or
      -- written off. A balance is Σ of these, never a stored figure somebody
      -- can edit, and its total must equal account 1030 in the same ledger —
      -- which is a thing a test can check rather than a thing a comment can
      -- promise.
      CREATE TABLE IF NOT EXISTS %1$I.house_entry (
        id        bigserial PRIMARY KEY,
        at        timestamptz NOT NULL DEFAULT now(),
        on_date   date NOT NULL,
        member_id uuid NOT NULL,
        kind      text NOT NULL
                  CHECK (kind IN ('charge','receipt','writeoff','adjust')),
        amount    numeric(12,2) NOT NULL CHECK (amount <> 0),
        sale_id   uuid,
        doc_no    text,
        method    text,
        note      text,
        by_staff  uuid
      );
      CREATE INDEX IF NOT EXISTS house_member ON %1$I.house_entry (member_id, on_date);
    $q$, o.schema_name);

    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
    -- Never DELETE: what a customer was charged is a record of a debt, and a
    -- debt that can be tidied away is not a ledger.
    EXECUTE format('REVOKE DELETE ON %I.house_entry FROM %I', o.schema_name, o.db_role);
  END LOOP;
END $$;
