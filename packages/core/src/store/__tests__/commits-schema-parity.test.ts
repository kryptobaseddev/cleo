/**
 * Schema parity guardrails for the T9506 provenance graph tables:
 *   `commits`, `task_commits`, `commit_files`.
 *
 * Each test validates that:
 *   1. The migration SQL file creates the expected table with correct column names.
 *   2. The migration SQL defines the expected indexes.
 *   3. The Drizzle schema enums in tasks-schema.ts are consistent with what
 *      the migration embeds (when CHECK constraints are present).
 *   4. All three tables apply cleanly on a fresh in-memory tasks.db via the
 *      standard `migrateSanitized` pipeline.
 *
 * @task T9506
 * @epic T9491
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMIT_CONVENTIONAL_TYPES,
  COMMIT_FILE_CHANGE_TYPES,
  COMMIT_LINK_KINDS,
  COMMIT_LINK_SOURCES,
  commitFiles,
  commits,
  taskCommits,
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

/** Find the migration SQL for a given T9506 table. */
function getMigrationSql(tableHint: string): string {
  const files = getAllMigrationFiles();
  const match = files.filter(({ sql }) => sql.includes(tableHint)).pop(); // use the latest migration that mentions the table
  if (!match) throw new Error(`No migration found for table hint: ${tableHint}`);
  return match.sql;
}

// ---------------------------------------------------------------------------
// Section 1: Migration SQL content checks
// ---------------------------------------------------------------------------

describe('T9506 commits migration SQL', () => {
  it('creates the commits table', () => {
    const sql = getMigrationSql('CREATE TABLE `commits`');
    expect(sql).toContain('CREATE TABLE `commits`');
  });

  it('has all required columns', () => {
    const sql = getMigrationSql('CREATE TABLE `commits`');
    const requiredCols = [
      'sha',
      'short_sha',
      'author_name',
      'author_email',
      'authored_at',
      'committer_name',
      'committer_email',
      'committed_at',
      'message',
      'subject',
      'conventional_type',
      'is_release_commit',
      'is_merge_commit',
      'parent_shas',
      'signature_verified',
      'branch_at_commit',
      'project_hash',
      'created_at',
    ];
    for (const col of requiredCols) {
      expect(sql, `Missing column: ${col}`).toContain(`\`${col}\``);
    }
  });

  it('defines all required indexes', () => {
    const sql = getMigrationSql('CREATE TABLE `commits`');
    const requiredIndexes = [
      'idx_commits_short_sha',
      'idx_commits_author_email',
      'idx_commits_authored_at',
      'idx_commits_conventional_type',
      'idx_commits_is_release',
      'idx_commits_project_hash',
    ];
    for (const idx of requiredIndexes) {
      expect(sql, `Missing index: ${idx}`).toContain(idx);
    }
  });
});

describe('T9506 task_commits migration SQL', () => {
  it('creates the task_commits table', () => {
    const sql = getMigrationSql('CREATE TABLE `task_commits`');
    expect(sql).toContain('CREATE TABLE `task_commits`');
  });

  it('has all required columns', () => {
    const sql = getMigrationSql('CREATE TABLE `task_commits`');
    const requiredCols = ['task_id', 'commit_sha', 'link_kind', 'link_source', 'created_at'];
    for (const col of requiredCols) {
      expect(sql, `Missing column: ${col}`).toContain(`\`${col}\``);
    }
  });

  it('declares composite PRIMARY KEY on (task_id, commit_sha, link_kind)', () => {
    const sql = getMigrationSql('CREATE TABLE `task_commits`');
    expect(sql).toContain('task_id');
    expect(sql).toContain('commit_sha');
    expect(sql).toContain('link_kind');
    expect(sql).toContain('PRIMARY KEY');
  });

  it('references commits table via FK on commit_sha', () => {
    const sql = getMigrationSql('CREATE TABLE `task_commits`');
    expect(sql).toContain('REFERENCES `commits`(`sha`)');
  });

  it('defines all required indexes', () => {
    const sql = getMigrationSql('CREATE TABLE `task_commits`');
    const requiredIndexes = [
      'idx_task_commits_task_id',
      'idx_task_commits_commit_sha',
      'idx_task_commits_link_kind',
    ];
    for (const idx of requiredIndexes) {
      expect(sql, `Missing index: ${idx}`).toContain(idx);
    }
  });
});

