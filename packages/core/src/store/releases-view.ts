/**
 * Typed helper for the `releases_view` SQL view.
 *
 * The view joins all 11 provenance graph tables (commits, task_commits,
 * commit_files, pull_requests, pr_commits, pr_tasks, releases, release_commits,
 * release_changes, release_artifacts, brain_release_links) into one row per
 * release with JSON-encoded arrays for dashboard consumers.
 *
 * Drizzle ORM v1 view support is limited; the view is managed as raw migration
 * SQL (migration 20260516000011_t9510-add-releases-view) and queried via the
 * helpers exported from this module.
 *
 * @task T9510
 * @epic T9491
 * @see SPEC-T9345 §3.12
 */

import { sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';

// ── Sub-shapes (parsed from JSON columns) ─────────────────────────────────────

/** One commit row from the `commits_json` array. */
export interface ReleasesViewCommit {
  /** Full 40-char git SHA. */
  sha: string;
  /** First line of the commit message. */
  subject: string;
  /** Topo-sorted position within the release range (0 = oldest). */
  position: number;
  /** 1 if this is the first commit after the previous release boundary. */
  is_first: number;
  /** 1 if this is the tag/merge commit that closed the release. */
  is_last: number;
}

/** One change entry from the `changes_json` array. */
export interface ReleasesViewChange {
  /** UUID primary key of the release_changes row. */
  id: string;
  /** Linked CLEO task ID. NULL for non-task-linked changes. */
  task_id: string | null;
  /** CLEO 12-value change taxonomy (e.g. 'feature', 'bug', 'chore'). */
  change_type: string;
  /** User-facing one-liner summary (≤ 200 chars) for the CHANGELOG. */
  summary: string;
  /** Semver bump impact ('major' | 'minor' | 'patch' | 'none'). */
  impact: string;
  /** Classification provenance ('auto' | 'manual' | 'approved'). */
  classified_by: string;
}

/** One artifact entry from the `artifacts_json` array. */
export interface ReleasesViewArtifact {
  /** Artifact archetype (e.g. 'npm', 'cargo', 'docker', 'github-tag'). */
  artifact_type: string;
  /** Artifact-specific identifier (e.g. '@cleocode/cleo', 'cleo-core'). */
  identifier: string;
  /** Published version string. */
  version: string;
  /** Registry URL or download URL. Null when not applicable. */
  url: string | null;
  /** ISO-8601 timestamp when the artifact was published. */
  published_at: string | null;
}

/** PR metadata from the `pr_metadata` column. */
export interface ReleasesViewPr {
  /** Composite PK: `<projectHash>:<prNumber>`. */
  id: string;
  /** GitHub PR number. */
  pr_number: number;
  /** PR title. */
  title: string;
  /** PR state ('open' | 'closed' | 'merged'). */
  state: string;
  /** Target branch name (e.g. 'main'). */
  base_ref: string;
  /** Source branch name (e.g. 'release/v2026.5.74'). */
  head_ref: string;
  /** GitHub login of the PR author. */
  author_login: string | null;
  /** ISO-8601 timestamp when the PR was opened. */
  opened_at: string;
  /** ISO-8601 timestamp when the PR was merged. Null if not merged. */
  merged_at: string | null;
}

/** One BRAIN link from the `brain_links_json` array. */
export interface ReleasesViewBrainLink {
  /** Soft FK into `brain.db` entries. Null if the BRAIN entry was deleted. */
  brain_entry_id: string | null;
  /** Semantic relationship ('approved-by' | 'documented-in' | 'derived-from' | 'observed-in'). */
  link_type: string;
  /** Agent or user identity that created the link. */
  created_by: string | null;
  /** ISO-8601 timestamp when the link was created. */
  created_at: string;
}

// ── Raw row (before JSON parsing) ─────────────────────────────────────────────

/** Raw row returned by `SELECT * FROM releases_view` before JSON parse. */
interface ReleasesViewRawRow {
  release_id: string;
  version: string;
  scheme: string;
  channel: string;
  epic_id: string | null;
  release_kind: string;
  status: string;
  previous_version: string | null;
  merge_commit_sha: string | null;
  pr_id: string | null;
  workflow_run_url: string | null;
  created_at: string;
  planned_at: string | null;
  pr_opened_at: string | null;
  pr_merged_at: string | null;
  published_at: string | null;
  reconciled_at: string | null;
  rolled_back_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  failure_reason: string | null;
  rolled_back_by: string | null;
  project_hash: string | null;
  /** Provenance discriminator — 'new' (from `releases`) or 'legacy' (from `release_manifests`). */
  source: 'new' | 'legacy';
  pr_metadata: string | null;
  commits_json: string | null;
  changes_json: string | null;
  artifacts_json: string | null;
  brain_links_json: string | null;
  // Legacy-only columns surfaced by the T9686-B view union. NULL on `new` rows.
  tasks_json: string | null;
  notes: string | null;
  changelog: string | null;
  git_tag: string | null;
  npm_dist_tag: string | null;
  prepared_at: string | null;
  committed_at: string | null;
  tagged_at: string | null;
  pushed_at: string | null;
}

// ── Public output type ─────────────────────────────────────────────────────────

/**
 * One row from `releases_view` with all JSON columns parsed into typed arrays.
 *
 * Returned by {@link queryReleasesView}. Consumers can iterate over `commits`,
 * `changes`, `artifacts`, and `brainLinks` without additional JSON parsing.
 *
 * @task T9510
 */
export interface ReleasesViewRow {
  /** Composite PK: `<projectHash>:<version>` (mirrors releases.id). */
  releaseId: string;
  /** CalVer or SemVer version string (e.g. 'v2026.6.0'). */
  version: string;
  /** Versioning scheme ('calver' | 'semver' | 'calver-suffix'). */
  scheme: string;
  /** Publication channel ('latest' | 'beta' | 'dev' | 'hotfix'). */
  channel: string;
  /** FK → tasks.id. Scoping epic. Null for hotfixes. */
  epicId: string | null;
  /** Release packaging kind ('regular' | 'hotfix' | 'prerelease'). */
  releaseKind: string;
  /** Current FSM status (e.g. 'published', 'reconciled'). */
  status: string;
  /** Previous release version (denormalized). */
  previousVersion: string | null;
  /** Merge commit SHA that landed the release branch into main. */
  mergeCommitSha: string | null;
  /** FK → pull_requests.id. The bump PR. */
  prId: string | null;
  /** GitHub Actions workflow run URL. */
  workflowRunUrl: string | null;
  /** ISO-8601 timestamp of row creation. */
  createdAt: string;
  /** ISO-8601 timestamp of plan creation. */
  plannedAt: string | null;
  /** ISO-8601 timestamp when the bump PR was opened. */
  prOpenedAt: string | null;
  /** ISO-8601 timestamp when the bump PR was merged. */
  prMergedAt: string | null;
  /** ISO-8601 timestamp when publish completed. */
  publishedAt: string | null;
  /** ISO-8601 timestamp when reconcile completed. */
  reconciledAt: string | null;
  /** ISO-8601 timestamp of rollback (terminal state). */
  rolledBackAt: string | null;
  /** ISO-8601 timestamp of failure detection (terminal state). */
  failedAt: string | null;
  /** ISO-8601 timestamp of operator cancellation (terminal state). */
  cancelledAt: string | null;
  /** Human-readable failure reason. Null unless status='failed'. */
  failureReason: string | null;
  /** Agent or operator that initiated rollback. */
  rolledBackBy: string | null;
  /** Project hash for multi-repo installs. */
  projectHash: string | null;
  /**
   * Provenance discriminator for the row.
   *
   * - `'new'` — row originates from the `releases` table (T9508 provenance graph).
   * - `'legacy'` — row originates from the `release_manifests` table (T5580 / pre-T9492).
   *
   * Callers that need full provenance arrays (`commits`, `changes`, `artifacts`,
   * `brainLinks`) should check `source === 'new'`; legacy rows return empty
   * arrays for those columns because the relational tables don't exist for
   * pre-T9492 releases.
   *
   * @task T9686
   */
  source: 'new' | 'legacy';
  /** PR metadata. Null when no PR is associated. */
  pr: ReleasesViewPr | null;
  /** Commits included in this release range. Empty array when none are linked. */
  commits: ReleasesViewCommit[];
  /** CHANGELOG entries for this release. Empty array when none are recorded. */
  changes: ReleasesViewChange[];
  /** Published artifacts for this release. Empty array when none are recorded. */
  artifacts: ReleasesViewArtifact[];
  /** BRAIN knowledge links. Empty array when none are recorded. */
  brainLinks: ReleasesViewBrainLink[];
  /**
   * Legacy task ID list from `release_manifests.tasks_json`. Null on `new` rows.
   * Parsed lazily by consumers — kept as JSON string here so callers that don't
   * need it pay no parsing cost.
   *
   * @task T9686
   */
  tasksJson: string | null;
  /** Free-form notes (legacy `release_manifests.notes`). Null on `new` rows. */
  notes: string | null;
  /** CHANGELOG body (legacy `release_manifests.changelog`). Null on `new` rows. */
  changelog: string | null;
  /** Git tag string (legacy `release_manifests.git_tag`). Null on `new` rows. */
  gitTag: string | null;
  /** npm dist-tag (legacy `release_manifests.npm_dist_tag`). Null on `new` rows. */
  npmDistTag: string | null;
  /** Legacy `prepared_at` timestamp (status='prepared'). Null on `new` rows. */
  preparedAt: string | null;
  /** Legacy `committed_at` timestamp (status='committed'). Null on `new` rows. */
  committedAt: string | null;
  /** Legacy `tagged_at` timestamp (status='tagged'). Null on `new` rows. */
  taggedAt: string | null;
  /** Legacy `pushed_at` timestamp (status='pushed'). Null on `new` rows. */
  pushedAt: string | null;
}

// ── JSON parse helpers ─────────────────────────────────────────────────────────

/**
 * Parse a JSON column that may be NULL or a JSON array string.
 * Returns an empty array when the value is NULL, empty, or `'[null]'`
 * (SQLite returns `'[null]'` from `json_group_array` when all rows are NULL).
 */
function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as T[] | null;
    if (!Array.isArray(parsed)) return [];
    // SQLite json_group_array with no rows returns '[null]' — filter that out.
    return parsed.filter((item) => item !== null) as T[];
  } catch {
    return [];
  }
}

