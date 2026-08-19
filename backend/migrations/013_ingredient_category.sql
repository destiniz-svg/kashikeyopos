-- ═══ INGREDIENTS BELONG SOMEWHERE ══════════════════════════════════════════
--
-- 02-POS-SPEC.md §2 (`counts`): "Count sheets BY CATEGORY". Nobody counts a
-- whole store in one go — somebody counts the freezer, somebody else counts the
-- bar, and each wants a sheet with their shelves on it and nothing else. A
-- count sheet listing all 400 lines is a sheet that gets half filled in.
--
-- Nullable, with no default and no seeded vocabulary: the categories a kitchen
-- uses are the kitchen's own words, and a list invented here would be one more
-- thing to fight. Uncategorised ingredients are a first-class state and appear
-- on every sheet, because an item nobody has filed still has to be counted.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name FROM chain.outlet LOOP
    EXECUTE format('ALTER TABLE %I.ingredient ADD COLUMN IF NOT EXISTS category text',
                   o.schema_name);
  END LOOP;
END $$;
