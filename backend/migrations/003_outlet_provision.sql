-- ═══ PER-OUTLET DATA PLANE ═════════════════════════════════════════════════
-- chain.provision_outlet() builds an outlet its own schema, its own login role
-- and its own document series, then grants that role USAGE on nothing but its
-- own schema. Two outlets share an instance and share no reachable object.
--
-- The chain of consequence is the schema's spine: ticket -> sale -> payment ->
-- tax -> stock_move -> journal -> settlement. Every table carries who, when
-- and on which device, because that is what makes it auditable to MIRA.
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

  -- The role can reach its own schema and the control plane's tables, nothing
  -- else. No CREATE, so it cannot add an object that escapes these grants.
  EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', r);
  EXECUTE format('GRANT USAGE ON SCHEMA %I, chain, app TO %I', s, r);
  EXECUTE format('ALTER ROLE %I SET search_path = %I, chain, public', r, s);

  -- ── the ticket, open on the floor ───────────────────────────────────────
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %1$I.ticket (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      table_no    text,
      split       int NOT NULL DEFAULT 0,
      channel     text NOT NULL DEFAULT 'dine_in',
      status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','held','closed','void')),
      covers      int NOT NULL DEFAULT 1,
      opened_at   timestamptz NOT NULL DEFAULT now(),
      closed_at   timestamptz,
      opened_by   uuid, closed_by uuid, device_id uuid,
      server_name text,
      -- Whose bill this split is (migration 039). NULL means nobody has said,
      -- and the till draws "Guest 2" — a party that has not asked to be named
      -- should not be made to be.
      guest_name  text,
      -- A parked bill's reference (§3.5), minted from the HOLD series. Parking
      -- frees the table for free: ticket_open_table covers only status='open'.
      hold_ref    text,
      held_at     timestamptz,
      held_by     uuid,
      member_id   uuid,
      -- What the member's own phone offered against this bill (migration 024).
      -- The phone never takes money: it posts an intent where the cashier is
      -- already looking, and the till decides.
      points_offered    numeric(12,2),
      points_offered_at timestamptz,
      CONSTRAINT closed_has_time CHECK (status <> 'closed' OR closed_at IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ticket_open_table ON %1$I.ticket(table_no, split)
      WHERE status = 'open';
    CREATE UNIQUE INDEX IF NOT EXISTS ticket_hold_ref ON %1$I.ticket(hold_ref)
      WHERE hold_ref IS NOT NULL;

    CREATE TABLE IF NOT EXISTS %1$I.ticket_line (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id  uuid NOT NULL REFERENCES %1$I.ticket(id) ON DELETE CASCADE,
      item_id    text NOT NULL,
      name       text NOT NULL,
      qty        numeric(10,3) NOT NULL CHECK (qty > 0),
      unit_price numeric(12,2) NOT NULL,
      addons     jsonb NOT NULL DEFAULT '[]',
      note       text,
      course     text,
      sent_at    timestamptz,
      void_at    timestamptz, void_by uuid, void_reason text,
      by_staff   uuid, device_id uuid
    );
    CREATE INDEX IF NOT EXISTS ticket_line_ticket ON %1$I.ticket_line(ticket_id);

    -- Tonight's book (§2 `reservations`). A booking holds a table for a
    -- WINDOW, and the exclusion constraint below is what stops two hosts on
    -- two terminals selling the same table twice. See migration 022.
    CREATE TABLE IF NOT EXISTS %1$I.reservation (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      at        timestamptz NOT NULL DEFAULT now(),
      on_date   date NOT NULL,
      at_min    int NOT NULL CHECK (at_min >= 0 AND at_min < 1440),
      mins      int NOT NULL DEFAULT 90 CHECK (mins > 0 AND mins <= 480),
      covers    int NOT NULL CHECK (covers > 0 AND covers <= 200),
      name      text NOT NULL,
      phone     text,
      member_id uuid,
      note      text,
      table_no  text,
      status    text NOT NULL DEFAULT 'booked'
                CHECK (status IN ('booked','seated','done','no_show','cancelled')),
      seated_at timestamptz,
      ticket_id uuid REFERENCES %1$I.ticket(id),
      done_at   timestamptz,
      reason    text,
      by_staff  uuid
    );
    CREATE INDEX IF NOT EXISTS reservation_day ON %1$I.reservation (on_date, at_min);
  $ddl$, s);

  EXECUTE 'CREATE EXTENSION IF NOT EXISTS btree_gist';
  EXECUTE format($ddl$
    ALTER TABLE %1$I.reservation
      DROP CONSTRAINT IF EXISTS reservation_no_double_book;
    ALTER TABLE %1$I.reservation
      ADD CONSTRAINT reservation_no_double_book EXCLUDE USING gist (
        table_no WITH =, on_date WITH =,
        int4range(at_min, at_min + mins) WITH &&
      ) WHERE (table_no IS NOT NULL AND status IN ('booked','seated'));
  $ddl$, s);

  -- ── the sale, once money has been taken ─────────────────────────────────
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %1$I.sale (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      receipt_no  text NOT NULL UNIQUE,
      ticket_id   uuid REFERENCES %1$I.ticket(id),
      at          timestamptz NOT NULL DEFAULT now(),
      business_date date NOT NULL,
      channel     text NOT NULL,
      covers      int NOT NULL DEFAULT 1,
      gross       numeric(12,2) NOT NULL,
      discount    numeric(12,2) NOT NULL DEFAULT 0,
      discount_reason text,
      discount_by uuid,
      service     numeric(12,2) NOT NULL DEFAULT 0,
      tax_code    text NOT NULL,
      tax_rate    numeric(5,2) NOT NULL,      -- recorded, never re-derived
      tax         numeric(12,2) NOT NULL,
      rounding    numeric(12,2) NOT NULL DEFAULT 0,
      total       numeric(12,2) NOT NULL,
      cogs        numeric(12,2) NOT NULL DEFAULT 0,
      member_id   uuid,
      server_name text,
      closed_by   uuid NOT NULL, device_id uuid,
      voided_at   timestamptz, voided_by uuid,
      -- What the TILL thought the bill came to, when it sent one. The server
      -- derives the real figures; this is kept so a device that disagrees can
      -- be found rather than quietly averaged into the month.
      client_total numeric(12,2),
      CONSTRAINT sale_adds_up CHECK (
        round(gross - discount + service + tax + rounding, 2) = round(total, 2))
    );
    CREATE INDEX IF NOT EXISTS sale_date ON %1$I.sale(business_date);

    CREATE TABLE IF NOT EXISTS %1$I.sale_line (
      id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sale_id  uuid NOT NULL REFERENCES %1$I.sale(id) ON DELETE CASCADE,
      item_id  text NOT NULL, name text NOT NULL,
      qty      numeric(10,3) NOT NULL,
      unit_price numeric(12,2) NOT NULL,
      line_total numeric(12,2) NOT NULL,
      unit_cost  numeric(12,4) NOT NULL DEFAULT 0,
      line_cost  numeric(12,2) NOT NULL DEFAULT 0,
      -- What was actually charged on top of the dish (migration 037). "Reef
      -- curry 240" and "Reef curry 240 + double portion 45" are different
      -- money, and a reprint that cannot tell them apart is not a tax record.
      addons     jsonb NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS sale_line_sale ON %1$I.sale_line(sale_id);

    CREATE TABLE IF NOT EXISTS %1$I.payment (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sale_id   uuid NOT NULL REFERENCES %1$I.sale(id),
      method    text NOT NULL,               -- cash | card | wallet | points | fx
      amount    numeric(12,2) NOT NULL,      -- always MVR, the book currency
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

    CREATE TABLE IF NOT EXISTS %1$I.settlement_batch (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      acquirer  text NOT NULL, batch_no text NOT NULL,
      value_date date NOT NULL,
      gross     numeric(12,2) NOT NULL,
      fee       numeric(12,2) NOT NULL DEFAULT 0,
      net       numeric(12,2) NOT NULL,
      matched_at timestamptz, matched_by uuid,
      variance  numeric(12,2) NOT NULL DEFAULT 0,
      -- Migration 026: who entered it, what they said, and the journal the
      -- match posted.
      entered_by uuid,
      entered_at timestamptz NOT NULL DEFAULT now(),
      note      text,
      journal_id uuid,
      UNIQUE (acquirer, batch_no)
    );

    CREATE TABLE IF NOT EXISTS %1$I.drawer_session (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      opened_at  timestamptz NOT NULL DEFAULT now(),
      opened_by  uuid NOT NULL,
      float_amount numeric(12,2) NOT NULL DEFAULT 0,
      closed_at  timestamptz, closed_by uuid,
      counted    numeric(12,2), expected numeric(12,2),
      variance   numeric(12,2),
      device_id  uuid
    );
  $ddl$, s);

  -- ── stock and cost, moved at the moment of sale ─────────────────────────
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %1$I.ingredient (
      id       text PRIMARY KEY,
      name     text NOT NULL,
      unit     text NOT NULL,
      on_hand  numeric(14,4) NOT NULL DEFAULT 0,
      avg_cost numeric(12,4) NOT NULL DEFAULT 0,
      par      numeric(14,4),
      allergens text[] NOT NULL DEFAULT '{}',
      supplier_id uuid,
      -- Where it lives, in the kitchen's own words. Drives the count sheets
      -- (§2 `counts`, "count sheets by category"). See migration 013.
      category text,
      -- How much one run of its prep recipe makes, in this ingredient's own
      -- base unit. NULL means it is bought rather than made, which is most of
      -- the store. See migration 033 — a prep item IS an ingredient, which is
      -- why nothing else in the system had to learn a new concept.
      prep_yield numeric(14,4) CHECK (prep_yield IS NULL OR prep_yield > 0)
    );

    CREATE TABLE IF NOT EXISTS %1$I.item (
      id       text PRIMARY KEY,
      name     text NOT NULL,
      category text,
      price    numeric(12,2) NOT NULL,
      yield_qty numeric(10,3) NOT NULL DEFAULT 1,
      active   boolean NOT NULL DEFAULT true,
      off_menu boolean NOT NULL DEFAULT false,
      -- Which station cooks it (chain.station). NULL = not routed yet; the KDS
      -- shows those on the first station rather than dropping the order.
      station  text,
      -- The face of the dish (migration 037). A photograph is a URL rather than
      -- a blob: no object store, and a database that grows four megabytes per
      -- dish cannot be replicated to an edge box. NULL photograph is a first
      -- class state -- the till draws the section artifact in its place.
      description text,
      image_url   text,
      tags        text[] NOT NULL DEFAULT '{}',
      spice       int NOT NULL DEFAULT 0,
      -- false = offer whatever this dish's section publishes; true = offer the
      -- item_modifier rows below, even when there are none.
      addons_own  boolean NOT NULL DEFAULT false,
      CONSTRAINT item_spice_range CHECK (spice BETWEEN 0 AND 3)
    );

    -- The floor plan (migration 038). Keyed by the NAME, because
    -- ticket.table_no is text and every reader of the floor — the KDS, the
    -- orders board, the receipt, the guest's QR card — already speaks it. An
    -- outlet with no rows here is not broken: the floor draws T01..Tn from
    -- chain.outlet.tables exactly as it always has, and naming tables is an
    -- enrichment a merchant opts into.
    CREATE TABLE IF NOT EXISTS %1$I.dining_table (
      name    text PRIMARY KEY,
      zone    text,
      seats   int NOT NULL DEFAULT 2 CHECK (seats > 0 AND seats <= 99),
      sort    int NOT NULL DEFAULT 0,
      active  boolean NOT NULL DEFAULT true
    );
    CREATE INDEX IF NOT EXISTS dining_table_zone ON %1$I.dining_table (zone, sort, name);

    -- Sections are keyed BY THE TEXT item.category already holds, so every
    -- query written against that column keeps working and a section with no row
    -- is simply an unconfigured section. The colour is not decoration: it bands
    -- the till grid, tints the artifact on a dish with no photograph, and
    -- colours the KDS docket rail (migration 037).
    CREATE TABLE IF NOT EXISTS %1$I.menu_section (
      name    text PRIMARY KEY,
      color   text,
      icon    text,
      station text,
      sort    int NOT NULL DEFAULT 0,
      hidden  boolean NOT NULL DEFAULT false
    );

    -- The priced add-on catalogue. The till posts IDs and the server does the
    -- arithmetic -- an add-on repriceable from a tablet is a hole in the price
    -- list (migration 037).
    CREATE TABLE IF NOT EXISTS %1$I.modifier (
      id       text PRIMARY KEY,
      name     text NOT NULL,
      price    numeric(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
      sections text[] NOT NULL DEFAULT '{}',
      active   boolean NOT NULL DEFAULT true,
      sort     int NOT NULL DEFAULT 0,
      -- What it costs the kitchen, optionally: an add-on that names a dish
      -- explodes through that dish's recipe when it sells, so add-on revenue
      -- carries add-on cost. NULL is a real answer -- "no ice" consumes
      -- nothing (migration 037).
      recipe_item_id text REFERENCES %1$I.item(id)
    );
    CREATE TABLE IF NOT EXISTS %1$I.item_modifier (
      item_id     text NOT NULL REFERENCES %1$I.item(id) ON DELETE CASCADE,
      modifier_id text NOT NULL REFERENCES %1$I.modifier(id) ON DELETE CASCADE,
      PRIMARY KEY (item_id, modifier_id)
    );

    CREATE TABLE IF NOT EXISTS %1$I.recipe_line (
      id        bigserial PRIMARY KEY,
      item_id   text NOT NULL REFERENCES %1$I.item(id) ON DELETE CASCADE,
      ingredient_id text REFERENCES %1$I.ingredient(id),
      sub_item_id   text REFERENCES %1$I.item(id),   -- sub-recipe
      qty       numeric(12,4) NOT NULL,
      waste_pct numeric(5,2) NOT NULL DEFAULT 0,
      CONSTRAINT one_component CHECK (
        (ingredient_id IS NOT NULL) <> (sub_item_id IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS %1$I.stock_move (
      id       bigserial PRIMARY KEY,
      at       timestamptz NOT NULL DEFAULT now(),
      ingredient_id text NOT NULL REFERENCES %1$I.ingredient(id),
      qty      numeric(14,4) NOT NULL,       -- signed
      unit_cost numeric(12,4) NOT NULL,
      value    numeric(12,2) NOT NULL,
      reason   text NOT NULL,                -- sale|delivery|waste|count|transfer
      sale_id  uuid REFERENCES %1$I.sale(id),
      -- Which prep batch this move belonged to (migration 033), so a run reads
      -- back as one act rather than six movements at the same second.
      prep_run_id uuid,
      by_staff uuid, device_id uuid
    );

    -- ── prep: a thing the kitchen makes rather than buys (migration 033) ──
    CREATE TABLE IF NOT EXISTS %1$I.prep_recipe (
      id        bigserial PRIMARY KEY,
      makes_id  text NOT NULL REFERENCES %1$I.ingredient(id) ON DELETE CASCADE,
      component_id text NOT NULL REFERENCES %1$I.ingredient(id),
      qty       numeric(14,4) NOT NULL CHECK (qty > 0),
      waste_pct numeric(5,2) NOT NULL DEFAULT 0
                CHECK (waste_pct >= 0 AND waste_pct < 100),
      UNIQUE (makes_id, component_id),
      CONSTRAINT not_itself CHECK (makes_id <> component_id)
    );
    CREATE INDEX IF NOT EXISTS prep_recipe_makes ON %1$I.prep_recipe(makes_id);

    CREATE TABLE IF NOT EXISTS %1$I.prep_run (
      id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      at       timestamptz NOT NULL DEFAULT now(),
      on_date  date NOT NULL DEFAULT current_date,
      makes_id text NOT NULL REFERENCES %1$I.ingredient(id),
      qty      numeric(14,4) NOT NULL CHECK (qty > 0),
      batches  numeric(10,4) NOT NULL DEFAULT 1 CHECK (batches > 0),
      cost     numeric(12,2) NOT NULL DEFAULT 0,
      note     text,
      by_staff uuid, device_id uuid
    );
    CREATE INDEX IF NOT EXISTS prep_run_date ON %1$I.prep_run(on_date DESC);
    CREATE INDEX IF NOT EXISTS stock_move_ing ON %1$I.stock_move(ingredient_id, at DESC);

    CREATE TABLE IF NOT EXISTS %1$I.stock_count (
      id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      at       timestamptz NOT NULL DEFAULT now(),
      by_staff uuid NOT NULL,
      categories text[] NOT NULL DEFAULT '{}',
      variance_value numeric(12,2) NOT NULL DEFAULT 0,
      approved_by uuid, approved_at timestamptz,
      -- A count above the outlet's approval threshold waits for a rank above
      -- the counter's before it moves any stock. See migration 011 for why
      -- this operation in particular is the one that needs a second signature.
      status   text NOT NULL DEFAULT 'posted'
        CHECK (status IN ('pending','posted','rejected')),
      note     text,
      rejected_reason text,
      threshold numeric(12,2) NOT NULL DEFAULT 0,
      CONSTRAINT count_approval_shape
        CHECK (status <> 'pending' OR (approved_by IS NULL AND approved_at IS NULL))
    );
    CREATE INDEX IF NOT EXISTS count_pending ON %1$I.stock_count (status, at)
      WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS %1$I.count_line (
      count_id uuid NOT NULL REFERENCES %1$I.stock_count(id) ON DELETE CASCADE,
      ingredient_id text NOT NULL,
      expected numeric(14,4) NOT NULL,
      counted  numeric(14,4) NOT NULL,
      variance numeric(14,4) NOT NULL,
      value    numeric(12,2) NOT NULL,
      -- Valued as at the COUNT, so what is approved is what posts.
      unit_cost numeric(12,4) NOT NULL DEFAULT 0,
      PRIMARY KEY (count_id, ingredient_id)
    );
  $ddl$, s);

  -- ── procurement to payment ──────────────────────────────────────────────
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %1$I.purchase_order (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      po_no     text NOT NULL UNIQUE,
      supplier_id uuid NOT NULL,
      raised_at timestamptz NOT NULL DEFAULT now(),
      raised_by uuid NOT NULL,
      approved_by uuid, approved_at timestamptz,
      status    text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','sent','part','received','closed','cancelled')),
      expected  date,
      total     numeric(12,2) NOT NULL DEFAULT 0
    );
    -- ── a kitchen asks; a manager decides (migration 036) ────────────────
    -- The first half of a chain whose second half — the purchase order below —
    -- has existed since this file was written and had nothing pointing at it.
    CREATE TABLE IF NOT EXISTS %1$I.indent (
      id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ref      text NOT NULL UNIQUE,
      at       timestamptz NOT NULL DEFAULT now(),
      on_date  date NOT NULL DEFAULT current_date,
      for_area text,
      needed_by date,
      note     text,
      state    text NOT NULL DEFAULT 'open'
               CHECK (state IN ('open','decided','ordered','cancelled')),
      raised_by uuid,
      decided_by uuid, decided_at timestamptz,
      reason   text,
      po_id    uuid REFERENCES %1$I.purchase_order(id)
    );
    CREATE INDEX IF NOT EXISTS indent_state ON %1$I.indent (state, at DESC);

    CREATE TABLE IF NOT EXISTS %1$I.indent_line (
      id        bigserial PRIMARY KEY,
      indent_id uuid NOT NULL REFERENCES %1$I.indent(id) ON DELETE CASCADE,
      ingredient_id text NOT NULL REFERENCES %1$I.ingredient(id),
      qty       numeric(14,4) NOT NULL CHECK (qty > 0),
      approved_qty numeric(14,4) CHECK (approved_qty >= 0),
      note      text,
      reason    text,
      UNIQUE (indent_id, ingredient_id)
    );
    CREATE INDEX IF NOT EXISTS indent_line_indent ON %1$I.indent_line(indent_id);

    CREATE TABLE IF NOT EXISTS %1$I.po_line (
      id      bigserial PRIMARY KEY,
      po_id   uuid NOT NULL REFERENCES %1$I.purchase_order(id) ON DELETE CASCADE,
      ingredient_id text NOT NULL,
      qty     numeric(14,4) NOT NULL,
      unit_price numeric(12,4) NOT NULL,
      received_qty numeric(14,4) NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS %1$I.delivery (
      id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      grn_no   text NOT NULL UNIQUE,
      po_id    uuid REFERENCES %1$I.purchase_order(id),
      supplier_id uuid NOT NULL,
      at       timestamptz NOT NULL DEFAULT now(),
      received_by uuid NOT NULL,
      priced   boolean NOT NULL DEFAULT false,
      total    numeric(12,2) NOT NULL DEFAULT 0,
      note     text,
      priced_at timestamptz, priced_by uuid
    );
    -- What actually arrived, line by line. `unit_price` is NULL until the
    -- invoice does — a different state from zero, which would be a free
    -- delivery. See migration 014.
    CREATE TABLE IF NOT EXISTS %1$I.delivery_line (
      id      bigserial PRIMARY KEY,
      delivery_id uuid NOT NULL REFERENCES %1$I.delivery(id) ON DELETE CASCADE,
      ingredient_id text NOT NULL REFERENCES %1$I.ingredient(id),
      qty     numeric(14,4) NOT NULL CHECK (qty > 0),
      unit_price numeric(12,4),
      provisional_cost numeric(12,4) NOT NULL DEFAULT 0,
      UNIQUE (delivery_id, ingredient_id)
    );
    CREATE INDEX IF NOT EXISTS delivery_unpriced ON %1$I.delivery (at)
      WHERE priced = false;

    -- ── lots and expiry (migration 034) ──────────────────────────────────
    -- Two questions: what is about to go off, and which sales contained a
    -- given lot. The second cannot be reconstructed after the fact, which is
    -- why every draw is recorded rather than inferred from quantities.
    CREATE TABLE IF NOT EXISTS %1$I.batch (
      id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ingredient_id text NOT NULL REFERENCES %1$I.ingredient(id),
      lot      text,
      qty_in   numeric(14,4) NOT NULL CHECK (qty_in > 0),
      qty_left numeric(14,4) NOT NULL CHECK (qty_left >= 0),
      unit_cost numeric(12,4) NOT NULL DEFAULT 0,
      received_on date NOT NULL DEFAULT current_date,
      expires_on date,
      delivery_id uuid REFERENCES %1$I.delivery(id),
      prep_run_id uuid,
      closed_at timestamptz,
      closed_reason text,
      note     text,
      by_staff uuid,
      CONSTRAINT left_within_in CHECK (qty_left <= qty_in)
    );
    CREATE INDEX IF NOT EXISTS batch_fefo ON %1$I.batch
      (ingredient_id, expires_on NULLS LAST, received_on) WHERE closed_at IS NULL;
    CREATE INDEX IF NOT EXISTS batch_expiry ON %1$I.batch (expires_on)
      WHERE closed_at IS NULL AND expires_on IS NOT NULL;

    CREATE TABLE IF NOT EXISTS %1$I.batch_draw (
      id       bigserial PRIMARY KEY,
      batch_id uuid NOT NULL REFERENCES %1$I.batch(id),
      stock_move_id bigint NOT NULL REFERENCES %1$I.stock_move(id),
      qty      numeric(14,4) NOT NULL CHECK (qty > 0),
      at       timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS batch_draw_batch ON %1$I.batch_draw(batch_id);
    CREATE INDEX IF NOT EXISTS batch_draw_move ON %1$I.batch_draw(stock_move_id);


    CREATE TABLE IF NOT EXISTS %1$I.vendor_invoice (
      id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      supplier_id uuid NOT NULL,
      invoice_no text NOT NULL,
      invoice_date date NOT NULL,
      due_date date NOT NULL,
      amount   numeric(12,2) NOT NULL,
      tax      numeric(12,2) NOT NULL DEFAULT 0,
      paid     numeric(12,2) NOT NULL DEFAULT 0,
      delivery_id uuid REFERENCES %1$I.delivery(id),
      approved_by uuid,
      UNIQUE (supplier_id, invoice_no)
    );
    CREATE INDEX IF NOT EXISTS invoice_due ON %1$I.vendor_invoice (due_date)
      WHERE paid < amount;
    -- A closed sale is corrected with one of these, never erased. Migration 027
    -- is where the approval workflow and the per-line detail were added; the
    -- shape below is what a NEW outlet gets, so both agree from day one.
    CREATE TABLE IF NOT EXISTS %1$I.credit_note (
      id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Issued at APPROVAL: a pending note is not yet a document, and a gapless
      -- series must not carry a hole where a declined one used to be.
      cn_no   text UNIQUE,
      sale_id uuid REFERENCES %1$I.sale(id),
      at      timestamptz NOT NULL DEFAULT now(),
      business_date date,
      amount  numeric(12,2) NOT NULL,
      goods   numeric(12,2) NOT NULL DEFAULT 0,
      service numeric(12,2) NOT NULL DEFAULT 0,
      tax     numeric(12,2) NOT NULL DEFAULT 0,
      reason  text NOT NULL,
      refund_method text,
      raised_by uuid NOT NULL,
      approved_by uuid, approved_at timestamptz,
      declined_by uuid, declined_at timestamptz, decline_reason text,
      journal_id uuid,
      CONSTRAINT cn_one_fate CHECK (approved_at IS NULL OR declined_at IS NULL),
      CONSTRAINT cn_approved_is_a_document
        CHECK (approved_at IS NULL OR (cn_no IS NOT NULL AND approved_by IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS cn_sale ON %1$I.credit_note (sale_id);

    CREATE TABLE IF NOT EXISTS %1$I.credit_note_line (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      credit_note_id uuid NOT NULL REFERENCES %1$I.credit_note(id) ON DELETE CASCADE,
      sale_line_id uuid NOT NULL REFERENCES %1$I.sale_line(id),
      item_id      text NOT NULL,
      name         text NOT NULL,
      qty          numeric(10,3) NOT NULL CHECK (qty > 0),
      amount       numeric(12,2) NOT NULL,
      restock      boolean NOT NULL DEFAULT false
    );
    CREATE INDEX IF NOT EXISTS cn_line_note ON %1$I.credit_note_line (credit_note_id);
    CREATE INDEX IF NOT EXISTS cn_line_sale_line ON %1$I.credit_note_line (sale_line_id);
  $ddl$, s);

  -- ── the ledger. Every consequence lands here, and it must balance. ──────
  EXECUTE format($ddl$
    -- Payroll (§2 `payroll`). Rates are effective-dated like the tax rate, and
    -- for the same reason: a rise agreed in March must not restate February.
    -- See migration 016.
    CREATE TABLE IF NOT EXISTS %1$I.pay_rate (
      id        bigserial PRIMARY KEY,
      staff_id  uuid NOT NULL,
      kind      text NOT NULL DEFAULT 'hourly' CHECK (kind IN ('hourly','monthly')),
      amount    numeric(12,2) NOT NULL CHECK (amount >= 0),
      effective_from date NOT NULL,
      set_by    uuid, set_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (staff_id, effective_from)
    );
    CREATE INDEX IF NOT EXISTS pay_rate_person ON %1$I.pay_rate (staff_id, effective_from DESC);

    CREATE TABLE IF NOT EXISTS %1$I.payroll_run (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      period_from date NOT NULL, period_to date NOT NULL,
      status    text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','posted','paid')),
      gross     numeric(12,2) NOT NULL DEFAULT 0,
      employee_pension numeric(12,2) NOT NULL DEFAULT 0,
      employer_pension numeric(12,2) NOT NULL DEFAULT 0,
      net       numeric(12,2) NOT NULL DEFAULT 0,
      run_by    uuid, run_at timestamptz NOT NULL DEFAULT now(),
      posted_by uuid, posted_at timestamptz, paid_at timestamptz, note text,
      CONSTRAINT payroll_period CHECK (period_to >= period_from)
    );
    -- One POSTED run per period: a second would pay everybody twice, and that
    -- is not a mistake anybody spots from the ledger afterwards.
    CREATE UNIQUE INDEX IF NOT EXISTS payroll_one_per_period
      ON %1$I.payroll_run (period_from, period_to) WHERE status <> 'draft';

    CREATE TABLE IF NOT EXISTS %1$I.payroll_line (
      id        bigserial PRIMARY KEY,
      run_id    uuid NOT NULL REFERENCES %1$I.payroll_run(id) ON DELETE CASCADE,
      staff_id  uuid NOT NULL,
      kind      text NOT NULL,
      rate      numeric(12,2) NOT NULL,
      hours     numeric(10,2) NOT NULL DEFAULT 0,
      shifts    int NOT NULL DEFAULT 0,
      gross     numeric(12,2) NOT NULL DEFAULT 0,
      employee_pension numeric(12,2) NOT NULL DEFAULT 0,
      employer_pension numeric(12,2) NOT NULL DEFAULT 0,
      net       numeric(12,2) NOT NULL DEFAULT 0,
      UNIQUE (run_id, staff_id)
    );

    -- The time clock (§2 `staff`). Hours are the OUTLET's cost, so they live
    -- here while the person lives in chain.staff. See migration 015.
    CREATE TABLE IF NOT EXISTS %1$I.shift (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      staff_id  uuid NOT NULL,
      in_at     timestamptz NOT NULL DEFAULT now(),
      out_at    timestamptz,
      in_by     uuid, out_by uuid,
      device_id uuid,
      note      text,
      CONSTRAINT shift_ends_after_it_starts CHECK (out_at IS NULL OR out_at >= in_at)
    );
    -- One clock per person at a time, enforced by the database because two
    -- terminals can press the button in the same second.
    CREATE UNIQUE INDEX IF NOT EXISTS shift_one_open ON %1$I.shift (staff_id)
      WHERE out_at IS NULL;
    CREATE INDEX IF NOT EXISTS shift_by_day ON %1$I.shift (in_at DESC);

    CREATE TABLE IF NOT EXISTS %1$I.account (
      code text PRIMARY KEY,
      name text NOT NULL,
      type text NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
      normal_side char(2) NOT NULL CHECK (normal_side IN ('dr','cr'))
    );
    CREATE TABLE IF NOT EXISTS %1$I.journal (
      id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      jv_no    text NOT NULL UNIQUE,
      entry_date date NOT NULL,
      memo     text NOT NULL,
      source   text NOT NULL,     -- sale|payment|delivery|payroll|depreciation|overhead
      source_id text,
      posted_at timestamptz NOT NULL DEFAULT now(),
      posted_by uuid NOT NULL,
      reversed_by uuid REFERENCES %1$I.journal(id)
    );
    CREATE TABLE IF NOT EXISTS %1$I.journal_line (
      id      bigserial PRIMARY KEY,
      journal_id uuid NOT NULL REFERENCES %1$I.journal(id) ON DELETE CASCADE,
      account_code text NOT NULL REFERENCES %1$I.account(code),
      dr      numeric(14,2) NOT NULL DEFAULT 0,
      cr      numeric(14,2) NOT NULL DEFAULT 0,
      CONSTRAINT one_side CHECK ((dr = 0) <> (cr = 0))
    );
    CREATE INDEX IF NOT EXISTS jl_journal ON %1$I.journal_line(journal_id);

    -- Operating costs (§2 `opcosts`). Below the ledger tables deliberately:
    -- both reference %1$I.account, and provisioning runs these blocks in file
    -- order, so an expense table written above the chart of accounts creates
    -- nothing and takes the whole outlet down with it. See migration 017.
    --
    -- A SPREAD cost sits on 1200 Prepaid expenses and is released a period at a
    -- time — an annual licence paid in January is a twelfth of January's cost,
    -- not all of it.
    CREATE TABLE IF NOT EXISTS %1$I.expense (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      at        timestamptz NOT NULL DEFAULT now(),
      spent_on  date NOT NULL,
      account_code text NOT NULL REFERENCES %1$I.account(code),
      amount    numeric(12,2) NOT NULL CHECK (amount > 0),
      supplier_id uuid, note text,
      method    text NOT NULL DEFAULT 'credit'
                CHECK (method IN ('cash','bank','credit')),
      recurring_id uuid, period_key text,
      spread_months int CHECK (spread_months IS NULL OR spread_months > 1),
      released_months int NOT NULL DEFAULT 0,
      -- The last period released FOR, so month-end run twice charges once.
      released_upto text,
      by_staff  uuid,
      UNIQUE (recurring_id, period_key)
    );
    CREATE INDEX IF NOT EXISTS expense_when ON %1$I.expense (spent_on DESC);
    CREATE INDEX IF NOT EXISTS expense_unreleased ON %1$I.expense (spent_on)
      WHERE spread_months IS NOT NULL;

    CREATE TABLE IF NOT EXISTS %1$I.recurring_cost (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_code text NOT NULL REFERENCES %1$I.account(code),
      amount    numeric(12,2) NOT NULL CHECK (amount > 0),
      cadence   text NOT NULL CHECK (cadence IN ('weekly','monthly','annual')),
      due_day   int NOT NULL,
      starts_on date NOT NULL, ends_on date,
      supplier_id uuid, note text,
      method    text NOT NULL DEFAULT 'credit'
                CHECK (method IN ('cash','bank','credit')),
      spread_months int CHECK (spread_months IS NULL OR spread_months > 1),
      active    boolean NOT NULL DEFAULT true,
      set_by    uuid, set_at timestamptz NOT NULL DEFAULT now()
    );

    -- The asset register (§2 `assets`). An oven is not an expense: it
    -- capitalises to 1500 and is charged to 6300 a month at a time. See
    -- migration 018.
    CREATE TABLE IF NOT EXISTS %1$I.asset (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tag       text,
      name      text NOT NULL,
      category  text,
      acquired_on date NOT NULL,
      cost      numeric(12,2) NOT NULL CHECK (cost > 0),
      life_months int NOT NULL CHECK (life_months BETWEEN 1 AND 600),
      residual  numeric(12,2) NOT NULL DEFAULT 0 CHECK (residual >= 0),
      method    text NOT NULL DEFAULT 'credit'
                CHECK (method IN ('cash','bank','credit')),
      supplier_id uuid, serial text, location text, note text,
      status    text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','disposed')),
      -- The last period depreciated FOR, so month-end run twice charges once.
      depreciated_months int NOT NULL DEFAULT 0,
      depreciated_upto text,
      disposed_on date,
      proceeds  numeric(12,2),
      by_staff  uuid,
      at        timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT residual_below_cost CHECK (residual < cost)
    );
    CREATE INDEX IF NOT EXISTS asset_live ON %1$I.asset (status, acquired_on DESC);

    CREATE TABLE IF NOT EXISTS %1$I.asset_service (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      asset_id  uuid NOT NULL REFERENCES %1$I.asset(id),
      kind      text NOT NULL DEFAULT 'service'
                CHECK (kind IN ('service','repair','inspection')),
      every_days int CHECK (every_days IS NULL OR every_days > 0),
      due_on    date NOT NULL,
      done_on   date,
      done_by   uuid,
      -- The ONE expense row a paid-for service books — the same table the
      -- Operating Costs screen writes to. One figure, reachable from both ends.
      expense_id uuid,
      note      text,
      at        timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS service_due ON %1$I.asset_service (due_on)
      WHERE done_on IS NULL;

    -- The house-account credit ledger (§2 `customers`). Immutable and signed
    -- like stock_move: + is owed to us, − is paid or written off. The profile
    -- is chain-wide; the DEBT is per outlet, because 1030 lives here. See
    -- migration 019.
    CREATE TABLE IF NOT EXISTS %1$I.house_entry (
      id        bigserial PRIMARY KEY,
      at        timestamptz NOT NULL DEFAULT now(),
      on_date   date NOT NULL,
      member_id uuid NOT NULL,
      kind      text NOT NULL
                CHECK (kind IN ('charge','receipt','writeoff','adjust')),
      amount    numeric(12,2) NOT NULL CHECK (amount <> 0),
      sale_id   uuid,
      doc_no    text,
      method    text,
      note      text,
      by_staff  uuid
    );
    CREATE INDEX IF NOT EXISTS house_member ON %1$I.house_entry (member_id, on_date);
  $ddl$, s);

  -- A journal that does not balance is not allowed to exist. Checked at
  -- COMMIT, so the two legs may be inserted in either order.
  -- Every literal percent below is DOUBLED, because this whole body is an
  -- argument to the outer format() and a bare `%` there is a format specifier.
  -- Written singly, provisioning died with "unrecognized format() type
  -- specifier" and no outlet could be created at all.
  --
  -- The row is read from TG_OP rather than coalesce(NEW, OLD): in a DELETE
  -- trigger NEW is not assigned, and touching it raises before the balance is
  -- ever checked — so deleting a line from an unbalanced journal would fail
  -- with the wrong error, or on some paths let the imbalance through.
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.assert_balanced() RETURNS trigger
      LANGUAGE plpgsql AS $t$
    DECLARE d numeric; c numeric; j uuid;
    BEGIN
      IF TG_OP = 'DELETE' THEN j := OLD.journal_id; ELSE j := NEW.journal_id; END IF;
      SELECT coalesce(sum(dr),0), coalesce(sum(cr),0) INTO d, c
        FROM %1$I.journal_line WHERE journal_id = j;
      -- A journal whose every line was deleted is not "unbalanced at zero", it
      -- is gone; the journal row's own FK cascade is what removes it.
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

  -- ── kitchen, guest and print, plus the offline replay log ───────────────
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %1$I.kds_ticket (
      id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id uuid REFERENCES %1$I.ticket(id),
      station text NOT NULL,
      stage   text NOT NULL DEFAULT 'Received',
      fired_at timestamptz NOT NULL DEFAULT now(),
      ready_at timestamptz, served_at timestamptz,
      target_mins int NOT NULL DEFAULT 12,
      by_staff uuid
    );
    CREATE TABLE IF NOT EXISTS %1$I.guest_order (
      id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      table_no text NOT NULL,
      lines   jsonb NOT NULL,
      promo   text,
      guest_name text, guest_phone text,
      at      timestamptz NOT NULL DEFAULT now(),
      accepted_at timestamptz, accepted_by uuid,
      ticket_id uuid REFERENCES %1$I.ticket(id),
      rejected_reason text,
      -- Delivery & QR (§2 `delivery`). A QR order at table 4 and a delivery to
      -- an address are the same object going to different places. See
      -- migration 023.
      channel text NOT NULL DEFAULT 'dine_in',
      source  text NOT NULL DEFAULT 'qr',
      ext_ref text,
      address text,
      fee     numeric(12,2) NOT NULL DEFAULT 0,
      rejected_at timestamptz, rejected_by uuid,
      rider   text, dispatched_at timestamptz, delivered_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS guest_order_waiting ON %1$I.guest_order (at)
      WHERE accepted_at IS NULL AND rejected_at IS NULL;
    CREATE TABLE IF NOT EXISTS %1$I.guest_request (
      id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      table_no text NOT NULL,
      kind    text NOT NULL,     -- server | bill | water | help
      detail  text,
      at      timestamptz NOT NULL DEFAULT now(),
      ack_at  timestamptz, ack_by uuid
    );
    CREATE TABLE IF NOT EXISTS %1$I.print_job (
      id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind    text NOT NULL, target text NOT NULL, label text NOT NULL,
      state   text NOT NULL DEFAULT 'queued'
              CHECK (state IN ('queued','sent','done','failed')),
      tries   int NOT NULL DEFAULT 0,
      at      timestamptz NOT NULL DEFAULT now(),
      by_staff uuid, device_id uuid, meta jsonb
    );

    -- Offline replay. The client stamps every operation with a UUID it
    -- generated locally; this unique index is what makes a replay idempotent
    -- and stops a reconnect from posting the same sale twice.
    CREATE TABLE IF NOT EXISTS %1$I.op_log (
      op_id     uuid PRIMARY KEY,
      kind      text NOT NULL,
      payload   jsonb NOT NULL,
      client_at timestamptz NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      device_id uuid, by_staff uuid,
      result    jsonb
    );
    CREATE INDEX IF NOT EXISTS op_log_applied ON %1$I.op_log(applied_at DESC);
    -- The KDS reads live tickets every few seconds all service; without this it
    -- is a seq scan of every ticket the outlet has ever fired.
    CREATE INDEX IF NOT EXISTS kds_live ON %1$I.kds_ticket (stage, fired_at)
      WHERE served_at IS NULL;
  $ddl$, s);

  -- Grants: data rights on the outlet's own tables. No DDL, no DELETE on the
  -- financial record — a closed sale is corrected by a credit note, never
  -- erased.
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA %I TO %I', s, r);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', s, r);
  EXECUTE format('REVOKE DELETE ON %I.sale, %I.sale_line, %I.payment, %I.journal, %I.journal_line, %I.op_log FROM %I', s, s, s, s, s, s, r);
  -- A debt that can be tidied away is not a ledger: a house charge is written
  -- off through an entry, never removed.
  EXECUTE format('REVOKE DELETE ON %I.house_entry FROM %I', s, r);
  -- A booking is cancelled, never deleted: what was promised and did not
  -- happen is the part worth keeping.
  EXECUTE format('REVOKE DELETE ON %I.reservation FROM %I', s, r);
  -- Recipe lines are current configuration, not a financial record: replacing a
  -- recipe removes the lines no longer in it, and its history is kept in
  -- chain.audit, which records the whole before and after set on every save.
  EXECUTE format('GRANT DELETE ON %I.recipe_line TO %I', s, r);
  -- A prep formula is replaced whole rather than edited line by line (a half
  -- saved one is how a batch gets made from four of its five components), so
  -- the rows have to be deletable. The RUNS never are: a batch that happened,
  -- happened.
  EXECUTE format('GRANT DELETE ON %I.prep_recipe TO %I', s, r);
  -- An indent still open can have a line taken off it by whoever raised it.
  -- The indent itself is cancelled rather than deleted: a request that was
  -- turned down is a thing that happened. See migration 036.
  EXECUTE format('GRANT DELETE ON %I.indent_line TO %I', s, r);
  -- A DRAFT payroll run is deleted when abandoned; a posted one never is.
  EXECUTE format('GRANT DELETE ON %I.payroll_run, %I.payroll_line TO %I', s, s, r);
  -- A schedule set up wrongly is deleted; a posted expense never is.
  EXECUTE format('GRANT DELETE ON %I.recurring_cost TO %I', s, r);
  -- A service booked against the wrong machine is deleted; a capitalised asset
  -- is disposed of, never deleted.
  EXECUTE format('GRANT DELETE ON %I.asset_service TO %I', s, r);
  -- The menu's presentation layer is configuration, not a record of anything
  -- that happened: unticking an add-on on a dish, retiring a section nobody
  -- sells from, deleting an add-on that was never ordered. What a sale actually
  -- charged is captured on sale_line.addons and is untouched by any of it.
  -- See migration 037.
  EXECUTE format('GRANT DELETE ON %I.item_modifier, %I.menu_section, %I.modifier TO %I', s, s, s, r);
  -- A table added by a typo is removed; one that has traded is retired, and
  -- the app enforces that rather than the grant. See migration 038.
  EXECUTE format('GRANT DELETE ON %I.dining_table TO %I', s, r);
  EXECUTE format('GRANT SELECT ON chain.outlet, chain.staff, chain.device, chain.tax_version, chain.supplier, chain.member TO %I', r);
  -- Loyalty (§2 `loyalty`). The scheme is chain-wide configuration; the point
  -- ledger is append-only, so no UPDATE or DELETE on it ever. See migration 020.
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON chain.loyalty TO %I', r);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON chain.reward TO %I', r);
  EXECUTE format('GRANT SELECT, INSERT ON chain.point_entry TO %I', r);
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE chain.point_entry_id_seq TO %I', r);
  -- Promotions (§2 `promos`). The uses are append-only: a cap counted from a
  -- mutable ledger is not a cap. See migration 021.
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON chain.promo TO %I', r);
  EXECUTE format('GRANT SELECT, INSERT ON chain.promo_use TO %I', r);
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE chain.promo_use_id_seq TO %I', r);
  -- The supplier master is shared across the estate and written at ADMIN rank;
  -- the policy in migration 014 enforces the rank, this grants the right.
  EXECUTE format('GRANT INSERT, UPDATE ON chain.supplier TO %I', r);
  -- The roster is written at rank 4 and never above the writer's own rank.
  -- That is the `staff_write` policy's job; this is the grant it needs to
  -- have anything to decide about. See migration 015.
  EXECUTE format('GRANT INSERT, UPDATE ON chain.staff TO %I', r);
  -- Kitchen stations: readable always, writable at Manager rank through the
  -- station_write policy. The grant lives HERE and not only in the migration
  -- that added the table, or an outlet provisioned after that migration is born
  -- without it — which is exactly how this was found.
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON chain.station TO %I', r);
  -- The estate targets a branch is judged against (migration 028). SELECT so a
  -- manager's own screens read the same yardstick the owner does; the write is
  -- granted because the rank-5 policy is what actually decides, and an owner
  -- signs in through an outlet's role like everybody else.
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON chain.estate_target TO %I', r);
  -- Devices (migration 030). A new outlet pairs its tills on day one, so the
  -- grant belongs here as well as in the migration that added it — an outlet
  -- provisioned afterwards is otherwise born unable to pair anything, which is
  -- how the station grant three lines up was found to be missing.
  EXECUTE format('GRANT INSERT, UPDATE ON chain.device TO %I', r);
  -- Inter-outlet transfers (migration 035). A new branch both sends and
  -- receives from day one; the policies decide which end may do what.
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON chain.transfer TO %I', r);
  -- The names of the other branches, and nothing else about them: a transfer
  -- needs a destination and `chain.outlet` cannot be widened without handing
  -- over `schema_name` and `db_role` too. See migration 035.
  EXECUTE format('GRANT EXECUTE ON FUNCTION chain.outlet_names() TO %I', r);
  EXECUTE format('GRANT EXECUTE ON FUNCTION chain.claim_device(int,text,text,text),'
    || ' chain.device_seen(int,uuid), chain.revoke_device(uuid,uuid) TO %I', r);
  -- Every request this outlet makes asks whether its session is still live
  -- (migration 031). Without the grant a new outlet's every request fails
  -- closed, which is the safe direction and still an outlet nobody can use.
  EXECUTE format('GRANT EXECUTE ON FUNCTION chain.session_live(uuid) TO %I', r);
  -- Settings and the tax rate (migration 032). Never UPDATE on chain.outlet:
  -- `schema_name` and `db_role` on that row ARE the tenancy model, and a policy
  -- decides which rows you may write, never which columns.
  EXECUTE format('GRANT EXECUTE ON FUNCTION'
    || ' chain.set_outlet_settings(text,text,numeric,int,int,text,text,text),'
    || ' chain.set_tax_rate(text,numeric,date) TO %I', r);
  EXECUTE format('GRANT INSERT, UPDATE ON chain.tax_version TO %I', r);
  EXECUTE format('GRANT EXECUTE ON FUNCTION chain.pin_candidates(int,text),'
    || ' chain.note_pin_attempt(int,uuid,boolean,int,int),'
    || ' chain.open_session(uuid,int,uuid,int,int),'
    || ' chain.log_signin(int,uuid,boolean) TO %I', r);
  -- SELECT so the outlet can read its OWN trail (the audit_read policy caps
  -- that at rank >= 3 and at this outlet); INSERT to append to it. No UPDATE,
  -- no DELETE, ever — append-only is the absence of the privilege.
  EXECUTE format('GRANT SELECT, INSERT ON chain.audit TO %I', r);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON chain.session, chain.doc_series, chain.member TO %I', r);
  -- The member portal's two chain-wide tables (migration 024). A new outlet
  -- serves members from day one: it writes the visit it served and takes the
  -- voucher a member presents.
  EXECUTE format('GRANT SELECT, INSERT ON chain.member_visit TO %I', r);
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE chain.member_visit_id_seq TO %I', r);
  EXECUTE format('GRANT SELECT, UPDATE ON chain.voucher TO %I', r);
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE chain.audit_id_seq TO %I', r);
  EXECUTE format('GRANT EXECUTE ON FUNCTION chain.next_doc_no(text), chain.log(text,text,text,jsonb,jsonb) TO %I', r);
  -- Releasing a lockout: manager rank, one person, its own function rather
  -- than widening the roster policy to rank 3. See migration 015.
  EXECUTE format('GRANT EXECUTE ON FUNCTION chain.release_lock(uuid) TO %I', r);

  INSERT INTO chain.outlet (id, code, name, schema_name, db_role)
  VALUES (p_id, p_code, p_name, s, r)
  ON CONFLICT (id) DO UPDATE SET name = excluded.name;

  INSERT INTO chain.doc_series (outlet_id, kind, prefix) VALUES
    (p_id, 'SALE', p_code || '-R'), (p_id, 'CN', p_code || '-CN'),
    -- Parked tickets get their own counter (migration 039): HOLD-000004
    -- following HOLD-000003 is what lets a cashier read a reference off a slip
    -- and find the bill. Borrowing SALE's would gap the receipt numbers.
    (p_id, 'HOLD', p_code || '-HOLD'),
    (p_id, 'PO', p_code || '-PO'), (p_id, 'GRN', p_code || '-GRN'),
    -- Inter-outlet transfers get their OWN counter (migration 035). Borrowing
    -- the GRN series and swapping the letters would leave gaps in that one.
    (p_id, 'TRF', p_code || '-TRF'), (p_id, 'IND', p_code || '-IND'),
    (p_id, 'JV', p_code || '-JV'), (p_id, 'RCT', p_code || '-RCT')
  ON CONFLICT DO NOTHING;

  RETURN s;
END $fn$;

-- ── group consolidation: read-only, aggregate-only ──────────────────────────
-- The estate view an Owner sees is built from per-outlet aggregates, never from
-- a role that can read another outlet's rows directly.
--
-- IT USED TO BE DEFINED HERE and is now in migration 028, with the rest of the
-- estate. Not tidying: leaving it here made the migrator unable to run twice.
-- 028 has to DROP the function to change its shape (a RETURNS TABLE cannot be
-- widened by CREATE OR REPLACE), and since every migration runs on every boot,
-- the second boot came back to this file and tried to REPLACE the new function
-- with the old one — `42P13: row type defined by OUT parameters is different`,
-- and no deploy after the first ever completed. One definition, in one file,
-- is the only shape of this that survives a redeploy.

