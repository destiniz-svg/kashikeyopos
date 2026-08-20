-- ═══ WHO OWNS THIS INSTALL ═════════════════════════════════════════════════
-- Until now the first person to reach an empty install claimed it with a name
-- and a PIN, and nothing above the outlet knew who they were. That works for a
-- till on a counter and not at all for a product people sign up to.
--
-- So there is now a plane ABOVE the outlet: an ACCOUNT, identified by an email
-- address, which owns companies and outlets. It is not a staff record and it
-- does not carry a rank on the floor —
--
--     an account signs up on the website and owns the business;
--     a staff member taps their face and keys four digits at the till.
--
-- Those are different acts by different people at different moments, and
-- conflating them is how a waiter ends up able to change the company's TIN.
-- The account that completes onboarding becomes the outlet's owner AND gets a
-- rank-5 staff record for the floor, because the founder is usually both.
--
-- Credentials are hashed with scrypt and a per-row salt, exactly like a staff
-- PIN. A social identity carries no password at all.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chain.account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text,
  -- Null for an account that only ever signs in through Google or Apple.
  password_hash text,
  password_salt text,
  -- A code is the same shape as a staff PIN: hashed, salted, expiring, and
  -- spent on use. It is used both to verify a new email and to sign in.
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

-- A social identity. The subject is the provider's own stable id — NOT the
-- email, which a person can change at the provider without telling us.
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

-- What an account owns. `owner` is the master admin — the account onboarding
-- was completed by — and there is exactly one per outlet.
CREATE TABLE IF NOT EXISTS chain.account_outlet (
  account_id uuid NOT NULL REFERENCES chain.account(id) ON DELETE CASCADE,
  outlet_id  int  NOT NULL REFERENCES chain.outlet(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','admin')),
  staff_id   uuid,                         -- their record on the floor, if any
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, outlet_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS account_outlet_one_owner
  ON chain.account_outlet (outlet_id) WHERE role = 'owner';

-- The company is owned by an account too: outlets are added under it later,
-- and the answer to "whose business is this" must not depend on which outlet
-- you happen to be looking at.
ALTER TABLE chain.company ADD COLUMN IF NOT EXISTS owner_account_id uuid
  REFERENCES chain.account(id);

-- ── the account plane is NOT reachable from an outlet's login role ─────────
-- Outlet roles are granted nothing on these tables. An account is authenticated
-- by the web tier on the owner connection, above the outlet entirely, so there
-- is no policy to get wrong and no grant to leak. Said explicitly rather than
-- left to the absence of a GRANT.
REVOKE ALL ON chain.account, chain.account_identity, chain.account_outlet
  FROM PUBLIC;

DO $g$
DECLARE o record;
BEGIN
  FOR o IN SELECT db_role FROM chain.outlet WHERE db_role IS NOT NULL LOOP
    EXECUTE format('REVOKE ALL ON chain.account, chain.account_identity,'
      || ' chain.account_outlet FROM %I', o.db_role);
  END LOOP;
END $g$;
