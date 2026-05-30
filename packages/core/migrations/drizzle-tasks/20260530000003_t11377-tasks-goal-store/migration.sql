-- T11377 — DB-persisted per-agent goal store (tasks_goal table).
--
-- Layer 4 of SG-COGNITIVE-SUBSTRATE: a DB-persisted, per-agent, turn-budgeted
-- goal record that survives process restart. Pattern A (ADR-068) — lives inside
-- tasks.db (no new file), domain-prefixed table name, idempotency_key TEXT PK
-- so a re-issued create coalesces via INSERT OR IGNORE / onConflictDoNothing.
--
-- Per-agent isolation: session_id + agent_id columns hold the resolved E0
-- identity (resolveSessionIdFromEnv / resolveAgentIdFromEnv). The owner-active
-- index serves the dominant "active goal for THIS agent" lookup so two
-- concurrent agents never collide on one global row.
--
-- criteria + goal_kind + last_verdict are JSONB BLOBs (binary, in-SQL-queryable)
-- written via the jsonb() constructor and read whole through json(col) — never
-- JSON.parse-d raw (the on-disk JSONB encoding is version-unstable).
--
-- Changes (idempotent — safe to re-run; CREATE ... IF NOT EXISTS):
--   1. CREATE TABLE tasks_goal — the per-agent goal record.
--   2. CREATE INDEX idx_tasks_goal_owner_active — (session_id, agent_id, status)
--      for getActiveGoal.
--   3. CREATE INDEX idx_tasks_goal_parent — sub-goal traversal by parent_goal_id.
--
-- @task T11377
-- @epic T11290
-- @saga T11283

CREATE TABLE IF NOT EXISTS `tasks_goal` (
  `idempotency_key` text PRIMARY KEY NOT NULL,
  `session_id` text,
  `agent_id` text,
  `parent_goal_id` text,
  `goal_kind` blob NOT NULL,
  `intent` text NOT NULL,
  `criteria` blob DEFAULT (jsonb('[]')) NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `turn_budget` integer NOT NULL,
  `turns_used` integer DEFAULT 0 NOT NULL,
  `paused_reason` text,
  `last_verdict` blob,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_tasks_goal_owner_active`
  ON `tasks_goal` (`session_id`, `agent_id`, `status`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_tasks_goal_parent`
  ON `tasks_goal` (`parent_goal_id`);
