-- Cash rounding is per outlet and per jurisdiction, not a constant in the
-- source. An outlet that has stopped handling 1- and 2-laari coins rounds a
-- cash bill to the nearest 5 or 10; one that still takes them rounds to
-- nothing. 0 = no rounding, which is the honest default for a new outlet
-- because nobody has said otherwise yet.
--
-- Cash only: a card bill is settled to the laari, so rounding a card payment
-- would create a difference the acquirer's batch will not contain.
ALTER TABLE chain.outlet
  ADD COLUMN IF NOT EXISTS cash_round_laari int NOT NULL DEFAULT 0
    CHECK (cash_round_laari >= 0 AND cash_round_laari <= 100);

-- The till's own total travels with a sale so a drifting device can be found.
-- Nullable: a till that does not send one is not in disagreement, it is silent,
-- and those are different states.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name FROM chain.outlet LOOP
    EXECUTE format('ALTER TABLE %I.sale ADD COLUMN IF NOT EXISTS'
                   || ' client_total numeric(12,2)', o.schema_name);
  END LOOP;
END $$;
