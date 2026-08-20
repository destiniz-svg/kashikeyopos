-- ═══════════════════════════════════════════════════════════════════════════
-- The menu the prototype actually draws — 02-POS-SPEC §2 (`menu`), §3.2.
--
-- Until now a dish was four columns: name, section, price, station. The till
-- drew it as a rectangle of text, and design/KashikeyoPOS Guest Theme v3.dc.html
-- draws it as a photographed card with a description, a heat rating, diet tags
-- and a list of add-ons — because that is what a cashier aims at across a
-- counter, and what a guest reads on their own phone. None of that had anywhere
-- to live.
--
-- FOUR THINGS ARRIVE HERE, AND EACH ONE HAS A REASON.
--
-- 1. THE DISH GETS A FACE. description / image_url / tags / spice. A photograph
--    is a URL, not a blob: this platform has no object store, the prototype's
--    dishes carry URLs, and a database that grows by four megabytes per dish is
--    a database nobody can replicate to an edge box. image_url NULL is a first
--    class state — the till draws the section artifact instead (§10), never an
--    empty grey box.
--
-- 2. THE SECTION BECOMES A ROW. `item.category` has always been free text, and
--    the prototype's note is load-bearing: "the section colour is not
--    decoration — it bands the till grid, tints the dish artifact where no
--    photograph exists, and colours the KDS docket rail". A colour needs
--    somewhere to be stored, so menu_section is keyed BY THAT SAME TEXT. Every
--    existing query against item.category keeps working untouched, a section
--    with no row is simply an unconfigured section, and renaming one is two
--    updates in one transaction rather than a migration of every dish.
--
-- 3. THE ADD-ON BECOMES SELLABLE. modifier is the priced catalogue; sections[]
--    publishes it to the sections that offer it; item_modifier overrides that
--    for one dish. A dish INHERITS its section's add-ons unless addons_own says
--    it names its own — which is how "extra sambol on every main" is one row
--    rather than forty, and how "no add-ons on this one" is still expressible
--    (addons_own with no rows), a distinction a bare link table cannot make.
--
-- 4. THE BILL REMEMBERS. sale_line.addons matches ticket_line.addons, which has
--    been declared since migration 003 and written by nobody. A settled line has
--    to say what was actually charged: "Reef curry 240" and "Reef curry 240 +
--    double portion 45" are different money, and a reprint six weeks later that
--    cannot tell them apart is not a tax record.
--
-- THE PRICE IS NEVER SENT BY THE TERMINAL. The till posts add-on IDs; the
-- server reads this catalogue and does the arithmetic, exactly as it already
-- does for the dish itself (backend/src/sale.js). An add-on that could be
-- repriced from a tablet is a hole in the price list.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^outlet_[0-9]+$' LOOP
    EXECUTE format($ddl$
      -- ── 1. the dish gets a face ──────────────────────────────────────────
      ALTER TABLE %1$I.item ADD COLUMN IF NOT EXISTS description text;
      ALTER TABLE %1$I.item ADD COLUMN IF NOT EXISTS image_url text;
      ALTER TABLE %1$I.item ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
      ALTER TABLE %1$I.item ADD COLUMN IF NOT EXISTS spice int NOT NULL DEFAULT 0;
      ALTER TABLE %1$I.item ADD COLUMN IF NOT EXISTS addons_own boolean NOT NULL DEFAULT false;

      -- ── 2. the section becomes a row ─────────────────────────────────────
      -- Keyed by the same text item.category already holds. color / icon NULL
      -- means "not chosen": the front-ends derive one from the sort position
      -- rather than inventing a stored default nobody picked.
      CREATE TABLE IF NOT EXISTS %1$I.menu_section (
        name    text PRIMARY KEY,
        color   text,
        icon    text,
        station text,
        sort    int NOT NULL DEFAULT 0,
        hidden  boolean NOT NULL DEFAULT false
      );

      -- ── 3. the add-on becomes sellable ───────────────────────────────────
      CREATE TABLE IF NOT EXISTS %1$I.modifier (
        id       text PRIMARY KEY,
        name     text NOT NULL,
        -- Inclusive of tax, in MVR, exactly like item.price. A free add-on is
        -- still an add-on: it prints on the docket and it costs nothing.
        price    numeric(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
        -- The sections that offer it. Empty means "named dishes only".
        sections text[] NOT NULL DEFAULT '{}',
        active   boolean NOT NULL DEFAULT true,
        sort     int NOT NULL DEFAULT 0,
        -- WHAT IT COSTS THE KITCHEN, optionally. An add-on that names a dish
        -- explodes through THAT dish's recipe when it sells, so "extra scoop"
        -- moves ice cream out of the store and into cost of sales like
        -- everything else. Leaving it NULL is a real answer -- "no ice" and
        -- "make it spicy" consume nothing -- but an add-on that quietly earned
        -- MVR 45 at nought cost would have made the GP report lie, and this
        -- platform's governing principle is that costing is real-time.
        recipe_item_id text REFERENCES %1$I.item(id)
      );

      CREATE TABLE IF NOT EXISTS %1$I.item_modifier (
        item_id     text NOT NULL REFERENCES %1$I.item(id) ON DELETE CASCADE,
        modifier_id text NOT NULL REFERENCES %1$I.modifier(id) ON DELETE CASCADE,
        PRIMARY KEY (item_id, modifier_id)
      );

      -- CREATE TABLE IF NOT EXISTS converges on the table and NOT on its
      -- columns, so a schema that already has an older `modifier` would keep it
      -- unchanged and every add-on would silently cost nothing. Stating the
      -- later column separately is what makes re-running this migration
      -- actually converge, which is the property scripts/migrate.js relies on
      -- to run every file on every boot.
      ALTER TABLE %1$I.modifier ADD COLUMN IF NOT EXISTS recipe_item_id text
        REFERENCES %1$I.item(id);

      -- ── 4. the bill remembers ────────────────────────────────────────────
      ALTER TABLE %1$I.sale_line ADD COLUMN IF NOT EXISTS addons jsonb NOT NULL DEFAULT '[]';
    $ddl$, s);
  END LOOP;
END $$;

-- The heat rating is 0..3 and the check is added separately, because a CHECK
-- inside ADD COLUMN IF NOT EXISTS re-runs on a re-applied migration and fails
-- on the duplicate constraint name.
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^outlet_[0-9]+$' LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'item_spice_range'
        AND connamespace = s::regnamespace
    ) THEN
      EXECUTE format(
        'ALTER TABLE %1$I.item ADD CONSTRAINT item_spice_range CHECK (spice BETWEEN 0 AND 3)', s);
    END IF;
  END LOOP;
END $$;

-- ── grants ─────────────────────────────────────────────────────────────────
-- Adding a table is two statements, not one (migration 014). DELETE on
-- item_modifier because unticking an add-on on a dish is an edit, not an event;
-- DELETE on menu_section and modifier for the same reason — neither carries
-- money, and a section deleted while a dish still names it simply becomes an
-- unconfigured section again rather than orphaning anything.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name, db_role FROM chain.outlet LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
    EXECUTE format('GRANT DELETE ON %I.item_modifier TO %I', o.schema_name, o.db_role);
    EXECUTE format('GRANT DELETE ON %I.menu_section TO %I', o.schema_name, o.db_role);
    EXECUTE format('GRANT DELETE ON %I.modifier TO %I', o.schema_name, o.db_role);
  END LOOP;
END $$;
