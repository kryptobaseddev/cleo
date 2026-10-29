/**
 * `cleo doctor type-matrix` (T14096): plan, apply with a receipt, and roll
 * back the repair of parent/child pairs that break the type matrix.
 *
 * Violations are seeded the way legacy stores got them: a parent is re-typed
 * after its children were filed (the guard trigger checks a row against its
 * own parent only, never its children).
 *
 * @task T14096
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import {
  applyTypeMatrixRepair,
  parseTypeMatrixResolutions,
  planTypeMatrixRepair,
  rollbackTypeMatrixRepair,
  TYPE_MATRIX_REPAIR_ACTION,
} from '../type-matrix-repair.js';

let env: TestDbEnv;
const createdAt = new Date().toISOString();

beforeEach(async () => {
  env = await createTestDb();
  process.env['CLEO_DIR'] = env.cleoDir;
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  resetDbState();
  await env.cleanup();
});

const row = (id: string, type: 'saga' | 'epic' | 'task' | 'subtask', parentId?: string) => ({
  id,
  title: `${type} ${id}`,
  type,
  status: 'pending' as const,
  priority: 'medium' as const,
  createdAt,
  ...(parentId ? { parentId } : {}),
});

/** Root epic E1 with a leaf task, then E1 re-typed to a task: task → task. */
async function ambiguousPair(): Promise<void> {
  await seedTasks(env.accessor, [row('T1', 'epic'), row('T2', 'task', 'T1')]);
  await env.accessor.updateTaskFields('T1', { type: 'task' });
}

