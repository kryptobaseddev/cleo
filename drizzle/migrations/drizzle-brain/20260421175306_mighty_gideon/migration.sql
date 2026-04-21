CREATE TABLE `brain_backfill_runs` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`status` text DEFAULT 'staged' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`approved_at` text,
	`rows_affected` integer DEFAULT 0 NOT NULL,
	`rollback_snapshot_json` text,
	`source` text DEFAULT 'unknown' NOT NULL,
	`target_table` text DEFAULT 'brain_observations' NOT NULL,
	`approved_by` text
);
--> statement-breakpoint
CREATE TABLE `brain_consolidation_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`trigger` text NOT NULL,
	`session_id` text,
	`step_results_json` text NOT NULL,
	`duration_ms` integer,
	`succeeded` integer DEFAULT true NOT NULL,
	`started_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `brain_modulators` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`modulator_type` text NOT NULL,
	`valence` real NOT NULL,
	`magnitude` real DEFAULT 1 NOT NULL,
	`source_event_id` text,
	`session_id` text,
	`description` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `brain_plasticity_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`source_node` text NOT NULL,
	`target_node` text NOT NULL,
	`delta_w` real NOT NULL,
	`kind` text NOT NULL,
	`timestamp` text DEFAULT (datetime('now')) NOT NULL,
	`session_id` text,
	`weight_before` real,
	`weight_after` real,
	`retrieval_log_id` integer,
	`reward_signal` real,
	`delta_t_ms` integer
);
--> statement-breakpoint
CREATE TABLE `brain_promotion_log` (
	`id` text PRIMARY KEY,
	`observation_id` text NOT NULL,
	`from_tier` text NOT NULL,
	`to_tier` text NOT NULL,
	`score` real NOT NULL,
	`decided_at` text DEFAULT (datetime('now')) NOT NULL,
	`decided_by` text DEFAULT 'composite-scorer' NOT NULL,
	`rationale_json` text
);
--> statement-breakpoint
CREATE TABLE `brain_retrieval_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`query` text NOT NULL,
	`entry_ids` text NOT NULL,
	`entry_count` integer NOT NULL,
	`source` text NOT NULL,
	`tokens_used` integer,
	`session_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`retrieval_order` integer,
	`delta_ms` integer,
	`reward_signal` real
);
--> statement-breakpoint
CREATE TABLE `brain_transcript_events` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`block_type` text NOT NULL,
	`content` text NOT NULL,
	`tokens` integer,
	`redacted_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `brain_weight_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`edge_from_id` text NOT NULL,
	`edge_to_id` text NOT NULL,
	`edge_type` text NOT NULL,
	`weight_before` real,
	`weight_after` real NOT NULL,
	`delta_weight` real NOT NULL,
	`event_kind` text NOT NULL,
	`source_plasticity_event_id` integer,
	`retrieval_log_id` integer,
	`reward_signal` real,
	`changed_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD `quality_score` real;--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD `memory_tier` text DEFAULT 'medium';--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD `memory_type` text DEFAULT 'semantic';--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD `verified` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD `valid_at` text DEFAULT (datetime('now')) NOT NULL;--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD `invalid_at` text;--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD `source_confidence` text DEFAULT 'agent';--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD `citation_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD `tier_promoted_at` text;--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD `tier_promotion_reason` text;--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD `content_hash` text;--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD `quality_score` real;--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD `memory_tier` text DEFAULT 'short';--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD `memory_type` text DEFAULT 'semantic';--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD `verified` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD `valid_at` text DEFAULT (datetime('now')) NOT NULL;--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD `invalid_at` text;--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD `source_confidence` text DEFAULT 'agent';--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD `citation_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD `tier_promoted_at` text;--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD `tier_promotion_reason` text;--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD `content_hash` text;--> statement-breakpoint
