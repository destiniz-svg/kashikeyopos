-- ═══════════════════════════════════════════════════════════════════════════
-- Indent Requests — 02-POS-SPEC §2 (`requests`): "A kitchen asks; a manager
-- approves."
--
-- AND THE THING IT FINALLY CONNECTS TO. `purchase_order` and `po_line` have
-- existed since migration 003, the `PO` document series has been minting
-- numbers nobody asked for, and NOTHING in this application has ever written a
-- row to either. Deliveries are received against a supplier and no order at
-- all, so "what did we ask for" and "what turned up" have never been the same
-- conversation. An indent is where the first half comes from:
--
--     the kitchen asks → a manager decides → it becomes an order →
--     the delivery is received against that order
--
-- Each arrow is a rank and a record. The last one already existed and was
-- pointing at nothing.
--
-- A MANAGER APPROVES A QUANTITY, NOT A REQUEST. The line carries what was asked
-- for and what was approved, separately, because "we asked for 20 kg and got
-- told 12" is the fact a kitchen needs to see at the stove — not a request that
-- silently came back smaller. Declining is per line and carries a reason: an
-- indent turned down in full with no explanation is how the next one gets
-- padded.
--
-- IT IS A REQUEST, NOT A RESERVATION. Approving an indent moves no stock and
-- promises nothing — the goods do not exist yet. Everything real happens when
-- the order is placed and again when the delivery arrives, which is where the
-- money and the stock already live.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^outlet_[0-9]+$' LOOP
    EXECUTE format($ddl$
      CREATE TABLE IF NOT EXISTS %1$I.indent (
        id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        ref      text NOT NULL UNIQUE,
        at       timestamptz NOT NULL DEFAULT now(),
        on_date  date NOT NULL DEFAULT current_date,
        /* Who is asking, in their own words — "the pass", "the bar". Not a
           foreign key to anything: a kitchen reorganises faster than a schema
           and the point is that a manager reading the list knows who wants it. */
        for_area text,
        needed_by date,
        note     text,
        state    text NOT NULL DEFAULT 'open'
                 CHECK (state IN ('open','decided','ordered','cancelled')),
        raised_by uuid,
        decided_by uuid, decided_at timestamptz,
        reason   text,
        /* The order it became, once somebody placed one. NULL is the normal
           state of an approved indent for as long as nobody has ordered — and
           that gap is exactly what the screen is for. */
        po_id    uuid REFERENCES %1$I.purchase_order(id)
      );
      CREATE INDEX IF NOT EXISTS indent_state ON %1$I.indent (state, at DESC);

      CREATE TABLE IF NOT EXISTS %1$I.indent_line (
        id        bigserial PRIMARY KEY,
        indent_id uuid NOT NULL REFERENCES %1$I.indent(id) ON DELETE CASCADE,
        ingredient_id text NOT NULL REFERENCES %1$I.ingredient(id),
        /* Asked for and approved, side by side and never overwritten. "We asked
           for 20 and were given 12" is the fact the stove needs; a request that
           quietly came back smaller is how a kitchen stops trusting the
           system. */
        qty       numeric(14,4) NOT NULL CHECK (qty > 0),
        approved_qty numeric(14,4) CHECK (approved_qty >= 0),
        note      text,
        reason    text,
        UNIQUE (indent_id, ingredient_id)
      );
      CREATE INDEX IF NOT EXISTS indent_line_indent ON %1$I.indent_line(indent_id);
    $ddl$, s);
  END LOOP;
END $$;

-- ── the order a delivery can be received against ───────────────────────────
-- `delivery.po_id` was already there and nothing ever set it. Nothing to add;
-- the column is used from this migration onward — see backend/src/purchasing.js.

-- ── the indent's own document series ───────────────────────────────────────
INSERT INTO chain.doc_series (outlet_id, kind, prefix)
SELECT id, 'IND', code || '-IND' FROM chain.outlet
ON CONFLICT DO NOTHING;

-- ── grants ─────────────────────────────────────────────────────────────────
-- Adding a table is two statements, not one (migration 014). DELETE on the
-- LINES so an indent still open can be edited by the person who raised it; the
-- indent itself is cancelled rather than deleted, because a request that was
-- turned down is a thing that happened.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name, db_role FROM chain.outlet LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
    EXECUTE format('GRANT DELETE ON %I.indent_line TO %I', o.schema_name, o.db_role);
  END LOOP;
END $$;
