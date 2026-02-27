-- ADR-017 §5.3 + ADR-018: ADR tracking tables, status registry, and architecture_decisions extension.
-- Trimmed: audit_log ALTER TABLE columns already applied by 20260225200000.
--          Lifecycle table rebuilds already applied by 20260225210000.
--          tasks/task_relations already match schema.ts in the live DB.

-- === NEW TABLES ===
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
CREATE TABLE `status_registry` (
	`name` text NOT NULL,
	`entity_type` text NOT NULL,
	`namespace` text NOT NULL,
	`description` text NOT NULL,
	`is_terminal` integer DEFAULT false NOT NULL,
	CONSTRAINT `status_registry_pk` PRIMARY KEY(`name`, `entity_type`)
);
--> statement-breakpoint

-- === architecture_decisions REBUILD ===
-- Adds 6 new columns (date, accepted_at, gate, gate_status, amends_id, file_path).
-- Also drops pre-Drizzle extra columns (context, decision, rationale, etc.) not in schema.ts.
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
	`file_path` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_architecture_decisions`(`id`, `title`, `status`, `supersedes_id`, `superseded_by_id`, `consensus_manifest_id`, `content`, `created_at`, `updated_at`) SELECT `id`, `title`, `status`, `supersedes_id`, `superseded_by_id`, `consensus_manifest_id`, `content`, `created_at`, `updated_at` FROM `architecture_decisions`;--> statement-breakpoint
DROP TABLE `architecture_decisions`;--> statement-breakpoint
ALTER TABLE `__new_architecture_decisions` RENAME TO `architecture_decisions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint

-- === sessions REBUILD ===
-- Adds handoff_json column (missing from prior migrations).
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
	`ended_at` text
);
--> statement-breakpoint
INSERT INTO `__new_sessions`(`id`, `name`, `status`, `scope_json`, `current_task`, `task_started_at`, `agent`, `notes_json`, `tasks_completed_json`, `tasks_created_json`, `started_at`, `ended_at`) SELECT `id`, `name`, `status`, `scope_json`, `current_task`, `task_started_at`, `agent`, `notes_json`, `tasks_completed_json`, `tasks_created_json`, `started_at`, `ended_at` FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint

-- === INDEXES ===
-- architecture_decisions index (recreated after table rebuild)
CREATE INDEX `idx_arch_decisions_status` ON `architecture_decisions` (`status`);--> statement-breakpoint
-- sessions index (recreated after table rebuild)
CREATE INDEX `idx_sessions_status` ON `sessions` (`status`);--> statement-breakpoint
-- new table indexes
CREATE INDEX `idx_adr_task_links_task_id` ON `adr_task_links` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_status_registry_entity_type` ON `status_registry` (`entity_type`);--> statement-breakpoint
CREATE INDEX `idx_status_registry_namespace` ON `status_registry` (`namespace`);
