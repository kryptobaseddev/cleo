/**
 * Schema parity guardrails for the T9507 provenance graph tables:
 *   `pull_requests`, `pr_commits`, `pr_tasks`.
 *
 * Each test validates that:
 *   1. The migration SQL file creates the expected table with correct column names.
 *   2. The migration SQL defines the expected indexes.
 *   3. The Drizzle schema enums in tasks-schema.ts are consistent with what
 *      the migration embeds (when CHECK constraints are present).
 *   4. All three tables apply cleanly on a fresh in-memory tasks.db via the
 *      standard `migrateSanitized` pipeline (including T9506 prerequisite tables).
 *
 * @task T9507
 * @epic T9491
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PR_LINK_KINDS,
  PR_LINK_SOURCES,
  PR_STATES,
  prCommits,
  prTasks,
  pullRequests,
} from '../tasks-schema.js';

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    opts?: { readonly?: boolean },
  ) => import('node:sqlite').DatabaseSync;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve path to the drizzle-tasks migration folder. */
function migrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

/** Read all migration SQL files from the drizzle-tasks folder (sorted). */
function getAllMigrationFiles(): Array<{ name: string; sql: string }> {
  const dir = migrationsDir();
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(dir, name, 'migration.sql'), 'utf-8'),
    }));
}

/** Find the migration SQL for a given T9507 table. */
function getMigrationSql(tableHint: string): string {
  const files = getAllMigrationFiles();
  const match = files.filter(({ sql }) => sql.includes(tableHint)).pop();
  if (!match) throw new Error(`No migration found for table hint: ${tableHint}`);
  return match.sql;
}

// ---------------------------------------------------------------------------
// Section 1: Migration SQL content checks
// ---------------------------------------------------------------------------

describe('T9507 pull_requests migration SQL', () => {
  it('creates the pull_requests table', () => {
    const sql = getMigrationSql('CREATE TABLE `pull_requests`');
    expect(sql).toContain('CREATE TABLE `pull_requests`');
  });

  it('has all required columns', () => {
    const sql = getMigrationSql('CREATE TABLE `pull_requests`');
    const requiredCols = [
      'id',
      'pr_number',
      'repo_url',
      'title',
      'body',
      'state',
      'base_ref',
      'head_ref',
      'head_sha',
      'merge_commit_sha',
      'author_login',
      'opened_at',
      'merged_at',
      'closed_at',
      'is_release_pr',
      'release_version',
      'is_bump_only',
      'project_hash',
      'created_at',
      'updated_at',
    ];
    for (const col of requiredCols) {
      expect(sql, `Missing column: ${col}`).toContain(`\`${col}\``);
    }
  });

  it('references commits table via FK on head_sha', () => {
    const sql = getMigrationSql('CREATE TABLE `pull_requests`');
    expect(sql).toContain('REFERENCES `commits`(`sha`)');
  });

  it('defines all required indexes', () => {
    const sql = getMigrationSql('CREATE TABLE `pull_requests`');
    const requiredIndexes = [
      'idx_pr_number',
      'idx_pr_state',
      'idx_pr_merge_commit_sha',
      'idx_pr_head_sha',
      'idx_pr_release_version',
      'idx_pr_project_hash',
    ];
    for (const idx of requiredIndexes) {
      expect(sql, `Missing index: ${idx}`).toContain(idx);
    }
  });
});

describe('T9507 pr_commits migration SQL', () => {
  it('creates the pr_commits table', () => {
    const sql = getMigrationSql('CREATE TABLE `pr_commits`');
    expect(sql).toContain('CREATE TABLE `pr_commits`');
  });

  it('has all required columns', () => {
    const sql = getMigrationSql('CREATE TABLE `pr_commits`');
    const requiredCols = ['pr_id', 'commit_sha', 'position'];
    for (const col of requiredCols) {
      expect(sql, `Missing column: ${col}`).toContain(`\`${col}\``);
    }
  });

  it('declares composite PRIMARY KEY on (pr_id, commit_sha)', () => {
    const sql = getMigrationSql('CREATE TABLE `pr_commits`');
    expect(sql).toContain('pr_id');
    expect(sql).toContain('commit_sha');
    expect(sql).toContain('PRIMARY KEY');
  });

  it('references pull_requests table via FK on pr_id', () => {
    const sql = getMigrationSql('CREATE TABLE `pr_commits`');
    expect(sql).toContain('REFERENCES `pull_requests`(`id`)');
  });

  it('references commits table via FK on commit_sha', () => {
    const sql = getMigrationSql('CREATE TABLE `pr_commits`');
    expect(sql).toContain('REFERENCES `commits`(`sha`)');
  });

  it('defines all required indexes', () => {
    const sql = getMigrationSql('CREATE TABLE `pr_commits`');
    const requiredIndexes = [
      'idx_pr_commits_pr_id',
      'idx_pr_commits_commit_sha',
      'idx_pr_commits_position',
    ];
    for (const idx of requiredIndexes) {
      expect(sql, `Missing index: ${idx}`).toContain(idx);
    }
  });
});

