/**
 * Provenance graph — release tables: releases, release_commits,
 * release_changes, release_changesets, release_artifacts, brain_release_links.
 *
 * @task T9508
 * @task T9509
 * @epic T9491
 * @see SPEC-T9345 §3.6–§3.9, §8
 */

import type {
  BrainReleaseLinkType,
  ReleaseArtifactType,
  ReleaseChangeType,
  ReleaseChannel,
  ReleaseClassifiedBy,
  ReleaseImpact,
  ReleaseKind,
  ReleaseScheme,
  ReleaseStatus,
} from '@cleocode/contracts/provenance';
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { tasks } from '../tasks.js';
import { commits } from './commits.js';

/**
 * Versioning scheme enum for {@link releases.scheme}.
 *
 * @task T9508
 */
export const RELEASE_SCHEMES = ['calver', 'semver', 'calver-suffix'] as const;

/**
 * Union type for {@link RELEASE_SCHEMES}. Promoted to
 * `@cleocode/contracts/provenance` in Phase 0c (T9955); re-exported here
 * for backward compatibility.
 */
export type { ReleaseScheme };

/**
 * Release channel enum for {@link releases.channel}.
 *
 * @task T9508
 */
export const RELEASE_CHANNELS = ['latest', 'beta', 'dev', 'hotfix'] as const;

/**
 * Union type for {@link RELEASE_CHANNELS}. Promoted to
 * `@cleocode/contracts/provenance` in Phase 0c (T9955); re-exported here
 * for backward compatibility.
 */
export type { ReleaseChannel };

/**
 * Release kind enum for {@link releases.releaseKind}.
 *
 * @task T9508
 */
export const RELEASE_KINDS = ['regular', 'hotfix', 'prerelease'] as const;

/**
 * Union type for {@link RELEASE_KINDS}. Promoted to
 * `@cleocode/contracts/provenance` in Phase 0c (T9955); re-exported here
 * for backward compatibility.
 */
export type { ReleaseKind };

/**
 * Release status FSM enum for {@link releases.status}.
 *
 * The unified `releases` table (T9686-B2) admits values from both the
 * new T9492 pipeline and the legacy T5580 pipeline.
 *
 * @task T9508
 * @task T9686 (lifecycle union)
 * @see SPEC-T9345 §10.1
 */
export const RELEASE_STATUSES = [
  // New T9492 pipeline statuses
  'planned',
  'pr-opened',
  'pr-merged',
  'published',
  'reconciled',
  // Legacy T5580 pipeline statuses (merged in by T9686-B2)
  'prepared',
  'committed',
  'tagged',
  'pushed',
  // Shared terminal states
  'rolled_back',
  'failed',
  'cancelled',
] as const;

/**
 * Union type for {@link RELEASE_STATUSES}. Promoted to
 * `@cleocode/contracts/provenance` in Phase 0c (T9955); re-exported here
 * for backward compatibility.
 */
export type { ReleaseStatus };

/**
 * Release change type enum for {@link releaseChanges.changeType}.
 *
 * @task T9508
 * @see SPEC-T9345 §2.2
 */
export const RELEASE_CHANGE_TYPES = [
  'feature',
  'enhancement',
  'bug',
  'hotfix',
  'security',
  'breaking',
  'refactor',
  'docs',
  'chore',
  'revert',
  'deprecation',
  'infrastructure',
] as const;

/**
 * Union type for {@link RELEASE_CHANGE_TYPES}. Promoted to
 * `@cleocode/contracts/provenance` in Phase 0c (T9955); re-exported here
 * for backward compatibility.
 */
export type { ReleaseChangeType };

/**
 * Impact level enum for {@link releaseChanges.impact}.
 *
 * @task T9508
 */
export const RELEASE_IMPACTS = ['major', 'minor', 'patch', 'none'] as const;

/**
 * Union type for {@link RELEASE_IMPACTS}. Promoted to
 * `@cleocode/contracts/provenance` in Phase 0c (T9955); re-exported here
 * for backward compatibility.
 */
export type { ReleaseImpact };

/**
 * Classification provenance enum for {@link releaseChanges.classifiedBy}.
 *
 * @task T9508
 */
