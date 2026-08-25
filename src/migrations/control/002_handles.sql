-- ═══ A HANDLE IS ONE NAME ON THE INTERNET ═══════════════════════════════════
-- `<name>.kashikeyopos.com` resolves for exactly one store, so the registry
-- that decides who holds a name cannot live inside a business's own database:
-- two customers there would each see an empty table and each be told the name
-- was free, and only one of them would get the traffic.
--
-- The whole rule set moves here, unchanged in substance. Uniqueness is still
-- enforced by the DATABASE — a primary key on the name, so two claims race and
-- one loses — and reservation is still a trigger, not an application check. It
-- is simply enforced in this database rather than in each business's.
--
-- A business database keeps chain.outlet.slug as its own copy for the pages it
-- renders. This table is authoritative; that column follows it.
--
-- A retired handle still does the two things it has always done: it redirects
-- 301 keeping path and query, and it cannot be claimed by anybody except the
-- outlet that gave it up. A dead QR is bad; a QR pointing at a competitor's
-- menu is worse.
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

INSERT INTO chain.reserved_handle (name, why) VALUES
  ('send', 'mail'),               -- SPF lives here (MX + TXT)
  ('track', 'mail'),              -- click tracking's CNAME, if ever enabled
  ('tracking', 'mail'),
  ('links', 'mail'),
  ('link', 'mail'),
  ('click', 'mail'),
  ('clicks', 'mail'),
  ('open', 'mail'),
  ('noreply', 'mail'),
  ('no-reply', 'mail'),
  ('reply', 'mail'),
  ('bounce', 'mail'),
  ('bounces', 'mail'),
  ('unsubscribe', 'mail'),
  ('notifications', 'mail'),
  ('notify', 'mail'),
  ('dkim', 'mail'),
  ('dmarc', 'mail'),
  ('spf', 'mail')
ON CONFLICT (name) DO NOTHING;


-- ── who holds a name, and who used to ──────────────────────────────────────
-- The primary key IS the uniqueness guarantee: two businesses claiming one
-- name race into the same row and one gets a constraint violation, which is a
-- refusal nobody had to remember to write.

CREATE TABLE IF NOT EXISTS chain.handle (
  name        text PRIMARY KEY,
  outlet_id   int  NOT NULL UNIQUE
              REFERENCES chain.outlet_directory(outlet_id) ON DELETE CASCADE,
  business_id int  NOT NULL REFERENCES chain.business(id) ON DELETE CASCADE,
  claimed_at  timestamptz NOT NULL DEFAULT now()
);

-- Nothing expires here. A card outlives the decision that renamed it, and a
-- retired handle costs a row.
CREATE TABLE IF NOT EXISTS chain.handle_history (
  name        text PRIMARY KEY,
  outlet_id   int  NOT NULL
              REFERENCES chain.outlet_directory(outlet_id) ON DELETE CASCADE,
  business_id int  NOT NULL REFERENCES chain.business(id) ON DELETE CASCADE,
  retired_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS handle_history_outlet
  ON chain.handle_history (outlet_id);

-- ── the rules, identical to the ones a business database used to hold ──────

CREATE OR REPLACE FUNCTION chain.handle_shape_ok(h text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT h IS NOT NULL
     AND h ~ '^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$'
     AND h !~ '--'
$$;

-- WHY a handle cannot be used, as a sentence, or NULL when it can. The
-- onboarding panel asks this while somebody is typing and the save path asks
-- it again, so a green tick cannot be followed by a refusal on save.
CREATE OR REPLACE FUNCTION chain.handle_why(h text, p_outlet int DEFAULT NULL)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN NOT chain.handle_shape_ok(h)
      THEN 'that is not a usable store address'
    WHEN EXISTS (SELECT 1 FROM chain.reserved_handle r WHERE r.name = h)
      THEN format('"%s" is reserved for %s', h,
                  (SELECT why FROM chain.reserved_handle r WHERE r.name = h))
    WHEN EXISTS (SELECT 1 FROM chain.handle x
                  WHERE x.name = h AND (p_outlet IS NULL OR x.outlet_id <> p_outlet))
      THEN format('"%s" is already another store''s address', h)
    WHEN EXISTS (SELECT 1 FROM chain.handle_history x
                  WHERE x.name = h AND (p_outlet IS NULL OR x.outlet_id <> p_outlet))
      THEN format('"%s" was another store''s address and still points at it', h)
    ELSE NULL
  END
$$;

-- Claim, or refuse BY NAME. A handle the business CHOSE is never quietly
-- swapped for a free one — they are about to print it.
CREATE OR REPLACE FUNCTION chain.claim_handle(
  p_outlet int, p_business int, p_handle text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE why text;
BEGIN
  why := chain.handle_why(p_handle, p_outlet);
  IF why IS NOT NULL THEN
    /* 23514, the same code chain.rename_outlet raised when this lived in a
       business database, because the route already knows that a check
       violation carrying no constraint name is a sentence somebody wrote for a
       person and passes it through. A second code would mean a second branch
       saying the same thing, and one of them would eventually rot. */
    RAISE EXCEPTION '%', why USING ERRCODE = '23514';
  END IF;
  -- Taking a name back that this outlet gave up frees the history row: it can
  -- only ever have been its own, because handle_why refused it otherwise.
  DELETE FROM chain.handle_history WHERE name = p_handle;
  INSERT INTO chain.handle (name, outlet_id, business_id)
  VALUES (p_handle, p_outlet, p_business)
  ON CONFLICT (outlet_id) DO UPDATE SET name = excluded.name,
    business_id = excluded.business_id, claimed_at = now();
  RETURN p_handle;
END $$;

/* Rename, keeping the address being given up. One transaction, because a
   rename that recorded the old handle and failed to set the new one leaves a
   store answering to an address the directory thinks is retired — and one that
   set the new one without recording the old kills every card already printed. */
CREATE OR REPLACE FUNCTION chain.rename_handle(p_outlet int, p_handle text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE was text; biz int;
BEGIN
  SELECT name, business_id INTO was, biz FROM chain.handle WHERE outlet_id = p_outlet;
  IF was IS NULL THEN
    RAISE EXCEPTION 'no outlet %', p_outlet USING ERRCODE = '23503';
  END IF;
  IF was = p_handle THEN RETURN was; END IF;   -- already there; nothing retires
  PERFORM chain.claim_handle(p_outlet, biz, p_handle);
  INSERT INTO chain.handle_history (name, outlet_id, business_id)
  VALUES (was, p_outlet, biz) ON CONFLICT (name) DO NOTHING;
  RETURN p_handle;
END $$;

-- Where an address points — current, or one a store gave up. The routing
-- answer for every guest request, and the reason a retired card still works.
CREATE OR REPLACE FUNCTION chain.handle_points_at(h text)
RETURNS TABLE (outlet_id int, business_id int, current boolean)
LANGUAGE sql STABLE AS $$
  SELECT x.outlet_id, x.business_id, true  FROM chain.handle x         WHERE x.name = h
  UNION ALL
  SELECT y.outlet_id, y.business_id, false FROM chain.handle_history y WHERE y.name = h
  LIMIT 1
$$;
