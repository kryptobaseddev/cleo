/**
 * Tests for FlatTreeNode dependency metadata extension (T1199).
 *
 * Verifies that `coreTaskTree` populates the new `priority`, `depends`,
 * `blockedBy`, and `ready` fields on every returned node.
 *
 * Acceptance criteria (T1199):
 * - `priority` is copied from the task record
 * - `depends` reflects the raw direct dependency IDs
 * - `blockedBy` contains only open (non-done/non-cancelled) deps
 * - `ready` is true when blockedBy is empty AND status is pending/active
 * - `ready` is false for tasks blocked by open deps
 * - Existing consumers (id/title/status/type/children) are unchanged
 *
 * @task T1199
 * @epic T1187
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

describe('FlatTreeNode dependency metadata (T1199)', () => {
  describe('priority field', () => {
    it('copies priority from task record — critical', async () => {
      await seed([{ id: 'T001', priority: 'critical' }]);
      const { tree } = await coreTaskTree(env.tempDir, 'T001');
      expect(tree[0]!.priority).toBe('critical');
    });

    it('copies priority from task record — high', async () => {
      await seed([{ id: 'T001', priority: 'high' }]);
      const { tree } = await coreTaskTree(env.tempDir, 'T001');
      expect(tree[0]!.priority).toBe('high');
    });

    it('defaults to medium when not explicitly set', async () => {
      await seed([{ id: 'T001' }]);
      const { tree } = await coreTaskTree(env.tempDir, 'T001');
      // test-db-helper defaults priority to 'medium'
      expect(tree[0]!.priority).toBe('medium');
    });
  });

  describe('depends field', () => {
    it('is an empty array when task has no declared dependencies', async () => {
      await seed([{ id: 'T001' }]);
      const { tree } = await coreTaskTree(env.tempDir, 'T001');
      expect(tree[0]!.depends).toEqual([]);
    });

    it('reflects direct dependency IDs from the task record', async () => {
      await seed([
        { id: 'T001', status: 'done' },
        { id: 'T002', status: 'done' },
        { id: 'T003', depends: ['T001', 'T002'] },
      ]);
      const { tree } = await coreTaskTree(env.tempDir, 'T003');
      expect(tree[0]!.depends).toEqual(['T001', 'T002']);
    });
  });

  describe('blockedBy field', () => {
    it('is empty when task has no deps', async () => {
      await seed([{ id: 'T001' }]);
      const { tree } = await coreTaskTree(env.tempDir, 'T001');
      expect(tree[0]!.blockedBy).toEqual([]);
    });

    it('is empty when all deps are done', async () => {
      await seed([
        { id: 'T001', status: 'done' },
        { id: 'T002', status: 'done' },
        { id: 'T003', depends: ['T001', 'T002'] },
      ]);
      const { tree } = await coreTaskTree(env.tempDir, 'T003');
      expect(tree[0]!.blockedBy).toEqual([]);
    });

    it('is empty when all deps are cancelled', async () => {
      await seed([
        { id: 'T001', status: 'cancelled' },
        { id: 'T002', depends: ['T001'] },
      ]);
      const { tree } = await coreTaskTree(env.tempDir, 'T002');
      expect(tree[0]!.blockedBy).toEqual([]);
    });

    it('contains pending dep IDs that are still open', async () => {
      await seed([
        { id: 'T001', status: 'pending' },
        { id: 'T002', status: 'done' },
        { id: 'T003', depends: ['T001', 'T002'] },
      ]);
      const { tree } = await coreTaskTree(env.tempDir, 'T003');
      expect(tree[0]!.blockedBy).toEqual(['T001']);
    });

    it('contains active dep IDs that are still open', async () => {
      await seed([
        { id: 'T001', status: 'active' },
        { id: 'T002', depends: ['T001'] },
      ]);
      const { tree } = await coreTaskTree(env.tempDir, 'T002');
      expect(tree[0]!.blockedBy).toEqual(['T001']);
    });

    it('lists all open deps when multiple are unresolved', async () => {
      await seed([
        { id: 'T001', status: 'pending' },
        { id: 'T002', status: 'active' },
        { id: 'T003', status: 'done' },
        { id: 'T004', depends: ['T001', 'T002', 'T003'] },
      ]);
      const { tree } = await coreTaskTree(env.tempDir, 'T004');
      expect(tree[0]!.blockedBy).toEqual(['T001', 'T002']);
    });
  });

  describe('ready field', () => {
    it('is true when task has no deps and status is pending', async () => {
      await seed([{ id: 'T001', status: 'pending' }]);
      const { tree } = await coreTaskTree(env.tempDir, 'T001');
      expect(tree[0]!.ready).toBe(true);
    });

    it('is true when task has no deps and status is active', async () => {
      await seed([{ id: 'T001', status: 'active' }]);
      const { tree } = await coreTaskTree(env.tempDir, 'T001');
      expect(tree[0]!.ready).toBe(true);
    });

    it('is true when all deps are satisfied (done) and status is pending', async () => {
      await seed([
        { id: 'T001', status: 'done' },
        { id: 'T002', status: 'done' },
        { id: 'T003', status: 'pending', depends: ['T001', 'T002'] },
      ]);
      const { tree } = await coreTaskTree(env.tempDir, 'T003');
      const node = tree[0]!;
      expect(node.blockedBy).toEqual([]);
      expect(node.ready).toBe(true);
    });

    it('is false when there are open deps (blocked)', async () => {
      await seed([
        { id: 'T001', status: 'pending' },
        { id: 'T002', status: 'pending', depends: ['T001'] },
      ]);
      const { tree } = await coreTaskTree(env.tempDir, 'T002');
      const node = tree[0]!;
      expect(node.blockedBy).toEqual(['T001']);
      expect(node.ready).toBe(false);
    });

    it('is false for done tasks even if all deps resolved', async () => {
      await seed([
        { id: 'T001', status: 'done' },
        { id: 'T002', status: 'done', depends: ['T001'] },
      ]);
      const { tree } = await coreTaskTree(env.tempDir, 'T002');
      expect(tree[0]!.ready).toBe(false);
    });

    it('is false for cancelled tasks', async () => {
      await seed([{ id: 'T001', status: 'cancelled' }]);
      const { tree } = await coreTaskTree(env.tempDir, 'T001');
      expect(tree[0]!.ready).toBe(false);
    });
  });

  describe('backward compatibility — existing fields unchanged', () => {
    it('preserves id, title, status, type, and children for existing consumers', async () => {
      await seed([
        { id: 'T001', type: 'epic', title: 'Root Epic' },
        { id: 'T002', title: 'Child Task', parentId: 'T001', type: 'task' },
      ]);
      const { tree } = await coreTaskTree(env.tempDir, 'T001');
      const root = tree[0]!;

      // Existing fields are untouched
      expect(root.id).toBe('T001');
      expect(root.title).toBe('Root Epic');
      expect(root.status).toBe('pending');
      expect(root.type).toBe('epic');
      expect(root.children).toHaveLength(1);

      const child = root.children[0]!;
      expect(child.id).toBe('T002');
      expect(child.title).toBe('Child Task');
      expect(child.type).toBe('task');
    });
  });
});
