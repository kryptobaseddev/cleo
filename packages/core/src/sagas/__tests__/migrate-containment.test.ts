/**
 * T10637 — characterization tests for saga.migrate-containment
 *
 * Tests the idempotent migration of parent_id-based Saga membership
 * to task_relations.type='groups'.
 *
 * @task T10637
 * @epic T10548
 * @saga T10538
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { getTaskAccessor } from '../../store/data-accessor.js';
import { migrateSagaContainment } from '../migrate-containment.js';
import { SAGA_GROUPS_RELATION } from '../constants.js';

/**
 * Test helpers: seed a minimal tasks.db with saga/epic rows and parent_id edges.
 */
async function seedTestData(
  accessor: { db?: { exec: (sql: string) => void; all: (sql: string, ...args: unknown[]) => unknown[] } },
) {
  const db = accessor.db!;

  // Create tables (minimal subset for migration)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'task',
      status TEXT NOT NULL DEFAULT 'pending',
      parent_id TEXT,
      labels TEXT DEFAULT '[]',
      priority TEXT DEFAULT 'medium',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS task_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      related_to TEXT NOT NULL,
      relation_type TEXT NOT NULL DEFAULT 'relates',
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(task_id, related_to, relation_type)
    );
  `);

  // Clean
  db.exec('DELETE FROM task_relations; DELETE FROM tasks;');
}

function seedSaga(
  db: { exec: (sql: string) => void; all: (sql: string, ...args: unknown[]) => unknown[] },
  id: string,
  title: string,
  parentId: string | null = null,
) {
  db.exec(
    `INSERT INTO tasks (id, title, type, status, parent_id) VALUES ('${id}', '${title}', 'saga', 'active', ${parentId ? `'${parentId}'` : 'NULL'})`,
  );
}

function seedEpic(
  db: { exec: (sql: string) => void; all: (sql: string, ...args: unknown[]) => unknown[] },
  id: string,
  title: string,
  parentId: string | null,
  status = 'active',
) {
  db.exec(
    `INSERT INTO tasks (id, title, type, status, parent_id) VALUES ('${id}', '${title}', 'epic', '${status}', ${parentId ? `'${parentId}'` : 'NULL'})`,
  );
}

function seedTask(
  db: { exec: (sql: string) => void; all: (sql: string, ...args: unknown[]) => unknown[] },
  id: string,
  title: string,
  parentId: string,
) {
  db.exec(
    `INSERT INTO tasks (id, title, type, status, parent_id) VALUES ('${id}', '${title}', 'task', 'pending', '${parentId}')`,
  );
}

function getRelations(
  db: { all: (sql: string, ...args: unknown[]) => unknown[] },
  relationType: string,
): Array<{ task_id: string; related_to: string; relation_type: string }> {
  return db.all(
    'SELECT task_id, related_to, relation_type FROM task_relations WHERE relation_type = ? ORDER BY task_id, related_to',
    relationType,
  ) as Array<{ task_id: string; related_to: string; relation_type: string }>;
}

function getParentId(db: { all: (sql: string, ...args: unknown[]) => unknown[] }, taskId: string): string | null {
  const rows = db.all('SELECT parent_id FROM tasks WHERE id = ?', taskId) as Array<{ parent_id: string | null }>;
  return rows[0]?.parent_id ?? null;
}

describe('migrateSagaContainment', () => {
  let accessor: Awaited<ReturnType<typeof getTaskAccessor>>;

  beforeAll(async () => {
    accessor = await getTaskAccessor();
    await seedTestData(accessor as unknown as { db?: { exec: (sql: string) => void; all: (sql: string, ...args: unknown[]) => unknown[] } });
  });

  afterEach(() => {
    const db = (accessor as unknown as { db?: { exec: (sql: string) => void } }).db!;
    db.exec('DELETE FROM task_relations; DELETE FROM tasks;');
  });

  // -----------------------------------------------------------------------
  // AC1: groups edges converted where unambiguous
  // -----------------------------------------------------------------------

  it('AC1: converts epic→Saga parent_id to groups relation', async () => {
    const db = (accessor as unknown as { db?: { exec: (sql: string) => void; all: (sql: string, ...args: unknown[]) => unknown[] } }).db!;

    seedSaga(db, 'T100', 'Test Saga');
    seedEpic(db, 'T200', 'Test Epic', 'T100');

    const result = await migrateSagaContainment('/tmp/test-cleocode', { sagaId: 'T100' });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const data = result.data!;
    expect(data.migrated).toBe(1);
    expect(data.migratedEpics).toHaveLength(1);
    expect(data.migratedEpics[0].epicId).toBe('T200');
    expect(data.migratedEpics[0].sagaId).toBe('T100');
    expect(data.migratedEpics[0].groupsRelation.from).toBe('T100');
    expect(data.migratedEpics[0].groupsRelation.to).toBe('T200');

    // Parent cleared on the epic
    expect(getParentId(db, 'T200')).toBeNull();

    // Groups relation exists
    const relations = getRelations(db, SAGA_GROUPS_RELATION);
    expect(relations).toHaveLength(1);
    expect(relations[0].task_id).toBe('T100');
    expect(relations[0].related_to).toBe('T200');
  });

  // -----------------------------------------------------------------------
  // AC1 continued: idempotency
  // -----------------------------------------------------------------------

  it('AC1: is idempotent — re-running reports skipped', async () => {
    const db = (accessor as unknown as { db?: { exec: (sql: string) => void } }).db!;

    seedSaga(db, 'T100', 'Test Saga');
    seedEpic(db, 'T200', 'Test Epic', 'T100');

    // First run: migrates
    const r1 = await migrateSagaContainment('/tmp/test-cleocode', { sagaId: 'T100' });
    expect(r1.success).toBe(true);
    if (!r1.success) return;
    expect(r1.data!.migrated).toBe(1);

    // Second run: idempotent skip
    const r2 = await migrateSagaContainment('/tmp/test-cleocode', { sagaId: 'T100' });
    expect(r2.success).toBe(true);
    if (!r2.success) return;
    expect(r2.data!.migrated).toBe(0);
    expect(r2.data!.skipped).toBe(1);
  });

  // -----------------------------------------------------------------------
  // AC1 continued: dry-run
  // -----------------------------------------------------------------------

  it('AC1: dryRun scans without mutating', async () => {
    const db = (accessor as unknown as { db?: { exec: (sql: string) => void; all: (sql: string, ...args: unknown[]) => unknown[] } }).db!;

    seedSaga(db, 'T100', 'Test Saga');
    seedEpic(db, 'T200', 'Test Epic', 'T100');

    const result = await migrateSagaContainment('/tmp/test-cleocode', { sagaId: 'T100', dryRun: true });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const data = result.data!;
    expect(data.dryRun).toBe(true);
    expect(data.migratedEpics).toHaveLength(1);

    // No mutations occurred
    expect(getParentId(db, 'T200')).toBe('T100');
    expect(getRelations(db, SAGA_GROUPS_RELATION)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // AC2: conflicts resolved or documented — non-Epic tasks are conflicts
  // -----------------------------------------------------------------------

  it('AC2: documents non-Epic tasks with Saga parents as conflicts', async () => {
    const db = (accessor as unknown as { db?: { exec: (sql: string) => void } }).db!;

    seedSaga(db, 'T100', 'Test Saga');
    seedTask(db, 'T300', 'Direct Task Under Saga', 'T100');

    const result = await migrateSagaContainment('/tmp/test-cleocode', { sagaId: 'T100' });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const data = result.data!;
    expect(data.conflicts).toHaveLength(1);
    expect(data.conflicts[0].taskId).toBe('T300');
    expect(data.conflicts[0].taskType).toBe('task');
    expect(data.conflicts[0].sagaId).toBe('T100');
    expect(data.conflicts[0].reason).toContain('Non-epic task');

    // Task parent_id is NOT cleared (conflict, not auto-migrated)
    expect(getParentId(db, 'T300')).toBe('T100');
  });

  // -----------------------------------------------------------------------
  // AC3: saga rollups match baseline — verify migrated state is correct
  // -----------------------------------------------------------------------

  it('AC3: post-migration state has correct groups relations for rollup', async () => {
    const db = (accessor as unknown as { db?: { exec: (sql: string) => void; all: (sql: string, ...args: unknown[]) => unknown[] } }).db!;

    seedSaga(db, 'T100', 'Multi-Epic Saga');
    seedEpic(db, 'T200', 'Epic A', 'T100');
    seedEpic(db, 'T201', 'Epic B', 'T100');
    seedEpic(db, 'T202', 'Epic C', 'T100');

    const result = await migrateSagaContainment('/tmp/test-cleocode', { sagaId: 'T100' });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const data = result.data!;
    expect(data.migrated).toBe(3);

    // All 3 epics have parents cleared
    expect(getParentId(db, 'T200')).toBeNull();
    expect(getParentId(db, 'T201')).toBeNull();
    expect(getParentId(db, 'T202')).toBeNull();

    // 3 groups relations exist (saga → each epic)
    const relations = getRelations(db, SAGA_GROUPS_RELATION);
    expect(relations).toHaveLength(3);

    // Relation direction: Saga → Epic
    const epicIds = relations.map((r) => r.related_to).sort();
    expect(epicIds).toEqual(['T200', 'T201', 'T202']);
    for (const r of relations) {
      expect(r.task_id).toBe('T100');
    }
  });

  // -----------------------------------------------------------------------
  // Edge case: already migrated (groups exist, parent_id cleared)
  // -----------------------------------------------------------------------

  it('skips epics that already have groups relations and no parent_id', async () => {
    const db = (accessor as unknown as { db?: { exec: (sql: string) => void } }).db!;

    seedSaga(db, 'T100', 'Test Saga');
    seedEpic(db, 'T200', 'Already Migrated Epic', null);
    // Pre-existing groups relation
    db.exec(
      `INSERT INTO task_relations (task_id, related_to, relation_type, reason) VALUES ('T100', 'T200', 'groups', 'Already migrated')`,
    );

    const result = await migrateSagaContainment('/tmp/test-cleocode', { sagaId: 'T100' });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data!.migrated).toBe(0);
    expect(result.data!.skipped).toBe(1);

    // No duplicate relations
    expect(getRelations(db, SAGA_GROUPS_RELATION)).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Edge case: no sagas found
  // -----------------------------------------------------------------------

  it('returns empty result when no sagas exist', async () => {
    const result = await migrateSagaContainment('/tmp/test-cleocode', { sagaId: 'T999' });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data!.sagasScanned).toBe(0);
    expect(result.data!.migrated).toBe(0);
    expect(result.data!.skipped).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Edge case: all sagas mode (no sagaId filter)
  // -----------------------------------------------------------------------

  it('migrates all sagas when sagaId is omitted', async () => {
    const db = (accessor as unknown as { db?: { exec: (sql: string) => void } }).db!;

    seedSaga(db, 'T100', 'Saga One');
    seedSaga(db, 'T101', 'Saga Two');
    seedEpic(db, 'T200', 'Epic Under Saga 1', 'T100');
    seedEpic(db, 'T201', 'Epic Under Saga 2', 'T101');

    const result = await migrateSagaContainment('/tmp/test-cleocode');
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data!.sagasScanned).toBe(2);
    expect(result.data!.migrated).toBe(2);

    // Both parents cleared
    expect(getParentId(db, 'T200')).toBeNull();
    expect(getParentId(db, 'T201')).toBeNull();

    // 2 groups relations
    const relations = getRelations(db, SAGA_GROUPS_RELATION);
    expect(relations).toHaveLength(2);
  });
});
