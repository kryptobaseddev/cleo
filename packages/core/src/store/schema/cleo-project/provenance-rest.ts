/**
 * Project-scope `cleo.db` — consolidated **provenance (PRs + releases)** domain
 * (8 tables).
 *
 * Part of the consolidated PROJECT-scope `cleo.db` target shape authored for
 * SG-DB-SUBSTRATE-V2 (saga T11242, epic T11245/E2, task T11360). Target-shape
 * authoring only — physical names carry the `tasks_` domain prefix. The live
 * runtime modules `schema/provenance/{pull-requests,releases}.ts` keep their
 * UNPREFIXED names until the exodus migration (T11248) swaps the substrate.
 * (The commits sub-family was authored in batch 1 / PR #849.)
 *
 * Tables: tasks_pull_requests · tasks_pr_commits · tasks_pr_tasks ·
 * tasks_releases · tasks_release_commits · tasks_release_changes ·
 * tasks_release_changesets · tasks_release_artifacts. The `brain_release_links`
 * table is EXCLUDED — it carries the `brain_` prefix and belongs to the
 * mirrored brain_* family (the coordinated final step).
 *
 * ## E10 §3b — boolean non-conformers
 *
 *   - `pull_requests.is_release_pr`         INTEGER 0/1 → integer({ mode:'boolean' })
 *   - `pull_requests.is_bump_only`          INTEGER 0/1 → integer({ mode:'boolean' })
 *   - `release_commits.is_first`            INTEGER 0/1 → integer({ mode:'boolean' })
 *   - `release_commits.is_last`             INTEGER 0/1 → integer({ mode:'boolean' })
 *   - `release_commits.is_release_chore`    INTEGER 0/1 → integer({ mode:'boolean' })
 *
 * The matching `CHECK (col IN (0,1))` ships as raw DDL at exodus.
 *
 * ## E10 §5b — enum-like bare-TEXT → { enum } (from named const arrays, §5a)
 *
 *   - `pull_requests.state`         → { enum: PR_STATES }
 *   - `pr_tasks.link_source`        → { enum: PR_LINK_SOURCES }
 *   - `pr_tasks.link_kind`          → { enum: PR_LINK_KINDS }
 *   - `release_artifacts.artifact_type` → { enum: RELEASE_ARTIFACT_TYPES }
 *   - `release_changesets.kind`     → { enum: CHANGESET_KINDS } (@cleocode/contracts)
 *
 * ## E10 §4 / §6a
 *
 * All timestamps are already canonical TEXT ISO8601 (no epoch non-conformers).
 * `releases.tasks_json` / `release_artifacts.metadata` stay serialized TEXT per
 * the JSON-Column Audit.
 *
 * Cross-table FKs into `tasks_tasks` / `tasks_commits` are carried as plain
 * TEXT id columns (resolved by the exodus prefixer); intra-domain FKs
 * (releases → release_commits/changes/changesets/artifacts, pull_requests →
 * pr_commits/pr_tasks) are real `.references()`.
 *
 * @task T11360
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §3b · §4 · §5b · §6a
 * @see docs/migration/sqlite-schema-columns.json (per-column affinity SSoT)
 */

import { CHANGESET_KINDS } from '@cleocode/contracts';
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { PR_LINK_KINDS, PR_LINK_SOURCES, PR_STATES } from '../provenance/pull-requests.js';
import {
  RELEASE_ARTIFACT_TYPES,
  RELEASE_CHANGE_TYPES,
  RELEASE_CHANNELS,
  RELEASE_CLASSIFIED_BY,
  RELEASE_IMPACTS,
  RELEASE_KINDS,
  RELEASE_SCHEMES,
  RELEASE_STATUSES,
} from '../provenance/releases.js';

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

/**
 * `tasks_pull_requests` — PR metadata for the provenance graph.
 *
 * @task T11360 (target shape) · T9507 (original)
 */
