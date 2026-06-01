CREATE TABLE `brain_attention` (
	`id` text PRIMARY KEY,
	`content` text NOT NULL,
	`session_id` text,
	`agent_id` text,
	`scope_kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`tags` blob DEFAULT (jsonb('[]')),
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`expires_at` text,
	`decay_score` real,
	`status` text DEFAULT 'open' NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("scope_kind" IN ('agent', 'task', 'epic', 'saga', 'session', 'global')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("expires_at" IS NULL OR "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("status" IN ('open', 'consolidated', 'discarded'))
);
--> statement-breakpoint
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
	`approved_by` text,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("kind" IN ('observation-promotion', 'transcript-ingest', 'graph-backfill', 'noise-sweep-2440', 'custom')),
	CHECK ("status" IN ('staged', 'approved', 'rolled-back')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("approved_at" IS NULL OR "approved_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `brain_consolidation_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`trigger` text NOT NULL,
	`session_id` text,
	`step_results_json` text NOT NULL,
	`duration_ms` integer,
	`succeeded` integer DEFAULT true NOT NULL,
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("succeeded" IN (0, 1)),
	CHECK ("started_at" IS NULL OR "started_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `brain_decisions` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`decision` text NOT NULL,
	`rationale` text NOT NULL,
	`confidence` text NOT NULL,
	`outcome` text,
	`alternatives_json` text,
	`context_epic_id` text,
	`context_task_id` text,
	`context_phase` text,
	`quality_score` real,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text,
	`memory_tier` text DEFAULT 'medium',
	`memory_type` text DEFAULT 'semantic',
	`verified` integer DEFAULT false NOT NULL,
	`valid_at` text DEFAULT (datetime('now')) NOT NULL,
	`invalid_at` text,
	`source_confidence` text DEFAULT 'agent',
	`citation_count` integer DEFAULT 0 NOT NULL,
	`tier_promoted_at` text,
	`tier_promotion_reason` text,
	`content_hash` text,
	`provenance_class` text DEFAULT 'swept-clean',
	`peer_id` text DEFAULT 'global' NOT NULL,
	`peer_scope` text DEFAULT 'project' NOT NULL,
	`adr_number` integer,
	`adr_path` text,
	`supersedes` text,
	`superseded_by` text,
	`confirmation_state` text DEFAULT 'proposed' NOT NULL,
	`decided_by` text DEFAULT 'agent' NOT NULL,
	`validator_run_at` text,
	`decision_category` text DEFAULT 'architectural' NOT NULL,
	CONSTRAINT `fk_brain_decisions_supersedes_brain_decisions_id_fk` FOREIGN KEY (`supersedes`) REFERENCES `brain_decisions`(`id`),
	CONSTRAINT `fk_brain_decisions_superseded_by_brain_decisions_id_fk` FOREIGN KEY (`superseded_by`) REFERENCES `brain_decisions`(`id`),
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("type" IN ('architecture', 'technical', 'process', 'strategic', 'tactical')),
	CHECK ("confidence" IN ('low', 'medium', 'high')),
	CHECK ("outcome" IN ('success', 'failure', 'mixed', 'pending')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("memory_tier" IN ('short', 'medium', 'long')),
	CHECK ("memory_type" IN ('semantic', 'episodic', 'procedural')),
	CHECK ("verified" IN (0, 1)),
	CHECK ("valid_at" IS NULL OR "valid_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("invalid_at" IS NULL OR "invalid_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("source_confidence" IN ('owner', 'task-outcome', 'agent', 'speculative')),
	CHECK ("tier_promoted_at" IS NULL OR "tier_promoted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("confirmation_state" IN ('proposed', 'accepted', 'superseded')),
	CHECK ("decided_by" IN ('owner', 'council', 'agent')),
	CHECK ("validator_run_at" IS NULL OR "validator_run_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("decision_category" IN ('architectural', 'agent_dispatch', 'other'))
);
--> statement-breakpoint
CREATE TABLE `brain_deriver_queue` (
	`id` text PRIMARY KEY,
	`item_type` text NOT NULL,
	`item_id` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`claimed_at` text,
	`claimed_by` text,
	`error_msg` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`completed_at` text,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("item_type" IN ('observation', 'session', 'narrative', 'embedding')),
	CHECK ("status" IN ('pending', 'in_progress', 'done', 'failed')),
	CHECK ("claimed_at" IS NULL OR "claimed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("completed_at" IS NULL OR "completed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `brain_learnings` (
	`id` text PRIMARY KEY,
	`insight` text NOT NULL,
	`source` text NOT NULL,
	`confidence` real NOT NULL,
	`actionable` integer DEFAULT false NOT NULL,
	`application` text,
	`applicable_types_json` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text,
	`quality_score` real,
	`memory_tier` text DEFAULT 'short',
	`memory_type` text DEFAULT 'semantic',
	`verified` integer DEFAULT false NOT NULL,
	`valid_at` text DEFAULT (datetime('now')) NOT NULL,
	`invalid_at` text,
	`source_confidence` text DEFAULT 'agent',
	`citation_count` integer DEFAULT 0 NOT NULL,
	`tier_promoted_at` text,
	`tier_promotion_reason` text,
	`content_hash` text,
	`provenance_class` text DEFAULT 'swept-clean',
	`peer_id` text DEFAULT 'global' NOT NULL,
	`peer_scope` text DEFAULT 'project' NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("actionable" IN (0, 1)),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("memory_tier" IN ('short', 'medium', 'long')),
	CHECK ("memory_type" IN ('semantic', 'episodic', 'procedural')),
	CHECK ("verified" IN (0, 1)),
	CHECK ("valid_at" IS NULL OR "valid_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("invalid_at" IS NULL OR "invalid_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("source_confidence" IN ('owner', 'task-outcome', 'agent', 'speculative')),
	CHECK ("tier_promoted_at" IS NULL OR "tier_promoted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `brain_memory_links` (
	`memory_type` text NOT NULL,
	`memory_id` text NOT NULL,
	`task_id` text NOT NULL,
	`link_type` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `brain_memory_links_pk` PRIMARY KEY(`memory_type`, `memory_id`, `task_id`, `link_type`),
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("memory_type" IN ('decision', 'pattern', 'learning', 'observation')),
	CHECK ("link_type" IN ('produced_by', 'applies_to', 'informed_by', 'contradicts')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `brain_memory_trees` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`depth` integer DEFAULT 0 NOT NULL,
	`leaf_ids` text DEFAULT '[]' NOT NULL,
	`centroid` text,
	`parent_id` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
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
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `brain_observations` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text,
	`narrative` text,
	`facts_json` text,
	`concepts_json` text,
	`project` text,
	`files_read_json` text,
	`files_modified_json` text,
	`source_session_id` text,
	`source_type` text DEFAULT 'agent' NOT NULL,
	`agent` text,
	`content_hash` text,
	`discovery_tokens` integer,
	`quality_score` real,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text,
	`memory_tier` text DEFAULT 'short',
	`memory_type` text DEFAULT 'episodic',
	`verified` integer DEFAULT false NOT NULL,
	`valid_at` text DEFAULT (datetime('now')) NOT NULL,
	`invalid_at` text,
	`source_confidence` text DEFAULT 'agent',
	`citation_count` integer DEFAULT 0 NOT NULL,
	`tier_promoted_at` text,
	`tier_promotion_reason` text,
	`attachments_json` text,
	`stability_score` real DEFAULT 0.5,
	`provenance_class` text DEFAULT 'swept-clean',
	`peer_id` text DEFAULT 'global' NOT NULL,
	`peer_scope` text DEFAULT 'project' NOT NULL,
	`source_ids` text,
	`times_derived` integer DEFAULT 1,
	`level` text DEFAULT 'explicit',
	`tree_id` integer,
	`origin` text,
	`validated_at` text,
	`provenance_chain` text,
	`idempotency_key` text CONSTRAINT `uq_brain_observations_idempotency_key` UNIQUE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("type" IN ('discovery', 'change', 'feature', 'bugfix', 'decision', 'refactor', 'diary', 'session-summary')),
	CHECK ("source_type" IN ('agent', 'session-debrief', 'claude-mem', 'manual')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("memory_tier" IN ('short', 'medium', 'long')),
	CHECK ("memory_type" IN ('semantic', 'episodic', 'procedural')),
	CHECK ("verified" IN (0, 1)),
	CHECK ("valid_at" IS NULL OR "valid_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("invalid_at" IS NULL OR "invalid_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("source_confidence" IN ('owner', 'task-outcome', 'agent', 'speculative')),
	CHECK ("tier_promoted_at" IS NULL OR "tier_promoted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("validated_at" IS NULL OR "validated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `brain_observations_staging` (
	`id` text PRIMARY KEY,
	`source_table` text NOT NULL,
	`source_id` text NOT NULL,
	`sweep_run_id` text NOT NULL,
	`action` text NOT NULL,
	`new_quality_score` real,
	`new_invalid_at` text,
	`new_provenance_class` text,
	`validation_status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("action" IN ('purge', 'keep', 'reclassify', 'promote')),
	CHECK ("new_invalid_at" IS NULL OR "new_invalid_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("validation_status" IN ('pending', 'applied', 'skipped')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `brain_page_edges` (
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
	CONSTRAINT `brain_page_edges_pk` PRIMARY KEY(`from_id`, `to_id`, `edge_type`),
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("edge_type" IN ('derived_from', 'produced_by', 'informed_by', 'supports', 'contradicts', 'supersedes', 'applies_to', 'documents', 'summarizes', 'part_of', 'references', 'modified_by', 'code_reference', 'affects', 'mentions', 'conduit_mentions_symbol', 'co_retrieved', 'blocks', 'discusses', 'cites', 'embeds', 'touches_code', 'task_touches_symbol')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("last_reinforced_at" IS NULL OR "last_reinforced_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("plasticity_class" IN ('static', 'hebbian', 'stdp')),
	CHECK ("last_depressed_at" IS NULL OR "last_depressed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `brain_page_nodes` (
	`id` text PRIMARY KEY,
	`node_type` text NOT NULL,
	`label` text NOT NULL,
	`quality_score` real DEFAULT 0.5 NOT NULL,
	`content_hash` text,
	`last_activity_at` text DEFAULT (datetime('now')) NOT NULL,
	`metadata_json` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("node_type" IN ('decision', 'pattern', 'learning', 'observation', 'sticky', 'task', 'session', 'epic', 'file', 'symbol', 'concept', 'summary', 'msg', 'llmtxt', 'commit')),
	CHECK ("last_activity_at" IS NULL OR "last_activity_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `brain_patterns` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`pattern` text NOT NULL,
	`context` text NOT NULL,
	`frequency` integer DEFAULT 1 NOT NULL,
	`success_rate` real,
	`impact` text,
	`anti_pattern` text,
	`mitigation` text,
	`examples_json` text DEFAULT '[]',
	`extracted_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text,
	`quality_score` real,
	`memory_tier` text DEFAULT 'medium',
	`memory_type` text DEFAULT 'procedural',
	`verified` integer DEFAULT false NOT NULL,
	`valid_at` text DEFAULT (datetime('now')) NOT NULL,
	`invalid_at` text,
	`source_confidence` text DEFAULT 'agent',
	`citation_count` integer DEFAULT 0 NOT NULL,
	`tier_promoted_at` text,
	`tier_promotion_reason` text,
	`content_hash` text,
	`provenance_class` text DEFAULT 'swept-clean',
	`peer_id` text DEFAULT 'global' NOT NULL,
	`peer_scope` text DEFAULT 'project' NOT NULL,
	`occurrence_count` integer DEFAULT 1 NOT NULL,
	`last_seen_at` text,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("type" IN ('workflow', 'blocker', 'success', 'failure', 'optimization')),
	CHECK ("impact" IN ('low', 'medium', 'high')),
	CHECK ("extracted_at" IS NULL OR "extracted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("memory_tier" IN ('short', 'medium', 'long')),
	CHECK ("memory_type" IN ('semantic', 'episodic', 'procedural')),
	CHECK ("verified" IN (0, 1)),
	CHECK ("valid_at" IS NULL OR "valid_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("invalid_at" IS NULL OR "invalid_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("source_confidence" IN ('owner', 'task-outcome', 'agent', 'speculative')),
	CHECK ("tier_promoted_at" IS NULL OR "tier_promoted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("last_seen_at" IS NULL OR "last_seen_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
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
	`delta_t_ms` integer,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("kind" IN ('ltp', 'ltd'))
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
	`rationale_json` text,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("decided_at" IS NULL OR "decided_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
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
	`reward_signal` real,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `brain_schema_meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `brain_session_narrative` (
	`session_id` text PRIMARY KEY,
	`narrative` text DEFAULT '' NOT NULL,
	`turn_count` integer DEFAULT 0 NOT NULL,
	`last_updated_at` text,
	`pivot_count` integer DEFAULT 0 NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("last_updated_at" IS NULL OR "last_updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `brain_sticky_notes` (
	`id` text PRIMARY KEY,
	`content` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text,
	`tags_json` text,
	`status` text DEFAULT 'active' NOT NULL,
	`converted_to_json` text,
	`color` text,
	`priority` text,
	`source_type` text DEFAULT 'sticky-note',
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("status" IN ('active', 'converted', 'archived')),
	CHECK ("color" IN ('yellow', 'blue', 'green', 'red', 'purple')),
	CHECK ("priority" IN ('low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE TABLE `brain_sticky_tags` (
	`sticky_id` text NOT NULL,
	`tag` text NOT NULL,
	CONSTRAINT `brain_sticky_tags_pk` PRIMARY KEY(`sticky_id`, `tag`),
	CONSTRAINT `fk_brain_sticky_tags_sticky_id_brain_sticky_notes_id_fk` FOREIGN KEY (`sticky_id`) REFERENCES `brain_sticky_notes`(`id`) ON DELETE CASCADE
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
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("role" IN ('user', 'assistant', 'system')),
	CHECK ("redacted_at" IS NULL OR "redacted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
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
	`changed_at` text DEFAULT (datetime('now')) NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("changed_at" IS NULL OR "changed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `nexus_audit_log` (
	`id` text PRIMARY KEY,
	`timestamp` text DEFAULT (datetime('now')) NOT NULL,
	`action` text NOT NULL,
	`project_hash` text,
	`project_id` text,
	`domain` text,
	`operation` text,
	`session_id` text,
	`request_id` text,
	`source` text,
	`gateway` text,
	`success` integer,
	`duration_ms` integer,
	`details_json` text DEFAULT '{}',
	`error_message` text
);
--> statement-breakpoint
CREATE TABLE `nexus_code_index` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`file_path` text NOT NULL,
	`symbol_name` text NOT NULL,
	`kind` text NOT NULL,
	`start_line` integer NOT NULL,
	`end_line` integer NOT NULL,
	`language` text NOT NULL,
	`exported` integer DEFAULT false,
	`parent` text,
	`return_type` text,
	`doc_summary` text,
	`indexed_at` text NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("kind" IN ('function', 'method', 'class', 'interface', 'type', 'enum', 'variable', 'constant', 'module', 'import', 'export', 'struct', 'trait', 'impl')),
	CHECK ("exported" IN (0, 1)),
	CHECK ("indexed_at" IS NULL OR "indexed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `nexus_contracts` (
	`contract_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`type` text NOT NULL,
	`path` text NOT NULL,
	`method` text,
	`request_schema_json` text DEFAULT '{}' NOT NULL,
	`response_schema_json` text DEFAULT '{}' NOT NULL,
	`source_symbol_id` text,
	`route_node_id` text,
	`confidence` real DEFAULT 1 NOT NULL,
	`description` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("type" IN ('http', 'grpc', 'topic')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `nexus_nodes` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`name` text,
	`file_path` text,
	`start_line` integer,
	`end_line` integer,
	`language` text,
	`is_exported` integer DEFAULT false NOT NULL,
	`parent_id` text,
	`parameters_json` text,
	`return_type` text,
	`doc_summary` text,
	`community_id` text,
	`meta_json` text,
	`is_external` integer DEFAULT false NOT NULL,
	`indexed_at` text DEFAULT (datetime('now')) NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("kind" IN ('file', 'folder', 'module', 'namespace', 'function', 'method', 'constructor', 'class', 'interface', 'struct', 'trait', 'impl', 'type_alias', 'enum', 'property', 'constant', 'variable', 'static', 'record', 'delegate', 'macro', 'union', 'typedef', 'annotation', 'template', 'community', 'process', 'route', 'tool', 'section', 'import', 'export', 'type')),
	CHECK ("is_exported" IN (0, 1)),
	CHECK ("is_external" IN (0, 1)),
	CHECK ("indexed_at" IS NULL OR "indexed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `nexus_project_id_aliases` (
	`legacy_id` text PRIMARY KEY,
	`canonical_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `nexus_project_registry` (
	`project_id` text PRIMARY KEY,
	`project_hash` text NOT NULL,
	`project_path` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`registered_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_seen` text DEFAULT (datetime('now')) NOT NULL,
	`health_status` text DEFAULT 'unknown' NOT NULL,
	`health_last_check` text,
	`permissions` text DEFAULT 'read' NOT NULL,
	`last_sync` text DEFAULT (datetime('now')) NOT NULL,
	`task_count` integer DEFAULT 0 NOT NULL,
	`labels_json` text DEFAULT '[]' NOT NULL,
	`brain_db_path` text,
	`tasks_db_path` text,
	`last_indexed` text,
	`stats_json` text DEFAULT '{}' NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("registered_at" IS NULL OR "registered_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `nexus_relations` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`type` text NOT NULL,
	`confidence` real NOT NULL,
	`reason` text,
	`step` integer,
	`indexed_at` text DEFAULT (datetime('now')) NOT NULL,
	`weight` real DEFAULT 0,
	`last_accessed_at` text,
	`co_accessed_count` integer DEFAULT 0,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("type" IN ('contains', 'defines', 'imports', 'accesses', 'calls', 'extends', 'implements', 'method_overrides', 'method_implements', 'has_method', 'has_property', 'member_of', 'step_in_process', 'handles_route', 'fetches', 'handles_tool', 'entry_point_of', 'wraps', 'queries', 'documents', 'applies_to', 'co_changed', 'co_cited_in_task')),
	CHECK ("indexed_at" IS NULL OR "indexed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("last_accessed_at" IS NULL OR "last_accessed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `nexus_schema_meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `nexus_sigils` (
	`peer_id` text PRIMARY KEY,
	`cant_file` text,
	`display_name` text DEFAULT '' NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	`system_prompt_fragment` text,
	`capability_flags` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("role" IN ('', 'orchestrator', 'lead', 'worker', 'subagent', 'specialist', 'validator')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `nexus_user_profile` (
	`trait_key` text PRIMARY KEY,
	`trait_value` text NOT NULL,
	`confidence` real NOT NULL,
	`source` text NOT NULL,
	`derived_from_message_id` text,
	`first_observed_at` text NOT NULL,
	`last_reinforced_at` text NOT NULL,
	`reinforcement_count` integer DEFAULT 1 NOT NULL,
	`superseded_by` text,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("first_observed_at" IS NULL OR "first_observed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("last_reinforced_at" IS NULL OR "last_reinforced_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `signaldock_accounts` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` text,
	`refresh_token_expires_at` text,
	`scope` text,
	`password` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_signaldock_accounts_user_id_signaldock_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `signaldock_users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `idx_signaldock_accounts_provider` UNIQUE(`provider_id`,`account_id`),
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("access_token_expires_at" IS NULL OR "access_token_expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("refresh_token_expires_at" IS NULL OR "refresh_token_expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `signaldock_agent_capabilities` (
	`agent_id` text NOT NULL,
	`capability_id` text NOT NULL,
	CONSTRAINT `signaldock_agent_capabilities_pk` PRIMARY KEY(`agent_id`, `capability_id`),
	CONSTRAINT `fk_signaldock_agent_capabilities_agent_id_signaldock_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `signaldock_agents`(`id`),
	CONSTRAINT `fk_signaldock_agent_capabilities_capability_id_signaldock_capabilities_id_fk` FOREIGN KEY (`capability_id`) REFERENCES `signaldock_capabilities`(`id`)
);
--> statement-breakpoint
CREATE TABLE `signaldock_agent_connections` (
	`id` text PRIMARY KEY,
	`agent_id` text NOT NULL,
	`transport_type` text DEFAULT 'http' NOT NULL,
	`connection_id` text,
	`connected_at` text NOT NULL,
	`last_heartbeat` integer NOT NULL,
	`connection_metadata` text,
	`created_at` text NOT NULL,
	CONSTRAINT `signaldock_agent_connections_agent_id_connection_id_unique` UNIQUE(`agent_id`,`connection_id`),
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("connected_at" IS NULL OR "connected_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `signaldock_agent_skills` (
	`agent_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`attached_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `signaldock_agent_skills_pk` PRIMARY KEY(`agent_id`, `skill_id`),
	CONSTRAINT `fk_signaldock_agent_skills_agent_id_signaldock_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `signaldock_agents`(`id`),
	CONSTRAINT `fk_signaldock_agent_skills_skill_id_signaldock_skills_id_fk` FOREIGN KEY (`skill_id`) REFERENCES `signaldock_skills`(`id`),
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("attached_at" IS NULL OR "attached_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `signaldock_agents` (
	`id` text PRIMARY KEY,
	`agent_id` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`description` text,
	`class` text DEFAULT 'custom' NOT NULL,
	`privacy_tier` text DEFAULT 'public' NOT NULL,
	`owner_id` text,
	`endpoint` text,
	`webhook_secret` text,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`skills` text DEFAULT '[]' NOT NULL,
	`avatar` text,
	`messages_sent` integer DEFAULT 0 NOT NULL,
	`messages_received` integer DEFAULT 0 NOT NULL,
	`conversation_count` integer DEFAULT 0 NOT NULL,
	`friend_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'online' NOT NULL,
	`last_seen` integer,
	`payment_config` text,
	`api_key_hash` text,
	`organization_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`transport_type` text DEFAULT 'http' NOT NULL,
	`api_key_encrypted` text,
	`api_base_url` text DEFAULT 'https://api.signaldock.io' NOT NULL,
	`classification` text,
	`transport_config` text DEFAULT '{}' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`last_used_at` text,
	`requires_reauth` integer DEFAULT 0 NOT NULL,
	`tier` text DEFAULT 'global' NOT NULL,
	`can_spawn` integer DEFAULT 0 NOT NULL,
	`orch_level` integer DEFAULT 2 NOT NULL,
	`reports_to` text,
	`cant_path` text,
	`cant_sha256` text,
	`installed_from` text,
	`installed_at` text,
	CONSTRAINT `fk_signaldock_agents_owner_id_signaldock_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `signaldock_users`(`id`),
	CONSTRAINT `fk_signaldock_agents_organization_id_signaldock_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `signaldock_organization`(`id`) ON DELETE SET NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("status" IN ('online', 'offline', 'busy', 'away')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("is_active" IN (0, 1)),
	CHECK ("last_used_at" IS NULL OR "last_used_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("installed_at" IS NULL OR "installed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `signaldock_capabilities` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`category` text NOT NULL,
	`created_at` text NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `signaldock_claim_codes` (
	`id` text PRIMARY KEY,
	`agent_id` text NOT NULL,
	`code` text NOT NULL UNIQUE,
	`expires_at` text NOT NULL,
	`used_at` text,
	`used_by` text,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_signaldock_claim_codes_agent_id_signaldock_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `signaldock_agents`(`id`),
	CONSTRAINT `fk_signaldock_claim_codes_used_by_signaldock_users_id_fk` FOREIGN KEY (`used_by`) REFERENCES `signaldock_users`(`id`),
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("expires_at" IS NULL OR "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("used_at" IS NULL OR "used_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `signaldock_org_agent_keys` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_signaldock_org_agent_keys_organization_id_signaldock_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `signaldock_organization`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_signaldock_org_agent_keys_agent_id_signaldock_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `signaldock_agents`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `signaldock_organization` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`slug` text,
	`logo` text,
	`metadata` text,
	`owner_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `signaldock_sessions` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`token` text NOT NULL UNIQUE,
	`ip_address` text,
	`user_agent` text,
	`expires_at` text NOT NULL,
	`active_organization_id` text,
	`impersonated_by` text,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_signaldock_sessions_user_id_signaldock_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `signaldock_users`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("expires_at" IS NULL OR "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `signaldock_skills` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`category` text NOT NULL,
	`created_at` text NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `signaldock_users` (
	`id` text PRIMARY KEY,
	`email` text NOT NULL UNIQUE,
	`password_hash` text NOT NULL,
	`name` text,
	`slug` text,
	`default_agent_id` text,
	`username` text,
	`display_username` text,
	`email_verified` integer DEFAULT 0 NOT NULL,
	`image` text,
	`role` text DEFAULT 'user' NOT NULL,
	`banned` integer DEFAULT 0 NOT NULL,
	`ban_reason` text,
	`ban_expires` text,
	`two_factor_enabled` integer DEFAULT 0 NOT NULL,
	`metadata` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("role" IN ('user', 'admin')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `signaldock_verifications` (
	`id` text PRIMARY KEY,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("expires_at" IS NULL OR "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `skills_skill_patches` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`skill_name` text NOT NULL,
	`proposed_at` text DEFAULT (datetime('now')) NOT NULL,
	`applied_at` text,
	`review_id` integer,
	`diff` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`reverted_by_patch_id` integer,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("proposed_at" IS NULL OR "proposed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("applied_at" IS NULL OR "applied_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("status" IN ('proposed', 'applied', 'reverted', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE `skills_skill_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`skill_name` text NOT NULL,
	`reviewed_at` text DEFAULT (datetime('now')) NOT NULL,
	`outcome` text NOT NULL,
	`score` integer,
	`review_run_id` text,
	`summary` text,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("reviewed_at" IS NULL OR "reviewed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("outcome" IN ('approved', 'rejected', 'needs-changes'))
);
--> statement-breakpoint
CREATE TABLE `skills_skill_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`skill_name` text NOT NULL,
	`observed_at` text DEFAULT (datetime('now')) NOT NULL,
	`event_kind` text NOT NULL,
	`task_id` text,
	`model_id` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("observed_at" IS NULL OR "observed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `skills_skills` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL UNIQUE,
	`version` text,
	`source_type` text NOT NULL,
	`source_url` text,
	`install_path` text NOT NULL,
	`canonical_path` text,
	`installed_at` text NOT NULL,
	`last_updated_at` text,
	`lifecycle_state` text DEFAULT 'active' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`is_agent_created` integer DEFAULT false NOT NULL,
	`archived_at` text,
	`archived_from_path` text,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("source_type" IN ('canonical', 'user', 'community', 'agent-created')),
	CHECK ("installed_at" IS NULL OR "installed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("last_updated_at" IS NULL OR "last_updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("lifecycle_state" IN ('active', 'stale', 'archived')),
	CHECK ("pinned" IN (0, 1)),
	CHECK ("is_agent_created" IN (0, 1)),
	CHECK ("archived_at" IS NULL OR "archived_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `telemetry_events` (
	`id` text PRIMARY KEY,
	`anonymous_id` text NOT NULL,
	`domain` text NOT NULL,
	`gateway` text NOT NULL,
	`operation` text NOT NULL,
	`command` text NOT NULL,
	`exit_code` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer NOT NULL,
	`error_code` text,
	`timestamp` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `telemetry_schema_meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_brain_attention_scope` ON `brain_attention` (`scope_kind`,`scope_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_attention_session` ON `brain_attention` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_attention_status_expires` ON `brain_attention` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_backfill_runs_status` ON `brain_backfill_runs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_backfill_runs_kind` ON `brain_backfill_runs` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_backfill_runs_created_at` ON `brain_backfill_runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_consolidation_events_started_at` ON `brain_consolidation_events` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_consolidation_events_trigger` ON `brain_consolidation_events` (`trigger`);--> statement-breakpoint
CREATE INDEX `idx_consolidation_events_session` ON `brain_consolidation_events` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_type` ON `brain_decisions` (`type`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_confidence` ON `brain_decisions` (`confidence`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_outcome` ON `brain_decisions` (`outcome`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_context_epic` ON `brain_decisions` (`context_epic_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_context_task` ON `brain_decisions` (`context_task_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_quality` ON `brain_decisions` (`quality_score`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_tier` ON `brain_decisions` (`memory_tier`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_mem_type` ON `brain_decisions` (`memory_type`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_verified` ON `brain_decisions` (`verified`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_valid_at` ON `brain_decisions` (`valid_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_source_conf` ON `brain_decisions` (`source_confidence`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_tier_promoted_at` ON `brain_decisions` (`tier_promoted_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_content_hash` ON `brain_decisions` (`content_hash`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_peer_scope` ON `brain_decisions` (`peer_id`,`peer_scope`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_adr_number` ON `brain_decisions` (`adr_number`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_confirmation_state` ON `brain_decisions` (`confirmation_state`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_decided_by` ON `brain_decisions` (`decided_by`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_decision_category` ON `brain_decisions` (`decision_category`);--> statement-breakpoint
CREATE INDEX `idx_brain_deriver_queue_status_priority` ON `brain_deriver_queue` (`status`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_deriver_queue_item` ON `brain_deriver_queue` (`item_type`,`item_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_deriver_queue_claimed_at` ON `brain_deriver_queue` (`claimed_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_confidence` ON `brain_learnings` (`confidence`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_actionable` ON `brain_learnings` (`actionable`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_quality` ON `brain_learnings` (`quality_score`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_tier` ON `brain_learnings` (`memory_tier`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_mem_type` ON `brain_learnings` (`memory_type`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_verified` ON `brain_learnings` (`verified`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_valid_at` ON `brain_learnings` (`valid_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_invalid` ON `brain_learnings` (`invalid_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_source_conf` ON `brain_learnings` (`source_confidence`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_tier_promoted_at` ON `brain_learnings` (`tier_promoted_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_content_hash` ON `brain_learnings` (`content_hash`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_peer_scope` ON `brain_learnings` (`peer_id`,`peer_scope`);--> statement-breakpoint
CREATE INDEX `idx_brain_links_task` ON `brain_memory_links` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_links_memory` ON `brain_memory_links` (`memory_type`,`memory_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_trees_parent` ON `brain_memory_trees` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_trees_depth` ON `brain_memory_trees` (`depth`);--> statement-breakpoint
CREATE INDEX `idx_modulators_type` ON `brain_modulators` (`modulator_type`);--> statement-breakpoint
CREATE INDEX `idx_modulators_session` ON `brain_modulators` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_modulators_created_at` ON `brain_modulators` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_modulators_source_event` ON `brain_modulators` (`source_event_id`);--> statement-breakpoint
CREATE INDEX `idx_modulators_valence` ON `brain_modulators` (`valence`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_type` ON `brain_observations` (`type`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_project` ON `brain_observations` (`project`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_created_at` ON `brain_observations` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_source_type` ON `brain_observations` (`source_type`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_source_session` ON `brain_observations` (`source_session_id`);--> statement-breakpoint
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
CREATE INDEX `idx_brain_observations_peer_scope` ON `brain_observations` (`peer_id`,`peer_scope`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_level` ON `brain_observations` (`level`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_tree_id` ON `brain_observations` (`tree_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_origin` ON `brain_observations` (`origin`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_validated_at` ON `brain_observations` (`validated_at`);--> statement-breakpoint
CREATE INDEX `idx_bos_sweep_run` ON `brain_observations_staging` (`sweep_run_id`);--> statement-breakpoint
CREATE INDEX `idx_bos_source` ON `brain_observations_staging` (`source_table`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_bos_status` ON `brain_observations_staging` (`validation_status`);--> statement-breakpoint
CREATE INDEX `idx_brain_edges_from` ON `brain_page_edges` (`from_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_edges_to` ON `brain_page_edges` (`to_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_edges_type` ON `brain_page_edges` (`edge_type`);--> statement-breakpoint
CREATE INDEX `idx_brain_edges_last_reinforced` ON `brain_page_edges` (`last_reinforced_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_edges_plasticity_class` ON `brain_page_edges` (`plasticity_class`);--> statement-breakpoint
CREATE INDEX `idx_brain_edges_stability` ON `brain_page_edges` (`stability_score`);--> statement-breakpoint
CREATE INDEX `idx_brain_nodes_type` ON `brain_page_nodes` (`node_type`);--> statement-breakpoint
CREATE INDEX `idx_brain_nodes_quality` ON `brain_page_nodes` (`quality_score`);--> statement-breakpoint
CREATE INDEX `idx_brain_nodes_content_hash` ON `brain_page_nodes` (`content_hash`);--> statement-breakpoint
CREATE INDEX `idx_brain_nodes_last_activity` ON `brain_page_nodes` (`last_activity_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_type` ON `brain_patterns` (`type`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_impact` ON `brain_patterns` (`impact`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_frequency` ON `brain_patterns` (`frequency`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_quality` ON `brain_patterns` (`quality_score`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_occurrence_count` ON `brain_patterns` (`occurrence_count`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_last_seen_at` ON `brain_patterns` (`last_seen_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_tier` ON `brain_patterns` (`memory_tier`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_mem_type` ON `brain_patterns` (`memory_type`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_verified` ON `brain_patterns` (`verified`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_valid_at` ON `brain_patterns` (`valid_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_source_conf` ON `brain_patterns` (`source_confidence`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_tier_promoted_at` ON `brain_patterns` (`tier_promoted_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_content_hash` ON `brain_patterns` (`content_hash`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_peer_scope` ON `brain_patterns` (`peer_id`,`peer_scope`);--> statement-breakpoint
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
CREATE INDEX `idx_brain_sticky_status` ON `brain_sticky_notes` (`status`);--> statement-breakpoint
CREATE INDEX `idx_brain_sticky_created` ON `brain_sticky_notes` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_sticky_tags` ON `brain_sticky_notes` (`tags_json`);--> statement-breakpoint
CREATE INDEX `idx_brain_sticky_tags_tag` ON `brain_sticky_tags` (`tag`);--> statement-breakpoint
CREATE INDEX `idx_transcript_events_session` ON `brain_transcript_events` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_transcript_events_role` ON `brain_transcript_events` (`role`);--> statement-breakpoint
CREATE INDEX `idx_transcript_events_block_type` ON `brain_transcript_events` (`block_type`);--> statement-breakpoint
CREATE INDEX `idx_transcript_events_created_at` ON `brain_transcript_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_weight_history_edge` ON `brain_weight_history` (`edge_from_id`,`edge_to_id`,`edge_type`);--> statement-breakpoint
CREATE INDEX `idx_weight_history_from` ON `brain_weight_history` (`edge_from_id`);--> statement-breakpoint
CREATE INDEX `idx_weight_history_to` ON `brain_weight_history` (`edge_to_id`);--> statement-breakpoint
CREATE INDEX `idx_weight_history_changed_at` ON `brain_weight_history` (`changed_at`);--> statement-breakpoint
CREATE INDEX `idx_weight_history_event_kind` ON `brain_weight_history` (`event_kind`);--> statement-breakpoint
CREATE INDEX `idx_weight_history_plasticity_event` ON `brain_weight_history` (`source_plasticity_event_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_audit_timestamp` ON `nexus_audit_log` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_nexus_audit_action` ON `nexus_audit_log` (`action`);--> statement-breakpoint
CREATE INDEX `idx_nexus_audit_project_hash` ON `nexus_audit_log` (`project_hash`);--> statement-breakpoint
CREATE INDEX `idx_nexus_audit_project_id` ON `nexus_audit_log` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_audit_session` ON `nexus_audit_log` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_code_index_project` ON `nexus_code_index` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_code_index_file` ON `nexus_code_index` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_nexus_code_index_symbol` ON `nexus_code_index` (`symbol_name`);--> statement-breakpoint
CREATE INDEX `idx_nexus_code_index_kind` ON `nexus_code_index` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_nexus_contracts_project` ON `nexus_contracts` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_contracts_type` ON `nexus_contracts` (`type`);--> statement-breakpoint
CREATE INDEX `idx_nexus_contracts_path` ON `nexus_contracts` (`path`);--> statement-breakpoint
CREATE INDEX `idx_nexus_contracts_method` ON `nexus_contracts` (`method`);--> statement-breakpoint
CREATE INDEX `idx_nexus_contracts_project_type` ON `nexus_contracts` (`project_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_nexus_contracts_source_symbol` ON `nexus_contracts` (`source_symbol_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_contracts_created` ON `nexus_contracts` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_project` ON `nexus_nodes` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_kind` ON `nexus_nodes` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_file` ON `nexus_nodes` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_name` ON `nexus_nodes` (`name`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_project_kind` ON `nexus_nodes` (`project_id`,`kind`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_project_file` ON `nexus_nodes` (`project_id`,`file_path`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_community` ON `nexus_nodes` (`community_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_parent` ON `nexus_nodes` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_exported` ON `nexus_nodes` (`is_exported`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_is_external` ON `nexus_nodes` (`is_external`);--> statement-breakpoint
CREATE INDEX `idx_nexus_project_id_aliases_canonical` ON `nexus_project_id_aliases` (`canonical_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_project_registry_hash` ON `nexus_project_registry` (`project_hash`);--> statement-breakpoint
CREATE INDEX `idx_nexus_project_registry_health` ON `nexus_project_registry` (`health_status`);--> statement-breakpoint
CREATE INDEX `idx_nexus_project_registry_name` ON `nexus_project_registry` (`name`);--> statement-breakpoint
CREATE INDEX `idx_nexus_project_registry_last_indexed` ON `nexus_project_registry` (`last_indexed`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_project` ON `nexus_relations` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_source` ON `nexus_relations` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_target` ON `nexus_relations` (`target_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_type` ON `nexus_relations` (`type`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_project_type` ON `nexus_relations` (`project_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_source_type` ON `nexus_relations` (`source_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_target_type` ON `nexus_relations` (`target_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_confidence` ON `nexus_relations` (`confidence`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_last_accessed` ON `nexus_relations` (`last_accessed_at`);--> statement-breakpoint
CREATE INDEX `idx_nexus_sigils_display_name` ON `nexus_sigils` (`display_name`);--> statement-breakpoint
CREATE INDEX `idx_nexus_sigils_role` ON `nexus_sigils` (`role`);--> statement-breakpoint
CREATE INDEX `idx_nexus_user_profile_confidence` ON `nexus_user_profile` (`confidence`);--> statement-breakpoint
CREATE INDEX `idx_nexus_user_profile_source` ON `nexus_user_profile` (`source`);--> statement-breakpoint
CREATE INDEX `idx_nexus_user_profile_last_reinforced` ON `nexus_user_profile` (`last_reinforced_at`);--> statement-breakpoint
CREATE INDEX `idx_nexus_user_profile_superseded` ON `nexus_user_profile` (`superseded_by`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_accounts_user_id` ON `signaldock_accounts` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_agent_connections_agent` ON `signaldock_agent_connections` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_agent_connections_transport` ON `signaldock_agent_connections` (`transport_type`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_agent_connections_heartbeat` ON `signaldock_agent_connections` (`last_heartbeat`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_agent_skills_source` ON `signaldock_agent_skills` (`source`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_agents_owner` ON `signaldock_agents` (`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_agents_class` ON `signaldock_agents` (`class`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_agents_privacy` ON `signaldock_agents` (`privacy_tier`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_agents_org` ON `signaldock_agents` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_agents_transport_type` ON `signaldock_agents` (`transport_type`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_agents_is_active` ON `signaldock_agents` (`is_active`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_agents_last_used` ON `signaldock_agents` (`last_used_at`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_agents_tier` ON `signaldock_agents` (`tier`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_agents_cant_path` ON `signaldock_agents` (`cant_path`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_claim_codes_agent` ON `signaldock_claim_codes` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_org_agent_keys_org` ON `signaldock_org_agent_keys` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_org_agent_keys_agent` ON `signaldock_org_agent_keys` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_organization_slug` ON `signaldock_organization` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_sessions_user_id` ON `signaldock_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_users_slug` ON `signaldock_users` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_signaldock_verifications_identifier` ON `signaldock_verifications` (`identifier`);--> statement-breakpoint
CREATE INDEX `idx_skills_skill_patches_name_proposed` ON `skills_skill_patches` (`skill_name`,`proposed_at`);--> statement-breakpoint
CREATE INDEX `idx_skills_skill_patches_status` ON `skills_skill_patches` (`status`);--> statement-breakpoint
CREATE INDEX `idx_skills_skill_reviews_name_reviewed` ON `skills_skill_reviews` (`skill_name`,`reviewed_at`);--> statement-breakpoint
CREATE INDEX `idx_skills_skill_reviews_outcome` ON `skills_skill_reviews` (`outcome`);--> statement-breakpoint
CREATE INDEX `idx_skills_skill_usage_name_observed` ON `skills_skill_usage` (`skill_name`,`observed_at`);--> statement-breakpoint
CREATE INDEX `idx_skills_skill_usage_kind` ON `skills_skill_usage` (`event_kind`);--> statement-breakpoint
CREATE INDEX `idx_skills_skills_state` ON `skills_skills` (`lifecycle_state`);--> statement-breakpoint
CREATE INDEX `idx_skills_skills_source` ON `skills_skills` (`source_type`);--> statement-breakpoint
CREATE INDEX `idx_telemetry_command` ON `telemetry_events` (`command`);--> statement-breakpoint
CREATE INDEX `idx_telemetry_domain` ON `telemetry_events` (`domain`);--> statement-breakpoint
CREATE INDEX `idx_telemetry_exit_code` ON `telemetry_events` (`exit_code`);--> statement-breakpoint
CREATE INDEX `idx_telemetry_timestamp` ON `telemetry_events` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_telemetry_duration` ON `telemetry_events` (`duration_ms`);