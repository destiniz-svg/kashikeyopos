-- ═══════════════════════════════════════════════════════════════════════════
-- Batches & Expiry — 02-POS-SPEC §2 (`batches`): "Lot tracking and expiry
-- alerts."
--
-- TWO QUESTIONS, AND ONLY ONE OF THEM IS ABOUT DATES. "What is about to go
-- off" is the one a kitchen asks every morning. "Which sales contained lot
-- 24B-119" is the one asked once, by an inspector or a supplier issuing a
-- recall, on the worst day of the year — and it is the one the answer has to be
-- built for in advance, because it cannot be reconstructed afterwards.
--
-- SO A DRAW IS RECORDED, NOT INFERRED. `batch_draw` ties each stock movement to
-- the batch or batches it came out of. Without it a batch is a note about
-- something that arrived; with it, a lot leads to the movements, the movements
-- lead to the sales, and the sales lead to the receipts and the day.
--
-- NOBODY SCANS A LOT AT THE PASS, and no design that requires it survives a
-- Friday. Allocation is FEFO — first to expire, first out — done by the server
-- inside the one function that already moves stock, so a batch's remaining
-- quantity stays honest without anybody doing anything. That is a MODEL of
-- what the kitchen does rather than a record of it, and the difference is
-- stated rather than glossed: a cook who reaches past the older tub is not
-- lying to the system, they are doing something the system assumed they would
-- not. Which is exactly why the expiry alert matters.
--
-- STOCK THAT NOBODY BATCHED IS NOT AN ERROR. Most ingredients never need a lot
-- — nobody tracks the batch of a bag of salt — so an ingredient becomes
-- batch-tracked the moment somebody records a batch of it and not before. A
-- movement that cannot be covered by open batches draws what it can and leaves
-- the rest untracked, which is the truth: the store had stock nobody recorded.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^outlet_[0-9]+$' LOOP
    EXECUTE format($ddl$
      CREATE TABLE IF NOT EXISTS %1$I.batch (
        id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        ingredient_id text NOT NULL REFERENCES %1$I.ingredient(id),
        /* The supplier's own code, when there is one. NULL is common and fine:
           a kitchen that opens a sack today and wants it gone by Friday has a
           batch with an expiry and no lot number, and that is still worth
           tracking. */
        lot      text,
        qty_in   numeric(14,4) NOT NULL CHECK (qty_in > 0),
        qty_left numeric(14,4) NOT NULL CHECK (qty_left >= 0),
        unit_cost numeric(12,4) NOT NULL DEFAULT 0,
        received_on date NOT NULL DEFAULT current_date,
        /* NULL means it does not expire, not that nobody has said. A batch with
           no date is excluded from the alerts entirely rather than sorted to
           the end of them. */
        expires_on date,
        delivery_id uuid REFERENCES %1$I.delivery(id),
        prep_run_id uuid REFERENCES %1$I.prep_run(id),
        /* Closed when it is used up, thrown away, or written off as expired.
           A closed batch keeps its rows: the draws against it are the trail. */
        closed_at timestamptz,
        closed_reason text,
        note     text,
        by_staff uuid,
        CONSTRAINT left_within_in CHECK (qty_left <= qty_in)
      );
      /* The allocation index: open batches of one ingredient, soonest expiry
         first, which is the exact order FEFO draws them in. NULLS LAST so a
         batch with no expiry is used only after the dated ones. */
      CREATE INDEX IF NOT EXISTS batch_fefo ON %1$I.batch
        (ingredient_id, expires_on NULLS LAST, received_on)
        WHERE closed_at IS NULL;
      CREATE INDEX IF NOT EXISTS batch_expiry ON %1$I.batch (expires_on)
        WHERE closed_at IS NULL AND expires_on IS NOT NULL;

      /* Which movement took how much out of which batch. This is the whole
         reason lot tracking is worth having: a recall walks lot → draws →
         movements → sales → receipts, and none of that can be reconstructed
         from quantities after the fact. */
      CREATE TABLE IF NOT EXISTS %1$I.batch_draw (
        id       bigserial PRIMARY KEY,
        batch_id uuid NOT NULL REFERENCES %1$I.batch(id),
        stock_move_id bigint NOT NULL REFERENCES %1$I.stock_move(id),
        qty      numeric(14,4) NOT NULL CHECK (qty > 0),
        at       timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS batch_draw_batch ON %1$I.batch_draw(batch_id);
      CREATE INDEX IF NOT EXISTS batch_draw_move ON %1$I.batch_draw(stock_move_id);
    $ddl$, s);
  END LOOP;
END $$;

-- ── grants ─────────────────────────────────────────────────────────────────
-- Adding a table is two statements, not one (migration 014). No DELETE on
-- either: a batch that arrived, arrived, and a draw records something that
-- happened. A batch written off is CLOSED, which keeps its trail.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name, db_role FROM chain.outlet LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
  END LOOP;
END $$;
