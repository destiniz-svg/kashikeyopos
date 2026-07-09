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
