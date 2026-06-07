/**
 * Schema parity guardrails for the T9508 provenance graph tables:
 *   `releases`, `release_commits`, `release_changes`.
 *
 * Each test validates that:
 *   1. The migration SQL file creates the expected table with correct column names.
 *   2. The migration SQL defines the expected indexes.
 *   3. The Drizzle schema enums in tasks-schema.ts are consistent (value counts,
 *      required values, and FSM invariants).
 *   4. All three tables apply cleanly on a fresh in-memory tasks.db via the
 *      standard `migrateSanitized` pipeline.
 *   5. The legacy `release_manifests` table is untouched (F12 — ADR-073).
 *
 * @task T9508
 * @epic T9491
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RELEASE_CHANGE_TYPES,
  RELEASE_CHANNELS,
  RELEASE_CLASSIFIED_BY,
  RELEASE_IMPACTS,
  RELEASE_KINDS,
  RELEASE_SCHEMES,
  RELEASE_STATUSES,
  releaseChanges,
  releaseCommits,
  releases,
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

/** Find the migration SQL for a given T9508 table. Returns latest match. */
function getMigrationSql(tableHint: string): string {
  const files = getAllMigrationFiles();
  const match = files.filter(({ sql }) => sql.includes(tableHint)).pop();
  if (!match) throw new Error(`No migration found for table hint: ${tableHint}`);
  return match.sql;
}

// ---------------------------------------------------------------------------
// Section 1: Migration SQL content checks — `releases`
// ---------------------------------------------------------------------------