export const tasksPullRequests = sqliteTable(
  'tasks_pull_requests',
  {
    /** Primary key: `"<projectHash>:<prNumber>"`. */
    id: text('id').primaryKey(),
    /** GitHub PR number. */
    prNumber: integer('pr_number').notNull(),
    /** Repository URL. */
    repoUrl: text('repo_url').notNull(),
    /** PR title. */
    title: text('title').notNull(),
    /** PR body markdown. */
    body: text('body'),
    /** PR state — E10 §5b CHECK-backed via {@link PR_STATES}. */
    state: text('state', { enum: PR_STATES }).notNull(),
    /** Target branch name. */
    baseRef: text('base_ref').notNull(),
    /** Source branch name. */
    headRef: text('head_ref').notNull(),
    /** HEAD SHA (soft FK → `tasks_commits.sha`, resolved at exodus). */
    headSha: text('head_sha'),
    /** Merge commit SHA (soft FK → `tasks_commits.sha`, resolved at exodus). */
    mergeCommitSha: text('merge_commit_sha'),
    /** PR author GitHub login. */
    authorLogin: text('author_login'),
    /** ISO-8601 UTC opened instant (canonical TEXT, §4). */
    openedAt: text('opened_at').notNull(),
    /** ISO-8601 UTC merged instant (canonical TEXT, §4). */
    mergedAt: text('merged_at'),
    /** ISO-8601 UTC closed instant (canonical TEXT, §4). */
    closedAt: text('closed_at'),
    /** Whether this is a release PR. E10 §3b: untyped INTEGER 0/1 → typed boolean. */
    isReleasePr: integer('is_release_pr', { mode: 'boolean' }).notNull().default(false),
    /** CalVer version this PR ships. */
    releaseVersion: text('release_version'),
    /** Whether this PR is a version-bump-only PR. E10 §3b: 0/1 → typed boolean. */
    isBumpOnly: integer('is_bump_only', { mode: 'boolean' }).notNull().default(false),
    /** Project correlation hash. */
    projectHash: text('project_hash'),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant (canonical TEXT, §4). */
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_tasks_pull_requests_pr_number').on(table.prNumber),
    index('idx_tasks_pull_requests_state').on(table.state),
    index('idx_tasks_pull_requests_merge_commit_sha').on(table.mergeCommitSha),
    index('idx_tasks_pull_requests_head_sha').on(table.headSha),
    index('idx_tasks_pull_requests_release_version').on(table.releaseVersion),
    index('idx_tasks_pull_requests_project_hash').on(table.projectHash),
  ],
);

/**
 * `tasks_pr_commits` — M:N ordered junction between PRs and commits.
 *
 * @task T11360 (target shape) · T9507 (original)
 */
export const tasksPrCommits = sqliteTable(
  'tasks_pr_commits',
  {
    /** FK → `tasks_pull_requests.id`. ON DELETE CASCADE. */
    prId: text('pr_id')
      .notNull()
      .references(() => tasksPullRequests.id, { onDelete: 'cascade' }),
    /** FK → `tasks_commits.sha` (resolved at exodus). */
    commitSha: text('commit_sha').notNull(),
    /** Ordinal position of the commit within the PR (0-based). */
    position: integer('position').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.prId, table.commitSha] }),
    index('idx_tasks_pr_commits_pr_id').on(table.prId),
    index('idx_tasks_pr_commits_commit_sha').on(table.commitSha),
    index('idx_tasks_pr_commits_position').on(table.prId, table.position),
  ],
);

/**
 * `tasks_pr_tasks` — M:N junction between PRs and tasks.
 *
 * @task T11360 (target shape) · T9507 (original)
 */
export const tasksPrTasks = sqliteTable(
  'tasks_pr_tasks',
  {
    /** FK → `tasks_pull_requests.id`. ON DELETE CASCADE. */
    prId: text('pr_id')
      .notNull()
      .references(() => tasksPullRequests.id, { onDelete: 'cascade' }),
    /** FK → `tasks_tasks.id` (resolved at exodus); NULL = orphaned link. */
    taskId: text('task_id'),
    /** How this link was discovered — E10 §5b CHECK-backed via {@link PR_LINK_SOURCES}. */
    linkSource: text('link_source', { enum: PR_LINK_SOURCES }).notNull(),
    /** Relationship classification — E10 §5b CHECK-backed via {@link PR_LINK_KINDS}. */
    linkKind: text('link_kind', { enum: PR_LINK_KINDS }).notNull(),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.prId, table.taskId, table.linkKind] }),
    index('idx_tasks_pr_tasks_pr_id').on(table.prId),
    index('idx_tasks_pr_tasks_task_id').on(table.taskId),
    index('idx_tasks_pr_tasks_link_source').on(table.linkSource),
  ],
);

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

/**
 * `tasks_releases` — canonical release record (ADR-073 / SPEC-T9345 §3.6).
 *
 * @task T11360 (target shape) · T9508 (original)
 */
