CREATE TABLE `external_task_links` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`external_id` text NOT NULL,
	`external_url` text,
	`external_title` text,
	`link_type` text NOT NULL,
	`sync_direction` text DEFAULT 'inbound' NOT NULL,
	`metadata_json` text DEFAULT '{}',
	`linked_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_sync_at` text,
	CONSTRAINT `fk_external_task_links_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `uq_ext_links_task_provider_external` UNIQUE(`task_id`,`provider_id`,`external_id`)
);
--> statement-breakpoint
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
	CONSTRAINT `fk_sessions_previous_session_id_sessions_id_fk` FOREIGN KEY (`previous_session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_sessions_next_session_id_sessions_id_fk` FOREIGN KEY (`next_session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `__new_sessions`(`id`, `name`, `status`, `scope_json`, `current_task`, `task_started_at`, `agent`, `notes_json`, `tasks_completed_json`, `tasks_created_json`, `handoff_json`, `started_at`, `ended_at`, `previous_session_id`, `next_session_id`, `agent_identifier`, `handoff_consumed_at`, `handoff_consumed_by`, `debrief_json`, `provider_id`, `stats_json`, `resume_count`, `grade_mode`) SELECT `id`, `name`, `status`, `scope_json`, `current_task`, `task_started_at`, `agent`, `notes_json`, `tasks_completed_json`, `tasks_created_json`, `handoff_json`, `started_at`, `ended_at`, `previous_session_id`, `next_session_id`, `agent_identifier`, `handoff_consumed_at`, `handoff_consumed_by`, `debrief_json`, `provider_id`, `stats_json`, `resume_count`, `grade_mode` FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_warp_chain_instances` (
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
	CONSTRAINT `fk_warp_chain_instances_chain_id_warp_chains_id_fk` FOREIGN KEY (`chain_id`) REFERENCES `warp_chains`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_warp_chain_instances`(`id`, `chain_id`, `epic_id`, `variables`, `stage_to_task`, `status`, `current_stage`, `gate_results`, `created_at`, `updated_at`) SELECT `id`, `chain_id`, `epic_id`, `variables`, `stage_to_task`, `status`, `current_stage`, `gate_results`, `created_at`, `updated_at` FROM `warp_chain_instances`;--> statement-breakpoint
DROP TABLE `warp_chain_instances`;--> statement-breakpoint
ALTER TABLE `__new_warp_chain_instances` RENAME TO `warp_chain_instances`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_sessions_status` ON `sessions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_sessions_previous` ON `sessions` (`previous_session_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_agent_identifier` ON `sessions` (`agent_identifier`);--> statement-breakpoint
CREATE INDEX `idx_sessions_started_at` ON `sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_warp_instances_chain` ON `warp_chain_instances` (`chain_id`);--> statement-breakpoint
CREATE INDEX `idx_warp_instances_epic` ON `warp_chain_instances` (`epic_id`);--> statement-breakpoint
CREATE INDEX `idx_warp_instances_status` ON `warp_chain_instances` (`status`);--> statement-breakpoint
CREATE INDEX `idx_arch_decisions_amends_id` ON `architecture_decisions` (`amends_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_actor` ON `audit_log` (`actor`);--> statement-breakpoint
CREATE INDEX `idx_ext_links_task_id` ON `external_task_links` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_ext_links_provider_external` ON `external_task_links` (`provider_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_ext_links_provider_id` ON `external_task_links` (`provider_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_stages_validated_by` ON `lifecycle_stages` (`validated_by`);--> statement-breakpoint
CREATE INDEX `idx_task_relations_related_to` ON `task_relations` (`related_to`);--> statement-breakpoint
CREATE INDEX `idx_tasks_session_id` ON `tasks` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_gateway` ON `token_usage` (`gateway`);