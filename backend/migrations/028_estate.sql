-- ═══════════════════════════════════════════════════════════════════════════
-- The estate: what an owner may see across the chain, and nothing more.
-- 08-BUILD-STAGES §25, 11-OWNER-DASHBOARD-SPEC.
--
-- THE SHAPE OF THIS FILE IS THE SECURITY MODEL. An owner's dashboard needs
-- revenue, cost, labour and a money position for every branch. There are two
-- ways to give it that, and only one of them is allowed here:
--
--   1. Widen a role until it can read every outlet's rows and add up the
--      answer in the application. That is a role which, on the day it is
--      misused, returns receipts.
--   2. Compute each figure INSIDE the outlet that owns it, and return only the
--      aggregate. A function that can only ever return sums cannot be talked
--      into returning a line.
--
-- So these are SECURITY DEFINER functions owned by the schema owner, each
-- gated on `app.group_scope()` — which itself requires connecting as
-- `kashikeyo_report` (migration 005), a role with no table grants at all. The
-- application never joins across outlets; it sums rows these functions have
-- already reduced.
--
-- The Owner Dashboard spec is explicit that no drill-through to another
-- outlet's receipts may be added. There is nothing to drill through to: no
-- function here returns an id of anything.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the targets a health score is measured against ─────────────────────────
--
-- 11-OWNER-DASHBOARD-SPEC §4: "The health score's weights belong in
-- configuration, not in code." So they are here, one row, editable at rank 5.
--
-- The two percentages the spec states outright (labour over 30%, prime over
-- 65%) are seeded as the initial configuration. The FOOD COST TARGET is left
-- NULL on purpose: the spec says "over target" without naming one, and a
-- restaurant's food cost target is a decision about its own menu — a fine
-- dining room runs 28% and a shawarma counter runs 40%, and neither is wrong.
-- Seeding a number nobody chose would be a hardcoded default masquerading as
-- the owner's own target (10-NO-DEMO-DATA.md). Unset means the score simply
-- does not deduct for food cost and the dashboard says so, which is a thing an
-- owner can act on. A wrong target is not.
CREATE TABLE IF NOT EXISTS chain.estate_target (
  only_row              boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  food_cost_target_pct  numeric(5,2) CHECK (food_cost_target_pct > 0
                                            AND food_cost_target_pct < 100),
  labour_target_pct     numeric(5,2) NOT NULL DEFAULT 30
                          CHECK (labour_target_pct > 0 AND labour_target_pct < 100),
  prime_target_pct      numeric(5,2) NOT NULL DEFAULT 65
                          CHECK (prime_target_pct > 0 AND prime_target_pct < 100),
  -- Deductions from 100, per the spec's own table. Numeric so a chain can
  -- decide a silent site matters more to it than a stock variance does.
  --
  -- Two of the spec's seven weights are not here. "Sync conflict" and
  -- "equipment down" are states this system does not record — see the note on
  -- chain.estate_alerts() below — and a weight for a condition that can never
  -- be true is a number in a settings screen that does nothing, which is worse
  -- than its absence. `w_sale_unjournalled` replaces them with a condition that
  -- IS real and matters more: money taken that never reached the ledger.
  w_food_over           numeric(6,2) NOT NULL DEFAULT 3,
  w_labour_over         numeric(6,2) NOT NULL DEFAULT 2,
  w_prime_over          numeric(6,2) NOT NULL DEFAULT 1.5,
  w_silent_site         numeric(6,2) NOT NULL DEFAULT 6,
  w_service_overdue     numeric(6,2) NOT NULL DEFAULT 5,
  w_house_over_limit    numeric(6,2) NOT NULL DEFAULT 3,
  w_sale_unjournalled   numeric(6,2) NOT NULL DEFAULT 8,
  set_by                uuid,
  set_at                timestamptz NOT NULL DEFAULT now()
);
INSERT INTO chain.estate_target (only_row) VALUES (true) ON CONFLICT DO NOTHING;

ALTER TABLE chain.estate_target ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain.estate_target FORCE ROW LEVEL SECURITY;

-- Readable by any outlet in session: a manager's own screens compare their
-- food cost against the same target the owner is judging them by, and a target
-- only the judge can see is not a target. Writable at rank 5 alone — it is the
-- yardstick, and a branch that can move its own yardstick has none.
--
-- Deliberately NOT readable by `kashikeyo_report`. The owner dashboard needs
-- both the targets and the estate aggregates, and the tempting thing is to
-- grant this one small table to the reporting role so it can be fetched in the
-- same round trip. That would cost the property this whole design rests on:
-- `kashikeyo_report` holds NO table grant of any kind, so a bug in it can leak
-- nothing but a sum. The owner is signed in at an outlet like everybody else —
-- the target is read on that connection, one extra query, and the reporting
-- role stays a role that can only call four functions.
DROP POLICY IF EXISTS estate_target_read ON chain.estate_target;
CREATE POLICY estate_target_read ON chain.estate_target FOR SELECT
  USING (app.current_outlet() IS NOT NULL);
