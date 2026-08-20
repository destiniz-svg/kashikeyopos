-- ═══ CONTROL PLANE ═════════════════════════════════════════════════════════
-- One per chain. Holds identity, the outlet registry, tax versions, document
-- series, the chain-wide masters (members, suppliers) and the audit trail.
--
-- It holds NO transactional data. Every sale, ticket, stock move and journal
-- line lives in its own outlet's schema, which another outlet's login role has
-- never been granted USAGE on.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS chain;
CREATE SCHEMA IF NOT EXISTS app;

-- ── request context ────────────────────────────────────────────────────────
-- Every transaction opens with SET LOCAL app.outlet_id / app.user_rank /
-- app.actor / app.scope / app.device. SET LOCAL dies with the transaction, so
-- a pooled connection can never carry one outlet's context into another's
-- query.

CREATE OR REPLACE FUNCTION app.current_outlet() RETURNS int
  LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.outlet_id', true), '')::int $$;

CREATE OR REPLACE FUNCTION app.current_rank() RETURNS int
  LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('app.user_rank', true), '')::int, 0) $$;

CREATE OR REPLACE FUNCTION app.current_actor() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.actor', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.current_device() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.device', true), '')::uuid $$;

-- Group scope is the ONE way to see across outlets. Rank 5 only, read-only,
-- and stamped on every row it touches in chain.audit.
CREATE OR REPLACE FUNCTION app.group_scope() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.scope', true) = 'group', false)
     AND app.current_rank() >= 5 $$;

