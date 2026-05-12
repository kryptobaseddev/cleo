-- Revert T9223 — Remove tasks.verifier_path column.
--
-- SQLite does not support DROP COLUMN in older versions. Use table rebuild
-- pattern to remove the column if needed.
--
-- @task T9223

-- This revert is intentionally left as a no-op because SQLite < 3.35.0
-- does not support ALTER TABLE DROP COLUMN. If a revert is needed, perform
-- the full table-rebuild pattern manually.
SELECT 1; -- no-op placeholder
