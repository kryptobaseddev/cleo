/**
 * Tests for buildTreeNode position-based sorting (T1196).
 *
 * buildTreeNode is a private function; we test it through the public
 * coreTaskTree API which calls it during tree construction.
 *
 * Acceptance criteria (T1196):
 * - Children sorted by position ASC
 * - null/undefined positions default to 0
 * - Sort is stable for equal positions
 *
 * @task T1196
 * @epic T1188
 */

import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { coreTaskTree } from '../task-ops.js';

let env: TestDbEnv;

beforeEach(async () => {
  env = await createTestDb();
});

afterEach(async () => {
  await env.cleanup();
});

/** Seed a set of tasks via the test accessor. */
async function seed(tasks: Array<Partial<Task> & { id: string }>): Promise<void> {
  await seedTasks(env.accessor, tasks);
}

describe('coreTaskTree child ordering (T1196 — position ASC)', () => {
  it('sorts children by position ASC', async () => {
    await seed([
      { id: 'T001', type: 'epic' },
      { id: 'T002', title: 'Third', parentId: 'T001', position: 3 },
      { id: 'T003', title: 'First', parentId: 'T001', position: 1 },
      { id: 'T004', title: 'Second', parentId: 'T001', position: 2 },
    ]);

    const { tree } = await coreTaskTree(env.tempDir, 'T001');
    expect(tree).toHaveLength(1);
    const root = tree[0]!;
    expect(root.id).toBe('T001');
    expect(root.children.map((c) => c.id)).toEqual(['T003', 'T004', 'T002']);
  });

  it('treats null position as 0 (sorts before position 1)', async () => {
    await seed([
      { id: 'T001', type: 'epic' },
      { id: 'T002', title: 'Explicit 1', parentId: 'T001', position: 1 },
      { id: 'T003', title: 'Null position', parentId: 'T001', position: null },
    ]);

    const { tree } = await coreTaskTree(env.tempDir, 'T001');
    const root = tree[0]!;
    // null → 0 sorts before 1
    expect(root.children[0]!.id).toBe('T003');
    expect(root.children[1]!.id).toBe('T002');
  });

  it('treats undefined position as 0', async () => {
    await seed([
      { id: 'T001', type: 'epic' },
      { id: 'T002', title: 'Explicit 2', parentId: 'T001', position: 2 },
      { id: 'T003', title: 'No position', parentId: 'T001' },
    ]);

    const { tree } = await coreTaskTree(env.tempDir, 'T001');
    const root = tree[0]!;
    // undefined → 0 sorts before 2
    expect(root.children[0]!.id).toBe('T003');
    expect(root.children[1]!.id).toBe('T002');
  });

  it('preserves all children when positions are equal (stable length check)', async () => {
    await seed([
      { id: 'T001', type: 'epic' },
      { id: 'T002', parentId: 'T001', position: 1 },
      { id: 'T003', parentId: 'T001', position: 1 },
      { id: 'T004', parentId: 'T001', position: 1 },
    ]);

    const { tree } = await coreTaskTree(env.tempDir, 'T001');
    const root = tree[0]!;
    // All 3 children should be present
    expect(root.children).toHaveLength(3);
    const ids = root.children.map((c) => c.id).sort();
    expect(ids).toEqual(['T002', 'T003', 'T004']);
  });

  it('handles tasks with no children', async () => {
    await seed([{ id: 'T001', type: 'task' }]);

    const { tree } = await coreTaskTree(env.tempDir, 'T001');
    expect(tree[0]!.children).toHaveLength(0);
  });

  it('sorts nested grandchildren correctly', async () => {
    await seed([
      { id: 'T001', type: 'epic' },
      { id: 'T002', parentId: 'T001', position: 1 },
      { id: 'T003', parentId: 'T002', position: 2 },
      { id: 'T004', parentId: 'T002', position: 1 },
    ]);

    const { tree } = await coreTaskTree(env.tempDir, 'T001');
    const child = tree[0]!.children[0]!;
    expect(child.id).toBe('T002');
    // Grandchildren: T004 (pos 1) before T003 (pos 2)
    expect(child.children[0]!.id).toBe('T004');
    expect(child.children[1]!.id).toBe('T003');
  });
});
