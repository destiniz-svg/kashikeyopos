-- ═══ CARD MONEY ════════════════════════════════════════════════════════════
-- 08-BUILD-STAGES §17: "Settlement reconciliation: acquirer batches matched to
-- payments, fees to 6180, variance surfaced." 05-DATA-MODEL §50: "Card sales
-- debit 1020 instead of 1000 and settle to 1010 with a fee to 6180 when the
-- acquirer batch matches."
--
-- The second half of that sentence has never happened. `settlement_batch` and
-- `payment.batch_id` have been in the schema since the first migration with
-- nothing writing them, so every card sale ever taken debited 1020 Card
-- receivable and stayed there. Account 1020 is therefore the sum of every card
-- payment since the day the restaurant opened — a receivable that only grows,
-- against money that is sitting in the bank account and counted nowhere.
--
-- WHAT A MATCH POSTS, and why it needs one more account than it looks like:
--
--   Dr 1010 Bank                what actually arrived
--   Dr 6180 Card fees           what the acquirer kept
--   Dr/Cr 6185 variance         the difference, if there is one
--   Cr 1020 Card receivable     WHAT THE MATCHED PAYMENTS ARE WORTH
--
-- The credit is the payments, not the batch: those are the receivables being
-- discharged and they are worth what the till recorded. If the acquirer's own
-- gross disagrees, that difference is real — a chargeback, a payment matched to
-- the wrong batch, a till that mistyped an amount — and it wants a name and a
-- line in the P&L where somebody will chase it. Plugging it into the fee would
-- hide a dispute inside a cost of doing business; balancing it against 1020
-- would leave a receivable nobody can explain.
-- 6185 is added to chain.seed_chart itself (migration 004) rather than to a
-- function of its own, so an outlet PROVISIONED TOMORROW has it too. A chart
-- patched only for the outlets that existed when the migration ran is the
-- provisioning trap in its usual disguise: everything works until somebody
-- opens a new branch, and then the first card settlement of its life dies on a
-- foreign key. Re-seeding here is what patches the outlets already trading.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name FROM chain.outlet LOOP
    PERFORM chain.seed_chart(o.schema_name);

    EXECUTE format($q$
      -- What the batch was for, in the operator's own words, and who entered
      -- it. A batch that turns out to be wrong is a conversation with an
      -- acquirer, and "who typed this" is the first question.
      ALTER TABLE %1$I.settlement_batch
        ADD COLUMN IF NOT EXISTS entered_by uuid,
        ADD COLUMN IF NOT EXISTS entered_at timestamptz NOT NULL DEFAULT now(),
        ADD COLUMN IF NOT EXISTS note text,
        ADD COLUMN IF NOT EXISTS journal_id uuid;

      -- Finding the payments a batch might be made of is the whole job of the
      -- screen, and it asks the same question every time: which card payments
      -- have not been settled yet.
      CREATE INDEX IF NOT EXISTS payment_unsettled ON %1$I.payment (sale_id)
        WHERE batch_id IS NULL;
      CREATE INDEX IF NOT EXISTS payment_batch ON %1$I.payment (batch_id)
        WHERE batch_id IS NOT NULL;
    $q$, o.schema_name);
  END LOOP;
END $$;
