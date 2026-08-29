/* ═══ 050 · A PERSON HAS A FACE, AND THE ROW IS WHERE IT LIVES ═══════════════
   The employee form has collected a photograph and a sex (the silhouette's
   gender) since People & Payroll was built, and NEITHER had anywhere to go:
   no column, not in the employee_upsert payload, and the bootstrap published
   a literal photo: '' — so the photo lived in one browser's collection copy
   and every bootstrap wiped it. Worse, the field asked for a "Photo URL",
   which the page's own CSP refuses and nobody has for a colleague anyway;
   the form takes an UPLOAD now (scaled on the device, a data URL), and these
   columns are where it lands. Both nullable: every existing row was asked
   for neither, and a silhouette is the honest default. */
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'outlet\_%' LOOP
    EXECUTE format('ALTER TABLE %I.employee ADD COLUMN IF NOT EXISTS photo text', s);
    EXECUTE format('ALTER TABLE %I.employee ADD COLUMN IF NOT EXISTS sex text', s);
  END LOOP;
END $$;