export const tasksReleases = sqliteTable(
  'tasks_releases',
  {
    /** Canonical PK — `<projectHash>:<version>`. */
    id: text('id').primaryKey(),
    /** Release version string. UNIQUE. */
    version: text('version').notNull().unique(),
    /** Versioning scheme — CHECK-backed via {@link RELEASE_SCHEMES}. */
    scheme: text('scheme', { enum: RELEASE_SCHEMES }).notNull().default('calver'),
    /** Publication channel — CHECK-backed via {@link RELEASE_CHANNELS}. */
    channel: text('channel', { enum: RELEASE_CHANNELS }).notNull().default('latest'),
    /** FK → `tasks_tasks.id` (epic, resolved at exodus). */
    epicId: text('epic_id'),
    /** Release packaging kind — CHECK-backed via {@link RELEASE_KINDS}. */
    releaseKind: text('release_kind', { enum: RELEASE_KINDS }).notNull().default('regular'),
    /** FSM status — CHECK-backed via {@link RELEASE_STATUSES}. */
    status: text('status', { enum: RELEASE_STATUSES }).notNull().default('planned'),
    /** Previous release version (denormalized). */
    previousVersion: text('previous_version'),
    /** Merge commit SHA (soft FK → `tasks_commits.sha`, resolved at exodus). */
    mergeCommitSha: text('merge_commit_sha'),
    /** FK → `tasks_pull_requests.id` (resolved at exodus). */
    prId: text('pr_id'),
    /** GitHub Actions workflow run URL. */
    workflowRunUrl: text('workflow_run_url'),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC planned instant (canonical TEXT, §4). */
    plannedAt: text('planned_at'),
    /** ISO-8601 UTC PR-opened instant (canonical TEXT, §4). */
    prOpenedAt: text('pr_opened_at'),
    /** ISO-8601 UTC PR-merged instant (canonical TEXT, §4). */
    prMergedAt: text('pr_merged_at'),
    /** ISO-8601 UTC published instant (canonical TEXT, §4). */
    publishedAt: text('published_at'),
    /** ISO-8601 UTC reconciled instant (canonical TEXT, §4). */
    reconciledAt: text('reconciled_at'),
    /** ISO-8601 UTC rolled-back instant (canonical TEXT, §4). */
    rolledBackAt: text('rolled_back_at'),
    /** ISO-8601 UTC failed instant (canonical TEXT, §4). */
    failedAt: text('failed_at'),
    /** ISO-8601 UTC cancelled instant (canonical TEXT, §4). */
    cancelledAt: text('cancelled_at'),
    /** Human-readable failure reason. */
    failureReason: text('failure_reason'),
    /** Rollback actor identity. */
    rolledBackBy: text('rolled_back_by'),
    /** Project correlation hash. */
    projectHash: text('project_hash'),
    /** Legacy: JSON array of task ids (TEXT per JSON audit). */
    tasksJson: text('tasks_json'),
    /** Legacy: CHANGELOG body. */
    changelog: text('changelog'),
    /** Legacy: release notes. */
    notes: text('notes'),
    /** Legacy: git tag string. */
    gitTag: text('git_tag'),
    /** Legacy: ISO-8601 UTC prepared instant (canonical TEXT, §4). */
    preparedAt: text('prepared_at'),
    /** Legacy: ISO-8601 UTC committed instant (canonical TEXT, §4). */
    committedAt: text('committed_at'),
    /** Legacy: ISO-8601 UTC tagged instant (canonical TEXT, §4). */
    taggedAt: text('tagged_at'),
    /** Legacy: ISO-8601 UTC pushed instant (canonical TEXT, §4). */
    pushedAt: text('pushed_at'),
  },
  (table) => [
    index('idx_tasks_releases_version').on(table.version),
    index('idx_tasks_releases_status').on(table.status),
    index('idx_tasks_releases_channel').on(table.channel),
    index('idx_tasks_releases_epic_id').on(table.epicId),
    index('idx_tasks_releases_merge_commit_sha').on(table.mergeCommitSha),
    index('idx_tasks_releases_project_hash').on(table.projectHash),
    index('idx_tasks_releases_published_at').on(table.publishedAt),
    index('idx_tasks_releases_pushed_at').on(table.pushedAt),
  ],
);

