/**
 * T10637 — characterization tests for saga.migrate-containment
 *
 * Tests the idempotent migration of parent_id-based Saga membership
 * to task_relations.type='groups'.
 *
 * Seeds data via raw SQL to bypass the application-level
 * E_TASK_PARENT_TYPE_MATRIX constraint (which correctly enforces
 * that new rows cannot have this shape — the migration exists for
 * legacy rows inserted before the constraint was added).
 *
 * @task T10637
 * @epic T10548
 * @saga T10538
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalProjectId } from '../../nexus/identity.js';
import { registerProjectOnEncounter } from '../../paths.js';
import { migrateSagaContainment } from '../migrate-containment.js';

type DbHandle = {
  exec: (sql: string) => void;
  all: (sql: string, ...args: unknown[]) => unknown[];
};

/**
 * Create a minimal isolated test DB with a tasks table.
 * Uses bare better-sqlite3 to bypass Drizzle's constraint layer.
 */
async function createRawTestDb(): Promise<{
  db: DbHandle;
  projectRoot: string;
  cleanup: () => void;
}> {
  const tempDir = mkdtempSync(join(tmpdir(), 'cleo-test-migrate-'));
  const cleoDir = join(tempDir, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  mkdirSync(join(tempDir, '.git'), { recursive: true });

  // Write project-info.json and register in nexus.
  const { id: projectId } = await canonicalProjectId(tempDir);
  writeFileSync(join(cleoDir, 'project-info.json'), JSON.stringify({
    $schema: './schemas/project-info.schema.json',
    schemaVersion: '1.0.0',
    projectId,
    projectHash: projectId,
    cleoVersion: 'test',
    lastUpdated: new Date().toISOString(),
  }));
  await registerProjectOnEncounter(tempDir, projectId);

  // Write minimal config
  writeFileSync(
    join(cleoDir, 'config.json'),
    JSON.stringify({
      enforcement: { session: { requiredForMutate: false }, acceptance: { mode: 'off' } },
      verification: { enabled: false },
    }),
  );

  const { DatabaseSync } = await import('node:sqlite');
  const sqlite = new DatabaseSync(join(cleoDir, 'tasks.db'));

  // Create minimal schema
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'task',
      status TEXT NOT NULL DEFAULT 'pending',
      parent_id TEXT,
      labels TEXT DEFAULT '[]',
      priority TEXT DEFAULT 'medium',
      pipeline_stage TEXT,
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

  // We also need these tables for getTaskAccessor to work
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      scope TEXT DEFAULT 'global',
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS task_acceptance_criteria (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL DEFAULT 1,
      criterion TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS evidence_ac_bindings (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      ac_id TEXT NOT NULL,
      evidence_atom_id TEXT,
      binding_type TEXT DEFAULT 'coverage',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS project_info (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  sqlite.exec("INSERT OR IGNORE INTO project_info (key, value) VALUES ('id', 'test-project')");

  const db: DbHandle = {
    exec: (sql: string) => sqlite.exec(sql),
    all: (sql: string, ...args: unknown[]) => sqlite.prepare(sql).all(...args),
  };

  return {
    db,
    projectRoot: tempDir,
    cleanup: () => {
      sqlite.close();
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

function seedSaga(db: DbHandle, id: string) {
  db.exec(
    `INSERT INTO tasks (id, title, type, status) VALUES ('${id}', 'Saga ${id}', 'saga', 'active')`,
  );
}

function seedEpic(db: DbHandle, id: string, parentId: string) {
  db.exec(
    `INSERT INTO tasks (id, title, type, status, parent_id) VALUES ('${id}', 'Epic ${id}', 'epic', 'active', '${parentId}')`,
  );
}

function seedTask(db: DbHandle, id: string, parentId: string) {
  db.exec(
    `INSERT INTO tasks (id, title, type, status, parent_id) VALUES ('${id}', 'Task ${id}', 'task', 'pending', '${parentId}')`,
  );
}

function getRelations(db: DbHandle): Array<{ task_id: string; related_to: string }> {
  return db.all(
    "SELECT task_id, related_to FROM task_relations WHERE relation_type = 'groups' ORDER BY task_id, related_to",
  ) as Array<{ task_id: string; related_to: string }>;
}

function getParentId(db: DbHandle, taskId: string): string | null {
  const rows = db.all('SELECT parent_id FROM tasks WHERE id = ?', taskId) as Array<{
    parent_id: string | null;
  }>;
  return rows[0]?.parent_id ?? null;
}

describe('migrateSagaContainment', () => {
  let db: DbHandle;
  let projectRoot: string;
  let cleanup: () => void;

  beforeEach(async () => {
    const env = await createRawTestDb();
    db = env.db;
    projectRoot = env.projectRoot;
    cleanup = env.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  // -----------------------------------------------------------------------
  // AC1: groups edges converted where unambiguous
  // -----------------------------------------------------------------------

  it('AC1: converts epic→Saga parent_id to groups relation', async () => {
    seedSaga(db, 'T100');
    seedEpic(db, 'T200', 'T100');

    const result = await migrateSagaContainment(projectRoot, { sagaId: 'T100' });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const data = result.data!;
    expect(data.migrated).toBe(1);
    expect(data.migratedEpics[0].epicId).toBe('T200');
    expect(data.migratedEpics[0].sagaId).toBe('T100');

    expect(getParentId(db, 'T200')).toBeNull();
    const rels = getRelations(db);
    expect(rels).toHaveLength(1);
    expect(rels[0].task_id).toBe('T100');
    expect(rels[0].related_to).toBe('T200');
  });

  // -----------------------------------------------------------------------
  // AC1 continued: idempotency
  // -----------------------------------------------------------------------

  it('AC1: is idempotent — re-running reports skipped', async () => {
    seedSaga(db, 'T100');
    seedEpic(db, 'T200', 'T100');

    const r1 = await migrateSagaContainment(projectRoot, { sagaId: 'T100' });
    expect(r1.success).toBe(true);
    expect(r1.data!.migrated).toBe(1);

    const r2 = await migrateSagaContainment(projectRoot, { sagaId: 'T100' });
    expect(r2.success).toBe(true);
    if (!r2.success) return;
    expect(r2.data!.migrated).toBe(0);
    expect(r2.data!.skipped).toBe(1);
  });

  // -----------------------------------------------------------------------
  // AC1 continued: dry-run
  // -----------------------------------------------------------------------

  it('AC1: dryRun scans without mutating', async () => {
    seedSaga(db, 'T100');
    seedEpic(db, 'T200', 'T100');

    const result = await migrateSagaContainment(projectRoot, { sagaId: 'T100', dryRun: true });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data!.dryRun).toBe(true);
    expect(result.data!.migratedEpics).toHaveLength(1);
    expect(getParentId(db, 'T200')).toBe('T100');
    expect(getRelations(db)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // AC2: conflicts resolved or documented
  // -----------------------------------------------------------------------

  it('AC2: documents non-Epic tasks with Saga parents as conflicts', async () => {
    seedSaga(db, 'T100');
    seedTask(db, 'T300', 'T100');

    const result = await migrateSagaContainment(projectRoot, { sagaId: 'T100' });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data!.conflicts).toHaveLength(1);
    expect(result.data!.conflicts[0].taskId).toBe('T300');
    expect(result.data!.conflicts[0].reason).toContain('Non-epic task');
    expect(getParentId(db, 'T300')).toBe('T100');
  });

  // -----------------------------------------------------------------------
  // AC3: saga rollups match baseline
  // -----------------------------------------------------------------------

  it('AC3: post-migration state has correct groups relations for rollup', async () => {
    seedSaga(db, 'T100');
    seedEpic(db, 'T200', 'T100');
    seedEpic(db, 'T201', 'T100');
    seedEpic(db, 'T202', 'T100');

    const result = await migrateSagaContainment(projectRoot, { sagaId: 'T100' });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data!.migrated).toBe(3);
    expect(getParentId(db, 'T200')).toBeNull();
    expect(getParentId(db, 'T201')).toBeNull();
    expect(getParentId(db, 'T202')).toBeNull();

    const rels = getRelations(db);
    expect(rels).toHaveLength(3);
    const epicIds = rels.map((r) => r.related_to).sort();
    expect(epicIds).toEqual(['T200', 'T201', 'T202']);
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it('skips epics that already have groups relations', async () => {
    seedSaga(db, 'T100');
    seedEpic(db, 'T200', 'T100');
    db.exec(
      "INSERT INTO task_relations (task_id, related_to, relation_type) VALUES ('T100', 'T200', 'groups')",
    );

    const result = await migrateSagaContainment(projectRoot, { sagaId: 'T100' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data!.migrated).toBe(0);
    expect(result.data!.skipped).toBe(1);
  });

  it('returns empty result when no sagas exist', async () => {
    const result = await migrateSagaContainment(projectRoot, { sagaId: 'T999' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data!.sagasScanned).toBe(0);
  });

  it('migrates all sagas when sagaId is omitted', async () => {
    seedSaga(db, 'T100');
    seedSaga(db, 'T101');
    seedEpic(db, 'T200', 'T100');
    seedEpic(db, 'T201', 'T101');

    const result = await migrateSagaContainment(projectRoot);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data!.sagasScanned).toBe(2);
    expect(result.data!.migrated).toBe(2);
    expect(getParentId(db, 'T200')).toBeNull();
    expect(getParentId(db, 'T201')).toBeNull();
  });
});
