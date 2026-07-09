-- KashikeyoPOS Cloud · Phase 2 schema (multi-tenant ready)
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

-- one row per business object; rowver is the global pull cursor
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

-- idempotency: each client op applied at most once
CREATE TABLE IF NOT EXISTS ops (
  org_id     TEXT NOT NULL,
  op_id      TEXT NOT NULL,
  register   TEXT,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, op_id)
);
