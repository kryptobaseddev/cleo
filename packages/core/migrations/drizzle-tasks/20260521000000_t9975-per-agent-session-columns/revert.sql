-- Revert T9975 — Remove per-agent session columns.
-- SQLite does not support DROP COLUMN on older versions; this revert
-- reconstructs the table without the four new columns.
-- WARNING: this destroys agent_handle, scope_kind, scope_id, last_activity data.
-- Only use this revert if you are absolutely certain the columns are unused.

-- SQLite does not support DROP INDEX / DROP COLUMN safely without recreating
-- the table. Since these are purely additive columns with no data constraints
-- beyond nullable, the practical approach is to leave them in place and simply
-- stop writing to them. This revert file is provided for documentation only;
-- production reverts should be handled via a forward migration that clears the
-- column data if needed.

SELECT 'T9975 revert: no-op — additive columns; data cleared on forward re-migration if needed';
