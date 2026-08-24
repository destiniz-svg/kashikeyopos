-- ═══ CREDIT IS A BALANCE THE SERVER KEEPS, NOT A PROMISE THE TILL MAKES ══════
-- A house account has a limit, and until now nothing enforced it. The terminal
-- told the operator a Postgres trigger would reject an over-limit charge
-- "offline or not" — there was no trigger, no CHECK, and no per-member
-- outstanding balance anywhere. A credit sale simply debited 1040 and the limit
-- was decoration. Two offline tills could run one customer arbitrarily over.
--
-- The fix keeps the balance where it belongs: on the member, chain-wide (the
-- limit is one figure across every outlet), maintained by the two ops that move
-- it — a credit sale raises it, a settlement lowers it. `applySale` reads it and
-- STAMPS an overrun rather than rejecting the sale (a sale that already happened
-- is never thrown away — the same doctrine that governs tax), and the till's own
-- pay screen blocks an over-limit charge before it is rung. Prevented at the
-- counter, detected and recorded on replay.
--
-- The old published `on_account` summed credit CHARGES and never subtracted
-- settlements, so a customer who had paid their balance still read as owing it.
-- `credit_used` is charges minus settlements — the real outstanding.

ALTER TABLE chain.member
  ADD COLUMN IF NOT EXISTS credit_used numeric(12,2) NOT NULL DEFAULT 0;

-- Back-fill once, from the books that already exist: credit charges summed
-- across every outlet's own payment table, minus the settlements recorded on
-- the trail. Guarded so a re-run after the column is live never clobbers a
-- balance the ops have since maintained.
DO $$
DECLARE
  o record;
BEGIN
  IF EXISTS (SELECT 1 FROM chain.member WHERE credit_used <> 0) THEN
    RETURN;  -- already populated / maintained; do not restate
  END IF;

  CREATE TEMP TABLE _credit_bf (member_id uuid, delta numeric) ON COMMIT DROP;

  -- charges: every credit tender on a non-void sale, in every outlet schema
  FOR o IN SELECT id FROM chain.outlet LOOP
    IF to_regclass(format('outlet_%s.payment', o.id)) IS NOT NULL THEN
      EXECUTE format(
        'INSERT INTO _credit_bf (member_id, delta)
           SELECT s.member_id, sum(p.amount)
             FROM outlet_%1$s.payment p
             JOIN outlet_%1$s.sale s ON s.id = p.sale_id
            WHERE p.method = ''credit''
              AND s.member_id IS NOT NULL
              AND s.voided_at IS NULL
            GROUP BY s.member_id', o.id);
    END IF;
  END LOOP;

  -- settlements: recorded on the audit trail as settle_credit, amount in `amt`
  INSERT INTO _credit_bf (member_id, delta)
    SELECT entity_id::uuid, -sum((after->>'amt')::numeric)
      FROM chain.audit
     WHERE action = 'settle_credit' AND entity = 'member' AND entity_id IS NOT NULL
       AND after ? 'amt'
     GROUP BY entity_id;

  UPDATE chain.member m
     SET credit_used = greatest(0, round(b.total, 2))
    FROM (SELECT member_id, sum(delta) AS total FROM _credit_bf
           WHERE member_id IS NOT NULL GROUP BY member_id) b
   WHERE b.member_id = m.id;
END $$;
