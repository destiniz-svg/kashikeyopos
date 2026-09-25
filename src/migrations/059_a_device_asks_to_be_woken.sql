/* === 059 . A DEVICE ASKS TO BE WOKEN =======================================
   Web Push (RFC 8291/8292, src/push.js) needs somewhere to keep what a
   device handed the browser when it subscribed: the push service's own
   endpoint URL and the two per-subscription keys (p256dh, auth) that
   encrypt a message only that browser can open.

   OUTLET-SCOPED, LIKE A DOOR RECEIPT OR A PUNCH. A subscription is a fact
   about one device at one outlet — who it is (staff_id, for "wake the
   waiter who owns this ticket") and which browser (the endpoint, unique by
   construction: a push service issues one per registration and a re-
   subscribe on the same browser gets a NEW one, so ON CONFLICT upserts the
   keys rather than growing a duplicate row for the same phone).

   staff_id carries no FK to chain.staff — same as ticket.opened_by and
   every other cross-plane staff reference in this schema, because chain.*
   is a shared, RLS-scoped plane and the outlet schema does not reach across
   it with a constraint. "Till devices, rank >= 2" is answered by JOINING
   chain.staff at SEND time, never by caching a rank here — a promotion or a
   demotion takes effect on the next alert, not on the next re-subscribe.

   Follows migration 048's own retro-patch shape: loop every outlet\_%
   schema already provisioned, create the table there, and — the equally
   important other half — add the same table to chain.provision_outlet() in
   003, so a brand-new outlet is born with it rather than only acquiring it
   through this loop. */
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'outlet\_%' LOOP
    EXECUTE format($ddl$
      CREATE TABLE IF NOT EXISTS %1$I.push_subscription (
        endpoint   text PRIMARY KEY,
        staff_id   uuid,
        device_id  uuid,
        p256dh     text NOT NULL,
        auth       text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_ok_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS push_subscription_staff ON %1$I.push_subscription(staff_id);
    $ddl$, s);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %1$I.push_subscription TO %2$I',
      s, s || '_app');
  END LOOP;
END $$;
