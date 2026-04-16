-- T673-M2: Expand brain_plasticity_events with observability columns.
--
-- Adds 5 new nullable columns to brain_plasticity_events:
--   weight_before  — edge weight immediately before this event
--   weight_after   — edge weight immediately after this event
--   retrieval_log_id — soft FK to brain_retrieval_log.id (causal trace)
--   reward_signal  — R-STDP reward signal at time of event
--   delta_t_ms     — Δt in ms between the two spikes that generated this event
--
-- Safety: table currently has 0 rows so all new nullable columns have no data impact.
-- New INSERT statements in brain-stdp.ts MUST populate these columns going forward.
--
-- SAFETY: brain_plasticity_events is not in the initial migration — it was created
-- only via self-healing DDL in brain-sqlite.ts. On a fresh DB this migration
-- runs before the self-healing code. CREATE TABLE IF NOT EXISTS ensures the
-- table exists so the ALTER TABLE statements below can succeed.
--
-- Per docs/specs/stdp-wire-up-spec.md §2.1.2 and T673-council-schema.md §4.2.

CREATE TABLE IF NOT EXISTS `brain_plasticity_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `source_node` text NOT NULL,
  `target_node` text NOT NULL,
  `delta_w` real NOT NULL,
  `kind` text NOT NULL,
  `timestamp` text NOT NULL DEFAULT (datetime('now')),
  `session_id` text
);
--> statement-breakpoint

ALTER TABLE `brain_plasticity_events` ADD COLUMN `weight_before` real;
--> statement-breakpoint
ALTER TABLE `brain_plasticity_events` ADD COLUMN `weight_after` real;
--> statement-breakpoint
ALTER TABLE `brain_plasticity_events` ADD COLUMN `retrieval_log_id` integer;
--> statement-breakpoint
ALTER TABLE `brain_plasticity_events` ADD COLUMN `reward_signal` real;
--> statement-breakpoint
ALTER TABLE `brain_plasticity_events` ADD COLUMN `delta_t_ms` integer;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_plasticity_retrieval_log` ON `brain_plasticity_events` (`retrieval_log_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_plasticity_reward` ON `brain_plasticity_events` (`reward_signal`);
