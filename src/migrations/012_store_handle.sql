-- ═══ A STORE HAS AN ADDRESS ════════════════════════════════════════════════
-- Until now `chain.outlet.slug` was a path fragment nobody chose: provisioning
-- derived it from the business name and stapled the outlet id on the end, and
-- the only place it surfaced was /g/<slug>. It is a HANDLE now, and a handle is
-- a public address:
--
--     https://<handle>.kashikeyopos.com
--
-- which is what a guest scans off the table and what a member opens to see
-- their card. That promotes the column from an internal convenience to a DNS
-- label a business prints on things, so it has to satisfy DNS and it has to
-- survive being chosen by a person:
--
--   · a valid DNS label — lowercase a-z, 0-9 and hyphen, 3 to 40 characters,
--     never starting or ending with a hyphen and never carrying two in a row.
--     A handle that cannot be resolved is not an address;
--   · not RESERVED. `www`, `mail`, `api` and their kind are infrastructure, and
--     a store that claimed one would take the platform's own name out of its
--     hands. This is not hypothetical: `webmail.` and `demo.` are probed by
--     scanners on this domain daily, and either would have been claimable.
--
-- The reserved names are a TABLE rather than a constant, because the set grows
-- with the product and a migration is the wrong place to learn that. The guard
-- is a trigger rather than a CHECK for the same reason — a CHECK cannot read
-- another table, and a list nobody can extend without a schema change is a list
-- that gets worked around.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chain.reserved_handle (
  name text PRIMARY KEY,
  why  text NOT NULL
);

INSERT INTO chain.reserved_handle (name, why) VALUES
  ('www','infrastructure'), ('api','infrastructure'), ('app','infrastructure'),
  ('apps','infrastructure'), ('cdn','infrastructure'), ('assets','infrastructure'),
  ('static','infrastructure'), ('media','infrastructure'), ('img','infrastructure'),
  ('images','infrastructure'), ('files','infrastructure'), ('download','infrastructure'),
  ('downloads','infrastructure'), ('proxy','infrastructure'), ('gateway','infrastructure'),
  ('vpn','infrastructure'), ('ssh','infrastructure'), ('ftp','infrastructure'),
  ('sftp','infrastructure'), ('ns1','infrastructure'), ('ns2','infrastructure'),
  ('dns','infrastructure'), ('mx','infrastructure'), ('smtp','mail'),
  ('imap','mail'), ('pop','mail'), ('mail','mail'), ('email','mail'),
  ('webmail','mail'), ('cpanel','hosting'), ('whm','hosting'), ('plesk','hosting'),
  ('admin','the platform'), ('administrator','the platform'), ('root','the platform'),
  ('system','the platform'), ('sys','the platform'), ('internal','the platform'),
  ('private','the platform'), ('secure','the platform'), ('ssl','the platform'),
  ('account','a product route'), ('accounts','a product route'),
  ('signin','a product route'), ('signup','a product route'),
  ('login','a product route'), ('logout','a product route'),
  ('onboarding','a product route'), ('dashboard','a product route'),
  ('portal','a product route'), ('pos','a product route'), ('kds','a product route'),
  ('kitchen','a product route'), ('till','a product route'),
  ('terminal','a product route'), ('member','a product route'),
  ('members','a product route'), ('card','a product route'),
  ('order','a product route'), ('orders','a product route'),
  ('guest','a product route'), ('g','a product route'), ('m','a product route'),
  ('p','a product route'), ('health','a product route'), ('healthz','a product route'),
  ('readyz','a product route'), ('metrics','a product route'),
  ('status','a product route'), ('monitor','a product route'),
  ('billing','commerce'), ('pay','commerce'), ('payments','commerce'),
  ('checkout','commerce'), ('invoice','commerce'), ('shop','commerce'),
  ('store','commerce'), ('staging','an environment'), ('stage','an environment'),
  ('dev','an environment'), ('test','an environment'), ('testing','an environment'),
  ('sandbox','an environment'), ('demo','an environment'), ('beta','an environment'),
  ('alpha','an environment'), ('preview','an environment'),
  ('kashikeyo','the brand'), ('kashikeyopos','the brand'), ('official','the brand'),
  ('blog','marketing'), ('news','marketing'), ('help','marketing'),
  ('support','marketing'), ('docs','marketing'), ('doc','marketing'),
  ('about','marketing'), ('legal','marketing'), ('terms','marketing'),
  ('privacy','marketing'), ('contact','marketing'), ('careers','marketing'),
  ('jobs','marketing'), ('press','marketing'), ('partner','marketing'),
  ('partners','marketing'), ('null','a word that breaks things'),
  ('undefined','a word that breaks things'), ('true','a word that breaks things'),
  ('false','a word that breaks things')
