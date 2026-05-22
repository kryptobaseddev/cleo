/**
 * Provenance graph — PR tables: pull_requests, pr_commits, pr_tasks.
 *
 * @task T9507
 * @epic T9491
 * @see SPEC-T9345 §3.4–§3.5
 */

import type { PrLinkKind, PrLinkSource, PrState } from '@cleocode/contracts/provenance';
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { tasks } from '../tasks.js';
import { commits } from './commits.js';

/**
 * State enum for {@link pullRequests.state}.
 *
 * @task T9507
 */
export const PR_STATES = ['open', 'closed', 'merged'] as const;

/**
 * Union type for {@link PR_STATES}. Promoted to
 * `@cleocode/contracts/provenance` in Phase 0c (T9955); re-exported here
 * for backward compatibility.
 */
export type { PrState };

/**
 * Link-source enum for {@link prTasks.linkSource}.
 *
 * @task T9507
 */
export const PR_LINK_SOURCES = [
  'pr-title',
  'pr-body',
  'branch-name',
  'commit-trailer',
  'manual',
] as const;

/**
 * Union type for {@link PR_LINK_SOURCES}. Promoted to
 * `@cleocode/contracts/provenance` in Phase 0c (T9955); re-exported here
 * for backward compatibility.
 */
export type { PrLinkSource };

/**
 * Link-kind enum for {@link prTasks.linkKind}.
 *
 * @task T9507
 */
export const PR_LINK_KINDS = [
  'implements',
  'fixes',
  'refactors',
  'tests',
  'docs',
  'reverts',
  'tracks',
] as const;

/**
 * Union type for {@link PR_LINK_KINDS}. Promoted to
 * `@cleocode/contracts/provenance` in Phase 0c (T9955); re-exported here
 * for backward compatibility.
 */
export type { PrLinkKind };

/**
 * `pull_requests` — PR metadata for the provenance graph.
 *
 * @task T9507
 * @epic T9491
 * @see SPEC-T9345 §3.4
 */
export const pullRequests = sqliteTable(
  'pull_requests',
  {
    /** Primary key: `"<projectHash>:<prNumber>"`. */
    id: text('id').primaryKey(),
    /** GitHub PR number (unique within a repo). */
    prNumber: integer('pr_number').notNull(),
    /** Full URL of the repository (e.g. `https://github.com/org/repo`). */
    repoUrl: text('repo_url').notNull(),
    /** PR title. */
    title: text('title').notNull(),
    /** PR body markdown (may be NULL if the PR had no description). */
    body: text('body'),
    /**
     * Current PR state. See {@link PR_STATES}.
     * Values: `open` | `closed` | `merged`.
     */
    state: text('state').notNull(),
    /** Target branch name (e.g. `main`). */
    baseRef: text('base_ref').notNull(),
    /** Source branch name (e.g. `release/v2026.5.74`). */
    headRef: text('head_ref').notNull(),
    /**
     * HEAD SHA of the PR at merge time.
     * Soft FK → commits.sha (ON DELETE SET NULL).
     */
    headSha: text('head_sha').references(() => commits.sha, { onDelete: 'set null' }),
    /**
     * The actual merge commit SHA (NULL if the PR was not merged).
     * Soft FK → commits.sha (ON DELETE SET NULL).
     */
    mergeCommitSha: text('merge_commit_sha').references(() => commits.sha, {
      onDelete: 'set null',
    }),
    /** GitHub login of the PR author. */
    authorLogin: text('author_login'),
    /** ISO-8601 timestamp when the PR was opened. */
    openedAt: text('opened_at').notNull(),
    /** ISO-8601 timestamp when the PR was merged (NULL if not merged). */
    mergedAt: text('merged_at'),
    /** ISO-8601 timestamp when the PR was closed (NULL if still open). */
    closedAt: text('closed_at'),
    /** 1 if this PR is a release PR (e.g. opened by `cleo release ship`). */
    isReleasePr: integer('is_release_pr').notNull().default(0),
    /** CalVer version string this PR ships (NULL for non-release PRs). */
    releaseVersion: text('release_version'),
    /** 1 if this PR contains only a version bump (no feature/fix commits). */
    isBumpOnly: integer('is_bump_only').notNull().default(0),
    /**
     * Project hash from `audit_log.project_hash` — correlates PRs to a
     * specific CLEO project in multi-repo installs.
     */
    projectHash: text('project_hash'),
    /** ISO-8601 timestamp when this row was first inserted into tasks.db. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 timestamp of the last update to this row. */
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_pr_number').on(table.prNumber),
    index('idx_pr_state').on(table.state),
    index('idx_pr_merge_commit_sha').on(table.mergeCommitSha),
    index('idx_pr_head_sha').on(table.headSha),
    index('idx_pr_release_version').on(table.releaseVersion),
    index('idx_pr_project_hash').on(table.projectHash),
  ],
);

/**
 * `pr_commits` — M:N ordered junction between pull_requests and commits.
 *
 * @task T9507
 * @epic T9491
 * @see SPEC-T9345 §3.5
 */
export const prCommits = sqliteTable(
  'pr_commits',
  {
    /** FK → pull_requests.id. ON DELETE CASCADE. */
    prId: text('pr_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    /** FK → commits.sha. ON DELETE CASCADE. */
    commitSha: text('commit_sha')
      .notNull()
      .references(() => commits.sha, { onDelete: 'cascade' }),
    /** Ordinal position of this commit within the PR commit list (0-based). */
    position: integer('position').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.prId, table.commitSha] }),
    index('idx_pr_commits_pr_id').on(table.prId),
    index('idx_pr_commits_commit_sha').on(table.commitSha),
    index('idx_pr_commits_position').on(table.prId, table.position),
  ],
);

/**
 * `pr_tasks` — M:N junction between pull_requests and tasks.
 *
 * @task T9507
 * @epic T9491
 * @see SPEC-T9345 §3.5
 */
export const prTasks = sqliteTable(
  'pr_tasks',
  {
    /** FK → pull_requests.id. ON DELETE CASCADE. */
    prId: text('pr_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    /**
     * FK → tasks.id. ON DELETE SET NULL to preserve the PR audit trail
     * after task deletion. NULL = orphaned link (task was purged).
     */
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    /**
     * How this link was discovered. See {@link PR_LINK_SOURCES}.
     */
    linkSource: text('link_source').notNull(),
    /**
     * Semantic relationship classification. See {@link PR_LINK_KINDS}.
     */
    linkKind: text('link_kind').notNull(),
    /** ISO-8601 timestamp when this link was created. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.prId, table.taskId, table.linkKind] }),
    index('idx_pr_tasks_pr_id').on(table.prId),
    index('idx_pr_tasks_task_id').on(table.taskId),
    index('idx_pr_tasks_link_source').on(table.linkSource),
  ],
);

// === TYPE EXPORTS ===

export type PullRequestRow = typeof pullRequests.$inferSelect;
export type NewPullRequestRow = typeof pullRequests.$inferInsert;
export type PrCommitRow = typeof prCommits.$inferSelect;
export type NewPrCommitRow = typeof prCommits.$inferInsert;
export type PrTaskRow = typeof prTasks.$inferSelect;
export type NewPrTaskRow = typeof prTasks.$inferInsert;
