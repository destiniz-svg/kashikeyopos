-- ═══════════════════════════════════════════════════════════════════════════
-- Who the bill belongs to, and putting it down — 02-POS-SPEC.md §3.3 and §3.5.
--
-- TWO THINGS THE SCHEMA ALREADY HALF-KNEW, and one it did not know at all.
--
-- 1. A GUEST HAS NO NAME. §3.3: "every line belongs to a guest (Guest 1, or A
--    NAMED MEMBER). One model covers split bills AND several parties sharing
--    one table." The model is right — a split IS a ticket, so `ticket.split`
--    already separates them — but the chips read "Guest 2" and nothing else,
--    and a cashier holding four separate bills on one table has no way to tell
--    the server which is whose. `guest_name` is a column on the ticket because
--    that is exactly where the split lives.
--
-- 2. `status` HAS ALWAYS ALLOWED 'held' AND NOTHING HAS EVER WRITTEN IT. The
--    CHECK constraint has listed open|held|closed|void since migration 003,
--    which means §3.5's parked tickets were designed for and then never built:
--    a party that moves to the bar, a walk-in that has to give the table back
--    before the card machine frees up, a bill somebody wants set aside — all of
--    them today can only be settled or written off. `hold_ref` gives the parked
--    bill the reference §3.5 asks for ("HOLD- + sequence"), and the doc series
--    below mints it from the same counter every other document in this system
--    uses, so it is unique per outlet and has no gaps.
--
--    PARKING FREES THE TABLE, and it does so for free: the partial unique index
--    `ticket_open_table` covers `WHERE status = 'open'`, so a held ticket stops
--    reserving its (table, split) the moment it is parked and the next party
--    can be seated. Resuming has to find the table free again — which is the
--    honest constraint, not an oversight, because two bills open on one table
--    at the same split is precisely what that index exists to prevent.
--
-- 3. A LINE HAS A NOTE COLUMN AND NO WAY TO WRITE ONE. `ticket_line.note` has
--    also existed since migration 003. The kitchen path passes it through, the
--    KDS prints it, the receipt shows it — and no screen in this build has ever
--    been able to put one there. "No onion", "allergy — nuts", "fire with the
--    mains" are the three things a server says out loud all night. Nothing in
--    THIS migration is needed for that; it is noted here because the reader of
--    §3.3 will look for it, and the answer is that it was a UI gap, not a
--    schema one.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^outlet_[0-9]+$' LOOP
    EXECUTE format($ddl$
      -- Whose bill this split is. NULL means nobody has said, and the till
      -- draws "Guest 2" as it always has -- a party that has not asked to be
      -- named should not be made to be.
      ALTER TABLE %1$I.ticket ADD COLUMN IF NOT EXISTS guest_name text;

      -- The parked bill's reference (§3.5). NULL for every ticket that has
      -- never been put down, which is almost all of them.
      ALTER TABLE %1$I.ticket ADD COLUMN IF NOT EXISTS hold_ref text;
      ALTER TABLE %1$I.ticket ADD COLUMN IF NOT EXISTS held_at timestamptz;
      ALTER TABLE %1$I.ticket ADD COLUMN IF NOT EXISTS held_by uuid;
    $ddl$, s);
  END LOOP;
END $$;

-- A held ticket is looked up by its reference from the parked strip, and there
-- are never many of them -- but the lookup is by ref and the index says so.
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^outlet_[0-9]+$' LOOP
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS ticket_hold_ref ON %1$I.ticket (hold_ref)'
      ' WHERE hold_ref IS NOT NULL', s);
  END LOOP;
END $$;

-- ── the parked ticket's own counter ────────────────────────────────────────
-- Its own series, not a borrowed one: HOLD-000004 following HOLD-000003 is the
-- property that lets a cashier read a reference off a printed slip and find the
-- bill. Borrowing SALE's counter would leave gaps in the receipt numbers, which
-- is the one series a tax authority reads.
INSERT INTO chain.doc_series (outlet_id, kind, prefix)
SELECT id, 'HOLD', code || '-HOLD' FROM chain.outlet
ON CONFLICT DO NOTHING;
