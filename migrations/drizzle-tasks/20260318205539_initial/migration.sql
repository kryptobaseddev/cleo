CREATE TABLE `adr_relations` (
	`from_adr_id` text NOT NULL,
	`to_adr_id` text NOT NULL,
	`relation_type` text NOT NULL,
	CONSTRAINT `adr_relations_pk` PRIMARY KEY(`from_adr_id`, `to_adr_id`, `relation_type`),
	CONSTRAINT `fk_adr_relations_from_adr_id_architecture_decisions_id_fk` FOREIGN KEY (`from_adr_id`) REFERENCES `architecture_decisions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_adr_relations_to_adr_id_architecture_decisions_id_fk` FOREIGN KEY (`to_adr_id`) REFERENCES `architecture_decisions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `adr_task_links` (
	`adr_id` text NOT NULL,
	`task_id` text NOT NULL,
	`link_type` text DEFAULT 'related' NOT NULL,
	CONSTRAINT `adr_task_links_pk` PRIMARY KEY(`adr_id`, `task_id`),
	CONSTRAINT `fk_adr_task_links_adr_id_architecture_decisions_id_fk` FOREIGN KEY (`adr_id`) REFERENCES `architecture_decisions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `architecture_decisions` (
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
	`topics` text
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY,
	`timestamp` text DEFAULT (datetime('now')) NOT NULL,
	`action` text NOT NULL,
	`task_id` text NOT NULL,
	`actor` text DEFAULT 'system' NOT NULL,
	`details_json` text DEFAULT '{}',
	`before_json` text,
	`after_json` text,
	`domain` text,
	`operation` text,
	`session_id` text,
	`request_id` text,
	`duration_ms` integer,
	`success` integer,
	`source` text,
	`gateway` text,
	`error_message` text,
	`project_hash` text
);
--> statement-breakpoint
CREATE TABLE `lifecycle_evidence` (
	`id` text PRIMARY KEY,
	`stage_id` text NOT NULL,
	`uri` text NOT NULL,
	`type` text NOT NULL,
	`recorded_at` text DEFAULT (datetime('now')) NOT NULL,
	`recorded_by` text,
	`description` text,
	CONSTRAINT `fk_lifecycle_evidence_stage_id_lifecycle_stages_id_fk` FOREIGN KEY (`stage_id`) REFERENCES `lifecycle_stages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `lifecycle_gate_results` (
	`id` text PRIMARY KEY,
	`stage_id` text NOT NULL,
	`gate_name` text NOT NULL,
	`result` text NOT NULL,
	`checked_at` text DEFAULT (datetime('now')) NOT NULL,
	`checked_by` text NOT NULL,
	`details` text,
	`reason` text,
	CONSTRAINT `fk_lifecycle_gate_results_stage_id_lifecycle_stages_id_fk` FOREIGN KEY (`stage_id`) REFERENCES `lifecycle_stages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `lifecycle_pipelines` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`current_stage_id` text,
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	`completed_at` text,
	`updated_at` text DEFAULT (datetime('now')),
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `fk_lifecycle_pipelines_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `lifecycle_stages` (
	`id` text PRIMARY KEY,
	`pipeline_id` text NOT NULL,
	`stage_name` text NOT NULL,
	`status` text DEFAULT 'not_started' NOT NULL,
	`sequence` integer NOT NULL,
	`started_at` text,
	`completed_at` text,
	`blocked_at` text,
	`block_reason` text,
	`skipped_at` text,
	`skip_reason` text,
	`notes_json` text DEFAULT '[]',
	`metadata_json` text DEFAULT '{}',
	`output_file` text,
	`created_by` text,
	`validated_by` text,
	`validated_at` text,
	`validation_status` text,
	`provenance_chain_json` text,
	CONSTRAINT `fk_lifecycle_stages_pipeline_id_lifecycle_pipelines_id_fk` FOREIGN KEY (`pipeline_id`) REFERENCES `lifecycle_pipelines`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `lifecycle_transitions` (
	`id` text PRIMARY KEY,
	`pipeline_id` text NOT NULL,
	`from_stage_id` text NOT NULL,
	`to_stage_id` text NOT NULL,
	`transition_type` text DEFAULT 'automatic' NOT NULL,
	`transitioned_by` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_lifecycle_transitions_pipeline_id_lifecycle_pipelines_id_fk` FOREIGN KEY (`pipeline_id`) REFERENCES `lifecycle_pipelines`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `manifest_entries` (
	`id` text PRIMARY KEY,
	`pipeline_id` text,
	`stage_id` text,
	`title` text NOT NULL,
	`date` text NOT NULL,
	`status` text NOT NULL,
	`agent_type` text,
	`output_file` text,
	`topics_json` text DEFAULT '[]',
	`findings_json` text DEFAULT '[]',
	`linked_tasks_json` text DEFAULT '[]',
	`created_by` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_manifest_entries_pipeline_id_lifecycle_pipelines_id_fk` FOREIGN KEY (`pipeline_id`) REFERENCES `lifecycle_pipelines`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_manifest_entries_stage_id_lifecycle_stages_id_fk` FOREIGN KEY (`stage_id`) REFERENCES `lifecycle_stages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `pipeline_manifest` (
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
	`archived_at` text
);
--> statement-breakpoint
CREATE TABLE `release_manifests` (
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
	CONSTRAINT `fk_release_manifests_pipeline_id_lifecycle_pipelines_id_fk` FOREIGN KEY (`pipeline_id`) REFERENCES `lifecycle_pipelines`(`id`)
);
--> statement-breakpoint
CREATE TABLE `schema_meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
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
	`grade_mode` integer
);
--> statement-breakpoint
CREATE TABLE `status_registry` (
	`name` text NOT NULL,
	`entity_type` text NOT NULL,
	`namespace` text NOT NULL,
	`description` text NOT NULL,
	`is_terminal` integer DEFAULT false NOT NULL,
	CONSTRAINT `status_registry_pk` PRIMARY KEY(`name`, `entity_type`)
);
--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`task_id` text NOT NULL,
	`depends_on` text NOT NULL,
	CONSTRAINT `task_dependencies_pk` PRIMARY KEY(`task_id`, `depends_on`),
	CONSTRAINT `fk_task_dependencies_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_task_dependencies_depends_on_tasks_id_fk` FOREIGN KEY (`depends_on`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `task_relations` (
	`task_id` text NOT NULL,
	`related_to` text NOT NULL,
	`relation_type` text DEFAULT 'related' NOT NULL,
	`reason` text,
	CONSTRAINT `task_relations_pk` PRIMARY KEY(`task_id`, `related_to`),
	CONSTRAINT `fk_task_relations_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_task_relations_related_to_tasks_id_fk` FOREIGN KEY (`related_to`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `task_work_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`session_id` text NOT NULL,
	`task_id` text NOT NULL,
	`set_at` text DEFAULT (datetime('now')) NOT NULL,
	`cleared_at` text,
	CONSTRAINT `fk_task_work_history_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tasks` (
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
	CONSTRAINT `fk_tasks_parent_id_tasks_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `token_usage` (
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
	`metadata_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `warp_chain_instances` (
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
	CONSTRAINT `fk_warp_chain_instances_chain_id_warp_chains_id_fk` FOREIGN KEY (`chain_id`) REFERENCES `warp_chains`(`id`)
);
--> statement-breakpoint
CREATE TABLE `warp_chains` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`description` text,
	`definition` text NOT NULL,
	`validated` integer DEFAULT false,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `idx_adr_task_links_task_id` ON `adr_task_links` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_arch_decisions_status` ON `architecture_decisions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_task_id` ON `audit_log` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_action` ON `audit_log` (`action`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_timestamp` ON `audit_log` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_domain` ON `audit_log` (`domain`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_request_id` ON `audit_log` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_project_hash` ON `audit_log` (`project_hash`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_evidence_stage_id` ON `lifecycle_evidence` (`stage_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_gate_results_stage_id` ON `lifecycle_gate_results` (`stage_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_pipelines_task_id` ON `lifecycle_pipelines` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_pipelines_status` ON `lifecycle_pipelines` (`status`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_stages_pipeline_id` ON `lifecycle_stages` (`pipeline_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_stages_stage_name` ON `lifecycle_stages` (`stage_name`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_stages_status` ON `lifecycle_stages` (`status`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_transitions_pipeline_id` ON `lifecycle_transitions` (`pipeline_id`);--> statement-breakpoint
CREATE INDEX `idx_manifest_entries_pipeline_id` ON `manifest_entries` (`pipeline_id`);--> statement-breakpoint
CREATE INDEX `idx_manifest_entries_stage_id` ON `manifest_entries` (`stage_id`);--> statement-breakpoint
CREATE INDEX `idx_manifest_entries_status` ON `manifest_entries` (`status`);--> statement-breakpoint
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
CREATE INDEX `idx_status_registry_entity_type` ON `status_registry` (`entity_type`);--> statement-breakpoint
CREATE INDEX `idx_status_registry_namespace` ON `status_registry` (`namespace`);--> statement-breakpoint
CREATE INDEX `idx_deps_depends_on` ON `task_dependencies` (`depends_on`);--> statement-breakpoint
CREATE INDEX `idx_work_history_session` ON `task_work_history` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_parent_id` ON `tasks` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_phase` ON `tasks` (`phase`);--> statement-breakpoint
CREATE INDEX `idx_tasks_type` ON `tasks` (`type`);--> statement-breakpoint
CREATE INDEX `idx_tasks_priority` ON `tasks` (`priority`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_created_at` ON `token_usage` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_request_id` ON `token_usage` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_session_id` ON `token_usage` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_task_id` ON `token_usage` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_provider` ON `token_usage` (`provider`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_transport` ON `token_usage` (`transport`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_domain_operation` ON `token_usage` (`domain`,`operation`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_method` ON `token_usage` (`method`);--> statement-breakpoint
CREATE INDEX `idx_warp_instances_chain` ON `warp_chain_instances` (`chain_id`);--> statement-breakpoint
CREATE INDEX `idx_warp_instances_epic` ON `warp_chain_instances` (`epic_id`);--> statement-breakpoint
CREATE INDEX `idx_warp_instances_status` ON `warp_chain_instances` (`status`);--> statement-breakpoint
CREATE INDEX `idx_warp_chains_name` ON `warp_chains` (`name`);