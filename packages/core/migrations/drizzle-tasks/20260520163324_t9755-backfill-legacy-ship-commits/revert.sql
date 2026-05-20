-- Revert T9755 — drop the `merge_commit_sha` FK on `releases` and DELETE
-- the 18 backfilled commit rows.
--
-- This restores the post-T9686-B2 / pre-T9755 state:
--   - `releases.merge_commit_sha` is a soft TEXT column with no FK
--   - the 18 legacy v5.x ship/merge commits are absent from `commits`
--
-- Operators who downgrade past this point and then re-apply the migration
-- will repopulate the same 18 rows (idempotent via ON CONFLICT DO NOTHING).
--
-- Backfilled SHAs (for auditability — these are the rows DELETEd below):
--   v5.80 PR merge:  9f1eac565d44818f7c803e3327aaed4d5d830c67
--   v5.80 ship:      1e1f2302b1ad5ed764206f573b6ca07d638cfa5b
--   v5.81 PR merge:  572630ee6a54b94a904ae6c79a7a86fc3a5054b0
--   v5.81 ship:      f2b2466bf9f5f53c5ab6f619a30490621c27e903
--   v5.82 PR merge:  101c0eb6f637cdc92165ade04ceef58f8f4dd014
--   v5.82 ship:      1386636d32bfd58d90d900e2636c02cc939025a8
--   v5.83 PR merge:  6607fc2cd09f0bd700bf6bdbcc7d7aac75873b4d
--   v5.83 ship:      5638ac5f567a9420c9c18b356ed1640f4236f526
--   v5.84 PR merge:  bd4bba8f654722a0e4ebd491bbb8b500cf8ae4d0
--   v5.84 ship:      1867e9778f7c02807d543435dd6bd29fc89abddd
--   v5.85 PR merge:  856353ebe45a4904e461fe00f326bd83d863ded8
--   v5.85 ship:      018b2cd7d36c0edde68234544834d9bc076c08d8
--   v5.86 PR merge:  85fa011fb08eb4e49f94be4ac92071e5b7f80b6e
--   v5.86 ship:      8a0a0131a536730a0017cf9de056d18f4a86e800
--   v5.87 PR merge:  422ff7353365f7e3ab5b2e1b7ca824e0b486ded6
--   v5.87 ship:      d36146b979ed0c50b4275400074188dabce79c86
--   v5.88 PR squash: 23dc2cc5e10176697f14f172c4ee5b94937fd7fc
--   v5.88 ship:      ebee726e5318d3cd7407310d0c44c0b53ead392b
--
-- @task T9755

PRAGMA foreign_keys=OFF;
--> statement-breakpoint

-- ── Step 1: Re-drop the FK via table rebuild ──────────────────────────────
-- This is the inverse of migration.sql Step 2 — recreate the table WITHOUT
-- the merge_commit_sha REFERENCES clause, then copy + drop + rename.
CREATE TABLE `releases_rebuilt` (
  `id`                TEXT PRIMARY KEY NOT NULL,
  `version`           TEXT NOT NULL UNIQUE,
  `scheme`            TEXT NOT NULL DEFAULT 'calver',
  `channel`           TEXT NOT NULL DEFAULT 'latest',
  `epic_id`           TEXT REFERENCES `tasks`(`id`) ON DELETE SET NULL,
  `release_kind`      TEXT NOT NULL DEFAULT 'regular',
  `status`            TEXT NOT NULL DEFAULT 'planned',
  `previous_version`  TEXT,
  `merge_commit_sha`  TEXT,                       -- soft FK restored (revert of T9755)
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
  `project_hash`      TEXT,
  `tasks_json`        TEXT,
  `changelog`         TEXT,
  `notes`             TEXT,
  `git_tag`           TEXT,
  `prepared_at`       TEXT,
  `committed_at`      TEXT,
  `tagged_at`         TEXT,
  `pushed_at`         TEXT
);
--> statement-breakpoint

INSERT INTO `releases_rebuilt` (
  `id`, `version`, `scheme`, `channel`, `epic_id`, `release_kind`, `status`,
  `previous_version`, `merge_commit_sha`, `pr_id`, `workflow_run_url`,
  `created_at`, `planned_at`, `pr_opened_at`, `pr_merged_at`, `published_at`,
  `reconciled_at`, `rolled_back_at`, `failed_at`, `cancelled_at`,
  `failure_reason`, `rolled_back_by`, `project_hash`,
  `tasks_json`, `changelog`, `notes`, `git_tag`,
  `prepared_at`, `committed_at`, `tagged_at`, `pushed_at`
)
SELECT
  `id`, `version`, `scheme`, `channel`, `epic_id`, `release_kind`, `status`,
  `previous_version`, `merge_commit_sha`, `pr_id`, `workflow_run_url`,
  `created_at`, `planned_at`, `pr_opened_at`, `pr_merged_at`, `published_at`,
  `reconciled_at`, `rolled_back_at`, `failed_at`, `cancelled_at`,
  `failure_reason`, `rolled_back_by`, `project_hash`,
  `tasks_json`, `changelog`, `notes`, `git_tag`,
  `prepared_at`, `committed_at`, `tagged_at`, `pushed_at`
FROM `releases`;
--> statement-breakpoint

DROP TABLE `releases`;
--> statement-breakpoint

ALTER TABLE `releases_rebuilt` RENAME TO `releases`;
--> statement-breakpoint

-- Recreate the same indexes the migration set up.
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
--> statement-breakpoint
CREATE INDEX `idx_releases_pushed_at` ON `releases` (`pushed_at`);
--> statement-breakpoint

-- ── Step 2: DELETE the 18 backfilled commit rows ──────────────────────────
DELETE FROM `commits` WHERE `sha` IN (
  '9f1eac565d44818f7c803e3327aaed4d5d830c67',
  '1e1f2302b1ad5ed764206f573b6ca07d638cfa5b',
  '572630ee6a54b94a904ae6c79a7a86fc3a5054b0',
  'f2b2466bf9f5f53c5ab6f619a30490621c27e903',
  '101c0eb6f637cdc92165ade04ceef58f8f4dd014',
  '1386636d32bfd58d90d900e2636c02cc939025a8',
  '6607fc2cd09f0bd700bf6bdbcc7d7aac75873b4d',
  '5638ac5f567a9420c9c18b356ed1640f4236f526',
  'bd4bba8f654722a0e4ebd491bbb8b500cf8ae4d0',
  '1867e9778f7c02807d543435dd6bd29fc89abddd',
  '856353ebe45a4904e461fe00f326bd83d863ded8',
  '018b2cd7d36c0edde68234544834d9bc076c08d8',
  '85fa011fb08eb4e49f94be4ac92071e5b7f80b6e',
  '8a0a0131a536730a0017cf9de056d18f4a86e800',
  '422ff7353365f7e3ab5b2e1b7ca824e0b486ded6',
  'd36146b979ed0c50b4275400074188dabce79c86',
  '23dc2cc5e10176697f14f172c4ee5b94937fd7fc',
  'ebee726e5318d3cd7407310d0c44c0b53ead392b'
);
--> statement-breakpoint

PRAGMA foreign_keys=ON;
