-- T11538 + T11545: Define the PROJECT-scope nexus code-graph schema
-- (ADR-090 — residency step 1 + plasticity partition §5.3).
--
-- The four per-project code/knowledge-graph tables (`nexus_nodes`,
-- `nexus_relations`, `nexus_contracts`, `nexus_code_index`) move from GLOBAL
-- scope (packages/core/src/store/schema/cleo-global/nexus.ts) into the
-- consolidated PROJECT-scope cleo.db so `.cleo/cleo.db` is the complete portable
-- living brain. This migration is the project-side CREATE TABLE half of that
-- move: it mirrors the global T11363 CREATE blocks for these four tables EXACTLY,
-- minus the redundant `project_id` column (scope is implicit in the owning
-- project DB, ADR-090 §2.1) and minus every `idx_*_project*` index that led with
-- `project_id`.
--
-- T11545 (ADR-090 §5.3): the Hebbian plasticity columns (`weight`,
-- `last_accessed_at`, `co_accessed_count`) are PARTITIONED into the sibling 1:1
-- `nexus_relation_weights` table (keyed by `relation_id`) rather than living
-- inline on `nexus_relations`. The consolidated project schema is authored to
-- its FINAL shape directly here (no inline-then-drop dance — SQLite cannot DROP
-- a column referenced by a CHECK without a full table rebuild), so this CREATE
-- omits the three plasticity columns from `nexus_relations` and adds the weights
-- table below.
--
-- CHECK constraints are derived from the schema enum/boolean/timestamp metadata —
-- byte-identical to scripts/inject-consolidation-checks.mjs (T11363), never
-- hand-typed — so the consolidated-schema-parity suite (T11364 AC2) stays green.
--
-- This is purely additive STEP 1. T11539 removes the global copies and moves the
-- data; this migration does NOT touch the GLOBAL scope.

CREATE TABLE `nexus_nodes` (
	`id` text PRIMARY KEY,
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
CREATE TABLE `nexus_relations` (
	`id` text PRIMARY KEY,
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`type` text NOT NULL,
	`confidence` real NOT NULL,
	`reason` text,
	`step` integer,
	`indexed_at` text DEFAULT (datetime('now')) NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("type" IN ('contains', 'defines', 'imports', 'accesses', 'calls', 'extends', 'implements', 'method_overrides', 'method_implements', 'has_method', 'has_property', 'member_of', 'step_in_process', 'handles_route', 'fetches', 'handles_tool', 'entry_point_of', 'wraps', 'queries', 'documents', 'applies_to', 'co_changed', 'co_cited_in_task')),
	CHECK ("indexed_at" IS NULL OR "indexed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
-- T11545 (ADR-090 §5.3): partitioned Hebbian plasticity weights, 1:1 with
-- nexus_relations.id. relation_id is PK + intra-scope soft FK to nexus_relations.id.
CREATE TABLE `nexus_relation_weights` (
	`relation_id` text PRIMARY KEY NOT NULL,
	`weight` real DEFAULT 0 NOT NULL,
	`last_accessed_at` text,
	`co_accessed_count` integer DEFAULT 0 NOT NULL,
	-- consolidation CHECK constraints (T11363) — derived from schema enum/boolean/timestamp metadata, never hand-typed
	CHECK ("last_accessed_at" IS NULL OR "last_accessed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `nexus_contracts` (
	`contract_id` text PRIMARY KEY,
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
CREATE TABLE `nexus_code_index` (
	`id` text PRIMARY KEY,
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
CREATE INDEX `idx_nexus_nodes_kind` ON `nexus_nodes` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_file` ON `nexus_nodes` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_name` ON `nexus_nodes` (`name`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_community` ON `nexus_nodes` (`community_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_parent` ON `nexus_nodes` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_exported` ON `nexus_nodes` (`is_exported`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_is_external` ON `nexus_nodes` (`is_external`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_source` ON `nexus_relations` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_target` ON `nexus_relations` (`target_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_type` ON `nexus_relations` (`type`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_source_type` ON `nexus_relations` (`source_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_target_type` ON `nexus_relations` (`target_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_confidence` ON `nexus_relations` (`confidence`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relation_weights_last_accessed` ON `nexus_relation_weights` (`last_accessed_at`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relation_weights_weight` ON `nexus_relation_weights` (`weight`);--> statement-breakpoint
CREATE INDEX `idx_nexus_contracts_type` ON `nexus_contracts` (`type`);--> statement-breakpoint
CREATE INDEX `idx_nexus_contracts_path` ON `nexus_contracts` (`path`);--> statement-breakpoint
CREATE INDEX `idx_nexus_contracts_method` ON `nexus_contracts` (`method`);--> statement-breakpoint
CREATE INDEX `idx_nexus_contracts_source_symbol` ON `nexus_contracts` (`source_symbol_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_contracts_created` ON `nexus_contracts` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_nexus_code_index_file` ON `nexus_code_index` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_nexus_code_index_symbol` ON `nexus_code_index` (`symbol_name`);--> statement-breakpoint
CREATE INDEX `idx_nexus_code_index_kind` ON `nexus_code_index` (`kind`);
