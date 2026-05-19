-- T9686-B: Extend `releases_view` to UNION the legacy `release_manifests` rows.
--
-- Background: prior to this migration `releases_view` was `FROM releases r`
-- only. Pre-T9492 releases (cut via the old `release prepare`/`ship` pipeline)
-- live in `release_manifests` and were invisible to the view, so
-- `cleo release show <legacy-version>` and `cleo release list` had to read
-- the legacy table directly. That created a dual-source-of-truth: the new
-- `plan` op wrote `releases`, but consumers read `release_manifests`, so
-- `plan v2026.5.99 → show v2026.5.99` failed with E_NOT_FOUND even though
-- the row was correctly upserted.
--
-- This migration rebuilds the view as a UNION ALL of:
--   1. NEW rows from `releases` (T9508 provenance graph) — full provenance.
--   2. LEGACY rows from `release_manifests` (T5580) — flattened into the
--      same columns with NULLs where not applicable.
--
-- A new `source` column ('new' | 'legacy') lets callers distinguish provenance
-- when needed. The legacy rows expose empty JSON arrays for the relational
-- columns (`commits_json`, `changes_json`, `artifacts_json`, `brain_links_json`,
-- `pr_metadata`) so the row shape is identical.
--
-- The view is recreated via DROP+CREATE because SQLite does not support
-- CREATE OR REPLACE VIEW. Views hold no data, so this is safe.
--
-- @task T9686
-- @epic T9499
-- @see SPEC-T9345 §3.12

DROP VIEW IF EXISTS `releases_view`;
--> statement-breakpoint
CREATE VIEW `releases_view` AS
-- ── Branch 1: NEW pipeline rows from `releases` ─────────────────────────────
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
  'new'                 AS source,

  -- PR metadata (single PR per release, joined via releases.pr_id).
  -- Returns a json_object when a PR exists, NULL when pr_id is NULL.
  CASE
    WHEN pr.id IS NOT NULL THEN json_object(
      'id',              pr.id,
      'pr_number',       pr.pr_number,
      'title',           pr.title,
      'state',           pr.state,
      'base_ref',        pr.base_ref,
      'head_ref',        pr.head_ref,
      'author_login',    pr.author_login,
      'opened_at',       pr.opened_at,
      'merged_at',       pr.merged_at
    )
    ELSE NULL
  END                   AS pr_metadata,

  -- Commits in this release range (one json_object per release_commits row).
  (
    SELECT json_group_array(
      json_object(
        'sha',     c.sha,
        'subject', c.subject,
        'position', rc.position,
        'is_first', rc.is_first,
        'is_last',  rc.is_last
      )
    )
    FROM release_commits rc
    LEFT JOIN commits c ON c.sha = rc.commit_sha
    WHERE rc.release_id = r.id
  )                     AS commits_json,

  -- Release changes (CHANGELOG entries) with linked task info.
  (
    SELECT json_group_array(
      json_object(
        'id',          rch.id,
        'task_id',     rch.task_id,
        'change_type', rch.change_type,
        'summary',     rch.summary,
        'impact',      rch.impact,
        'classified_by', rch.classified_by
      )
    )
    FROM release_changes rch
    WHERE rch.release_id = r.id
  )                     AS changes_json,

  -- Artifacts published for this release (npm, cargo, docker, etc.).
  (
    SELECT json_group_array(
      json_object(
        'artifact_type', ra.artifact_type,
        'identifier',    ra.identifier,
        'version',       ra.version,
        'url',           ra.url,
        'published_at',  ra.published_at
      )
    )
    FROM release_artifacts ra
    WHERE ra.release_id = r.id
  )                     AS artifacts_json,

  -- BRAIN links closing the BRAIN↔release loop.
  (
    SELECT json_group_array(
      json_object(
        'brain_entry_id', brl.brain_entry_id,
        'link_type',      brl.link_type,
        'created_by',     brl.created_by,
        'created_at',     brl.created_at
      )
    )
    FROM brain_release_links brl
    WHERE brl.release_id = r.id
  )                     AS brain_links_json,

  -- Legacy-only columns (NULL for new pipeline rows).
  NULL                  AS tasks_json,
  NULL                  AS notes,
  NULL                  AS changelog,
  NULL                  AS git_tag,
  NULL                  AS npm_dist_tag,
  NULL                  AS prepared_at,
  NULL                  AS committed_at,
  NULL                  AS tagged_at,
  NULL                  AS pushed_at

FROM releases r
LEFT JOIN pull_requests pr ON pr.id = r.pr_id

UNION ALL

-- ── Branch 2: LEGACY rows from `release_manifests` ──────────────────────────
-- Only include legacy rows whose version is NOT already present in `releases`.
-- This prevents duplicate rows when a release was dual-written during the
-- T9510 dual-write window (CLEO_PROVENANCE_DUAL_WRITE).
SELECT
  'legacy:' || rm.id    AS release_id,
  rm.version,
  'calver'              AS scheme,
  -- Map legacy `npm_dist_tag` to channel; fall back to 'latest'.
  COALESCE(
    CASE WHEN rm.npm_dist_tag IN ('latest','beta','dev','hotfix') THEN rm.npm_dist_tag END,
    'latest'
  )                     AS channel,
  rm.epic_id,
  'regular'             AS release_kind,
  rm.status,
  rm.previous_version,
  rm.commit_sha         AS merge_commit_sha,
  NULL                  AS pr_id,
  NULL                  AS workflow_run_url,
  rm.created_at,
  NULL                  AS planned_at,
  NULL                  AS pr_opened_at,
  NULL                  AS pr_merged_at,
  rm.pushed_at          AS published_at,
  NULL                  AS reconciled_at,
  NULL                  AS rolled_back_at,
  NULL                  AS failed_at,
  NULL                  AS cancelled_at,
  NULL                  AS failure_reason,
  NULL                  AS rolled_back_by,
  NULL                  AS project_hash,
  'legacy'              AS source,
  NULL                  AS pr_metadata,
  '[]'                  AS commits_json,
  '[]'                  AS changes_json,
  '[]'                  AS artifacts_json,
  '[]'                  AS brain_links_json,
  rm.tasks_json,
  rm.notes,
  rm.changelog,
  rm.git_tag,
  rm.npm_dist_tag,
  rm.prepared_at,
  rm.committed_at,
  rm.tagged_at,
  rm.pushed_at
FROM release_manifests rm
WHERE NOT EXISTS (
  SELECT 1 FROM releases r2 WHERE r2.version = rm.version
);
