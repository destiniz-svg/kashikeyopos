-- ═══ THE NAMES THE MAIL INFRASTRUCTURE USES ═════════════════════════════════
-- Stores live on `<handle>.kashikeyopos.com`, served by a WILDCARD — every name
-- under the base domain already answers, which is what makes a new store work
-- the moment its handle is taken. The cost of a wildcard is that a name is
-- never obviously "free": it answers whether or not anybody meant it to.
--
-- The mail transport wants some of those names for itself. SPF is published at
-- `send`, and click tracking, if it is ever turned on, wants a CNAME at
-- whatever the tracking subdomain is set to. Neither of those names was
-- reserved, so a store could have claimed `send` or `track`, printed the
-- handle onto forty table cards, and then had its portal broken the day
-- somebody added the DNS record the mail provider asked for. A dead QR is bad;
-- a QR that dies because of a change nobody connected to it is worse, because
-- nobody will look there.
--
-- This is the same fence 012 built for `www`, `mail` and `webmail`, extended to
-- the names an email provider reaches for. `noreply` is included because it is
-- the from-address half of the same story: it is a name a business expects to
-- be able to write to, not a shop.
--
-- Idempotent, like 012 and 027: ON CONFLICT DO NOTHING, so re-running it is a
-- no-op and adding a name later is one more row.
-- ═══════════════════════════════════════════════════════════════════════════

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

-- A store that somehow already holds one of these keeps trading — taking a
-- handle away from a business that has printed it is not a migration's call —
-- but it is named on the trail so somebody can have the conversation.
DO $mig$
DECLARE o record;
BEGIN
  FOR o IN SELECT id, slug FROM chain.outlet
            WHERE slug IN (SELECT name FROM chain.reserved_handle) LOOP
    INSERT INTO chain.audit (outlet_id, action, entity, entity_id, after, scope)
    VALUES (o.id, 'handle_now_reserved', 'outlet', o.id::text,
            jsonb_build_object('slug', o.slug,
              'note', 'this handle is now reserved for mail infrastructure;'
                   || ' the store keeps it until somebody decides otherwise'),
            'group');
  END LOOP;
END $mig$;
