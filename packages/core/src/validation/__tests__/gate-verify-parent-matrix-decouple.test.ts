/**
 * Regression test for T11907 — `cleo verify` gate-recording must be DECOUPLED
 * from the parent-type-matrix structural invariant.
 *
 * ## The bug
 *
 * The gate-recording write path (`validateGateVerify`) persisted the task with a
 * FULL-COLUMN upsert (`upsertSingleTask` → `upsertTask` with an
 * `ON CONFLICT DO UPDATE SET` clause that re-writes `parent_id` and `type`).
 * SQLite fires a `BEFORE UPDATE OF parent_id, type` trigger
 * (`tasks_tasks_parent_type_matrix_update`, T10638/T11884) whenever those
 * columns appear in the SET clause — even when their values are unchanged.
 *
 * On a task that ALREADY violates the parent-type matrix (e.g. a task parented
 * DIRECTLY under a saga — T1738 under saga T10401), that trigger ABORTed the
 * verify write with `E_TASK_PARENT_TYPE_MATRIX`, blocking the recording of an
 * otherwise-valid evidence gate. The hierarchy violation is a STRUCTURAL-REPAIR
 * concern (`cleo doctor` / saga audit), not a `verify` precondition.
 *
 * ## The fix
 *
 * `validateGateVerify` now persists ONLY the verification + updatedAt columns via
 * a partial `updateTaskFields` SET, so `parent_id` / `type` never enter the
 * `UPDATE OF` column set and the matrix trigger never fires for gate-recording.
 * Genuine `parent_id` / `type` mutations elsewhere remain fully guarded.
 *
 * @task T11907
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetDbState, validateGateVerify } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** Absolute project root for each test — recreated per test. */
let TEST_ROOT: string;

/** Minimal raw-SQLite surface used by the fixtures. */
interface NativeDbForTest {
  prepare: (sql: string) => {
    run: (...args: (string | number | null)[]) => void;
    get: (...args: (string | number | null)[]) => unknown;
  };
  exec: (sql: string) => void;
}

/**
 * Minimal config that:
 * - disables session enforcement so the test does not need an active session.
 * - limits required gates so verify can run a single non-critical gate cheaply.
 */
const MINIMAL_CONFIG = {
  enforcement: {
    session: { requiredForMutate: false },
    acceptance: { mode: 'off' },
  },
  verification: {
    enabled: true,
    requiredGates: ['cleanupDone'],
  },
  lifecycle: { mode: 'off' },
};

async function setupTestRoot(): Promise<void> {
  const cleoDir = join(TEST_ROOT, '.cleo');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(cleoDir, { recursive: true });
  await writeFile(join(cleoDir, 'config.json'), JSON.stringify(MINIMAL_CONFIG));
}

/**
 * Drop ONLY the parent-type-matrix INSERT trigger so the fixture can materialize
 * the deliberately invariant-violating hierarchy (a task parented directly under
 * a saga). The UPDATE trigger is kept installed — it is the exact guard that
 * previously aborted the verify write and must remain present to prove the fix.
 */
function dropMatrixInsertGuard(db: NativeDbForTest): void {
  db.exec('DROP TRIGGER IF EXISTS tasks_parent_type_matrix_insert');
  db.exec('DROP TRIGGER IF EXISTS tasks_tasks_parent_type_matrix_insert');
}

/** Insert a task row directly, bypassing the higher-level add path. */
function insertTask(
  db: NativeDbForTest,
  row: {
    id: string;
    title: string;
    type: 'saga' | 'epic' | 'task' | 'subtask';
    parentId?: string | null;
  },
): void {
  db.prepare(
    'INSERT INTO tasks_tasks (id, title, type, status, priority, parent_id, pipeline_stage) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(row.id, row.title, row.type, 'active', 'medium', row.parentId ?? null, null);
}

function hasTrigger(db: NativeDbForTest, name: string): boolean {
  const found = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .get(name) as { name: string } | undefined;
  return found?.name === name;
}

describe('validateGateVerify — parent-type-matrix decoupling (T11907)', () => {
  beforeEach(async () => {
    resetDbState();
    TEST_ROOT = await mkdtemp(join(tmpdir(), 'cleo-t11907-'));
    await setupTestRoot();
  });

  afterEach(async () => {
    resetDbState();
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it('records an evidence gate on a task parented directly under a saga (repro)', async () => {
    const { getDb, getNativeDb } = await import('../../store/sqlite.js');
    await getDb(TEST_ROOT);
    const db = getNativeDb() as NativeDbForTest | null;
    if (!db) throw new Error('nativeDb not initialized');

    // Materialize the pre-existing violation: T1738 (task) parented DIRECTLY
    // under saga T10401. The matrix forbids task->saga, so the INSERT guard must
    // be dropped to seed it — the UPDATE guard stays installed.
    dropMatrixInsertGuard(db);
    insertTask(db, { id: 'T10401', title: 'Saga', type: 'saga' });
    insertTask(db, { id: 'T1738', title: 'Task under saga', type: 'task', parentId: 'T10401' });

    // Sanity: the UPDATE matrix trigger is still installed (the structural-repair
    // guard that previously aborted verify must remain present).
    expect(hasTrigger(db, 'tasks_tasks_parent_type_matrix_update')).toBe(true);

    resetDbState();

    // Recording a gate on the mis-parented task previously aborted with
    // E_TASK_PARENT_TYPE_MATRIX. After the fix it succeeds regardless.
    const result = await validateGateVerify(TEST_ROOT, {
      taskId: 'T1738',
      gate: 'cleanupDone',
      value: true,
      evidence: 'note:removed dead branches',
    });

    // The matrix abort surfaces via the trigger's RAISE message; assert neither
    // the code nor the message carries the matrix violation through to verify
    // (the negative control — old full-column upsert — fails BOTH of these).
    expect(result.error?.code).not.toBe('E_TASK_PARENT_TYPE_MATRIX');
    expect(result.error?.message ?? '').not.toContain('E_TASK_PARENT_TYPE_MATRIX');
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('set_gate');

    // The verification persisted to the row.
    resetDbState();
    const { createSqliteDataAccessor } = await import('@cleocode/core/internal');
    const accessor = await createSqliteDataAccessor(TEST_ROOT);
    const reloaded = await accessor.loadSingleTask('T1738');
    await accessor.close();
    expect(reloaded?.verification?.gates?.cleanupDone).toBe(true);
    // The mis-parent itself is untouched — verify did not "repair" it.
    expect(reloaded?.parentId).toBe('T10401');
  });

  it('keeps the parent-type-matrix UPDATE trigger enforcing genuine mis-parents (structural-repair path intact)', async () => {
    const { getDb, getNativeDb } = await import('../../store/sqlite.js');
    await getDb(TEST_ROOT);
    const db = getNativeDb() as NativeDbForTest | null;
    if (!db) throw new Error('nativeDb not initialized');

    dropMatrixInsertGuard(db);
    insertTask(db, { id: 'T10401', title: 'Saga', type: 'saga' });
    insertTask(db, { id: 'T2001', title: 'Epic', type: 'epic', parentId: 'T10401' });
    // A clean task under the epic — a valid hierarchy.
    insertTask(db, { id: 'T2002', title: 'Task under epic', type: 'task', parentId: 'T2001' });

    // A genuine parent_id mutation that introduces a violation (task -> saga)
    // MUST still be aborted by the surviving UPDATE matrix trigger.
    expect(() =>
      db.prepare('UPDATE tasks_tasks SET parent_id = ? WHERE id = ?').run('T10401', 'T2002'),
    ).toThrow(/E_TASK_PARENT_TYPE_MATRIX/);
  });
});
