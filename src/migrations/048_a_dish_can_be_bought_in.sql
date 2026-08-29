/* ═══ 048 · A DISH CAN BE BOUGHT IN, AND A CHANNEL IS A SECOND AXIS ═════════
   Most Maldivian outlets sell a mix: curries cooked in the kitchen, and
   hedhika, pastry and bottled drinks that arrive READY TO SELL — from a
   supplier, or from a person with a tray at seven in the morning. Those two
   kinds behave differently everywhere, from one nullable link:

     buy_item IS NULL      → made here: costed from its recipe, its
                             ingredients leave the shelf through the recipe
     buy_item IS NOT NULL  → bought in: costed from the supplier's last
                             price, one sale takes 1/buy_pack of the linked
                             stock item itself off the shelf, and the KOT
                             goes nowhere because nothing is cooked

   `buy_pack` is the field most tills forget: the supplier delivers a box,
   the guest buys a piece. One stock unit × pack = sellable units. Get it
   wrong and the count is wrong from the first delivery, quietly.

   AND A THIRD SWITCH, DELIBERATELY. `off_menu` (hidden — a decision that
   lasts, off every channel) and `sold_out_reason` (86 — tonight's stock
   talking) already exist and are different columns on purpose. `qr_off` is
   the third question with the third lifespan: off the GUEST's phone — the
   table QR menu and the member portal — while the counter can still ring
   it. That is what a tray you will not restock needs. On the section too,
   because "take the whole thing off the phone" is a decision a cashier
   makes once, not per dish.

   THE DOOR RECEIPT. The gulha man is not a vendor invoice and a GRN pad —
   he is a tray, a count and a price, and the till has to take him in under
   a minute or the delivery never gets recorded at all. Same stock ledger,
   same audit line, one small document. A PERSON IS NOT A SUPPLIER RECORD:
   a one-off cash purchase must not pollute the supplier master, but the
   name is mandatory, because MIRA can ask who was paid and "a man with a
   tray" is not an answer. Blind receiving is enforced where the handler
   applies the op, not only where the form hides a field: a rate from a
   rank-2 caller is refused by name. */
DO $$
DECLARE s text; outlet_id int;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'outlet\_%' LOOP
    EXECUTE format('ALTER TABLE %I.item'
      || ' ADD COLUMN IF NOT EXISTS buy_item text,'
      || ' ADD COLUMN IF NOT EXISTS buy_vendor uuid,'
      || ' ADD COLUMN IF NOT EXISTS buy_pack int NOT NULL DEFAULT 1,'
      || ' ADD COLUMN IF NOT EXISTS qr_off boolean NOT NULL DEFAULT false', s);
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = s AND t.relname = 'item' AND c.conname = 'item_buy_pack_serves'
    ) THEN
      EXECUTE format('ALTER TABLE %I.item ADD CONSTRAINT item_buy_pack_serves'
        || ' CHECK (buy_pack >= 1)', s);
    END IF;
    EXECUTE format('ALTER TABLE %I.menu_category'
      || ' ADD COLUMN IF NOT EXISTS qr_off boolean NOT NULL DEFAULT false', s);

    EXECUTE format($ddl$
      CREATE TABLE IF NOT EXISTS %1$I.door_receipt (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        no          text NOT NULL UNIQUE,
        received_on date NOT NULL DEFAULT current_date,
        -- A supplier from the master, OR a named person. One of the two.
        supplier_id uuid,
        person      text,
        docket      text,
        -- Cash paid at the door never becomes a payable: the money already
        -- left the drawer, and a second claim on it at month end is a real
        -- reconciliation break.
        paid_cash   boolean NOT NULL DEFAULT true,
        total       numeric(12,2) NOT NULL DEFAULT 0,
        -- `unpriced` is BLIND receiving: the count is only evidence if the
        -- person counting could not see the expected figure. A manager
        -- prices it afterwards, and that is what their bill gets checked
        -- against.
        status      text NOT NULL DEFAULT 'unpriced'
                    CHECK (status IN ('unpriced', 'received')),
        by_staff    uuid,
        by_rank     smallint,
        device_id   text,
        notes       text,
        at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT door_receipt_who
          CHECK (supplier_id IS NOT NULL OR nullif(btrim(person), '') IS NOT NULL),
        CONSTRAINT door_receipt_not_future CHECK (received_on <= current_date)
      );
      CREATE TABLE IF NOT EXISTS %1$I.door_line (
        receipt_id uuid NOT NULL REFERENCES %1$I.door_receipt(id) ON DELETE CASCADE,
        ingredient_id text NOT NULL REFERENCES %1$I.ingredient(id),
        qty        numeric(12,3) NOT NULL CHECK (qty > 0),
        rate       numeric(12,2) NOT NULL DEFAULT 0 CHECK (rate >= 0),
        PRIMARY KEY (receipt_id, ingredient_id)
      );
    $ddl$, s);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %1$I.door_receipt,'
      || ' %1$I.door_line TO %2$I', s, s || '_app');

    -- The DD document series, for every outlet that already exists. New
    -- outlets get theirs from chain.provision_outlet.
    outlet_id := substring(s FROM 'outlet_(\d+)')::int;
    INSERT INTO chain.doc_series (outlet_id, kind, prefix)
    SELECT o.id, 'DD', o.code || '-DD' FROM chain.outlet o WHERE o.id = outlet_id
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
