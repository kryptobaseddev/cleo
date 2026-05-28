/**
 * T10637 — characterization tests for saga.migrate-containment
 *
 * Tests the idempotent migration of legacy task_relations.type='groups'
 * Saga membership to canonical parent_id containment (PM-Core V2 / ADR-088).
 *
 * Seeds legacy data (standalone Epics with groups relations) via raw SQL
 * to bypass the application-level E_TASK_PARENT_TYPE_MATRIX constraint,
 * then calls migrateSagaContainment and verifies:
 *   1. Groups relations are converted to parent_id containment.
 *   2. Legacy groups rows are removed.
 *   3. Already-correct Epics are skipped (idempotent).
 *   4. Non-Epic targets are documented as conflicts.
 *
 * @task T10637
 * @epic T10548
 * @saga T10538
 * @see ADR-088 — PM-Core V2 WorkGraph containment
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
 * Create a minimal isolated test DB with tasks + task_relations tables.
 * Uses bare node:sqlite to bypass Drizzle's constraint layer — necessary
 * because the migration exists for legacy rows inserted before the
 * parent-type-matrix trigger was added.
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

  // Create minimal schema (mirrors production tables that migrateSagaContainment queries)
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

  // Minimal tables needed for getTaskAccessor
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

// ---- seed helpers (PM-Core V2: saga type='saga', epics standalone + groups relation) ----

function seedSaga(db: DbHandle, id: string) {
  db.exec(
    `INSERT INTO tasks (id, title, type, status) VALUES ('${id}', 'Saga ${id}', 'saga', 'active')`,
  );
}

/** Seed a standalone Epic (no parentId) with a legacy groups relation from the Saga. */
function seedEpicWithGroupsRelation(db: DbHandle, epicId: string, sagaId: string) {
  // Standalone Epic — no parent_id (legacy pattern: membership was via groups relation)
  db.exec(
    `INSERT INTO tasks (id, title, type, status) VALUES ('${epicId}', 'Epic ${epicId}', 'epic', 'active')`,
  );
  // Legacy groups relation from Saga to Epic
  db.exec(
    `INSERT INTO task_relations (task_id, related_to, relation_type) VALUES ('${sagaId}', '${epicId}', 'groups')`,
  );
}

function seedTaskWithGroupsRelation(db: DbHandle, taskId: string, sagaId: string) {
  db.exec(
    `INSERT INTO tasks (id, title, type, status) VALUES ('${taskId}', 'Task ${taskId}', 'task', 'pending')`,
  );
  db.exec(
    `INSERT INTO task_relations (task_id, related_to, relation_type) VALUES ('${sagaId}', '${taskId}', 'groups')`,
  );
}

// ---- query helpers ----

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

