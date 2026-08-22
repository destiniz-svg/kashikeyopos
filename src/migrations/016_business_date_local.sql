-- ═══ THE BUSINESS DATE IS THE OUTLET'S LOCAL DATE ══════════════════════════
-- `current_date` is whatever timezone the SESSION is in, and a container is in
-- UTC. Malé is UTC+5, so from 19:00 local — most of a restaurant's trading —
-- every business date, document number and settlement key was being filed
-- under YESTERDAY while the clock in the header said tonight. A GST return
-- keyed on that is wrong for roughly a third of every day's takings.
--
-- The outlet has always carried its own zone (`chain.outlet.tz`) and nothing
-- read it. `setContext()` now sets it on every transaction, so `current_date`
-- inside a request is the outlet's own date from here on.
--
-- This migration repairs what was already written. Every row is rewritten from
-- ITS OWN timestamp in ITS OWN outlet's zone — never from "now", which would
-- stamp a week of history with today. Rows already correct are left alone, so
-- it is idempotent and re-running it is free.
-- ═══════════════════════════════════════════════════════════════════════════

DO $mig$
DECLARE
  o record;
  t text;
  ts text;
  n bigint;
  total bigint := 0;
BEGIN
  FOR o IN SELECT schema_name, coalesce(tz, 'Indian/Maldives') AS tz
             FROM chain.outlet WHERE schema_name IS NOT NULL LOOP
    -- table name paired with the timestamp its business date is derived from.
    FOREACH t IN ARRAY ARRAY['ticket','sale','credit_note','stock_move',
                             'delivery','clock_entry','document'] LOOP
      ts := CASE t WHEN 'ticket' THEN 'opened_at'
                   WHEN 'clock_entry' THEN 'in_at'
                   ELSE 'at' END;
      -- An outlet provisioned before a table existed simply has no rows to fix.
      IF to_regclass(format('%I.%I', o.schema_name, t)) IS NULL THEN
        CONTINUE;
      END IF;
      EXECUTE format(
        'UPDATE %I.%I SET business_date = (%I AT TIME ZONE %L)::date'
        || ' WHERE business_date IS DISTINCT FROM (%I AT TIME ZONE %L)::date',
        o.schema_name, t, ts, o.tz, ts, o.tz);
      GET DIAGNOSTICS n = ROW_COUNT;
      total := total + n;
      IF n > 0 THEN
        RAISE NOTICE '[bizdate] %.% — % row(s) refiled onto %',
          o.schema_name, t, n, o.tz;
      END IF;
    END LOOP;
  END LOOP;
  IF total = 0 THEN
    RAISE NOTICE '[bizdate] nothing to refile — every business date already local';
  END IF;
END $mig$;