ALTER TABLE `brain_observations` ADD `agent` text;--> statement-breakpoint
ALTER TABLE `brain_observations` ADD `quality_score` real;--> statement-breakpoint
ALTER TABLE `brain_observations` ADD `memory_tier` text DEFAULT 'short';--> statement-breakpoint
ALTER TABLE `brain_observations` ADD `memory_type` text DEFAULT 'episodic';--> statement-breakpoint
ALTER TABLE `brain_observations` ADD `verified` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `brain_observations` ADD `valid_at` text DEFAULT (datetime('now')) NOT NULL;--> statement-breakpoint
ALTER TABLE `brain_observations` ADD `invalid_at` text;--> statement-breakpoint
ALTER TABLE `brain_observations` ADD `source_confidence` text DEFAULT 'agent';--> statement-breakpoint
ALTER TABLE `brain_observations` ADD `citation_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `brain_observations` ADD `tier_promoted_at` text;--> statement-breakpoint
ALTER TABLE `brain_observations` ADD `tier_promotion_reason` text;--> statement-breakpoint
ALTER TABLE `brain_observations` ADD `attachments_json` text;--> statement-breakpoint
ALTER TABLE `brain_observations` ADD `stability_score` real DEFAULT 0.5;--> statement-breakpoint
ALTER TABLE `brain_page_edges` ADD `provenance` text;--> statement-breakpoint
ALTER TABLE `brain_page_edges` ADD `last_reinforced_at` text;--> statement-breakpoint
ALTER TABLE `brain_page_edges` ADD `reinforcement_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `brain_page_edges` ADD `plasticity_class` text DEFAULT 'static' NOT NULL;--> statement-breakpoint
ALTER TABLE `brain_page_edges` ADD `last_depressed_at` text;--> statement-breakpoint
ALTER TABLE `brain_page_edges` ADD `depression_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `brain_page_edges` ADD `stability_score` real;--> statement-breakpoint
ALTER TABLE `brain_page_nodes` ADD `quality_score` real DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE `brain_page_nodes` ADD `content_hash` text;--> statement-breakpoint
ALTER TABLE `brain_page_nodes` ADD `last_activity_at` text DEFAULT (datetime('now')) NOT NULL;--> statement-breakpoint
ALTER TABLE `brain_page_nodes` ADD `updated_at` text;--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD `quality_score` real;--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD `memory_tier` text DEFAULT 'medium';--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD `memory_type` text DEFAULT 'procedural';--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD `verified` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD `valid_at` text DEFAULT (datetime('now')) NOT NULL;--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD `invalid_at` text;--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD `source_confidence` text DEFAULT 'agent';--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD `citation_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD `tier_promoted_at` text;--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD `tier_promotion_reason` text;--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD `content_hash` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_brain_page_edges` (
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`edge_type` text NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`provenance` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_reinforced_at` text,
	`reinforcement_count` integer DEFAULT 0 NOT NULL,
	`plasticity_class` text DEFAULT 'static' NOT NULL,
	`last_depressed_at` text,
	`depression_count` integer DEFAULT 0 NOT NULL,
	`stability_score` real,
	CONSTRAINT `brain_page_edges_pk` PRIMARY KEY(`from_id`, `to_id`, `edge_type`)
);
--> statement-breakpoint
INSERT INTO `__new_brain_page_edges`(`from_id`, `to_id`, `edge_type`, `weight`, `created_at`) SELECT `from_id`, `to_id`, `edge_type`, `weight`, `created_at` FROM `brain_page_edges`;--> statement-breakpoint
DROP TABLE `brain_page_edges`;--> statement-breakpoint
ALTER TABLE `__new_brain_page_edges` RENAME TO `brain_page_edges`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_brain_observations_content_hash`;--> statement-breakpoint
CREATE INDEX `idx_brain_edges_from` ON `brain_page_edges` (`from_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_edges_to` ON `brain_page_edges` (`to_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_edges_type` ON `brain_page_edges` (`edge_type`);--> statement-breakpoint
CREATE INDEX `idx_brain_edges_last_reinforced` ON `brain_page_edges` (`last_reinforced_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_edges_plasticity_class` ON `brain_page_edges` (`plasticity_class`);--> statement-breakpoint
CREATE INDEX `idx_brain_edges_stability` ON `brain_page_edges` (`stability_score`);--> statement-breakpoint
CREATE INDEX `idx_backfill_runs_status` ON `brain_backfill_runs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_backfill_runs_kind` ON `brain_backfill_runs` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_backfill_runs_created_at` ON `brain_backfill_runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_consolidation_events_started_at` ON `brain_consolidation_events` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_consolidation_events_trigger` ON `brain_consolidation_events` (`trigger`);--> statement-breakpoint
CREATE INDEX `idx_consolidation_events_session` ON `brain_consolidation_events` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_quality` ON `brain_decisions` (`quality_score`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_tier` ON `brain_decisions` (`memory_tier`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_mem_type` ON `brain_decisions` (`memory_type`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_verified` ON `brain_decisions` (`verified`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_valid_at` ON `brain_decisions` (`valid_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_source_conf` ON `brain_decisions` (`source_confidence`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_tier_promoted_at` ON `brain_decisions` (`tier_promoted_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_content_hash` ON `brain_decisions` (`content_hash`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_quality` ON `brain_learnings` (`quality_score`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_tier` ON `brain_learnings` (`memory_tier`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_mem_type` ON `brain_learnings` (`memory_type`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_verified` ON `brain_learnings` (`verified`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_valid_at` ON `brain_learnings` (`valid_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_invalid` ON `brain_learnings` (`invalid_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_source_conf` ON `brain_learnings` (`source_confidence`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_tier_promoted_at` ON `brain_learnings` (`tier_promoted_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_content_hash` ON `brain_learnings` (`content_hash`);--> statement-breakpoint
CREATE INDEX `idx_modulators_type` ON `brain_modulators` (`modulator_type`);--> statement-breakpoint
CREATE INDEX `idx_modulators_session` ON `brain_modulators` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_modulators_created_at` ON `brain_modulators` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_modulators_source_event` ON `brain_modulators` (`source_event_id`);--> statement-breakpoint
CREATE INDEX `idx_modulators_valence` ON `brain_modulators` (`valence`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_content_hash_created_at` ON `brain_observations` (`content_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_type_project` ON `brain_observations` (`type`,`project`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_agent` ON `brain_observations` (`agent`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_quality` ON `brain_observations` (`quality_score`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_tier` ON `brain_observations` (`memory_tier`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_mem_type` ON `brain_observations` (`memory_type`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_verified` ON `brain_observations` (`verified`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_valid_at` ON `brain_observations` (`valid_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_invalid` ON `brain_observations` (`invalid_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_source_conf` ON `brain_observations` (`source_confidence`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_tier_promoted_at` ON `brain_observations` (`tier_promoted_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_stability_score` ON `brain_observations` (`stability_score`);--> statement-breakpoint
CREATE INDEX `idx_brain_nodes_quality` ON `brain_page_nodes` (`quality_score`);--> statement-breakpoint
CREATE INDEX `idx_brain_nodes_content_hash` ON `brain_page_nodes` (`content_hash`);--> statement-breakpoint
CREATE INDEX `idx_brain_nodes_last_activity` ON `brain_page_nodes` (`last_activity_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_quality` ON `brain_patterns` (`quality_score`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_tier` ON `brain_patterns` (`memory_tier`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_mem_type` ON `brain_patterns` (`memory_type`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_verified` ON `brain_patterns` (`verified`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_valid_at` ON `brain_patterns` (`valid_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_source_conf` ON `brain_patterns` (`source_confidence`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_tier_promoted_at` ON `brain_patterns` (`tier_promoted_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_content_hash` ON `brain_patterns` (`content_hash`);--> statement-breakpoint
CREATE INDEX `idx_plasticity_source` ON `brain_plasticity_events` (`source_node`);--> statement-breakpoint
CREATE INDEX `idx_plasticity_target` ON `brain_plasticity_events` (`target_node`);--> statement-breakpoint
CREATE INDEX `idx_plasticity_timestamp` ON `brain_plasticity_events` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_plasticity_session` ON `brain_plasticity_events` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_plasticity_kind` ON `brain_plasticity_events` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_plasticity_retrieval_log` ON `brain_plasticity_events` (`retrieval_log_id`);--> statement-breakpoint
CREATE INDEX `idx_plasticity_reward` ON `brain_plasticity_events` (`reward_signal`);--> statement-breakpoint
CREATE INDEX `idx_promotion_log_observation` ON `brain_promotion_log` (`observation_id`);--> statement-breakpoint
CREATE INDEX `idx_promotion_log_decided_at` ON `brain_promotion_log` (`decided_at`);--> statement-breakpoint
CREATE INDEX `idx_promotion_log_to_tier` ON `brain_promotion_log` (`to_tier`);--> statement-breakpoint
CREATE INDEX `idx_promotion_log_score` ON `brain_promotion_log` (`score`);--> statement-breakpoint
CREATE INDEX `idx_retrieval_log_created` ON `brain_retrieval_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_retrieval_log_source` ON `brain_retrieval_log` (`source`);--> statement-breakpoint
CREATE INDEX `idx_retrieval_log_session` ON `brain_retrieval_log` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_retrieval_log_reward` ON `brain_retrieval_log` (`reward_signal`);--> statement-breakpoint
CREATE INDEX `idx_transcript_events_session` ON `brain_transcript_events` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_transcript_events_role` ON `brain_transcript_events` (`role`);--> statement-breakpoint
CREATE INDEX `idx_transcript_events_block_type` ON `brain_transcript_events` (`block_type`);--> statement-breakpoint
CREATE INDEX `idx_transcript_events_created_at` ON `brain_transcript_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_weight_history_edge` ON `brain_weight_history` (`edge_from_id`,`edge_to_id`,`edge_type`);--> statement-breakpoint
CREATE INDEX `idx_weight_history_from` ON `brain_weight_history` (`edge_from_id`);--> statement-breakpoint
CREATE INDEX `idx_weight_history_to` ON `brain_weight_history` (`edge_to_id`);--> statement-breakpoint
CREATE INDEX `idx_weight_history_changed_at` ON `brain_weight_history` (`changed_at`);--> statement-breakpoint
CREATE INDEX `idx_weight_history_event_kind` ON `brain_weight_history` (`event_kind`);--> statement-breakpoint
CREATE INDEX `idx_weight_history_plasticity_event` ON `brain_weight_history` (`source_plasticity_event_id`);