DROP POLICY IF EXISTS estate_target_write ON chain.estate_target;
CREATE POLICY estate_target_write ON chain.estate_target FOR ALL
  USING (app.current_outlet() IS NOT NULL AND app.current_rank() >= 5)
  WITH CHECK (app.current_rank() >= 5);

-- A policy with no grant behind it never executes.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT db_role FROM chain.outlet LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON chain.estate_target TO %I', o.db_role);
  END LOOP;
END $$;

-- ── the day, per outlet ────────────────────────────────────────────────────
--
-- REPLACED rather than extended, and the return type changes, so it is dropped
-- first. Two things were wrong with the old shape:
--
--   · `covers` was `count(*)` — the number of BILLS, not the number of people.
--     `sale.covers` is right there. An estate table that reports 40 covers for
--     a lunch that fed 96 makes every per-head figure derived from it wrong,
--     and per-head spend is the one number a chain compares branches on.
--   · `sales` was `sum(total)`, which is tax-inclusive takings. The P&L's
--     revenue is goods net of tax and net of the discount. Calling both of them
--     "sales" is how the estate table and the P&L come to disagree by exactly
--     the GST for reasons nobody can see. Both are returned now, named for what
--     they are.
DROP FUNCTION IF EXISTS chain.estate_day(date);
CREATE FUNCTION chain.estate_day(p_date date)
RETURNS TABLE (outlet_id int, outlet text, code text,
               takings numeric, revenue numeric,
               covers bigint, bills bigint,
               cogs numeric, tax numeric, discount numeric, service numeric,
               last_sale_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE o record;
BEGIN
  IF NOT app.group_scope() THEN
    RAISE EXCEPTION 'estate reporting requires rank 5 in group scope';
  END IF;
  /* Qualified, because `code` is also the name of an OUT parameter above and
     an unqualified one is ambiguous to plpgsql — an error at CALL time, not at
     definition time, so it ships. */
  FOR o IN SELECT x.id, x.name, x.code, x.schema_name
             FROM chain.outlet x WHERE x.active ORDER BY x.id LOOP
    RETURN QUERY EXECUTE format(
      'SELECT $1, $2, $3,
              coalesce(sum(total),0), coalesce(sum(gross - discount),0),
              coalesce(sum(covers),0)::bigint, count(*)::bigint,
              coalesce(sum(cogs),0), coalesce(sum(tax),0),
              coalesce(sum(discount),0), coalesce(sum(service),0),
              max(at)
         FROM %I.sale WHERE business_date = $4 AND voided_at IS NULL',
      o.schema_name) USING o.id, o.name, o.code, p_date;
  END LOOP;
END $fn$;

-- ── the ledger, per outlet, reduced to account totals ──────────────────────
--
-- One row per outlet per account. This is what makes the owner's P&L the SAME
-- P&L the branch sees: the grouping into cost of sales, labour and overheads
-- happens once, in `backend/src/accounts.js`, over these balances — rather than
-- a second time in SQL here, where it would drift out of sight of the module
-- that owns the definition.
--
-- Sign convention matches reports.balances() exactly: an asset or expense
-- balance is dr − cr, a liability, equity or income balance is cr − dr. That is
-- what makes `4090 Discounts given` — income, dr-normal — come out negative and
-- reduce revenue instead of reading as a cost.
--
-- p_from NULL means "everything ever posted", which is what a balance-sheet
-- figure (cash in the drawer, GST held) needs. The P&L figures pass a range.
DROP FUNCTION IF EXISTS chain.estate_ledger(date, date);
CREATE FUNCTION chain.estate_ledger(p_from date, p_to date)
RETURNS TABLE (outlet_id int, code text, name text, type text,
               dr numeric, cr numeric, balance numeric)
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE o record;
BEGIN
  IF NOT app.group_scope() THEN
    RAISE EXCEPTION 'estate reporting requires rank 5 in group scope';
  END IF;
  FOR o IN SELECT x.id, x.schema_name FROM chain.outlet x WHERE x.active ORDER BY x.id LOOP
    RETURN QUERY EXECUTE format(
      'SELECT $1, a.code, a.name, a.type,
              coalesce(sum(l.dr),0), coalesce(sum(l.cr),0),
              CASE WHEN a.normal_side = ''dr''
                   THEN coalesce(sum(l.dr),0) - coalesce(sum(l.cr),0)
                   ELSE coalesce(sum(l.cr),0) - coalesce(sum(l.dr),0) END
         FROM %1$I.account a
         LEFT JOIN (
           SELECT l.account_code, l.dr, l.cr
             FROM %1$I.journal_line l JOIN %1$I.journal j ON j.id = l.journal_id
            WHERE ($2::date IS NULL OR j.entry_date >= $2::date)
              AND ($3::date IS NULL OR j.entry_date <= $3::date)
         ) l ON l.account_code = a.code
        GROUP BY a.code, a.name, a.type, a.normal_side
        HAVING coalesce(sum(l.dr),0) <> 0 OR coalesce(sum(l.cr),0) <> 0',
      o.schema_name) USING o.id, p_from, p_to;
  END LOOP;
END $fn$;

-- ── the trend: one row per outlet per trading day ──────────────────────────
--
-- Only days that actually traded come back. The dashboard draws fourteen
-- columns and needs to know which of them are empty — an absent row is a day
-- that did not trade, and a zero would be indistinguishable from a day that
-- took nothing while its doors were open. The spec's rule that growth is
-- suppressed when either week has no trading depends on being able to tell
-- those two apart.
DROP FUNCTION IF EXISTS chain.estate_series(date, date);
CREATE FUNCTION chain.estate_series(p_from date, p_to date)
RETURNS TABLE (business_date date, outlet_id int, revenue numeric,
               takings numeric, covers bigint)
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE o record;
BEGIN
  IF NOT app.group_scope() THEN
    RAISE EXCEPTION 'estate reporting requires rank 5 in group scope';
  END IF;
  FOR o IN SELECT x.id, x.schema_name FROM chain.outlet x WHERE x.active ORDER BY x.id LOOP
    RETURN QUERY EXECUTE format(
      'SELECT business_date, $1, coalesce(sum(gross - discount),0),
              coalesce(sum(total),0), coalesce(sum(covers),0)::bigint
         FROM %I.sale
        WHERE voided_at IS NULL AND business_date >= $2 AND business_date <= $3
        GROUP BY business_date',
      o.schema_name) USING o.id, p_from, p_to;
  END LOOP;
END $fn$;

-- ── the last business date that traded anywhere ────────────────────────────
--
-- §2 of the spec: "If today has not traded, the screen falls back to the last
-- business date that did and says so in the briefing chip — never silently."
-- Answered in one round trip rather than by the application walking backwards
-- a day at a time, which is fourteen queries on the morning of a public
-- holiday.
DROP FUNCTION IF EXISTS chain.estate_last_trading(date);
CREATE FUNCTION chain.estate_last_trading(p_on_or_before date)
RETURNS date
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE o record; d date; best date;
BEGIN
  IF NOT app.group_scope() THEN
    RAISE EXCEPTION 'estate reporting requires rank 5 in group scope';
  END IF;
  FOR o IN SELECT x.schema_name FROM chain.outlet x WHERE x.active LOOP
    EXECUTE format(
      'SELECT max(business_date) FROM %I.sale'
      || ' WHERE voided_at IS NULL AND business_date <= $1', o.schema_name)
      INTO d USING p_on_or_before;
    IF d IS NOT NULL AND (best IS NULL OR d > best) THEN best := d; END IF;
  END LOOP;
  RETURN best;
END $fn$;

-- ── the controls, as counts ────────────────────────────────────────────────
--
-- 11-OWNER-DASHBOARD-SPEC §3.6 and §3.7 want a "waiting on you" list and a set
-- of controls "checked, not claimed". Everything they need is operational
-- detail living inside each outlet — an overdue service, a house account past
-- its limit, a sale that never reached the ledger. None of it may cross the
-- boundary as rows.
--
-- So it crosses as COUNTS. The owner learns that Hulhumalé has three overdue
-- services and must open Hulhumalé to learn which three, which is exactly the
-- drill-through the spec forbids being built the other way round.
--
-- WHAT IS DELIBERATELY ABSENT. The spec's list also names "equipment down" and
-- "writes waiting to reach the cloud", and neither is a thing this system
-- knows:
--   · `asset.status` is active or disposed. There is no "down". Inventing one
--     here would mean an owner reading a number no screen can ever explain, so
--     what is reported is the SERVICE that is overdue, which is real.
--   · Unsynced writes live in the till's own outbox, on the device, which is
--     the entire point of them. A server that could count them would be a
--     server that already had them. The dashboard says so rather than showing
--     a confident zero — a zero that cannot be wrong is not a check.
DROP FUNCTION IF EXISTS chain.estate_alerts(date);
CREATE FUNCTION chain.estate_alerts(p_date date)
RETURNS TABLE (outlet_id int,
               services_overdue int,
               house_over_limit int, house_over_limit_value numeric,
               receipt_low bigint, receipt_high bigint, receipt_count bigint,
               sales_unjournalled int)
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE o record;
BEGIN
  IF NOT app.group_scope() THEN
    RAISE EXCEPTION 'estate reporting requires rank 5 in group scope';
  END IF;
  FOR o IN SELECT x.id, x.schema_name FROM chain.outlet x WHERE x.active
           ORDER BY x.id LOOP
    RETURN QUERY EXECUTE format(
      'SELECT $1,
         (SELECT count(*)::int FROM %1$I.asset_service s
            JOIN %1$I.asset a ON a.id = s.asset_id AND a.status = ''active''
           WHERE s.done_on IS NULL AND s.due_on < $2),
         /* A house account past the limit its own record carries. Balances are
            per outlet by design — a member owing money at two branches owes it
            to two sets of books — so this is counted inside each one. */
         (SELECT count(*)::int FROM (
            SELECT h.member_id, sum(
                     CASE WHEN h.kind IN (''charge'',''adjust'') THEN h.amount
                          ELSE -h.amount END) AS bal
              FROM %1$I.house_entry h GROUP BY h.member_id) b
            JOIN chain.member m ON m.id = b.member_id
           WHERE m.credit_limit IS NOT NULL AND m.credit_limit > 0
             AND b.bal > m.credit_limit),
         coalesce((SELECT sum(b.bal - m.credit_limit) FROM (
            SELECT h.member_id, sum(
                     CASE WHEN h.kind IN (''charge'',''adjust'') THEN h.amount
                          ELSE -h.amount END) AS bal
              FROM %1$I.house_entry h GROUP BY h.member_id) b
            JOIN chain.member m ON m.id = b.member_id
           WHERE m.credit_limit IS NOT NULL AND m.credit_limit > 0
             AND b.bal > m.credit_limit), 0),
         /* Receipt-series integrity: the lowest and highest number issued on
            the day and how many were issued. A run with a hole in it is a
            missing receipt, which is the first thing an inspection looks for.
            The number is the trailing digits of receipt_no — the prefix is the
            outlet''s own series code. */
         (SELECT min(substring(s.receipt_no from ''([0-9]+)$'')::bigint)
            FROM %1$I.sale s WHERE s.business_date = $2),
         (SELECT max(substring(s.receipt_no from ''([0-9]+)$'')::bigint)
            FROM %1$I.sale s WHERE s.business_date = $2),
         (SELECT count(*) FROM %1$I.sale s WHERE s.business_date = $2),
         /* A sale that took money and never reached the ledger. Zero is the
            only acceptable answer and it is worth asking every day. Voided
            sales are excluded: a void has its own reversal. */
         (SELECT count(*)::int FROM %1$I.sale s
           WHERE s.business_date = $2 AND s.voided_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM %1$I.journal j
                              WHERE j.source = ''sale'' AND j.source_id = s.id::text))',
      o.schema_name) USING o.id, p_date;
  END LOOP;
