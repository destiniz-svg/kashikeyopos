-- ═══ A LINE NEEDS AN IDENTITY THE TILL CAN NAME ════════════════════════════
-- An open ticket belongs to the OUTLET, not to the device that opened it. A
-- waiter's tablet takes the order; the counter settles it; the pass fires it.
-- All three have to be looking at the same ticket.
--
-- The obstacle was identity. The terminal creates a line offline, so it cannot
-- wait for a server id to name it — and without a name, "void the second line"
-- and "add a note to the third" are unsendable, so the whole open ticket stayed
-- on one device and the other terminals saw an empty floor.
--
-- So a line carries the id the till gave it. It is unique per ticket, which
-- makes `add_line` idempotent under replay: the same line sent twice is one
-- line, not two, whatever the network did.
-- ═══════════════════════════════════════════════════════════════════════════

DO $mig$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name FROM chain.outlet WHERE schema_name IS NOT NULL LOOP
    EXECUTE format('ALTER TABLE %I.ticket_line ADD COLUMN IF NOT EXISTS client_id text',
                   o.schema_name);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS ticket_line_client'
      || ' ON %I.ticket_line(ticket_id, client_id) WHERE client_id IS NOT NULL',
      o.schema_name);
  END LOOP;
END $mig$;
