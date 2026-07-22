-- KashikeyoPOS Cloud · multi-store, multi-tenant schema
CREATE TABLE IF NOT EXISTS orgs (
  id          TEXT PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  email       TEXT UNIQUE NOT NULL,
  pass_hash   TEXT NOT NULL,
  store_name  TEXT NOT NULL,
  registers   INT  NOT NULL DEFAULT 0,
  oseq        BIGINT NOT NULL DEFAULT 500,      -- server-assigned guest order numbers
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'trial';
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '14 days';
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS owner_name TEXT NOT NULL DEFAULT '';
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'password';
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS google_sub TEXT;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS apple_sub TEXT;
-- false only for orgs created by a first-time social sign-in: they still owe
-- the /welcome step (store name, currency, PIN). Email signups collected all
-- of that in the wizard, and every pre-existing org is grandfathered in.
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS onboarded BOOLEAN NOT NULL DEFAULT true;
-- Each till session mints a fresh register id (R1, R2, …) for op attribution,
-- so this counter only ever climbs. Widen INT → BIGINT so it can never
-- overflow over a busy store's lifetime. Guarded so the boot migration is a
-- no-op once widened.
DO $reg$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='orgs' AND column_name='registers' AND data_type='integer') THEN
    ALTER TABLE orgs ALTER COLUMN registers TYPE BIGINT;
  END IF;
END $reg$;
CREATE UNIQUE INDEX IF NOT EXISTS orgs_google_sub_uq ON orgs (google_sub) WHERE google_sub IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orgs_apple_sub_uq ON orgs (apple_sub) WHERE apple_sub IS NOT NULL;

-- one company/workspace can operate many physical stores/branches
CREATE TABLE IF NOT EXISTS stores (
  id          TEXT NOT NULL,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  address     TEXT NOT NULL DEFAULT '',
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, code)
);
CREATE INDEX IF NOT EXISTS stores_org ON stores (org_id, active);

-- one row per business object; rowver is the global pull cursor
-- Store-scoped rows carry data.storeId. Shared rows omit storeId or use "global".
CREATE TABLE IF NOT EXISTS entities (
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  kind        TEXT NOT NULL,
  id          TEXT NOT NULL,
  data        JSONB NOT NULL,
  deleted     BOOLEAN NOT NULL DEFAULT false,
  rowver      BIGSERIAL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, kind, id)
);
CREATE INDEX IF NOT EXISTS entities_pull ON entities (org_id, rowver);
CREATE INDEX IF NOT EXISTS entities_store ON entities (org_id, kind, ((data->>'storeId')), rowver);

-- idempotency: each client op applied at most once
CREATE TABLE IF NOT EXISTS ops (
  org_id     TEXT NOT NULL,
  op_id      TEXT NOT NULL,
  register   TEXT,
  store_id   TEXT NOT NULL DEFAULT 'main',
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, op_id)
);
ALTER TABLE ops ADD COLUMN IF NOT EXISTS store_id TEXT NOT NULL DEFAULT 'main';

