-- Revert T1899: remove origin index (column is preserved but index is dropped).
-- Cannot un-backfill data without knowing original state.
DROP INDEX IF EXISTS `idx_tasks_origin`;
