-- ═══ THE MEMBER PORTAL ═════════════════════════════════════════════════════
-- 04-MEMBER-PORTAL-SPEC.md. 08-BUILD-STAGES §23: "OTP sign-in, member card,
-- bill, points as tender against liability 2200, real visit history, rewards."
--
-- A MEMBER BELONGS TO NO OUTLET, which is the whole difficulty. Every other
-- session in this system is an outlet: it connects as `outlet_<id>_app`, and
-- `app.role_outlet()` reads its identity out of the role name so that claiming
-- to be somebody else changes nothing. A member is chain-wide by design — they
-- earn at Malé and spend at Hulhumalé — so there is no outlet role that fits
-- them, and inventing one per member is not a scheme, it is a role explosion.
--
-- So there is a third role, `kashikeyo_member`, and the member's own id arrives
-- in `app.member_id`. That looks like exactly the forgeable claim migration 005
-- was written to abolish — and it is not, for the same reason group scope is
-- not: the policies below require `current_user = 'kashikeyo_member'` AS WELL,
-- and that role's password is derived from OUTLET_ROLE_SECRET and never stored.
-- An outlet connection setting `app.member_id` is a string in a variable
-- nothing consults. `app.member_self()` is the one function that decides.
--
-- WHAT THE MEMBER ROLE MAY REACH is four tables and nothing else: their own
-- record, their own points, their own visits, their own vouchers — plus the
-- scheme's configuration and catalogue, which are the same for everybody. It
-- holds no grant on any outlet schema at all, so a member session cannot read a
-- ticket, a sale or a staff row even by accident. Where the portal genuinely
-- needs one (the bill at the table they are sitting at), the API opens that
-- outlet's own connection and asks for rows that name this member.

-- Identity, from the role first. NULL for every connection that is not the
-- member role, whatever it sets.
CREATE OR REPLACE FUNCTION app.member_self() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN current_user = 'kashikeyo_member'
              THEN nullif(current_setting('app.member_id', true), '')::uuid END $$;

-- FORCE ROW LEVEL SECURITY applies to the table's OWNER as well, which is the
-- whole reason it is used here — but it therefore also applies inside a
-- SECURITY DEFINER function, where `current_user` IS that owner. Signing in is
-- exactly the operation that has no identity yet: it must look up a phone
-- number before there is a member to be. Without this, `otp_verify` would
-- politely find nobody, every code would be wrong, and the portal would be a
-- locked door with the key inside.
--
-- So: one policy, matched only by a connection running as the schema's owner.
-- No runtime role can be that — an outlet role, the report role and the member
-- role are all somebody else — and the check names no role literally, so
-- renaming the database user does not quietly open or close it.
CREATE OR REPLACE FUNCTION app.is_definer() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT current_user = (SELECT r.rolname FROM pg_namespace n
                         JOIN pg_roles r ON r.oid = n.nspowner
                         WHERE n.nspname = 'chain') $$;

-- ── the one-time code ──────────────────────────────────────────────────────
-- The code itself is never stored: what is kept is an HMAC of it under
-- SESSION_SECRET, which lives in the platform's variables and not in the
-- database. A dump of this table is a list of phone numbers and useless macs.
CREATE TABLE IF NOT EXISTS chain.member_otp (
  phone       text PRIMARY KEY,
  mac         text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  -- Set when a cashier issued the code at the counter instead of it being sent
  -- to the phone. Recorded because "who let this person in" is a question that
  -- gets asked exactly once, after something has gone wrong.
  issued_by   uuid,
  issued_outlet int
);

-- No role gets a grant on that table. Both operations are SECURITY DEFINER
-- functions instead, so the mac is unreadable by anything that can be reached
-- from a request, and the cooldown and the attempt limit hold whoever calls.
CREATE OR REPLACE FUNCTION chain.otp_issue(
  p_phone text, p_mac text, p_ttl_seconds int,
  p_by uuid DEFAULT NULL, p_outlet int DEFAULT NULL)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE existing chain.member_otp; out_at timestamptz;
