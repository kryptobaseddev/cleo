-- T9686-B2: Unify `release_manifests` (T5580) and `releases` (T9508) into a
-- single canonical `releases` table. Drops the legacy table and the
-- `releases_view` bridge (T9510, T9686-B).
--
-- Background: the codebase carried two parallel release-state tables —
-- `release_manifests` (legacy 12-step pipeline, statuses: draft/prepared/
-- committed/tagged/pushed/rolled_back) and `releases` (new T9492 pipeline,
-- statuses: planned/pr-opened/pr-merged/published/reconciled/...). Writers
-- targeted the new table; readers (`cleo release show`, `cleo release list`)
-- targeted the legacy table; a SQL view bridged the two for read paths.
-- This migration eliminates the dual-source-of-truth by merging every
-- legacy column + every legacy row into the new table, then dropping the
-- legacy table and the bridge view.
--
-- Status enum is widened to the union of both lifecycles (12 values) so no
-- information is lost — the status value itself discriminates which
-- pipeline owns each row (e.g., `prepared` → legacy, `planned` → new).
--
-- Legacy-row PKs are rewritten to `legacy:<version>` (deterministic, no
-- project-hash dependency, makes provenance explicit). The single existing
-- new-pipeline row keeps its `<projectHash>:<version>` PK unchanged.
--
-- `merge_commit_sha` loses its FK to `commits(sha)` — legacy ship SHAs
-- aren't tracked in the `commits` table, and a hard FK would either force
-- nulling out ~12-15 legacy SHA links or block the copy. The column stays
-- as a soft text reference (consistent with `pr_id`, which is also a soft
-- FK pending T9507 table availability). A follow-up task may backfill
-- `commits` rows for legacy ship SHAs to re-enable referential integrity.
--
-- DESTRUCTIVE: downgrade past this migration cannot split `legacy:*` rows
-- back into a separate `release_manifests` table without manual SQL.
-- `revert.sql` recreates the empty shell + the prior view only.
--
-- @task T9686
-- @epic T9499
-- @see SPEC-T9345 §3.6 (the new `releases` table)
-- @see /mnt/projects/cleocode/packages/core/src/store/tasks-schema.ts (legacy schema)

PRAGMA foreign_keys=OFF;
--> statement-breakpoint

-- ── Step 1: Drop the bridge view ──────────────────────────────────────────
-- Added by T9510 (new-only) and extended to UNION legacy by T9686-B.
-- The unified table makes the view redundant.
DROP VIEW IF EXISTS `releases_view`;
--> statement-breakpoint

-- ── Step 2: Add legacy-only columns to `releases` ─────────────────────────
-- All nullable — new-pipeline rows leave them NULL; legacy rows populate them.
-- `pipeline_id` and `npm_dist_tag` are NOT carried over — both are dead
-- columns (zero callers in src; empty in every live row).
ALTER TABLE `releases` ADD COLUMN `tasks_json` TEXT;
--> statement-breakpoint
ALTER TABLE `releases` ADD COLUMN `changelog` TEXT;
--> statement-breakpoint
ALTER TABLE `releases` ADD COLUMN `notes` TEXT;
--> statement-breakpoint
ALTER TABLE `releases` ADD COLUMN `git_tag` TEXT;
--> statement-breakpoint
ALTER TABLE `releases` ADD COLUMN `prepared_at` TEXT;
--> statement-breakpoint
ALTER TABLE `releases` ADD COLUMN `committed_at` TEXT;
--> statement-breakpoint
ALTER TABLE `releases` ADD COLUMN `tagged_at` TEXT;
--> statement-breakpoint
ALTER TABLE `releases` ADD COLUMN `pushed_at` TEXT;
--> statement-breakpoint