ON CONFLICT (name) DO NOTHING;

-- What a handle may look like. One definition, read by the constraint below
-- and by chain.handle_free() — src/handle.js states the same shape for the
-- browser, and test/handle.test.js asserts the two agree.
CREATE OR REPLACE FUNCTION chain.handle_shape_ok(h text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT h IS NOT NULL
     AND h ~ '^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$'
     AND h !~ '--'
$$;

-- WHY a handle cannot be used, as a sentence, or NULL when it can. One
-- function so that the answer the onboarding panel shows while somebody is
-- typing and the answer the database gives when they submit are the same
-- answer, arrived at the same way — including which of the three reasons it is.
CREATE OR REPLACE FUNCTION chain.handle_why(h text, p_outlet int DEFAULT NULL)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN NOT chain.handle_shape_ok(h)
      THEN 'that is not a usable store address'
    WHEN EXISTS (SELECT 1 FROM chain.reserved_handle r WHERE r.name = h)
      THEN format('"%s" is reserved for %s', h,
                  (SELECT why FROM chain.reserved_handle r WHERE r.name = h))
    WHEN EXISTS (SELECT 1 FROM chain.outlet o
                  WHERE o.slug = h AND (p_outlet IS NULL OR o.id <> p_outlet))
      THEN format('"%s" is already another store''s address', h)
    ELSE NULL
  END
$$;

-- Is this handle both well-formed and unclaimed? The same question, asked of
-- the same function, for callers that only need yes or no.
CREATE OR REPLACE FUNCTION chain.handle_free(h text, p_outlet int DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT chain.handle_why(h, p_outlet) IS NULL
$$;

-- Backfill before constraining: an outlet that predates the handle either has
-- no slug or has one shaped by the old rule. Give it something resolvable
-- rather than refuse to migrate.
UPDATE chain.outlet SET slug = 'store-' || id
 WHERE slug IS NULL OR NOT chain.handle_shape_ok(slug);

UPDATE chain.outlet o SET slug = o.slug || '-' || o.id
 WHERE EXISTS (SELECT 1 FROM chain.reserved_handle r WHERE r.name = o.slug);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'outlet_slug_is_a_handle'
                    AND conrelid = 'chain.outlet'::regclass) THEN
    ALTER TABLE chain.outlet
      ADD CONSTRAINT outlet_slug_is_a_handle CHECK (chain.handle_shape_ok(slug));
  END IF;
END $$;

ALTER TABLE chain.outlet ALTER COLUMN slug SET NOT NULL;

-- A CHECK cannot read chain.reserved_handle, so the reserved half is a trigger.
-- It refuses with the reason, because "invalid" sends somebody hunting for a
-- typo in a handle that is spelled perfectly and simply is not theirs to take.
CREATE OR REPLACE FUNCTION chain.outlet_handle_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE why text;
BEGIN
  SELECT r.why INTO why FROM chain.reserved_handle r WHERE r.name = NEW.slug;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('"%s" is reserved for %s and cannot be a store address', NEW.slug, why);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS outlet_handle_guard ON chain.outlet;
CREATE TRIGGER outlet_handle_guard
  BEFORE INSERT OR UPDATE OF slug ON chain.outlet
  FOR EACH ROW EXECUTE FUNCTION chain.outlet_handle_guard();

-- Every outlet role may read the reserved list and ask whether a handle is
-- free — an outlet adding a branch needs the same answer onboarding got. It
-- may not edit the list: that is the platform's.
GRANT SELECT ON chain.reserved_handle TO PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON chain.reserved_handle FROM PUBLIC;
