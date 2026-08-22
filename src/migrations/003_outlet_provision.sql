-- ═══ PER-OUTLET DATA PLANE ═════════════════════════════════════════════════
-- chain.provision_outlet() builds an outlet its own schema, its own login role
-- and its own document series, then grants that role USAGE on nothing but its
-- own schema. Two outlets share an instance and share no reachable object.
--
-- The chain of consequence is the spine of this schema:
--   ticket -> sale -> payment -> tax -> stock_move -> journal -> settlement
-- Every table carries who, when and on which device, because that is what
-- makes the trail auditable.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION chain.provision_outlet(
  p_id int, p_code text, p_name text, p_role_password text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  s text := 'outlet_' || p_id::text;
  r text := 'outlet_' || p_id::text || '_app';
BEGIN
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', s);

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOINHERIT', r, p_role_password);
  ELSE
    EXECUTE format('ALTER ROLE %I PASSWORD %L', r, p_role_password);
  END IF;

  -- The role reaches its own schema and the control plane, nothing else. No
  -- CREATE, so it cannot add an object that escapes these grants.
  EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', r);
  EXECUTE format('GRANT USAGE ON SCHEMA %I, chain, app TO %I', s, r);
  EXECUTE format('ALTER ROLE %I SET search_path = %I, chain, public', r, s);

  -- ══ FLOOR AND SERVICE ═══════════════════════════════════════════════════
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %1$I.zone (
      id      text PRIMARY KEY,
      name    text NOT NULL,
      pos     int  NOT NULL DEFAULT 0,
      active  boolean NOT NULL DEFAULT true
    );
    -- The floor plan is a saved list of tables, not a count. A restaurant adds
    -- a two-top, pushes two together for a party of eight, or takes the
    -- terrace out of service for a week — none of which a number can express.
    CREATE TABLE IF NOT EXISTS %1$I.table_def (
      id      text PRIMARY KEY,
      label   text NOT NULL,
      zone_id text REFERENCES %1$I.zone(id),
      seats   int  NOT NULL DEFAULT 4 CHECK (seats > 0),
      pos     int  NOT NULL DEFAULT 0,
      shape   text NOT NULL DEFAULT 'square',
      status  text NOT NULL DEFAULT 'free'
              CHECK (status IN ('free','occupied','reserved','out')),
      active  boolean NOT NULL DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS %1$I.ticket (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      table_no    text,
      split       int NOT NULL DEFAULT 0,
      channel     text NOT NULL DEFAULT 'dine_in',
      status      text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','held','closed','void')),
      covers      int NOT NULL DEFAULT 1 CHECK (covers >= 1),
      party       int NOT NULL DEFAULT 0,
      business_date date NOT NULL DEFAULT current_date,
      opened_at   timestamptz NOT NULL DEFAULT now(),
      closed_at   timestamptz,
      opened_by   uuid, closed_by uuid, device_id uuid,
      server_name text,
      member_id   uuid,
      note        text,
      guests      jsonb NOT NULL DEFAULT '[]',
      -- WHERE THE FOOD IS, on the same four rungs the guest's tracker reads:
      -- 0 taking the order, 1 in the kitchen, 2 ready at the pass, 3 served.
      -- `status` above is a different question — the bill's lifecycle — and a
      -- served table that has not paid is the row a manager is looking for.
      stage       smallint NOT NULL DEFAULT 0,
      stage_at    timestamptz, stage_by uuid,
      CONSTRAINT ticket_stage_rung CHECK (stage BETWEEN 0 AND 3),
      CONSTRAINT closed_has_time CHECK (status <> 'closed' OR closed_at IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ticket_open_table
      ON %1$I.ticket(table_no, split) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS ticket_status ON %1$I.ticket(status);

    CREATE TABLE IF NOT EXISTS %1$I.ticket_line (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id  uuid NOT NULL REFERENCES %1$I.ticket(id) ON DELETE CASCADE,
      item_id    text NOT NULL,
      name       text NOT NULL,
      qty        numeric(10,3) NOT NULL CHECK (qty > 0),
      unit_price numeric(12,2) NOT NULL,
      addons     jsonb NOT NULL DEFAULT '[]',
      guest_ix   int NOT NULL DEFAULT 0,
      note       text,
      course     text,
      station    text,
      -- The id the TILL gave this line. A line is created offline, so it
      -- cannot wait for a server id to be nameable — and without a name, "void
      -- the second line" is unsendable. Unique per ticket, which also makes
      -- add_line idempotent under replay.
      client_id  text,
      sent_at    timestamptz,
      -- When the pass finished it. A bump that lives only in the browser is a
      -- bump the next tablet never sees, and one refresh puts the whole table
      -- back on the kitchen screen.
      ready_at   timestamptz, ready_by uuid,
      void_at    timestamptz, void_by uuid, void_reason text,
      by_staff   uuid, device_id uuid,
      at         timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT line_ready_was_fired CHECK (ready_at IS NULL OR sent_at IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS ticket_line_ticket ON %1$I.ticket_line(ticket_id);
    CREATE INDEX IF NOT EXISTS ticket_line_cooking ON %1$I.ticket_line(ticket_id)
      WHERE sent_at IS NOT NULL AND ready_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ticket_line_client
      ON %1$I.ticket_line(ticket_id, client_id) WHERE client_id IS NOT NULL;

    -- Booked -> confirmed -> arrived -> seated. A booking's guest name, phone
    -- and kitchen note travel to the ticket without anyone re-keying them.
    CREATE TABLE IF NOT EXISTS %1$I.reservation (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      guest_name text NOT NULL,
      phone     text,
      member_id uuid,
      party     int NOT NULL CHECK (party >= 1),
      at        timestamptz NOT NULL,
      duration_mins int NOT NULL DEFAULT 90,
      zone_id   text,
      table_no  text,
      status    text NOT NULL DEFAULT 'booked'
                CHECK (status IN ('booked','confirmed','arrived','seated','no_show','cancelled')),
      note      text,
      ticket_id uuid REFERENCES %1$I.ticket(id),
      made_by   uuid, made_at timestamptz NOT NULL DEFAULT now(),
      seated_at timestamptz, seated_by uuid
    );
    CREATE INDEX IF NOT EXISTS reservation_at ON %1$I.reservation(at);
  $ddl$, s);

  -- ══ THE SALE ════════════════════════════════════════════════════════════
  -- One shape, whichever screen settled it. `net` is AFTER discount; the
  -- pre-discount subtotal is never booked as revenue. `total` is what the
  -- guest handed over, and on a rounded cash sale that is not net+svc+tax —
  -- the difference is `rounding`, posted to its own account.
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %1$I.sale (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      receipt_no    text NOT NULL UNIQUE,
      ticket_id     uuid REFERENCES %1$I.ticket(id),
      at            timestamptz NOT NULL DEFAULT now(),
      business_date date NOT NULL,
      channel       text NOT NULL DEFAULT 'dine_in',
      covers        int NOT NULL DEFAULT 1 CHECK (covers >= 1),
      subtotal      numeric(12,2) NOT NULL,          -- goods, gross of discount
      discount      numeric(12,2) NOT NULL DEFAULT 0,
      discount_code text,
      discount_reason text,
      discount_by   uuid,
      net           numeric(12,2) NOT NULL,          -- subtotal - discount
      service       numeric(12,2) NOT NULL DEFAULT 0,
      tax_code      text NOT NULL,
      tax_label     text NOT NULL,
      tax_rate      numeric(5,2) NOT NULL,           -- recorded, never re-derived
      tax           numeric(12,2) NOT NULL,
      rounding      numeric(12,2) NOT NULL DEFAULT 0,
      total         numeric(12,2) NOT NULL,
      tip           numeric(12,2) NOT NULL DEFAULT 0,
      cogs          numeric(12,2) NOT NULL DEFAULT 0,
      currency      text NOT NULL DEFAULT 'MVR',
      fx_rate       numeric(12,6) NOT NULL DEFAULT 1,
      fx_amount     numeric(12,2) NOT NULL DEFAULT 0,
      member_id     uuid,
      customer_name text,
      server_name   text,
      closed_by     uuid NOT NULL, device_id uuid,
      voided_at     timestamptz, voided_by uuid,
      -- What the terminal said the bill came to, kept beside what the books
      -- make it. The server never REJECTS a sale — a cashier has already taken
      -- the money — so a mismatch is repaired into a consistent row and the
      -- discrepancy is stamped here for someone to answer for.
      client_total  numeric(12,2),
      server_audit  jsonb,
      CONSTRAINT sale_nets CHECK (round(subtotal - discount, 2) = round(net, 2)),
      CONSTRAINT sale_adds_up CHECK (
        round(net + service + tax + rounding, 2) = round(total, 2))
    );
    CREATE INDEX IF NOT EXISTS sale_date ON %1$I.sale(business_date);
    CREATE INDEX IF NOT EXISTS sale_at ON %1$I.sale(at DESC);

    CREATE TABLE IF NOT EXISTS %1$I.sale_line (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sale_id    uuid NOT NULL REFERENCES %1$I.sale(id) ON DELETE CASCADE,
      item_id    text NOT NULL, name text NOT NULL,
      qty        numeric(10,3) NOT NULL,
      unit_price numeric(12,2) NOT NULL,   -- tax-inclusive, for display
      line_total numeric(12,2) NOT NULL,   -- rounded once, net of tax
      unit_cost  numeric(12,4) NOT NULL DEFAULT 0,
      line_cost  numeric(12,2) NOT NULL DEFAULT 0,
      addons     jsonb NOT NULL DEFAULT '[]',
      guest_ix   int NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS sale_line_sale ON %1$I.sale_line(sale_id);

    CREATE TABLE IF NOT EXISTS %1$I.payment (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sale_id   uuid NOT NULL REFERENCES %1$I.sale(id),
      method    text NOT NULL,             -- cash|card|transfer|wallet|points|credit|fx
      amount    numeric(12,2) NOT NULL,    -- always MVR, the book currency
      currency  text NOT NULL DEFAULT 'MVR',
      fx_amount numeric(12,2),
      fx_rate   numeric(12,6),
      tendered  numeric(12,2),
      change_given numeric(12,2),
      tip       numeric(12,2) NOT NULL DEFAULT 0,
      auth_ref  text,
      batch_id  uuid,
      taken_by  uuid, device_id uuid,
      at        timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS payment_sale ON %1$I.payment(sale_id);
    CREATE INDEX IF NOT EXISTS payment_batch ON %1$I.payment(batch_id);

    -- A refund is a reversing document, never an edit of the original.
    CREATE TABLE IF NOT EXISTS %1$I.credit_note (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cn_no     text NOT NULL UNIQUE,
      sale_id   uuid REFERENCES %1$I.sale(id),
      at        timestamptz NOT NULL DEFAULT now(),
      business_date date NOT NULL DEFAULT current_date,
      lines     jsonb NOT NULL DEFAULT '[]',
      net       numeric(12,2) NOT NULL,
      tax       numeric(12,2) NOT NULL DEFAULT 0,
      service   numeric(12,2) NOT NULL DEFAULT 0,
      amount    numeric(12,2) NOT NULL,
      method    text NOT NULL DEFAULT 'cash',
      reason    text NOT NULL,
      raised_by uuid NOT NULL, approved_by uuid NOT NULL
    );

    CREATE TABLE IF NOT EXISTS %1$I.settlement_batch (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      acquirer   text NOT NULL, batch_no text NOT NULL,
      value_date date NOT NULL,
      gross      numeric(12,2) NOT NULL,
      mdr_pct    numeric(5,3) NOT NULL DEFAULT 0,
      fee        numeric(12,2) NOT NULL DEFAULT 0,
      net        numeric(12,2) NOT NULL,
      expected_net numeric(12,2) NOT NULL DEFAULT 0,
      variance   numeric(12,2) NOT NULL DEFAULT 0,
      state      text NOT NULL DEFAULT 'open'
                 CHECK (state IN ('open','matched','short','reopened')),
      matched_at timestamptz, matched_by uuid,
      UNIQUE (acquirer, batch_no)
    );

    CREATE TABLE IF NOT EXISTS %1$I.drawer_session (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      opened_at    timestamptz NOT NULL DEFAULT now(),
      opened_by    uuid NOT NULL,
      float_amount numeric(12,2) NOT NULL DEFAULT 0,
      closed_at    timestamptz, closed_by uuid,
      counted      numeric(12,2), expected numeric(12,2),
      variance     numeric(12,2),
      note         text,
      device_id    uuid
    );
    CREATE UNIQUE INDEX IF NOT EXISTS drawer_one_open
      ON %1$I.drawer_session((closed_at IS NULL)) WHERE closed_at IS NULL;

    -- An override is a decision somebody made, so it is a row with a name on
    -- it, not a silently different price.
    CREATE TABLE IF NOT EXISTS %1$I.price_override (
      id       bigserial PRIMARY KEY,
      item_id  text NOT NULL,
      price    numeric(12,2) NOT NULL,
      reason   text NOT NULL,
      at       timestamptz NOT NULL DEFAULT now(),
      by_staff uuid NOT NULL,
      until    timestamptz
    );
  $ddl$, s);

  -- ══ MENU ════════════════════════════════════════════════════════════════
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %1$I.menu_section (
      id     text PRIMARY KEY,
      name   text NOT NULL,
      pos    int NOT NULL DEFAULT 0,
      colour text,
      active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS %1$I.menu_category (
      id         text PRIMARY KEY,
      name       text NOT NULL,
      section_id text REFERENCES %1$I.menu_section(id),
      pos        int NOT NULL DEFAULT 0,
      colour     text,
      active     boolean NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS %1$I.item (
      id          text PRIMARY KEY,
      name        text NOT NULL,
      category_id text REFERENCES %1$I.menu_category(id),
      station     text NOT NULL DEFAULT 'main',
      price       numeric(12,2) NOT NULL CHECK (price >= 0),
      yield_qty   numeric(10,3) NOT NULL DEFAULT 1 CHECK (yield_qty > 0),
      unit        text NOT NULL DEFAULT 'plate',
      prep_mins   int NOT NULL DEFAULT 12,
      description text,
      image       text,
      allergens   text[] NOT NULL DEFAULT '{}',
      diets       text[] NOT NULL DEFAULT '{}',
      tags        text[] NOT NULL DEFAULT '{}',
      active      boolean NOT NULL DEFAULT true,
      off_menu    boolean NOT NULL DEFAULT false,
      sold_out_reason text,
      pos         int NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS item_category ON %1$I.item(category_id);

    CREATE TABLE IF NOT EXISTS %1$I.modifier_group (
      id       text PRIMARY KEY,
      name     text NOT NULL,
      min_pick int NOT NULL DEFAULT 0,
      max_pick int NOT NULL DEFAULT 1,
      required boolean NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS %1$I.modifier (
      id       text PRIMARY KEY,
      group_id text NOT NULL REFERENCES %1$I.modifier_group(id) ON DELETE CASCADE,
      name     text NOT NULL,
      price    numeric(12,2) NOT NULL DEFAULT 0,
      pos      int NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS %1$I.item_modifier (
      item_id  text NOT NULL REFERENCES %1$I.item(id) ON DELETE CASCADE,
      group_id text NOT NULL REFERENCES %1$I.modifier_group(id) ON DELETE CASCADE,
      PRIMARY KEY (item_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS %1$I.promo (
      id        text PRIMARY KEY,
      name      text NOT NULL,
      kind      text NOT NULL DEFAULT 'percent' CHECK (kind IN ('percent','amount','item')),
      value     numeric(12,2) NOT NULL DEFAULT 0,
      code      text,
      max_pct   numeric(5,2) NOT NULL DEFAULT 100,
      channels  text[] NOT NULL DEFAULT '{}',
      starts_on date, ends_on date,
      active    boolean NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS %1$I.banner (
      id     text PRIMARY KEY,
      slot   text NOT NULL,
      title  text NOT NULL,
      body   text,
      image  text,
      link   text,
      starts_on date, ends_on date,
      active boolean NOT NULL DEFAULT true
    );
  $ddl$, s);

  -- ══ STOCK ═══════════════════════════════════════════════════════════════
  -- On-hand = opening + received here - consumed by recipes. The ledger is
  -- the source of truth; `on_hand` is a cache kept in step with it.
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %1$I.location (
      id     text PRIMARY KEY,
      name   text NOT NULL,
      kind   text NOT NULL DEFAULT 'store'
             CHECK (kind IN ('kitchen','store','freezer','chiller','bar','other')),
      active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS %1$I.ingredient (
      id          text PRIMARY KEY,
      name        text NOT NULL,
      category    text,
      base_unit   text NOT NULL,             -- g | ml | pcs
      stock_unit  text NOT NULL,             -- what the kitchen counts in
      stock_factor numeric(14,6) NOT NULL DEFAULT 1 CHECK (stock_factor > 0),
      on_hand     numeric(14,4) NOT NULL DEFAULT 0,
      avg_cost    numeric(14,6) NOT NULL DEFAULT 0,   -- per base unit
      par         numeric(14,4),
      min_stock   numeric(14,4),
      location_id text REFERENCES %1$I.location(id),
      supplier_id uuid,
      count_freq  text NOT NULL DEFAULT 'weekly',
      allergens   text[] NOT NULL DEFAULT '{}',
      sellable    boolean NOT NULL DEFAULT false,
      sell_price  numeric(12,2),
      product_id  text,
      producible  boolean NOT NULL DEFAULT false,
      active      boolean NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS %1$I.ingredient_unit (
      id            bigserial PRIMARY KEY,
      ingredient_id text NOT NULL REFERENCES %1$I.ingredient(id) ON DELETE CASCADE,
      name          text NOT NULL,
      factor        numeric(14,6) NOT NULL CHECK (factor > 0),
      UNIQUE (ingredient_id, name)
    );

    -- One line per component. A recipe line points at an ingredient OR at a
    -- sub-recipe item, never both — that is what makes the explosion terminate.
    CREATE TABLE IF NOT EXISTS %1$I.recipe_line (
      id            bigserial PRIMARY KEY,
      item_id       text NOT NULL,
      ingredient_id text REFERENCES %1$I.ingredient(id),
      sub_item_id   text REFERENCES %1$I.item(id),
      qty           numeric(14,6) NOT NULL CHECK (qty > 0),
      waste_pct     numeric(5,2) NOT NULL DEFAULT 0,
      CONSTRAINT one_component CHECK (
        (ingredient_id IS NOT NULL) <> (sub_item_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS recipe_item ON %1$I.recipe_line(item_id);

    -- The immutable signed ledger. Never updated, never deleted: a correction
    -- is another move, so the timeline stays readable.
    CREATE TABLE IF NOT EXISTS %1$I.stock_move (
      id            bigserial PRIMARY KEY,
      at            timestamptz NOT NULL DEFAULT now(),
      business_date date NOT NULL DEFAULT current_date,
      ingredient_id text NOT NULL REFERENCES %1$I.ingredient(id),
      qty           numeric(14,4) NOT NULL,      -- signed, in base units
      unit_cost     numeric(14,6) NOT NULL DEFAULT 0,
      value         numeric(12,2) NOT NULL DEFAULT 0,
      reason        text NOT NULL CHECK (reason IN
                    ('purchase','sale','refund','audit','manual','waste',
                     'transfer','produce','prep','opening')),
      location_id   text,
      sale_id       uuid REFERENCES %1$I.sale(id),
      batch_id      uuid,
      note          text,
      by_staff      uuid, device_id uuid
    );
    CREATE INDEX IF NOT EXISTS stock_move_ing ON %1$I.stock_move(ingredient_id, at DESC);
    CREATE INDEX IF NOT EXISTS stock_move_date ON %1$I.stock_move(business_date);

    -- First expiry, first out: the table IS the pick order.
    CREATE TABLE IF NOT EXISTS %1$I.batch (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ingredient_id text NOT NULL REFERENCES %1$I.ingredient(id),
      lot           text,
      qty           numeric(14,4) NOT NULL,
      unit_cost     numeric(14,6) NOT NULL DEFAULT 0,
      received_at   timestamptz NOT NULL DEFAULT now(),
      use_by        date,
      location_id   text,
      delivery_id   uuid,
      state         text NOT NULL DEFAULT 'holding'
                    CHECK (state IN ('holding','open','used','wasted'))
    );
    CREATE INDEX IF NOT EXISTS batch_fefo ON %1$I.batch(ingredient_id, use_by NULLS LAST);

    CREATE TABLE IF NOT EXISTS %1$I.stock_count (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      opened_at timestamptz NOT NULL DEFAULT now(),
      closed_at timestamptz,
      by_staff  uuid NOT NULL,
      scope     text NOT NULL DEFAULT 'all',
      categories text[] NOT NULL DEFAULT '{}',
      location_id text,
      variance_value numeric(12,2) NOT NULL DEFAULT 0,
      state     text NOT NULL DEFAULT 'open' CHECK (state IN ('open','posted')),
      approved_by uuid, approved_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS %1$I.count_line (
      count_id      uuid NOT NULL REFERENCES %1$I.stock_count(id) ON DELETE CASCADE,
      ingredient_id text NOT NULL,
      expected      numeric(14,4) NOT NULL,
      counted       numeric(14,4) NOT NULL,
      variance      numeric(14,4) NOT NULL,
      value         numeric(12,2) NOT NULL,
      PRIMARY KEY (count_id, ingredient_id)
    );

    -- A prep item is built from components: consume the components, stock the
    -- item, roll the component cost into its average.
    CREATE TABLE IF NOT EXISTS %1$I.production_batch (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ingredient_id text NOT NULL REFERENCES %1$I.ingredient(id),
      qty           numeric(14,4) NOT NULL CHECK (qty > 0),
      unit_cost     numeric(14,6) NOT NULL DEFAULT 0,
      at            timestamptz NOT NULL DEFAULT now(),
      by_staff      uuid, device_id uuid,
      note          text
    );
  $ddl$, s);

  -- ══ PURCHASING ══════════════════════════════════════════════════════════
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %1$I.purchase_order (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      po_no       text NOT NULL UNIQUE,
      supplier_id uuid NOT NULL,
      raised_at   timestamptz NOT NULL DEFAULT now(),
      raised_by   uuid NOT NULL,
      approved_by uuid, approved_at timestamptz,
      status      text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','sent','part','received','closed','cancelled')),
      expected    date,
      total       numeric(12,2) NOT NULL DEFAULT 0,
      note        text
    );
    CREATE TABLE IF NOT EXISTS %1$I.po_line (
      id            bigserial PRIMARY KEY,
      po_id         uuid NOT NULL REFERENCES %1$I.purchase_order(id) ON DELETE CASCADE,
      ingredient_id text NOT NULL,
      qty           numeric(14,4) NOT NULL,
      unit          text,
      unit_price    numeric(14,6) NOT NULL DEFAULT 0,
      received_qty  numeric(14,4) NOT NULL DEFAULT 0
    );

    -- A delivery is signed for when the van arrives; it is PRICED later, and
    -- an unpriced delivery is unclaimed input tax, which the return says so.
    CREATE TABLE IF NOT EXISTS %1$I.delivery (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      grn_no      text NOT NULL UNIQUE,
      po_id       uuid REFERENCES %1$I.purchase_order(id),
      supplier_id uuid NOT NULL,
      at          timestamptz NOT NULL DEFAULT now(),
      business_date date NOT NULL DEFAULT current_date,
      received_by uuid NOT NULL,
      priced      boolean NOT NULL DEFAULT false,
      priced_at   timestamptz, priced_by uuid,
      net         numeric(12,2) NOT NULL DEFAULT 0,
      tax         numeric(12,2) NOT NULL DEFAULT 0,
      total       numeric(12,2) NOT NULL DEFAULT 0,
      note        text
    );
    CREATE TABLE IF NOT EXISTS %1$I.grn_line (
      id            bigserial PRIMARY KEY,
      delivery_id   uuid NOT NULL REFERENCES %1$I.delivery(id) ON DELETE CASCADE,
      ingredient_id text NOT NULL,
      qty           numeric(14,4) NOT NULL,
      unit          text,
      unit_price    numeric(14,6) NOT NULL DEFAULT 0,
      line_total    numeric(12,2) NOT NULL DEFAULT 0,
      use_by        date,
      lot           text
    );

    CREATE TABLE IF NOT EXISTS %1$I.vendor_invoice (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      supplier_id  uuid NOT NULL,
      invoice_no   text NOT NULL,
      invoice_date date NOT NULL,
      due_date     date NOT NULL,
      net          numeric(12,2) NOT NULL,
      tax          numeric(12,2) NOT NULL DEFAULT 0,
      amount       numeric(12,2) NOT NULL,
      paid         numeric(12,2) NOT NULL DEFAULT 0,
      delivery_id  uuid REFERENCES %1$I.delivery(id),
      approved_by  uuid,
      UNIQUE (supplier_id, invoice_no)
    );
    CREATE TABLE IF NOT EXISTS %1$I.vendor_payment (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      supplier_id uuid NOT NULL,
      invoice_id uuid REFERENCES %1$I.vendor_invoice(id),
      at         timestamptz NOT NULL DEFAULT now(),
      amount     numeric(12,2) NOT NULL,
      method     text NOT NULL DEFAULT 'transfer',
      ref        text,
      by_staff   uuid NOT NULL
    );

    -- An indent is one outlet asking the store for stock; a dispatch is the
    -- store sending it. Both sides are rows, so nothing is entered twice.
    CREATE TABLE IF NOT EXISTS %1$I.indent (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      pr_no     text NOT NULL UNIQUE,
      to_outlet int,
      at        timestamptz NOT NULL DEFAULT now(),
      needed_by date,
      raised_by uuid NOT NULL,
      status    text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','approved','part','fulfilled','cancelled')),
      note      text
    );
    CREATE TABLE IF NOT EXISTS %1$I.indent_line (
      id            bigserial PRIMARY KEY,
      indent_id     uuid NOT NULL REFERENCES %1$I.indent(id) ON DELETE CASCADE,
      ingredient_id text NOT NULL,
      qty           numeric(14,4) NOT NULL,
      sent_qty      numeric(14,4) NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS %1$I.dispatch (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      dsp_no     text NOT NULL UNIQUE,
      indent_id  uuid REFERENCES %1$I.indent(id),
      to_outlet  int,
      at         timestamptz NOT NULL DEFAULT now(),
      sent_by    uuid NOT NULL,
      received_at timestamptz, received_by uuid,
      status     text NOT NULL DEFAULT 'sent'
                 CHECK (status IN ('sent','in_transit','received','short')),
      value      numeric(12,2) NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS %1$I.dispatch_line (
      id            bigserial PRIMARY KEY,
      dispatch_id   uuid NOT NULL REFERENCES %1$I.dispatch(id) ON DELETE CASCADE,
      ingredient_id text NOT NULL,
      qty           numeric(14,4) NOT NULL,
      unit_cost     numeric(14,6) NOT NULL DEFAULT 0,
      received_qty  numeric(14,4)
    );
  $ddl$, s);

  -- ══ THE LEDGER ══════════════════════════════════════════════════════════
  -- Every consequence lands here, and it must balance. Journals are DERIVED
  -- from events that already happened; the manual journal exists but refuses
  -- the accounts the till owns.
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %1$I.account (
      code        text PRIMARY KEY,
      name        text NOT NULL,
      type        text NOT NULL CHECK (type IN ('Asset','Liability','Equity','Revenue','Expense')),
      normal_side char(2) NOT NULL CHECK (normal_side IN ('dr','cr')),
      till_owned  boolean NOT NULL DEFAULT false,
      pos         int NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS %1$I.journal (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      jv_no      text NOT NULL UNIQUE,
      entry_date date NOT NULL,
      memo       text NOT NULL,
      source     text NOT NULL,
      source_id  text,
      posted_at  timestamptz NOT NULL DEFAULT now(),
      posted_by  uuid NOT NULL,
      reverses   uuid REFERENCES %1$I.journal(id)
    );
    CREATE INDEX IF NOT EXISTS journal_date ON %1$I.journal(entry_date);
    CREATE TABLE IF NOT EXISTS %1$I.journal_line (
      id           bigserial PRIMARY KEY,
      journal_id   uuid NOT NULL REFERENCES %1$I.journal(id) ON DELETE CASCADE,
      account_code text NOT NULL REFERENCES %1$I.account(code),
      dr           numeric(14,2) NOT NULL DEFAULT 0,
      cr           numeric(14,2) NOT NULL DEFAULT 0,
      memo         text,
      CONSTRAINT one_side CHECK ((dr = 0) <> (cr = 0)),
      CONSTRAINT no_negatives CHECK (dr >= 0 AND cr >= 0)
    );
    CREATE INDEX IF NOT EXISTS jl_journal ON %1$I.journal_line(journal_id);
    CREATE INDEX IF NOT EXISTS jl_account ON %1$I.journal_line(account_code);

    -- A closed period cannot take a new posting. Reopening is a rank-4 act
    -- and is audited.
    CREATE TABLE IF NOT EXISTS %1$I.period (
      id        text PRIMARY KEY,             -- YYYY-MM
      starts_on date NOT NULL,
      ends_on   date NOT NULL,
      state     text NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
      closed_at timestamptz, closed_by uuid,
      reopened_at timestamptz, reopened_by uuid
    );

    -- Bank reconciliation: three outcomes, never two.
    CREATE TABLE IF NOT EXISTS %1$I.bank_line (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      value_date date NOT NULL,
      descr     text NOT NULL,
      amount    numeric(12,2) NOT NULL,
      balance   numeric(12,2),
      ref       text,
      state     text NOT NULL DEFAULT 'unexplained'
                CHECK (state IN ('cleared','proposed','unexplained')),
      matched_account text,
      matched_source  text,
      matched_id text,
      matched_at timestamptz, matched_by uuid,
      imported_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS bank_date ON %1$I.bank_line(value_date);
    CREATE TABLE IF NOT EXISTS %1$I.bank_opening (
      id        int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      account_code text NOT NULL,
      as_of     date NOT NULL,
      amount    numeric(12,2) NOT NULL,
      set_by    uuid NOT NULL,
      set_at    timestamptz NOT NULL DEFAULT now()
    );
  $ddl$, s);

  -- A journal that does not balance is not allowed to exist. Checked at
  -- COMMIT, so the two legs may be inserted in either order.
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.assert_balanced() RETURNS trigger
      LANGUAGE plpgsql AS $t$
    DECLARE d numeric; c numeric; j uuid;
    BEGIN
      j := coalesce(NEW.journal_id, OLD.journal_id);
      SELECT coalesce(sum(dr),0), coalesce(sum(cr),0) INTO d, c
        FROM %1$I.journal_line WHERE journal_id = j;
      IF round(d,2) <> round(c,2) THEN
        RAISE EXCEPTION 'journal %% out of balance: dr %% cr %%', j, d, c;
      END IF;
      RETURN NULL;
    END $t$;
    DROP TRIGGER IF EXISTS journal_balances ON %1$I.journal_line;
    CREATE CONSTRAINT TRIGGER journal_balances
      AFTER INSERT OR UPDATE OR DELETE ON %1$I.journal_line
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION %1$I.assert_balanced();
  $ddl$, s);

  -- ══ PEOPLE AND COSTS ════════════════════════════════════════════════════
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %1$I.employee (
      id        text PRIMARY KEY,
      staff_id  uuid,                        -- the login, when they have one
      name      text NOT NULL,
      job       text NOT NULL,
      kind      text NOT NULL DEFAULT 'local' CHECK (kind IN ('local','expat')),
      basic     numeric(12,2) NOT NULL DEFAULT 0,   -- the pensionable wage
      hourly    numeric(12,2) NOT NULL DEFAULT 0,
      joined_on date,
      left_on   date,
      mrps      boolean NOT NULL DEFAULT false,     -- enrolled in the pension
      ot        boolean NOT NULL DEFAULT true,      -- paid overtime at 1.25x
      svc       boolean NOT NULL DEFAULT true,      -- shares the service pool
      emp_type  text NOT NULL DEFAULT 'fulltime',
      phone     text, id_no text,
      active    boolean NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS %1$I.rota_shift (
      id          bigserial PRIMARY KEY,
      employee_id text NOT NULL REFERENCES %1$I.employee(id) ON DELETE CASCADE,
      on_date     date NOT NULL,
      starts      time NOT NULL,
      ends        time NOT NULL,
      station     text,
      published   boolean NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS %1$I.clock_entry (
      id          bigserial PRIMARY KEY,
      employee_id text NOT NULL REFERENCES %1$I.employee(id),
      in_at       timestamptz NOT NULL,
      out_at      timestamptz,
      business_date date NOT NULL,
      source      text NOT NULL DEFAULT 'terminal',
      by_staff    uuid, device_id uuid
    );
    CREATE INDEX IF NOT EXISTS clock_emp ON %1$I.clock_entry(employee_id, business_date);

    CREATE TABLE IF NOT EXISTS %1$I.payroll_run (
      id        text PRIMARY KEY,            -- YYYY-MM
      posted_at timestamptz, posted_by uuid,
      gross     numeric(12,2) NOT NULL DEFAULT 0,
      pension_ee numeric(12,2) NOT NULL DEFAULT 0,
      pension_er numeric(12,2) NOT NULL DEFAULT 0,
      withholding numeric(12,2) NOT NULL DEFAULT 0,
      service_pool numeric(12,2) NOT NULL DEFAULT 0,
      net       numeric(12,2) NOT NULL DEFAULT 0,
      journal_id uuid
    );
    CREATE TABLE IF NOT EXISTS %1$I.payroll_line (
      id       bigserial PRIMARY KEY,
      run_id   text NOT NULL REFERENCES %1$I.payroll_run(id) ON DELETE CASCADE,
      employee_id text NOT NULL,
      hours    numeric(10,2) NOT NULL DEFAULT 0,
      ot_hours numeric(10,2) NOT NULL DEFAULT 0,
      basic    numeric(12,2) NOT NULL DEFAULT 0,
      ot_pay   numeric(12,2) NOT NULL DEFAULT 0,
      service  numeric(12,2) NOT NULL DEFAULT 0,
      pension_ee numeric(12,2) NOT NULL DEFAULT 0,
      pension_er numeric(12,2) NOT NULL DEFAULT 0,
      withholding numeric(12,2) NOT NULL DEFAULT 0,
      net      numeric(12,2) NOT NULL DEFAULT 0
    );

    -- Operating costs are what turn gross profit into actual profit.
    CREATE TABLE IF NOT EXISTS %1$I.opex (
      id        text PRIMARY KEY,
      category  text NOT NULL,
      vendor    text,
      amount    numeric(12,2) NOT NULL,
      freq      text NOT NULL DEFAULT 'monthly'
                CHECK (freq IN ('monthly','quarterly','annual','one_off')),
      due_day   int NOT NULL DEFAULT 1,
      account_code text NOT NULL,
      note      text,
      active    boolean NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS %1$I.opex_payment (
      id       bigserial PRIMARY KEY,
      opex_id  text NOT NULL REFERENCES %1$I.opex(id) ON DELETE CASCADE,
      period   text NOT NULL,
      paid_on  date NOT NULL,
      amount   numeric(12,2) NOT NULL,
      by_staff uuid,
      journal_id uuid,
      UNIQUE (opex_id, period)
    );

    CREATE TABLE IF NOT EXISTS %1$I.asset (
      id        text PRIMARY KEY,
      name      text NOT NULL,
      category  text,
      cost      numeric(12,2) NOT NULL,
      bought_on date NOT NULL,
      life_years numeric(5,2) NOT NULL DEFAULT 5,
      residual  numeric(12,2) NOT NULL DEFAULT 0,
      serial    text, location_id text, supplier_id uuid,
      warranty_to date,
      state     text NOT NULL DEFAULT 'in_service'
                CHECK (state IN ('in_service','repair','retired','lost')),
      disposed_on date, disposed_value numeric(12,2)
    );
    CREATE TABLE IF NOT EXISTS %1$I.maintenance_log (
      id       bigserial PRIMARY KEY,
      asset_id text NOT NULL REFERENCES %1$I.asset(id) ON DELETE CASCADE,
      at       timestamptz NOT NULL DEFAULT now(),
      kind     text NOT NULL DEFAULT 'repair',
      detail   text NOT NULL,
      cost     numeric(12,2) NOT NULL DEFAULT 0,
      vendor   text,
      by_staff uuid,
      journal_id uuid
    );
    CREATE TABLE IF NOT EXISTS %1$I.depreciation_run (
      period    text PRIMARY KEY,            -- YYYY-MM
      posted_at timestamptz NOT NULL DEFAULT now(),
      posted_by uuid,
      amount    numeric(12,2) NOT NULL,
      journal_id uuid
    );
  $ddl$, s);

  -- ══ KITCHEN, GUEST, PRINT AND REPLAY ════════════════════════════════════
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %1$I.kds_ticket (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id uuid REFERENCES %1$I.ticket(id),
      line_ids  uuid[] NOT NULL DEFAULT '{}',
      station   text NOT NULL,
      stage     text NOT NULL DEFAULT 'Received'
                CHECK (stage IN ('Received','Cooking','Ready','Served','Recalled')),
      course    text,
      fired_at  timestamptz NOT NULL DEFAULT now(),
      ready_at  timestamptz, served_at timestamptz,
      target_mins int NOT NULL DEFAULT 12,
      by_staff  uuid, bumped_by uuid
    );
    CREATE INDEX IF NOT EXISTS kds_open ON %1$I.kds_ticket(station) WHERE served_at IS NULL;

    -- A guest posts intent; the till decides. The phone never takes money.
    CREATE TABLE IF NOT EXISTS %1$I.guest_order (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      table_no  text NOT NULL,
      lines     jsonb NOT NULL,
      promo     text,
      guest_name text, guest_phone text,
      member_id uuid,
      note      text,
      at        timestamptz NOT NULL DEFAULT now(),
      accepted_at timestamptz, accepted_by uuid,
      ticket_id uuid REFERENCES %1$I.ticket(id),
      rejected_reason text
    );
    CREATE TABLE IF NOT EXISTS %1$I.guest_request (
      id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      table_no text NOT NULL,
      kind     text NOT NULL,       -- server | bill | water | help
      detail   text,
      at       timestamptz NOT NULL DEFAULT now(),
      ack_at   timestamptz, ack_by uuid
    );
    CREATE TABLE IF NOT EXISTS %1$I.print_job (
      id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind    text NOT NULL, target text NOT NULL, label text NOT NULL,
      state   text NOT NULL DEFAULT 'queued'
              CHECK (state IN ('queued','sent','done','failed','abandoned')),
      tries   int NOT NULL DEFAULT 0,
      at      timestamptz NOT NULL DEFAULT now(),
      by_staff uuid, device_id uuid, meta jsonb
    );

    -- Offline replay. The client stamps every operation with a UUID it
    -- generated locally, BEFORE the network is touched; this primary key is
    -- what makes replay idempotent and stops a reconnect posting a sale twice.
    CREATE TABLE IF NOT EXISTS %1$I.op_log (
      op_id      uuid PRIMARY KEY,
      kind       text NOT NULL,
      label      text,
      entity     text,
      payload    jsonb NOT NULL DEFAULT '{}',
      client_at  timestamptz NOT NULL,
      lamport    bigint NOT NULL DEFAULT 0,
      applied_at timestamptz NOT NULL DEFAULT now(),
      device_id  uuid, by_staff uuid,
      result     jsonb
    );
    CREATE INDEX IF NOT EXISTS op_log_applied ON %1$I.op_log(applied_at DESC);

    -- Per-outlet configuration the terminal reads back: floor defaults,
    -- branding, station map, printer map, KDS targets, tender types.
    CREATE TABLE IF NOT EXISTS %1$I.setting (
      key        text PRIMARY KEY,
      value      jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by uuid
    );

    -- The document register: every numbered document, one place to look.
    CREATE TABLE IF NOT EXISTS %1$I.document (
      no        text PRIMARY KEY,
      kind      text NOT NULL,
      at        timestamptz NOT NULL DEFAULT now(),
      business_date date NOT NULL DEFAULT current_date,
      amount    numeric(12,2),
      ref_id    text,
      by_staff  uuid
    );
  $ddl$, s);

  -- ══ GRANTS ══════════════════════════════════════════════════════════════
  -- Data rights on the outlet's own tables. No DDL. No DELETE on the financial
  -- record — a closed sale is corrected by a credit note, never erased — and
  -- no DELETE or UPDATE on the stock ledger, which is immutable by design.
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', s, r);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', s, r);
  EXECUTE format('REVOKE DELETE ON %1$I.sale, %1$I.sale_line, %1$I.payment,'
    || ' %1$I.journal, %1$I.journal_line, %1$I.op_log, %1$I.stock_move,'
    || ' %1$I.credit_note, %1$I.document FROM %2$I', s, r);
  EXECUTE format('REVOKE UPDATE ON %1$I.stock_move FROM %2$I', s, r);

  -- The account plane sits ABOVE the outlet and is not reachable from it.
  -- Said explicitly, so a future GRANT has to argue with this line.
  EXECUTE format('REVOKE ALL ON chain.account, chain.account_identity,'
    || ' chain.account_outlet FROM %I', r);

  EXECUTE format('GRANT SELECT ON chain.company, chain.outlet, chain.staff,'
    || ' chain.device, chain.tax_version, chain.supplier, chain.member,'
    || ' chain.setting TO %I', r);
  EXECUTE format('GRANT INSERT ON chain.audit TO %I', r);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON chain.session, chain.doc_series,'
    || ' chain.member, chain.staff, chain.device, chain.supplier, chain.setting,'
    || ' chain.tax_version, chain.company, chain.outlet TO %I', r);
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE chain.audit_id_seq,'
    || ' chain.tax_version_id_seq TO %I', r);
  EXECUTE format('GRANT EXECUTE ON FUNCTION chain.next_doc_no(text),'
    || ' chain.log(text,text,text,jsonb,jsonb),'
    || ' chain.log_anon(int,text,text,text,jsonb),'
    || ' chain.pin_candidates(int), chain.pin_failed(int,int,int),'
    || ' chain.pin_ok(uuid), chain.member_code_set(text,text,text,int),'
    || ' chain.member_code_take(text), chain.member_code_clear(uuid,boolean),'
    || ' chain.member_card(uuid),'
    -- An invitation is an event (migration 017): the till issues one and a
    -- manager withdraws it, so both belong to every outlet role from the
    -- moment the outlet exists rather than to whoever happened to run 017.
    || ' chain.member_invite(uuid,text,text,uuid),'
    || ' chain.member_revoke(uuid,uuid) TO %I', r);

  -- The slug is a public store ADDRESS (migration 012), so it is NOT NULL and
  -- has to exist from the first insert. Provisioning writes a placeholder the
  -- caller then replaces with the handle the business chose; 'store-<id>' is
  -- always well-formed and always free, which is what a placeholder owes you.
  -- tax_code follows the COMPANY. The column's default is GGST, which is right
  -- for a registered business and refused outright for one that is not — so a
  -- business below the threshold could not create an outlet at all, which is
  -- the opposite of optional. (chain.gst_registered() arrives in migration 014;
  -- this body is late-bound, so it resolves when an outlet is provisioned, long
  -- after every migration has run.)
  INSERT INTO chain.outlet (id, code, name, schema_name, db_role, slug, tax_code)
  VALUES (p_id, p_code, p_name, s, r, 'store-' || p_id,
          CASE WHEN chain.gst_registered() THEN 'GGST' ELSE 'NONE' END)
  ON CONFLICT (id) DO UPDATE SET name = excluded.name, code = excluded.code;

  INSERT INTO chain.doc_series (outlet_id, kind, prefix) VALUES
    (p_id, 'SALE', p_code || '-R'),  (p_id, 'CN',  p_code || '-CN'),
    (p_id, 'PO',   p_code || '-PO'), (p_id, 'GRN', p_code || '-GRN'),
    (p_id, 'PR',   p_code || '-PR'), (p_id, 'DSP', p_code || '-DSP'),
    (p_id, 'JV',   p_code || '-JV')
  ON CONFLICT DO NOTHING;

  PERFORM chain.seed_chart(s);

  RETURN s;
END $fn$;

-- ── group consolidation: read-only, aggregate-only ──────────────────────────
-- The estate an Owner sees is built from per-outlet aggregates, never from a
-- role that can read another outlet's rows directly.
CREATE OR REPLACE FUNCTION chain.estate_day(p_date date)
RETURNS TABLE (outlet_id int, outlet text, sales numeric, covers bigint,
               tickets bigint, cogs numeric, tax numeric)
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE o record;
BEGIN
  IF NOT app.group_scope() THEN
    RAISE EXCEPTION 'estate reporting requires rank 5 in group scope';
  END IF;
  FOR o IN SELECT id, name, schema_name FROM chain.outlet WHERE active
           ORDER BY id LOOP
    RETURN QUERY EXECUTE format(
      'SELECT $1, $2, coalesce(sum(net),0), coalesce(sum(covers),0)::bigint,'
      || ' count(*)::bigint, coalesce(sum(cogs),0), coalesce(sum(tax),0)'
      || '  FROM %I.sale WHERE business_date = $3 AND voided_at IS NULL',
      o.schema_name) USING o.id, o.name, p_date;
  END LOOP;
END $fn$;
