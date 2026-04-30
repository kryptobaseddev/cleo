-- T1609 — Introduce `session_handoff_entries` (write-once handoff table).
--
-- Operator rule: session.handoffJson is APPEND-ONLY (set once at session end,
-- never overwritten).  This migration makes that rule physically impossible to
-- violate at the SQL level by:
--
--   1. Creating `session_handoff_entries` with a UNIQUE constraint on
--      `session_id` — only one handoff row per session is allowed.
--   2. Adding a BEFORE UPDATE trigger that raises ABORT when any UPDATE on the
--      table is attempted — the row is immutable once inserted.
--   3. Adding an AFTER INSERT trigger that mirrors the new handoff value back
--      into `sessions.handoff_json` so that all existing read paths remain
--      unchanged (zero-change backward compatibility).
--   4. Backfilling existing `sessions.handoff_json` values into the new table
--      for sessions that already have handoff data.
--
-- Write path (post-migration):
--   - `persistHandoff()` in packages/core/src/sessions/handoff.ts INSERTs into
--     `session_handoff_entries`.  A duplicate session produces a UNIQUE
--     constraint violation (SQLITE_CONSTRAINT_UNIQUE), surfaced as
--     E_HANDOFF_ALREADY_PERSISTED to callers.
--
-- Read path (unchanged):
--   - `session.handoffJson` in converters/session-store continues to read from
--     `sessions.handoff_json`, which the AFTER INSERT trigger keeps in sync.
--
-- Sibling T1615 (session-end auto-creates BRAIN observation) is unaffected —
-- that code reads `session.handoffJson` from the sessions row, which the
-- trigger keeps populated.
--
-- @task T1609
-- @epic T1603

PRAGMA foreign_keys = OFF;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Step 1 — Create the write-once table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `session_handoff_entries` (
  `id`           INTEGER PRIMARY KEY AUTOINCREMENT,
  `session_id`   TEXT    NOT NULL UNIQUE REFERENCES `sessions`(`id`) ON DELETE CASCADE,
  `handoff_json` TEXT    NOT NULL,
  `created_at`   TEXT    NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_session_handoff_session_id`
  ON `session_handoff_entries` (`session_id`);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Step 2 — BEFORE UPDATE trigger: make rows physically immutable.
--
-- Any attempt to UPDATE a row in session_handoff_entries is aborted with a
-- descriptive error message that surfaces T1609 as the enforcement source.
-- ---------------------------------------------------------------------------
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
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Step 3 — AFTER INSERT trigger: mirror value into sessions.handoff_json.
--
-- This keeps the existing read path (converters.ts → session.handoffJson)
-- working without any code changes.
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS `trg_session_handoff_mirror`
AFTER INSERT ON `session_handoff_entries`
FOR EACH ROW
BEGIN
  UPDATE `sessions`
     SET `handoff_json` = NEW.handoff_json
   WHERE `id` = NEW.session_id;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Step 4 — Backfill existing handoff data.
--
-- For sessions that already have handoff_json set, insert one row into the
-- new table.  `INSERT OR IGNORE` is used so re-running the migration is safe.
-- The AFTER INSERT trigger will overwrite sessions.handoff_json with the same
-- value, which is a no-op.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO `session_handoff_entries` (`session_id`, `handoff_json`)
SELECT `id`, `handoff_json`
FROM   `sessions`
WHERE  `handoff_json` IS NOT NULL
  AND  `handoff_json` != '';
--> statement-breakpoint

PRAGMA foreign_keys = ON;