describe('doctor type-matrix (T14096)', () => {
  it('dry run: a pair with one valid fix carries it, an ambiguous pair lists its options, nothing changes', async () => {
    await ambiguousPair();
    // T3 is a root task whose own children decide the fix: T4 (task) is a
    // violation, and T5 (a subtask) rules out turning T3 back into an epic.
    await seedTasks(env.accessor, [
      row('T3', 'epic'),
      row('T4', 'task', 'T3'),
      row('T5', 'subtask', 'T3'),
    ]);
    await env.accessor.updateTaskFields('T3', { type: 'task' });

    const plan = await planTypeMatrixRepair(env.tempDir);
    expect(plan.dryRun).toBe(true);
    expect(plan.byPair).toEqual({ 'task → task': 2 });
    const of = (id: string) => plan.plans.find((p) => p.taskId === id);
    expect(of('T4')?.proposal).toEqual({ kind: 'retype', taskId: 'T4', to: 'subtask' });
    expect(of('T2')?.proposal).toBeNull();
    expect(of('T2')?.options).toEqual(
      expect.arrayContaining([
        { kind: 'retype', taskId: 'T2', to: 'subtask' },
        { kind: 'retype', taskId: 'T1', to: 'epic' },
      ]),
    );
    expect(plan.operations).toEqual([{ kind: 'retype', taskId: 'T4', to: 'subtask' }]);
    expect(plan.unresolved).toEqual(['T2']);
    expect((await env.accessor.loadSingleTask('T4'))?.type).toBe('task');
  });

  it('apply runs the proposals and the agent resolution, with a receipt; rollback restores it', async () => {
    await ambiguousPair();
    const done = await applyTypeMatrixRepair(env.tempDir, [
      { kind: 'retype', taskId: 'T1', to: 'epic' },
    ]);
    expect(done.unresolved).toEqual([]);
    expect(done.receiptId).toMatch(/^type-matrix-/);
    expect((await env.accessor.loadSingleTask('T1'))?.type).toBe('epic');
    expect((await planTypeMatrixRepair(env.tempDir)).violations).toBe(0);
    const [receipt] = await env.accessor.queryAuditLog({
      ids: [done.receiptId ?? ''],
      actions: [TYPE_MATRIX_REPAIR_ACTION],
    });
    expect(JSON.parse(receipt?.beforeJson ?? '[]')).toEqual([
      { id: 'T1', type: 'task', parentId: null },
    ]);

    const undone = await rollbackTypeMatrixRepair(env.tempDir, done.receiptId ?? '');
    expect(undone.restored).toEqual(['T1']);
    expect((await env.accessor.loadSingleTask('T1'))?.type).toBe('task');
    await expect(rollbackTypeMatrixRepair(env.tempDir, done.receiptId ?? '')).rejects.toThrow(
      /already rolled back/,
    );
  });

  it('owner decision Q1: a leaf subtask under an epic is a violation, re-typed to a task', async () => {
    // The trigger accepts this pair; the contracts matrix (the authority) does not.
    await seedTasks(env.accessor, [
      row('T1', 'saga'),
      row('T2', 'epic', 'T1'),
      row('T3', 'subtask', 'T2'),
    ]);
    const plan = await planTypeMatrixRepair(env.tempDir);
    expect(plan.byPair).toEqual({ 'epic → subtask': 1 });
    expect(plan.plans[0]?.proposal).toEqual({ kind: 'retype', taskId: 'T3', to: 'task' });
    const done = await applyTypeMatrixRepair(env.tempDir);
    expect(done.unresolved).toEqual([]);
    expect((await env.accessor.loadSingleTask('T3'))?.type).toBe('task');
  });

  it('owner decision Q2: rollback restores what the trigger allows and names each row it refuses', async () => {
    // Two pairs: one fixed by re-typing its parent (restorable), one by
    // re-typing its child (the before image, a task under a task, is now
    // refused by the trigger).
    await ambiguousPair();
    await seedTasks(env.accessor, [row('T4', 'epic'), row('T5', 'task', 'T4')]);
    await env.accessor.updateTaskFields('T4', { type: 'task' });
    const done = await applyTypeMatrixRepair(env.tempDir, [
      { kind: 'retype', taskId: 'T1', to: 'epic' },
      { kind: 'retype', taskId: 'T5', to: 'subtask' },
    ]);
    expect(done.unresolved).toEqual([]);

    const undone = await rollbackTypeMatrixRepair(env.tempDir, done.receiptId ?? '');
    expect(undone.restored).toEqual(['T1']);
    expect(undone.refused.map((r) => r.id)).toEqual(['T5']);
    expect(undone.refused[0]?.reason).toMatch(/refused by the type-matrix trigger/);
    expect((await env.accessor.loadSingleTask('T1'))?.type).toBe('task');
    expect((await env.accessor.loadSingleTask('T5'))?.type).toBe('subtask');
  });

  it('owner decision Q2: a rollback with nothing the trigger allows is refused with the reason', async () => {
    await ambiguousPair();
    const done = await applyTypeMatrixRepair(env.tempDir, [
      { kind: 'retype', taskId: 'T2', to: 'subtask' },
    ]);
    await expect(rollbackTypeMatrixRepair(env.tempDir, done.receiptId ?? '')).rejects.toThrow(
      /Nothing in receipt .* can be rolled back: restoring T2 as a task under T1/,
    );
    expect((await env.accessor.loadSingleTask('T2'))?.type).toBe('subtask');
  });

  it('rollback refuses when a row changed after the repair', async () => {
    await ambiguousPair();
    const done = await applyTypeMatrixRepair(env.tempDir, [
      { kind: 'retype', taskId: 'T1', to: 'epic' },
    ]);
    await env.accessor.updateTaskFields('T1', { type: 'saga' });
    await env.accessor.updateTaskFields('T2', { parentId: null });
    await expect(rollbackTypeMatrixRepair(env.tempDir, done.receiptId ?? '')).rejects.toThrow(
      /changed after the repair/,
    );
    expect((await env.accessor.loadSingleTask('T1'))?.type).toBe('saga');
  });

  it('refuses a resolution that leaves the matrix broken, and writes nothing', async () => {
    await ambiguousPair();
    await expect(
      applyTypeMatrixRepair(env.tempDir, [{ kind: 'retype', taskId: 'T2', to: 'saga' }]),
    ).rejects.toThrow(/type matrix/);
    expect((await env.accessor.loadSingleTask('T2'))?.type).toBe('task');
  });

  it('a write between the reviewed plan and the apply is E_CONFLICT: nothing changes, no receipt', async () => {
    await ambiguousPair();
    const resolution = [{ kind: 'retype' as const, taskId: 'T1', to: 'epic' as const }];
    const plan = await planTypeMatrixRepair(env.tempDir, resolution);
    await env.accessor.updateTaskFields('T1', { title: 'edited after the plan' });
    await expect(applyTypeMatrixRepair(env.tempDir, resolution, { plan })).rejects.toMatchObject({
      code: 23,
    });
    expect((await env.accessor.loadSingleTask('T1'))?.type).toBe('task');
    const receipts = await env.accessor.queryAuditLog({ actions: [TYPE_MATRIX_REPAIR_ACTION] });
    expect(receipts).toEqual([]);
  });

  it('skips a proposal an earlier resolution already settled', async () => {
    // P (a root task, once an epic) holds task C, which holds subtask S. The
    // one valid fix for C is re-typing P back to an epic; the agent instead
    // moves C under the live epic E, so that proposal is skipped.
    await seedTasks(env.accessor, [
      row('P', 'epic'),
      row('C', 'task', 'P'),
      row('S', 'subtask', 'C'),
      row('E', 'epic'),
    ]);
    await env.accessor.updateTaskFields('P', { type: 'task' });
    const dry = await planTypeMatrixRepair(env.tempDir);
    expect(dry.plans.find((p) => p.taskId === 'C')?.proposal).toEqual({
      kind: 'retype',
      taskId: 'P',
      to: 'epic',
    });
    const plan = await planTypeMatrixRepair(env.tempDir, [
      { kind: 'reparent', taskId: 'C', toParentId: 'E' },
    ]);
    expect(plan.operations).toEqual([{ kind: 'reparent', taskId: 'C', toParentId: 'E' }]);
    expect(plan.unresolved).toEqual([]);
  });

  it('refuses a reparent resolution into a cycle, under a cancelled parent, or under an unknown task', async () => {
    await seedTasks(env.accessor, [
      row('P', 'epic'),
      row('C', 'task', 'P'),
      row('S', 'subtask', 'C'),
      { ...row('X', 'epic'), status: 'cancelled' as const, pipelineStage: 'cancelled' },
    ]);
    await env.accessor.updateTaskFields('P', { type: 'task' });
    const move = (to: string) => [{ kind: 'reparent' as const, taskId: 'C', toParentId: to }];
    await expect(planTypeMatrixRepair(env.tempDir, move('S'))).rejects.toThrow(/cycle/);
    await expect(planTypeMatrixRepair(env.tempDir, move('X'))).rejects.toThrow(/strand/);
    await expect(planTypeMatrixRepair(env.tempDir, move('T404'))).rejects.toThrow(
      /T404, which is not a task/,
    );
    expect((await env.accessor.loadSingleTask('C'))?.parentId).toBe('P');
  });

  it('refuses a parent re-type its own parent cannot contain', async () => {
    // G (saga) > P (epic) > C (task); P re-typed to a task makes C task → task.
    // Re-typing P to a saga would fix C but sagas sit only at the root.
    await seedTasks(env.accessor, [row('G', 'saga'), row('P', 'epic', 'G'), row('C', 'task', 'P')]);
    await env.accessor.updateTaskFields('C', { type: 'subtask' });
    await expect(
      applyTypeMatrixRepair(env.tempDir, [{ kind: 'retype', taskId: 'P', to: 'task' }]),
    ).rejects.toThrow(/would leave P/);
    expect((await env.accessor.loadSingleTask('P'))?.type).toBe('epic');
  });

  it('rollback never breaks a child filed after the repair', async () => {
    // Saga G > epic E > subtask T: the repair re-types T to a task. Later a
    // subtask is filed under T; restoring T to a subtask would orphan it.
    await seedTasks(env.accessor, [
      row('G', 'saga'),
      row('E', 'epic', 'G'),
      row('T', 'subtask', 'E'),
    ]);
    const done = await applyTypeMatrixRepair(env.tempDir);
    expect((await env.accessor.loadSingleTask('T'))?.type).toBe('task');
    await seedTasks(env.accessor, [row('T9', 'subtask', 'T')]);
    await expect(rollbackTypeMatrixRepair(env.tempDir, done.receiptId ?? '')).rejects.toThrow(
      /would break T9/,
    );
    expect((await env.accessor.loadSingleTask('T'))?.type).toBe('task');
  });

  it('rollback refuses a row whose version moved after the repair', async () => {
    await ambiguousPair();
    const done = await applyTypeMatrixRepair(env.tempDir, [
      { kind: 'retype', taskId: 'T1', to: 'epic' },
    ]);
    await env.accessor.updateTaskFields('T1', { title: 'edited after the repair' });
    await expect(rollbackTypeMatrixRepair(env.tempDir, done.receiptId ?? '')).rejects.toThrow(
      /changed after the repair/,
    );
  });

  it('parses a resolutions file and refuses a malformed one', () => {
    expect(
      parseTypeMatrixResolutions(
        '[{"kind":"retype","taskId":"T1","to":"epic"},{"kind":"reparent","taskId":"T2","toParentId":"T3"}]',
      ),
    ).toEqual({
      ok: true,
      operations: [
        { kind: 'retype', taskId: 'T1', to: 'epic' },
        { kind: 'reparent', taskId: 'T2', toParentId: 'T3' },
      ],
    });
    expect(parseTypeMatrixResolutions('[{"kind":"retype","taskId":"T1","to":"story"}]').ok).toBe(
      false,
    );
    expect(parseTypeMatrixResolutions('{}').ok).toBe(false);
  });
});
