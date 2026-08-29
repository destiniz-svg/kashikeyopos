/* ═══ 049 · A SECTION WEARS ITS KIND, NOT ITS EXTRACTION ═════════════════════
   The section artifact — the glyph and the hue a dish's tile is composed
   from — is classified from the section's NAME now (sectionArt() in
   app/kashikeyo-data.js): every drinks rail wears the glass, every curry
   section the bowl, in the same hue at the till, on the guest's phone and on
   the member card. An icon or colour a person picked in the section editor
   always wins over that classification; NULL is "nobody has chosen", and
   only NULL classifies.

   Which is exactly why existing rows need this repair. The pre-set menu was
   EXTRACTED from a live outlet's tables, and the extraction carried whatever
   the CSV import's defaults had landed there — most visibly "Breakfast &
   Maldivian Specialties" wearing the SALAD glyph, and "Mains & Curries"
   wearing generic cutlery. Those values were written by a machine, not
   picked by a person, but they are non-NULL, so they would override the
   classification for ever on every store that loaded the pre-set.

   So: the exact (id, value) pairs the pre-set provably wrote are reset to
   NULL — and ONLY those. A row whose icon or colour differs from what the
   pre-set wrote was changed by somebody, and their choice stands untouched.
   `var(--cat-mains)` is also a till THEME TOKEN that rode into a colour
   column; published to a phone it resolves to nothing, so it goes with the
   rest. Idempotent: a repaired row no longer matches the pairs. */
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'outlet\_%' LOOP
    EXECUTE format(
      'UPDATE %I.menu_category SET icon = NULL WHERE (id, icon) IN ('
      || '(''breakfast'',''salad''),(''shorteats'',''starter''),'
      || '(''mains'',''main''),(''rice'',''rice''),(''western'',''grill''),'
      || '(''sides'',''side''),(''desserts'',''dessert''),'
      || '(''hotdrinks'',''coffee''),(''colddrinks'',''drink''))', s);
    EXECUTE format(
      'UPDATE %I.menu_category SET colour = NULL WHERE (id, colour) IN ('
      || '(''shorteats'',''#b7791f''),(''mains'',''var(--cat-mains)''))', s);
    /* Two more shapes only a machine ever wrote. ensureSection() used to
       stamp every auto-created section with its own ID as the icon and the
       rail's RESOLVED colour — so a section called "import-corner" carries
       icon ''import-corner'', which matches no glyph and renders as generic
       cutlery for ever. An icon that is the row's own id and names no glyph
       was never picked by anybody (the picker only offers glyph keys). And a
       `var(--…)` colour is a till THEME TOKEN — the editor's swatches are
       hexes, so no person ever chose one, and published to a phone it
       resolves to nothing. */
    EXECUTE format(
      'UPDATE %I.menu_category SET icon = NULL WHERE icon = id AND icon NOT IN ('
      || '''all'',''starter'',''main'',''grill'',''rice'',''side'',''dessert'','
      || '''drink'',''soup'',''salad'',''seafood'',''coffee'','
      || '''curry'',''breakfast'',''burger'',''noodles'',''juice'')', s);
    EXECUTE format(
      'UPDATE %I.menu_category SET colour = NULL WHERE colour LIKE ''var(%%''', s);
  END LOOP;
END $$;