/** Parse the `pr_metadata` JSON column into a typed PR shape (or null). */
function parsePrMetadata(raw: string | null): ReleasesViewPr | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReleasesViewPr;
  } catch {
    return null;
  }
}

/** Map a raw DB row to the public {@link ReleasesViewRow} type. */
function mapRawRow(raw: ReleasesViewRawRow): ReleasesViewRow {
  return {
    releaseId: raw.release_id,
    version: raw.version,
    scheme: raw.scheme,
    channel: raw.channel,
    epicId: raw.epic_id,
    releaseKind: raw.release_kind,
    status: raw.status,
    previousVersion: raw.previous_version,
    mergeCommitSha: raw.merge_commit_sha,
    prId: raw.pr_id,
    workflowRunUrl: raw.workflow_run_url,
    createdAt: raw.created_at,
    plannedAt: raw.planned_at,
    prOpenedAt: raw.pr_opened_at,
    prMergedAt: raw.pr_merged_at,
    publishedAt: raw.published_at,
    reconciledAt: raw.reconciled_at,
    rolledBackAt: raw.rolled_back_at,
    failedAt: raw.failed_at,
    cancelledAt: raw.cancelled_at,
    failureReason: raw.failure_reason,
    rolledBackBy: raw.rolled_back_by,
    projectHash: raw.project_hash,
    source: raw.source,
    pr: parsePrMetadata(raw.pr_metadata),
    commits: parseJsonArray<ReleasesViewCommit>(raw.commits_json),
    changes: parseJsonArray<ReleasesViewChange>(raw.changes_json),
    artifacts: parseJsonArray<ReleasesViewArtifact>(raw.artifacts_json),
    brainLinks: parseJsonArray<ReleasesViewBrainLink>(raw.brain_links_json),
    tasksJson: raw.tasks_json,
    notes: raw.notes,
    changelog: raw.changelog,
    gitTag: raw.git_tag,
    npmDistTag: raw.npm_dist_tag,
    preparedAt: raw.prepared_at,
    committedAt: raw.committed_at,
    taggedAt: raw.tagged_at,
    pushedAt: raw.pushed_at,
  };
}

