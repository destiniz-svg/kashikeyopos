/* ═══ 058 · A LATER COVERS WINS ═════════════════════════════════════════════
   Two waiters, two devices, both offline, both retype the covers on one
   table. Reconnect and whichever push happened to land second at the server
   simply overwrote the first — never told, never asked, and the earlier
   change was gone with nothing on either screen to say so.

   `ticket.version` is not a row counter. It is the LAMPORT of whichever
   scalar edit last won this ticket — `covers_update`, `move_table` and
   `ticket_status` each carry the op's own lamport (`queue()` has always
   stamped one, `app/kashikeyo-api.js` line ~929) and only apply when it is
   GREATER than the version already stored, which is what makes "wins by
   Lamport order" true regardless of which push reaches the outlet first: a
   device holding the causally later edit still wins even if its network is
   slower. The loser is not a network failure — the outlet answered — so it
   is never parked or retried; the handler hands back the value that won, and
   the device that lost is told once, on the same push response.

   Zero is a real "no opinion yet": every ticket already open when this ships
   has a version of 0, so its very next scalar edit applies unconditionally
   (any lamport beats zero) exactly as every edit before this migration did.
   An old client that never learned to send a lamport sends none, `apply.js`
   treats that the same as it always has — last-write-wins with no version
   check at all, because a device that cannot name what it is comparing
   against cannot lose a comparison either. */
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'outlet\_%' LOOP
    EXECUTE format('ALTER TABLE %I.ticket'
      || ' ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0', s);
  END LOOP;
END $$;
