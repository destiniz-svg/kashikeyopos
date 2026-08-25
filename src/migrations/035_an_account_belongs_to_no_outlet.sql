-- ═══ AN ACCOUNT EVENT BELONGS TO NO OUTLET ══════════════════════════════════
-- `chain.audit.outlet_id` has been NOT NULL since 001, which is right for every
-- event the floor generates: a sale, a void, a PIN failure all happen AT an
-- outlet. The ACCOUNT plane does not. It sits above every outlet — that is the
-- whole of migration 011 — and the events that matter most there happen before
-- any outlet exists at all: somebody creating the account that will own the
-- business, on an install with nothing in it.
--
-- src/routes/account.js has always written those events with `outlet_id NULL`,
-- and the insert has always failed on this constraint. It is wrapped in a
-- `.catch(() => {})`, so it failed SILENTLY: not one account event has ever
-- reached the trail. Found by walking the signup on a fresh install and looking
-- for a code the screen said would be there.
--
-- NULL is the honest answer, and it costs nothing elsewhere:
--
--   · `audit_read` is `outlet_id = app.current_outlet() ... OR app.group_scope()`,
--     so a NULL row is invisible to an outlet role and readable at group scope,
--     which is exactly the account plane's own visibility;
--   · `audit_append` checks `outlet_id = app.current_outlet()`, so an outlet
--     role still cannot write one — these are written on the owner connection,
--     which bypasses RLS, and only from account.js;
--   · the `audit_outlet_at` index simply does not carry the NULL rows, and a
--     partial index gives the account plane its own.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE chain.audit ALTER COLUMN outlet_id DROP NOT NULL;

-- The account plane's own events, found without scanning the floor's.
CREATE INDEX IF NOT EXISTS audit_no_outlet ON chain.audit(at DESC)
  WHERE outlet_id IS NULL;
