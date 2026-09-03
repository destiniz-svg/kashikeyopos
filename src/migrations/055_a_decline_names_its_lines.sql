/* ═══ 055 · A DECLINE NAMES ITS LINES ═══════════════════════════════════════
   A counter that cannot make one dish in a round cooks the rest — that is what
   `acceptQr(sig, skip, why)` and `H.qr_order` already do, setting `ticket_id`
   for the part accepted and `rejected_reason` for the part that was not, in
   one statement.

   What the outlet recorded about the refused part was a SENTENCE. "Sorry — no
   Pancakes tonight" is exactly right for the guest to read and it is prose:
   nothing downstream can act on it. So the phone went on listing the pancakes
   under ROUNDS SENT, beside the two dishes that were actually coming, with a
   note underneath saying one of them was not. The guest is left to match a
   sentence against a list and work out which line it means.

   This is the settled-receipt defect one field along, and it takes the same
   answer the projection already gives everywhere else in this build: SAY IT AS
   DATA. `rejected_lines` carries the entries the counter marked unavailable —
   the index within the round, the item id, the name as the till resolved it,
   and the quantity — so the phone drops exactly those lines and nothing has to
   parse a sentence to find out which food is not coming.

   The name rides with the id ON PURPOSE. A guest's phone holds no menu for a
   dish this outlet has since deleted or renamed, and "your Pancakes were not
   available" is the whole point of the message; an id it cannot resolve would
   render as nothing at all. It is the till's own resolution at the moment of
   the decision, which is also what the sentence was composed from, so the two
   can never disagree about which dish was refused.

   NULL IS A REAL ANSWER, and it is two different ones — which is why this is
   nullable rather than defaulted to an empty array:

     · a WHOLE round declined. `ticket_id` is NULL and `rejected_reason` is
       set, so nothing was cooked and there is no subset to name. Writing every
       line in here would be true and would also make "some of this round is
       coming" indistinguishable from "none of it is" without reading a second
       column;
     · a round decided by a build older than this one. Those rows are what they
       were written as, and a migration must not invent which line a counter
       meant — the same rule 054 keeps about the shifts it found open.

   Both read as "this row does not name a subset", which is the honest answer,
   and the phone falls back to the sentence exactly as it does today.

   No index: this is read only through `guest_order`'s own two-hour window,
   which `guest_order_open` and the projection's `accepted_at` bound already. */
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'outlet\_%' LOOP
    EXECUTE format('ALTER TABLE %I.guest_order'
      || ' ADD COLUMN IF NOT EXISTS rejected_lines jsonb', s);
    /* A subset can only exist where something was refused. A row naming lines
       with no reason beside them is a decline nobody worded, which is the one
       thing `declineQr()` refuses at the till and the handler refuses at the
       door — so the database refuses it too, rather than trusting both. */
    EXECUTE format('ALTER TABLE %I.guest_order'
      || ' DROP CONSTRAINT IF EXISTS guest_order_rejected_lines_need_a_reason', s);
    EXECUTE format('ALTER TABLE %I.guest_order'
      || ' ADD CONSTRAINT guest_order_rejected_lines_need_a_reason'
      || ' CHECK (rejected_lines IS NULL OR rejected_reason IS NOT NULL)', s);
  END LOOP;
END $$;
