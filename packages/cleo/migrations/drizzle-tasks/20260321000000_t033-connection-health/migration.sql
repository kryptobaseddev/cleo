-- T033: Connection Health Remediation
-- Part 1: Foreign key enforcement is enabled at the application layer via
--         openNativeDatabase() enableForeignKeyConstraints + PRAGMA foreign_keys=ON.
--         No SQL change needed here.
--
-- Part 2: Add 7 missing composite indexes for tasks.db (from T031 analysis).
--         NOTE: Indexes on tasks and sessions are placed AFTER their respective
--         table rebuilds so they are not lost when old tables are dropped.
--         audit_log indexes are safe here since that table is not rebuilt.
-- Part 3: Add hard FK constraints to intra-DB soft FK columns (from T030 audit).
-- Part 5: Add tasks.pipeline_stage column with FK to lifecycle_stages (T056 contract).

-- ============================================================================
-- INDEXES: audit_log (table not rebuilt — safe to create now)
-- ============================================================================

-- INDEX 6: audit_log session_id + timestamp (session grading — composite replaces single-col)
CREATE INDEX IF NOT EXISTS `idx_audit_log_session_timestamp`
  ON `audit_log` (`session_id`, `timestamp`);
--> statement-breakpoint

-- INDEX 7: audit_log domain + operation (dispatch-layer audit queries)
CREATE INDEX IF NOT EXISTS `idx_audit_log_domain_operation`
  ON `audit_log` (`domain`, `operation`);
--> statement-breakpoint

-- ============================================================================
-- PART 3: Intra-DB FK Hardening (table rebuilds required for SQLite)
-- ============================================================================

-- SFK-022: task_work_history.task_id → tasks.id CASCADE
-- (session_id FK already exists; adding task_id FK)
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `task_work_history_new` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `session_id` text NOT NULL,
  `task_id` text NOT NULL,
  `set_at` text DEFAULT (datetime('now')) NOT NULL,
  `cleared_at` text,
  CONSTRAINT `fk_task_work_history_session_id` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_task_work_history_task_id` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `task_work_history_new` SELECT `id`, `session_id`, `task_id`, `set_at`, `cleared_at` FROM `task_work_history`;
--> statement-breakpoint
DROP TABLE `task_work_history`;
--> statement-breakpoint
ALTER TABLE `task_work_history_new` RENAME TO `task_work_history`;
--> statement-breakpoint
CREATE INDEX `idx_work_history_session` ON `task_work_history` (`session_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint

