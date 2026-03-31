DROP INDEX IF EXISTS idx_agents_last_used;
DROP INDEX IF EXISTS idx_agents_is_active;
-- SQLite does not support DROP COLUMN; columns remain but are unused.
