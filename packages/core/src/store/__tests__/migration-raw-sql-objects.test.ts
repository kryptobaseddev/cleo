/**
 * T10573 migration-chain characterization tests.
 *
 * These tests prove PM-Core V2 raw SQL migration objects survive the real
 * drizzle-tasks chain across fresh installs, copied legacy DBs, FK toggling,
 * and rollback/re-apply flows. They intentionally inspect sqlite_master rather
 * than Drizzle schema declarations because triggers and several guard indexes
 * are hand-authored SQL objects.
 *
 * @task T10573
 * @saga T10538
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const requireForNodeSqlite = createRequire(import.meta.url);
const { DatabaseSync } = requireForNodeSqlite('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    opts?: { readonly?: boolean },
  ) => import('node:sqlite').DatabaseSync;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const T10572_MIGRATION_NAME = '20260525000072_t10572-task-hierarchy-invariant-guards';

const T10572_TRIGGER_NAMES = [
  'task_relations_non_containment_insert',
  'task_relations_non_containment_update',
  'tasks_parent_type_matrix_insert',
  'tasks_parent_type_matrix_update',
  'task_acceptance_child_target_insert',
  'task_acceptance_child_target_update',
  'tasks_parent_cycle_guard_insert',
  'tasks_parent_cycle_guard_update',
] as const;

const RAW_SQL_INDEX_NAMES = [
  // T11356: the fragile partial index idx_tasks_sentient_proposals_today (LIKE
  // on serialized JSON) was replaced by a plain date(created_at) expression
  // index; label membership now resolves through the task_labels junction.
  'idx_tasks_created_date',
  'idx_acceptance_projection_dirty_task_id',
  'idx_acceptance_projection_dirty_queued_at',
  'idx_acceptance_projection_state_status_freshness',
] as const;

const RAW_SQL_PARTIAL_INDEX_NAMES = [
  // T11356: idx_tasks_sentient_proposals_today removed (was the only WHERE-clause
  // partial index pinned on a JSON-LIKE predicate). The remaining entries are
  // genuine partial indexes that still carry a WHERE clause.
  'idx_sessions_agent_handle',
  'uniq_attachments_slug',
  'idx_attachments_type',
] as const;

type SqliteNameRow = { name: string };
type SqliteSqlRow = { name: string; sql: string };
type CountRow = { cnt: number };
type ForeignKeysRow = { foreign_keys: number };
type IntegrityRow = { integrity_check: string };
type DrizzleMigration = { name?: string; hash: string };

function resolveTasksMigrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

function migrationFilePath(
  migrationName: string,
  fileName: 'migration.sql' | 'revert.sql',
): string {
  return join(resolveTasksMigrationsDir(), migrationName, fileName);
}

function readExecutableStatements(filePath: string): string[] {
  return readFileSync(filePath, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .filter((statement) =>
      statement.split('\n').some((line) => {
        const trimmed = line.trim();
        return trimmed.length > 0 && !trimmed.startsWith('--');
      }),
    );
}

function applySqlFile(nativeDb: import('node:sqlite').DatabaseSync, filePath: string): void {
  for (const statement of readExecutableStatements(filePath)) {
    nativeDb.exec(statement);
  }
}

async function applyCanonicalTasksMigrations(
  nativeDb: import('node:sqlite').DatabaseSync,
): Promise<void> {
  const { drizzle } = await import('drizzle-orm/node-sqlite');
  const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');
  const migrationsFolder = resolveTasksMigrationsDir();
  const db = drizzle({ client: nativeDb });

  reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
  migrateSanitized(db, { migrationsFolder });
}

async function readT10572Hash(): Promise<string> {
  const { readMigrationFiles } = await import('drizzle-orm/migrator');
  const migrations = readMigrationFiles({
    migrationsFolder: resolveTasksMigrationsDir(),
  }) as DrizzleMigration[];
  const migration = migrations.find((candidate) => candidate.name === T10572_MIGRATION_NAME);
  expect(migration).toBeDefined();
  return migration!.hash;
}

function listObjectNames(
  nativeDb: import('node:sqlite').DatabaseSync,
  type: 'index' | 'trigger' | 'table',
): string[] {
  return (
    nativeDb
      .prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name')
      .all(type) as SqliteNameRow[]
  ).map((row) => row.name);
}

function expectT10572Triggers(
  nativeDb: import('node:sqlite').DatabaseSync,
  present: boolean,
): void {
  const triggerNames = listObjectNames(nativeDb, 'trigger');
  for (const triggerName of T10572_TRIGGER_NAMES) {
    if (present) {
      expect(triggerNames).toContain(triggerName);
    } else {
      expect(triggerNames).not.toContain(triggerName);
    }
  }
}

function expectRawSqlInventory(nativeDb: import('node:sqlite').DatabaseSync): void {
  const indexNames = listObjectNames(nativeDb, 'index');
  for (const indexName of RAW_SQL_INDEX_NAMES) {
    expect(indexNames).toContain(indexName);
  }

  const partialIndexRows = nativeDb
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN (" +
        RAW_SQL_PARTIAL_INDEX_NAMES.map(() => '?').join(',') +
        ') ORDER BY name',
    )
    .all(...RAW_SQL_PARTIAL_INDEX_NAMES) as SqliteSqlRow[];
  expect(partialIndexRows).toHaveLength(RAW_SQL_PARTIAL_INDEX_NAMES.length);
  expect(partialIndexRows.map((row) => row.name).sort()).toEqual(
    [...RAW_SQL_PARTIAL_INDEX_NAMES].sort(),
  );
  expect(partialIndexRows.every((row) => /\bWHERE\b/i.test(row.sql))).toBe(true);

  const triggerRows = nativeDb
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (" +
        T10572_TRIGGER_NAMES.map(() => '?').join(',') +
        ') ORDER BY name',
    )
    .all(...T10572_TRIGGER_NAMES) as SqliteSqlRow[];

  expect(triggerRows).toHaveLength(T10572_TRIGGER_NAMES.length);
  expect(triggerRows.map((row) => row.name).sort()).toEqual([...T10572_TRIGGER_NAMES].sort());
  expect(triggerRows.every((row) => row.sql.includes('RAISE(ABORT'))).toBe(true);
}

describe('T10573 drizzle-tasks migration acceptance coverage', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t10573-migrations-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('fresh schema passes integrity checks and inventories raw SQL-only objects', async () => {
    const nativeDb = new DatabaseSync(join(tempDir, 'fresh-tasks.db'));
    nativeDb.exec('PRAGMA foreign_keys = ON');

    await applyCanonicalTasksMigrations(nativeDb);

    const integrity = nativeDb.prepare('PRAGMA integrity_check').get() as IntegrityRow;
    const foreignKeyViolations = nativeDb.prepare('PRAGMA foreign_key_check').all();

    expect(integrity.integrity_check).toBe('ok');
    expect(foreignKeyViolations).toHaveLength(0);
    expect(listObjectNames(nativeDb, 'table')).toContain('tasks');
    expectT10572Triggers(nativeDb, true);
    expectRawSqlInventory(nativeDb);

    nativeDb.close();
  });

  it('copied legacy schema missing the raw trigger objects migrates forward cleanly', async () => {
    const nativeDb = new DatabaseSync(join(tempDir, 'legacy-copy-tasks.db'));
    nativeDb.exec('PRAGMA foreign_keys = ON');

    await applyCanonicalTasksMigrations(nativeDb);
    applySqlFile(nativeDb, migrationFilePath(T10572_MIGRATION_NAME, 'revert.sql'));
    expectT10572Triggers(nativeDb, false);

    const t10572Hash = await readT10572Hash();
    nativeDb.prepare('DELETE FROM __drizzle_migrations WHERE hash = ?').run(t10572Hash);

    await applyCanonicalTasksMigrations(nativeDb);

    const journalEntry = nativeDb
      .prepare('SELECT COUNT(*) AS cnt FROM __drizzle_migrations WHERE hash = ?')
      .get(t10572Hash) as CountRow;
    expect(journalEntry.cnt).toBe(1);
    expectT10572Triggers(nativeDb, true);
    expectRawSqlInventory(nativeDb);

    nativeDb.close();
  });

  it('migration chain restores PRAGMA foreign_keys after FK-off table rebuild migrations', async () => {
    const nativeDb = new DatabaseSync(join(tempDir, 'foreign-keys-tasks.db'));
    nativeDb.exec('PRAGMA foreign_keys = ON');

    await applyCanonicalTasksMigrations(nativeDb);

    const pragma = nativeDb.prepare('PRAGMA foreign_keys').get() as ForeignKeysRow;
    expect(pragma.foreign_keys).toBe(1);

    nativeDb.close();
  });

  it('fresh schema created from an FK-off connection still preserves raw SQL objects', async () => {
    const nativeDb = new DatabaseSync(join(tempDir, 'foreign-keys-off-tasks.db'));
    nativeDb.exec('PRAGMA foreign_keys = OFF');
    expect((nativeDb.prepare('PRAGMA foreign_keys').get() as ForeignKeysRow).foreign_keys).toBe(0);

    await applyCanonicalTasksMigrations(nativeDb);

    const integrity = nativeDb.prepare('PRAGMA integrity_check').get() as IntegrityRow;
    const foreignKeyViolations = nativeDb.prepare('PRAGMA foreign_key_check').all();
    expect(integrity.integrity_check).toBe('ok');
    expect(foreignKeyViolations).toHaveLength(0);
    expect((nativeDb.prepare('PRAGMA foreign_keys').get() as ForeignKeysRow).foreign_keys).toBe(0);
    expectRawSqlInventory(nativeDb);

    nativeDb.close();
  });

  it('T10572 rollback drops raw triggers and re-apply restores them without losing data', async () => {
    const nativeDb = new DatabaseSync(join(tempDir, 'rollback-tasks.db'));
    nativeDb.exec('PRAGMA foreign_keys = ON');

    await applyCanonicalTasksMigrations(nativeDb);
    nativeDb
      .prepare('INSERT INTO tasks (id, title, type, status, priority) VALUES (?, ?, ?, ?, ?)')
      .run('T10573_PARENT', 'migration rollback parent', 'epic', 'pending', 'high');
    nativeDb
      .prepare(
        'INSERT INTO tasks (id, title, type, status, priority, parent_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('T10573_CHILD', 'migration rollback child', 'task', 'pending', 'high', 'T10573_PARENT');

    applySqlFile(nativeDb, migrationFilePath(T10572_MIGRATION_NAME, 'revert.sql'));
    expectT10572Triggers(nativeDb, false);

    const retainedRows = nativeDb
      .prepare("SELECT COUNT(*) AS cnt FROM tasks WHERE id IN ('T10573_PARENT', 'T10573_CHILD')")
      .get() as CountRow;
    expect(retainedRows.cnt).toBe(2);

    const t10572Hash = await readT10572Hash();
    nativeDb.prepare('DELETE FROM __drizzle_migrations WHERE hash = ?').run(t10572Hash);
    await applyCanonicalTasksMigrations(nativeDb);

    expectT10572Triggers(nativeDb, true);
    expect(() =>
      nativeDb
        .prepare(
          'INSERT INTO task_relations (task_id, related_to, relation_type, reason) VALUES (?, ?, ?, ?)',
        )
        .run('T10573_CHILD', 'T10573_PARENT', 'related', 'must be rejected as containment'),
    ).toThrow(/E_TASK_RELATION_CONTAINMENT/);

    nativeDb.close();
  });
});
