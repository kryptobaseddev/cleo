-- No-op: the reason column addition is handled by the subsequent table rebuild
-- migration (20260301180528_update-task-relations-check-constraint) which
-- recreates task_relations with all columns including reason.
-- This migration exists to maintain the drizzle snapshot chain integrity.
SELECT 1;
