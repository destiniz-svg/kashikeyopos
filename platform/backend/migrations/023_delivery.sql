-- ═══ DELIVERY & QR ═════════════════════════════════════════════════════════
--
-- 02-POS-SPEC.md §2 (`delivery`): "Aggregator and QR channel orders, rider
-- dispatch, stage tracking." 08-BUILD-STAGES §15: "accept, reject, dispatch,
-- track", and §14's acceptance criterion: "A guest orders from a phone, the
-- till accepts it, the kitchen sees it, the guest's tracker follows it."
--
-- THE CHAIN IS BROKEN IN THE MIDDLE TODAY. A guest's round lands in
-- `guest_order` as a blob of jsonb lines. The accept operation stamps
-- `accepted_at` and can be handed a ticket id — and nothing has ever created
-- that ticket, so the lines never become ticket_lines, the kitchen never sees
-- the food, and the guest's tracker cannot follow anything. The tracker's own
-- code says as much: it matches its stage with `find(() => false)`, a predicate
-- that can never be true, left as a placeholder for the link that was never
-- built. A guest can order from a phone and nobody in the building will know.
--
-- The columns below are what an order needs to be a real one:
--
-- A CHANNEL, because a QR order at table 4 and a delivery to an address are the
-- same object at different addresses, and the till has to treat them
-- differently in exactly one place — where it goes.
--
-- A REJECTION WITH A REASON AND A TIME. "We have no more of that" is an answer;
-- a row that silently stays pending for ever is not.
--
-- A RIDER STAGE, because §4's ladder says delivery adds "With the rider" before
-- Delivered, and a guest watching a phone deserves to know which of those two
-- they are in.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name, db_role FROM chain.outlet LOOP
    EXECUTE format($q$
      ALTER TABLE %1$I.guest_order
        -- 'dine_in' is the QR case and stays the default: every order that
        -- exists today came from a table.
        ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'dine_in',
        -- Where it came from, which is not the same as where it goes. An
        -- aggregator order and a telephone order both end up as 'delivery'
        -- and are chased in completely different places when they go wrong.
        ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'qr',
        ADD COLUMN IF NOT EXISTS ext_ref text,
        ADD COLUMN IF NOT EXISTS address text,
        ADD COLUMN IF NOT EXISTS fee numeric(12,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
        ADD COLUMN IF NOT EXISTS rejected_by uuid,
        -- The rider leg. NULL until it is dispatched, which is how "ready" and
        -- "on its way" are told apart.
        ADD COLUMN IF NOT EXISTS rider text,
        ADD COLUMN IF NOT EXISTS dispatched_at timestamptz,
        ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

      CREATE INDEX IF NOT EXISTS guest_order_waiting ON %1$I.guest_order (at)
        WHERE accepted_at IS NULL AND rejected_at IS NULL;
      CREATE INDEX IF NOT EXISTS guest_order_live ON %1$I.guest_order (accepted_at DESC)
        WHERE accepted_at IS NOT NULL AND delivered_at IS NULL;
    $q$, o.schema_name);

    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
  END LOOP;
END $$;

-- `rejected_reason` has existed since migration 003 and nothing ever set it,
-- for the same reason nothing created the ticket: the accept path was half
-- built. Both halves are wired now.
