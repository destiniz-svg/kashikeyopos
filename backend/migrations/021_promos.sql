-- ═══ PROMOTIONS ════════════════════════════════════════════════════════════
--
-- 02-POS-SPEC.md §2 (`promos`): "Codes, windows, caps. A promo the guest sees
-- is a promo the till charges." 08-BUILD-STAGES §16, and its acceptance
-- criterion: "A promo quoted on the phone is charged by the till, or refused
-- with a reason — never quoted and then silently dropped."
--
-- That criterion is currently failed outright. The guest portal has a promo
-- code field; the code is stored on guest_order.promo and read by nothing. A
-- guest types SAVE20, sees it accepted, and pays full price.
--
-- THE OTHER HALF IS WORSE AND IS NOT IN THE SPEC. `sale.discount` is whatever
-- number the client sends. Any till session can settle a 900-rufiyaa bill with
-- a 900-rufiyaa discount and a reason it made up, and the sale is
-- self-consistent, balances, and posts to 4090 like any other. A promo module
-- that did not close that would be a lock on a door with no wall.
--
-- A PROMO IS CHAIN-WIDE BY DEFAULT because a code printed on a flyer works
-- wherever the guest walks in, with `outlet_id` set when it does not.

CREATE TABLE IF NOT EXISTS chain.promo (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored upper-case and compared upper-case: a guest typing save20 on a
  -- phone keyboard has not typed a different promotion.
  code      text NOT NULL UNIQUE CHECK (code = upper(code) AND length(code) BETWEEN 2 AND 24),
  name      text NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('percent', 'amount')),
  -- Percent in basis points (2000 = 20%), or an amount in MVR. One column, one
  -- meaning per kind, so a 20 can never be read as 20% by one caller and 20
  -- rufiyaa by another.
  value     numeric(12,2) NOT NULL CHECK (value > 0),

  -- ── the caps ────────────────────────────────────────────────────────────
  min_spend numeric(12,2) NOT NULL DEFAULT 0 CHECK (min_spend >= 0),
  -- The most this promo can ever take off ONE bill. Without it, "20% off" on a
  -- party of thirty is a number nobody signed off.
  max_discount numeric(12,2) CHECK (max_discount IS NULL OR max_discount > 0),
  max_uses  int CHECK (max_uses IS NULL OR max_uses > 0),
  max_per_member int CHECK (max_per_member IS NULL OR max_per_member > 0),

  -- ── the window ──────────────────────────────────────────────────────────
  starts_on date,
  ends_on   date,
  -- 0 = Sunday … 6 = Saturday. Empty means every day.
  days      int[] NOT NULL DEFAULT '{}',
  -- Minutes from midnight, so a happy hour is 1020–1260 rather than two
  -- timestamps that would need a date to mean anything.
  from_min  int CHECK (from_min IS NULL OR (from_min >= 0 AND from_min < 1440)),
  to_min    int CHECK (to_min IS NULL OR (to_min > 0 AND to_min <= 1440)),

  outlet_id int REFERENCES chain.outlet(id),
  members_only boolean NOT NULL DEFAULT false,
  active    boolean NOT NULL DEFAULT true,
  set_by    uuid, set_at timestamptz NOT NULL DEFAULT now()
);

-- Every time a promo was actually honoured. Append-only: this is what the caps
-- are counted from, and a cap counted from a mutable number is not a cap.
CREATE TABLE IF NOT EXISTS chain.promo_use (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  promo_id  uuid NOT NULL REFERENCES chain.promo(id),
  outlet_id int NOT NULL REFERENCES chain.outlet(id),
  member_id uuid,
  sale_id   uuid,
  amount    numeric(12,2) NOT NULL CHECK (amount > 0),
  by_staff  uuid
);
CREATE INDEX IF NOT EXISTS promo_use_promo ON chain.promo_use (promo_id);
CREATE INDEX IF NOT EXISTS promo_use_member ON chain.promo_use (member_id, promo_id);

-- ── RLS: never a table in `chain` without a policy ─────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['promo','promo_use']
  LOOP
    EXECUTE format('ALTER TABLE chain.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE chain.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Readable by any outlet in session — including at RANK 0, because a guest
-- phone quoting a code is a rank-0 token and the whole point is that the phone
-- and the till get the same answer from the same evaluator.
DROP POLICY IF EXISTS promo_read ON chain.promo;
CREATE POLICY promo_read ON chain.promo FOR SELECT
  USING (app.current_outlet() IS NOT NULL
         AND (outlet_id IS NULL OR outlet_id = app.current_outlet()));
DROP POLICY IF EXISTS promo_write ON chain.promo;
CREATE POLICY promo_write ON chain.promo FOR ALL
  USING (app.current_outlet() IS NOT NULL AND app.current_rank() >= 4)
  WITH CHECK (app.current_rank() >= 4);

DROP POLICY IF EXISTS promo_use_read ON chain.promo_use;
CREATE POLICY promo_use_read ON chain.promo_use FOR SELECT
  USING (app.current_outlet() IS NOT NULL);
-- Recorded by the sale that honoured it, pinned to the outlet in session.
DROP POLICY IF EXISTS promo_use_write ON chain.promo_use;
CREATE POLICY promo_use_write ON chain.promo_use FOR INSERT
  WITH CHECK (outlet_id = app.current_outlet());

-- ── grants. A policy with no grant behind it never executes ────────────────
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT db_role FROM chain.outlet LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON chain.promo TO %I', o.db_role);
    -- Never UPDATE or DELETE on the uses: a cap counted from a mutable ledger
    -- is not a cap.
    EXECUTE format('GRANT SELECT, INSERT ON chain.promo_use TO %I', o.db_role);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE chain.promo_use_id_seq TO %I',
                   o.db_role);
  END LOOP;
END $$;

-- ── how much a cashier may take off by hand ────────────────────────────────
--
-- Separate from promos and deliberately so. An open discount is a judgement
-- call — a burnt steak, a regular, an apology — and it needs a person's rank
-- behind it rather than a rule. Nought is not "no discounts": it is the safe
-- default that says nobody has decided yet, and until somebody does, the only
-- discount that goes through is one a promo authorised.
ALTER TABLE chain.outlet
  ADD COLUMN IF NOT EXISTS max_open_discount numeric(12,2) NOT NULL DEFAULT 0;
