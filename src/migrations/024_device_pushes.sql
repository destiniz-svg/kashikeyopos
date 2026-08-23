-- ═══ THE OUTLET CAN SEE WHICH TILL HAS GONE QUIET ═══════════════════════════
-- `last_seen` moves at sign-in, which answers "when was somebody standing at
-- it" — a different question from "when did it last DELIVER its writes". A
-- till can be signed in all evening, look alive on every screen, and be
-- sitting on four hours of unreplayed sales behind a dead link or a poison
-- outbox. The device that is holding the only copy of the evening's takings
-- is exactly the one nobody can ask, because asking it requires the link that
-- is down.
--
-- So the PUSH stamps the row: every batch a device successfully delivers —
-- even one where every op was a replay — sets last_push_at. The outlet's own
-- database can then answer "which of my tills has not delivered in an hour"
-- from any other screen, which is the moment to walk over with a cable rather
-- than discover it at the drawer count.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE chain.device ADD COLUMN IF NOT EXISTS last_push_at timestamptz;