END $fn$;

-- ── the estate read writes itself into the audit trail ─────────────────────
--
-- 11-OWNER-DASHBOARD-SPEC §3.4 and 08-BUILD-STAGES' acceptance criterion: "the
-- audit log shows a group-scope read". It has to be written from the reporting
-- connection, because that is the connection that did the reading — an entry
-- written afterwards on the owner's outlet connection would be stamped
-- `scope = 'outlet'` by chain.log(), since group scope is false there. A trail
-- that records the one cross-outlet read in the system as an ordinary local one
-- is worse than no trail: it is a trail that will be believed.
--
-- SECURITY DEFINER because `kashikeyo_report` holds no INSERT on chain.audit
-- and is never going to. The actor and the outlet come from the same
-- transaction-local settings `withEstate` already sets.
DROP FUNCTION IF EXISTS chain.log_estate_read(date);
CREATE FUNCTION chain.log_estate_read(p_date date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  IF NOT app.group_scope() THEN
    RAISE EXCEPTION 'estate reporting requires rank 5 in group scope';
  END IF;
  INSERT INTO chain.audit (outlet_id, actor, rank, action, entity, entity_id, scope)
  VALUES (app.current_outlet(), app.current_actor(), app.current_rank(),
          'estate_read', 'estate', p_date::text, 'group');
END $fn$;
