-- T673-M4: New plasticity infrastructure tables
-- brain_weight_history: per-edge delta-w audit log (owner Q4 mandate -- 90-day rolling retention)
-- brain_modulators: R-STDP reward/correction/user_feedback event log
-- brain_consolidation_events: pipeline run audit for T628 auto-dream + manual consolidations
-- All IF NOT EXISTS -- safe to apply multiple times (idempotent).
-- Retention: brain_weight_history rows older than 90 days are swept by runConsolidation Step 9d.
-- Actual pruning wired in Wave 3 (T690 homeostatic decay per spec §4.2 Step 9d).

CREATE TABLE IF NOT EXISTS `brain_weight_history` (
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
  `changed_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_weight_history_edge` ON `brain_weight_history` (`edge_from_id`, `edge_to_id`, `edge_type`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_weight_history_from` ON `brain_weight_history` (`edge_from_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_weight_history_to` ON `brain_weight_history` (`edge_to_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_weight_history_changed_at` ON `brain_weight_history` (`changed_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_weight_history_event_kind` ON `brain_weight_history` (`event_kind`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_weight_history_plasticity_event` ON `brain_weight_history` (`source_plasticity_event_id`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `brain_modulators` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `modulator_type` text NOT NULL,
  `valence` real NOT NULL,
  `magnitude` real NOT NULL DEFAULT 1.0,
  `source_event_id` text,
  `session_id` text,
  `description` text,
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_modulators_type` ON `brain_modulators` (`modulator_type`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_modulators_session` ON `brain_modulators` (`session_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_modulators_created_at` ON `brain_modulators` (`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_modulators_source_event` ON `brain_modulators` (`source_event_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_modulators_valence` ON `brain_modulators` (`valence`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `brain_consolidation_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `trigger` text NOT NULL,
  `session_id` text,
  `step_results_json` text NOT NULL,
  `duration_ms` integer,
  `succeeded` integer NOT NULL DEFAULT 1,
  `started_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_consolidation_events_started_at` ON `brain_consolidation_events` (`started_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_consolidation_events_trigger` ON `brain_consolidation_events` (`trigger`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_consolidation_events_session` ON `brain_consolidation_events` (`session_id`);
