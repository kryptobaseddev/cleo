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
import { resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { migrateSagaContainment } from '../migrate-containment.js';

type DbHandle = {
  exec: (sql: string) => void;
  all: (sql: string, ...args: unknown[]) => unknown[];
};

/**
 * Create an isolated test DB with the canonical migrated schema, then expose a
 * bare node:sqlite handle on the same file for raw seeding/assertions.
 *
 * The schema is produced via the real {@link createSqliteDataAccessor} migration
 * path (T11280) — hand-rolling a partial schema diverges from the migration
 * chain and triggers a destructive re-run (e.g. the wave0 `sessions` rebuild
 * failing on a missing `name` column). The raw handle is then used to seed the
 * LEGACY shape (standalone Epics + `task_relations.type='groups'`) that the
 * migration exists to convert — these rows do not violate the parent-type
 * matrix, so raw seeding is only needed to write the `groups` relation rows.
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
  writeFileSync(
    join(cleoDir, 'project-info.json'),
    JSON.stringify({
      $schema: './schemas/project-info.schema.json',
      schemaVersion: '1.0.0',
      projectId,
      projectHash: projectId,
      cleoVersion: 'test',
      lastUpdated: new Date().toISOString(),
    }),
  );
  await registerProjectOnEncounter(tempDir, projectId);

  // Write minimal config
  writeFileSync(
    join(cleoDir, 'config.json'),
    JSON.stringify({
      enforcement: { session: { requiredForMutate: false }, acceptance: { mode: 'off' } },
      verification: { enabled: false },
    }),
  );

  // Build the canonical schema + migration journal via the real accessor, then
  // close it so a bare handle can seed legacy rows without a destructive
  // mid-migration re-run.
  resetDbState();
  const accessor = await createSqliteDataAccessor(tempDir);
  await accessor.close();
  resetDbState();

  // E6-L1 (T11521): tasks domain consolidated into `cleo.db` via
  // openDualScopeDb('project'); the accessor above seeded the schema there.
  const { DatabaseSync } = await import('node:sqlite');
  const sqlite = new DatabaseSync(join(cleoDir, 'cleo.db'));

  // Drop the PM-Core V2 guards that would reject the LEGACY rows these tests
  // seed (a parent-child `task_relations.type='groups'` edge is exactly the
  // stale data migrateSagaContainment exists to clean up, but the
  // task_relations_non_containment trigger now rejects it on insert). (T11280)
  sqlite.exec('DROP TRIGGER IF EXISTS task_relations_non_containment_insert');
  sqlite.exec('DROP TRIGGER IF EXISTS task_relations_non_containment_update');
  // T11884: the non-containment guard was restored on the PREFIXED table
  // (`tasks_task_relations`) where these fixtures actually seed legacy `groups`
  // edges — the bare-table drops above are now no-ops, so drop the prefixed
  // guard too (this stale containment shape is exactly what the migration cleans up).
  sqlite.exec('DROP TRIGGER IF EXISTS tasks_task_relations_non_containment_insert');
  sqlite.exec('DROP TRIGGER IF EXISTS tasks_task_relations_non_containment_update');

  const db: DbHandle = {
    exec: (sql: string) => sqlite.exec(sql),
    all: (sql: string, ...args: unknown[]) => sqlite.prepare(sql).all(...args),
  };

  return {
    db,
    projectRoot: tempDir,
    cleanup: () => {
      sqlite.close();
      resetDbState();
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
    `INSERT INTO tasks_tasks (id, title, type, status) VALUES ('${id}', 'Saga ${id}', 'saga', 'active')`,
  );
}

/** Seed a standalone Epic (no parentId) with a legacy groups relation from the Saga. */
function seedEpicWithGroupsRelation(db: DbHandle, epicId: string, sagaId: string) {
  // Standalone Epic — no parent_id (legacy pattern: membership was via groups relation)
  db.exec(
    `INSERT INTO tasks_tasks (id, title, type, status) VALUES ('${epicId}', 'Epic ${epicId}', 'epic', 'active')`,
  );
  // Legacy groups relation from Saga to Epic
  db.exec(
    `INSERT INTO tasks_task_relations (task_id, related_to, relation_type) VALUES ('${sagaId}', '${epicId}', 'groups')`,
  );
}

function seedTaskWithGroupsRelation(db: DbHandle, taskId: string, sagaId: string) {
  db.exec(
    `INSERT INTO tasks_tasks (id, title, type, status) VALUES ('${taskId}', 'Task ${taskId}', 'task', 'pending')`,
  );
  db.exec(
    `INSERT INTO tasks_task_relations (task_id, related_to, relation_type) VALUES ('${sagaId}', '${taskId}', 'groups')`,
  );
}

// ---- query helpers ----

function getRelations(db: DbHandle): Array<{ task_id: string; related_to: string }> {
  return db.all(
    "SELECT task_id, related_to FROM tasks_task_relations WHERE relation_type = 'groups' ORDER BY task_id, related_to",
  ) as Array<{ task_id: string; related_to: string }>;
}

function getParentId(db: DbHandle, taskId: string): string | null {
  const rows = db.all('SELECT parent_id FROM tasks_tasks WHERE id = ?', taskId) as Array<{
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

    // Second run is a no-op: run 1 reparented the Epic AND removed the legacy
    // groups relation, so the groups-relation scan now finds nothing — neither
    // migrated nor skipped. Idempotency = a safe no-op, not a re-skip.
    const r2 = await migrateSagaContainment(projectRoot, { sagaId: 'T100' });
    expect(r2.success).toBe(true);
    if (!r2.success) return;
    expect(r2.data!.migrated).toBe(0);
    expect(r2.data!.skipped).toBe(0);

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
      "INSERT INTO tasks_tasks (id, title, type, status, parent_id) VALUES ('T200', 'Epic T200', 'epic', 'active', 'T100')",
    );
    db.exec(
      "INSERT INTO tasks_task_relations (task_id, related_to, relation_type) VALUES ('T100', 'T200', 'groups')",
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
