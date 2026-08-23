-- ═══ HISTORY HAS A HORIZON, THE TRAIL DOES NOT ══════════════════════════════
-- Two per-outlet tables grow with every keystroke and nothing ever trimmed
-- them:
--
--   op_log         the replay-idempotency record. Its JOB is a window: it
--                  exists so an op that arrives twice applies once, and a
--                  device that has been dark longer than the window has
--                  bigger problems than a replay. Every consequence an op
--                  carried lives on in the rows it wrote — sales, journals,
--                  stock moves — which are never touched here.
--   guest_request  the floor board. A month-old "water please" is not a
--                  record, it is noise with a timestamp.
--
-- chain.audit is deliberately NOT here. It is the trail — who did what, when,
-- from which till — and trails are kept, not trimmed (MIRA's five-year
-- expectation applies to the records it explains). Archival of the audit
-- trail, if it is ever wanted, is an export, not a DELETE.
--
-- The function only deletes; what counts as "old" is the caller's to say, and
-- the server reads it from RETAIN_OP_LOG_DAYS / RETAIN_GUEST_REQUEST_DAYS
-- (defaults 90 and 30). Owner-only: no outlet role is granted EXECUTE, so a
-- compromised till cannot shred its own history early.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION chain.prune_history(p_op_days int, p_guest_days int)
RETURNS TABLE (outlet_id int, op_rows int, guest_rows int)
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE o record;
        n_op int; n_gr int;
BEGIN
  IF coalesce(p_op_days, 0) < 30 OR coalesce(p_guest_days, 0) < 7 THEN
    -- A window short enough to eat live replays is a config typo, not a policy.
    RAISE EXCEPTION 'retention refuses: op_log keeps at least 30 days, guest_request at least 7';
  END IF;
  FOR o IN SELECT id FROM chain.outlet LOOP
    EXECUTE format('DELETE FROM %1$I.op_log WHERE applied_at < now() - ($1 || '' days'')::interval',
      'outlet_' || o.id::text) USING p_op_days::text;
    GET DIAGNOSTICS n_op = ROW_COUNT;
    EXECUTE format('DELETE FROM %1$I.guest_request WHERE at < now() - ($1 || '' days'')::interval',
      'outlet_' || o.id::text) USING p_guest_days::text;
    GET DIAGNOSTICS n_gr = ROW_COUNT;
    IF n_op > 0 OR n_gr > 0 THEN
      INSERT INTO chain.audit (outlet_id, action, entity, after, scope)
      VALUES (o.id, 'history_pruned', 'retention',
        jsonb_build_object('op_log', n_op, 'guest_request', n_gr,
                           'op_days', p_op_days, 'guest_days', p_guest_days),
        'group');
    END IF;
    outlet_id := o.id; op_rows := n_op; guest_rows := n_gr;
    RETURN NEXT;
  END LOOP;
END $fn$;

REVOKE ALL ON FUNCTION chain.prune_history(int, int) FROM PUBLIC;