describe('T9508 releases migration SQL', () => {
  it('creates the releases table', () => {
    const sql = getMigrationSql('CREATE TABLE `releases`');
    expect(sql).toContain('CREATE TABLE `releases`');
  });

  it('has all required columns', () => {
    const sql = getMigrationSql('CREATE TABLE `releases`');
    const requiredCols = [
      'id',
      'version',
      'scheme',
      'channel',
      'epic_id',
      'release_kind',
      'status',
      'previous_version',
      'merge_commit_sha',
      'pr_id',
      'workflow_run_url',
      'created_at',
      'planned_at',
      'pr_opened_at',
      'pr_merged_at',
      'published_at',
      'reconciled_at',
      'rolled_back_at',
      'failed_at',
      'cancelled_at',
      'failure_reason',
      'rolled_back_by',
      'project_hash',
    ];
    for (const col of requiredCols) {
      expect(sql, `Missing column: ${col}`).toContain(`\`${col}\``);
    }
  });

  it('declares UNIQUE on version', () => {
    const sql = getMigrationSql('CREATE TABLE `releases`');
    expect(sql).toContain('version');
    expect(sql).toContain('UNIQUE');
  });

  it('references tasks table via FK on epic_id', () => {
    const sql = getMigrationSql('CREATE TABLE `releases`');
    expect(sql).toContain('REFERENCES `tasks`(`id`)');
    expect(sql).toContain('epic_id');
  });

  it('references commits table via FK on merge_commit_sha', () => {
    const sql = getMigrationSql('CREATE TABLE `releases`');
    expect(sql).toContain('REFERENCES `commits`(`sha`)');
    expect(sql).toContain('merge_commit_sha');
  });

  it('defines all required indexes', () => {
    const sql = getMigrationSql('CREATE TABLE `releases`');
    const requiredIndexes = [
      'idx_releases_version',
      'idx_releases_status',
      'idx_releases_channel',
      'idx_releases_epic_id',
      'idx_releases_merge_commit_sha',
      'idx_releases_project_hash',
      'idx_releases_published_at',
    ];
    for (const idx of requiredIndexes) {
      expect(sql, `Missing index: ${idx}`).toContain(idx);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 2: Migration SQL content checks — `release_commits`
// ---------------------------------------------------------------------------

describe('T9508 release_commits migration SQL', () => {
  it('creates the release_commits table', () => {
    const sql = getMigrationSql('CREATE TABLE `release_commits`');
    expect(sql).toContain('CREATE TABLE `release_commits`');
  });

  it('has all required columns', () => {
    const sql = getMigrationSql('CREATE TABLE `release_commits`');
    const requiredCols = [
      'release_id',
      'commit_sha',
      'position',
      'is_first',
      'is_last',
      'is_release_chore',
    ];
    for (const col of requiredCols) {
      expect(sql, `Missing column: ${col}`).toContain(`\`${col}\``);
    }
  });

  it('declares composite PRIMARY KEY on (release_id, commit_sha)', () => {
    const sql = getMigrationSql('CREATE TABLE `release_commits`');
    expect(sql).toContain('PRIMARY KEY');
    expect(sql).toContain('release_id');
    expect(sql).toContain('commit_sha');
  });

  it('references releases table via FK on release_id', () => {
    const sql = getMigrationSql('CREATE TABLE `release_commits`');
    expect(sql).toContain('REFERENCES `releases`(`id`)');
  });

  it('references commits table via FK on commit_sha', () => {
    const sql = getMigrationSql('CREATE TABLE `release_commits`');
    expect(sql).toContain('REFERENCES `commits`(`sha`)');
  });

  it('defines all required indexes', () => {
    const sql = getMigrationSql('CREATE TABLE `release_commits`');
    const requiredIndexes = [
      'idx_release_commits_release_id',
      'idx_release_commits_commit_sha',
      'idx_release_commits_position',
    ];
    for (const idx of requiredIndexes) {
      expect(sql, `Missing index: ${idx}`).toContain(idx);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 3: Migration SQL content checks — `release_changes`
// ---------------------------------------------------------------------------

describe('T9508 release_changes migration SQL', () => {
  it('creates the release_changes table', () => {
    const sql = getMigrationSql('CREATE TABLE `release_changes`');
    expect(sql).toContain('CREATE TABLE `release_changes`');
  });

  it('has all required columns', () => {
    const sql = getMigrationSql('CREATE TABLE `release_changes`');
    const requiredCols = [
      'id',
      'release_id',
      'task_id',
      'change_type',
      'summary',
      'description',
      'impact',
      'classified_by',
      'classified_at',
    ];
    for (const col of requiredCols) {
      expect(sql, `Missing column: ${col}`).toContain(`\`${col}\``);
    }
  });

  it('references releases table via FK on release_id', () => {
    const sql = getMigrationSql('CREATE TABLE `release_changes`');
    expect(sql).toContain('REFERENCES `releases`(`id`)');
  });

  it('references tasks table via FK on task_id with SET NULL', () => {
    const sql = getMigrationSql('CREATE TABLE `release_changes`');
    expect(sql).toContain('task_id');
    expect(sql).toContain('SET NULL');
    expect(sql).toContain('REFERENCES `tasks`(`id`)');
  });

  it('defines all required indexes', () => {
    const sql = getMigrationSql('CREATE TABLE `release_changes`');
    const requiredIndexes = [
      'idx_release_changes_release_id',
      'idx_release_changes_task_id',
      'idx_release_changes_change_type',
      'idx_release_changes_impact',
    ];
    for (const idx of requiredIndexes) {
      expect(sql, `Missing index: ${idx}`).toContain(idx);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 4: Drizzle schema column-name parity checks
// ---------------------------------------------------------------------------

describe('T9508 / T9686-B2 Drizzle schema parity — unified `releases` table', () => {
  it('exports the unified `releases` table with the correct column set', () => {
    const cols = Object.keys(releases);
    // New T9492 pipeline columns (T9508)
    expect(cols).toContain('id');
    expect(cols).toContain('version');
    expect(cols).toContain('scheme');
    expect(cols).toContain('channel');
    expect(cols).toContain('epicId');
    expect(cols).toContain('releaseKind');
    expect(cols).toContain('status');
    expect(cols).toContain('previousVersion');
    expect(cols).toContain('mergeCommitSha');
    expect(cols).toContain('prId');
    expect(cols).toContain('workflowRunUrl');
    expect(cols).toContain('createdAt');
    expect(cols).toContain('plannedAt');
    expect(cols).toContain('prOpenedAt');
    expect(cols).toContain('prMergedAt');
    expect(cols).toContain('publishedAt');
    expect(cols).toContain('reconciledAt');
    expect(cols).toContain('rolledBackAt');
    expect(cols).toContain('failedAt');
    expect(cols).toContain('cancelledAt');
    expect(cols).toContain('failureReason');
    expect(cols).toContain('rolledBackBy');
    expect(cols).toContain('projectHash');
    // Legacy T5580 pipeline columns merged in by T9686-B2
    expect(cols).toContain('tasksJson');
    expect(cols).toContain('changelog');
    expect(cols).toContain('notes');
    expect(cols).toContain('gitTag');
    expect(cols).toContain('preparedAt');
    expect(cols).toContain('committedAt');
    expect(cols).toContain('taggedAt');
    expect(cols).toContain('pushedAt');
  });
});

describe('T9508 Drizzle schema parity — releaseCommits', () => {
  it('exports the releaseCommits table with the correct column set', () => {
    const cols = Object.keys(releaseCommits);
    expect(cols).toContain('releaseId');
    expect(cols).toContain('commitSha');
    expect(cols).toContain('position');
    expect(cols).toContain('isFirst');
    expect(cols).toContain('isLast');
    expect(cols).toContain('isReleaseChore');
  });
});

describe('T9508 Drizzle schema parity — releaseChanges', () => {
  it('exports the releaseChanges table with the correct column set', () => {
    const cols = Object.keys(releaseChanges);
    expect(cols).toContain('id');
    expect(cols).toContain('releaseId');
    expect(cols).toContain('taskId');
    expect(cols).toContain('changeType');
    expect(cols).toContain('summary');
    expect(cols).toContain('description');
    expect(cols).toContain('impact');
    expect(cols).toContain('classifiedBy');
    expect(cols).toContain('classifiedAt');
  });
});

// ---------------------------------------------------------------------------
// Section 5: Enum constant invariants
// ---------------------------------------------------------------------------

describe('T9508 enum constant invariants', () => {
  it('RELEASE_SCHEMES contains exactly the 3 supported schemes', () => {
    expect(RELEASE_SCHEMES).toHaveLength(3);
    expect(RELEASE_SCHEMES).toContain('calver');
    expect(RELEASE_SCHEMES).toContain('semver');
    expect(RELEASE_SCHEMES).toContain('calver-suffix');
  });

  it('RELEASE_CHANNELS contains exactly the 4 supported channels', () => {
    expect(RELEASE_CHANNELS).toHaveLength(4);
    expect(RELEASE_CHANNELS).toContain('latest');
    expect(RELEASE_CHANNELS).toContain('beta');
    expect(RELEASE_CHANNELS).toContain('dev');
    expect(RELEASE_CHANNELS).toContain('hotfix');
  });

  it('RELEASE_KINDS contains exactly the 3 supported kinds', () => {
    expect(RELEASE_KINDS).toHaveLength(3);
    expect(RELEASE_KINDS).toContain('regular');
    expect(RELEASE_KINDS).toContain('hotfix');
    expect(RELEASE_KINDS).toContain('prerelease');
  });

  it('RELEASE_STATUSES has exactly 12 values — union of new T9492 + legacy T5580 pipelines (T9686-B2)', () => {
    expect(RELEASE_STATUSES).toHaveLength(12);
    // New T9492 pipeline (SPEC-T9345 §10.1) non-terminal states
    expect(RELEASE_STATUSES).toContain('planned');
    expect(RELEASE_STATUSES).toContain('pr-opened');
    expect(RELEASE_STATUSES).toContain('pr-merged');
    expect(RELEASE_STATUSES).toContain('published');
    expect(RELEASE_STATUSES).toContain('reconciled');
    // Legacy T5580 pipeline states (merged in by T9686-B2)
    expect(RELEASE_STATUSES).toContain('prepared');
    expect(RELEASE_STATUSES).toContain('committed');
    expect(RELEASE_STATUSES).toContain('tagged');
    expect(RELEASE_STATUSES).toContain('pushed');
    // Shared terminal off-ramps
    expect(RELEASE_STATUSES).toContain('rolled_back');
    expect(RELEASE_STATUSES).toContain('failed');
    expect(RELEASE_STATUSES).toContain('cancelled');
  });

  it('RELEASE_STATUSES FSM — new-pipeline ordering preserved (planned → reconciled)', () => {
    // Order within the new-pipeline subset still matters: linear path first.
    const idx = (s: string) => (RELEASE_STATUSES as readonly string[]).indexOf(s);
    expect(idx('planned')).toBeLessThan(idx('pr-opened'));
    expect(idx('pr-opened')).toBeLessThan(idx('pr-merged'));
    expect(idx('pr-merged')).toBeLessThan(idx('published'));
    expect(idx('published')).toBeLessThan(idx('reconciled'));
    // Legacy block follows the new block; terminals follow legacy.
    expect(idx('reconciled')).toBeLessThan(idx('prepared'));
    expect(idx('pushed')).toBeLessThan(idx('rolled_back'));
  });

  it('RELEASE_CHANGE_TYPES has exactly 12 values per provenance-graph-design.md §2.2', () => {
    expect(RELEASE_CHANGE_TYPES).toHaveLength(12);
    const required = [
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
    for (const t of required) {
      expect(RELEASE_CHANGE_TYPES, `Missing change type: ${t}`).toContain(t);
    }
  });

  it('RELEASE_IMPACTS contains all 4 semver assessment values', () => {
    expect(RELEASE_IMPACTS).toHaveLength(4);
    expect(RELEASE_IMPACTS).toContain('major');
    expect(RELEASE_IMPACTS).toContain('minor');
    expect(RELEASE_IMPACTS).toContain('patch');
    expect(RELEASE_IMPACTS).toContain('none');
  });

  it('RELEASE_CLASSIFIED_BY contains all 3 classification provenance values', () => {
    expect(RELEASE_CLASSIFIED_BY).toHaveLength(3);
    expect(RELEASE_CLASSIFIED_BY).toContain('auto');
    expect(RELEASE_CLASSIFIED_BY).toContain('manual');
    expect(RELEASE_CLASSIFIED_BY).toContain('approved');
  });
});

// ---------------------------------------------------------------------------
// Section 6: T9686-B2 unification — legacy table dropped, unified table is SSoT
// ---------------------------------------------------------------------------

describe('T9686-B2 unification invariants', () => {
  it('`releases` is the canonical Drizzle binding (no `releasesNew` alias)', () => {
    expect(releases).toBeDefined();
    const cols = Object.keys(releases);
    // Carries both new-pipeline AND legacy-pipeline columns post-T9686-B2
    expect(cols).toContain('plannedAt'); // new pipeline
    expect(cols).toContain('preparedAt'); // legacy pipeline
    expect(cols).toContain('tasksJson'); // legacy pipeline
  });

  it('`releases` Drizzle binding targets the prefixed SQL table "tasks_releases" (T11883 cutover)', () => {
    const tableName =
      // @ts-expect-error — accessing internal Drizzle table name for test validation
      releases[Symbol.for('drizzle:Name')] ?? (releases as { _: { name: string } })._.name;
    // T11883 (E3) rebinds the runtime `releases` symbol from the bare `releases`
    // table onto the consolidated, FK-free prefixed `tasks_releases`. The bare
    // table is retired in E5; the runtime SSoT is now the prefixed table.
    expect(tableName).toBe('tasks_releases');
  });
});

// ---------------------------------------------------------------------------
// Section 7: End-to-end migration apply on a fresh tasks.db
// ---------------------------------------------------------------------------

describe('T9508 fresh migration apply — all 3 tables created', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t9508-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies all drizzle-tasks migrations and creates releases, release_commits, release_changes', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    const tableNames = ['releases', 'release_commits', 'release_changes'];
    for (const tableName of tableNames) {
      const row = nativeDb
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(tableName) as { name: string } | undefined;
      expect(row?.name, `Table '${tableName}' was not created`).toBe(tableName);
    }

    nativeDb.close();
  });

  it('releases table has the correct columns after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-releases-col.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const cols = nativeDb.prepare('PRAGMA table_info(releases)').all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);

    const expectedCols = [
      // New T9492 pipeline columns
      'id',
      'version',
      'scheme',
      'channel',
      'epic_id',
      'release_kind',
      'status',
      'previous_version',
      'merge_commit_sha',
      'pr_id',
      'workflow_run_url',
      'created_at',
      'planned_at',
      'pr_opened_at',
      'pr_merged_at',
      'published_at',
      'reconciled_at',
      'rolled_back_at',
      'failed_at',
      'cancelled_at',
      'failure_reason',
      'rolled_back_by',
      'project_hash',
      // Legacy T5580 pipeline columns merged in by T9686-B2
      'tasks_json',
      'changelog',
      'notes',
      'git_tag',
      'prepared_at',
      'committed_at',
      'tagged_at',
      'pushed_at',
    ];

    for (const col of expectedCols) {
      expect(colNames, `Column '${col}' missing from releases table`).toContain(col);
    }

    nativeDb.close();
  });

  it('release_commits table has correct columns and composite PK after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-rc-col.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const cols = nativeDb.prepare('PRAGMA table_info(release_commits)').all() as Array<{
      name: string;
      pk: number;
    }>;
    const colNames = cols.map((c) => c.name);
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);

    expect(colNames).toContain('release_id');
    expect(colNames).toContain('commit_sha');
    expect(colNames).toContain('position');
    expect(colNames).toContain('is_first');
    expect(colNames).toContain('is_last');
    expect(colNames).toContain('is_release_chore');

    // Composite PK covers both FK columns
    expect(pkCols).toContain('release_id');
    expect(pkCols).toContain('commit_sha');

    nativeDb.close();
  });

  it('release_changes table has correct columns and nullable task_id after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-rch-col.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const cols = nativeDb.prepare('PRAGMA table_info(release_changes)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    const colNames = cols.map((c) => c.name);
    const colMap = new Map(cols.map((c) => [c.name, c]));

    expect(colNames).toContain('id');
    expect(colNames).toContain('release_id');
    expect(colNames).toContain('task_id');
    expect(colNames).toContain('change_type');
    expect(colNames).toContain('summary');
    expect(colNames).toContain('description');
    expect(colNames).toContain('impact');
    expect(colNames).toContain('classified_by');
    expect(colNames).toContain('classified_at');

    // task_id must be nullable (NOT NULL = 0)
    expect(colMap.get('task_id')?.notnull, 'task_id must be nullable').toBe(0);

    // summary must be NOT NULL
    expect(colMap.get('summary')?.notnull, 'summary must be NOT NULL').toBe(1);

    // release_id must be NOT NULL
    expect(colMap.get('release_id')?.notnull, 'release_id must be NOT NULL').toBe(1);

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
      // releases
      'idx_releases_version',
      'idx_releases_status',
      'idx_releases_channel',
      'idx_releases_epic_id',
      'idx_releases_merge_commit_sha',
      'idx_releases_project_hash',
      'idx_releases_published_at',
      // release_commits
      'idx_release_commits_release_id',
      'idx_release_commits_commit_sha',
      'idx_release_commits_position',
      // release_changes
      'idx_release_changes_release_id',
      'idx_release_changes_task_id',
      'idx_release_changes_change_type',
      'idx_release_changes_impact',
    ];

    for (const idx of expectedIndexes) {
      expect(indexNames, `Index '${idx}' missing after migration`).toContain(idx);
    }

    nativeDb.close();
  });

  it('T9686-B2: legacy `release_manifests` table is dropped + columns merged into `releases`', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-unify-check.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    // Legacy table must NO LONGER exist post-T9686-B2 unification migration.
    const legacyRow = nativeDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='release_manifests'")
      .get() as { name: string } | undefined;
    expect(legacyRow, 'release_manifests must be dropped by T9686-B2').toBeUndefined();

    // The legacy `releases_view` is also dropped (no longer needed once
    // readers go directly to the unified `releases` table).
    const viewRow = nativeDb
      .prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='releases_view'")
      .get() as { name: string } | undefined;
    expect(viewRow, 'releases_view must be dropped by T9686-B2').toBeUndefined();

    // The unified `releases` table must carry every legacy column.
    const cols = nativeDb.prepare('PRAGMA table_info(releases)').all() as Array<{
      name: string;
    }>;
    const colNames = cols.map((c) => c.name);
    for (const legacyCol of [
      'tasks_json',
      'changelog',
      'notes',
      'git_tag',
      'prepared_at',
      'committed_at',
      'tagged_at',
      'pushed_at',
    ]) {
      expect(colNames, `legacy column '${legacyCol}' missing from unified releases`).toContain(
        legacyCol,
      );
    }

    nativeDb.close();
  });

  it('release_commits is_first + is_last + is_release_chore are all INTEGER columns', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-rc-types.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const cols = nativeDb.prepare('PRAGMA table_info(release_commits)').all() as Array<{
      name: string;
      type: string;
      dflt_value: string | null;
    }>;
    const colMap = new Map(cols.map((c) => [c.name, c]));

    // All three flag columns must be INTEGER with DEFAULT 0 (mutually-exclusive invariant)
    for (const flagCol of ['is_first', 'is_last', 'is_release_chore']) {
      const col = colMap.get(flagCol);
      expect(col, `Column ${flagCol} not found`).toBeDefined();
      expect(col?.type.toUpperCase(), `${flagCol} must be INTEGER type`).toContain('INTEGER');
      expect(col?.dflt_value, `${flagCol} must default to 0`).toBe('0');
    }

    nativeDb.close();
  });
});
