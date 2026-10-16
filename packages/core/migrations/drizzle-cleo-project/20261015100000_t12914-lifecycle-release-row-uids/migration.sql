-- T12914 (epic T12323) — row uids for the lifecycle, release, PR and commit
-- tables (project store).
--
-- Adds a nullable `uid` column and a unique index on it to each of the 16
-- tables (the two minted ones, `tasks_lifecycle_evidence` and
-- `tasks_lifecycle_transitions`, also get `birth_fp`). Without a uid none of
-- them had capture triggers, so a release, a lifecycle stage or a commit
-- recorded on one device never reached another, and the typed release merge
-- rule (release.status.absorbing, T12943) never fired across devices (Stage C
-- gate, T13549). Spec: `cleo docs fetch t12341-uid-scheme`.
--
-- The columns are filled by TypeScript at open (store/row-identity.ts, inside
-- the cold-open lease), and rows inserted by this build get theirs from the
-- per-connection TEMP trigger. Nothing here rebuilds a table or touches a row
-- (only ADD COLUMN and CREATE INDEX), so the T12541 rebuild probe and the
-- gate 36 DML rules do not apply; a probe-stamped store gets its columns and
-- indexes from the open's heal.
--
-- @task T12914
-- @epic T12323

ALTER TABLE `tasks_lifecycle_pipelines` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `tasks_lifecycle_stages` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `tasks_lifecycle_gate_results` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `tasks_lifecycle_evidence` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `tasks_lifecycle_evidence` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
ALTER TABLE `tasks_lifecycle_transitions` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `tasks_lifecycle_transitions` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
ALTER TABLE `tasks_releases` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `tasks_release_commits` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `tasks_release_changes` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `tasks_release_changesets` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `tasks_release_artifacts` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `tasks_pull_requests` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `tasks_pr_commits` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `tasks_pr_tasks` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `tasks_commits` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `tasks_commit_files` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `tasks_task_commits` ADD COLUMN `uid` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_lifecycle_pipelines_uid` ON `tasks_lifecycle_pipelines` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_lifecycle_stages_uid` ON `tasks_lifecycle_stages` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_lifecycle_gate_results_uid` ON `tasks_lifecycle_gate_results` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_lifecycle_evidence_uid` ON `tasks_lifecycle_evidence` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_lifecycle_transitions_uid` ON `tasks_lifecycle_transitions` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_releases_uid` ON `tasks_releases` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_release_commits_uid` ON `tasks_release_commits` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_release_changes_uid` ON `tasks_release_changes` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_release_changesets_uid` ON `tasks_release_changesets` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_release_artifacts_uid` ON `tasks_release_artifacts` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_pull_requests_uid` ON `tasks_pull_requests` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_pr_commits_uid` ON `tasks_pr_commits` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_pr_tasks_uid` ON `tasks_pr_tasks` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_commits_uid` ON `tasks_commits` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_commit_files_uid` ON `tasks_commit_files` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_task_commits_uid` ON `tasks_task_commits` (`uid`);