/**
 * `tasks_release_commits` — M:N junction between releases and commits.
 *
 * @task T11360 (target shape) · T9508 (original)
 */
export const tasksReleaseCommits = sqliteTable(
  'tasks_release_commits',
  {
    /** FK → `tasks_releases.id`. ON DELETE CASCADE. */
    releaseId: text('release_id')
      .notNull()
      .references(() => tasksReleases.id, { onDelete: 'cascade' }),
    /** FK → `tasks_commits.sha` (resolved at exodus). */
    commitSha: text('commit_sha').notNull(),
    /** Topo-sorted ascending position. */
    position: integer('position').notNull(),
    /** First commit after the previous release boundary. E10 §3b: 0/1 → boolean. */
    isFirst: integer('is_first', { mode: 'boolean' }).notNull().default(false),
    /** Tag/merge commit that closed this release. E10 §3b: 0/1 → boolean. */
    isLast: integer('is_last', { mode: 'boolean' }).notNull().default(false),
    /** chore(release) version-bump commit. E10 §3b: 0/1 → boolean. */
    isReleaseChore: integer('is_release_chore', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.releaseId, table.commitSha] }),
    index('idx_tasks_release_commits_release_id').on(table.releaseId),
    index('idx_tasks_release_commits_commit_sha').on(table.commitSha),
    index('idx_tasks_release_commits_position').on(table.releaseId, table.position),
  ],
);

/**
 * `tasks_release_changes` — editorial CHANGELOG generation layer.
 *
 * @task T11360 (target shape) · T9508 (original)
 */
export const tasksReleaseChanges = sqliteTable(
  'tasks_release_changes',
  {
    /** UUID primary key. */
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** FK → `tasks_releases.id`. ON DELETE CASCADE. */
    releaseId: text('release_id')
      .notNull()
      .references(() => tasksReleases.id, { onDelete: 'cascade' }),
    /** FK → `tasks_tasks.id` (resolved at exodus). */
    taskId: text('task_id'),
    /** Change taxonomy — CHECK-backed via {@link RELEASE_CHANGE_TYPES}. */
    changeType: text('change_type', { enum: RELEASE_CHANGE_TYPES }).notNull(),
    /** CHANGELOG one-liner (≤200 chars). */
    summary: text('summary').notNull(),
    /** Optional markdown body. */
    description: text('description'),
    /** Semver impact — CHECK-backed via {@link RELEASE_IMPACTS}. */
    impact: text('impact', { enum: RELEASE_IMPACTS }).notNull().default('patch'),
    /** Classification provenance — CHECK-backed via {@link RELEASE_CLASSIFIED_BY}. */
    classifiedBy: text('classified_by', { enum: RELEASE_CLASSIFIED_BY }).notNull().default('auto'),
    /** ISO-8601 UTC classification instant (canonical TEXT, §4). */
    classifiedAt: text('classified_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_tasks_release_changes_release_id').on(table.releaseId),
    index('idx_tasks_release_changes_task_id').on(table.taskId),
    index('idx_tasks_release_changes_change_type').on(table.changeType),
    index('idx_tasks_release_changes_impact').on(table.impact),
  ],
);

/**
 * `tasks_release_changesets` — CLEO-native task-anchored changeset persistence.
 *
 * @task T11360 (target shape) · T9753 (original)
 */
export const tasksReleaseChangesets = sqliteTable(
  'tasks_release_changesets',
  {
    /** UUID primary key. */
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** FK → `tasks_releases.id`. ON DELETE CASCADE. */
    releaseId: text('release_id')
      .notNull()
      .references(() => tasksReleases.id, { onDelete: 'cascade' }),
    /** Filename slug of the `.changeset/<slug>.md` file. */
    changesetId: text('changeset_id').notNull(),
    /** JSON array of CLEO task ids (TEXT per JSON audit). */
    taskIds: text('task_ids').notNull(),
    /** Kind — E10 §5b CHECK-backed via {@link CHANGESET_KINDS} (@cleocode/contracts). */
    kind: text('kind', { enum: CHANGESET_KINDS }).notNull(),
    /** User-facing one-liner summary. */
    summary: text('summary').notNull(),
    /** JSON array of PR numbers (TEXT per JSON audit). */
    prs: text('prs'),
    /** Markdown body. */
    notes: text('notes'),
    /** Breaking-change migration note. */
    breaking: text('breaking'),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_tasks_release_changesets_release_id').on(table.releaseId),
    index('idx_tasks_release_changesets_changeset_id').on(table.changesetId),
    index('idx_tasks_release_changesets_kind').on(table.kind),
  ],
);