-- platform staff who can sign into the developer panel (cross-tenant, not
-- subject to row level security below — this table holds no store data)
CREATE TABLE IF NOT EXISTS platform_admins (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  pass_hash   TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Row Level Security ──────────────────────────────────────────────────
-- Every tenant-data table is scoped to the Postgres session GUC app.org_id,
-- set per-request via SELECT set_config('app.org_id', $1, true) inside a
-- transaction (see index.js withOrg/withSystem). app.is_superadmin is an
-- explicit escape hatch for trusted system-level lookups (login by email,
-- guest boot by slug, the developer panel) where no single org_id applies.
-- FORCE is set so even the owning role (used to run this migration) is
-- bound by these policies once the app switches to the restricted
-- kashikeyo_app role below for all request handling.
ALTER TABLE orgs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs     FORCE ROW LEVEL SECURITY;
ALTER TABLE stores   ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores   FORCE ROW LEVEL SECURITY;
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities FORCE ROW LEVEL SECURITY;
ALTER TABLE ops      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops      FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON orgs;
CREATE POLICY tenant_isolation ON orgs
  USING (id = current_setting('app.org_id', true) OR current_setting('app.is_superadmin', true) = 'on')
  WITH CHECK (id = current_setting('app.org_id', true) OR current_setting('app.is_superadmin', true) = 'on');

DROP POLICY IF EXISTS tenant_isolation ON stores;
CREATE POLICY tenant_isolation ON stores
  USING (org_id = current_setting('app.org_id', true) OR current_setting('app.is_superadmin', true) = 'on')
  WITH CHECK (org_id = current_setting('app.org_id', true) OR current_setting('app.is_superadmin', true) = 'on');

DROP POLICY IF EXISTS tenant_isolation ON entities;
CREATE POLICY tenant_isolation ON entities
  USING (org_id = current_setting('app.org_id', true) OR current_setting('app.is_superadmin', true) = 'on')
  WITH CHECK (org_id = current_setting('app.org_id', true) OR current_setting('app.is_superadmin', true) = 'on');

DROP POLICY IF EXISTS tenant_isolation ON ops;
CREATE POLICY tenant_isolation ON ops
  USING (org_id = current_setting('app.org_id', true) OR current_setting('app.is_superadmin', true) = 'on')
  WITH CHECK (org_id = current_setting('app.org_id', true) OR current_setting('app.is_superadmin', true) = 'on');

-- ── Inventory & Pricing (recipe-first, periodic-audit) ─────────────────────
-- Design: docs/inventory-and-pricing.md. All quantities are NUMERIC in the
-- ingredient's BASE unit (g / ml / pcs); bulk units (Case, Bottle, 25kg bag)
-- are per-ingredient conversion factors, applied at the edges (invoice entry,
-- stock-check entry) and never stored. All money is NUMERIC laari (the
-- integer sub-unit the rest of the system uses); unit costs keep 6 decimals
-- because a cost per gram is routinely a fraction of a laari.

CREATE TABLE IF NOT EXISTS ingredients (
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  name          TEXT NOT NULL,
  sku           TEXT NOT NULL DEFAULT '',
  base_unit     TEXT NOT NULL DEFAULT 'g',       -- g | ml | pcs
  current_stock NUMERIC(14,3) NOT NULL DEFAULT 0, -- base units
  min_stock     NUMERIC(14,3) NOT NULL DEFAULT 0, -- low-stock alert threshold
  avg_cost      NUMERIC(16,6) NOT NULL DEFAULT 0, -- laari per base unit (weighted average)
  location      TEXT NOT NULL DEFAULT 'Dry',      -- Fridge | Freezer | Dry | Bar | ...
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS ingredients_org_loc ON ingredients (org_id, location) WHERE active;
CREATE UNIQUE INDEX IF NOT EXISTS ingredients_sku_uq ON ingredients (org_id, sku) WHERE sku <> '';

-- Bulk/pack units: factor = how many base units one pack holds
-- ("Case" of 24×330ml → factor 7920 for an ml-based ingredient).
CREATE TABLE IF NOT EXISTS ingredient_units (
  org_id        TEXT NOT NULL,
  id            TEXT NOT NULL,
  ingredient_id TEXT NOT NULL,
  name          TEXT NOT NULL,
  factor        NUMERIC(16,6) NOT NULL CHECK (factor > 0),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, ingredient_id) REFERENCES ingredients (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ingredient_units_ing ON ingredient_units (org_id, ingredient_id);

-- Recipe: menu item (entities kind='products' id) -> ingredient quantities.
-- qty is base units consumed per ONE unit sold.
CREATE TABLE IF NOT EXISTS recipe_lines (
  org_id        TEXT NOT NULL,
  id            TEXT NOT NULL,
  product_id    TEXT NOT NULL,
  ingredient_id TEXT NOT NULL,
  qty           NUMERIC(14,6) NOT NULL CHECK (qty > 0),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, ingredient_id) REFERENCES ingredients (org_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS recipe_lines_uq ON recipe_lines (org_id, product_id, ingredient_id);
CREATE INDEX IF NOT EXISTS recipe_lines_product ON recipe_lines (org_id, product_id);

-- Immutable movement ledger — the source of truth every report/audit derives
-- from. qty is signed (+in / -out, base units). The partial unique index on
-- (org_id, ref, ingredient_id) is what makes sale deduction idempotent: a
-- replayed sync op inserts nothing and therefore deducts nothing.
CREATE TABLE IF NOT EXISTS stock_moves (
  org_id        TEXT NOT NULL,
  id            TEXT NOT NULL,
  ingredient_id TEXT NOT NULL,
  store_id      TEXT NOT NULL DEFAULT 'main',
  kind          TEXT NOT NULL,                    -- sale | refund | purchase | audit | manual
  qty           NUMERIC(14,3) NOT NULL,
  unit_cost     NUMERIC(16,6) NOT NULL DEFAULT 0, -- laari per base unit at move time
  ref           TEXT NOT NULL DEFAULT '',         -- sale:<id> | invoice:<id> | audit:<id>
  note          TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_moves_ref_uq ON stock_moves (org_id, ref, ingredient_id) WHERE ref <> '';
CREATE INDEX IF NOT EXISTS stock_moves_ing_t ON stock_moves (org_id, ingredient_id, created_at);
CREATE INDEX IF NOT EXISTS stock_moves_kind_t ON stock_moves (org_id, kind, created_at);

-- One "stock check" (periodic audit). COGS on close = opening_value
-- + purchases_value - closing_value (periodic inventory method).
CREATE TABLE IF NOT EXISTS audit_sessions (
  org_id          TEXT NOT NULL,
  id              TEXT NOT NULL,
  label           TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'open',   -- open | closed
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ,
  started_by      TEXT NOT NULL DEFAULT '',
  opening_value   NUMERIC(14,2) NOT NULL DEFAULT 0,
  purchases_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  closing_value   NUMERIC(14,2) NOT NULL DEFAULT 0,
  cogs            NUMERIC(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS audit_sessions_org ON audit_sessions (org_id, started_at DESC);

CREATE TABLE IF NOT EXISTS audit_lines (
  org_id        TEXT NOT NULL,
  id            TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  ingredient_id TEXT NOT NULL,
  expected      NUMERIC(14,3) NOT NULL DEFAULT 0, -- system stock at count time
  counted       NUMERIC(14,3),                    -- NULL until the owner enters it
  variance      NUMERIC(14,3) NOT NULL DEFAULT 0,
  variance_pct  NUMERIC(8,2) NOT NULL DEFAULT 0,
  flag          TEXT NOT NULL DEFAULT 'ok',       -- ok | review (>5% variance)
  reason        TEXT NOT NULL DEFAULT '',         -- Spoilage | Staff meal | Waste | Count error | Other
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, session_id, ingredient_id)
);
CREATE INDEX IF NOT EXISTS audit_lines_session ON audit_lines (org_id, session_id);

-- Procurement: suppliers + received invoices (posting an invoice is what
-- moves stock in and re-averages ingredient cost).
CREATE TABLE IF NOT EXISTS suppliers (
  org_id     TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS suppliers_org ON suppliers (org_id) WHERE active;

CREATE TABLE IF NOT EXISTS purchase_invoices (
  org_id      TEXT NOT NULL,
  id          TEXT NOT NULL,
  supplier_id TEXT NOT NULL DEFAULT '',
  invoice_no  TEXT NOT NULL DEFAULT '',
  total       NUMERIC(14,2) NOT NULL DEFAULT 0,   -- laari
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS purchase_invoices_org ON purchase_invoices (org_id, received_at DESC);

CREATE TABLE IF NOT EXISTS purchase_invoice_lines (
  org_id        TEXT NOT NULL,
  id            TEXT NOT NULL,
  invoice_id    TEXT NOT NULL,
  ingredient_id TEXT NOT NULL,
  qty           NUMERIC(14,3) NOT NULL,           -- as entered, in unit_name
  unit_name     TEXT NOT NULL DEFAULT '',         -- '' = base unit
  factor        NUMERIC(16,6) NOT NULL DEFAULT 1, -- captured at entry time
  base_qty      NUMERIC(14,3) NOT NULL,           -- qty * factor
  line_cost     NUMERIC(14,2) NOT NULL,           -- laari, whole line
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS purchase_invoice_lines_inv ON purchase_invoice_lines (org_id, invoice_id);

-- RLS: same tenant_isolation contract as the core tables.
DO $rls$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ingredients','ingredient_units','recipe_lines','stock_moves',
                           'audit_sessions','audit_lines','suppliers','purchase_invoices','purchase_invoice_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (org_id = current_setting('app.org_id', true) OR current_setting('app.is_superadmin', true) = 'on')
      WITH CHECK (org_id = current_setting('app.org_id', true) OR current_setting('app.is_superadmin', true) = 'on')$p$, t);
  END LOOP;
END $rls$;

-- ── Incremental migrations (idempotent, run on every boot) ─────────────────

-- Per-location stock. A move happens AT a location; a blank location means the
-- ingredient's own "home" location (ingredients.location), so historical rows
-- need no backfill. Per-location balances are derived from this ledger
-- (SUM(qty) grouped by COALESCE(NULLIF(location,''), home)); the total stays
-- the cached ingredients.current_stock. A transfer is two net-zero moves
-- (kind='transfer'): -qty at the source location, +qty at the destination.
ALTER TABLE stock_moves ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS stock_moves_ing_loc ON stock_moves (org_id, ingredient_id, location);

-- Item roles (§6, first step): an ingredient can also carry the "sellable"
-- role — a resale item bought and sold as-is (a canned drink), no recipe to
-- build. When set, the app keeps a linked till product + a 1:1 self-recipe in
-- step, so the one item plays both the stockable and the sellable role while
-- the underlying tables stay as they are.
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS sellable   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS sell_price NUMERIC(14,2) NOT NULL DEFAULT 0; -- laari
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS product_id TEXT NOT NULL DEFAULT '';         -- linked entities product

-- Item roles (§6, prep step): an ingredient can also carry the "producible"
-- role — a prep / made-in-house item (dough, sauce, cold-brew concentrate)
-- built from other ingredients. Its build recipe lives in recipe_lines keyed
-- by the prep ingredient's OWN id (product_id = ingredient id), reusing the
-- recipe machinery. Making a batch consumes the components and stocks the prep
-- item, rolling their cost into its weighted average — so one item is both
-- built-from-a-recipe and a stock item consumed by other recipes.
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS producible BOOLEAN NOT NULL DEFAULT false;

-- Change / audit trail (audit FIN-03). An append-only record of sensitive,
-- server-observed events — money-integrity flags, credit over-limit breaches,
-- flag acknowledgements, refunds and voids — so a manager/accountant can answer
-- "who did what, when, and why" without trusting a mutable entity row. Written
-- server-side only; never updated or deleted by the app (no UPDATE/DELETE grant).
CREATE TABLE IF NOT EXISTS activity_log (
  id         BIGSERIAL,
  org_id     TEXT NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor      TEXT NOT NULL DEFAULT '',   -- staff name/id, or 'system'
  action     TEXT NOT NULL,              -- e.g. sale.flagged, credit.over_limit, flag.ack, sale.refund, sale.void
  ref        TEXT NOT NULL DEFAULT '',   -- related sale no / entity id
  request_id TEXT NOT NULL DEFAULT '',   -- correlates to the request that caused it (OPS-02)
  detail     JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS activity_log_org_at ON activity_log (org_id, at DESC);
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON activity_log;
CREATE POLICY tenant_isolation ON activity_log
  USING (org_id = current_setting('app.org_id', true) OR current_setting('app.is_superadmin', true) = 'on')
  WITH CHECK (org_id = current_setting('app.org_id', true) OR current_setting('app.is_superadmin', true) = 'on');

-- Expiry / shelf-life lots (P3). A lightweight lot ledger: each delivery line
-- with a use-by date records a lot (received base-unit qty + expiry). We do NOT
-- decrement lots on the hot sale path (that stays the audited stock_moves +
-- current_stock cache); instead the "what's expiring" view allocates the cached
-- current_stock across lots FEFO at read time (earliest-expiry consumed first,
-- so remaining stock sits in the latest lots) — flagging slow-moving stock about
-- to spoil without touching the offline-critical deduction path.
CREATE TABLE IF NOT EXISTS ingredient_lots (
  org_id        TEXT NOT NULL,
  id            TEXT NOT NULL,
  ingredient_id TEXT NOT NULL,
  store_id      TEXT NOT NULL DEFAULT 'main',
  expiry        DATE,
  qty           NUMERIC(14,3) NOT NULL DEFAULT 0,   -- received base units
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ref           TEXT NOT NULL DEFAULT '',           -- invoice:<invId>:<lineId>
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS ingredient_lots_ing ON ingredient_lots (org_id, ingredient_id, expiry);
ALTER TABLE ingredient_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingredient_lots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingredient_lots;
CREATE POLICY tenant_isolation ON ingredient_lots
  USING (org_id = current_setting('app.org_id', true) OR current_setting('app.is_superadmin', true) = 'on')
  WITH CHECK (org_id = current_setting('app.org_id', true) OR current_setting('app.is_superadmin', true) = 'on');
