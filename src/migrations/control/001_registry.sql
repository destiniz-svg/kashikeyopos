-- ═══ THE CONTROL DATABASE ═══════════════════════════════════════════════════
-- One database for the whole product. It holds WHO signed up and WHICH
-- database their business lives in, and nothing a till ever reads on the hot
-- path.
--
-- Every business gets its own database (`kashikeyo_biz_<id>`) carrying the
-- schema this repo has always had — company, staff, members, the outlet
-- schemas and their login roles. That boundary is not a preference: a sale
-- moves chain.member.points and credit_used in the SAME transaction as the
-- journal, and Postgres has no cross-database transaction, so a member balance
-- outside the sale's database means a crash can take the money without the
-- balance.
--
-- What lives here is exactly what must be true ACROSS businesses:
--
--   an account          one person, one email, possibly several businesses
--   a business          its database, and how far its schema has been migrated
--   an outlet id        allocated globally, so a token naming outlet 7 names
--                       exactly one store anywhere in the estate
--   a handle            <name>.kashikeyopos.com is one name on the internet
--
-- The account plane moved here from migration 011. It could not stay in a
-- business database: one account may own several, and sign-in would otherwise
-- have to search every database in the cluster to find out whether an address
-- is known.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS chain;

-- The runner's own ledger, same shape as a business database's, so one
-- migrate() serves both and a checksum means the same thing in each.
CREATE TABLE IF NOT EXISTS chain.migration (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum   text
);

-- ── who signed up ──────────────────────────────────────────────────────────
-- Verbatim from migration 011: an ACCOUNT signs up on the website and owns the
-- business; a STAFF member taps their face at the till and keys four digits.
-- Different people, different moments, different credentials.

CREATE TABLE IF NOT EXISTS chain.account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text,
  password_hash text,
  password_salt text,
  code_hash     text,
  code_salt     text,
  code_exp      timestamptz,
  code_tries    int NOT NULL DEFAULT 0,
  code_purpose  text,
  verified_at   timestamptz,
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','suspended')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  failed        int NOT NULL DEFAULT 0,
  locked_until  timestamptz
);
-- One account per address, however it is typed.
CREATE UNIQUE INDEX IF NOT EXISTS account_email ON chain.account (lower(email));

CREATE TABLE IF NOT EXISTS chain.account_identity (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES chain.account(id) ON DELETE CASCADE,
  provider   text NOT NULL CHECK (provider IN ('google','apple')),
  subject    text NOT NULL,
  email      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS account_identity_sub
  ON chain.account_identity (provider, subject);
CREATE INDEX IF NOT EXISTS account_identity_acct
  ON chain.account_identity (account_id);

-- ── the businesses, and where each one lives ───────────────────────────────
-- `db_name` is the routing answer for every request: a token names an outlet,
-- the directory below says which business, and this says which database to
-- open. `schema_version` is how many migrations that database has applied —
-- a business behind head is refused rather than served on a stale schema.

CREATE TABLE IF NOT EXISTS chain.business (
  id             int PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name           text NOT NULL,
  db_name        text NOT NULL UNIQUE,
  status         text NOT NULL DEFAULT 'building'
                 CHECK (status IN ('building','live','suspended','failed')),
  -- Which step a half-built business reached, in its own words. Written BEFORE
  -- each step rather than after: the expensive failure is not an error, it is
  -- an orphan — a database nobody knows about, which is invisible until
  -- somebody reads the cluster by hand.
  build_state    text,
  schema_version int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  live_at        timestamptz
);

CREATE TABLE IF NOT EXISTS chain.account_business (
  account_id  uuid NOT NULL REFERENCES chain.account(id) ON DELETE CASCADE,
  business_id int  NOT NULL REFERENCES chain.business(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','admin')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, business_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS account_business_one_owner
  ON chain.account_business (business_id) WHERE role = 'owner';

-- ── outlet ids are allocated HERE, not per database ────────────────────────
-- provision.js took max(id)+1 inside one install, so every install had an
-- outlet 1. Under one cluster that is the install-uuid problem again (026): a
-- session token naming outlet 7 must resolve to exactly one store, or one
-- customer's terminal can address another's. The sequence is the allocator and
-- the directory is the map.

CREATE SEQUENCE IF NOT EXISTS chain.outlet_id_seq AS int START 1;

CREATE TABLE IF NOT EXISTS chain.outlet_directory (
  outlet_id   int  PRIMARY KEY,
  business_id int  NOT NULL REFERENCES chain.business(id) ON DELETE CASCADE,
  name        text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outlet_directory_business
  ON chain.outlet_directory (business_id);

-- ── the registry keeps its own trail ───────────────────────────────────────
-- An account event happens ABOVE every outlet and now above every business, so
-- it has nowhere else to be written. It has to exist here, and the reason is
-- worth remembering: chain.audit.outlet_id used to be NOT NULL while account
-- events were written with NULL, so every insert failed, was swallowed by a
-- .catch(() => {}), and NOT ONE account event ever reached the trail — while
-- the sign-in screen told the customer their code was in it. Migration 035
-- fixed that in a business database. Getting it wrong again here, by simply
-- not having the table, would be the same defect wearing a new shape.
CREATE TABLE IF NOT EXISTS chain.audit (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  outlet_id int,
  actor     uuid,
  rank      int,
  device_id uuid,
  action    text NOT NULL,
  entity    text,
  entity_id text,
  before    jsonb,
  after     jsonb,
  scope     text NOT NULL DEFAULT 'group'
);
CREATE INDEX IF NOT EXISTS audit_at ON chain.audit (at DESC);
CREATE INDEX IF NOT EXISTS audit_action ON chain.audit (action, at DESC);
