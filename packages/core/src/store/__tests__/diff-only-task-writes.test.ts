/**
 * Task writes touch only what changed (T14265), the column-scoped guards fire
 * only on a real change (T14218, migration t14218-guard-triggers-compare-old),
 * and a refused task write reports its SQLite cause (T14218 AC3, durability F4).
 *
 * The legacy row is built the way stores got them: a parent re-typed after
 * its child was filed (the guard checks a row only against its own parent).
 *
 * @task T14218
 * @task T14265
 */

import type { DatabaseSync } from 'node:sqlite';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CleoError } from '../../errors.js';
import { changedColumns } from '../db-helpers.js';
import { getNativeTasksDb, resetDbState } from '../sqlite.js';
import { createTestDb, seedTasks, type TestDbEnv } from './test-db-helper.js';

let env: TestDbEnv;
let db: DatabaseSync;
const createdAt = new Date('2026-01-01T00:00:00.000Z').toISOString();

const row = (id: string, type: 'saga' | 'epic' | 'task' | 'subtask', parentId?: string) => ({
  id,
  title: `${type} ${id}`,
  // A stored description round-trips exactly (a NULL one reloads as '').
  description: `${type} ${id}`,
  type,
  status: 'pending' as const,
  priority: 'medium' as const,
  createdAt,
  ...(parentId ? { parentId } : {}),
});

/** The pre-T14218 guard: checks NEW only, so it fires on unchanged values. */
const OLD_MATRIX_GUARD = `CREATE TRIGGER tasks_tasks_parent_type_matrix_update
BEFORE UPDATE OF parent_id, type ON tasks_tasks
WHEN (NEW.parent_id IS NOT NULL AND NEW.type IS NOT NULL
  AND EXISTS (SELECT 1 FROM tasks_tasks parent WHERE parent.id = NEW.parent_id AND parent.type IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM tasks_tasks parent WHERE parent.id = NEW.parent_id AND (
    (NEW.type = 'epic' AND parent.type = 'saga') OR (NEW.type = 'task' AND parent.type = 'epic')
    OR (NEW.type = 'subtask' AND parent.type IN ('epic', 'task')))))
BEGIN SELECT RAISE(ABORT, 'E_TASK_PARENT_TYPE_MATRIX: legacy guard'); END`;

/** A TEMP trigger refusing any UPDATE that names a column outside `allowed`. */
function refuseUpdatesOutside(allowed: readonly string[]): void {
  const cols = (db.prepare('PRAGMA table_info(tasks_tasks)').all() as Array<{ name: string }>)
    .map((c) => c.name)
    .filter((c) => !allowed.includes(c));
  db.exec(`CREATE TEMP TRIGGER t14265_set_probe BEFORE UPDATE OF ${cols.map((c) => `"${c}"`).join(', ')}
    ON main.tasks_tasks BEGIN SELECT RAISE(ABORT, 'T14265_PROBE: column outside the expected SET'); END`);
}

beforeEach(async () => {
  env = await createTestDb();
  process.env['CLEO_DIR'] = env.cleoDir;
  // P is an epic when its task child C is filed, then becomes a task: C is now
  // a legacy task under a task.
  await seedTasks(env.accessor, [row('P', 'epic'), row('C', 'task', 'P'), row('Q', 'task')]);
  await env.accessor.updateTaskFields('P', { type: 'task' });
  const native = getNativeTasksDb(env.tempDir);
  if (!native) throw new Error('no native handle');
  db = native;
});

afterEach(async () => {
  db.exec('DROP TRIGGER IF EXISTS temp.t14265_set_probe');
  delete process.env['CLEO_DIR'];
  resetDbState();
  await env.cleanup();
});

describe('diff-only task writes and change-aware guards (T14218, T14265)', () => {
  it('a notes write on a legacy task-under-task row succeeds and SETs only notes and updated_at, even under the old guard', async () => {
    // Put the pre-T14218 guard back: only the diff-only write can pass it.
    db.exec('DROP TRIGGER tasks_tasks_parent_type_matrix_update');
    db.exec(OLD_MATRIX_GUARD);
    refuseUpdatesOutside(['notes_json', 'updated_at']);
    const c = await env.accessor.loadSingleTask('C');
    if (!c) throw new Error('fixture missing');
    await env.accessor.upsertSingleTask({
      ...c,
      notes: ['triage note'],
      updatedAt: new Date('2026-11-05T00:00:00.000Z').toISOString(),
    });
    expect((await env.accessor.loadSingleTask('C'))?.notes).toEqual(['triage note']);
  });

  it('a no-op write issues no UPDATE', async () => {
    refuseUpdatesOutside([]);
    const c = await env.accessor.loadSingleTask('C');
    if (!c) throw new Error('fixture missing');
    await expect(env.accessor.upsertSingleTask(c)).resolves.toBeUndefined();
  });

  it('the new guard ignores a SET of unchanged parent_id and type, and still refuses a real bad change', () => {
    db.prepare(
      'UPDATE tasks_tasks SET parent_id = parent_id, type = type, notes_json = ? WHERE id = ?',
    ).run('["raw"]', 'C');
    expect(() => db.prepare("UPDATE tasks_tasks SET type = 'epic' WHERE id = 'C'").run()).toThrow(
      /E_TASK_PARENT_TYPE_MATRIX/,
    );
  });

  it('a reparent into an invalid pair is refused with its trigger code and the SQLite cause, not a bare internal error', async () => {
    const c = await env.accessor.loadSingleTask('C');
    if (!c) throw new Error('fixture missing');
    // Moving C under the root task Q changes parent_id into a task-under-task pair.
    const err = await env.accessor
      .upsertSingleTask({ ...c, parentId: 'Q' })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CleoError);
    const cleo = err as CleoError;
    expect(cleo.code).toBe(ExitCode.INVALID_PARENT_TYPE);
    expect(cleo.message).toMatch(/Writing task C failed: E_TASK_PARENT_TYPE_MATRIX/);
    expect(cleo.details?.['code']).toBe('E_TASK_PARENT_TYPE_MATRIX');
    expect(String(cleo.details?.['sql']).length).toBeLessThanOrEqual(201);
    expect((await env.accessor.loadSingleTask('C'))?.parentId).toBe('P');
  });

  it('a field update into an invalid pair is refused the same way', async () => {
    await expect(env.accessor.updateTaskFields('C', { parentId: 'Q' })).rejects.toMatchObject({
      code: ExitCode.INVALID_PARENT_TYPE,
      details: { field: 'parentId', code: 'E_TASK_PARENT_TYPE_MATRIX' },
    });
  });

  it('changedColumns keeps only real changes and skips undefined', () => {
    expect(
      changedColumns(
        { title: 'a', notesJson: '[]', parentId: null, noAutoComplete: false },
        { title: 'a', notesJson: '["x"]', parentId: undefined, noAutoComplete: false },
      ),
    ).toEqual({ notesJson: '["x"]' });
  });
});
