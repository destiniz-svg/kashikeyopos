-- ═══ A MENU SECTION IS THE OUTLET'S, NOT ONE BROWSER'S ══════════════════════
-- The till's section editor collects five things — name, colour, glyph, the
-- station its dishes fire to, and whether it shows on the menu at all. Exactly
-- one of them has ever reached the outlet, and only when the section was
-- created: `menu_category` has held `id`, `name`, `section_id`, `pos` and
-- `colour` since 003, and the other four lived in `state.catMeta`, which is one
-- browser's localStorage.
--
-- So two tills at one counter drew the same section in two colours under two
-- glyphs, a section hidden on the manager's tablet was still on the rail at the
-- counter, and a dish created on either one inherited a DIFFERENT default
-- station — which decides where the KOT prints and which pass the KDS files it
-- under. Clearing a browser's storage reverted all five to a guess.
--
-- WORSE, AND THIS IS WHAT WAS REPORTED FROM A LIVE STORE: creating a section
-- reached the outlet never at all. Three call sites queued three different op
-- kinds and every one of them was queued WITH NO PAYLOAD — `queue(kind, label,
-- entity)` against a signature of `(kind, label, entity, payload)` — and one of
-- the three named `menu_section`, a different table from the `menu_category`
-- the bootstrap actually publishes and `item.category_id` actually references.
-- The server refused each for want of a name, the toast said "Section created",
-- and the section existed in that one browser.
--
-- The consequence surfaced one screen later and looked like a different bug: a
-- dish saved into that section was refused by `item_category_id_fkey`, for
-- ever, until the outbox parked it on the eighth try. Measured against a real
-- database before this was written — the section op, the update, the reorder
-- and then the dish, in that order, with the exact payloads the shipped build
-- sends.
--
-- `colour` is separated from `icon` here rather than overloaded. The bootstrap
-- published `icon: r.colour || 'main'`, so the one column was being read as the
-- glyph key while the editor's colour picker wrote nothing at all. Every real
-- row has `colour` NULL — nothing has ever sent a payload to write one — so
-- there is nothing to migrate, only a conflation to stop repeating.
--
-- NULL IS A REAL ANSWER for `icon` and `station`, the same reason 031 made a
-- measured yield nullable: "nobody has chosen a glyph for this section" and
-- "somebody chose the mains glyph" are different facts, and only the first may
-- fall through to the shipped default. `hidden` is not nullable — a section is
-- on the menu or it is not, and there is no third state.
-- ═══════════════════════════════════════════════════════════════════════════

DO $mig$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name FROM chain.outlet WHERE schema_name IS NOT NULL LOOP
    EXECUTE format(
      'ALTER TABLE %I.menu_category'
      -- The glyph both apps strike through the section's hue. A key into
      -- SECTION_GLYPHS, which the till and the guest portal share.
      || ' ADD COLUMN IF NOT EXISTS icon text,'
      -- Where a dish created in this section fires by default. The dish still
      -- carries its own — this is what the editor offers when there is none.
      || ' ADD COLUMN IF NOT EXISTS station text,'
      -- Off the rail, off the QR menu, off the printed list. A standing menu
      -- decision, like item.off_menu one level down.
      || ' ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false',
      o.schema_name);
  END LOOP;
END $mig$;
