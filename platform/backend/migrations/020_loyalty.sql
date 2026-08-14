-- ═══ LOYALTY & REWARDS ═════════════════════════════════════════════════════
--
-- 02-POS-SPEC.md §2 (`loyalty`): "Earn rate, tier ladder, reward catalogue.
-- Points are a liability (account 2200)." 08-BUILD-STAGES §24.
-- 04-MEMBER-PORTAL-SPEC.md §6: "Points are a liability, not a discount.
-- Earning credits 2200; redeeming debits it. The P&L never sees a point."
--
-- 2200 Loyalty liability is the last account in the chart with nothing able to
-- reach it. `points` has been a valid tender mapping to 2200 since the sale
-- journal was written, and until now nothing could put a point there to spend.
--
-- CONFIGURATION IS CHAIN-WIDE, not per outlet, and that is the whole point of a
-- chain scheme: a member earns at one branch and spends at another, so two
-- branches on different earn rates would be two schemes wearing one name. It
-- lives in a single-row table in `chain` rather than on chain.outlet for
-- exactly that reason.
--
-- A ZERO EARN RATE MEANS THE SCHEME IS NOT RUNNING. There is no default rate,
-- because inventing one would have every restaurant that installed this
-- silently accruing a liability nobody agreed to. The screen says the scheme is
-- off until somebody sets a rate.
--
-- 4095 LOYALTY EARNED is new, and it is a contra-income account beside 4090
-- Discounts given rather than the same one. A point accrued and a discount
-- given at the counter are both giveaways, but blending them makes each
-- unanalysable — "what did we give away, and to whom, and did it come back?"
-- has two different answers.

