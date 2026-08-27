/* ═══ A SALE THE TILL CAN NAME ══════════════════════════════════════════════
   A sale's id and its receipt number are both allocated by the OUTLET: the id
   is a uuid default, the number comes from `chain.doc_series`. Both are right
   — a document number is a statutory sequence and cannot be minted on a device
   that has been offline all evening. But it leaves the till holding a bill it
   has no way to point at afterwards.

   That is the same problem `ticket_line.client_id` already answers, one row
   up: a line created offline has to be nameable before any server has seen it,
   or "void the second line" is unsendable. A settled bill is exactly that —
   the guest is standing there asking for it on WhatsApp, and the till cannot
   say WHICH bill to the outlet that holds it.

   Found by settling a bill in a browser: the Send control on the settled
   receipt stayed disabled for ever, because it matched the outlet's row by
   receipt NUMBER and the two numbers are minted by different allocators. The
   control said "once this bill reaches the outlet" while the bill was already
   there.

   So the till names the sale, the outlet keeps the name, and the bootstrap
   publishes it back. NULL is a real answer and stays allowed: a bill rung by a
   build older than this one has no name, and inventing one would be worse than
   a control that honestly stays disabled.

   UNIQUE, because the name is the till's idempotency key for its own bill —
   two rows under one name would make "that bill" ambiguous, which is the whole
   thing being fixed. Partial, so the unnamed history does not collide. */
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'outlet\_%' LOOP
    EXECUTE format('ALTER TABLE %I.sale ADD COLUMN IF NOT EXISTS client_id text', s);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS sale_client_id ON %I.sale'
      || ' (client_id) WHERE client_id IS NOT NULL', s);
  END LOOP;
END $$;