-- SFK-001: adr_task_links.task_id → tasks.id CASCADE
-- (adr_id FK already exists; adding task_id FK)
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `adr_task_links_new` (
  `adr_id` text NOT NULL,
  `task_id` text NOT NULL,
  `link_type` text DEFAULT 'related' NOT NULL,
  CONSTRAINT `adr_task_links_pk` PRIMARY KEY(`adr_id`, `task_id`),
  CONSTRAINT `fk_adr_task_links_adr_id` FOREIGN KEY (`adr_id`) REFERENCES `architecture_decisions`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_adr_task_links_task_id` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `adr_task_links_new` SELECT `adr_id`, `task_id`, `link_type` FROM `adr_task_links`;
--> statement-breakpoint
DROP TABLE `adr_task_links`;
--> statement-breakpoint
ALTER TABLE `adr_task_links_new` RENAME TO `adr_task_links`;
--> statement-breakpoint
CREATE INDEX `idx_adr_task_links_task_id` ON `adr_task_links` (`task_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint

-- SFK-008/009: lifecycle_transitions stage FKs CASCADE
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `lifecycle_transitions_new` (
  `id` text PRIMARY KEY,
  `pipeline_id` text NOT NULL,
  `from_stage_id` text NOT NULL,
  `to_stage_id` text NOT NULL,
  `transition_type` text DEFAULT 'automatic' NOT NULL,
  `transitioned_by` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  CONSTRAINT `fk_lifecycle_transitions_pipeline_id` FOREIGN KEY (`pipeline_id`) REFERENCES `lifecycle_pipelines`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_lifecycle_transitions_from_stage_id` FOREIGN KEY (`from_stage_id`) REFERENCES `lifecycle_stages`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_lifecycle_transitions_to_stage_id` FOREIGN KEY (`to_stage_id`) REFERENCES `lifecycle_stages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `lifecycle_transitions_new` SELECT `id`, `pipeline_id`, `from_stage_id`, `to_stage_id`, `transition_type`, `transitioned_by`, `created_at` FROM `lifecycle_transitions`;
--> statement-breakpoint
DROP TABLE `lifecycle_transitions`;
--> statement-breakpoint
ALTER TABLE `lifecycle_transitions_new` RENAME TO `lifecycle_transitions`;
--> statement-breakpoint
CREATE INDEX `idx_lifecycle_transitions_pipeline_id` ON `lifecycle_transitions` (`pipeline_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint

-- SFK-010/011/012/013: architecture_decisions self-refs SET NULL
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `architecture_decisions_new` (
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
  CONSTRAINT `fk_arch_decisions_supersedes_id` FOREIGN KEY (`supersedes_id`) REFERENCES `architecture_decisions`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_arch_decisions_superseded_by_id` FOREIGN KEY (`superseded_by_id`) REFERENCES `architecture_decisions`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_arch_decisions_amends_id` FOREIGN KEY (`amends_id`) REFERENCES `architecture_decisions`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_arch_decisions_consensus_manifest_id` FOREIGN KEY (`consensus_manifest_id`) REFERENCES `manifest_entries`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `architecture_decisions_new` SELECT `id`, `title`, `status`, `supersedes_id`, `superseded_by_id`, `consensus_manifest_id`, `content`, `created_at`, `updated_at`, `date`, `accepted_at`, `gate`, `gate_status`, `amends_id`, `file_path`, `summary`, `keywords`, `topics` FROM `architecture_decisions`;
--> statement-breakpoint
DROP TABLE `architecture_decisions`;
--> statement-breakpoint
ALTER TABLE `architecture_decisions_new` RENAME TO `architecture_decisions`;
--> statement-breakpoint
CREATE INDEX `idx_arch_decisions_status` ON `architecture_decisions` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_arch_decisions_amends_id` ON `architecture_decisions` (`amends_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint

-- SFK-014/015/016: agent_instances refs SET NULL
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `agent_instances_new` (
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
  `parent_agent_id` text,
  CONSTRAINT `fk_agent_instances_session_id` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_agent_instances_task_id` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_agent_instances_parent_agent_id` FOREIGN KEY (`parent_agent_id`) REFERENCES `agent_instances`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `agent_instances_new` SELECT `id`, `agent_type`, `status`, `session_id`, `task_id`, `started_at`, `last_heartbeat`, `stopped_at`, `error_count`, `total_tasks_completed`, `capacity`, `metadata_json`, `parent_agent_id` FROM `agent_instances`;
--> statement-breakpoint
DROP TABLE `agent_instances`;
--> statement-breakpoint
ALTER TABLE `agent_instances_new` RENAME TO `agent_instances`;
--> statement-breakpoint
CREATE INDEX `idx_agent_instances_status` ON `agent_instances` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_agent_instances_agent_type` ON `agent_instances` (`agent_type`);
--> statement-breakpoint
CREATE INDEX `idx_agent_instances_session_id` ON `agent_instances` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_instances_task_id` ON `agent_instances` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_instances_parent_agent_id` ON `agent_instances` (`parent_agent_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_instances_last_heartbeat` ON `agent_instances` (`last_heartbeat`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint

-- SFK-017: agent_error_log.agent_id → agent_instances.id CASCADE
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `agent_error_log_new` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `agent_id` text NOT NULL,
  `error_type` text NOT NULL,
  `message` text NOT NULL,
  `stack` text,
  `occurred_at` text DEFAULT (datetime('now')) NOT NULL,
  `resolved` integer DEFAULT false NOT NULL,
  CONSTRAINT `fk_agent_error_log_agent_id` FOREIGN KEY (`agent_id`) REFERENCES `agent_instances`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `agent_error_log_new` SELECT `id`, `agent_id`, `error_type`, `message`, `stack`, `occurred_at`, `resolved` FROM `agent_error_log`;
--> statement-breakpoint
DROP TABLE `agent_error_log`;
--> statement-breakpoint
ALTER TABLE `agent_error_log_new` RENAME TO `agent_error_log`;
--> statement-breakpoint
CREATE INDEX `idx_agent_error_log_agent_id` ON `agent_error_log` (`agent_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_error_log_error_type` ON `agent_error_log` (`error_type`);
--> statement-breakpoint
CREATE INDEX `idx_agent_error_log_occurred_at` ON `agent_error_log` (`occurred_at`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint

-- SFK-002/003/004: pipeline_manifest SET NULL FKs
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `pipeline_manifest_new` (
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
  CONSTRAINT `fk_pipeline_manifest_task_id` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pipeline_manifest_session_id` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pipeline_manifest_epic_id` FOREIGN KEY (`epic_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `pipeline_manifest_new` SELECT `id`, `session_id`, `task_id`, `epic_id`, `type`, `content`, `content_hash`, `status`, `distilled`, `brain_obs_id`, `source_file`, `metadata_json`, `created_at`, `archived_at` FROM `pipeline_manifest`;
--> statement-breakpoint
DROP TABLE `pipeline_manifest`;
--> statement-breakpoint
ALTER TABLE `pipeline_manifest_new` RENAME TO `pipeline_manifest`;
--> statement-breakpoint
CREATE INDEX `idx_pipeline_manifest_task_id` ON `pipeline_manifest` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_manifest_session_id` ON `pipeline_manifest` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_manifest_distilled` ON `pipeline_manifest` (`distilled`);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_manifest_status` ON `pipeline_manifest` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_manifest_content_hash` ON `pipeline_manifest` (`content_hash`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint

-- SFK-006: release_manifests.epic_id → tasks.id SET NULL
-- (pipeline_id FK already exists; adding epic_id FK)
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `release_manifests_new` (
  `id` text PRIMARY KEY,
  `version` text NOT NULL UNIQUE,
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
  CONSTRAINT `fk_release_manifests_pipeline_id` FOREIGN KEY (`pipeline_id`) REFERENCES `lifecycle_pipelines`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_release_manifests_epic_id` FOREIGN KEY (`epic_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `release_manifests_new` SELECT `id`, `version`, `status`, `pipeline_id`, `epic_id`, `tasks_json`, `changelog`, `notes`, `previous_version`, `commit_sha`, `git_tag`, `npm_dist_tag`, `created_at`, `prepared_at`, `committed_at`, `tagged_at`, `pushed_at` FROM `release_manifests`;
--> statement-breakpoint
DROP TABLE `release_manifests`;
--> statement-breakpoint
ALTER TABLE `release_manifests_new` RENAME TO `release_manifests`;
--> statement-breakpoint
CREATE INDEX `idx_release_manifests_status` ON `release_manifests` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_release_manifests_version` ON `release_manifests` (`version`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint

-- SFK-007: warp_chain_instances.epic_id → tasks.id CASCADE
-- (chain_id FK already exists; adding epic_id FK)
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `warp_chain_instances_new` (
  `id` text PRIMARY KEY,
  `chain_id` text NOT NULL,
  `epic_id` text NOT NULL,
  `variables` text,
  `stage_to_task` text,
  `status` text DEFAULT 'pending' NOT NULL,
  `current_stage` text,
  `gate_results` text,
  `created_at` text DEFAULT (datetime('now')),
  `updated_at` text DEFAULT (datetime('now')),
  CONSTRAINT `fk_warp_chain_instances_chain_id` FOREIGN KEY (`chain_id`) REFERENCES `warp_chains`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_warp_chain_instances_epic_id` FOREIGN KEY (`epic_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `warp_chain_instances_new` SELECT `id`, `chain_id`, `epic_id`, `variables`, `stage_to_task`, `status`, `current_stage`, `gate_results`, `created_at`, `updated_at` FROM `warp_chain_instances`;
--> statement-breakpoint
DROP TABLE `warp_chain_instances`;
--> statement-breakpoint
ALTER TABLE `warp_chain_instances_new` RENAME TO `warp_chain_instances`;
--> statement-breakpoint
CREATE INDEX `idx_warp_instances_chain` ON `warp_chain_instances` (`chain_id`);
--> statement-breakpoint
CREATE INDEX `idx_warp_instances_epic` ON `warp_chain_instances` (`epic_id`);
--> statement-breakpoint
CREATE INDEX `idx_warp_instances_status` ON `warp_chain_instances` (`status`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint

-- SFK-018: tasks.session_id → sessions.id SET NULL
-- AND Part 5: Add tasks.pipeline_stage column with FK to lifecycle_stages.id
-- (parent_id FK already exists; adding session_id and pipeline_stage FKs)
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `tasks_new` (
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
  CONSTRAINT `fk_tasks_parent_id` FOREIGN KEY (`parent_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_tasks_session_id` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_tasks_pipeline_stage` FOREIGN KEY (`pipeline_stage`) REFERENCES `lifecycle_stages`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `tasks_new` (`id`, `title`, `description`, `status`, `priority`, `type`, `parent_id`, `phase`, `size`, `position`, `position_version`, `labels_json`, `notes_json`, `acceptance_json`, `files_json`, `origin`, `blocked_by`, `epic_lifecycle`, `no_auto_complete`, `created_at`, `updated_at`, `completed_at`, `cancelled_at`, `cancellation_reason`, `archived_at`, `archive_reason`, `cycle_time_days`, `verification_json`, `created_by`, `modified_by`, `session_id`) SELECT `id`, `title`, `description`, `status`, `priority`, `type`, `parent_id`, `phase`, `size`, `position`, `position_version`, `labels_json`, `notes_json`, `acceptance_json`, `files_json`, `origin`, `blocked_by`, `epic_lifecycle`, `no_auto_complete`, `created_at`, `updated_at`, `completed_at`, `cancelled_at`, `cancellation_reason`, `archived_at`, `archive_reason`, `cycle_time_days`, `verification_json`, `created_by`, `modified_by`, `session_id` FROM `tasks`;
--> statement-breakpoint
DROP TABLE `tasks`;
--> statement-breakpoint
ALTER TABLE `tasks_new` RENAME TO `tasks`;
--> statement-breakpoint
-- Single-column indexes for tasks (restore after table rebuild)
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_parent_id` ON `tasks` (`parent_id`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_phase` ON `tasks` (`phase`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_type` ON `tasks` (`type`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_priority` ON `tasks` (`priority`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_session_id` ON `tasks` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_pipeline_stage` ON `tasks` (`pipeline_stage`);
--> statement-breakpoint
-- Composite indexes for tasks (PART 2 — placed after rebuild to survive DROP)
CREATE INDEX IF NOT EXISTS `idx_tasks_parent_status` ON `tasks` (`parent_id`, `status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_status_priority` ON `tasks` (`status`, `priority`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_type_phase` ON `tasks` (`type`, `phase`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_status_archive_reason` ON `tasks` (`status`, `archive_reason`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint

-- SFK-023: sessions.current_task → tasks.id SET NULL
-- (previous_session_id and next_session_id FKs already exist; adding current_task FK)
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `sessions_new` (
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
  CONSTRAINT `fk_sessions_previous_session_id` FOREIGN KEY (`previous_session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_sessions_next_session_id` FOREIGN KEY (`next_session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_sessions_current_task` FOREIGN KEY (`current_task`) REFERENCES `tasks`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `sessions_new` SELECT `id`, `name`, `status`, `scope_json`, `current_task`, `task_started_at`, `agent`, `notes_json`, `tasks_completed_json`, `tasks_created_json`, `handoff_json`, `started_at`, `ended_at`, `previous_session_id`, `next_session_id`, `agent_identifier`, `handoff_consumed_at`, `handoff_consumed_by`, `debrief_json`, `provider_id`, `stats_json`, `resume_count`, `grade_mode` FROM `sessions`;
--> statement-breakpoint
DROP TABLE `sessions`;
--> statement-breakpoint
ALTER TABLE `sessions_new` RENAME TO `sessions`;
--> statement-breakpoint
-- Single-column indexes for sessions (restore after table rebuild)
CREATE INDEX `idx_sessions_status` ON `sessions` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_sessions_previous` ON `sessions` (`previous_session_id`);
--> statement-breakpoint
CREATE INDEX `idx_sessions_agent_identifier` ON `sessions` (`agent_identifier`);
--> statement-breakpoint
CREATE INDEX `idx_sessions_started_at` ON `sessions` (`started_at`);
--> statement-breakpoint
-- Composite index for sessions (PART 2 — placed after rebuild to survive DROP)
CREATE INDEX IF NOT EXISTS `idx_sessions_status_started_at` ON `sessions` (`status`, `started_at`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint

-- SFK-020/021: token_usage SET NULL FKs for session_id and task_id
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `token_usage_new` (
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
  CONSTRAINT `fk_token_usage_session_id` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_token_usage_task_id` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `token_usage_new` SELECT `id`, `created_at`, `provider`, `model`, `transport`, `gateway`, `domain`, `operation`, `session_id`, `task_id`, `request_id`, `input_chars`, `output_chars`, `input_tokens`, `output_tokens`, `total_tokens`, `method`, `confidence`, `request_hash`, `response_hash`, `metadata_json` FROM `token_usage`;
--> statement-breakpoint
DROP TABLE `token_usage`;
--> statement-breakpoint
ALTER TABLE `token_usage_new` RENAME TO `token_usage`;
--> statement-breakpoint
CREATE INDEX `idx_token_usage_created_at` ON `token_usage` (`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_token_usage_request_id` ON `token_usage` (`request_id`);
--> statement-breakpoint
CREATE INDEX `idx_token_usage_session_id` ON `token_usage` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_token_usage_task_id` ON `token_usage` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_token_usage_provider` ON `token_usage` (`provider`);
--> statement-breakpoint
CREATE INDEX `idx_token_usage_transport` ON `token_usage` (`transport`);
--> statement-breakpoint
CREATE INDEX `idx_token_usage_domain_operation` ON `token_usage` (`domain`, `operation`);
--> statement-breakpoint
CREATE INDEX `idx_token_usage_method` ON `token_usage` (`method`);
--> statement-breakpoint
CREATE INDEX `idx_token_usage_gateway` ON `token_usage` (`gateway`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
