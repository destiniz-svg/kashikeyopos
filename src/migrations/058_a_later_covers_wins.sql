/* ═══ 058 · A LATER EDIT WINS, FIELD BY FIELD ════════════════════════════════
   Two waiters, two devices, both offline, both retype the covers on one
   table. Reconnect and whichever push landed second simply overwrote the
   first — never told, and the earlier change gone with nothing to say so.

   `party_lamport`, `table_lamport` and `note_lamport` are not counters.
   Each is the LAMPORT of whichever edit last won THAT field. `covers_update`,
   `move_table` and `ticket_status` carry the op's own lamport and apply only
   when it is GREATER than that field's stamp, so the causally later edit wins
   whichever push reaches the outlet first. One stamp per field, not per
   ticket: a single stamp turns a covers change into a refusal of a table move
   nobody else made, which drops a real edit to fix a conflict that was not
   there. The loser is not a network failure — the outlet answered — so it is
   never parked or retried; the device that lost is told the value that won.

   Zero is "no opinion yet": a ticket open when this ships takes its next edit
   unconditionally, as every edit before this did. An op carrying no lamport
   (an older client) is applied as it always was, with no stamp check at all:
   a device that names no clock cannot lose a comparison against one. */
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'outlet\_%' LOOP
    EXECUTE format('ALTER TABLE %I.ticket'
      || ' ADD COLUMN IF NOT EXISTS party_lamport bigint NOT NULL DEFAULT 0,'
      || ' ADD COLUMN IF NOT EXISTS table_lamport bigint NOT NULL DEFAULT 0,'
      || ' ADD COLUMN IF NOT EXISTS note_lamport bigint NOT NULL DEFAULT 0', s);
  END LOOP;
END $$;
