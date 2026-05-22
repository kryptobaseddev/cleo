/**
 * Provenance graph — commit tables: commits, task_commits, commit_files.
 *
 * @task T9506
 * @epic T9491
 * @see SPEC-T9345 §3.1–§3.3
 */

import type {
  CommitConventionalType,
  CommitFileChangeType,
  CommitLinkKind,
  CommitLinkSource,
} from '@cleocode/contracts/provenance';
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { tasks } from '../tasks.js';

/**
 * Canonical enum values for {@link commits.conventionalType}.
 *
 * Mirrors the Conventional Commits specification prefixes plus `breaking`
 * to flag BREAKING CHANGE footers. Stored as TEXT in SQLite.
 *
 * @task T9506
 */
export const COMMIT_CONVENTIONAL_TYPES = [
  'feat',
  'fix',
  'chore',
  'docs',
  'refactor',
  'test',
  'build',
  'ci',
  'perf',
  'revert',
  'breaking',
] as const;

/**
 * Union type for {@link COMMIT_CONVENTIONAL_TYPES}. Promoted to
 * `@cleocode/contracts/provenance` in Phase 0c (T9955); re-exported here
 * for backward compatibility.
 */
export type { CommitConventionalType };

/**
 * Link-kind enum for {@link taskCommits.linkKind}.
 *
 * @task T9506
 */
export const COMMIT_LINK_KINDS = [
  'implements',
  'fixes',
  'refactors',
  'tests',
  'docs',
  'reverts',
] as const;

/**
 * Union type for {@link COMMIT_LINK_KINDS}. Promoted to
 * `@cleocode/contracts/provenance` in Phase 0c (T9955); re-exported here
 * for backward compatibility.
 */
export type { CommitLinkKind };

/**
 * Link-source enum for {@link taskCommits.linkSource}.
 *
 * @task T9506
 */
export const COMMIT_LINK_SOURCES = [
  'commit-trailer',
  'commit-subject',
  'pr-title',
  'pr-body',
  'branch-name',
  'manual',
] as const;

/**
 * Union type for {@link COMMIT_LINK_SOURCES}. Promoted to
 * `@cleocode/contracts/provenance` in Phase 0c (T9955); re-exported here
 * for backward compatibility.
 */
export type { CommitLinkSource };

/**
 * Change-type enum for {@link commitFiles.changeType}.
 *
 * Uses git status letter codes: A=added, M=modified, D=deleted, R=renamed, C=copied.
 *
 * @task T9506
 */
export const COMMIT_FILE_CHANGE_TYPES = ['A', 'M', 'D', 'R', 'C'] as const;

/**
 * Union type for {@link COMMIT_FILE_CHANGE_TYPES}. Promoted to
 * `@cleocode/contracts/provenance` in Phase 0c (T9955); re-exported here
 * for backward compatibility.
 */
export type { CommitFileChangeType };

/**
 * `commits` — Every git commit reachable from a release tag.
 *
 * @task T9506
 * @epic T9491
 * @see SPEC-T9345 §3.1
 */