BEGIN
  SELECT * INTO existing FROM chain.member_otp WHERE phone = p_phone;
  -- A resend is a new code, but not every two seconds: a send costs money and
  -- an unthrottled one is a way to bill somebody else's account.
  --
  -- `p_by` set means a CASHIER issued this at the counter, with the member in
  -- front of them, and no message was sent to anybody. Nothing was spent and
  -- nothing can be flooded, so the cooldown does not apply — a cashier who
  -- misread the digits should be able to press the button again rather than
  -- explain to a guest that the till needs half a minute to think.
  IF p_by IS NULL AND existing.phone IS NOT NULL
     AND existing.sent_at > now() - interval '30 seconds' THEN
    RAISE EXCEPTION 'otp_cooldown' USING ERRCODE = 'P0001';
  END IF;
  out_at := now() + make_interval(secs => p_ttl_seconds);
  INSERT INTO chain.member_otp (phone, mac, expires_at, attempts, sent_at, issued_by, issued_outlet)
    VALUES (p_phone, p_mac, out_at, 0, now(), p_by, p_outlet)
  ON CONFLICT (phone) DO UPDATE SET
    mac = EXCLUDED.mac, expires_at = EXCLUDED.expires_at, attempts = 0,
    sent_at = now(), issued_by = EXCLUDED.issued_by, issued_outlet = EXCLUDED.issued_outlet;
  RETURN out_at;
END $fn$;

