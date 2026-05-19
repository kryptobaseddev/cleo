-- Revert T9686-B view extension. Restore the original new-pipeline-only view.
-- Views hold no data — recreating the prior shape has no data-loss risk.
--
-- @task T9686

DROP VIEW IF EXISTS `releases_view`;
--> statement-breakpoint
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
  END AS pr_metadata,
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
  ) AS commits_json,
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
  ) AS changes_json,
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
  ) AS artifacts_json,
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
  ) AS brain_links_json
FROM releases r
LEFT JOIN pull_requests pr ON pr.id = r.pr_id
GROUP BY r.id;