-- Added to chain.seed_chart itself rather than to a second function, so a
-- freshly provisioned outlet and a patched one end up with the same chart.
-- This is the fifth migration to restate the whole list; the drift it invites
-- is now caught by a test that walks every account code the CODE references and
-- requires it to exist in a newly seeded outlet.
CREATE OR REPLACE FUNCTION chain.seed_chart(p_schema text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  EXECUTE format($q$
    INSERT INTO %1$I.account (code, name, type, normal_side) VALUES
      ('1000','Cash in drawer','asset','dr'),
      ('1010','Bank','asset','dr'),
      ('1020','Card receivable','asset','dr'),
      ('1030','Customer receivable','asset','dr'),
      ('1100','Inventory - food','asset','dr'),
      ('1110','Inventory - beverage','asset','dr'),
      ('1200','Prepaid expenses','asset','dr'),
      ('1500','Equipment','asset','dr'),
      ('1510','Accumulated depreciation','asset','cr'),
      ('2000','Accounts payable','liability','cr'),
      ('2100','GST payable','liability','cr'),
      ('2110','Service charge payable','liability','cr'),
      ('2120','Tips payable','liability','cr'),
      ('2200','Loyalty liability','liability','cr'),
      ('2300','Payroll payable','liability','cr'),
      ('2310','Pension payable','liability','cr'),
      ('3000','Owner equity','equity','cr'),
      ('3100','Retained earnings','equity','cr'),
      ('4000','Food sales','income','cr'),
      ('4010','Beverage sales','income','cr'),
      ('4090','Discounts given','income','dr'),
      ('4095','Loyalty earned','income','dr'),
      ('5000','Food cost','expense','dr'),
      ('5010','Beverage cost','expense','dr'),
      ('5100','Stock variance','expense','dr'),
      ('6000','Wages','expense','dr'),
      ('6010','Staff benefits','expense','dr'),
      ('6100','Rent','expense','dr'),
      ('6110','Utilities','expense','dr'),
      ('6120','Marketing','expense','dr'),
      ('6130','Travel','expense','dr'),
      ('6140','Uniforms','expense','dr'),
      ('6150','Pest control','expense','dr'),
      ('6160','Packaging','expense','dr'),
      ('6170','Aggregator commission','expense','dr'),
      ('6180','Card fees','expense','dr'),
      ('6190','Repairs','expense','dr'),
      ('6200','Licences','expense','dr'),
      ('6300','Depreciation','expense','dr'),
      ('6310','Gain or loss on disposal','expense','dr'),
      ('6400','Bad debt','expense','dr'),
      ('6900','FX gain or loss','expense','dr'),
      ('6910','Cash rounding','expense','dr'),
      ('6920','Cash over or short','expense','dr')
    ON CONFLICT (code) DO NOTHING
  $q$, p_schema);
END $fn$;

DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^outlet_[0-9]+$'
  LOOP
    PERFORM chain.seed_chart(s);
  END LOOP;
END $$;

-- ── the scheme itself: one row, chain-wide ─────────────────────────────────
CREATE TABLE IF NOT EXISTS chain.loyalty (
  -- A single row, enforced by the primary key rather than by convention.
  only_row      boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  -- Points earned per MVR of goods. Nought = the scheme is off.
  earn_per_mvr  numeric(8,4) NOT NULL DEFAULT 0 CHECK (earn_per_mvr >= 0),
  -- What a point is worth in MVR when it is spent. This is the number that
  -- makes points a LIABILITY: it is what the business has promised to honour.
  point_value   numeric(8,4) NOT NULL DEFAULT 0 CHECK (point_value >= 0),
  -- [{name, points}] — the ladder, ascending. Never a hardcoded threshold:
  -- 04-MEMBER-PORTAL-SPEC §2 requires the portal to read it from here.
  tiers         jsonb NOT NULL DEFAULT '[]',
  set_by        uuid,
  set_at        timestamptz NOT NULL DEFAULT now()
);
INSERT INTO chain.loyalty (only_row) VALUES (true) ON CONFLICT DO NOTHING;

-- ── what points can buy ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chain.reward (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name     text NOT NULL,
  points   int NOT NULL CHECK (points > 0),
  -- What it is worth in MVR, so redeeming it debits the liability by what the
  -- business actually gives up rather than by a number somebody typed.
  value    numeric(12,2) NOT NULL CHECK (value > 0),
  active   boolean NOT NULL DEFAULT true,
  set_by   uuid, set_at timestamptz NOT NULL DEFAULT now()
);

-- ── every point that ever moved ────────────────────────────────────────────
--
-- Immutable and signed, like stock_move and house_entry. `chain.member.points`
-- is a CACHE of the sum; this is the truth, and it records which outlet the
-- points moved at — because the money side of them lands in that outlet's own
-- 2200, and a chain scheme means those two outlets need not be the same one.
CREATE TABLE IF NOT EXISTS chain.point_entry (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  member_id uuid NOT NULL REFERENCES chain.member(id),
  outlet_id int NOT NULL REFERENCES chain.outlet(id),
  kind      text NOT NULL CHECK (kind IN ('earn','redeem','adjust','expire')),
  points    numeric(12,2) NOT NULL CHECK (points <> 0),
  -- The MVR the liability moved by, so the ledger and the points can be
  -- reconciled against each other rather than trusted to agree.
  value     numeric(12,2) NOT NULL DEFAULT 0,
  sale_id   uuid,
  note      text,
  by_staff  uuid
);
CREATE INDEX IF NOT EXISTS point_member ON chain.point_entry (member_id, at DESC);
CREATE INDEX IF NOT EXISTS point_outlet ON chain.point_entry (outlet_id, at DESC);

-- ── RLS: never a table in `chain` without a policy ─────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['loyalty','reward','point_entry']
  LOOP
    EXECUTE format('ALTER TABLE chain.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE chain.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- The scheme is readable by any outlet in session — the till needs the earn
-- rate to tell a guest what they earned. Changing it is ADMIN: an earn rate is
-- a standing promise to every member of the chain, not a shift decision.
DROP POLICY IF EXISTS loyalty_read ON chain.loyalty;
CREATE POLICY loyalty_read ON chain.loyalty FOR SELECT
  USING (app.current_outlet() IS NOT NULL);
DROP POLICY IF EXISTS loyalty_write ON chain.loyalty;
CREATE POLICY loyalty_write ON chain.loyalty FOR ALL
  USING (app.current_outlet() IS NOT NULL AND app.current_rank() >= 4)
  WITH CHECK (app.current_rank() >= 4);

DROP POLICY IF EXISTS reward_read ON chain.reward;
CREATE POLICY reward_read ON chain.reward FOR SELECT
  USING (app.current_outlet() IS NOT NULL);
DROP POLICY IF EXISTS reward_write ON chain.reward;
CREATE POLICY reward_write ON chain.reward FOR ALL
  USING (app.current_outlet() IS NOT NULL AND app.current_rank() >= 4)
  WITH CHECK (app.current_rank() >= 4);

-- A member's points are chain-wide and so is their history — that is the point
-- of the scheme. Writing one is pinned to the outlet in session, so an entry
-- can never be booked against a branch the session is not at.
DROP POLICY IF EXISTS point_read ON chain.point_entry;
CREATE POLICY point_read ON chain.point_entry FOR SELECT
  USING (app.current_outlet() IS NOT NULL);
DROP POLICY IF EXISTS point_write ON chain.point_entry;
CREATE POLICY point_write ON chain.point_entry FOR INSERT
  WITH CHECK (outlet_id = app.current_outlet() AND app.current_rank() >= 2);

-- ── grants. A policy with no grant behind it never executes ────────────────
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT db_role FROM chain.outlet LOOP
    EXECUTE format('GRANT SELECT ON chain.loyalty, chain.reward TO %I', o.db_role);
    EXECUTE format('GRANT INSERT, UPDATE ON chain.loyalty TO %I', o.db_role);
    EXECUTE format('GRANT INSERT, UPDATE, DELETE ON chain.reward TO %I', o.db_role);
    -- Never UPDATE or DELETE on the ledger: a point that moved, moved.
    EXECUTE format('GRANT SELECT, INSERT ON chain.point_entry TO %I', o.db_role);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE chain.point_entry_id_seq TO %I',
                   o.db_role);
  END LOOP;
END $$;