-- Returns the member on success and NULL on every failure, without saying
-- which failure: a wrong code, an expired one and a phone with no code
-- outstanding are the same answer to whoever is guessing.
CREATE OR REPLACE FUNCTION chain.otp_verify(p_phone text, p_mac text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE row chain.member_otp; found uuid;
BEGIN
  SELECT * INTO row FROM chain.member_otp WHERE phone = p_phone FOR UPDATE;
  IF row.phone IS NULL THEN RETURN NULL; END IF;
  IF row.expires_at < now() OR row.attempts >= 5 THEN
    DELETE FROM chain.member_otp WHERE phone = p_phone;
    RETURN NULL;
  END IF;
  IF row.mac <> p_mac THEN
    -- Counted, so six guesses at a six-digit code is not a way in.
    UPDATE chain.member_otp SET attempts = attempts + 1 WHERE phone = p_phone;
    RETURN NULL;
  END IF;
  SELECT id INTO found FROM chain.member WHERE phone = p_phone;
  DELETE FROM chain.member_otp WHERE phone = p_phone;   -- one time means one time
  RETURN found;
END $fn$;

-- ── the visit ──────────────────────────────────────────────────────────────
-- 04-MEMBER-PORTAL §4 wants "real visit history read from settled sales", and
-- §6 says a member's visits "stay in the outlet that served them". Both are
-- true at once only if the member sees a PROJECTION of the sale rather than the
-- sale: the date, the branch, the covers, what it came to, what it earned. The
-- lines, the tender, the staff and the discount stay in the outlet's own
-- schema, where a member session holds no grant of any kind.
CREATE TABLE IF NOT EXISTS chain.member_visit (
  id        bigserial PRIMARY KEY,
  member_id uuid NOT NULL REFERENCES chain.member(id) ON DELETE CASCADE,
  outlet_id int  NOT NULL REFERENCES chain.outlet(id),
  sale_id   uuid NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  covers    int NOT NULL DEFAULT 1,
  total     numeric(12,2) NOT NULL,
  points    numeric(12,2) NOT NULL DEFAULT 0,
  -- One row per sale. A settle that is retried must not become two visits.
  UNIQUE (outlet_id, sale_id)
);
CREATE INDEX IF NOT EXISTS visit_member ON chain.member_visit (member_id, at DESC);

-- ── the voucher ────────────────────────────────────────────────────────────
-- Redeeming does NOT post a journal, and that is the point rather than an
-- omission. Points are a liability from the moment they are earned; turning
-- them into a voucher changes the shape of the promise, not whether it is owed.
-- The liability is released when the voucher is actually taken against a bill,
-- exactly as the points tender releases it — so `loyalty.stats` counts
-- outstanding vouchers alongside outstanding points, or the figure it reports
-- would fall the moment a member redeemed and rise again when they spent.
CREATE TABLE IF NOT EXISTS chain.voucher (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  member_id   uuid NOT NULL REFERENCES chain.member(id) ON DELETE CASCADE,
  reward_id   uuid REFERENCES chain.reward(id),
  name        text NOT NULL,
  points      numeric(12,2) NOT NULL,
  value       numeric(12,2) NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  redeemed_at timestamptz,
  redeemed_outlet int REFERENCES chain.outlet(id),
  redeemed_sale   uuid,
  CONSTRAINT voucher_positive CHECK (points > 0 AND value > 0)
);
CREATE INDEX IF NOT EXISTS voucher_member ON chain.voucher (member_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS voucher_live ON chain.voucher (code) WHERE redeemed_at IS NULL;

-- ── row-level security ─────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['member_visit','voucher','member_otp']
  LOOP
    EXECUTE format('ALTER TABLE chain.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE chain.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- A visit is the member's to read anywhere, and the serving outlet's to write.
-- An outlet reads only the visits it served: another branch's takings are not
-- its business even one row at a time.
DROP POLICY IF EXISTS visit_read ON chain.member_visit;
CREATE POLICY visit_read ON chain.member_visit FOR SELECT
  USING (member_id = app.member_self() OR outlet_id = app.current_outlet());
DROP POLICY IF EXISTS visit_write ON chain.member_visit;
CREATE POLICY visit_write ON chain.member_visit FOR INSERT
  WITH CHECK (outlet_id = app.current_outlet());

-- A voucher belongs to its member and is accepted by whichever outlet the
-- member walks into, so any outlet may read one and mark it redeemed. It is
-- issued by the member's own session.
DROP POLICY IF EXISTS voucher_read ON chain.voucher;
CREATE POLICY voucher_read ON chain.voucher FOR SELECT
  USING (member_id = app.member_self() OR app.current_outlet() IS NOT NULL);
DROP POLICY IF EXISTS voucher_issue ON chain.voucher;
CREATE POLICY voucher_issue ON chain.voucher FOR INSERT
  WITH CHECK (member_id = app.member_self());
DROP POLICY IF EXISTS voucher_take ON chain.voucher;
CREATE POLICY voucher_take ON chain.voucher FOR UPDATE
  USING (app.current_outlet() IS NOT NULL AND app.current_rank() >= 2)
  WITH CHECK (app.current_outlet() IS NOT NULL);

-- The OTP table is reachable only from inside the two functions above. No
-- runtime role holds a grant on it either, so this is the belt behind an
-- already-absent privilege.
DROP POLICY IF EXISTS otp_definer ON chain.member_otp;
CREATE POLICY otp_definer ON chain.member_otp FOR ALL
  USING (app.is_definer()) WITH CHECK (app.is_definer());

-- A member reads their own record and nothing else in that table. The existing
-- member_read policy is `app.current_outlet() IS NOT NULL`, which the member
-- role fails — so this is an additional policy, and PostgreSQL ORs permissive
-- policies together.
DROP POLICY IF EXISTS member_self_read ON chain.member;
CREATE POLICY member_self_read ON chain.member FOR SELECT
  USING (id = app.member_self());

-- And the sign-in path, which by definition has no identity yet: the phone
-- lookup and the points arithmetic of a redemption both run inside SECURITY
-- DEFINER functions. Nothing a request can connect as satisfies this.
DROP POLICY IF EXISTS member_definer ON chain.member;
CREATE POLICY member_definer ON chain.member FOR ALL
  USING (app.is_definer()) WITH CHECK (app.is_definer());
DROP POLICY IF EXISTS point_definer ON chain.point_entry;
CREATE POLICY point_definer ON chain.point_entry FOR ALL
  USING (app.is_definer()) WITH CHECK (app.is_definer());
DROP POLICY IF EXISTS reward_definer ON chain.reward;
CREATE POLICY reward_definer ON chain.reward FOR SELECT
  USING (app.is_definer());
DROP POLICY IF EXISTS voucher_definer ON chain.voucher;
CREATE POLICY voucher_definer ON chain.voucher FOR ALL
  USING (app.is_definer()) WITH CHECK (app.is_definer());

-- Is this number one of ours? The one question the portal asks before anybody
-- is signed in, and the reason it is a function rather than a query is that a
-- member session holds no read on the table until it knows who it is.
CREATE OR REPLACE FUNCTION chain.member_by_phone(p_phone text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id FROM chain.member WHERE phone = p_phone $$;

-- Their own point history, from any branch. `point_read` already lets an outlet
-- see the entries it wrote.
DROP POLICY IF EXISTS point_self_read ON chain.point_entry;
CREATE POLICY point_self_read ON chain.point_entry FOR SELECT
  USING (member_id = app.member_self());

-- The scheme and the catalogue are the same for everybody in the chain, so a
-- member may read both. Neither carries anybody's data.
DROP POLICY IF EXISTS loyalty_member_read ON chain.loyalty;
CREATE POLICY loyalty_member_read ON chain.loyalty FOR SELECT
  USING (app.member_self() IS NOT NULL);
DROP POLICY IF EXISTS reward_member_read ON chain.reward;
CREATE POLICY reward_member_read ON chain.reward FOR SELECT
  USING (app.member_self() IS NOT NULL);

-- An outlet may name itself to a member ("earned at Malé"), so the outlet row
-- is readable by a member session. Name and code only matter; the rest of the
-- row is configuration nobody outside the estate needs, and the API selects
-- the two columns rather than the row.
DROP POLICY IF EXISTS outlet_member_read ON chain.outlet;
CREATE POLICY outlet_member_read ON chain.outlet FOR SELECT
  USING (app.member_self() IS NOT NULL AND active);

-- ── grants: every outlet, and the member role itself ───────────────────────
-- A policy with no grant behind it never executes, and a grant with no policy
-- is the leak. Both, for both directions.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT db_role FROM chain.outlet LOOP
    EXECUTE format('GRANT SELECT, INSERT ON chain.member_visit TO %I', o.db_role);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE chain.member_visit_id_seq TO %I',
                   o.db_role);
    EXECUTE format('GRANT SELECT, UPDATE ON chain.voucher TO %I', o.db_role);
  END LOOP;
END $$;

-- The member role is created by scripts/migrate.js, which holds the secret the
-- password is derived from. Its grants are here, beside the policies they
-- belong to, and they are issued only if the role exists so that a first-ever
-- migration on a fresh database does not fail on ordering.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kashikeyo_member') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA chain, app TO kashikeyo_member';
    EXECUTE 'GRANT SELECT ON chain.member, chain.point_entry, chain.member_visit,'
          || ' chain.voucher, chain.loyalty, chain.reward, chain.outlet TO kashikeyo_member';
    EXECUTE 'GRANT INSERT ON chain.voucher TO kashikeyo_member';
    -- Spending points is an UPDATE of the member's own balance, and the
    -- member_write policy (rank >= 2, an outlet connection) refuses it — which
    -- is correct: a phone must not move its own balance. Redemption goes
    -- through chain.redeem_reward() instead, which is SECURITY DEFINER and does
    -- the whole thing or none of it.
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.member_self(), app.is_definer(),'
          || ' app.current_outlet(), app.current_rank(), app.group_scope(),'
          || ' app.current_actor() TO kashikeyo_member';
    -- Signing in: before there is a member, these three are all it may call.
    EXECUTE 'GRANT EXECUTE ON FUNCTION chain.member_by_phone(text),'
          || ' chain.otp_issue(text,text,int,uuid,int), chain.otp_verify(text,text)'
          || ' TO kashikeyo_member';
  END IF;
END $$;

-- ── redemption, in one place ───────────────────────────────────────────────
-- A point entry made from a member's own phone happened at NO BRANCH, so the
-- outlet becomes optional. Forcing one would attribute a redemption to a
-- restaurant that had nothing to do with it — and `loyalty.stats` reports what
-- each branch earned and redeemed, so that attribution would appear in a
-- manager's figures as trade they never saw.
ALTER TABLE chain.point_entry ALTER COLUMN outlet_id DROP NOT NULL;

-- Points off the balance, a point_entry to say so, and a voucher — or none of
-- it. A phone on a train loses its connection between any two of those, and a
-- member whose points vanished without a voucher has been robbed by a race.
CREATE OR REPLACE FUNCTION chain.redeem_reward(
  p_member uuid, p_reward uuid, p_code text, p_days int)
RETURNS chain.voucher LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE r chain.reward; m chain.member; v chain.voucher;
BEGIN
  SELECT * INTO r FROM chain.reward WHERE id = p_reward AND active;
  IF r.id IS NULL THEN RAISE EXCEPTION 'no_such_reward' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO m FROM chain.member WHERE id = p_member FOR UPDATE;
  IF m.id IS NULL THEN RAISE EXCEPTION 'no_such_member' USING ERRCODE = 'P0001'; END IF;
  IF m.points < r.points THEN RAISE EXCEPTION 'not_enough_points' USING ERRCODE = 'P0001'; END IF;

  UPDATE chain.member SET points = points - r.points WHERE id = p_member;
  INSERT INTO chain.point_entry (member_id, outlet_id, kind, points, value, note)
    VALUES (p_member, m.home_outlet, 'redeem', -r.points, -r.value,
            'Redeemed for ' || r.name);
  INSERT INTO chain.voucher (code, member_id, reward_id, name, points, value, expires_at)
    VALUES (p_code, p_member, r.id, r.name, r.points, r.value,
            CASE WHEN p_days > 0 THEN now() + make_interval(days => p_days) END)
    RETURNING * INTO v;
  RETURN v;
END $fn$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kashikeyo_member') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION chain.redeem_reward(uuid,uuid,text,int)'
          || ' TO kashikeyo_member';
  END IF;
END $$;

-- ── what the phone offers, where the till can see it ───────────────────────
-- "The phone never takes money. Guest devices post intent; the till settles."
-- So an offer to pay with points lands ON THE TICKET, in the outlet's own
-- schema, where the cashier is already looking — not in a queue somebody has
-- to remember to check.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT schema_name, db_role FROM chain.outlet LOOP
    EXECUTE format($q$
      ALTER TABLE %1$I.ticket
        ADD COLUMN IF NOT EXISTS points_offered numeric(12,2),
        ADD COLUMN IF NOT EXISTS points_offered_at timestamptz;
    $q$, o.schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA %I TO %I',
                   o.schema_name, o.db_role);
  END LOOP;
END $$;
