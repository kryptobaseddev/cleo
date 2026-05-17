-- T9508 (1/3): Add `releases` table for provenance graph (ADR-073 / SPEC-T9345 §3.6).
--
-- Normalized release record — separate from the legacy `release_manifests` table.
-- The legacy table is PRESERVED as-is per F12 force (ADR-073). This table is the
-- new normalized fact; release_manifests stays as the in-flight scratchpad for the
-- 12-step pipeline.
--
-- ID format: '<projectHash>:<version>' (e.g., 'abc123def456:v2026.6.0').
-- status FSM (§10.1): planned → pr-opened → pr-merged → published → reconciled,
-- with rolled_back | failed | cancelled as terminal off-ramps.
--
-- FKs:
--   epic_id          → tasks(id)         ON DELETE SET NULL
--   merge_commit_sha → commits(sha)       ON DELETE SET NULL
--   pr_id            → pull_requests(id)  ON DELETE SET NULL  (table added by T9507)
--
-- All timestamps are ISO-8601 TEXT (matches existing convention). Booleans are
-- INTEGER NOT NULL DEFAULT 0 per SQLite idiom.
--
-- @task T9508
-- @epic T9491

CREATE TABLE `releases` (
  `id`                TEXT PRIMARY KEY NOT NULL,
  `version`           TEXT NOT NULL UNIQUE,
  `scheme`            TEXT NOT NULL DEFAULT 'calver',
  `channel`           TEXT NOT NULL DEFAULT 'latest',
  `epic_id`           TEXT REFERENCES `tasks`(`id`) ON DELETE SET NULL,
  `release_kind`      TEXT NOT NULL DEFAULT 'regular',
  `status`            TEXT NOT NULL DEFAULT 'planned',
  `previous_version`  TEXT,
  `merge_commit_sha`  TEXT REFERENCES `commits`(`sha`) ON DELETE SET NULL,
  `pr_id`             TEXT REFERENCES `pull_requests`(`id`) ON DELETE SET NULL,
  `workflow_run_url`  TEXT,
  `created_at`        TEXT NOT NULL DEFAULT (datetime('now')),
  `planned_at`        TEXT,
  `pr_opened_at`      TEXT,
  `pr_merged_at`      TEXT,
  `published_at`      TEXT,
  `reconciled_at`     TEXT,
  `rolled_back_at`    TEXT,
  `failed_at`         TEXT,
  `cancelled_at`      TEXT,
  `failure_reason`    TEXT,
  `rolled_back_by`    TEXT,
  `project_hash`      TEXT
);
--> statement-breakpoint

CREATE INDEX `idx_releases_version` ON `releases` (`version`);
--> statement-breakpoint
CREATE INDEX `idx_releases_status` ON `releases` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_releases_channel` ON `releases` (`channel`);
--> statement-breakpoint
CREATE INDEX `idx_releases_epic_id` ON `releases` (`epic_id`);
--> statement-breakpoint
CREATE INDEX `idx_releases_merge_commit_sha` ON `releases` (`merge_commit_sha`);
--> statement-breakpoint
CREATE INDEX `idx_releases_project_hash` ON `releases` (`project_hash`);
--> statement-breakpoint
CREATE INDEX `idx_releases_published_at` ON `releases` (`published_at`);
