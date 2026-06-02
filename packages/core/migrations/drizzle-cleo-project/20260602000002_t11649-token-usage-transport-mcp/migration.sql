-- T11649 — Widen `tasks_token_usage.transport` CHECK to preserve 'mcp'.
--
-- Background:
--   The consolidation migration (20260531000001_t11363) created
--   `tasks_token_usage` with `CHECK ("transport" IN ('cli','api','agent','unknown'))`.
--   `'mcp'` was NOT in the enum, so the exodus migrate layer coerced
--   `transport = 'mcp'` → `'agent'` (T11548) to satisfy the CHECK. The full
--   cutover dry-run flagged this as a SILENT SEMANTIC ALTERATION: ~194 real
--   telemetry rows had their true origin (MCP-gateway, `source: "mcp"`) rewritten
--   to `'agent'`, with no preserving column capturing the lost value. Count was
--   preserved; integrity was not.
--
-- Owner directive (T11649): 100% data integrity. `'mcp'` is a first-class
--   transport origin, distinct from `'agent'`, and MUST be stored verbatim.
--
-- Change:
--   Old CHECK: transport IN ('cli','api','agent','unknown')
--   New CHECK: transport IN ('cli','api','agent','mcp','unknown')
--
--   The widened enum is the canonical `TOKEN_USAGE_TRANSPORTS` SSoT in
--   packages/core/src/store/schema/audit.ts. The exodus `tasks_token_usage.transport`
--   normalization rule is removed in the same change so `'mcp'` lands unmodified.
--
-- SQLite cannot ALTER a CHECK constraint in place, so this migration follows the
-- canonical "table rebuild" recipe (same pattern as drizzle-tasks T9073 / T1408):
--
--   1. Create `__new_tasks_token_usage` with the widened CHECK (every other
--      column / default / CHECK preserved verbatim from the T11363 DDL).
--   2. INSERT … SELECT every row (no data transformation — existing values are
--      all valid under the wider constraint).
--   3. DROP `tasks_token_usage`; RENAME `__new_tasks_token_usage` TO it.
--   4. Recreate all nine indexes.
--
-- This migration is purely additive at the schema level (the enum only GROWS),
-- runs AFTER the consolidation CREATE, and leaves every other table untouched.
--
-- @task T11649
-- @epic T11245
-- @saga T11242

PRAGMA foreign_keys = OFF;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 1 — Drop the nine indexes attached to `tasks_token_usage`
--          (they are recreated against the rebuilt table in Step 4).
-- --------------------------------------------------------------------------
DROP INDEX IF EXISTS `idx_tasks_token_usage_created_at`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_token_usage_request_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_token_usage_session_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_token_usage_task_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_token_usage_provider`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_token_usage_transport`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_token_usage_domain_operation`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_token_usage_method`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_token_usage_gateway`;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 2 — Create `__new_tasks_token_usage` with the widened transport CHECK.
--          All other columns / constraints / defaults are byte-identical to the
--          T11363 consolidation DDL — the only change is the transport enum.
-- --------------------------------------------------------------------------
CREATE TABLE `__new_tasks_token_usage` (
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
	-- consolidation CHECK constraints (T11363) — transport widened to include 'mcp' (T11649)
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("transport" IN ('cli', 'api', 'agent', 'mcp', 'unknown')),
	CHECK ("method" IN ('otel', 'provider_api', 'tokenizer', 'heuristic')),
	CHECK ("confidence" IN ('real', 'high', 'estimated', 'coarse'))
);
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 3 — Copy every row (no transformation; every value is valid under the
--          wider constraint) then swap tables.
-- --------------------------------------------------------------------------
INSERT INTO `__new_tasks_token_usage` (
	`id`, `created_at`, `provider`, `model`, `transport`, `gateway`, `domain`,
	`operation`, `session_id`, `task_id`, `request_id`, `input_chars`,
	`output_chars`, `input_tokens`, `output_tokens`, `total_tokens`, `method`,
	`confidence`, `request_hash`, `response_hash`, `metadata_json`
)
SELECT
	`id`, `created_at`, `provider`, `model`, `transport`, `gateway`, `domain`,
	`operation`, `session_id`, `task_id`, `request_id`, `input_chars`,
	`output_chars`, `input_tokens`, `output_tokens`, `total_tokens`, `method`,
	`confidence`, `request_hash`, `response_hash`, `metadata_json`
FROM `tasks_token_usage`;
--> statement-breakpoint
DROP TABLE `tasks_token_usage`;
--> statement-breakpoint
ALTER TABLE `__new_tasks_token_usage` RENAME TO `tasks_token_usage`;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 4 — Recreate all nine indexes (verbatim from the T11363 DDL).
-- --------------------------------------------------------------------------
CREATE INDEX `idx_tasks_token_usage_created_at` ON `tasks_token_usage` (`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_token_usage_request_id` ON `tasks_token_usage` (`request_id`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_token_usage_session_id` ON `tasks_token_usage` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_token_usage_task_id` ON `tasks_token_usage` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_token_usage_provider` ON `tasks_token_usage` (`provider`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_token_usage_transport` ON `tasks_token_usage` (`transport`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_token_usage_domain_operation` ON `tasks_token_usage` (`domain`,`operation`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_token_usage_method` ON `tasks_token_usage` (`method`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_token_usage_gateway` ON `tasks_token_usage` (`gateway`);
--> statement-breakpoint

PRAGMA foreign_keys = ON;