-- ── Step 3: Drop the merge_commit_sha FK ──────────────────────────────────
-- SQLite can't ALTER a constraint in place; rebuild the table without the FK.
-- All other FKs (epic_id → tasks.id, pr_id → soft FK already) are preserved.
-- All junction tables (release_commits, release_changes, release_artifacts,
-- brain_release_links) reference `releases(id)` by name — they continue to
-- resolve to the rebuilt table after RENAME.
CREATE TABLE `releases_rebuilt` (
  `id`                TEXT PRIMARY KEY NOT NULL,
  `version`           TEXT NOT NULL UNIQUE,
  `scheme`            TEXT NOT NULL DEFAULT 'calver',
  `channel`           TEXT NOT NULL DEFAULT 'latest',
  `epic_id`           TEXT REFERENCES `tasks`(`id`) ON DELETE SET NULL,
  `release_kind`      TEXT NOT NULL DEFAULT 'regular',
  `status`            TEXT NOT NULL DEFAULT 'planned',
  `previous_version`  TEXT,
  `merge_commit_sha`  TEXT,                       -- soft FK (was: REFERENCES commits(sha))
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
  -- Legacy columns (added in Step 2; kept here in the rebuild so column-order
  -- matches a fresh-install schema):
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

-- ── Step 4: Recreate indexes on the rebuilt table ─────────────────────────
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

-- ── Step 5: Copy legacy rows into the unified table ───────────────────────
-- One row per legacy `release_manifests` entry, with:
--   - PK rewritten to 'legacy:<version>' for deterministic provenance
--   - status copied verbatim (the widened enum admits all legacy values)
--   - commit_sha → merge_commit_sha (lifted into the canonical column)
--   - scheme defaulted to 'calver' (legacy didn't track scheme; all are calver)
--   - channel defaulted to 'latest' (legacy didn't track channel; new pipeline
--     never operated on legacy rows so defaulting is safe)
--   - release_kind defaulted to 'regular' (legacy didn't model this axis)
--   - project_hash NULL (legacy didn't track; backfill is a follow-up task)
-- Skip any row whose version already exists in `releases` — defensive
-- against the retired dual-write window. The NOT EXISTS guard makes the
-- migration replay-safe (idempotent re-runs are a no-op).
INSERT INTO `releases` (
  `id`, `version`, `scheme`, `channel`, `epic_id`, `release_kind`, `status`,
  `previous_version`, `merge_commit_sha`, `created_at`,
  `tasks_json`, `changelog`, `notes`, `git_tag`,
  `prepared_at`, `committed_at`, `tagged_at`, `pushed_at`
)
SELECT
  'legacy:' || rm.`version`        AS `id`,
  rm.`version`                     AS `version`,
  'calver'                         AS `scheme`,
  'latest'                         AS `channel`,
  rm.`epic_id`                     AS `epic_id`,
  'regular'                        AS `release_kind`,
  rm.`status`                      AS `status`,
  rm.`previous_version`            AS `previous_version`,
  rm.`commit_sha`                  AS `merge_commit_sha`,
  rm.`created_at`                  AS `created_at`,
  rm.`tasks_json`                  AS `tasks_json`,
  rm.`changelog`                   AS `changelog`,
  rm.`notes`                       AS `notes`,
  rm.`git_tag`                     AS `git_tag`,
  rm.`prepared_at`                 AS `prepared_at`,
  rm.`committed_at`                AS `committed_at`,
  rm.`tagged_at`                   AS `tagged_at`,
  rm.`pushed_at`                   AS `pushed_at`
FROM `release_manifests` rm
WHERE NOT EXISTS (
  SELECT 1 FROM `releases` r WHERE r.`version` = rm.`version`
);
--> statement-breakpoint

-- ── Step 6: Drop the legacy table ─────────────────────────────────────────
-- After this point, `release_manifests` no longer exists. Any code that
-- still references `schema.releaseManifests` will fail at query time. The
-- TypeScript sweep landing in this PR removes every such reference.
DROP TABLE `release_manifests`;
--> statement-breakpoint

PRAGMA foreign_keys=ON;
