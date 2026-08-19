-- Replacing a recipe means removing the lines that are no longer in it, and
-- provisioning granted SELECT/INSERT/UPDATE and no DELETE anywhere — so saving
-- a recipe died with "permission denied for table recipe_line".
--
-- Granting it here is deliberate and narrow. A recipe line is CURRENT
-- CONFIGURATION, not a financial record: what a dish is made of today. Its
-- history is kept where history belongs, in chain.audit, which records the
-- whole before and after set on every save. The financial tables keep their
-- revoke — a sale, a payment, a journal line and an op_log entry are corrected
-- by a further entry, never erased.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name, db_role FROM chain.outlet LOOP
    EXECUTE format('GRANT DELETE ON %I.recipe_line TO %I', o.schema_name, o.db_role);
  END LOOP;
END $$;