export const RELEASE_CLASSIFIED_BY = ['auto', 'manual', 'approved'] as const;

/**
 * Union type for {@link RELEASE_CLASSIFIED_BY}. Promoted to
 * `@cleocode/contracts/provenance` in Phase 0c (T9955); re-exported here
 * for backward compatibility.
 */
export type { ReleaseClassifiedBy };

/**
 * Artifact type enum for {@link releaseArtifacts.artifactType}.
 *
 * @task T9509
 * @see SPEC-T9345 §3.9
 */
export const RELEASE_ARTIFACT_TYPES = [
  'npm',
  'cargo',
  'docker',
  'pypi',
  'github-release',
  'binary',
  'github-tag',
] as const;

/**
 * Union type for {@link RELEASE_ARTIFACT_TYPES}. Promoted to
 * `@cleocode/contracts/provenance` in Phase 0c (T9955); re-exported here
 * for backward compatibility.
 */
export type { ReleaseArtifactType };

/**
 * Link type enum for {@link brainReleaseLinks.linkType}.
 *
 * @task T9509
 * @see SPEC-T9345 §8.1
 */
export const BRAIN_RELEASE_LINK_TYPES = [
  'approved-by',
  'documented-in',
  'derived-from',
  'observed-in',
] as const;

/**
 * Union type for {@link BRAIN_RELEASE_LINK_TYPES}. Promoted to
 * `@cleocode/contracts/provenance` in Phase 0c (T9955); re-exported here
 * for backward compatibility.
 */
export type { BrainReleaseLinkType };

/**
 * `releases` — Canonical release record (ADR-073 / SPEC-T9345 §3.6).
 *
 * As of T9686-B2, this is the SINGLE source of truth for release state.
 *
 * @task T9508
 * @task T9686 (unification — legacy columns + widened status enum)
 * @task T9756 (uniform PK shape)
 * @epic T9491
 * @see SPEC-T9345 §3.6
 */
