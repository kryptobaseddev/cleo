-- Revert T9686-B2 unification — BEST-EFFORT ONLY.
--
-- DESTRUCTIVE LOSS: this revert recreates an empty `release_manifests` shell
-- and the prior `releases_view`, but cannot split `legacy:*` rows out of
-- `releases` back into `release_manifests` without manual SQL. Operators
-- who downgrade past this point will lose the canonical source of pre-T9492
-- release history unless they have a backup of `release_manifests` from
-- before the unification migration ran.
--
-- This file exists so the Drizzle revert pipeline has a syntactically valid
-- script to apply on rollback, NOT because the unification is reversible in
-- a data-preserving way. The owner mandate that authorized this migration
-- accepted the irreversibility explicitly.
--
-- @task T9686

PRAGMA foreign_keys=OFF;
--> statement-breakpoint

-- Recreate the legacy table shell (empty — no rows restored).
CREATE TABLE IF NOT EXISTS `release_manifests` (
  `id`               TEXT PRIMARY KEY NOT NULL,
  `version`          TEXT NOT NULL UNIQUE,
  `status`           TEXT NOT NULL DEFAULT 'draft',
  `pipeline_id`      TEXT REFERENCES `lifecycle_pipelines`(`id`) ON DELETE SET NULL,
  `epic_id`          TEXT REFERENCES `tasks`(`id`) ON DELETE SET NULL,
  `tasks_json`       TEXT NOT NULL DEFAULT '[]',
  `changelog`        TEXT,
  `notes`            TEXT,
  `previous_version` TEXT,
  `commit_sha`       TEXT,
  `git_tag`          TEXT,
  `npm_dist_tag`     TEXT,
  `created_at`       TEXT NOT NULL,
  `prepared_at`      TEXT,
  `committed_at`     TEXT,
  `tagged_at`        TEXT,
  `pushed_at`        TEXT
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_release_manifests_status` ON `release_manifests` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_release_manifests_version` ON `release_manifests` (`version`);
--> statement-breakpoint

-- Recreate the prior `releases_view` (new-pipeline-only shape from T9510).
-- Skipping the UNION-with-legacy form from the T9686-B view because it
-- references `release_manifests` which is now empty after revert.
CREATE VIEW IF NOT EXISTS `releases_view` AS
SELECT
  r.id                  AS release_id,
  r.version,
  r.scheme,
  r.channel,
  r.epic_id,
  r.release_kind,
  r.status,
  r.previous_version,
  r.merge_commit_sha,
  r.pr_id,
  r.workflow_run_url,
  r.created_at,
  r.planned_at,
  r.pr_opened_at,
  r.pr_merged_at,
  r.published_at,
  r.reconciled_at,
  r.rolled_back_at,
  r.failed_at,
  r.cancelled_at,
  r.failure_reason,
  r.rolled_back_by,
  r.project_hash,
  NULL                  AS pr_metadata,
  '[]'                  AS commits_json,
  '[]'                  AS changes_json,
  '[]'                  AS artifacts_json,
  '[]'                  AS brain_links_json
FROM releases r;
--> statement-breakpoint

-- Note: the legacy columns added in Step 2 (`tasks_json`, `changelog`,
-- `notes`, `git_tag`, `prepared_at`, `committed_at`, `tagged_at`,
-- `pushed_at`) remain on the `releases` table after revert. Stripping them
-- via table-rebuild is a no-op for new-pipeline rows (they're already NULL
-- there) and would destroy data on the unified rows. The revert leaves
-- them in place — they're harmless if unread.

PRAGMA foreign_keys=ON;
