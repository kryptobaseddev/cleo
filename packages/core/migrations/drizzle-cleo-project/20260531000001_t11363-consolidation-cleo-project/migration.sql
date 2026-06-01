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
CREATE TABLE `tasks_adr_relations` (
	`from_adr_id` text NOT NULL,
	`to_adr_id` text NOT NULL,
	`relation_type` text NOT NULL,
	CONSTRAINT `tasks_adr_relations_pk` PRIMARY KEY(`from_adr_id`, `to_adr_id`, `relation_type`),
	CONSTRAINT `fk_tasks_adr_relations_from_adr_id_tasks_architecture_decisions_id_fk` FOREIGN KEY (`from_adr_id`) REFERENCES `tasks_architecture_decisions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tasks_adr_relations_to_adr_id_tasks_architecture_decisions_id_fk` FOREIGN KEY (`to_adr_id`) REFERENCES `tasks_architecture_decisions`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("relation_type" IN ('supersedes', 'amends', 'related'))
);
--> statement-breakpoint
CREATE TABLE `tasks_adr_task_links` (
	`adr_id` text NOT NULL,
	`task_id` text NOT NULL,
	`link_type` text DEFAULT 'related' NOT NULL,
	CONSTRAINT `tasks_adr_task_links_pk` PRIMARY KEY(`adr_id`, `task_id`),
	CONSTRAINT `fk_tasks_adr_task_links_adr_id_tasks_architecture_decisions_id_fk` FOREIGN KEY (`adr_id`) REFERENCES `tasks_architecture_decisions`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("link_type" IN ('related', 'governed_by', 'implements'))
);
--> statement-breakpoint
CREATE TABLE `tasks_architecture_decisions` (
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
	CONSTRAINT `fk_tasks_architecture_decisions_supersedes_id_tasks_architecture_decisions_id_fk` FOREIGN KEY (`supersedes_id`) REFERENCES `tasks_architecture_decisions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_tasks_architecture_decisions_superseded_by_id_tasks_architecture_decisions_id_fk` FOREIGN KEY (`superseded_by_id`) REFERENCES `tasks_architecture_decisions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_tasks_architecture_decisions_amends_id_tasks_architecture_decisions_id_fk` FOREIGN KEY (`amends_id`) REFERENCES `tasks_architecture_decisions`(`id`) ON DELETE SET NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("status" IN ('proposed', 'accepted', 'superseded', 'deprecated')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("accepted_at" IS NULL OR "accepted_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("gate" IN ('HITL', 'automated')),
	CHECK ("gate_status" IN ('pending', 'passed', 'failed', 'waived'))
);
--> statement-breakpoint
CREATE TABLE `tasks_audit_log` (
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
	`idempotency_key` text,
	`duration_ms` integer,
	`success` integer,
	`source` text,
	`gateway` text,
	`error_message` text,
	`project_hash` text,
	CONSTRAINT `uq_tasks_audit_log_idempotency_lookup` UNIQUE(`project_hash`,`domain`,`operation`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `tasks_schema_meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks_status_registry` (
	`name` text NOT NULL,
	`entity_type` text NOT NULL,
	`namespace` text NOT NULL,
	`description` text NOT NULL,
	`is_terminal` integer DEFAULT false NOT NULL,
	CONSTRAINT `tasks_status_registry_pk` PRIMARY KEY(`name`, `entity_type`),
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("entity_type" IN ('task', 'session', 'lifecycle_pipeline', 'lifecycle_stage', 'adr', 'gate', 'manifest')),
	CHECK ("namespace" IN ('workflow', 'governance', 'manifest')),
	CHECK ("is_terminal" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `tasks_token_usage` (
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
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("transport" IN ('cli', 'api', 'agent', 'unknown')),
	CHECK ("method" IN ('otel', 'provider_api', 'tokenizer', 'heuristic')),
	CHECK ("confidence" IN ('real', 'high', 'estimated', 'coarse'))
);
--> statement-breakpoint
CREATE TABLE `conduit_attachment_approvals` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL,
	`reviewer_agent_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`comment` text,
	`version_reviewed` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_conduit_attachment_approvals_slug_conduit_attachments_slug_fk` FOREIGN KEY (`slug`) REFERENCES `conduit_attachments`(`slug`) ON DELETE CASCADE,
	CONSTRAINT `uq_conduit_attachment_approvals_slug_reviewer` UNIQUE(`slug`,`reviewer_agent_id`),
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `conduit_attachment_contributors` (
	`slug` text NOT NULL,
	`agent_id` text NOT NULL,
	`version_count` integer DEFAULT 0 NOT NULL,
	`total_tokens_added` integer DEFAULT 0 NOT NULL,
	`total_tokens_removed` integer DEFAULT 0 NOT NULL,
	`first_contribution_at` text NOT NULL,
	`last_contribution_at` text NOT NULL,
	CONSTRAINT `conduit_attachment_contributors_pk` PRIMARY KEY(`slug`, `agent_id`),
	CONSTRAINT `fk_conduit_attachment_contributors_slug_conduit_attachments_slug_fk` FOREIGN KEY (`slug`) REFERENCES `conduit_attachments`(`slug`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("first_contribution_at" IS NULL OR "first_contribution_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("last_contribution_at" IS NULL OR "last_contribution_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `conduit_attachment_versions` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL,
	`version_number` integer NOT NULL,
	`author_agent_id` text NOT NULL,
	`change_type` text DEFAULT 'patch' NOT NULL,
	`patch_text` text,
	`storage_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`original_size` integer NOT NULL,
	`compressed_size` integer NOT NULL,
	`tokens` integer NOT NULL,
	`change_summary` text,
	`sections_modified` text DEFAULT '[]' NOT NULL,
	`tokens_added` integer DEFAULT 0 NOT NULL,
	`tokens_removed` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_conduit_attachment_versions_slug_conduit_attachments_slug_fk` FOREIGN KEY (`slug`) REFERENCES `conduit_attachments`(`slug`) ON DELETE CASCADE,
	CONSTRAINT `uq_conduit_attachment_versions_slug_version` UNIQUE(`slug`,`version_number`),
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `conduit_attachments` (
	`slug` text PRIMARY KEY,
	`conversation_id` text NOT NULL,
	`from_agent_id` text NOT NULL,
	`content` blob NOT NULL,
	`original_size` integer NOT NULL,
	`compressed_size` integer NOT NULL,
	`content_hash` text NOT NULL,
	`format` text DEFAULT 'text' NOT NULL,
	`title` text,
	`tokens` integer DEFAULT 0 NOT NULL,
	`expires_at` text,
	`storage_key` text,
	`mode` text DEFAULT 'draft' NOT NULL,
	`version_count` integer DEFAULT 1 NOT NULL,
	`current_version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("expires_at" IS NULL OR "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `conduit_conversations` (
	`id` text PRIMARY KEY,
	`participants` text NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`last_message_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("last_message_at" IS NULL OR "last_message_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `conduit_dead_letters` (
	`id` text PRIMARY KEY,
	`message_id` text NOT NULL,
	`job_id` text NOT NULL,
	`reason` text NOT NULL,
	`attempts` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `conduit_delivery_jobs` (
	`id` text PRIMARY KEY,
	`message_id` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 6 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`last_error` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`idempotency_key` text CONSTRAINT `uq_conduit_delivery_jobs_idempotency_key` UNIQUE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("next_attempt_at" IS NULL OR "next_attempt_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `conduit_message_pins` (
	`id` text PRIMARY KEY,
	`message_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`pinned_by` text NOT NULL,
	`note` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `uq_conduit_message_pins_message_pinned_by` UNIQUE(`message_id`,`pinned_by`),
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `conduit_messages` (
	`id` text PRIMARY KEY,
	`conversation_id` text NOT NULL,
	`from_agent_id` text NOT NULL,
	`to_agent_id` text NOT NULL,
	`content` text NOT NULL,
	`content_type` text DEFAULT 'text' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attachments` text DEFAULT '[]' NOT NULL,
	`group_id` text,
	`metadata` text DEFAULT '{}',
	`reply_to` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`delivered_at` text,
	`read_at` text,
	`idempotency_key` text CONSTRAINT `uq_conduit_messages_idempotency_key` UNIQUE,
	CONSTRAINT `fk_conduit_messages_conversation_id_conduit_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conduit_conversations`(`id`),
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("delivered_at" IS NULL OR "delivered_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("read_at" IS NULL OR "read_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `conduit_project_agent_refs` (
	`agent_id` text PRIMARY KEY,
	`attached_at` text NOT NULL,
	`role` text,
	`capabilities_override` text,
	`last_used_at` text,
	`enabled` integer DEFAULT true NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("attached_at" IS NULL OR "attached_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("last_used_at" IS NULL OR "last_used_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("enabled" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `conduit_topic_message_acks` (
	`message_id` text NOT NULL,
	`subscriber_agent_id` text NOT NULL,
	`delivered_at` text,
	`read_at` text,
	CONSTRAINT `conduit_topic_message_acks_pk` PRIMARY KEY(`message_id`, `subscriber_agent_id`),
	CONSTRAINT `fk_conduit_topic_message_acks_message_id_conduit_topic_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `conduit_topic_messages`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("delivered_at" IS NULL OR "delivered_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("read_at" IS NULL OR "read_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `conduit_topic_messages` (
	`id` text PRIMARY KEY,
	`topic_id` text NOT NULL,
	`from_agent_id` text NOT NULL,
	`kind` text DEFAULT 'message' NOT NULL,
	`content` text NOT NULL,
	`payload` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`idempotency_key` text CONSTRAINT `uq_conduit_topic_messages_idempotency_key` UNIQUE,
	CONSTRAINT `fk_conduit_topic_messages_topic_id_conduit_topics_id_fk` FOREIGN KEY (`topic_id`) REFERENCES `conduit_topics`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `conduit_topic_subscriptions` (
	`topic_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`subscribed_at` text NOT NULL,
	CONSTRAINT `conduit_topic_subscriptions_pk` PRIMARY KEY(`topic_id`, `agent_id`),
	CONSTRAINT `fk_conduit_topic_subscriptions_topic_id_conduit_topics_id_fk` FOREIGN KEY (`topic_id`) REFERENCES `conduit_topics`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("subscribed_at" IS NULL OR "subscribed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `conduit_topics` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL UNIQUE,
	`epic_id` text NOT NULL,
	`wave_id` integer,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `docs_attachment_refs` (
	`attachment_id` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`attached_at` text NOT NULL,
	`attached_by` text,
	CONSTRAINT `docs_attachment_refs_pk` PRIMARY KEY(`attachment_id`, `owner_type`, `owner_id`),
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("owner_type" IN ('task', 'observation', 'session', 'decision', 'learning', 'pattern')),
	CHECK ("attached_at" IS NULL OR "attached_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `docs_attachments` (
	`id` text PRIMARY KEY,
	`sha256` text NOT NULL,
	`attachment_json` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`ref_count` integer DEFAULT 0 NOT NULL,
	`slug` text,
	`type` text,
	`lifecycle_status` text DEFAULT 'draft' NOT NULL,
	`supersedes` text,
	`superseded_by` text,
	`summary` text,
	`keywords` text,
	`topics` text,
	`related_tasks` text,
	`owner_version` text,
	`doc_version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `fk_docs_attachments_supersedes_docs_attachments_id_fk` FOREIGN KEY (`supersedes`) REFERENCES `docs_attachments`(`id`),
	CONSTRAINT `fk_docs_attachments_superseded_by_docs_attachments_id_fk` FOREIGN KEY (`superseded_by`) REFERENCES `docs_attachments`(`id`),
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("lifecycle_status" IN ('draft', 'proposed', 'accepted', 'superseded', 'archived', 'deprecated'))
);
--> statement-breakpoint
CREATE TABLE `docs_manifest_entries` (
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
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("status" IN ('completed', 'partial', 'blocked', 'archived')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `docs_pipeline_manifest` (
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
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`archived_at` text,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("distilled" IN (0, 1)),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("archived_at" IS NULL OR "archived_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_lifecycle_evidence` (
	`id` text PRIMARY KEY,
	`stage_id` text NOT NULL,
	`uri` text NOT NULL,
	`type` text NOT NULL,
	`recorded_at` text DEFAULT (datetime('now')) NOT NULL,
	`recorded_by` text,
	`description` text,
	CONSTRAINT `fk_tasks_lifecycle_evidence_stage_id_tasks_lifecycle_stages_id_fk` FOREIGN KEY (`stage_id`) REFERENCES `tasks_lifecycle_stages`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("type" IN ('file', 'url', 'manifest')),
	CHECK ("recorded_at" IS NULL OR "recorded_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_lifecycle_gate_results` (
	`id` text PRIMARY KEY,
	`stage_id` text NOT NULL,
	`gate_name` text NOT NULL,
	`result` text NOT NULL,
	`checked_at` text DEFAULT (datetime('now')) NOT NULL,
	`checked_by` text NOT NULL,
	`details` text,
	`reason` text,
	CONSTRAINT `fk_tasks_lifecycle_gate_results_stage_id_tasks_lifecycle_stages_id_fk` FOREIGN KEY (`stage_id`) REFERENCES `tasks_lifecycle_stages`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("result" IN ('pass', 'fail', 'warn')),
	CHECK ("checked_at" IS NULL OR "checked_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_lifecycle_pipelines` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`current_stage_id` text,
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	`completed_at` text,
	`updated_at` text DEFAULT (datetime('now')),
	`version` integer DEFAULT 1 NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("status" IN ('active', 'completed', 'blocked', 'failed', 'cancelled', 'aborted')),
	CHECK ("started_at" IS NULL OR "started_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("completed_at" IS NULL OR "completed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_lifecycle_stages` (
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
	CONSTRAINT `fk_tasks_lifecycle_stages_pipeline_id_tasks_lifecycle_pipelines_id_fk` FOREIGN KEY (`pipeline_id`) REFERENCES `tasks_lifecycle_pipelines`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("stage_name" IN ('research', 'consensus', 'architecture_decision', 'specification', 'decomposition', 'implementation', 'validation', 'testing', 'release', 'contribution')),
	CHECK ("status" IN ('not_started', 'in_progress', 'blocked', 'completed', 'skipped', 'failed')),
	CHECK ("started_at" IS NULL OR "started_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("completed_at" IS NULL OR "completed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("blocked_at" IS NULL OR "blocked_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("skipped_at" IS NULL OR "skipped_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("validated_at" IS NULL OR "validated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("validation_status" IN ('pending', 'in_review', 'approved', 'rejected', 'needs_revision'))
);
--> statement-breakpoint
CREATE TABLE `tasks_lifecycle_transitions` (
	`id` text PRIMARY KEY,
	`pipeline_id` text NOT NULL,
	`from_stage_id` text NOT NULL,
	`to_stage_id` text NOT NULL,
	`transition_type` text DEFAULT 'automatic' NOT NULL,
	`transitioned_by` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_tasks_lifecycle_transitions_pipeline_id_tasks_lifecycle_pipelines_id_fk` FOREIGN KEY (`pipeline_id`) REFERENCES `tasks_lifecycle_pipelines`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tasks_lifecycle_transitions_from_stage_id_tasks_lifecycle_stages_id_fk` FOREIGN KEY (`from_stage_id`) REFERENCES `tasks_lifecycle_stages`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tasks_lifecycle_transitions_to_stage_id_tasks_lifecycle_stages_id_fk` FOREIGN KEY (`to_stage_id`) REFERENCES `tasks_lifecycle_stages`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("transition_type" IN ('automatic', 'manual', 'forced')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_commit_files` (
	`commit_sha` text NOT NULL,
	`path` text NOT NULL,
	`old_path` text,
	`change_type` text NOT NULL,
	`lines_added` integer DEFAULT 0 NOT NULL,
	`lines_deleted` integer DEFAULT 0 NOT NULL,
	`is_binary` integer DEFAULT false NOT NULL,
	CONSTRAINT `tasks_commit_files_pk` PRIMARY KEY(`commit_sha`, `path`),
	CONSTRAINT `fk_tasks_commit_files_commit_sha_tasks_commits_sha_fk` FOREIGN KEY (`commit_sha`) REFERENCES `tasks_commits`(`sha`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("change_type" IN ('A', 'M', 'D', 'R', 'C')),
	CHECK ("is_binary" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `tasks_commits` (
	`sha` text PRIMARY KEY,
	`short_sha` text NOT NULL,
	`author_name` text,
	`author_email` text,
	`authored_at` text NOT NULL,
	`committer_name` text,
	`committer_email` text,
	`committed_at` text NOT NULL,
	`message` text NOT NULL,
	`subject` text NOT NULL,
	`conventional_type` text,
	`is_release_commit` integer DEFAULT false NOT NULL,
	`is_merge_commit` integer DEFAULT false NOT NULL,
	`parent_shas` text DEFAULT '[]' NOT NULL,
	`signature_verified` integer,
	`branch_at_commit` text,
	`project_hash` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("authored_at" IS NULL OR "authored_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("committed_at" IS NULL OR "committed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("conventional_type" IN ('feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'build', 'ci', 'perf', 'revert', 'breaking')),
	CHECK ("is_release_commit" IN (0, 1)),
	CHECK ("is_merge_commit" IN (0, 1)),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_task_commits` (
	`task_id` text,
	`commit_sha` text NOT NULL,
	`link_kind` text NOT NULL,
	`link_source` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `tasks_task_commits_pk` PRIMARY KEY(`task_id`, `commit_sha`, `link_kind`),
	CONSTRAINT `fk_tasks_task_commits_commit_sha_tasks_commits_sha_fk` FOREIGN KEY (`commit_sha`) REFERENCES `tasks_commits`(`sha`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("link_kind" IN ('implements', 'fixes', 'refactors', 'tests', 'docs', 'reverts')),
	CHECK ("link_source" IN ('commit-trailer', 'commit-subject', 'pr-title', 'pr-body', 'branch-name', 'manual')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_pr_commits` (
	`pr_id` text NOT NULL,
	`commit_sha` text NOT NULL,
	`position` integer NOT NULL,
	CONSTRAINT `tasks_pr_commits_pk` PRIMARY KEY(`pr_id`, `commit_sha`),
	CONSTRAINT `fk_tasks_pr_commits_pr_id_tasks_pull_requests_id_fk` FOREIGN KEY (`pr_id`) REFERENCES `tasks_pull_requests`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tasks_pr_tasks` (
	`pr_id` text NOT NULL,
	`task_id` text,
	`link_source` text NOT NULL,
	`link_kind` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `tasks_pr_tasks_pk` PRIMARY KEY(`pr_id`, `task_id`, `link_kind`),
	CONSTRAINT `fk_tasks_pr_tasks_pr_id_tasks_pull_requests_id_fk` FOREIGN KEY (`pr_id`) REFERENCES `tasks_pull_requests`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("link_source" IN ('pr-title', 'pr-body', 'branch-name', 'commit-trailer', 'manual')),
	CHECK ("link_kind" IN ('implements', 'fixes', 'refactors', 'tests', 'docs', 'reverts', 'tracks')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_pull_requests` (
	`id` text PRIMARY KEY,
	`pr_number` integer NOT NULL,
	`repo_url` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`state` text NOT NULL,
	`base_ref` text NOT NULL,
	`head_ref` text NOT NULL,
	`head_sha` text,
	`merge_commit_sha` text,
	`author_login` text,
	`opened_at` text NOT NULL,
	`merged_at` text,
	`closed_at` text,
	`is_release_pr` integer DEFAULT false NOT NULL,
	`release_version` text,
	`is_bump_only` integer DEFAULT false NOT NULL,
	`project_hash` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("state" IN ('open', 'closed', 'merged')),
	CHECK ("opened_at" IS NULL OR "opened_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("merged_at" IS NULL OR "merged_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("closed_at" IS NULL OR "closed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("is_release_pr" IN (0, 1)),
	CHECK ("is_bump_only" IN (0, 1)),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_release_artifacts` (
	`release_id` text NOT NULL,
	`artifact_type` text NOT NULL,
	`identifier` text NOT NULL,
	`version` text NOT NULL,
	`url` text,
	`published_at` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	CONSTRAINT `tasks_release_artifacts_pk` PRIMARY KEY(`release_id`, `artifact_type`, `identifier`),
	CONSTRAINT `fk_tasks_release_artifacts_release_id_tasks_releases_id_fk` FOREIGN KEY (`release_id`) REFERENCES `tasks_releases`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("artifact_type" IN ('npm', 'cargo', 'docker', 'pypi', 'github-release', 'binary', 'github-tag')),
	CHECK ("published_at" IS NULL OR "published_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_release_changes` (
	`id` text PRIMARY KEY,
	`release_id` text NOT NULL,
	`task_id` text,
	`change_type` text NOT NULL,
	`summary` text NOT NULL,
	`description` text,
	`impact` text DEFAULT 'patch' NOT NULL,
	`classified_by` text DEFAULT 'auto' NOT NULL,
	`classified_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_tasks_release_changes_release_id_tasks_releases_id_fk` FOREIGN KEY (`release_id`) REFERENCES `tasks_releases`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("change_type" IN ('feature', 'enhancement', 'bug', 'hotfix', 'security', 'breaking', 'refactor', 'docs', 'chore', 'revert', 'deprecation', 'infrastructure')),
	CHECK ("impact" IN ('major', 'minor', 'patch', 'none')),
	CHECK ("classified_by" IN ('auto', 'manual', 'approved')),
	CHECK ("classified_at" IS NULL OR "classified_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_release_changesets` (
	`id` text PRIMARY KEY,
	`release_id` text NOT NULL,
	`changeset_id` text NOT NULL,
	`task_ids` text NOT NULL,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`prs` text,
	`notes` text,
	`breaking` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_tasks_release_changesets_release_id_tasks_releases_id_fk` FOREIGN KEY (`release_id`) REFERENCES `tasks_releases`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("kind" IN ('feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'chore', 'breaking')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_release_commits` (
	`release_id` text NOT NULL,
	`commit_sha` text NOT NULL,
	`position` integer NOT NULL,
	`is_first` integer DEFAULT false NOT NULL,
	`is_last` integer DEFAULT false NOT NULL,
	`is_release_chore` integer DEFAULT false NOT NULL,
	CONSTRAINT `tasks_release_commits_pk` PRIMARY KEY(`release_id`, `commit_sha`),
	CONSTRAINT `fk_tasks_release_commits_release_id_tasks_releases_id_fk` FOREIGN KEY (`release_id`) REFERENCES `tasks_releases`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("is_first" IN (0, 1)),
	CHECK ("is_last" IN (0, 1)),
	CHECK ("is_release_chore" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `tasks_releases` (
	`id` text PRIMARY KEY,
	`version` text NOT NULL,
	`scheme` text DEFAULT 'calver' NOT NULL,
	`channel` text DEFAULT 'latest' NOT NULL,
	`epic_id` text,
	`release_kind` text DEFAULT 'regular' NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`previous_version` text,
	`merge_commit_sha` text,
	`pr_id` text,
	`workflow_run_url` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`planned_at` text,
	`pr_opened_at` text,
	`pr_merged_at` text,
	`published_at` text,
	`reconciled_at` text,
	`rolled_back_at` text,
	`failed_at` text,
	`cancelled_at` text,
	`failure_reason` text,
	`rolled_back_by` text,
	`project_hash` text,
	`tasks_json` text,
	`changelog` text,
	`notes` text,
	`git_tag` text,
	`prepared_at` text,
	`committed_at` text,
	`tagged_at` text,
	`pushed_at` text,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("scheme" IN ('calver', 'semver', 'calver-suffix')),
	CHECK ("channel" IN ('latest', 'beta', 'dev', 'hotfix')),
	CHECK ("release_kind" IN ('regular', 'hotfix', 'prerelease')),
	CHECK ("status" IN ('planned', 'pr-opened', 'pr-merged', 'published', 'reconciled', 'prepared', 'committed', 'tagged', 'pushed', 'rolled_back', 'failed', 'cancelled')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("planned_at" IS NULL OR "planned_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("pr_opened_at" IS NULL OR "pr_opened_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("pr_merged_at" IS NULL OR "pr_merged_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("published_at" IS NULL OR "published_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("reconciled_at" IS NULL OR "reconciled_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("rolled_back_at" IS NULL OR "rolled_back_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("failed_at" IS NULL OR "failed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("cancelled_at" IS NULL OR "cancelled_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("prepared_at" IS NULL OR "prepared_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("committed_at" IS NULL OR "committed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("tagged_at" IS NULL OR "tagged_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("pushed_at" IS NULL OR "pushed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_agent_error_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`agent_id` text NOT NULL,
	`error_type` text NOT NULL,
	`message` text NOT NULL,
	`stack` text,
	`occurred_at` text DEFAULT (datetime('now')) NOT NULL,
	`resolved` integer DEFAULT false NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("error_type" IN ('retriable', 'permanent', 'unknown')),
	CHECK ("occurred_at" IS NULL OR "occurred_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("resolved" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `tasks_agent_instances` (
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
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("agent_type" IN ('orchestrator', 'executor', 'researcher', 'architect', 'validator', 'documentor', 'custom')),
	CHECK ("status" IN ('starting', 'active', 'idle', 'error', 'crashed', 'stopped')),
	CHECK ("started_at" IS NULL OR "started_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("stopped_at" IS NULL OR "stopped_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_playbook_approvals` (
	`approval_id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`node_id` text NOT NULL,
	`token` text NOT NULL UNIQUE,
	`requested_at` text DEFAULT (datetime('now')) NOT NULL,
	`approved_at` text,
	`approver` text,
	`reason` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`auto_passed` integer DEFAULT false NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("requested_at" IS NULL OR "requested_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("approved_at" IS NULL OR "approved_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("status" IN ('pending', 'approved', 'rejected')),
	CHECK ("auto_passed" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `tasks_playbook_runs` (
	`run_id` text PRIMARY KEY,
	`playbook_name` text NOT NULL,
	`playbook_hash` text NOT NULL,
	`current_node` text,
	`bindings` text DEFAULT '{}' NOT NULL,
	`error_context` text,
	`status` text DEFAULT 'running' NOT NULL,
	`iteration_counts` text DEFAULT '{}' NOT NULL,
	`epic_id` text,
	`session_id` text,
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	`completed_at` text,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("status" IN ('running', 'paused', 'completed', 'failed', 'cancelled')),
	CHECK ("started_at" IS NULL OR "started_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("completed_at" IS NULL OR "completed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_warp_chain_instances` (
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
	CONSTRAINT `fk_tasks_warp_chain_instances_chain_id_tasks_warp_chains_id_fk` FOREIGN KEY (`chain_id`) REFERENCES `tasks_warp_chains`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("status" IN ('pending', 'active', 'completed', 'failed', 'cancelled')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_warp_chains` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`description` text,
	`definition` text NOT NULL,
	`validated` integer DEFAULT false,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("validated" IN (0, 1)),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_acceptance_projection_dirty` (
	`projection_key` text NOT NULL,
	`task_id` text NOT NULL,
	`reason` text DEFAULT 'manual_rebuild' NOT NULL,
	`source_updated_at` text,
	`queued_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`payload_json` text,
	CONSTRAINT `tasks_acceptance_projection_dirty_pk` PRIMARY KEY(`projection_key`, `task_id`),
	CONSTRAINT `fk_tasks_acceptance_projection_dirty_projection_key_tasks_acceptance_projection_state_projection_key_fk` FOREIGN KEY (`projection_key`) REFERENCES `tasks_acceptance_projection_state`(`projection_key`) ON DELETE CASCADE,
	CONSTRAINT `fk_tasks_acceptance_projection_dirty_task_id_tasks_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks_tasks`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("reason" IN ('task_acceptance_changed', 'task_reparented', 'child_completion_changed', 'manual_rebuild')),
	CHECK ("source_updated_at" IS NULL OR "source_updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("queued_at" IS NULL OR "queued_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_acceptance_projection_state` (
	`projection_key` text PRIMARY KEY,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'fresh' NOT NULL,
	`last_projected_at` text,
	`last_source_updated_at` text,
	`source_fingerprint` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("status" IN ('fresh', 'stale', 'rebuilding')),
	CHECK ("last_projected_at" IS NULL OR "last_projected_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("last_source_updated_at" IS NULL OR "last_source_updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_external_task_links` (
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
	CONSTRAINT `fk_tasks_external_task_links_task_id_tasks_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks_tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `uq_tasks_external_task_links_task_provider_external` UNIQUE(`task_id`,`provider_id`,`external_id`),
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("link_type" IN ('created', 'matched', 'manual', 'transferred')),
	CHECK ("sync_direction" IN ('inbound', 'outbound', 'bidirectional')),
	CHECK ("linked_at" IS NULL OR "linked_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("last_sync_at" IS NULL OR "last_sync_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_session_handoff_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`session_id` text NOT NULL,
	`handoff_json` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_tasks_session_handoff_entries_session_id_tasks_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `tasks_sessions`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_sessions` (
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
	`owner_auth_token` text,
	`agent_handle` text,
	`scope_kind` text,
	`scope_id` text,
	`last_activity` text,
	CONSTRAINT `fk_tasks_sessions_current_task_tasks_tasks_id_fk` FOREIGN KEY (`current_task`) REFERENCES `tasks_tasks`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_tasks_sessions_previous_session_id_tasks_sessions_id_fk` FOREIGN KEY (`previous_session_id`) REFERENCES `tasks_sessions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_tasks_sessions_next_session_id_tasks_sessions_id_fk` FOREIGN KEY (`next_session_id`) REFERENCES `tasks_sessions`(`id`) ON DELETE SET NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("status" IN ('active', 'ended', 'orphaned', 'suspended')),
	CHECK ("task_started_at" IS NULL OR "task_started_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("started_at" IS NULL OR "started_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("ended_at" IS NULL OR "ended_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("handoff_consumed_at" IS NULL OR "handoff_consumed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("grade_mode" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `tasks_task_acceptance_criteria` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`kind` text DEFAULT 'text' NOT NULL,
	`source_key` text,
	`target_task_id` text,
	`projection` text DEFAULT 'legacy' NOT NULL,
	`text` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text,
	`content_hash` text,
	CONSTRAINT `fk_tasks_task_acceptance_criteria_task_id_tasks_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks_tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tasks_task_acceptance_criteria_target_task_id_tasks_tasks_id_fk` FOREIGN KEY (`target_task_id`) REFERENCES `tasks_tasks`(`id`) ON DELETE SET NULL,
	CONSTRAINT `uq_tasks_task_acceptance_criteria_task_ordinal` UNIQUE(`task_id`,`ordinal`),
	CONSTRAINT `uq_tasks_task_acceptance_criteria_task_source_key` UNIQUE(`task_id`,`source_key`),
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("kind" IN ('text', 'child_task', 'evidence_bound')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_task_acceptance_criteria_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`ac_id` text NOT NULL,
	`recorded_at` text DEFAULT (datetime('now')) NOT NULL,
	`previous_text` text NOT NULL,
	`reason` text NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("recorded_at" IS NULL OR "recorded_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_task_dependencies` (
	`task_id` text NOT NULL,
	`depends_on` text NOT NULL,
	CONSTRAINT `tasks_task_dependencies_pk` PRIMARY KEY(`task_id`, `depends_on`),
	CONSTRAINT `fk_tasks_task_dependencies_task_id_tasks_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks_tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tasks_task_dependencies_depends_on_tasks_tasks_id_fk` FOREIGN KEY (`depends_on`) REFERENCES `tasks_tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tasks_task_relations` (
	`task_id` text NOT NULL,
	`related_to` text NOT NULL,
	`relation_type` text DEFAULT 'related' NOT NULL,
	`reason` text,
	CONSTRAINT `tasks_task_relations_pk` PRIMARY KEY(`task_id`, `related_to`, `relation_type`),
	CONSTRAINT `fk_tasks_task_relations_task_id_tasks_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks_tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tasks_task_relations_related_to_tasks_tasks_id_fk` FOREIGN KEY (`related_to`) REFERENCES `tasks_tasks`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("relation_type" IN ('related', 'blocks', 'duplicates', 'absorbs', 'fixes', 'extends', 'supersedes', 'groups'))
);
--> statement-breakpoint
CREATE TABLE `tasks_task_work_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`session_id` text NOT NULL,
	`task_id` text NOT NULL,
	`set_at` text DEFAULT (datetime('now')) NOT NULL,
	`cleared_at` text,
	CONSTRAINT `fk_tasks_task_work_history_session_id_tasks_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `tasks_sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tasks_task_work_history_task_id_tasks_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks_tasks`(`id`) ON DELETE CASCADE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("set_at" IS NULL OR "set_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("cleared_at" IS NULL OR "cleared_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_tasks` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`type` text,
	`role` text DEFAULT 'work' NOT NULL,
	`scope` text DEFAULT 'feature' NOT NULL,
	`severity` text,
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
	`ivtr_state` text,
	`idempotency_key` text CONSTRAINT `uq_tasks_tasks_idempotency_key` UNIQUE,
	CONSTRAINT `fk_tasks_tasks_parent_id_tasks_tasks_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `tasks_tasks`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_tasks_tasks_session_id_tasks_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `tasks_sessions`(`id`) ON DELETE SET NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("status" IN ('pending', 'active', 'blocked', 'done', 'cancelled', 'archived', 'proposed')),
	CHECK ("priority" IN ('critical', 'high', 'medium', 'low')),
	CHECK ("type" IN ('saga', 'epic', 'task', 'subtask')),
	CHECK ("role" IN ('work', 'research', 'experiment', 'bug', 'spike', 'release')),
	CHECK ("scope" IN ('project', 'feature', 'unit')),
	CHECK ("severity" IN ('P0', 'P1', 'P2', 'P3')),
	CHECK ("size" IN ('small', 'medium', 'large')),
	CHECK ("no_auto_complete" IN (0, 1)),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("completed_at" IS NULL OR "completed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("cancelled_at" IS NULL OR "cancelled_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("archived_at" IS NULL OR "archived_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("archive_reason" IN ('verified', 'reconciled', 'superseded', 'shadowed', 'cancelled', 'completed-unverified'))
);
--> statement-breakpoint
CREATE TABLE `tasks_background_jobs` (
	`id` text PRIMARY KEY,
	`operation` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	`completed_at` text,
	`result` text,
	`error` text,
	`progress` integer,
	`heartbeat_at` text DEFAULT (datetime('now')) NOT NULL,
	`claimed_by` text,
	`idempotency_key` text CONSTRAINT `uq_tasks_background_jobs_idempotency_key` UNIQUE,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("status" IN ('pending', 'running', 'complete', 'failed', 'cancelled', 'orphaned')),
	CHECK ("started_at" IS NULL OR "started_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("completed_at" IS NULL OR "completed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("heartbeat_at" IS NULL OR "heartbeat_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_evidence_ac_bindings` (
	`id` text PRIMARY KEY,
	`evidence_atom_id` text NOT NULL,
	`ac_id` text NOT NULL,
	`binding_type` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("binding_type" IN ('direct', 'satisfies', 'coverage')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_experiments` (
	`task_id` text PRIMARY KEY,
	`sandbox_branch` text,
	`baseline_commit` text,
	`merged_at` text,
	`receipt_id` text,
	`metrics_delta_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("merged_at" IS NULL OR "merged_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `tasks_task_labels` (
	`task_id` text NOT NULL,
	`label` text NOT NULL,
	CONSTRAINT `tasks_task_labels_pk` PRIMARY KEY(`task_id`, `label`)
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
CREATE INDEX `idx_tasks_adr_task_links_task_id` ON `tasks_adr_task_links` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_architecture_decisions_status` ON `tasks_architecture_decisions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_architecture_decisions_amends_id` ON `tasks_architecture_decisions` (`amends_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_audit_log_task_id` ON `tasks_audit_log` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_audit_log_action` ON `tasks_audit_log` (`action`);--> statement-breakpoint
CREATE INDEX `idx_tasks_audit_log_timestamp` ON `tasks_audit_log` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_tasks_audit_log_domain` ON `tasks_audit_log` (`domain`);--> statement-breakpoint
CREATE INDEX `idx_tasks_audit_log_request_id` ON `tasks_audit_log` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_audit_log_idempotency_key` ON `tasks_audit_log` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_tasks_audit_log_project_hash` ON `tasks_audit_log` (`project_hash`);--> statement-breakpoint
CREATE INDEX `idx_tasks_audit_log_actor` ON `tasks_audit_log` (`actor`);--> statement-breakpoint
CREATE INDEX `idx_tasks_audit_log_session_timestamp` ON `tasks_audit_log` (`session_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_tasks_audit_log_domain_operation` ON `tasks_audit_log` (`domain`,`operation`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status_registry_entity_type` ON `tasks_status_registry` (`entity_type`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status_registry_namespace` ON `tasks_status_registry` (`namespace`);--> statement-breakpoint
CREATE INDEX `idx_tasks_token_usage_created_at` ON `tasks_token_usage` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_token_usage_request_id` ON `tasks_token_usage` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_token_usage_session_id` ON `tasks_token_usage` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_token_usage_task_id` ON `tasks_token_usage` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_token_usage_provider` ON `tasks_token_usage` (`provider`);--> statement-breakpoint
CREATE INDEX `idx_tasks_token_usage_transport` ON `tasks_token_usage` (`transport`);--> statement-breakpoint
CREATE INDEX `idx_tasks_token_usage_domain_operation` ON `tasks_token_usage` (`domain`,`operation`);--> statement-breakpoint
CREATE INDEX `idx_tasks_token_usage_method` ON `tasks_token_usage` (`method`);--> statement-breakpoint
CREATE INDEX `idx_tasks_token_usage_gateway` ON `tasks_token_usage` (`gateway`);--> statement-breakpoint
CREATE INDEX `idx_conduit_attachment_approvals_slug` ON `conduit_attachment_approvals` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_conduit_attachment_versions_slug` ON `conduit_attachment_versions` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_conduit_attachment_versions_author` ON `conduit_attachment_versions` (`author_agent_id`);--> statement-breakpoint
CREATE INDEX `idx_conduit_attachments_conversation` ON `conduit_attachments` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_conduit_attachments_agent` ON `conduit_attachments` (`from_agent_id`);--> statement-breakpoint
CREATE INDEX `idx_conduit_dead_letters_message` ON `conduit_dead_letters` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_conduit_delivery_jobs_status` ON `conduit_delivery_jobs` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_conduit_message_pins_conversation` ON `conduit_message_pins` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_conduit_message_pins_agent` ON `conduit_message_pins` (`pinned_by`);--> statement-breakpoint
CREATE INDEX `idx_conduit_messages_conversation` ON `conduit_messages` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_conduit_messages_from_agent` ON `conduit_messages` (`from_agent_id`);--> statement-breakpoint
CREATE INDEX `idx_conduit_messages_to_agent` ON `conduit_messages` (`to_agent_id`);--> statement-breakpoint
CREATE INDEX `idx_conduit_messages_created_at` ON `conduit_messages` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_conduit_messages_group_id` ON `conduit_messages` (`group_id`);--> statement-breakpoint
CREATE INDEX `idx_conduit_messages_reply_to` ON `conduit_messages` (`reply_to`);--> statement-breakpoint
CREATE INDEX `idx_conduit_topic_messages_topic_created` ON `conduit_topic_messages` (`topic_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_conduit_topic_subscriptions_agent` ON `conduit_topic_subscriptions` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_conduit_topics_epic` ON `conduit_topics` (`epic_id`);--> statement-breakpoint
CREATE INDEX `idx_docs_attachment_refs_attachment_id` ON `docs_attachment_refs` (`attachment_id`);--> statement-breakpoint
CREATE INDEX `idx_docs_attachment_refs_owner` ON `docs_attachment_refs` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_docs_attachments_sha256` ON `docs_attachments` (`sha256`);--> statement-breakpoint
CREATE INDEX `idx_docs_attachments_lifecycle_status` ON `docs_attachments` (`lifecycle_status`);--> statement-breakpoint
CREATE INDEX `idx_docs_attachments_supersedes` ON `docs_attachments` (`supersedes`);--> statement-breakpoint
CREATE INDEX `idx_docs_manifest_entries_pipeline_id` ON `docs_manifest_entries` (`pipeline_id`);--> statement-breakpoint
CREATE INDEX `idx_docs_manifest_entries_stage_id` ON `docs_manifest_entries` (`stage_id`);--> statement-breakpoint
CREATE INDEX `idx_docs_manifest_entries_status` ON `docs_manifest_entries` (`status`);--> statement-breakpoint
CREATE INDEX `idx_docs_pipeline_manifest_task_id` ON `docs_pipeline_manifest` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_docs_pipeline_manifest_session_id` ON `docs_pipeline_manifest` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_docs_pipeline_manifest_distilled` ON `docs_pipeline_manifest` (`distilled`);--> statement-breakpoint
CREATE INDEX `idx_docs_pipeline_manifest_status` ON `docs_pipeline_manifest` (`status`);--> statement-breakpoint
CREATE INDEX `idx_docs_pipeline_manifest_content_hash` ON `docs_pipeline_manifest` (`content_hash`);--> statement-breakpoint
CREATE INDEX `idx_tasks_lifecycle_evidence_stage_id` ON `tasks_lifecycle_evidence` (`stage_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_lifecycle_gate_results_stage_id` ON `tasks_lifecycle_gate_results` (`stage_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_lifecycle_pipelines_task_id` ON `tasks_lifecycle_pipelines` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_lifecycle_pipelines_status` ON `tasks_lifecycle_pipelines` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_lifecycle_stages_pipeline_id` ON `tasks_lifecycle_stages` (`pipeline_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_lifecycle_stages_stage_name` ON `tasks_lifecycle_stages` (`stage_name`);--> statement-breakpoint
CREATE INDEX `idx_tasks_lifecycle_stages_status` ON `tasks_lifecycle_stages` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_lifecycle_stages_validated_by` ON `tasks_lifecycle_stages` (`validated_by`);--> statement-breakpoint
CREATE INDEX `idx_tasks_lifecycle_transitions_pipeline_id` ON `tasks_lifecycle_transitions` (`pipeline_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_commit_files_path` ON `tasks_commit_files` (`path`);--> statement-breakpoint
CREATE INDEX `idx_tasks_commit_files_change_type` ON `tasks_commit_files` (`change_type`);--> statement-breakpoint
CREATE INDEX `idx_tasks_commits_short_sha` ON `tasks_commits` (`short_sha`);--> statement-breakpoint
CREATE INDEX `idx_tasks_commits_author_email` ON `tasks_commits` (`author_email`);--> statement-breakpoint
CREATE INDEX `idx_tasks_commits_authored_at` ON `tasks_commits` (`authored_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_commits_conventional_type` ON `tasks_commits` (`conventional_type`);--> statement-breakpoint
CREATE INDEX `idx_tasks_commits_is_release` ON `tasks_commits` (`is_release_commit`);--> statement-breakpoint
CREATE INDEX `idx_tasks_commits_project_hash` ON `tasks_commits` (`project_hash`);--> statement-breakpoint
CREATE INDEX `idx_tasks_task_commits_task_id` ON `tasks_task_commits` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_task_commits_commit_sha` ON `tasks_task_commits` (`commit_sha`);--> statement-breakpoint
CREATE INDEX `idx_tasks_task_commits_link_kind` ON `tasks_task_commits` (`link_kind`);--> statement-breakpoint
CREATE INDEX `idx_tasks_pr_commits_pr_id` ON `tasks_pr_commits` (`pr_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_pr_commits_commit_sha` ON `tasks_pr_commits` (`commit_sha`);--> statement-breakpoint
CREATE INDEX `idx_tasks_pr_commits_position` ON `tasks_pr_commits` (`pr_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_tasks_pr_tasks_pr_id` ON `tasks_pr_tasks` (`pr_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_pr_tasks_task_id` ON `tasks_pr_tasks` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_pr_tasks_link_source` ON `tasks_pr_tasks` (`link_source`);--> statement-breakpoint
CREATE INDEX `idx_tasks_pull_requests_pr_number` ON `tasks_pull_requests` (`pr_number`);--> statement-breakpoint
CREATE INDEX `idx_tasks_pull_requests_state` ON `tasks_pull_requests` (`state`);--> statement-breakpoint
CREATE INDEX `idx_tasks_pull_requests_merge_commit_sha` ON `tasks_pull_requests` (`merge_commit_sha`);--> statement-breakpoint
CREATE INDEX `idx_tasks_pull_requests_head_sha` ON `tasks_pull_requests` (`head_sha`);--> statement-breakpoint
CREATE INDEX `idx_tasks_pull_requests_release_version` ON `tasks_pull_requests` (`release_version`);--> statement-breakpoint
CREATE INDEX `idx_tasks_pull_requests_project_hash` ON `tasks_pull_requests` (`project_hash`);--> statement-breakpoint
CREATE INDEX `idx_tasks_release_artifacts_release_id` ON `tasks_release_artifacts` (`release_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_release_artifacts_artifact_type` ON `tasks_release_artifacts` (`artifact_type`);--> statement-breakpoint
CREATE INDEX `idx_tasks_release_artifacts_published_at` ON `tasks_release_artifacts` (`published_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_release_changes_release_id` ON `tasks_release_changes` (`release_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_release_changes_task_id` ON `tasks_release_changes` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_release_changes_change_type` ON `tasks_release_changes` (`change_type`);--> statement-breakpoint
CREATE INDEX `idx_tasks_release_changes_impact` ON `tasks_release_changes` (`impact`);--> statement-breakpoint
CREATE INDEX `idx_tasks_release_changesets_release_id` ON `tasks_release_changesets` (`release_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_release_changesets_changeset_id` ON `tasks_release_changesets` (`changeset_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_release_changesets_kind` ON `tasks_release_changesets` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_tasks_release_commits_release_id` ON `tasks_release_commits` (`release_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_release_commits_commit_sha` ON `tasks_release_commits` (`commit_sha`);--> statement-breakpoint
CREATE INDEX `idx_tasks_release_commits_position` ON `tasks_release_commits` (`release_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_tasks_releases_version` ON `tasks_releases` (`version`);--> statement-breakpoint
CREATE INDEX `idx_tasks_releases_status` ON `tasks_releases` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_releases_channel` ON `tasks_releases` (`channel`);--> statement-breakpoint
CREATE INDEX `idx_tasks_releases_epic_id` ON `tasks_releases` (`epic_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_releases_merge_commit_sha` ON `tasks_releases` (`merge_commit_sha`);--> statement-breakpoint
CREATE INDEX `idx_tasks_releases_project_hash` ON `tasks_releases` (`project_hash`);--> statement-breakpoint
CREATE INDEX `idx_tasks_releases_published_at` ON `tasks_releases` (`published_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_releases_pushed_at` ON `tasks_releases` (`pushed_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_agent_error_log_agent_id` ON `tasks_agent_error_log` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_agent_error_log_error_type` ON `tasks_agent_error_log` (`error_type`);--> statement-breakpoint
CREATE INDEX `idx_tasks_agent_error_log_occurred_at` ON `tasks_agent_error_log` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_agent_instances_status` ON `tasks_agent_instances` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_agent_instances_agent_type` ON `tasks_agent_instances` (`agent_type`);--> statement-breakpoint
CREATE INDEX `idx_tasks_agent_instances_session_id` ON `tasks_agent_instances` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_agent_instances_task_id` ON `tasks_agent_instances` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_agent_instances_parent_agent_id` ON `tasks_agent_instances` (`parent_agent_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_agent_instances_last_heartbeat` ON `tasks_agent_instances` (`last_heartbeat`);--> statement-breakpoint
CREATE INDEX `idx_tasks_warp_chain_instances_chain` ON `tasks_warp_chain_instances` (`chain_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_warp_chain_instances_epic` ON `tasks_warp_chain_instances` (`epic_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_warp_chain_instances_status` ON `tasks_warp_chain_instances` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_warp_chains_name` ON `tasks_warp_chains` (`name`);--> statement-breakpoint
CREATE INDEX `idx_tasks_acceptance_projection_dirty_task_id` ON `tasks_acceptance_projection_dirty` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_acceptance_projection_dirty_queued_at` ON `tasks_acceptance_projection_dirty` (`queued_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_acceptance_projection_state_status_freshness` ON `tasks_acceptance_projection_state` (`status`,`last_source_updated_at`,`last_projected_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_external_task_links_task_id` ON `tasks_external_task_links` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_external_task_links_provider_external` ON `tasks_external_task_links` (`provider_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_external_task_links_provider_id` ON `tasks_external_task_links` (`provider_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_session_handoff_entries_session_id` ON `tasks_session_handoff_entries` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_sessions_status` ON `tasks_sessions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_sessions_previous` ON `tasks_sessions` (`previous_session_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_sessions_agent_identifier` ON `tasks_sessions` (`agent_identifier`);--> statement-breakpoint
CREATE INDEX `idx_tasks_sessions_started_at` ON `tasks_sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_sessions_status_started_at` ON `tasks_sessions` (`status`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_sessions_agent_handle` ON `tasks_sessions` (`agent_handle`);--> statement-breakpoint
CREATE INDEX `idx_tasks_sessions_scope_kind_id` ON `tasks_sessions` (`scope_kind`,`scope_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_task_acceptance_criteria_task_id` ON `tasks_task_acceptance_criteria` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_task_acceptance_criteria_target_task_id` ON `tasks_task_acceptance_criteria` (`target_task_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_task_acceptance_criteria_history_ac_id_recorded_at` ON `tasks_task_acceptance_criteria_history` (`ac_id`,"recorded_at" desc);--> statement-breakpoint
CREATE INDEX `idx_tasks_task_dependencies_depends_on` ON `tasks_task_dependencies` (`depends_on`);--> statement-breakpoint
CREATE INDEX `idx_tasks_task_relations_task_id_relation_type` ON `tasks_task_relations` (`task_id`,`relation_type`);--> statement-breakpoint
CREATE INDEX `idx_tasks_task_relations_related_to_relation_type` ON `tasks_task_relations` (`related_to`,`relation_type`);--> statement-breakpoint
CREATE INDEX `idx_tasks_task_relations_relation_type` ON `tasks_task_relations` (`relation_type`);--> statement-breakpoint
CREATE INDEX `idx_tasks_task_work_history_session` ON `tasks_task_work_history` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_tasks_status` ON `tasks_tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_tasks_parent_id` ON `tasks_tasks` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_tasks_phase` ON `tasks_tasks` (`phase`);--> statement-breakpoint
CREATE INDEX `idx_tasks_tasks_type` ON `tasks_tasks` (`type`);--> statement-breakpoint
CREATE INDEX `idx_tasks_tasks_priority` ON `tasks_tasks` (`priority`);--> statement-breakpoint
CREATE INDEX `idx_tasks_tasks_session_id` ON `tasks_tasks` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_tasks_pipeline_stage` ON `tasks_tasks` (`pipeline_stage`);--> statement-breakpoint
CREATE INDEX `idx_tasks_tasks_assignee` ON `tasks_tasks` (`assignee`);--> statement-breakpoint
CREATE INDEX `idx_tasks_tasks_parent_status` ON `tasks_tasks` (`parent_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_tasks_status_priority` ON `tasks_tasks` (`status`,`priority`);--> statement-breakpoint
CREATE INDEX `idx_tasks_tasks_type_phase` ON `tasks_tasks` (`type`,`phase`);--> statement-breakpoint
CREATE INDEX `idx_tasks_tasks_status_archive_reason` ON `tasks_tasks` (`status`,`archive_reason`);--> statement-breakpoint
CREATE INDEX `idx_tasks_tasks_role` ON `tasks_tasks` (`role`);--> statement-breakpoint
CREATE INDEX `idx_tasks_tasks_scope` ON `tasks_tasks` (`scope`);--> statement-breakpoint
CREATE INDEX `idx_tasks_tasks_role_status` ON `tasks_tasks` (`role`,`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_tasks_created_date` ON `tasks_tasks` (date("created_at"));--> statement-breakpoint
CREATE INDEX `idx_tasks_background_jobs_status` ON `tasks_background_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_background_jobs_operation` ON `tasks_background_jobs` (`operation`);--> statement-breakpoint
CREATE INDEX `idx_tasks_background_jobs_claimed_by` ON `tasks_background_jobs` (`claimed_by`);--> statement-breakpoint
CREATE INDEX `idx_tasks_background_jobs_started_at` ON `tasks_background_jobs` (`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tasks_evidence_ac_bindings_atom_ac_type` ON `tasks_evidence_ac_bindings` (`evidence_atom_id`,`ac_id`,`binding_type`);--> statement-breakpoint
CREATE INDEX `idx_tasks_evidence_ac_bindings_ac_id` ON `tasks_evidence_ac_bindings` (`ac_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_evidence_ac_bindings_evidence_atom_id` ON `tasks_evidence_ac_bindings` (`evidence_atom_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_experiments_merged` ON `tasks_experiments` (`merged_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_task_labels_label` ON `tasks_task_labels` (`label`);