-- ===========================================================================
-- T1718 — Fix trg_session_handoff_no_update trigger syntax
-- ===========================================================================
-- Original trigger (T1609 migration 20260429000000) used `||` string
-- concatenation in `SELECT RAISE(ABORT, msg)`. SQLite's RAISE expects a
-- STRING LITERAL in the second argument — concatenation expressions
-- cause `malformed database schema` errors when ANY tool other than the
-- creating connection (e.g. the `sqlite3` CLI) opens the database.
--
-- This broke sandbox `living-brain-e2e` and `harness-e2e` assertions
-- which use `sqlite3 ... 'SELECT COUNT(*)'` to verify task counts.
--
-- Fix: drop the broken trigger, recreate with a static error message
-- (no dynamic session_id interpolation in the abort message).
-- ===========================================================================

DROP TRIGGER IF EXISTS `trg_session_handoff_no_update`;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `trg_session_handoff_no_update`
BEFORE UPDATE ON `session_handoff_entries`
FOR EACH ROW
BEGIN
  SELECT RAISE(
    ABORT,
    'T1609_HANDOFF_IMMUTABLE: session_handoff_entries rows are write-once. Use persistHandoff() exactly once per session.'
  );
END;
