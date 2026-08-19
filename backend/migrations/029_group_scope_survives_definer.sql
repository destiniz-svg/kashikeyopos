-- ═══════════════════════════════════════════════════════════════════════════
-- `app.group_scope()` asked the wrong question, and so the one cross-outlet
-- read in the system had never once succeeded.
--
-- It tested `current_user = 'kashikeyo_report'`. `chain.estate_day()` is
-- SECURITY DEFINER — that is the whole point of it, it is how an aggregate can
-- reach into every outlet's schema without any role being able to. But inside a
-- SECURITY DEFINER function `current_user` is the function's OWNER. So the
-- first thing estate_day did was ask "am I the reporting role?", be told
-- "no, you are postgres", and raise:
--
--     estate reporting requires rank 5 in group scope
--
-- for the reporting role itself, called correctly, at rank 5, in group scope.
-- `GET /api/estate/day` was a 500 for an owner and had been since the day it
-- was written.
--
-- WHY NOTHING CAUGHT IT. The leak test probes estate_day twice — without group
-- scope and with forged group scope — and both probes want a refusal. They got
-- one, from the wrong cause, and reported PASS. A suite that only ever asserts
-- "this is refused" cannot tell a working lock from a broken door: refusing
-- everybody looks exactly like refusing the right people. So the fix here comes
-- with the missing half of that test — a POSITIVE control that fails if the
-- legitimate caller is turned away — added to `backend/scripts/leak-test.js`.
--
-- THE FIX is `session_user`: the role that actually connected, which
-- SECURITY DEFINER does not change and `SET ROLE` cannot fake. It is strictly
-- narrower than what was intended, not wider — an outlet role can no more
-- become `kashikeyo_report` for a session than it could before, and a superuser
-- that did `SET ROLE kashikeyo_report` no longer gains group scope either.
--
-- The rank and the scope request are still checked, and still come from
-- transaction-local settings. All three conditions remain.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION app.group_scope() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT session_user = 'kashikeyo_report'
     AND coalesce(current_setting('app.scope', true) = 'group', false)
     AND app.current_rank() >= 5 $$;
