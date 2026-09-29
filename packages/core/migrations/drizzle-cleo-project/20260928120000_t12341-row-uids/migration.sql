-- T12341 (epic T12323) — row uids: the merge key of every syncing row.
--
-- Adds a nullable `uid` column (and a unique index on it) to the task-graph
-- tables whose live table is settled (no pending twin collapse), plus the
-- stored AC-uid references `ac_uid` on evidence bindings and AC history, and
-- the display-id alias table. Spec: `cleo docs fetch t12341-uid-scheme`.
--
-- The column is filled by TypeScript, not here: SQLite has no hash function,
-- and existing rows need a DETERMINISTIC uid so two devices that share a
-- history derive the same one (store/row-identity.ts, run at every open inside
-- the cold-open lease, right after the migrations). Nothing in this file
-- rebuilds a table, so the T12541 rebuild probe does not apply; if the journal
-- probe ever stamps this migration after adding only its columns (Scenario 3,
-- Case B), the open pass re-creates the indexes.
--
-- There is deliberately no persistent trigger: one that called the uid
-- function would fail every insert an older build makes (it lacks the
-- function), and one that minted a random uid would make those rows
-- non-deterministic. Rows an older build inserts keep a NULL uid until the next
-- open by this build fills them.
--
-- `tasks_display_id_aliases` follows the ADR-094 alias pattern: a displaced
-- display id keeps resolving to the row that carried it, and an id claimed by
-- more than one row is ambiguous and never resolves. Runtime infrastructure
-- written by store/display-id-alias.ts, not part of the exodus target shape.
--
-- @task T12341
-- @epic T12323

ALTER TABLE `tasks_tasks` ADD COLUMN `uid` TEXT;
--> statement-breakpoint
ALTER TABLE `tasks_task_acceptance_criteria` ADD COLUMN `uid` TEXT;
--> statement-breakpoint
ALTER TABLE `tasks_task_acceptance_criteria_history` ADD COLUMN `uid` TEXT;
--> statement-breakpoint
ALTER TABLE `tasks_task_acceptance_criteria_history` ADD COLUMN `ac_uid` TEXT;
--> statement-breakpoint
ALTER TABLE `tasks_evidence_ac_bindings` ADD COLUMN `uid` TEXT;
--> statement-breakpoint
ALTER TABLE `tasks_evidence_ac_bindings` ADD COLUMN `ac_uid` TEXT;
--> statement-breakpoint
ALTER TABLE `tasks_sessions` ADD COLUMN `uid` TEXT;
--> statement-breakpoint
ALTER TABLE `tasks_task_dependencies` ADD COLUMN `uid` TEXT;
--> statement-breakpoint
ALTER TABLE `tasks_task_relations` ADD COLUMN `uid` TEXT;
--> statement-breakpoint
ALTER TABLE `tasks_task_labels` ADD COLUMN `uid` TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_tasks_uid` ON `tasks_tasks` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_task_acceptance_criteria_uid` ON `tasks_task_acceptance_criteria` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_task_acceptance_criteria_history_uid` ON `tasks_task_acceptance_criteria_history` (`uid`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_task_acceptance_criteria_history_ac_uid` ON `tasks_task_acceptance_criteria_history` (`ac_uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_evidence_ac_bindings_uid` ON `tasks_evidence_ac_bindings` (`uid`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_evidence_ac_bindings_ac_uid` ON `tasks_evidence_ac_bindings` (`ac_uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_sessions_uid` ON `tasks_sessions` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_task_dependencies_uid` ON `tasks_task_dependencies` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_task_relations_uid` ON `tasks_task_relations` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_task_labels_uid` ON `tasks_task_labels` (`uid`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tasks_display_id_aliases` (
  `uid` TEXT PRIMARY KEY NOT NULL,
  `entity_table` TEXT NOT NULL,
  `display_id` TEXT NOT NULL,
  `entity_uid` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `origin` TEXT,
  `created_at` TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_display_id_aliases_lookup` ON `tasks_display_id_aliases` (`entity_table`, `display_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_display_id_aliases_entity` ON `tasks_display_id_aliases` (`entity_uid`);
