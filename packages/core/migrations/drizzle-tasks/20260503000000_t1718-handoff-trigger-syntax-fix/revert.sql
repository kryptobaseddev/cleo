-- T1718 revert — restore the original (broken) T1609 trigger syntax.
DROP TRIGGER IF EXISTS `trg_session_handoff_no_update`;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `trg_session_handoff_no_update`
BEFORE UPDATE ON `session_handoff_entries`
FOR EACH ROW
BEGIN
  SELECT RAISE(
    ABORT,
    'T1609_HANDOFF_IMMUTABLE: session_handoff_entries rows are write-once. '
    || 'Use persistHandoff() exactly once per session (session_id='
    || OLD.session_id || ').'
  );
END;
