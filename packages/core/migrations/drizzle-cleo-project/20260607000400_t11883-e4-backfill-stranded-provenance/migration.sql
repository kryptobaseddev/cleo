-- T11883 (E4) — Backfill stranded provenance rows from the BARE legacy tables
-- into the PREFIXED consolidated tables, with DHQ-068 enum coercions.
--
-- ## Why this exists
--
-- The exodus migration copies the bare provenance tables (`commits`,
-- `task_commits`, `releases`, …) into their prefixed equivalents (`tasks_commits`,
-- …). The prefixed tables carry the restored T11363 CHECK constraints that the
-- no-CHECK legacy tables never enforced (DHQ-068). A handful of legacy rows hold
-- values OUTSIDE those enums:
--   • `commits.conventional_type = 'style'`        (1 row — not a CC enum member)
--   • `task_commits.link_source  = 'commit-message'` (97 rows — the same bug E3
--     fixed in reconcile.ts; the valid member is 'commit-subject')
-- Because exodus copies in batched transactions, those CHECK-violating rows abort
-- their whole batch, stranding ~672 otherwise-valid rows in the bare tables. E5
-- drops the bare tables, so those rows must be recovered FIRST — this migration
-- copies every stranded bare row into the prefixed table, coercing the two
-- out-of-enum columns so the CHECK passes.
--
-- ## Safety / idempotency
--
-- • `INSERT OR IGNORE` — rows already present in the prefixed table (matched by
--   PK) are skipped, so re-running is a no-op; only the genuinely-stranded rows
--   are added.
-- • `defer_foreign_keys` + parents-first ordering (releases → release_*) so the
--   `tasks_release_*.release_id → tasks_releases.id` FKs resolve.
-- • The release-child inserts are guarded with `WHERE EXISTS (… tasks_releases)`
--   so a child whose parent release exists in NEITHER the prefixed table nor the
--   bare `releases` being copied is dropped cleanly (orphan) rather than aborting
--   the migration.
-- • Column lists are the bare∩prefixed intersection; no prefixed-only NOT NULL
--   column exists, so no synthetic defaults are needed.
--
-- @task T11883
-- @saga T11242

PRAGMA defer_foreign_keys = ON;

-- 1. releases (parent of release_*) — no coercion; all stranded values in-enum.
INSERT OR IGNORE INTO `tasks_releases` (
  id, version, scheme, channel, epic_id, release_kind, status, previous_version,
  merge_commit_sha, pr_id, workflow_run_url, created_at, planned_at, pr_opened_at,
  pr_merged_at, published_at, reconciled_at, rolled_back_at, failed_at, cancelled_at,
  failure_reason, rolled_back_by, project_hash, tasks_json, changelog, notes, git_tag,
  prepared_at, committed_at, tagged_at, pushed_at
)
SELECT
  id, version, scheme, channel, epic_id, release_kind, status, previous_version,
  merge_commit_sha, pr_id, workflow_run_url, created_at, planned_at, pr_opened_at,
  pr_merged_at, published_at, reconciled_at, rolled_back_at, failed_at, cancelled_at,
  failure_reason, rolled_back_by, project_hash, tasks_json, changelog, notes, git_tag,
  prepared_at, committed_at, tagged_at, pushed_at
FROM `releases`;

-- 2. commits — coerce out-of-enum conventional_type to NULL (the column is nullable).
INSERT OR IGNORE INTO `tasks_commits` (
  sha, short_sha, author_name, author_email, authored_at, committer_name,
  committer_email, committed_at, message, subject, conventional_type,
  is_release_commit, is_merge_commit, parent_shas, signature_verified,
  branch_at_commit, project_hash, created_at
)
SELECT
  sha, short_sha, author_name, author_email, authored_at, committer_name,
  committer_email, committed_at, message, subject,
  CASE
    WHEN conventional_type IN (
      'feat','fix','chore','docs','refactor','test','build','ci','perf','revert','breaking'
    ) THEN conventional_type
    ELSE NULL
  END,
  is_release_commit, is_merge_commit, parent_shas, signature_verified,
  branch_at_commit, project_hash, created_at
FROM `commits`;

-- 3. commit_files — change_type values (A/D/M/R) are all in-enum; no coercion.
INSERT OR IGNORE INTO `tasks_commit_files` (
  commit_sha, path, old_path, change_type, lines_added, lines_deleted, is_binary
)
SELECT
  commit_sha, path, old_path, change_type, lines_added, lines_deleted, is_binary
FROM `commit_files`;

-- 4. task_commits — coerce legacy link_source 'commit-message' → 'commit-subject'
--    (the valid COMMIT_LINK_SOURCES member); any other out-of-enum value → 'manual'.
INSERT OR IGNORE INTO `tasks_task_commits` (
  task_id, commit_sha, link_kind, link_source, created_at
)
SELECT
  task_id, commit_sha, link_kind,
  CASE
    WHEN link_source IN (
      'commit-trailer','commit-subject','pr-title','pr-body','branch-name','manual'
    ) THEN link_source
    WHEN link_source = 'commit-message' THEN 'commit-subject'
    ELSE 'manual'
  END,
  created_at
FROM `task_commits`;

-- 5. release_commits (child of releases) — guard FK on tasks_releases.
INSERT OR IGNORE INTO `tasks_release_commits` (
  release_id, commit_sha, position, is_first, is_last, is_release_chore
)
SELECT
  rc.release_id, rc.commit_sha, rc.position, rc.is_first, rc.is_last, rc.is_release_chore
FROM `release_commits` rc
WHERE EXISTS (SELECT 1 FROM `tasks_releases` r WHERE r.id = rc.release_id);

-- 6. release_changes (child of releases) — guard FK.
INSERT OR IGNORE INTO `tasks_release_changes` (
  id, release_id, task_id, change_type, summary, description, impact, classified_by, classified_at
)
SELECT
  c.id, c.release_id, c.task_id, c.change_type, c.summary, c.description, c.impact, c.classified_by, c.classified_at
FROM `release_changes` c
WHERE EXISTS (SELECT 1 FROM `tasks_releases` r WHERE r.id = c.release_id);

-- 7. release_artifacts (child of releases) — guard FK.
INSERT OR IGNORE INTO `tasks_release_artifacts` (
  release_id, artifact_type, identifier, version, url, published_at, metadata
)
SELECT
  a.release_id, a.artifact_type, a.identifier, a.version, a.url, a.published_at, a.metadata
FROM `release_artifacts` a
WHERE EXISTS (SELECT 1 FROM `tasks_releases` r WHERE r.id = a.release_id);

-- 8. brain_release_links (child of releases) — guard FK.
INSERT OR IGNORE INTO `tasks_brain_release_links` (
  brain_entry_id, release_id, link_type, created_at, created_by
)
SELECT
  l.brain_entry_id, l.release_id, l.link_type, l.created_at, l.created_by
FROM `brain_release_links` l
WHERE EXISTS (SELECT 1 FROM `tasks_releases` r WHERE r.id = l.release_id);