/**
 * `tasks_release_artifacts` — polymorphic artifact registry.
 *
 * @task T11360 (target shape) · T9509 (original)
 */
export const tasksReleaseArtifacts = sqliteTable(
  'tasks_release_artifacts',
  {
    /** FK → `tasks_releases.id`. ON DELETE CASCADE. */
    releaseId: text('release_id')
      .notNull()
      .references(() => tasksReleases.id, { onDelete: 'cascade' }),
    /** Artifact archetype — E10 §5b CHECK-backed via {@link RELEASE_ARTIFACT_TYPES}. */
    artifactType: text('artifact_type', { enum: RELEASE_ARTIFACT_TYPES }).notNull(),
    /** Artifact-specific identifier (package/crate/image name). */
    identifier: text('identifier').notNull(),
    /** Published version string. */
    version: text('version').notNull(),
    /** Registry/asset URL. */
    url: text('url'),
    /** ISO-8601 UTC publish instant (canonical TEXT, §4). */
    publishedAt: text('published_at'),
    /** JSON type-specific metadata (TEXT per JSON audit; empty-object default). */
    metadata: text('metadata').notNull().default('{}'),
  },
  (table) => [
    primaryKey({ columns: [table.releaseId, table.artifactType, table.identifier] }),
    index('idx_tasks_release_artifacts_release_id').on(table.releaseId),
    index('idx_tasks_release_artifacts_artifact_type').on(table.artifactType),
    index('idx_tasks_release_artifacts_published_at').on(table.publishedAt),
  ],
);

// === TYPE EXPORTS ===

/** Row type for `tasks_pull_requests` SELECT queries (target shape). */
export type TasksPullRequestRow = typeof tasksPullRequests.$inferSelect;
/** Row type for `tasks_pull_requests` INSERT operations (target shape). */
export type NewTasksPullRequestRow = typeof tasksPullRequests.$inferInsert;
/** Row type for `tasks_pr_commits` SELECT queries (target shape). */
export type TasksPrCommitRow = typeof tasksPrCommits.$inferSelect;
/** Row type for `tasks_pr_commits` INSERT operations (target shape). */
export type NewTasksPrCommitRow = typeof tasksPrCommits.$inferInsert;
/** Row type for `tasks_pr_tasks` SELECT queries (target shape). */
export type TasksPrTaskRow = typeof tasksPrTasks.$inferSelect;
/** Row type for `tasks_pr_tasks` INSERT operations (target shape). */
export type NewTasksPrTaskRow = typeof tasksPrTasks.$inferInsert;
/** Row type for `tasks_releases` SELECT queries (target shape). */
export type TasksReleaseRow = typeof tasksReleases.$inferSelect;
/** Row type for `tasks_releases` INSERT operations (target shape). */
export type NewTasksReleaseRow = typeof tasksReleases.$inferInsert;
/** Row type for `tasks_release_commits` SELECT queries (target shape). */
export type TasksReleaseCommitRow = typeof tasksReleaseCommits.$inferSelect;
/** Row type for `tasks_release_commits` INSERT operations (target shape). */
export type NewTasksReleaseCommitRow = typeof tasksReleaseCommits.$inferInsert;
/** Row type for `tasks_release_changes` SELECT queries (target shape). */
export type TasksReleaseChangeRow = typeof tasksReleaseChanges.$inferSelect;
/** Row type for `tasks_release_changes` INSERT operations (target shape). */
export type NewTasksReleaseChangeRow = typeof tasksReleaseChanges.$inferInsert;
/** Row type for `tasks_release_changesets` SELECT queries (target shape). */
export type TasksReleaseChangesetRow = typeof tasksReleaseChangesets.$inferSelect;
/** Row type for `tasks_release_changesets` INSERT operations (target shape). */
export type NewTasksReleaseChangesetRow = typeof tasksReleaseChangesets.$inferInsert;
/** Row type for `tasks_release_artifacts` SELECT queries (target shape). */
export type TasksReleaseArtifactRow = typeof tasksReleaseArtifacts.$inferSelect;
/** Row type for `tasks_release_artifacts` INSERT operations (target shape). */
export type NewTasksReleaseArtifactRow = typeof tasksReleaseArtifacts.$inferInsert;
