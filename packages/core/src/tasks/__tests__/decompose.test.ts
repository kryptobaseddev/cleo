/**
 * `decomposeTask` admission guards.
 *
 * Scope note, stated because the gap matters: these cases cover the guards that
 * run BEFORE any write — tier, presence of text criteria, and refusal to rewrite
 * non-text rows. Each returns before `addTask` is reached, so they need only a
 * stub accessor. The write path (strip → create → restore-on-failure) is proven
 * end-to-end against a real project in the PR's verification, not here; a
 * DB-backed harness for it is worth adding but is not what these assertions
 * claim to cover.
 *
 * @task T12281
 */

import type { AcRow, DataAccessor, Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { decomposeTask } from '../decompose.js';

function task(overrides: Partial<Task>): Task {
  const now = new Date().toISOString();
  return {
    id: 'T003',
    title: 'Task One',
    description: '',
    type: 'task',
    status: 'pending',
    priority: 'medium',
    size: 'medium',
    parentId: 'T002',
    position: 1,
    positionVersion: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Task;
}

function acRow(overrides: Partial<AcRow>): AcRow {
  return {
    id: 'ac-1',
    taskId: 'T003',
    ordinal: 1,
    kind: 'text',
    sourceKey: 'direct:1',
    targetTaskId: null,
    projection: 'direct',
    contentHash: 'h',
    text: 'ac1',
    ...overrides,
  } as AcRow;
}

/** Minimal accessor exposing only what the pre-write guards read. */
function stubAccessor(row: Task | null, acRows: AcRow[]): DataAccessor {
  return {
    loadSingleTask: async () => row,
    getAcRows: async () => acRows,
  } as unknown as DataAccessor;
}

describe('decomposeTask — admission guards', () => {
  it('refuses a task that does not exist', async () => {
    await expect(
      decomposeTask({ taskId: 'T999' }, '/tmp/x', stubAccessor(null, [])),
    ).rejects.toThrow(/Task not found: T999/);
  });

  it.each([
    ['saga', /already containers/],
    ['epic', /already containers/],
    ['subtask', /leaf tier/],
  ])('refuses a %s', async (type, expected) => {
    await expect(
      decomposeTask(
        { taskId: 'T003' },
        '/tmp/x',
        stubAccessor(task({ type: type as Task['type'] }), []),
      ),
    ).rejects.toThrow(expected);
  });

  it('refuses a task with no text criteria — it is already a container', async () => {
    const rows = [acRow({ kind: 'child_task', text: 'Complete child T004', targetTaskId: 'T004' })];
    await expect(
      decomposeTask({ taskId: 'T003' }, '/tmp/x', stubAccessor(task({}), rows)),
    ).rejects.toThrow(/no free-text acceptance criteria to move/);
  });

  it('refuses rather than silently flattening evidence-bound criteria', async () => {
    // planAcUpdate takes AcceptanceItem[], so rebuilding a gate from its stored
    // row is lossy. Refusing is the honest outcome; rewriting it into plain text
    // would quietly discard the gate.
    const rows = [
      acRow({ id: 'ac-1', ordinal: 1, kind: 'text', text: 'ac1' }),
      acRow({ id: 'ac-2', ordinal: 2, kind: 'evidence_bound', text: 'tests pass' }),
    ];
    await expect(
      decomposeTask({ taskId: 'T003' }, '/tmp/x', stubAccessor(task({}), rows)),
    ).rejects.toThrow(/non-text\s+acceptance row\(s\) \(evidence_bound\)/);
  });
});
