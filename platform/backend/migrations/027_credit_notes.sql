-- ═══ CREDIT NOTES ══════════════════════════════════════════════════════════
-- 08-BUILD-STAGES §21: "numbered documents against a sale, with approval."
-- DEPLOYMENT.md, on what this system refuses: "A closed sale is corrected with
-- a credit note, never erased."
--
-- That promise has had nothing behind it. `credit_note` and the `CN` document
-- series have been in the schema since the first migration with no code that
-- writes either, so the only ways to undo a mistake were to void the sale —
-- which erases exactly what a tax authority came to see — or to leave it wrong.
--
-- THE APPROVAL IS THE FEATURE, and the table as written could not hold one.
-- Both `raised_by` and `approved_by` were NOT NULL, so a credit note could only
-- exist already approved: there was no row to represent the state that actually
-- happens in a restaurant, which is a cashier standing in front of a guest with
-- a manager on their way over. A pending note is now a real row, and NOTHING is
-- posted until somebody with the rank says yes.
--
-- AND THE NUMBER IS ISSUED AT APPROVAL, not before. `chain.next_doc_no` is
-- gapless because a tax authority asks about gaps; handing a number to a note
-- that is then declined would put a hole in the series that nobody can explain
-- years later. A pending note has no number because it is not yet a document.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name, db_role FROM chain.outlet LOOP
    EXECUTE format($q$
      ALTER TABLE %1$I.credit_note
        ALTER COLUMN approved_by DROP NOT NULL,
        ALTER COLUMN cn_no DROP NOT NULL,
        ADD COLUMN IF NOT EXISTS approved_at timestamptz,
        ADD COLUMN IF NOT EXISTS declined_at timestamptz,
        ADD COLUMN IF NOT EXISTS declined_by uuid,
        ADD COLUMN IF NOT EXISTS decline_reason text,
        -- Where the money went back. A credit note that reduces a house account
        -- moves no cash at all, and one refunded to a card will shrink the next
        -- settlement batch — three different postings, so the choice is stored.
        ADD COLUMN IF NOT EXISTS refund_method text,
        ADD COLUMN IF NOT EXISTS goods numeric(12,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS service numeric(12,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS journal_id uuid,
        ADD COLUMN IF NOT EXISTS business_date date;

      -- What is being credited, line by line. A credit note for one burnt steak
      -- off a table of nine is the ordinary case; crediting a whole sale is the
      -- rare one. Per line also means the same line cannot be credited twice
      -- for more than it was sold for, which is the check that matters.
      CREATE TABLE IF NOT EXISTS %1$I.credit_note_line (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        credit_note_id uuid NOT NULL REFERENCES %1$I.credit_note(id) ON DELETE CASCADE,
        sale_line_id uuid NOT NULL REFERENCES %1$I.sale_line(id),
        item_id      text NOT NULL,
        name         text NOT NULL,
        qty          numeric(10,3) NOT NULL CHECK (qty > 0),
        -- NET of tax, like sale_line.line_total, so the two can be compared
        -- without either being re-grossed.
        amount       numeric(12,2) NOT NULL,
        -- Did the goods come back? A returned bottle of wine goes back on the
        -- shelf; a steak sent back does not. Defaulting this to true would
        -- quietly invent stock that is in a bin.
        restock      boolean NOT NULL DEFAULT false
      );
      CREATE INDEX IF NOT EXISTS cn_line_note ON %1$I.credit_note_line (credit_note_id);
      CREATE INDEX IF NOT EXISTS cn_line_sale_line ON %1$I.credit_note_line (sale_line_id);
      CREATE INDEX IF NOT EXISTS cn_sale ON %1$I.credit_note (sale_id);

      -- A note is pending, approved or declined, and never two of those.
      ALTER TABLE %1$I.credit_note DROP CONSTRAINT IF EXISTS cn_one_fate;
      ALTER TABLE %1$I.credit_note ADD CONSTRAINT cn_one_fate
        CHECK (approved_at IS NULL OR declined_at IS NULL);
      -- An approved note is a DOCUMENT: it has a number and somebody's name on
      -- it. The constraint is here rather than in the code because this is the
      -- rule a tax inspection turns on.
      ALTER TABLE %1$I.credit_note DROP CONSTRAINT IF EXISTS cn_approved_is_a_document;
      ALTER TABLE %1$I.credit_note ADD CONSTRAINT cn_approved_is_a_document
        CHECK (approved_at IS NULL OR (cn_no IS NOT NULL AND approved_by IS NOT NULL));
    $q$, o.schema_name);

    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
  END LOOP;
END $$;