-- ── the legal entity ───────────────────────────────────────────────────────
-- Captured once at onboarding: this is who files the return. The fascia a
-- guest sees is set separately, per outlet, under branding.
CREATE TABLE IF NOT EXISTS chain.company (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  legal_name    text NOT NULL,
  reg_no        text NOT NULL,
  tin           text NOT NULL,
  address       text NOT NULL,
  atoll         text,
  country       text NOT NULL DEFAULT 'Maldives',
  phone         text,
  email         text,
  base_currency text NOT NULL DEFAULT 'MVR',
  fy_start_month int NOT NULL DEFAULT 1 CHECK (fy_start_month BETWEEN 1 AND 12),
  brand         jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ── outlet registry ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chain.outlet (
  id            int PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  schema_name   text NOT NULL UNIQUE,
  db_role       text NOT NULL UNIQUE,
  kind          text NOT NULL DEFAULT 'restaurant',
  parent_id     int REFERENCES chain.outlet(id),
  currency      text NOT NULL DEFAULT 'MVR',
  tz            text NOT NULL DEFAULT 'Indian/Maldives',
  tax_code      text NOT NULL DEFAULT 'GGST' CHECK (tax_code IN ('GGST','TGST','NONE')),
  service_pct   numeric(5,2) NOT NULL DEFAULT 10,
  address       text,
  atoll         text,
  phone         text,
  slug          text UNIQUE,
  day_start     time NOT NULL DEFAULT '04:00',   -- the trading day is not the calendar day
  active        boolean NOT NULL DEFAULT true,
  onboarded_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── people. One five-rank ladder: Kitchen 1, Till 2, Manager 3, Admin 4,
--    Owner 5. Rank is the only gate; never a name, never a title string.
CREATE TABLE IF NOT EXISTS chain.staff (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  rank         int  NOT NULL CHECK (rank BETWEEN 1 AND 5),
  role_key     text NOT NULL DEFAULT 'Cashier',  -- the permission-catalogue key the UI reads
  outlet_id    int  REFERENCES chain.outlet(id),  -- NULL = group (rank 5 only)
  outlets      int[] NOT NULL DEFAULT '{}',       -- extra outlets granted to this PERSON
  pin_hash     text NOT NULL,
  pin_salt     text NOT NULL,
  failed       int  NOT NULL DEFAULT 0,
  locked_until timestamptz,
  perm_override jsonb NOT NULL DEFAULT '{}',
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_staff_are_owners CHECK (outlet_id IS NOT NULL OR rank = 5)
);
CREATE INDEX IF NOT EXISTS staff_outlet ON chain.staff(outlet_id);

CREATE TABLE IF NOT EXISTS chain.device (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id    int NOT NULL REFERENCES chain.outlet(id),
  label        text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('till','kds','expo','handheld','printer','display')),
  pair_code    text,
  pair_expires timestamptz,
  paired_at    timestamptz,
  last_seen    timestamptz,
  fingerprint  text,
  station      text,
  revoked      boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS device_outlet ON chain.device(outlet_id);

CREATE TABLE IF NOT EXISTS chain.session (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id   uuid NOT NULL REFERENCES chain.staff(id),
  outlet_id  int  NOT NULL REFERENCES chain.outlet(id),
  device_id  uuid REFERENCES chain.device(id),
  rank       int  NOT NULL,
  scope      text NOT NULL DEFAULT 'outlet' CHECK (scope IN ('outlet','group')),
  issued_at  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS session_outlet ON chain.session(outlet_id);
CREATE INDEX IF NOT EXISTS session_staff ON chain.session(staff_id);

-- ── tax, versioned by effective date so a rate change cannot restate a return
--    that was already filed. A version is law, not a demo figure.
CREATE TABLE IF NOT EXISTS chain.tax_version (
  id             bigserial PRIMARY KEY,
  outlet_id      int REFERENCES chain.outlet(id),   -- NULL = statutory history, all outlets
  code           text NOT NULL,                     -- GGST | TGST
  rate           numeric(5,2) NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  authority_ref  text,
  UNIQUE (outlet_id, code, effective_from)
);

-- ── document series. Numbers are allocated under a row lock, per outlet per
--    kind, so two terminals can never mint the same receipt number. A series,
--    once used, cannot be renumbered.
CREATE TABLE IF NOT EXISTS chain.doc_series (
  outlet_id int  NOT NULL REFERENCES chain.outlet(id),
  kind      text NOT NULL,                  -- SALE | CN | PO | GRN | PR | JV | DSP
  prefix    text NOT NULL,
  next_no   bigint NOT NULL DEFAULT 1,
  used      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (outlet_id, kind)
);

CREATE OR REPLACE FUNCTION chain.next_doc_no(p_kind text) RETURNS text
  LANGUAGE plpgsql AS $$
DECLARE v_outlet int := app.current_outlet(); v_no bigint; v_prefix text;
BEGIN
  IF v_outlet IS NULL THEN RAISE EXCEPTION 'no outlet context'; END IF;
  UPDATE chain.doc_series SET next_no = next_no + 1, used = true
    WHERE outlet_id = v_outlet AND kind = p_kind
    RETURNING next_no - 1, prefix INTO v_no, v_prefix;
  IF v_no IS NULL THEN RAISE EXCEPTION 'no % series for outlet %', p_kind, v_outlet; END IF;
  RETURN v_prefix || '-' || lpad(v_no::text, 6, '0');
END $$;

-- ── loyalty is deliberately chain-wide: a member earns at one outlet and
--    spends at another. Their visits stay with the outlet that served them.
CREATE TABLE IF NOT EXISTS chain.member (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text NOT NULL UNIQUE,
  name        text,
  email       text,
  home_outlet int REFERENCES chain.outlet(id),
  points      numeric(12,2) NOT NULL DEFAULT 0 CHECK (points >= 0),
  tier        text NOT NULL DEFAULT 'Member',
  credit_limit numeric(12,2) NOT NULL DEFAULT 0,
  notes       text,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  consent_at  timestamptz
);

-- ── supplier master is chain-level (one vendor, many outlets); orders,
--    deliveries and invoices live per outlet.
CREATE TABLE IF NOT EXISTS chain.supplier (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  trn        text,
  contact    text,
  phone      text,
  email      text,
  terms_days int NOT NULL DEFAULT 30,
  lead_days  int NOT NULL DEFAULT 2,
  active     boolean NOT NULL DEFAULT true
);

-- ── chain-level configuration the terminals read (currency list, fx rates,
--    payroll rules, acquirer contract rates). Structure, not trade data.
CREATE TABLE IF NOT EXISTS chain.setting (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

-- ── audit. Append-only: no UPDATE or DELETE grant is ever issued on it.
CREATE TABLE IF NOT EXISTS chain.audit (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  outlet_id int NOT NULL,
  actor     uuid,
  rank      int,
  device_id uuid,
  action    text NOT NULL,
  entity    text,
  entity_id text,
  before    jsonb,
  after     jsonb,
  scope     text NOT NULL DEFAULT 'outlet'
);
CREATE INDEX IF NOT EXISTS audit_outlet_at ON chain.audit(outlet_id, at DESC);

CREATE OR REPLACE FUNCTION chain.log(p_action text, p_entity text,
  p_entity_id text, p_before jsonb, p_after jsonb) RETURNS void
  LANGUAGE sql AS $$
  INSERT INTO chain.audit(outlet_id, actor, rank, device_id, action, entity,
                          entity_id, before, after, scope)
  VALUES (app.current_outlet(), app.current_actor(), app.current_rank(),
          app.current_device(), p_action, p_entity, p_entity_id, p_before, p_after,
          CASE WHEN app.group_scope() THEN 'group' ELSE 'outlet' END) $$;

-- Sign-in must be auditable before a session exists, so the failure path runs
-- without an actor. It still records the outlet and the device.
CREATE OR REPLACE FUNCTION chain.log_anon(p_outlet int, p_action text,
  p_entity text, p_entity_id text, p_after jsonb) RETURNS void
  LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO chain.audit(outlet_id, action, entity, entity_id, after)
  VALUES (p_outlet, p_action, p_entity, p_entity_id, p_after) $$;

-- ── the migration ledger itself ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chain.migration (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum   text
);
