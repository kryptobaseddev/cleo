/**
 * Tests for saga-aware `cleo list --parent` routing.
 *
 * When `--parent` targets a Saga (Epic with `labels.includes('saga')`),
 * children must be resolved via `task_relations.type='groups'` edges instead
 * of the default `parentId` column query (ADR-073 §1).
 *
 * @task T9658
 * @epic T9566
 * @see ADR-073-above-epic-naming.md §1
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { LIST_BINDING_SAGA_GROUPS, listTasks, SAGA_GROUPS_RELATION } from '../list.js';

describe('listTasks — saga-aware --parent routing (T9658)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  describe('saga path', () => {
    it("resolves children for a Saga via task_relations.type='groups'", async () => {
      // Saga (T9560) holds member Epics via `groups` edges, NOT parentId.
      // Member Epics (T9561..T9563) are top-level — no parentId set.
      await seedTasks(accessor, [
        {
          id: 'T9560',
          title: 'SG-X: example saga',
          status: 'active',
          priority: 'high',
          type: 'epic',
          labels: ['saga'],
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T9561',
          title: 'E1: member epic 1',
          status: 'active',
          priority: 'high',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T9562',
          title: 'E2: member epic 2',
          status: 'pending',
          priority: 'high',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T9563',
          title: 'E3: member epic 3',
          status: 'pending',
          priority: 'medium',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
        // Non-member: should not appear in the saga member list.
        {
          id: 'T9999',
          title: 'Unrelated Epic',
          status: 'pending',
          priority: 'low',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
      ]);

      await accessor.addRelation('T9560', 'T9561', SAGA_GROUPS_RELATION);
      await accessor.addRelation('T9560', 'T9562', SAGA_GROUPS_RELATION);
      await accessor.addRelation('T9560', 'T9563', SAGA_GROUPS_RELATION);

      const result = await listTasks({ parentId: 'T9560' }, env.tempDir, accessor);

      expect(result.tasks).toHaveLength(3);
      const ids = result.tasks.map((t) => t.id).sort();
      expect(ids).toEqual(['T9561', 'T9562', 'T9563']);
      expect(result.filtered).toBe(3);
      // AC5: result is tagged with bindingSource='saga.groups'
      expect(result.bindingSource).toBe(LIST_BINDING_SAGA_GROUPS);
    });

    it('returns an empty list (with saga.groups binding) for a Saga with no members', async () => {
      await seedTasks(accessor, [
        {
          id: 'T9560',
          title: 'SG-EMPTY: saga with no members',
          status: 'pending',
          priority: 'high',
          type: 'epic',
          labels: ['saga'],
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await listTasks({ parentId: 'T9560' }, env.tempDir, accessor);

      expect(result.tasks).toHaveLength(0);
      expect(result.filtered).toBe(0);
      expect(result.bindingSource).toBe(LIST_BINDING_SAGA_GROUPS);
    });

    it('ignores non-groups relations (e.g. "blocks", "related") when resolving Saga members', async () => {
      await seedTasks(accessor, [
        {
          id: 'T9560',
          title: 'SG-X',
          status: 'active',
          priority: 'high',
          type: 'epic',
          labels: ['saga'],
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T9561',
          title: 'Member',
          status: 'active',
          priority: 'high',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T9562',
          title: 'Not a member — only blocks',
          status: 'pending',
          priority: 'high',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
      ]);

      await accessor.addRelation('T9560', 'T9561', SAGA_GROUPS_RELATION);
      await accessor.addRelation('T9560', 'T9562', 'blocks');

      const result = await listTasks({ parentId: 'T9560' }, env.tempDir, accessor);

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]?.id).toBe('T9561');
      expect(result.bindingSource).toBe(LIST_BINDING_SAGA_GROUPS);
    });

    it('still applies status/priority filters within the Saga member set', async () => {
      await seedTasks(accessor, [
        {
          id: 'T9560',
          title: 'SG-X',
          status: 'active',
          priority: 'high',
          type: 'epic',
          labels: ['saga'],
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T9561',
          title: 'Done member',
          status: 'done',
          priority: 'high',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T9562',
          title: 'Active member',
          status: 'active',
          priority: 'high',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
      ]);

      await accessor.addRelation('T9560', 'T9561', SAGA_GROUPS_RELATION);
      await accessor.addRelation('T9560', 'T9562', SAGA_GROUPS_RELATION);

      const result = await listTasks(
        { parentId: 'T9560', status: 'active' },
        env.tempDir,
        accessor,
      );

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]?.id).toBe('T9562');
      expect(result.bindingSource).toBe(LIST_BINDING_SAGA_GROUPS);
    });
  });

  describe('regular (non-saga) Epic parent — backwards compatibility', () => {
    it('still uses parentId column for regular Epic children', async () => {
      // Regular Epic (no `saga` label) — its children use parentId.
      await seedTasks(accessor, [
        {
          id: 'T9566',
          title: 'Regular epic',
          status: 'active',
          priority: 'high',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T9567',
          title: 'Child 1',
          status: 'pending',
          priority: 'medium',
          parentId: 'T9566',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T9568',
          title: 'Child 2',
          status: 'pending',
          priority: 'medium',
          parentId: 'T9566',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T9569',
          title: 'Other (no parent)',
          status: 'pending',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await listTasks({ parentId: 'T9566' }, env.tempDir, accessor);

      expect(result.tasks).toHaveLength(2);
      const ids = result.tasks.map((t) => t.id).sort();
      expect(ids).toEqual(['T9567', 'T9568']);
      // bindingSource must be undefined for the default parentId path.
      expect(result.bindingSource).toBeUndefined();
    });

    it('does NOT mistake a non-saga labeled Epic for a Saga', async () => {
      // Has a `label` but it is not the `saga` label.
      await seedTasks(accessor, [
        {
          id: 'T9566',
          title: 'Labeled epic',
          status: 'active',
          priority: 'high',
          type: 'epic',
          labels: ['platform', 'infra'],
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T9567',
          title: 'Child',
          status: 'pending',
          priority: 'medium',
          parentId: 'T9566',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await listTasks({ parentId: 'T9566' }, env.tempDir, accessor);

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]?.id).toBe('T9567');
      expect(result.bindingSource).toBeUndefined();
    });
  });

  describe('error / edge cases', () => {
    it('returns an empty list when --parent targets an unknown task ID', async () => {
      await seedTasks(accessor, [
        {
          id: 'T9566',
          title: 'Existing epic',
          status: 'active',
          priority: 'high',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await listTasks({ parentId: 'T9999-NONEXISTENT' }, env.tempDir, accessor);

      expect(result.tasks).toHaveLength(0);
      expect(result.filtered).toBe(0);
      // Unknown parent → default parentId path returns empty; not a saga path.
      expect(result.bindingSource).toBeUndefined();
    });

    it('does not tag bindingSource when no --parent was supplied', async () => {
      await seedTasks(accessor, [
        {
          id: 'T9560',
          title: 'SG-X',
          status: 'active',
          priority: 'high',
          type: 'epic',
          labels: ['saga'],
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await listTasks({}, env.tempDir, accessor);

      expect(result.bindingSource).toBeUndefined();
    });
  });
});