describe('T9506 commit_files migration SQL', () => {
  it('creates the commit_files table', () => {
    const sql = getMigrationSql('CREATE TABLE `commit_files`');
    expect(sql).toContain('CREATE TABLE `commit_files`');
  });

  it('has all required columns', () => {
    const sql = getMigrationSql('CREATE TABLE `commit_files`');
    const requiredCols = [
      'commit_sha',
      'path',
      'old_path',
      'change_type',
      'lines_added',
      'lines_deleted',
      'is_binary',
    ];
    for (const col of requiredCols) {
      expect(sql, `Missing column: ${col}`).toContain(`\`${col}\``);
    }
  });

  it('references commits table via FK on commit_sha', () => {
    const sql = getMigrationSql('CREATE TABLE `commit_files`');
    expect(sql).toContain('REFERENCES `commits`(`sha`)');
  });

  it('defines all required indexes', () => {
    const sql = getMigrationSql('CREATE TABLE `commit_files`');
    const requiredIndexes = ['idx_commit_files_path', 'idx_commit_files_change_type'];
    for (const idx of requiredIndexes) {
      expect(sql, `Missing index: ${idx}`).toContain(idx);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 2: Drizzle schema column-name parity checks
// ---------------------------------------------------------------------------

describe('T9506 Drizzle schema parity — commits', () => {
  it('exports the commits table with the correct column set', () => {
    const cols = Object.keys(commits);
    // Verify key structural columns are present via Drizzle table object
    expect(cols).toContain('sha');
    expect(cols).toContain('shortSha');
    expect(cols).toContain('authorName');
    expect(cols).toContain('authorEmail');
    expect(cols).toContain('authoredAt');
    expect(cols).toContain('committedAt');
    expect(cols).toContain('message');
    expect(cols).toContain('subject');
    expect(cols).toContain('conventionalType');
    expect(cols).toContain('isReleaseCommit');
    expect(cols).toContain('isMergeCommit');
    expect(cols).toContain('parentShas');
    expect(cols).toContain('projectHash');
    expect(cols).toContain('createdAt');
  });

  it('COMMIT_CONVENTIONAL_TYPES has at least the canonical CC prefixes', () => {
    const required = [
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
    ];
    for (const t of required) {
      expect(COMMIT_CONVENTIONAL_TYPES, `Missing CC type: ${t}`).toContain(t);
    }
  });
});

describe('T9506 Drizzle schema parity — task_commits', () => {
  it('exports the taskCommits table with the correct column set', () => {
    const cols = Object.keys(taskCommits);
    expect(cols).toContain('taskId');
    expect(cols).toContain('commitSha');
    expect(cols).toContain('linkKind');
    expect(cols).toContain('linkSource');
    expect(cols).toContain('createdAt');
  });

  it('COMMIT_LINK_KINDS contains all required values', () => {
    const required = ['implements', 'fixes', 'refactors', 'tests', 'docs', 'reverts'];
    for (const k of required) {
      expect(COMMIT_LINK_KINDS, `Missing link kind: ${k}`).toContain(k);
    }
  });

  it('COMMIT_LINK_SOURCES contains all required values', () => {
    const required = [
      'commit-trailer',
      'commit-subject',
      'pr-title',
      'pr-body',
      'branch-name',
      'manual',
    ];
    for (const s of required) {
      expect(COMMIT_LINK_SOURCES, `Missing link source: ${s}`).toContain(s);
    }
  });
});

describe('T9506 Drizzle schema parity — commit_files', () => {
  it('exports the commitFiles table with the correct column set', () => {
    const cols = Object.keys(commitFiles);
    expect(cols).toContain('commitSha');
    expect(cols).toContain('path');
    expect(cols).toContain('oldPath');
    expect(cols).toContain('changeType');
    expect(cols).toContain('linesAdded');
    expect(cols).toContain('linesDeleted');
    expect(cols).toContain('isBinary');
  });

  it('COMMIT_FILE_CHANGE_TYPES contains git status letter codes', () => {
    const required = ['A', 'M', 'D', 'R', 'C'];
    for (const c of required) {
      expect(COMMIT_FILE_CHANGE_TYPES, `Missing change type: ${c}`).toContain(c);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 3: End-to-end migration apply on a fresh tasks.db
// ---------------------------------------------------------------------------

describe('T9506 fresh migration apply — all 3 tables created', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t9506-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies all drizzle-tasks migrations cleanly and creates commits, task_commits, commit_files', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    const tableNames = ['commits', 'task_commits', 'commit_files'];
    for (const tableName of tableNames) {
      const row = nativeDb
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(tableName) as { name: string } | undefined;
      expect(row?.name, `Table '${tableName}' was not created`).toBe(tableName);
    }

    nativeDb.close();
  });

  it('commits table has the correct columns after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-col-check.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const cols = nativeDb.prepare('PRAGMA table_info(commits)').all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);

    const expectedCols = [
      'sha',
      'short_sha',
      'author_name',
      'author_email',
      'authored_at',
      'committer_name',
      'committer_email',
      'committed_at',
      'message',
      'subject',
      'conventional_type',
      'is_release_commit',
      'is_merge_commit',
      'parent_shas',
      'signature_verified',
      'branch_at_commit',
      'project_hash',
      'created_at',
    ];

    for (const col of expectedCols) {
      expect(colNames, `Column '${col}' missing from commits table`).toContain(col);
    }

    nativeDb.close();
  });

  it('task_commits table has correct columns and composite PK after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-tc-check.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const cols = nativeDb.prepare('PRAGMA table_info(task_commits)').all() as Array<{
      name: string;
      pk: number;
    }>;
    const colNames = cols.map((c) => c.name);
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);

    expect(colNames).toContain('task_id');
    expect(colNames).toContain('commit_sha');
    expect(colNames).toContain('link_kind');
    expect(colNames).toContain('link_source');
    expect(colNames).toContain('created_at');

    // All three PK columns must be present in the primary key
    expect(pkCols).toContain('task_id');
    expect(pkCols).toContain('commit_sha');
    expect(pkCols).toContain('link_kind');

    nativeDb.close();
  });

  it('commit_files table has correct columns and composite PK after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-cf-check.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const cols = nativeDb.prepare('PRAGMA table_info(commit_files)').all() as Array<{
      name: string;
      pk: number;
    }>;
    const colNames = cols.map((c) => c.name);
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);

    expect(colNames).toContain('commit_sha');
    expect(colNames).toContain('path');
    expect(colNames).toContain('old_path');
    expect(colNames).toContain('change_type');
    expect(colNames).toContain('lines_added');
    expect(colNames).toContain('lines_deleted');
    expect(colNames).toContain('is_binary');

    expect(pkCols).toContain('commit_sha');
    expect(pkCols).toContain('path');

    nativeDb.close();
  });

  it('all required indexes are present after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-idx-check.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const indexes = nativeDb
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as Array<{ name: string }>;
    const indexNames = new Set(indexes.map((r) => r.name));

    const expectedIndexes = [
      'idx_commits_short_sha',
      'idx_commits_author_email',
      'idx_commits_authored_at',
      'idx_commits_conventional_type',
      'idx_commits_is_release',
      'idx_commits_project_hash',
      'idx_task_commits_task_id',
      'idx_task_commits_commit_sha',
      'idx_task_commits_link_kind',
      'idx_commit_files_path',
      'idx_commit_files_change_type',
    ];

    for (const idx of expectedIndexes) {
      expect(indexNames, `Index '${idx}' missing after migration`).toContain(idx);
    }

    nativeDb.close();
  });

  it('legacy release_manifests table is untouched after provenance migrations', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-legacy-check.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    // release_manifests must still exist and contain its key columns
    const row = nativeDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='release_manifests'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('release_manifests');

    const cols = nativeDb.prepare('PRAGMA table_info(release_manifests)').all() as Array<{
      name: string;
    }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('version');
    expect(colNames).toContain('tasks_json');

    nativeDb.close();
  });
});
