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
      member_id   uuid,
      CONSTRAINT closed_has_time CHECK (status <> 'closed' OR closed_at IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ticket_open_table ON %1$I.ticket(table_no, split)
      WHERE status = 'open';

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
      line_cost  numeric(12,2) NOT NULL DEFAULT 0
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
      category text
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
      station  text
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
      by_staff uuid, device_id uuid
    );
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
      total    numeric(12,2) NOT NULL DEFAULT 0
    );
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
    CREATE TABLE IF NOT EXISTS %1$I.credit_note (
      id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cn_no   text NOT NULL UNIQUE,
      sale_id uuid REFERENCES %1$I.sale(id),
      at      timestamptz NOT NULL DEFAULT now(),
      amount  numeric(12,2) NOT NULL,
      tax     numeric(12,2) NOT NULL DEFAULT 0,
      reason  text NOT NULL,
      raised_by uuid NOT NULL, approved_by uuid NOT NULL
    );
  $ddl$, s);

  -- ── the ledger. Every consequence lands here, and it must balance. ──────
  EXECUTE format($ddl$
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
      rejected_reason text
    );
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
  -- Recipe lines are current configuration, not a financial record: replacing a
  -- recipe removes the lines no longer in it, and its history is kept in
  -- chain.audit, which records the whole before and after set on every save.
  EXECUTE format('GRANT DELETE ON %I.recipe_line TO %I', s, r);
  EXECUTE format('GRANT SELECT ON chain.outlet, chain.staff, chain.device, chain.tax_version, chain.supplier, chain.member TO %I', r);
  -- Kitchen stations: readable always, writable at Manager rank through the
  -- station_write policy. The grant lives HERE and not only in the migration
  -- that added the table, or an outlet provisioned after that migration is born
  -- without it — which is exactly how this was found.
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON chain.station TO %I', r);
  EXECUTE format('GRANT EXECUTE ON FUNCTION chain.pin_candidates(int,text),'
    || ' chain.note_pin_attempt(int,uuid,boolean,int,int),'
    || ' chain.open_session(uuid,int,uuid,int,int),'
    || ' chain.log_signin(int,uuid,boolean) TO %I', r);
  -- SELECT so the outlet can read its OWN trail (the audit_read policy caps
  -- that at rank >= 3 and at this outlet); INSERT to append to it. No UPDATE,
  -- no DELETE, ever — append-only is the absence of the privilege.
  EXECUTE format('GRANT SELECT, INSERT ON chain.audit TO %I', r);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON chain.session, chain.doc_series, chain.member TO %I', r);
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE chain.audit_id_seq TO %I', r);
  EXECUTE format('GRANT EXECUTE ON FUNCTION chain.next_doc_no(text), chain.log(text,text,text,jsonb,jsonb) TO %I', r);

  INSERT INTO chain.outlet (id, code, name, schema_name, db_role)
  VALUES (p_id, p_code, p_name, s, r)
  ON CONFLICT (id) DO UPDATE SET name = excluded.name;

  INSERT INTO chain.doc_series (outlet_id, kind, prefix) VALUES
    (p_id, 'SALE', p_code || '-R'), (p_id, 'CN', p_code || '-CN'),
    (p_id, 'PO', p_code || '-PO'), (p_id, 'GRN', p_code || '-GRN'),
    (p_id, 'JV', p_code || '-JV')
  ON CONFLICT DO NOTHING;

  RETURN s;
END $fn$;

-- ── group consolidation: read-only, aggregate-only ──────────────────────────
-- The estate view an Owner sees is built from per-outlet aggregates, never
-- from a role that can read another outlet's rows directly.
CREATE OR REPLACE FUNCTION chain.estate_day(p_date date)
RETURNS TABLE (outlet_id int, outlet text, sales numeric, covers bigint,
               cogs numeric, tax numeric)
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE o record;
BEGIN
  IF NOT app.group_scope() THEN
    RAISE EXCEPTION 'estate reporting requires rank 5 in group scope';
  END IF;
  FOR o IN SELECT id, name, schema_name FROM chain.outlet WHERE active LOOP
    RETURN QUERY EXECUTE format(
      'SELECT $1, $2, coalesce(sum(total),0), count(*)::bigint,
              coalesce(sum(cogs),0), coalesce(sum(tax),0)
         FROM %I.sale WHERE business_date = $3 AND voided_at IS NULL',
      o.schema_name) USING o.id, o.name, p_date;
  END LOOP;
END $fn$;
