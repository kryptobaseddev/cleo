-- T10570 — Add acceptance projection freshness state and dirty queue.
--
-- PM-Core V2 treats task_acceptance_criteria as a derived projection from typed
-- completion criteria sources. The projection needs durable freshness metadata,
-- a coalescing dirty queue, indexed freshness scan paths, and an explicit schema
-- version row so rebuilders can invalidate rows after projection-shape changes.
--
-- @saga T10538
-- @task T10570

CREATE TABLE IF NOT EXISTS `acceptance_projection_state` (
  `projection_key` TEXT PRIMARY KEY NOT NULL,
  `schema_version` INTEGER NOT NULL DEFAULT 1,
  `status` TEXT NOT NULL DEFAULT 'fresh' CHECK (`status` IN ('fresh', 'stale', 'rebuilding')),
  `last_projected_at` TEXT,
  `last_source_updated_at` TEXT,
  `source_fingerprint` TEXT,
  `created_at` TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  `updated_at` TEXT
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_acceptance_projection_state_status_freshness`
  ON `acceptance_projection_state` (`status`, `last_source_updated_at`, `last_projected_at`);
--> statement-breakpoint

INSERT OR IGNORE INTO `acceptance_projection_state` (
  `projection_key`,
  `schema_version`,
  `status`,
  `last_projected_at`,
  `last_source_updated_at`
)
VALUES (
  'task_acceptance',
  1,
  'fresh',
  CURRENT_TIMESTAMP,
  (SELECT COALESCE(MAX(COALESCE(`updated_at`, `created_at`)), CURRENT_TIMESTAMP) FROM `task_acceptance_criteria`)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `acceptance_projection_dirty` (
  `projection_key` TEXT NOT NULL REFERENCES `acceptance_projection_state`(`projection_key`) ON DELETE CASCADE,
  `task_id` TEXT NOT NULL REFERENCES `tasks`(`id`) ON DELETE CASCADE,
  `reason` TEXT NOT NULL DEFAULT 'manual_rebuild' CHECK (`reason` IN ('task_acceptance_changed', 'task_reparented', 'child_completion_changed', 'manual_rebuild')),
  `source_updated_at` TEXT,
  `queued_at` TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  `payload_json` TEXT,
  PRIMARY KEY (`projection_key`, `task_id`)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_acceptance_projection_dirty_task_id`
  ON `acceptance_projection_dirty` (`task_id`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_acceptance_projection_dirty_queued_at`
  ON `acceptance_projection_dirty` (`queued_at`);
