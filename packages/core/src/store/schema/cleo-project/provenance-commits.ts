/**
 * Project-scope `cleo.db` — consolidated **provenance / commits** domain.
 *
 * Part of the consolidated PROJECT-scope `cleo.db` target shape authored for
 * SG-DB-SUBSTRATE-V2 (saga T11242, epic T11245/E2, task T11360). Target-shape
 * authoring only — physical names carry the `tasks_` domain prefix (provenance
 * is a satellite of the project-tier tasks-core cluster per the canonical
 * `targetTable` map). The live runtime module
 * `schema/provenance/commits.ts` keeps its UNPREFIXED physical names
 * (`commits` / `task_commits` / `commit_files`) until the exodus migration
 * (T11248) deploys this shape; the migration-baseline test depends on the live
 * names, so they must not change in-place.
 *
 * This module is the canonical demonstration of the E10 §3b boolean
 * non-conformer transform within T11360's slice:
 *
 *   - `commits.is_release_commit`   INTEGER 0/1  → integer({ mode: 'boolean' })
 *   - `commits.is_merge_commit`     INTEGER 0/1  → integer({ mode: 'boolean' })
 *   - `commit_files.is_binary`      INTEGER 0/1  → integer({ mode: 'boolean' })
 *
 * The matching SQL `CHECK (col IN (0,1))` ships as raw DDL in the exodus
 * migration (drizzle-orm sqlite-core surfaces no typed per-column CHECK DSL in
 * rc.3); the `{ mode: 'boolean' }` builder guarantees the application only ever
 * writes 0/1, so the row type narrows to `boolean`.
 *
 * ## E10 enum-like bare-TEXT transform (§5b)
 *
 * Four §5b enum-like bare-TEXT non-conformers gain `{ enum }` narrowing from
 * the named const arrays already declared in the live module (referenced by
 * identifier, never hand-typed literals — §5a):
 *
 *   - `commits.conventional_type`   → { enum: COMMIT_CONVENTIONAL_TYPES }
 *   - `task_commits.link_kind`      → { enum: COMMIT_LINK_KINDS }
 *   - `task_commits.link_source`    → { enum: COMMIT_LINK_SOURCES }
 *   - `commit_files.change_type`    → { enum: COMMIT_FILE_CHANGE_TYPES }
 *
 * ## E10 timestamps (§4)
 *
 * All timestamp columns are already the canonical TEXT ISO8601 form
 * (`authored_at`, `committed_at`, `created_at`); none were epoch non-conformers.
 *
 * @task T11360
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §1 (D1″) · §3b · §5 · §4
 * @see docs/migration/sqlite-schema-columns.json (per-column affinity SSoT)
 */

import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  COMMIT_CONVENTIONAL_TYPES,
  COMMIT_FILE_CHANGE_TYPES,
  COMMIT_LINK_KINDS,
  COMMIT_LINK_SOURCES,
} from '../provenance/commits.js';

/**
 * `tasks_commits` — domain-prefixed target of the legacy `commits` table.
 *
 * @task T11360 (target shape) · T9506 (original)
 */
