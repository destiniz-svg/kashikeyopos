-- ═══════════════════════════════════════════════════════════════════════════
-- Dispatches — 02-POS-SPEC §2 (`dispatches`): "Inter-outlet transfers, both
-- sides of the move."
--
-- THIS IS THE ONE FEATURE THE TENANCY MODEL MAKES GENUINELY HARD, and the
-- shape of this file is the answer. Malé cannot write into Hulhumalé's schema:
-- it holds no grant there, the tables are not in its search_path, and that is
-- not an inconvenience to work around — it is the property the whole build
-- rests on. So a transfer is NOT one outlet moving another's stock. It is:
--
--   · a row in `chain`, which both outlets can see, saying what was sent
--   · a stock movement in the SENDER's own schema, written by the sender
--   · a stock movement in the RECEIVER's own schema, written by the receiver,
--     when they confirm what actually turned up
--
-- Neither side ever touches the other's tables. The chain row is a handshake,
-- not a shared ledger, and a transfer that is sent and never confirmed stays
-- visibly in flight rather than silently completing.
--
-- WHICH MEANS THE RECEIVER NAMES THEIR OWN INGREDIENT. Ingredient ids are
-- per-outlet — Malé's `BEEF` and Hulhumalé's `BEEF` are different rows in
-- different schemas and may not even be the same word. So the sender writes
-- down what it IS (name, unit, quantity, cost) and the receiver maps it to
-- whatever they call it. Assuming the ids match would work for exactly as long
-- as one chain used one spreadsheet to set both outlets up.
--
-- WHAT ARRIVES IS WHAT IS RECEIVED, NOT WHAT WAS SENT. The receiver enters the
-- quantity they actually got. A shortfall is not an error to be argued with in
-- a dialog: it is the difference between two branches' books, it belongs to
-- somebody, and it is recorded so that it can be. See `variance` below.
--
-- THE MONEY. One clearing account, 1350, not a pair: the sender debits it as
-- stock leaves and the receiver credits it as the same stock arrives, so across
-- the estate it nets to zero once both halves have posted. A non-zero total is
-- then a real finding — a van still on the road, or a delivery nobody
-- confirmed — visible without reconciling two accounts against each other.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chain.transfer (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref         text NOT NULL UNIQUE,
  from_outlet int NOT NULL REFERENCES chain.outlet(id),
  to_outlet   int NOT NULL REFERENCES chain.outlet(id),
  /* What it is, in the SENDER's words. The receiver reads this and maps it to
     their own ingredient — ids are per-outlet and assuming they match is an
     assumption that holds until one chain sets two outlets up separately. */
  item_name   text NOT NULL,
  unit        text NOT NULL,
  from_ingredient text NOT NULL,
  /* Named by the receiver at the moment of confirming, and NULL until then. */
  to_ingredient   text,
  qty_sent    numeric(14,4) NOT NULL CHECK (qty_sent > 0),
  qty_received numeric(14,4) CHECK (qty_received >= 0),
  /* The sender's cost per unit, in MVR. The stock moves at what it cost where
     it came from — a transfer is not a sale and must not create margin in one
     branch or destroy it in the other. */
  unit_cost   numeric(12,4) NOT NULL DEFAULT 0,
  state       text NOT NULL DEFAULT 'sent'
              CHECK (state IN ('sent','received','rejected','cancelled')),
  note        text,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  sent_by     uuid,
  settled_at  timestamptz,
  settled_by  uuid,
  reason      text,
  CONSTRAINT not_to_itself CHECK (from_outlet <> to_outlet),
  CONSTRAINT settled_has_a_time CHECK (
    (state = 'sent') = (settled_at IS NULL)),
  CONSTRAINT received_has_a_quantity CHECK (
    state <> 'received' OR (qty_received IS NOT NULL AND to_ingredient IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS transfer_from ON chain.transfer(from_outlet, sent_at DESC);
CREATE INDEX IF NOT EXISTS transfer_to ON chain.transfer(to_outlet, sent_at DESC);
CREATE INDEX IF NOT EXISTS transfer_open ON chain.transfer(to_outlet)
  WHERE state = 'sent';

ALTER TABLE chain.transfer ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain.transfer FORCE ROW LEVEL SECURITY;

-- ── who may see and do what ────────────────────────────────────────────────
--
-- BOTH ENDS SEE IT, and only the two of them. This is the one row in the system
-- an outlet may read that names another outlet, and it names it because the
-- transfer is a fact about both — a branch that could not see who sent it stock
-- could not confirm it. It carries no figure about the other branch's business
-- beyond the one thing being moved.
DROP POLICY IF EXISTS transfer_read ON chain.transfer;
CREATE POLICY transfer_read ON chain.transfer FOR SELECT
  USING (from_outlet = app.current_outlet() OR to_outlet = app.current_outlet()
         OR app.group_scope());

-- Sending is MANAGER, at the sending end only. A branch cannot help itself to
-- another's stock by writing a row that says it was sent.
DROP POLICY IF EXISTS transfer_send ON chain.transfer;
CREATE POLICY transfer_send ON chain.transfer FOR INSERT
  WITH CHECK (from_outlet = app.current_outlet() AND app.current_rank() >= 3);

-- Settling is the RECEIVER's, and cancelling is the SENDER's, and the row can
-- only move out of `sent`. A receiver cannot rewrite what was sent; a sender
-- cannot decide what arrived.
DROP POLICY IF EXISTS transfer_settle ON chain.transfer;
CREATE POLICY transfer_settle ON chain.transfer FOR UPDATE
  USING (state = 'sent' AND app.current_rank() >= 3
         AND (to_outlet = app.current_outlet() OR from_outlet = app.current_outlet()))
  WITH CHECK (to_outlet = app.current_outlet() OR from_outlet = app.current_outlet());

-- ── the names of the other branches, and nothing else about them ──────────
--
-- A transfer needs a destination, and `chain.outlet` is guarded by a policy
-- that matches this outlet's row and no other — correctly. Widening that policy
-- would hand over the whole ROW, and `chain.outlet` carries `schema_name` and
-- `db_role`: the two columns a connection is resolved through. RLS decides
-- which rows you may read, never which columns.
--
-- So: a SECURITY DEFINER function returning an id, a code, a name and whether
-- the branch is open. That is what a manager choosing where to send a case of
-- beef needs, and it is all of it. No takings, no staff, no stock, no schema.
-- Which branches a chain has is not a secret from its own staff; what those
-- branches DID is, and none of it is here.
CREATE OR REPLACE FUNCTION chain.outlet_names()
RETURNS TABLE (id int, code text, name text, active boolean)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT o.id, o.code, o.name, o.active FROM chain.outlet o
   WHERE app.current_outlet() IS NOT NULL OR app.group_scope()
   ORDER BY o.name
$$;

DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT db_role FROM chain.outlet LOOP
    -- No DELETE. A transfer that happened, happened; one that should not have
    -- is cancelled or rejected, and the row says which.
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON chain.transfer TO %I', o.db_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION chain.outlet_names() TO %I', o.db_role);
  END LOOP;
END $$;

-- ── the clearing account, on every outlet that already exists ──────────────
-- Adding a code to the ONE chart (migration 004) is half the job; the outlets
-- provisioned before today have to be re-seeded with it. Both halves, one list.
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^outlet_[0-9]+$' LOOP
    PERFORM chain.seed_chart(s);
  END LOOP;
END $$;

-- ── the transfer series, on outlets that already exist ─────────────────────
-- Same shape as the chart above: a new series added to `provision_outlet` only
-- reaches outlets provisioned afterwards.
INSERT INTO chain.doc_series (outlet_id, kind, prefix)
SELECT id, 'TRF', code || '-TRF' FROM chain.outlet
ON CONFLICT DO NOTHING;
