-- ═══ ROW-LEVEL SECURITY ════════════════════════════════════════════════════
-- The second belt. The first is that each outlet connects as its own database
-- role with USAGE on its own schema only; RLS covers the control plane, which
-- is by definition shared.
--
-- FORCE ROW LEVEL SECURITY matters: without it the table owner bypasses every
-- policy, and migrations run as the owner. Never add a table to `chain`
-- without a policy — an unpoliced table with RLS enabled denies everything,
-- and an unenabled one leaks everything.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company','outlet','staff','device','session',
                           'tax_version','doc_series','member','supplier',
                           'setting','audit']
  LOOP
    EXECUTE format('ALTER TABLE chain.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE chain.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- The legal entity is one row and every outlet needs it on its receipts.
-- Only Admin+ may change it.
DROP POLICY IF EXISTS company_read ON chain.company;
CREATE POLICY company_read ON chain.company FOR SELECT
  USING (app.current_outlet() IS NOT NULL);
DROP POLICY IF EXISTS company_write ON chain.company;
CREATE POLICY company_write ON chain.company FOR ALL
  USING (app.current_rank() >= 4) WITH CHECK (app.current_rank() >= 4);

-- An outlet sees itself and its own sub-locations. Rank 5 in group scope sees
-- the estate, read-only.
DROP POLICY IF EXISTS outlet_self ON chain.outlet;
CREATE POLICY outlet_self ON chain.outlet FOR SELECT
  USING (id = app.current_outlet() OR parent_id = app.current_outlet()
         OR app.group_scope());
DROP POLICY IF EXISTS outlet_write ON chain.outlet;
CREATE POLICY outlet_write ON chain.outlet FOR UPDATE
  USING (id = app.current_outlet() AND app.current_rank() >= 4)
  WITH CHECK (id = app.current_outlet() AND app.current_rank() >= 4);

-- Staff: readable by their own outlet, writable by Admin+, and never above the
-- writer's own rank — a rank-4 admin cannot mint a rank-5 owner.
DROP POLICY IF EXISTS staff_scoped ON chain.staff;
CREATE POLICY staff_scoped ON chain.staff FOR SELECT
  USING (outlet_id = app.current_outlet()
         OR app.current_outlet() = ANY (outlets)
         OR app.group_scope());
DROP POLICY IF EXISTS staff_write ON chain.staff;
CREATE POLICY staff_write ON chain.staff FOR ALL
  USING (outlet_id = app.current_outlet() AND app.current_rank() >= 4
         AND rank <= app.current_rank())
  WITH CHECK (outlet_id = app.current_outlet() AND app.current_rank() >= 4
         AND rank <= app.current_rank());
-- Sign-in has to read a PIN hash before a rank exists, and has to reset the
-- failure counter afterwards. Both go through SECURITY DEFINER functions
-- (005_auth.sql) rather than a policy hole in this table.

DROP POLICY IF EXISTS device_scoped ON chain.device;
CREATE POLICY device_scoped ON chain.device FOR ALL
  USING (outlet_id = app.current_outlet() OR app.group_scope())
  WITH CHECK (outlet_id = app.current_outlet());

DROP POLICY IF EXISTS session_scoped ON chain.session;
CREATE POLICY session_scoped ON chain.session FOR ALL
  USING (outlet_id = app.current_outlet())
  WITH CHECK (outlet_id = app.current_outlet());

-- Statutory tax history (outlet_id NULL) is readable everywhere; an outlet's
-- own versions are its own, and only Admin+ may add one.
DROP POLICY IF EXISTS tax_scoped ON chain.tax_version;
CREATE POLICY tax_scoped ON chain.tax_version FOR SELECT
  USING (outlet_id IS NULL OR outlet_id = app.current_outlet() OR app.group_scope());
DROP POLICY IF EXISTS tax_write ON chain.tax_version;
CREATE POLICY tax_write ON chain.tax_version FOR ALL
  USING (outlet_id = app.current_outlet() AND app.current_rank() >= 4)
  WITH CHECK (outlet_id = app.current_outlet() AND app.current_rank() >= 4);

DROP POLICY IF EXISTS series_scoped ON chain.doc_series;
CREATE POLICY series_scoped ON chain.doc_series FOR ALL
  USING (outlet_id = app.current_outlet())
  WITH CHECK (outlet_id = app.current_outlet());

-- A member record is visible to any outlet transacting (loyalty is chain-wide
-- by design), writable from Till rank up, and points can never go negative.
DROP POLICY IF EXISTS member_read ON chain.member;
CREATE POLICY member_read ON chain.member FOR SELECT
  USING (app.current_outlet() IS NOT NULL);
DROP POLICY IF EXISTS member_write ON chain.member;
CREATE POLICY member_write ON chain.member FOR ALL
  USING (app.current_outlet() IS NOT NULL AND app.current_rank() >= 2)
  WITH CHECK (app.current_outlet() IS NOT NULL AND app.current_rank() >= 2
              AND points >= 0);

DROP POLICY IF EXISTS supplier_read ON chain.supplier;
CREATE POLICY supplier_read ON chain.supplier FOR SELECT
  USING (app.current_outlet() IS NOT NULL);
DROP POLICY IF EXISTS supplier_write ON chain.supplier;
CREATE POLICY supplier_write ON chain.supplier FOR ALL
  USING (app.current_rank() >= 3) WITH CHECK (app.current_rank() >= 3);

DROP POLICY IF EXISTS setting_read ON chain.setting;
CREATE POLICY setting_read ON chain.setting FOR SELECT
  USING (app.current_outlet() IS NOT NULL);
DROP POLICY IF EXISTS setting_write ON chain.setting;
CREATE POLICY setting_write ON chain.setting FOR ALL
  USING (app.current_rank() >= 4) WITH CHECK (app.current_rank() >= 4);

-- Audit is append-only and readable by Manager+ for its own outlet. There is
-- deliberately no UPDATE or DELETE policy: a trail that can be edited is not
-- a trail.
DROP POLICY IF EXISTS audit_read ON chain.audit;
CREATE POLICY audit_read ON chain.audit FOR SELECT
  USING ((outlet_id = app.current_outlet() AND app.current_rank() >= 3)
         OR app.group_scope());
DROP POLICY IF EXISTS audit_append ON chain.audit;
CREATE POLICY audit_append ON chain.audit FOR INSERT
  WITH CHECK (outlet_id = app.current_outlet());