export const releases = sqliteTable(
  'releases',
  {
    /**
     * Canonical PK — uniform `<projectHash>:<version>` shape (post-T9756).
     * Example: `1e3146b7352b:v2026.6.0`.
     */
    id: text('id').primaryKey(),
    /** Release version string, e.g. `v2026.6.0`. UNIQUE — one row per version. */
    version: text('version').notNull().unique(),
    /**
     * Versioning scheme used for this release. See {@link RELEASE_SCHEMES}.
     * Defaulted to `calver` on legacy migrated rows.
     */
    scheme: text('scheme', { enum: RELEASE_SCHEMES }).notNull().default('calver'),
    /**
     * Publication channel governing the npm dist-tag (or equivalent).
     * See {@link RELEASE_CHANNELS}. Defaulted to `latest` on legacy migrated rows.
     */
    channel: text('channel', { enum: RELEASE_CHANNELS }).notNull().default('latest'),
    /**
     * FK → tasks.id (ON DELETE SET NULL). The epic that scoped this release.
     * NULL for hotfixes scoped to a single task, not an epic.
     */
    epicId: text('epic_id').references(() => tasks.id, { onDelete: 'set null' }),
    /**
     * Release packaging kind — describes the whole release, not individual changes.
     * See {@link RELEASE_KINDS}. Defaulted to `regular` on legacy migrated rows.
     */
    releaseKind: text('release_kind', { enum: RELEASE_KINDS }).notNull().default('regular'),
    /**
     * Current FSM status. Admits both new-pipeline and legacy-pipeline values
     * post-T9686-B2 — see {@link RELEASE_STATUSES}.
     */
    status: text('status', { enum: RELEASE_STATUSES }).notNull().default('planned'),
    /** Previous release version string (denormalized for fast prior-release walks). */
    previousVersion: text('previous_version'),
    /**
     * Git merge commit SHA. HARD FK to `commits(sha)` ON DELETE SET NULL (T9755).
     */
    mergeCommitSha: text('merge_commit_sha').references(() => commits.sha, {
      onDelete: 'set null',
    }),
    /**
     * FK → pull_requests.id (ON DELETE SET NULL). The bump-PR opened by `cleo release open`.
     * Always NULL on legacy migrated rows (legacy pipeline pre-dated `pull_requests`).
     */
    prId: text('pr_id'),
    /** URL of the GitHub Actions workflow run that built and published this release. */
    workflowRunUrl: text('workflow_run_url'),
    /** ISO-8601 timestamp when this row was inserted. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 timestamp when `cleo release plan` created the plan (new pipeline). */
    plannedAt: text('planned_at'),
    /** ISO-8601 timestamp when the bump-PR was opened (new pipeline). */
    prOpenedAt: text('pr_opened_at'),
    /** ISO-8601 timestamp when the bump-PR was merged (new pipeline). */
    prMergedAt: text('pr_merged_at'),
    /** ISO-8601 timestamp when npm/cargo/etc. publish completed (new pipeline). */
    publishedAt: text('published_at'),
    /** ISO-8601 timestamp when `cleo release reconcile` completed (new pipeline). */
    reconciledAt: text('reconciled_at'),
    /** ISO-8601 timestamp when `cleo release rollback` completed (terminal). */
    rolledBackAt: text('rolled_back_at'),
    /** ISO-8601 timestamp when a failure was detected (terminal). */
    failedAt: text('failed_at'),
    /** ISO-8601 timestamp when the operator cancelled the release (terminal). */
    cancelledAt: text('cancelled_at'),
    /** Human-readable reason for the failure (populated when status='failed'). */
    failureReason: text('failure_reason'),
    /** Agent or operator identity that initiated the rollback. */
    rolledBackBy: text('rolled_back_by'),
    /** Project hash for multi-repo CLEO installs (matches audit_log.project_hash). */
    projectHash: text('project_hash'),
    // ── Legacy-only columns (merged in by T9686-B2 from `release_manifests`) ──
    /**
     * Legacy: JSON array of task IDs included in this release. Populated for
     * legacy-migrated rows only; NULL on new-pipeline rows.
     */
    tasksJson: text('tasks_json'),
    /**
     * Legacy: free-form CHANGELOG body text. Populated for legacy-migrated
     * rows only; NULL on new-pipeline rows.
     */
    changelog: text('changelog'),
    /** Legacy: free-form release notes. Populated for legacy-migrated rows only. */
    notes: text('notes'),
    /** Legacy: git tag string. Populated for legacy-migrated rows only. */
    gitTag: text('git_tag'),
    /** Legacy: ISO-8601 timestamp when the release was marked `prepared`. */
    preparedAt: text('prepared_at'),
    /** Legacy: ISO-8601 timestamp when the release was marked `committed`. */
    committedAt: text('committed_at'),
    /** Legacy: ISO-8601 timestamp when the release was marked `tagged`. */
    taggedAt: text('tagged_at'),
    /** Legacy: ISO-8601 timestamp when the release was marked `pushed` (published). */
    pushedAt: text('pushed_at'),
  },
  (table) => [
    index('idx_releases_version').on(table.version),
    index('idx_releases_status').on(table.status),
    index('idx_releases_channel').on(table.channel),
    index('idx_releases_epic_id').on(table.epicId),
    index('idx_releases_merge_commit_sha').on(table.mergeCommitSha),
    index('idx_releases_project_hash').on(table.projectHash),
    index('idx_releases_published_at').on(table.publishedAt),
    index('idx_releases_pushed_at').on(table.pushedAt),
  ],
);

/**
 * `release_commits` — M:N junction between releases and commits (SPEC-T9345 §3.8).
 *
 * @task T9508
 * @epic T9491
 * @see SPEC-T9345 §3.8
 */
