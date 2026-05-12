-- T9223 — Add tasks.verifier_path TEXT NULL column.
--
-- Purpose:
--   Single source of truth for which verifier measures which task.
--   The column stores the absolute or project-relative path to the verifier
--   script for the task (e.g., `.cleo/verifiers/T9223.mjs`).
--
--   When non-null, `cleo verify --acceptance-check` resolves the verifier from
--   this registry column first and falls back to the filesystem convention
--   (.cleo/verifiers/<TID>.mjs, then scripts/verify-<tid>.mjs) when NULL.
--
-- SQLite supports ALTER TABLE ADD COLUMN for nullable columns with no DEFAULT
-- (or a constant DEFAULT). This is a non-destructive, backwards-compatible
-- migration — no table rebuild required.
--
-- @task T9223
-- @adr ADR-070

ALTER TABLE `tasks` ADD COLUMN `verifier_path` text;