// ── Query options ──────────────────────────────────────────────────────────────

/** Options for {@link queryReleasesView}. */
export interface ReleasesViewOptions {
  /**
   * Filter by release status (e.g. 'published', 'reconciled').
   * When omitted, all statuses are returned.
   */
  status?: string;
  /**
   * Filter by release channel (e.g. 'latest', 'beta').
   * When omitted, all channels are returned.
   */
  channel?: string;
  /**
   * Maximum number of rows to return.
   * When omitted, all matching rows are returned.
   */
  limit?: number;
  /**
   * Number of rows to skip before returning results (0-based).
   * Only meaningful when combined with `limit`.
   */
  offset?: number;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Query the `releases_view` SQL view and return fully-typed rows.
 *
 * All JSON columns (`commits_json`, `changes_json`, `artifacts_json`,
 * `brain_links_json`, `pr_metadata`) are parsed into typed arrays/objects.
 * SQLite's `json_group_array` returns a JSON null singleton (`'[null]'`) when
 * no rows match the subquery; this helper normalizes that to `[]`.
 *
 * @param db     - The Drizzle ORM database instance connected to `tasks.db`.
 * @param options - Optional filter and pagination parameters.
 * @returns      Array of {@link ReleasesViewRow} objects, one per release.
 *
 * @example
 * ```ts
 * const rows = await queryReleasesView(db, { status: 'published', limit: 10 });
 * for (const row of rows) {
 *   console.log(row.version, row.commits.length, 'commits');
 * }
 * ```
 *
 * @task T9510
 */
export async function queryReleasesView(
  db: NodeSQLiteDatabase<Record<string, unknown>>,
  options: ReleasesViewOptions = {},
): Promise<ReleasesViewRow[]> {
  const { status, channel, limit, offset } = options;

  // Build the WHERE clause predicates dynamically.
  const conditions: string[] = [];
  if (status !== undefined) {
    conditions.push(`status = '${status.replace(/'/g, "''")}'`);
  }
  if (channel !== undefined) {
    conditions.push(`channel = '${channel.replace(/'/g, "''")}'`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitClause = typeof limit === 'number' && limit > 0 ? `LIMIT ${limit}` : '';
  const offsetClause =
    typeof offset === 'number' && offset > 0 && limitClause ? `OFFSET ${offset}` : '';

  const query =
    `SELECT * FROM releases_view ${whereClause} ORDER BY created_at DESC ${limitClause} ${offsetClause}`.trim();

  const rawRows = db.all(sql.raw(query)) as ReleasesViewRawRow[];
  return rawRows.map(mapRawRow);
}

/**
 * Look up a single release row by version string. Returns `null` when the
 * version is not present in either branch of `releases_view`.
 *
 * Used by `cleo release show <version>` as the SSoT lookup that bridges
 * both the new `releases` table (T9508) and the legacy `release_manifests`
 * table (T5580). Eliminates the dual-table split that caused E_NOT_FOUND
 * after `cleo release plan` (T9686).
 *
 * @example
 * ```ts
 * const row = await findReleaseViewByVersion(db, 'v2026.5.99');
 * if (row === null) {
 *   throw new Error('release not found');
 * }
 * ```
 *
 * @task T9686
 */
export async function findReleaseViewByVersion(
  db: NodeSQLiteDatabase<Record<string, unknown>>,
  version: string,
): Promise<ReleasesViewRow | null> {
  const escaped = version.replace(/'/g, "''");
  const query = `SELECT * FROM releases_view WHERE version = '${escaped}' LIMIT 1`;
  const rawRows = db.all(sql.raw(query)) as ReleasesViewRawRow[];
  const first = rawRows[0];
  if (first === undefined) return null;
  return mapRawRow(first);
}

/**
 * Count rows in `releases_view`, optionally filtered by status / channel.
 * Mirrors the predicate shape of {@link queryReleasesView} so list endpoints
 * can render an accurate `total` alongside a paginated slice.
 *
 * @task T9686
 */
export function countReleasesView(
  db: NodeSQLiteDatabase<Record<string, unknown>>,
  filter: { status?: string; channel?: string } = {},
): number {
  const conditions: string[] = [];
  if (filter.status !== undefined) {
    conditions.push(`status = '${filter.status.replace(/'/g, "''")}'`);
  }
  if (filter.channel !== undefined) {
    conditions.push(`channel = '${filter.channel.replace(/'/g, "''")}'`);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const row = db.get(sql.raw(`SELECT COUNT(*) AS n FROM releases_view ${whereClause}`)) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}