export const releaseCommits = sqliteTable(
  'release_commits',
  {
    /** FK → releases.id. ON DELETE CASCADE — purging a release removes its junction rows. */
    releaseId: text('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    /** FK → commits.sha. ON DELETE CASCADE — purging a commit removes its junction rows. */
    commitSha: text('commit_sha')
      .notNull()
      .references(() => commits.sha, { onDelete: 'cascade' }),
    /** Topo-sorted ascending position: 0 = oldest commit reachable since prev release. */
    position: integer('position').notNull(),
    /**
     * 1 if this is the first commit after the previous release boundary.
     * MUTUALLY EXCLUSIVE with is_last and is_release_chore (application enforced).
     */
    isFirst: integer('is_first').notNull().default(0),
    /**
     * 1 if this is the tag/merge commit that closed this release.
     * MUTUALLY EXCLUSIVE with is_first and is_release_chore (application enforced).
     */
    isLast: integer('is_last').notNull().default(0),
    /**
     * 1 for "chore(release): vX.Y.Z" version-bump commits.
     * MUTUALLY EXCLUSIVE with is_first and is_last (application enforced).
     */
    isReleaseChore: integer('is_release_chore').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.releaseId, table.commitSha] }),
    index('idx_release_commits_release_id').on(table.releaseId),
    index('idx_release_commits_commit_sha').on(table.commitSha),
    index('idx_release_commits_position').on(table.releaseId, table.position),
  ],
);

/**
 * `release_changes` — Editorial CHANGELOG generation layer (SPEC-T9345 §3.7).
 *
 * @task T9508
 * @epic T9491
 * @see SPEC-T9345 §3.7
 */
