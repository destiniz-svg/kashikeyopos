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