// ---- tests ----

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
  // AC1: groups→parent_id migration — converts legacy groups to containment
  // -----------------------------------------------------------------------

  it('AC1: converts legacy groups relation to parent_id containment', async () => {
    seedSaga(db, 'T100');
    seedEpicWithGroupsRelation(db, 'T200', 'T100');

    const result = await migrateSagaContainment(projectRoot, { sagaId: 'T100' });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data!.migrated).toBe(1);
    expect(result.data!.migratedEpics[0].epicId).toBe('T200');
    expect(result.data!.migratedEpics[0].sagaId).toBe('T100');

    // After migration: Epic has parent_id=SagaId (containment), groups row removed
    expect(getParentId(db, 'T200')).toBe('T100');
    expect(getRelations(db)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // AC1 continued: idempotency
  // -----------------------------------------------------------------------

  it('AC1: is idempotent — already-parented Epics are skipped', async () => {
    seedSaga(db, 'T100');
    seedEpicWithGroupsRelation(db, 'T200', 'T100');

    // First run: migrate
    const r1 = await migrateSagaContainment(projectRoot, { sagaId: 'T100' });
    expect(r1.success).toBe(true);
    expect(r1.data!.migrated).toBe(1);

    // Second run: already has parentId=saga — skipped
    const r2 = await migrateSagaContainment(projectRoot, { sagaId: 'T100' });
    expect(r2.success).toBe(true);
    if (!r2.success) return;
    expect(r2.data!.migrated).toBe(0);
    expect(r2.data!.skipped).toBe(1);

    // State unchanged: parent_id still set, no groups rows
    expect(getParentId(db, 'T200')).toBe('T100');
    expect(getRelations(db)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // AC1 continued: dry-run
  // -----------------------------------------------------------------------

  it('AC1: dryRun scans without mutating', async () => {
    seedSaga(db, 'T100');
    seedEpicWithGroupsRelation(db, 'T200', 'T100');

    const result = await migrateSagaContainment(projectRoot, { sagaId: 'T100', dryRun: true });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data!.dryRun).toBe(true);
    expect(result.data!.migratedEpics).toHaveLength(1);
    expect(result.data!.migratedEpics[0].epicId).toBe('T200');

    // Dry-run: no mutation — parent_id still null, groups relation still exists
    expect(getParentId(db, 'T200')).toBeNull();
    expect(getRelations(db)).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // AC2: non-Epic tasks with legacy groups relations are conflicts
  // -----------------------------------------------------------------------

  it('AC2: documents non-Epic tasks with legacy groups relations as conflicts', async () => {
    seedSaga(db, 'T100');
    seedTaskWithGroupsRelation(db, 'T300', 'T100');

    const result = await migrateSagaContainment(projectRoot, { sagaId: 'T100' });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data!.conflicts).toHaveLength(1);
    expect(result.data!.conflicts[0].taskId).toBe('T300');
    expect(result.data!.conflicts[0].reason).toContain('Non-epic task');
    expect(result.data!.migrated).toBe(0);

    // Task stays as-is (not reparented), groups relation preserved for manual cleanup
    expect(getParentId(db, 'T300')).toBeNull();
    expect(getRelations(db)).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // AC3: multiple Epics all correctly migrated
  // -----------------------------------------------------------------------

  it('AC3: migrates all Epics with legacy groups relations to parent_id containment', async () => {
    seedSaga(db, 'T100');
    seedEpicWithGroupsRelation(db, 'T200', 'T100');
    seedEpicWithGroupsRelation(db, 'T201', 'T100');
    seedEpicWithGroupsRelation(db, 'T202', 'T100');

    const result = await migrateSagaContainment(projectRoot, { sagaId: 'T100' });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data!.migrated).toBe(3);
    expect(result.data!.skipped).toBe(0);

    // All Epics now parented under Saga
    expect(getParentId(db, 'T200')).toBe('T100');
    expect(getParentId(db, 'T201')).toBe('T100');
    expect(getParentId(db, 'T202')).toBe('T100');

    // All legacy groups rows removed
    expect(getRelations(db)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Edge case: Epic that already has BOTH parentId and groups relation
  // -----------------------------------------------------------------------

  it('skips Epics that already have parentId set (idempotent cleanup)', async () => {
    seedSaga(db, 'T100');
    // Epic already parented under Saga AND has legacy groups relation
    db.exec(
      "INSERT INTO tasks (id, title, type, status, parent_id) VALUES ('T200', 'Epic T200', 'epic', 'active', 'T100')",
    );
    db.exec(
      "INSERT INTO task_relations (task_id, related_to, relation_type) VALUES ('T100', 'T200', 'groups')",
    );

    const result = await migrateSagaContainment(projectRoot, { sagaId: 'T100' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data!.migrated).toBe(0);
    expect(result.data!.skipped).toBe(1);

    // ParentId preserved, legacy groups row cleaned up
    expect(getParentId(db, 'T200')).toBe('T100');
    expect(getRelations(db)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Edge case: no sagas exist
  // -----------------------------------------------------------------------

  it('returns empty result when no sagas exist', async () => {
    const result = await migrateSagaContainment(projectRoot, { sagaId: 'T999' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data!.sagasScanned).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Edge case: migrates all sagas when sagaId is omitted
  // -----------------------------------------------------------------------

  it('migrates all sagas when sagaId is omitted', async () => {
    seedSaga(db, 'T100');
    seedSaga(db, 'T101');
    seedEpicWithGroupsRelation(db, 'T200', 'T100');
    seedEpicWithGroupsRelation(db, 'T201', 'T101');

    const result = await migrateSagaContainment(projectRoot);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data!.sagasScanned).toBe(2);
    expect(result.data!.migrated).toBe(2);

    // Both Epics now parented under their respective Sagas
    expect(getParentId(db, 'T200')).toBe('T100');
    expect(getParentId(db, 'T201')).toBe('T101');

    // All legacy groups rows removed
    expect(getRelations(db)).toHaveLength(0);
  });
});
