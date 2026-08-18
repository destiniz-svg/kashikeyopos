-- ═══════════════════════════════════════════════════════════════════════════
-- Production — 02-POS-SPEC §2 (`production`): "Batch prep of sub-recipes;
-- consumes ingredients, produces stock."
--
-- THE HOLE THIS FILLS IS A REAL ONE AND IT SHOWS UP ON A STOCK COUNT. A dish
-- with a sub-recipe is exploded to raw ingredients at the moment of SALE
-- (`costing.explode`), so a kitchen that makes four litres of sauce at nine in
-- the morning has physically used the tomatoes, the oil and the stock — and
-- this system goes on saying they are on the shelf until a dish that contains
-- them sells, possibly days later. Count the store at eleven and every one of
-- those components is short, with nothing to explain it. The variance lands in
-- 5100 as if somebody had thrown them away.
--
-- WHAT A PREP ITEM IS HERE. It is an INGREDIENT, with a unit, an average cost
-- and a quantity on hand, that happens to be MADE rather than bought. That is
-- the whole design, and everything else falls out of it:
--
--   · a dish's recipe references it the same way it references tomatoes, so
--     `costing.explode` needs no change and knows nothing about prep
--   · its cost is a weighted average like any other ingredient's, so a batch
--     made from cheaper tomatoes moves it the way a cheaper delivery would
--   · it appears on count sheets, in the stock ledger and in wastage without
--     any of those modules learning a new concept
--
-- The alternative — the one the previous generation of this product used — was
-- to overload the menu-item recipe table by keying a build recipe on the
-- ingredient's own id, with no foreign key to make it wrong. One table meaning
-- two things is how a recipe screen quietly starts editing a prep formula.
--
-- MAKING A BATCH POSTS NO JOURNAL, and that is correct rather than an omission.
-- Tomatoes at 1100 become sauce at 1100: the value moves between two things
-- that are both inventory and the ledger has nothing to say about it. Yield
-- loss is not a loss of VALUE either — the components' whole cost lands in the
-- smaller output, which is exactly what makes the sauce cost what it costs.
-- The only thing production can do to the P&L is nothing.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^outlet_[0-9]+$' LOOP
    EXECUTE format($ddl$
      /* How much one run of the recipe makes, in the ingredient's own base
         unit. NULL means this is something you buy, not something you make —
         which is most of the store, so the column is nullable rather than
         defaulted. A kitchen writes a prep sheet as "this makes four litres",
         so that is how it is stored; the components below are per BATCH. */
      ALTER TABLE %1$I.ingredient ADD COLUMN IF NOT EXISTS prep_yield numeric(14,4);
      ALTER TABLE %1$I.ingredient DROP CONSTRAINT IF EXISTS prep_yield_positive;
      ALTER TABLE %1$I.ingredient ADD CONSTRAINT prep_yield_positive
        CHECK (prep_yield IS NULL OR prep_yield > 0);

      CREATE TABLE IF NOT EXISTS %1$I.prep_recipe (
        id        bigserial PRIMARY KEY,
        makes_id  text NOT NULL REFERENCES %1$I.ingredient(id) ON DELETE CASCADE,
        component_id text NOT NULL REFERENCES %1$I.ingredient(id),
        qty       numeric(14,4) NOT NULL CHECK (qty > 0),
        /* Trim, peel, evaporation. Same meaning as on a dish's recipe line and
           the same 95%% guard in the code: a line that wastes everything is a
           typo, not a formula. */
        waste_pct numeric(5,2) NOT NULL DEFAULT 0
                  CHECK (waste_pct >= 0 AND waste_pct < 100),
        UNIQUE (makes_id, component_id),
        /* A thing cannot be an ingredient of itself. Deeper loops — A makes B
           makes A — are caught in the application, which is the only place that
           can see the whole graph. */
        CONSTRAINT not_itself CHECK (makes_id <> component_id)
      );
      CREATE INDEX IF NOT EXISTS prep_recipe_makes ON %1$I.prep_recipe(makes_id);

      /* Every batch anybody made. Immutable, like every other record of
         something that happened: a run that was wrong is corrected by a
         wastage or a count, never by editing the run. */
      CREATE TABLE IF NOT EXISTS %1$I.prep_run (
        id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        at       timestamptz NOT NULL DEFAULT now(),
        on_date  date NOT NULL DEFAULT current_date,
        makes_id text NOT NULL REFERENCES %1$I.ingredient(id),
        /* What came out, in base units. Not "how many batches": a cook who
           gets 3.6 litres out of a 4-litre recipe records 3.6, and the cost of
           the whole four litres' components lands in it. */
        qty      numeric(14,4) NOT NULL CHECK (qty > 0),
        batches  numeric(10,4) NOT NULL DEFAULT 1 CHECK (batches > 0),
        /* What the components cost, in MVR. Stored because it is the answer to
           "what did this batch cost" and recomputing it later from today's
           average would answer a different question. */
        cost     numeric(12,2) NOT NULL DEFAULT 0,
        note     text,
        by_staff uuid, device_id uuid
      );
      CREATE INDEX IF NOT EXISTS prep_run_date ON %1$I.prep_run(on_date DESC);

      /* Which run a move belonged to, so a batch can be read back as one act
         rather than as six unrelated movements at the same second. */
      ALTER TABLE %1$I.stock_move ADD COLUMN IF NOT EXISTS prep_run_id uuid;
    $ddl$, s);
  END LOOP;
END $$;

-- ── grants ─────────────────────────────────────────────────────────────────
--
-- `provision_outlet` grants on ALL TABLES IN SCHEMA at the moment it runs, so a
-- table added by a later migration is invisible to every outlet that already
-- exists. Adding a table is two statements, not one — see migration 014, which
-- learned this the same way.
--
-- DELETE on the formula and not on the runs. A prep sheet is replaced whole;
-- a batch that was made, was made, and is corrected by a wastage or a count
-- like anything else that happened.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name, db_role FROM chain.outlet LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
    EXECUTE format('GRANT DELETE ON %I.prep_recipe TO %I', o.schema_name, o.db_role);
  END LOOP;
END $$;