export const releaseChanges = sqliteTable(
  'release_changes',
  {
    /** UUID primary key generated at insert time. */
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** FK → releases.id. ON DELETE CASCADE. */
    releaseId: text('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    /**
     * FK → tasks.id (ON DELETE SET NULL). Nullable — some changes are
     * not task-linked (e.g., automated dependency bumps).
     */
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    /**
     * CLEO 12-value change taxonomy. See {@link RELEASE_CHANGE_TYPES}.
     */
    changeType: text('change_type', { enum: RELEASE_CHANGE_TYPES }).notNull(),
    /**
     * User-facing one-liner summary for the CHANGELOG. MUST be ≤ 200 characters.
     */
    summary: text('summary').notNull(),
    /** Optional markdown body with additional detail (multi-line allowed). */
    description: text('description'),
    /**
     * Semver bump impact assessment. See {@link RELEASE_IMPACTS}.
     * Defaults to 'patch' (conservative).
     */
    impact: text('impact', { enum: RELEASE_IMPACTS }).notNull().default('patch'),
    /**
     * Provenance of the classification. See {@link RELEASE_CLASSIFIED_BY}.
     */
    classifiedBy: text('classified_by', { enum: RELEASE_CLASSIFIED_BY }).notNull().default('auto'),
    /** ISO-8601 timestamp when this change was classified. */
    classifiedAt: text('classified_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_release_changes_release_id').on(table.releaseId),
    index('idx_release_changes_task_id').on(table.taskId),
    index('idx_release_changes_change_type').on(table.changeType),
    index('idx_release_changes_impact').on(table.impact),
  ],
);

/**
 * `release_changesets` — Persistence layer for CLEO-native task-anchored
 * changesets (T9738 carryforward → T9753).
 *
 * @task T9753
 * @epic T9752
 */
export const releaseChangesets = sqliteTable(
  'release_changesets',
  {
    /** UUID primary key generated at insert time. */
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** FK → releases.id. ON DELETE CASCADE — purging a release removes its changeset rows. */
    releaseId: text('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    /** Filename slug of the `.changeset/<slug>.md` file (matches `ChangesetEntry.id`). */
    changesetId: text('changeset_id').notNull(),
    /** JSON array of CLEO task IDs anchored by this changeset entry. */
    taskIds: text('task_ids').notNull(),
    /** Kind discriminator — mirrors {@link CHANGESET_KINDS} from `@cleocode/contracts`. */
    kind: text('kind').notNull(),
    /** User-facing one-liner summary lifted verbatim from the entry's `summary` field. */
    summary: text('summary').notNull(),
    /** JSON array of integer PR numbers, nullable. */
    prs: text('prs'),
    /** Markdown body — longer-form explanation from the source entry, nullable. */
    notes: text('notes'),
    /** Migration note when `kind = 'breaking'`, nullable. */
    breaking: text('breaking'),
    /** ISO-8601 timestamp when this row was inserted. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('release_changesets_release_id_idx').on(table.releaseId),
    index('release_changesets_changeset_id_idx').on(table.changesetId),
    index('release_changesets_kind_idx').on(table.kind),
  ],
);

/**
 * `release_artifacts` — Polymorphic artifact registry (ADR-073 / SPEC-T9345 §3.9).
 *
 * @task T9509
 * @epic T9491
 * @see SPEC-T9345 §3.9
 */
export const releaseArtifacts = sqliteTable(
  'release_artifacts',
  {
    /** FK → releases.id. ON DELETE CASCADE — purging a release removes its artifact rows. */
    releaseId: text('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    /**
     * Artifact archetype. See {@link RELEASE_ARTIFACT_TYPES}.
     */
    artifactType: text('artifact_type').notNull(),
    /**
     * Artifact-specific identifier.
     * npm: package name; cargo: crate name; docker: image ref; binary: filename.
     */
    identifier: text('identifier').notNull(),
    /** Published version string (artifact-specific format). */
    version: text('version').notNull(),
    /** Registry URL, OCI ref, or asset download URL. Nullable. */
    url: text('url'),
    /** ISO-8601 timestamp when the artifact was published to its registry. */
    publishedAt: text('published_at'),
    /**
     * JSON blob for type-specific metadata. Defaults to `{}`.
     */
    metadata: text('metadata').notNull().default('{}'),
  },
  (table) => [
    primaryKey({ columns: [table.releaseId, table.artifactType, table.identifier] }),
    index('idx_release_artifacts_release_id').on(table.releaseId),
    index('idx_release_artifacts_artifact_type').on(table.artifactType),
    index('idx_release_artifacts_published_at').on(table.publishedAt),
  ],
);

/**
 * `brain_release_links` — M:N junction closing the BRAIN↔release loop
 * (ADR-073 / SPEC-T9345 §8).
 *
 * @task T9509
 * @epic T9491
 * @see SPEC-T9345 §8.1
 */
export const brainReleaseLinks = sqliteTable(
  'brain_release_links',
  {
    /**
     * Soft FK to `brain_entries.id` in `brain.db`.
     * NOT a hard REFERENCES — brain.db is a separate SQLite file.
     */
    brainEntryId: text('brain_entry_id'),
    /** FK → releases.id. ON DELETE CASCADE. */
    releaseId: text('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    /**
     * Semantic relationship type. See {@link BRAIN_RELEASE_LINK_TYPES}.
     */
    linkType: text('link_type', { enum: BRAIN_RELEASE_LINK_TYPES }).notNull(),
    /** ISO-8601 timestamp when this link was created. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** Identifier of the agent or user that created this link. Nullable. */
    createdBy: text('created_by'),
  },
  (table) => [
    primaryKey({ columns: [table.brainEntryId, table.releaseId, table.linkType] }),
    index('idx_brain_release_links_brain_entry_id').on(table.brainEntryId),
    index('idx_brain_release_links_release_id').on(table.releaseId),
    index('idx_brain_release_links_link_type').on(table.linkType),
  ],
);

// === TYPE EXPORTS ===

// T9508 / T9686-B2: unified releases table row types
export type ReleaseRow = typeof releases.$inferSelect;
export type NewReleaseRow = typeof releases.$inferInsert;
export type ReleaseCommitRow = typeof releaseCommits.$inferSelect;
export type NewReleaseCommitRow = typeof releaseCommits.$inferInsert;
export type ReleaseChangeRow = typeof releaseChanges.$inferSelect;
export type NewReleaseChangeRow = typeof releaseChanges.$inferInsert;
// T9753 release changesets (CLEO-native changesets aggregator)
export type ReleaseChangesetRow = typeof releaseChangesets.$inferSelect;
export type NewReleaseChangesetRow = typeof releaseChangesets.$inferInsert;
// T9509 provenance graph row types (release_artifacts + brain_release_links)
export type ReleaseArtifactRow = typeof releaseArtifacts.$inferSelect;
export type NewReleaseArtifactRow = typeof releaseArtifacts.$inferInsert;
export type BrainReleaseLinkRow = typeof brainReleaseLinks.$inferSelect;
export type NewBrainReleaseLinkRow = typeof brainReleaseLinks.$inferInsert;
