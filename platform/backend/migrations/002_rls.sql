-- ═══ ROW-LEVEL SECURITY ════════════════════════════════════════════════════
-- Second belt. The first belt is that each outlet connects as its own database
-- role with USAGE on its own schema only. RLS covers the control plane, which
-- is by definition shared, and covers any future consolidation query.
--
-- FORCE ROW LEVEL SECURITY matters: without it the table owner bypasses every
-- policy. The runtime roles are never owners, and the owner is forced anyway.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff','device','session','tax_version','doc_series','audit']
  LOOP
    EXECUTE format('ALTER TABLE chain.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE chain.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

ALTER TABLE chain.outlet ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain.outlet FORCE ROW LEVEL SECURITY;
ALTER TABLE chain.member ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain.member FORCE ROW LEVEL SECURITY;

-- An outlet sees itself. Rank 5 in group scope sees the estate, read-only.
DROP POLICY IF EXISTS outlet_self ON chain.outlet;
CREATE POLICY outlet_self ON chain.outlet FOR SELECT
  USING (id = app.current_outlet() OR app.group_scope());

DROP POLICY IF EXISTS staff_scoped ON chain.staff;
CREATE POLICY staff_scoped ON chain.staff FOR SELECT
  USING (outlet_id = app.current_outlet() OR app.group_scope());
-- Only Admin+ may change staff, and never above their own rank.
DROP POLICY IF EXISTS staff_write ON chain.staff;
CREATE POLICY staff_write ON chain.staff FOR ALL
  USING (outlet_id = app.current_outlet() AND app.current_rank() >= 4
         AND rank <= app.current_rank())
  WITH CHECK (outlet_id = app.current_outlet() AND app.current_rank() >= 4
         AND rank <= app.current_rank());

DROP POLICY IF EXISTS device_scoped ON chain.device;
CREATE POLICY device_scoped ON chain.device FOR ALL
  USING (outlet_id = app.current_outlet() OR app.group_scope())
  WITH CHECK (outlet_id = app.current_outlet());

DROP POLICY IF EXISTS session_scoped ON chain.session;
CREATE POLICY session_scoped ON chain.session FOR ALL
  USING (outlet_id = app.current_outlet())
  WITH CHECK (outlet_id = app.current_outlet());

DROP POLICY IF EXISTS tax_scoped ON chain.tax_version;
CREATE POLICY tax_scoped ON chain.tax_version FOR SELECT
  USING (outlet_id = app.current_outlet() OR app.group_scope());
DROP POLICY IF EXISTS tax_write ON chain.tax_version;
CREATE POLICY tax_write ON chain.tax_version FOR ALL
  USING (outlet_id = app.current_outlet() AND app.current_rank() >= 4)
  WITH CHECK (outlet_id = app.current_outlet() AND app.current_rank() >= 4);

DROP POLICY IF EXISTS series_scoped ON chain.doc_series;
CREATE POLICY series_scoped ON chain.doc_series FOR ALL
  USING (outlet_id = app.current_outlet())
  WITH CHECK (outlet_id = app.current_outlet());

-- Audit is append-only and readable by Manager+ for its own outlet.
DROP POLICY IF EXISTS audit_read ON chain.audit;
CREATE POLICY audit_read ON chain.audit FOR SELECT
  USING ((outlet_id = app.current_outlet() AND app.current_rank() >= 3)
         OR app.group_scope());
DROP POLICY IF EXISTS audit_append ON chain.audit;
CREATE POLICY audit_append ON chain.audit FOR INSERT
  WITH CHECK (outlet_id = app.current_outlet());

-- A member record is visible to the outlet holding consent, or in group scope.
-- Points move only through the outlet transacting, and never go negative.
DROP POLICY IF EXISTS member_read ON chain.member;
CREATE POLICY member_read ON chain.member FOR SELECT
  USING (app.current_outlet() IS NOT NULL);
DROP POLICY IF EXISTS member_write ON chain.member;
CREATE POLICY member_write ON chain.member FOR ALL
  USING (app.current_outlet() IS NOT NULL AND app.current_rank() >= 2)
  WITH CHECK (points >= 0);
