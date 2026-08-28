/* ═══ 047 · THE ASK CARRIES THE ANSWER ══════════════════════════════════════
   "Ask for the bill" composes a whole decision on the guest's phone — which
   tender they will pay by, the tip, an even or by-dish split, their share of
   it, a promo — and the network path threw all of it away: the request door
   took a kind and a line of text, so the intent survived only in
   localStorage, which reaches a till only when the till shares the browser.
   The one path a real restaurant uses — the guest's own phone on the guest's
   own network — delivered "T5 asked for the bill" and nothing else, and the
   pay screen pre-selected nothing.

   `pay` is the intent, as a row the till can read back: tender, tip, due,
   split, parts, guestRef, promo, points. jsonb rather than eight columns
   because this is a MESSAGE, not a ledger figure — nothing joins on a tip
   percentage, and the sale that eventually settles carries its own money
   columns. The floor board's text stays in `detail`, because a board is read
   by a person. */
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'outlet\_%' LOOP
    EXECUTE format(
      'ALTER TABLE %I.guest_request ADD COLUMN IF NOT EXISTS pay jsonb', s);
  END LOOP;
END $$;
