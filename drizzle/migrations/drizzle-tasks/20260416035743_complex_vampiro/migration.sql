CREATE TABLE `agent_error_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`agent_id` text NOT NULL,
	`error_type` text NOT NULL,
	`message` text NOT NULL,
	`stack` text,
	`occurred_at` text DEFAULT (datetime('now')) NOT NULL,
	`resolved` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_instances` (
	`id` text PRIMARY KEY,
	`agent_type` text NOT NULL,
	`status` text DEFAULT 'starting' NOT NULL,
	`session_id` text,
	`task_id` text,
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_heartbeat` text DEFAULT (datetime('now')) NOT NULL,
	`stopped_at` text,
	`error_count` integer DEFAULT 0 NOT NULL,
	`total_tasks_completed` integer DEFAULT 0 NOT NULL,
	`capacity` text DEFAULT '1.0' NOT NULL,
	`metadata_json` text DEFAULT '{}',
	`parent_agent_id` text
);
--> statement-breakpoint
CREATE TABLE `background_jobs` (
	`id` text PRIMARY KEY,
	`operation` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`result` text,
	`error` text,
	`progress` integer,
	`heartbeat_at` integer NOT NULL,
	`claimed_by` text
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `pipeline_stage` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `assignee` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_adr_task_links` (
	`adr_id` text NOT NULL,
	`task_id` text NOT NULL,
	`link_type` text DEFAULT 'related' NOT NULL,
	CONSTRAINT `adr_task_links_pk` PRIMARY KEY(`adr_id`, `task_id`),
	CONSTRAINT `fk_adr_task_links_adr_id_architecture_decisions_id_fk` FOREIGN KEY (`adr_id`) REFERENCES `architecture_decisions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_adr_task_links_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_adr_task_links`(`adr_id`, `task_id`, `link_type`) SELECT `adr_id`, `task_id`, `link_type` FROM `adr_task_links`;--> statement-breakpoint
DROP TABLE `adr_task_links`;--> statement-breakpoint
ALTER TABLE `__new_adr_task_links` RENAME TO `adr_task_links`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_architecture_decisions` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`supersedes_id` text,
	`superseded_by_id` text,
	`consensus_manifest_id` text,
	`content` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text,
	`date` text DEFAULT '' NOT NULL,
	`accepted_at` text,
	`gate` text,
	`gate_status` text,
	`amends_id` text,
	`file_path` text DEFAULT '' NOT NULL,
	`summary` text,
	`keywords` text,
	`topics` text,
	CONSTRAINT `fk_architecture_decisions_supersedes_id_architecture_decisions_id_fk` FOREIGN KEY (`supersedes_id`) REFERENCES `architecture_decisions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_architecture_decisions_superseded_by_id_architecture_decisions_id_fk` FOREIGN KEY (`superseded_by_id`) REFERENCES `architecture_decisions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_architecture_decisions_consensus_manifest_id_manifest_entries_id_fk` FOREIGN KEY (`consensus_manifest_id`) REFERENCES `manifest_entries`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_architecture_decisions_amends_id_architecture_decisions_id_fk` FOREIGN KEY (`amends_id`) REFERENCES `architecture_decisions`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `__new_architecture_decisions`(`id`, `title`, `status`, `supersedes_id`, `superseded_by_id`, `consensus_manifest_id`, `content`, `created_at`, `updated_at`, `date`, `accepted_at`, `gate`, `gate_status`, `amends_id`, `file_path`, `summary`, `keywords`, `topics`) SELECT `id`, `title`, `status`, `supersedes_id`, `superseded_by_id`, `consensus_manifest_id`, `content`, `created_at`, `updated_at`, `date`, `accepted_at`, `gate`, `gate_status`, `amends_id`, `file_path`, `summary`, `keywords`, `topics` FROM `architecture_decisions`;--> statement-breakpoint
DROP TABLE `architecture_decisions`;--> statement-breakpoint
ALTER TABLE `__new_architecture_decisions` RENAME TO `architecture_decisions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lifecycle_transitions` (
	`id` text PRIMARY KEY,
	`pipeline_id` text NOT NULL,
	`from_stage_id` text NOT NULL,
	`to_stage_id` text NOT NULL,
	`transition_type` text DEFAULT 'automatic' NOT NULL,
	`transitioned_by` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_lifecycle_transitions_pipeline_id_lifecycle_pipelines_id_fk` FOREIGN KEY (`pipeline_id`) REFERENCES `lifecycle_pipelines`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_lifecycle_transitions_from_stage_id_lifecycle_stages_id_fk` FOREIGN KEY (`from_stage_id`) REFERENCES `lifecycle_stages`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_lifecycle_transitions_to_stage_id_lifecycle_stages_id_fk` FOREIGN KEY (`to_stage_id`) REFERENCES `lifecycle_stages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_lifecycle_transitions`(`id`, `pipeline_id`, `from_stage_id`, `to_stage_id`, `transition_type`, `transitioned_by`, `created_at`) SELECT `id`, `pipeline_id`, `from_stage_id`, `to_stage_id`, `transition_type`, `transitioned_by`, `created_at` FROM `lifecycle_transitions`;--> statement-breakpoint
DROP TABLE `lifecycle_transitions`;--> statement-breakpoint
ALTER TABLE `__new_lifecycle_transitions` RENAME TO `lifecycle_transitions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pipeline_manifest` (
	`id` text PRIMARY KEY,
	`session_id` text,
	`task_id` text,
	`epic_id` text,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`content_hash` text,
	`status` text DEFAULT 'active' NOT NULL,
	`distilled` integer DEFAULT false NOT NULL,
	`brain_obs_id` text,
	`source_file` text,
	`metadata_json` text,
	`created_at` text NOT NULL,
	`archived_at` text,
	CONSTRAINT `fk_pipeline_manifest_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_pipeline_manifest_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_pipeline_manifest_epic_id_tasks_id_fk` FOREIGN KEY (`epic_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `__new_pipeline_manifest`(`id`, `session_id`, `task_id`, `epic_id`, `type`, `content`, `content_hash`, `status`, `distilled`, `brain_obs_id`, `source_file`, `metadata_json`, `created_at`, `archived_at`) SELECT `id`, `session_id`, `task_id`, `epic_id`, `type`, `content`, `content_hash`, `status`, `distilled`, `brain_obs_id`, `source_file`, `metadata_json`, `created_at`, `archived_at` FROM `pipeline_manifest`;--> statement-breakpoint
DROP TABLE `pipeline_manifest`;--> statement-breakpoint
ALTER TABLE `__new_pipeline_manifest` RENAME TO `pipeline_manifest`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_release_manifests` (
	`id` text PRIMARY KEY,
	`version` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`pipeline_id` text,
	`epic_id` text,
	`tasks_json` text DEFAULT '[]' NOT NULL,
	`changelog` text,
	`notes` text,
	`previous_version` text,
	`commit_sha` text,
	`git_tag` text,
	`npm_dist_tag` text,
	`created_at` text NOT NULL,
	`prepared_at` text,
	`committed_at` text,
	`tagged_at` text,
	`pushed_at` text,
	CONSTRAINT `fk_release_manifests_pipeline_id_lifecycle_pipelines_id_fk` FOREIGN KEY (`pipeline_id`) REFERENCES `lifecycle_pipelines`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_release_manifests_epic_id_tasks_id_fk` FOREIGN KEY (`epic_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `__new_release_manifests`(`id`, `version`, `status`, `pipeline_id`, `epic_id`, `tasks_json`, `changelog`, `notes`, `previous_version`, `commit_sha`, `git_tag`, `npm_dist_tag`, `created_at`, `prepared_at`, `committed_at`, `tagged_at`, `pushed_at`) SELECT `id`, `version`, `status`, `pipeline_id`, `epic_id`, `tasks_json`, `changelog`, `notes`, `previous_version`, `commit_sha`, `git_tag`, `npm_dist_tag`, `created_at`, `prepared_at`, `committed_at`, `tagged_at`, `pushed_at` FROM `release_manifests`;--> statement-breakpoint
DROP TABLE `release_manifests`;--> statement-breakpoint
ALTER TABLE `__new_release_manifests` RENAME TO `release_manifests`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`scope_json` text DEFAULT '{}' NOT NULL,
	`current_task` text,
	`task_started_at` text,
	`agent` text,
	`notes_json` text DEFAULT '[]',
	`tasks_completed_json` text DEFAULT '[]',
	`tasks_created_json` text DEFAULT '[]',
	`handoff_json` text,
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	`ended_at` text,
	`previous_session_id` text,
	`next_session_id` text,
	`agent_identifier` text,
	`handoff_consumed_at` text,
	`handoff_consumed_by` text,
	`debrief_json` text,
	`provider_id` text,
	`stats_json` text,
	`resume_count` integer,
	`grade_mode` integer,
	CONSTRAINT `fk_sessions_current_task_tasks_id_fk` FOREIGN KEY (`current_task`) REFERENCES `tasks`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_sessions_previous_session_id_sessions_id_fk` FOREIGN KEY (`previous_session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_sessions_next_session_id_sessions_id_fk` FOREIGN KEY (`next_session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `__new_sessions`(`id`, `name`, `status`, `scope_json`, `current_task`, `task_started_at`, `agent`, `notes_json`, `tasks_completed_json`, `tasks_created_json`, `handoff_json`, `started_at`, `ended_at`, `previous_session_id`, `next_session_id`, `agent_identifier`, `handoff_consumed_at`, `handoff_consumed_by`, `debrief_json`, `provider_id`, `stats_json`, `resume_count`, `grade_mode`) SELECT `id`, `name`, `status`, `scope_json`, `current_task`, `task_started_at`, `agent`, `notes_json`, `tasks_completed_json`, `tasks_created_json`, `handoff_json`, `started_at`, `ended_at`, `previous_session_id`, `next_session_id`, `agent_identifier`, `handoff_consumed_at`, `handoff_consumed_by`, `debrief_json`, `provider_id`, `stats_json`, `resume_count`, `grade_mode` FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_task_work_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`session_id` text NOT NULL,
	`task_id` text NOT NULL,
	`set_at` text DEFAULT (datetime('now')) NOT NULL,
	`cleared_at` text,
	CONSTRAINT `fk_task_work_history_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_task_work_history_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_task_work_history`(`id`, `session_id`, `task_id`, `set_at`, `cleared_at`) SELECT `id`, `session_id`, `task_id`, `set_at`, `cleared_at` FROM `task_work_history`;--> statement-breakpoint
DROP TABLE `task_work_history`;--> statement-breakpoint
ALTER TABLE `__new_task_work_history` RENAME TO `task_work_history`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`type` text,
	`parent_id` text,
	`phase` text,
	`size` text,
	`position` integer,
	`position_version` integer DEFAULT 0,
	`labels_json` text DEFAULT '[]',
	`notes_json` text DEFAULT '[]',
	`acceptance_json` text DEFAULT '[]',
	`files_json` text DEFAULT '[]',
	`origin` text,
	`blocked_by` text,
	`epic_lifecycle` text,
	`no_auto_complete` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text,
	`completed_at` text,
	`cancelled_at` text,
	`cancellation_reason` text,
	`archived_at` text,
	`archive_reason` text,
	`cycle_time_days` integer,
	`verification_json` text,
	`created_by` text,
	`modified_by` text,
	`session_id` text,
	`pipeline_stage` text,
	`assignee` text,
	CONSTRAINT `fk_tasks_parent_id_tasks_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_tasks_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `__new_tasks`(`id`, `title`, `description`, `status`, `priority`, `type`, `parent_id`, `phase`, `size`, `position`, `position_version`, `labels_json`, `notes_json`, `acceptance_json`, `files_json`, `origin`, `blocked_by`, `epic_lifecycle`, `no_auto_complete`, `created_at`, `updated_at`, `completed_at`, `cancelled_at`, `cancellation_reason`, `archived_at`, `archive_reason`, `cycle_time_days`, `verification_json`, `created_by`, `modified_by`, `session_id`) SELECT `id`, `title`, `description`, `status`, `priority`, `type`, `parent_id`, `phase`, `size`, `position`, `position_version`, `labels_json`, `notes_json`, `acceptance_json`, `files_json`, `origin`, `blocked_by`, `epic_lifecycle`, `no_auto_complete`, `created_at`, `updated_at`, `completed_at`, `cancelled_at`, `cancellation_reason`, `archived_at`, `archive_reason`, `cycle_time_days`, `verification_json`, `created_by`, `modified_by`, `session_id` FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_token_usage` (
	`id` text PRIMARY KEY,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`provider` text DEFAULT 'unknown' NOT NULL,
	`model` text,
	`transport` text DEFAULT 'unknown' NOT NULL,
	`gateway` text,
	`domain` text,
	`operation` text,
	`session_id` text,
	`task_id` text,
	`request_id` text,
	`input_chars` integer DEFAULT 0 NOT NULL,
	`output_chars` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`method` text DEFAULT 'heuristic' NOT NULL,
	`confidence` text DEFAULT 'coarse' NOT NULL,
	`request_hash` text,
	`response_hash` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	CONSTRAINT `fk_token_usage_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_token_usage_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `__new_token_usage`(`id`, `created_at`, `provider`, `model`, `transport`, `gateway`, `domain`, `operation`, `session_id`, `task_id`, `request_id`, `input_chars`, `output_chars`, `input_tokens`, `output_tokens`, `total_tokens`, `method`, `confidence`, `request_hash`, `response_hash`, `metadata_json`) SELECT `id`, `created_at`, `provider`, `model`, `transport`, `gateway`, `domain`, `operation`, `session_id`, `task_id`, `request_id`, `input_chars`, `output_chars`, `input_tokens`, `output_tokens`, `total_tokens`, `method`, `confidence`, `request_hash`, `response_hash`, `metadata_json` FROM `token_usage`;--> statement-breakpoint
DROP TABLE `token_usage`;--> statement-breakpoint
ALTER TABLE `__new_token_usage` RENAME TO `token_usage`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_adr_task_links_task_id` ON `adr_task_links` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_arch_decisions_status` ON `architecture_decisions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_arch_decisions_amends_id` ON `architecture_decisions` (`amends_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_transitions_pipeline_id` ON `lifecycle_transitions` (`pipeline_id`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_manifest_task_id` ON `pipeline_manifest` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_manifest_session_id` ON `pipeline_manifest` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_manifest_distilled` ON `pipeline_manifest` (`distilled`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_manifest_status` ON `pipeline_manifest` (`status`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_manifest_content_hash` ON `pipeline_manifest` (`content_hash`);--> statement-breakpoint
CREATE INDEX `idx_release_manifests_status` ON `release_manifests` (`status`);--> statement-breakpoint
CREATE INDEX `idx_release_manifests_version` ON `release_manifests` (`version`);--> statement-breakpoint
CREATE INDEX `idx_sessions_status` ON `sessions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_sessions_previous` ON `sessions` (`previous_session_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_agent_identifier` ON `sessions` (`agent_identifier`);--> statement-breakpoint
CREATE INDEX `idx_sessions_started_at` ON `sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_status_started_at` ON `sessions` (`status`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_work_history_session` ON `task_work_history` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_parent_id` ON `tasks` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_phase` ON `tasks` (`phase`);--> statement-breakpoint
CREATE INDEX `idx_tasks_type` ON `tasks` (`type`);--> statement-breakpoint
CREATE INDEX `idx_tasks_priority` ON `tasks` (`priority`);--> statement-breakpoint
CREATE INDEX `idx_tasks_session_id` ON `tasks` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_pipeline_stage` ON `tasks` (`pipeline_stage`);--> statement-breakpoint
CREATE INDEX `idx_tasks_assignee` ON `tasks` (`assignee`);--> statement-breakpoint
CREATE INDEX `idx_tasks_parent_status` ON `tasks` (`parent_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status_priority` ON `tasks` (`status`,`priority`);--> statement-breakpoint
CREATE INDEX `idx_tasks_type_phase` ON `tasks` (`type`,`phase`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status_archive_reason` ON `tasks` (`status`,`archive_reason`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_created_at` ON `token_usage` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_request_id` ON `token_usage` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_session_id` ON `token_usage` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_task_id` ON `token_usage` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_provider` ON `token_usage` (`provider`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_transport` ON `token_usage` (`transport`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_domain_operation` ON `token_usage` (`domain`,`operation`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_method` ON `token_usage` (`method`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_gateway` ON `token_usage` (`gateway`);--> statement-breakpoint
CREATE INDEX `idx_agent_error_log_agent_id` ON `agent_error_log` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_error_log_error_type` ON `agent_error_log` (`error_type`);--> statement-breakpoint
CREATE INDEX `idx_agent_error_log_occurred_at` ON `agent_error_log` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_instances_status` ON `agent_instances` (`status`);--> statement-breakpoint
CREATE INDEX `idx_agent_instances_agent_type` ON `agent_instances` (`agent_type`);--> statement-breakpoint
CREATE INDEX `idx_agent_instances_session_id` ON `agent_instances` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_instances_task_id` ON `agent_instances` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_instances_parent_agent_id` ON `agent_instances` (`parent_agent_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_instances_last_heartbeat` ON `agent_instances` (`last_heartbeat`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_session_timestamp` ON `audit_log` (`session_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_domain_operation` ON `audit_log` (`domain`,`operation`);--> statement-breakpoint
CREATE INDEX `idx_background_jobs_status` ON `background_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_background_jobs_operation` ON `background_jobs` (`operation`);--> statement-breakpoint
CREATE INDEX `idx_background_jobs_claimed_by` ON `background_jobs` (`claimed_by`);--> statement-breakpoint
CREATE INDEX `idx_background_jobs_started_at` ON `background_jobs` (`started_at`);