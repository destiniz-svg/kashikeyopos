-- ═══ SUPPLIERS, AND THE DOCUMENTS THAT BUY FROM THEM ═══════════════════════
--
-- 02-POS-SPEC.md §2 (`purchases`): "PO → delivery → priced GRN → vendor invoice
-- → ageing", and (`vendors`): "Supplier master, terms, price history".
--
-- chain.supplier is deliberately GROUP-WIDE: it holds no outlet's trading data,
-- only who the estate buys from, and a chain that had to re-enter its fish
-- supplier at every branch would end up with four spellings of one company and
-- no way to see what any of them charge. Every outlet role could already read
-- it; this adds the write, gated at ADMIN in the policy as well as in the route
-- so the second belt actually holds something.

ALTER TABLE chain.supplier ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain.supplier FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS supplier_read ON chain.supplier;
CREATE POLICY supplier_read ON chain.supplier FOR SELECT
  USING (app.current_outlet() IS NOT NULL OR app.group_scope());

-- Rank 4. A supplier record carries payment terms, and payment terms are how
-- long the restaurant gets to hold somebody else's money.
DROP POLICY IF EXISTS supplier_write ON chain.supplier;
CREATE POLICY supplier_write ON chain.supplier FOR ALL
  USING (app.current_outlet() IS NOT NULL AND app.current_rank() >= 4)
  WITH CHECK (app.current_outlet() IS NOT NULL AND app.current_rank() >= 4);

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT db_role FROM chain.outlet LOOP
    EXECUTE format('GRANT INSERT, UPDATE ON chain.supplier TO %I', r.db_role);
  END LOOP;
END $$;

-- ── the delivery gains what a GRN actually needs ───────────────────────────
--
-- `priced` already existed as a flag with nothing behind it. A delivery that
-- arrives without an invoice is the normal case in a kitchen — the driver hands
-- over fish and leaves — and the stock has to rise NOW or the next sale oversells
-- it. So an unpriced GRN raises stock at the ingredient's current average cost,
-- is marked unpriced, and is corrected when the invoice turns up. That is what
-- the Today screen means by "unpriced deliveries", which until now it could
-- only approximate.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name FROM chain.outlet LOOP
    EXECUTE format($q$
      ALTER TABLE %1$I.delivery
        ADD COLUMN IF NOT EXISTS note text,
        ADD COLUMN IF NOT EXISTS priced_at timestamptz,
        ADD COLUMN IF NOT EXISTS priced_by uuid;

      CREATE TABLE IF NOT EXISTS %1$I.delivery_line (
        id      bigserial PRIMARY KEY,
        delivery_id uuid NOT NULL REFERENCES %1$I.delivery(id) ON DELETE CASCADE,
        ingredient_id text NOT NULL REFERENCES %1$I.ingredient(id),
        qty     numeric(14,4) NOT NULL CHECK (qty > 0),
        -- The price ACTUALLY invoiced. NULL until the invoice arrives, which is
        -- a different state from zero: zero is a free delivery and null is an
        -- unanswered question.
        unit_price numeric(12,4),
        -- What the stock was raised at when it landed, so the correction when
        -- the invoice comes in is a difference and not a guess.
        provisional_cost numeric(12,4) NOT NULL DEFAULT 0,
        UNIQUE (delivery_id, ingredient_id)
      );
      CREATE INDEX IF NOT EXISTS delivery_unpriced ON %1$I.delivery (at)
        WHERE priced = false;

      -- A vendor invoice is due on a date, and that date is what makes a
      -- supplier overdue. Indexed because the ageing view asks for it and the
      -- Today screen asks for it every two minutes.
      CREATE INDEX IF NOT EXISTS invoice_due ON %1$I.vendor_invoice (due_date)
        WHERE paid < amount;
    $q$, o.schema_name);
  END LOOP;
END $$;

-- ── the grant, which is half of adding a table ─────────────────────────────
--
-- provision_outlet grants on ALL TABLES IN SCHEMA at the moment it runs, so a
-- table added by a LATER migration is invisible to every outlet that already
-- exists — while a freshly provisioned one works perfectly. The whole test
-- suite provisions fresh outlets, so it went green and the dev database threw
-- "permission denied for table delivery_line" the first time a screen asked for
-- it. Adding a table is two statements, not one.
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

-- No doc_series insert here: provision_outlet has always minted GRN and PO
-- alongside SALE, CN and JV, so every outlet already has the series a delivery
-- needs a number from.
