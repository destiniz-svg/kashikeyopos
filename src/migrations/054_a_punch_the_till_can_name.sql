/* ═══ 054 · A PUNCH THE TILL CAN NAME ═══════════════════════════════════════
   `clock_entry.id` is a bigserial the OUTLET allocates, and clocking out is
   `UPDATE clock_entry SET out_at = ... WHERE id = $1`. The till mints its own
   id for the row it draws the instant somebody punches in — it has to, because
   a shift starts on a device that may be dark — and then sends that id back
   when the same person taps to clock out. The two are never equal, so the
   update matched NOTHING: every clock-out this build has ever taken said so on
   screen and closed no shift at the outlet.

   That is the same problem `sale.client_id` (043) and `ticket_line.client_id`
   (008) already answer: a row created offline has to be nameable before any
   server has seen it, or the second half of the act is unsendable. A punch is
   exactly that, and it is worse than a receipt — an open shift ACCRUES, so a
   clock-out that reached nowhere is not a missing link, it is a wage bill that
   goes on growing until somebody finds it.

   NULL is a real answer and the column stays nullable: a build older than this
   sends none, and a punch made by an earlier terminal is still a punch. It is
   UNIQUE where present, because it is the till's way of saying "that shift"
   and two rows under one name make that ambiguous — the same reason 043 gives.

   No foreign key and no default: the id belongs to the device that minted it,
   and a row the outlet created itself has no client name to invent.

   WHAT THIS DELIBERATELY DOES NOT DO IS CLOSE THE SHIFTS THAT WERE STRANDED.
   Because the update never matched, every punch any store has ever made is
   still open, and the first draft of this migration added a partial unique
   index — one open entry per employee — which is the right rule and would have
   REFUSED TO APPLY on any store that has used the clock twice. A migration
   that refuses to apply is worse than a handler that converges, which is the
   lesson `vendor_upsert` already paid for.

   Nor may it invent an `out_at`. Nobody knows when those people went home, and
   a made-up finish time is a wage figure somebody could be paid on. So the
   stranded rows stay exactly as they were written, the terminal draws them
   apart from today's floor as shifts left open, and a manager closes each one
   at a time they state. The rule itself lives in `H.clock_in`, which refuses a
   second open punch for the same person ON THE SAME BUSINESS DATE — the day
   is load-bearing, because refusing on any open entry at all would lock every
   person with a stranded shift out of the clock for ever. */
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'outlet\_%' LOOP
    EXECUTE format('ALTER TABLE %I.clock_entry'
      || ' ADD COLUMN IF NOT EXISTS client_id text', s);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS clock_client_id'
      || ' ON %I.clock_entry (client_id) WHERE client_id IS NOT NULL', s);
    /* The open ones are what every screen and every wage figure reads first,
       and there is one per person per shift on a table that only grows. */
    EXECUTE format('CREATE INDEX IF NOT EXISTS clock_open'
      || ' ON %I.clock_entry (employee_id, business_date) WHERE out_at IS NULL', s);
  END LOOP;
END $$;