describe('T9507 pr_tasks migration SQL', () => {
  it('creates the pr_tasks table', () => {
    const sql = getMigrationSql('CREATE TABLE `pr_tasks`');
    expect(sql).toContain('CREATE TABLE `pr_tasks`');
  });

  it('has all required columns', () => {
    const sql = getMigrationSql('CREATE TABLE `pr_tasks`');
    const requiredCols = ['pr_id', 'task_id', 'link_source', 'link_kind', 'created_at'];
    for (const col of requiredCols) {
      expect(sql, `Missing column: ${col}`).toContain(`\`${col}\``);
    }
  });

  it('declares composite PRIMARY KEY on (pr_id, task_id, link_kind)', () => {
    const sql = getMigrationSql('CREATE TABLE `pr_tasks`');
    expect(sql).toContain('pr_id');
    expect(sql).toContain('task_id');
    expect(sql).toContain('link_kind');
    expect(sql).toContain('PRIMARY KEY');
  });

  it('references pull_requests table via FK on pr_id', () => {
    const sql = getMigrationSql('CREATE TABLE `pr_tasks`');
    expect(sql).toContain('REFERENCES `pull_requests`(`id`)');
  });

  it('references tasks table via FK on task_id', () => {
    const sql = getMigrationSql('CREATE TABLE `pr_tasks`');
    expect(sql).toContain('REFERENCES `tasks`(`id`)');
  });

  it('defines all required indexes', () => {
    const sql = getMigrationSql('CREATE TABLE `pr_tasks`');
    const requiredIndexes = [
      'idx_pr_tasks_pr_id',
      'idx_pr_tasks_task_id',
      'idx_pr_tasks_link_source',
    ];
    for (const idx of requiredIndexes) {
      expect(sql, `Missing index: ${idx}`).toContain(idx);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 2: Drizzle schema column-name parity checks
// ---------------------------------------------------------------------------

describe('T9507 Drizzle schema parity — pull_requests', () => {
  it('exports the pullRequests table with the correct column set', () => {
    const cols = Object.keys(pullRequests);
    expect(cols).toContain('id');
    expect(cols).toContain('prNumber');
    expect(cols).toContain('repoUrl');
    expect(cols).toContain('title');
    expect(cols).toContain('body');
    expect(cols).toContain('state');
    expect(cols).toContain('baseRef');
    expect(cols).toContain('headRef');
    expect(cols).toContain('headSha');
    expect(cols).toContain('mergeCommitSha');
    expect(cols).toContain('authorLogin');
    expect(cols).toContain('openedAt');
    expect(cols).toContain('mergedAt');
    expect(cols).toContain('closedAt');
    expect(cols).toContain('isReleasePr');
    expect(cols).toContain('releaseVersion');
    expect(cols).toContain('isBumpOnly');
    expect(cols).toContain('projectHash');
    expect(cols).toContain('createdAt');
    expect(cols).toContain('updatedAt');
  });

  it('PR_STATES contains all required values', () => {
    const required = ['open', 'closed', 'merged'];
    for (const s of required) {
      expect(PR_STATES, `Missing PR state: ${s}`).toContain(s);
    }
  });
});

describe('T9507 Drizzle schema parity — pr_commits', () => {
  it('exports the prCommits table with the correct column set', () => {
    const cols = Object.keys(prCommits);
    expect(cols).toContain('prId');
    expect(cols).toContain('commitSha');
    expect(cols).toContain('position');
  });
});

describe('T9507 Drizzle schema parity — pr_tasks', () => {
  it('exports the prTasks table with the correct column set', () => {
    const cols = Object.keys(prTasks);
    expect(cols).toContain('prId');
    expect(cols).toContain('taskId');
    expect(cols).toContain('linkSource');
    expect(cols).toContain('linkKind');
    expect(cols).toContain('createdAt');
  });

  it('PR_LINK_SOURCES contains all required values', () => {
    const required = ['pr-title', 'pr-body', 'branch-name', 'commit-trailer', 'manual'];
    for (const s of required) {
      expect(PR_LINK_SOURCES, `Missing PR link source: ${s}`).toContain(s);
    }
  });

  it('PR_LINK_KINDS contains all required values including tracks', () => {
    const required = ['implements', 'fixes', 'refactors', 'tests', 'docs', 'reverts', 'tracks'];
    for (const k of required) {
      expect(PR_LINK_KINDS, `Missing PR link kind: ${k}`).toContain(k);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 3: End-to-end migration apply on a fresh tasks.db
// ---------------------------------------------------------------------------

describe('T9507 fresh migration apply — all 3 PR tables created', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t9507-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies all drizzle-tasks migrations cleanly and creates pull_requests, pr_commits, pr_tasks', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    const tableNames = ['pull_requests', 'pr_commits', 'pr_tasks'];
    for (const tableName of tableNames) {
      const row = nativeDb
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(tableName) as { name: string } | undefined;
      expect(row?.name, `Table '${tableName}' was not created`).toBe(tableName);
    }

    nativeDb.close();
  });

  it('pull_requests table has the correct columns after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-pr-col-check.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const cols = nativeDb.prepare('PRAGMA table_info(pull_requests)').all() as Array<{
      name: string;
    }>;
    const colNames = cols.map((c) => c.name);

    const expectedCols = [
      'id',
      'pr_number',
      'repo_url',
      'title',
      'body',
      'state',
      'base_ref',
      'head_ref',
      'head_sha',
      'merge_commit_sha',
      'author_login',
      'opened_at',
      'merged_at',
      'closed_at',
      'is_release_pr',
      'release_version',
      'is_bump_only',
      'project_hash',
      'created_at',
      'updated_at',
    ];

    for (const col of expectedCols) {
      expect(colNames, `Column '${col}' missing from pull_requests table`).toContain(col);
    }

    nativeDb.close();
  });

  it('pr_commits table has correct columns and composite PK after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-prc-check.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const cols = nativeDb.prepare('PRAGMA table_info(pr_commits)').all() as Array<{
      name: string;
      pk: number;
    }>;
    const colNames = cols.map((c) => c.name);
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);

    expect(colNames).toContain('pr_id');
    expect(colNames).toContain('commit_sha');
    expect(colNames).toContain('position');

    expect(pkCols).toContain('pr_id');
    expect(pkCols).toContain('commit_sha');

    nativeDb.close();
  });

  it('pr_tasks table has correct columns and composite PK after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-prt-check.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const cols = nativeDb.prepare('PRAGMA table_info(pr_tasks)').all() as Array<{
      name: string;
      pk: number;
    }>;
    const colNames = cols.map((c) => c.name);
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);

    expect(colNames).toContain('pr_id');
    expect(colNames).toContain('task_id');
    expect(colNames).toContain('link_source');
    expect(colNames).toContain('link_kind');
    expect(colNames).toContain('created_at');

    expect(pkCols).toContain('pr_id');
    expect(pkCols).toContain('task_id');
    expect(pkCols).toContain('link_kind');

    nativeDb.close();
  });

  it('all 12 required indexes are present after migration (6+3+3)', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-pr-idx-check.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const indexes = nativeDb
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as Array<{ name: string }>;
    const indexNames = new Set(indexes.map((r) => r.name));

    // pull_requests (6 indexes)
    const prIndexes = [
      'idx_pr_number',
      'idx_pr_state',
      'idx_pr_merge_commit_sha',
      'idx_pr_head_sha',
      'idx_pr_release_version',
      'idx_pr_project_hash',
    ];
    // pr_commits (3 indexes)
    const prCommitsIndexes = [
      'idx_pr_commits_pr_id',
      'idx_pr_commits_commit_sha',
      'idx_pr_commits_position',
    ];
    // pr_tasks (3 indexes)
    const prTasksIndexes = [
      'idx_pr_tasks_pr_id',
      'idx_pr_tasks_task_id',
      'idx_pr_tasks_link_source',
    ];

    const expectedIndexes = [...prIndexes, ...prCommitsIndexes, ...prTasksIndexes];
    for (const idx of expectedIndexes) {
      expect(indexNames, `Index '${idx}' missing after migration`).toContain(idx);
    }

    nativeDb.close();
  });

  it('T9686-B2: `release_manifests` is dropped, `commits` is untouched after PR provenance migrations', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-pr-legacy-check.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    // Legacy `release_manifests` must NO LONGER exist after T9686-B2.
    const rmRow = nativeDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='release_manifests'")
      .get() as { name: string } | undefined;
    expect(rmRow, 'release_manifests must be dropped by T9686-B2').toBeUndefined();

    // The canonical `releases` table carries the legacy columns now.
    const releasesCols = nativeDb.prepare('PRAGMA table_info(releases)').all() as Array<{
      name: string;
    }>;
    const releasesColNames = releasesCols.map((c) => c.name);
    expect(releasesColNames).toContain('id');
    expect(releasesColNames).toContain('version');
    expect(releasesColNames).toContain('tasks_json');

    // T9506 commits table must still exist (untouched by T9686-B2).
    const commitsRow = nativeDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='commits'")
      .get() as { name: string } | undefined;
    expect(commitsRow?.name).toBe('commits');

    nativeDb.close();
  });
});