export const tasksCommits = sqliteTable(
  'tasks_commits',
  {
    /** Full 40-char git SHA — primary key. */
    sha: text('sha').primaryKey(),
    /** First 7 characters of the SHA for display purposes. */
    shortSha: text('short_sha').notNull(),
    /** Author display name (from `git log %an`). */
    authorName: text('author_name'),
    /** Author email (from `git log %ae`). */
    authorEmail: text('author_email'),
    /** ISO-8601 author timestamp (canonical TEXT, §4). */
    authoredAt: text('authored_at').notNull(),
    /** Committer display name (from `git log %cn`). */
    committerName: text('committer_name'),
    /** Committer email (from `git log %ce`). */
    committerEmail: text('committer_email'),
    /** ISO-8601 committer timestamp (canonical TEXT, §4). */
    committedAt: text('committed_at').notNull(),
    /** Full commit message body (subject + blank line + body if present). */
    message: text('message').notNull(),
    /** First line of the commit message (the subject). */
    subject: text('subject').notNull(),
    /**
     * Conventional Commits type parsed from the subject; NULL when the commit
     * does not follow Conventional Commits format. E10 §5b: now CHECK-backed
     * via {@link COMMIT_CONVENTIONAL_TYPES}.
     */
    conventionalType: text('conventional_type', { enum: COMMIT_CONVENTIONAL_TYPES }),
    /**
     * Whether this commit matches the `chore(release): vX.Y.Z` release pattern.
     * E10 §3b: untyped INTEGER 0/1 → typed boolean.
     */
    isReleaseCommit: integer('is_release_commit', { mode: 'boolean' }).notNull().default(false),
    /**
     * Whether the commit has more than one parent (merge commit).
     * E10 §3b: untyped INTEGER 0/1 → typed boolean.
     */
    isMergeCommit: integer('is_merge_commit', { mode: 'boolean' }).notNull().default(false),
    /** JSON array of parent SHA strings (TEXT per JSON audit; empty-array default). */
    parentShas: text('parent_shas').notNull().default('[]'),
    /**
     * Signature verification tri-state: 0=absent/invalid, 1=verified,
     * NULL=not checked. Tri-state, so NOT a 0/1 boolean — kept numeric.
     */
    signatureVerified: integer('signature_verified'),
    /** Best-effort branch HEAD was on at commit time; NULL if unavailable. */
    branchAtCommit: text('branch_at_commit'),
    /** Project hash correlating commits to a specific CLEO project. */
    projectHash: text('project_hash'),
    /** ISO-8601 UTC insertion instant (canonical TEXT timestamp, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_tasks_commits_short_sha').on(table.shortSha),
    index('idx_tasks_commits_author_email').on(table.authorEmail),
    index('idx_tasks_commits_authored_at').on(table.authoredAt),
    index('idx_tasks_commits_conventional_type').on(table.conventionalType),
    index('idx_tasks_commits_is_release').on(table.isReleaseCommit),
    index('idx_tasks_commits_project_hash').on(table.projectHash),
  ],
);

/**
 * `tasks_task_commits` — M:N junction between tasks and commits.
 *
 * Domain-prefixed target of the legacy `task_commits` table. `task_id` is a
 * cross-table FK into `tasks_tasks` resolved by the exodus prefixer; carried
 * here as a plain TEXT id. `commit_sha` references the in-module
 * {@link tasksCommits}.
 *
 * @task T11360 (target shape) · T9506 (original)
 */
export const tasksTaskCommits = sqliteTable(
  'tasks_task_commits',
  {
    /** FK → `tasks_tasks.id` (resolved at exodus); NULL = orphaned link. */
    taskId: text('task_id'),
    /** FK → `tasks_commits.sha`. ON DELETE CASCADE. */
    commitSha: text('commit_sha')
      .notNull()
      .references(() => tasksCommits.sha, { onDelete: 'cascade' }),
    /** Semantic task↔commit relationship — E10 §5b CHECK-backed. */
    linkKind: text('link_kind', { enum: COMMIT_LINK_KINDS }).notNull(),
    /** How this link was discovered — E10 §5b CHECK-backed. */
    linkSource: text('link_source', { enum: COMMIT_LINK_SOURCES }).notNull(),
    /** ISO-8601 UTC link-creation instant (canonical TEXT timestamp, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.commitSha, table.linkKind] }),
    index('idx_tasks_task_commits_task_id').on(table.taskId),
    index('idx_tasks_task_commits_commit_sha').on(table.commitSha),
    index('idx_tasks_task_commits_link_kind').on(table.linkKind),
  ],
);

/**
 * `tasks_commit_files` — per-file × SHA materialization (blast-radius enabler).
 *
 * Domain-prefixed target of the legacy `commit_files` table.
 *
 * @task T11360 (target shape) · T9506 (original)
 */
export const tasksCommitFiles = sqliteTable(
  'tasks_commit_files',
  {
    /** FK → `tasks_commits.sha`. ON DELETE CASCADE. */
    commitSha: text('commit_sha')
      .notNull()
      .references(() => tasksCommits.sha, { onDelete: 'cascade' }),
    /** Canonical repo-relative file path (after rename, if any). */
    path: text('path').notNull(),
    /** Previous path before a rename/copy; NULL for A/M/D change types. */
    oldPath: text('old_path'),
    /** Git status letter — E10 §5b CHECK-backed via {@link COMMIT_FILE_CHANGE_TYPES}. */
    changeType: text('change_type', { enum: COMMIT_FILE_CHANGE_TYPES }).notNull(),
    /** Lines added (0 for deletions and binary files). */
    linesAdded: integer('lines_added').notNull().default(0),
    /** Lines deleted (0 for additions and binary files). */
    linesDeleted: integer('lines_deleted').notNull().default(0),
    /** Whether the file is binary. E10 §3b: untyped INTEGER 0/1 → typed boolean. */
    isBinary: integer('is_binary', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.commitSha, table.path] }),
    index('idx_tasks_commit_files_path').on(table.path),
    index('idx_tasks_commit_files_change_type').on(table.changeType),
  ],
);

// === TYPE EXPORTS ===

/** Row type for `tasks_commits` SELECT queries (target shape). */
export type TasksCommitRow = typeof tasksCommits.$inferSelect;
/** Row type for `tasks_commits` INSERT operations (target shape). */
export type NewTasksCommitRow = typeof tasksCommits.$inferInsert;
/** Row type for `tasks_task_commits` SELECT queries (target shape). */
export type TasksTaskCommitRow = typeof tasksTaskCommits.$inferSelect;
/** Row type for `tasks_task_commits` INSERT operations (target shape). */
export type NewTasksTaskCommitRow = typeof tasksTaskCommits.$inferInsert;
/** Row type for `tasks_commit_files` SELECT queries (target shape). */
export type TasksCommitFileRow = typeof tasksCommitFiles.$inferSelect;
/** Row type for `tasks_commit_files` INSERT operations (target shape). */
export type NewTasksCommitFileRow = typeof tasksCommitFiles.$inferInsert;
