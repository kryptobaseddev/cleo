-- Revert T9228 — Remove tasks.lifetime column.
-- SQLite < 3.35.0 does not support DROP COLUMN; use table rebuild if needed.
SELECT 1; -- no-op placeholder