export const commits = sqliteTable(
  'commits',
  {
    /** Full 40-char git SHA — primary key. */
    sha: text('sha').primaryKey(),
    /** First 7 characters of the SHA for display purposes. */
    shortSha: text('short_sha').notNull(),
    /** Author display name (from `git log %an`). */
    authorName: text('author_name'),
    /** Author email (from `git log %ae`). */
    authorEmail: text('author_email'),
    /** ISO-8601 author timestamp (from `git log %aI`). */
    authoredAt: text('authored_at').notNull(),
    /** Committer display name (from `git log %cn`). */
    committerName: text('committer_name'),
    /** Committer email (from `git log %ce`). */
    committerEmail: text('committer_email'),
    /** ISO-8601 committer timestamp (from `git log %cI`). */
    committedAt: text('committed_at').notNull(),
    /** Full commit message body (subject + blank line + body if present). */
    message: text('message').notNull(),
    /** First line of the commit message (the subject). */
    subject: text('subject').notNull(),
    /**
     * Conventional Commits type parsed from the subject line.
     * NULL when the commit does not follow Conventional Commits format.
     * See {@link COMMIT_CONVENTIONAL_TYPES}.
     */
    conventionalType: text('conventional_type'),
    /** 1 when this commit matches the `chore(release): vX.Y.Z` release pattern. */
    isReleaseCommit: integer('is_release_commit').notNull().default(0),
    /** 1 when the commit has more than one parent (merge commit). */
    isMergeCommit: integer('is_merge_commit').notNull().default(0),
    /** JSON array of parent SHA strings. Most commits have exactly one element. */
    parentShas: text('parent_shas').notNull().default('[]'),
    /** 0=signature absent or invalid, 1=signature verified, NULL=not checked. */
    signatureVerified: integer('signature_verified'),
    /** Best-effort: branch HEAD was on at commit time. NULL if unavailable. */
    branchAtCommit: text('branch_at_commit'),
    /**
     * Project hash from `audit_log.project_hash` — correlates commits to a
     * specific CLEO project in multi-repo installs.
     */
    projectHash: text('project_hash'),
    /** ISO-8601 timestamp when this row was inserted into tasks.db. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_commits_short_sha').on(table.shortSha),
    index('idx_commits_author_email').on(table.authorEmail),
    index('idx_commits_authored_at').on(table.authoredAt),
    index('idx_commits_conventional_type').on(table.conventionalType),
    index('idx_commits_is_release').on(table.isReleaseCommit),
    index('idx_commits_project_hash').on(table.projectHash),
  ],
);

/**
 * `task_commits` — M:N junction between tasks and commits.
 *
 * @task T9506
 * @epic T9491
 * @see SPEC-T9345 §3.2
 */
export const taskCommits = sqliteTable(
  'task_commits',
  {
    /**
     * FK → tasks.id. Uses ON DELETE SET NULL to preserve linkage history
     * after task deletion. NULL = orphaned link (task was purged).
     */
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    /** FK → commits.sha. ON DELETE CASCADE — purging a commit clears its links. */
    commitSha: text('commit_sha')
      .notNull()
      .references(() => commits.sha, { onDelete: 'cascade' }),
    /**
     * Semantic classification of the task↔commit relationship.
     * See {@link COMMIT_LINK_KINDS}.
     */
    linkKind: text('link_kind').notNull(),
    /**
     * How this link was discovered (commit-trailer, branch-name, manual, etc.).
     * See {@link COMMIT_LINK_SOURCES}.
     */
    linkSource: text('link_source').notNull(),
    /** ISO-8601 timestamp when this link was created. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.commitSha, table.linkKind] }),
    index('idx_task_commits_task_id').on(table.taskId),
    index('idx_task_commits_commit_sha').on(table.commitSha),
    index('idx_task_commits_link_kind').on(table.linkKind),
  ],
);

/**
 * `commit_files` — Per-file × SHA materialization (blast-radius enabler).
 *
 * @task T9506
 * @epic T9491
 * @see SPEC-T9345 §3.3
 */
export const commitFiles = sqliteTable(
  'commit_files',
  {
    /** FK → commits.sha. ON DELETE CASCADE. */
    commitSha: text('commit_sha')
      .notNull()
      .references(() => commits.sha, { onDelete: 'cascade' }),
    /** Canonical repo-relative file path (after rename, if any). */
    path: text('path').notNull(),
    /**
     * Previous path before a rename or copy operation.
     * NULL for A / M / D change types.
     */
    oldPath: text('old_path'),
    /**
     * Git status letter: A=added, M=modified, D=deleted, R=renamed, C=copied.
     * See {@link COMMIT_FILE_CHANGE_TYPES}.
     */
    changeType: text('change_type').notNull(),
    /** Lines added in this commit for this file (0 for deletions and binary files). */
    linesAdded: integer('lines_added').notNull().default(0),
    /** Lines deleted in this commit for this file (0 for additions and binary files). */
    linesDeleted: integer('lines_deleted').notNull().default(0),
    /** 1 if the file is binary (diff stats are 0/0). */
    isBinary: integer('is_binary').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.commitSha, table.path] }),
    index('idx_commit_files_path').on(table.path),
    index('idx_commit_files_change_type').on(table.changeType),
  ],
);

// === TYPE EXPORTS ===

export type CommitRow = typeof commits.$inferSelect;
export type NewCommitRow = typeof commits.$inferInsert;
export type TaskCommitRow = typeof taskCommits.$inferSelect;
export type NewTaskCommitRow = typeof taskCommits.$inferInsert;
export type CommitFileRow = typeof commitFiles.$inferSelect;
export type NewCommitFileRow = typeof commitFiles.$inferInsert;
