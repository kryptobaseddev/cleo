-- T9975 — Per-agent session model for multi-agent isolation.
--
-- Background
-- ──────────
-- When N agents work concurrently they share one briefing surface and can
-- overwrite each other's session state. This migration adds three columns
-- to the `sessions` table so each concurrent agent session can be tagged
-- with a human-readable handle and its scope can be looked up without
-- deserialising the `scope_json` blob.
--
-- New columns
-- ───────────
-- agent_handle  TEXT NULL
--   Human-readable agent tag supplied via `cleo session start --agent <handle>`.
--   Distinct from `agent` (provider-level) and `agent_identifier` (LLM
--   conversation ID). Used to disambiguate concurrent sessions started by
--   different worktree agents.
--   Example: "agent-A", "worker-1", "ct-task-executor@T9975"
--
-- scope_kind  TEXT NULL
--   Denormalised cache of the `type` field inside `scope_json`.
--   Values: "global" | "epic".  Allows fast index scans on scope without
--   JSON parsing (e.g., find all active sessions for a specific epic).
--
-- scope_id  TEXT NULL
--   Denormalised cache of the `epicId` / `rootTaskId` inside `scope_json`
--   when `scope_kind = 'epic'`. NULL for global sessions.
--   Example: "T9964"
--
-- last_activity  TEXT NULL
--   ISO 8601 timestamp updated on session mutate operations (start, focus
--   change, task completion). Used by `cleo session list --all` to surface
--   an "idle for N minutes" column and by the idle auto-end lifecycle hook.
--
-- Backward compatibility
-- ──────────────────────
-- All columns are nullable. Existing rows pass-through with NULL values;
-- the runtime falls back gracefully to `scope_json` parsing when
-- `scope_kind`/`scope_id` are NULL.
--
-- Idempotency
-- ───────────
-- Each ALTER TABLE ADD COLUMN statement is idempotent against Drizzle's
-- migration journal — the migration will only be applied once. Re-running
-- the migration after partial application is safe because SQLite ignores
-- "duplicate column" errors when the column already exists (as long as the
-- migration is recorded in the journal).
--
-- @task T9975
-- @epic T9964
-- @see packages/core/src/store/tasks-schema.ts (sessions table definition)
-- @see packages/core/src/store/db-helpers.ts (upsertSession)
-- @see packages/core/src/store/converters.ts (rowToSession)

ALTER TABLE `sessions` ADD COLUMN `agent_handle` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `scope_kind` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `scope_id` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `last_activity` text;
--> statement-breakpoint
CREATE INDEX `idx_sessions_agent_handle` ON `sessions` (`agent_handle`) WHERE `agent_handle` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_sessions_scope_kind_id` ON `sessions` (`scope_kind`, `scope_id`);
