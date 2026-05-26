/**
 * Characterisation tests for orchestrateReport
 *
 * @task T10631
 */

import { orchestrateReport } from '@cleocode/core/internal';
import { mkdirSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let TEST_ROOT: string;

async function seedTasks(testRoot: string, tasks: any[]): Promise<void> {
  const cleoDir = join(testRoot, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  const { getDb } = await import('@cleocode/core/internal');
  const { createTask } = await import('@cleocode/core/internal');
  await getDb(testRoot);

  for (const task of tasks) {
    await createTask(task as any, testRoot);
  }
}

beforeEach(async () => {
  TEST_ROOT = await mkdtemp(join(tmpdir(), 'cleo-report-test-'));
  mkdirSync(join(TEST_ROOT, '.cleo'), { recursive: true });
  mkdirSync(join(TEST_ROOT, '.git'), { recursive: true });
});

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe('orchestrateReport', () => {
  it('classifies ready tasks correctly', async () => {
    await seedTasks(TEST_ROOT, [
      {
        id: 'E1',
        title: 'Epic',
        type: 'epic',
        status: 'active',
        priority: 'high',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
      {
        id: 'T1',
        title: 'Ready task',
        type: 'task',
        status: 'pending',
        priority: 'high',
        parentId: 'E1',
        depends: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
      {
        id: 'T2',
        title: 'Another ready',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        parentId: 'E1',
        depends: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
    ]);

    const result = await orchestrateReport('E1', TEST_ROOT);
    expect(result.success).toBe(true);
    const groups = (result.data as any).groups;
    const readyGroup = groups.find((g: any) => g.group === 'ready');
    expect(readyGroup).toBeDefined();
    expect(readyGroup.count).toBe(2);
    expect(readyGroup.tasks.map((t: any) => t.id)).toEqual(['T1', 'T2']);
  });

  it('classifies blockedBy tasks with unmet dependencies', async () => {
    await seedTasks(TEST_ROOT, [
      {
        id: 'E1',
        title: 'Epic',
        type: 'epic',
        status: 'active',
        priority: 'high',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
      {
        id: 'T1',
        title: 'Blocked task',
        type: 'task',
        status: 'pending',
        priority: 'high',
        parentId: 'E1',
        depends: ['T2'],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
      {
        id: 'T2',
        title: 'Unfinished dep',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        parentId: 'E1',
        depends: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
    ]);

    const result = await orchestrateReport('E1', TEST_ROOT);
    expect(result.success).toBe(true);
    const groups = (result.data as any).groups;
    const blockedByGroup = groups.find((g: any) => g.group === 'blockedBy');
    expect(blockedByGroup).toBeDefined();
    expect(blockedByGroup.count).toBe(1);
    expect(blockedByGroup.tasks[0].id).toBe('T1');
    expect(blockedByGroup.tasks[0].reason).toContain('T2');
  });

  it('gate-blocked group exists with count 0 when no gates persisted', async () => {
    await seedTasks(TEST_ROOT, [
      {
        id: 'E1',
        title: 'Epic',
        type: 'epic',
        status: 'active',
        priority: 'high',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
      {
        id: 'T1',
        title: 'Pending task',
        type: 'task',
        status: 'pending',
        priority: 'high',
        parentId: 'E1',
        depends: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
    ]);

    const result = await orchestrateReport('E1', TEST_ROOT);
    expect(result.success).toBe(true);
    const groups = (result.data as any).groups;
    const gateGroup = groups.find((g: any) => g.group === 'gateBlocked');
    expect(gateGroup).toBeDefined();
    // createTask does not persist gates; pending tasks flow to 'ready' group
    expect(gateGroup.count).toBe(0);
  });

  it('skips done and cancelled tasks', async () => {
    await seedTasks(TEST_ROOT, [
      {
        id: 'E1',
        title: 'Epic',
        type: 'epic',
        status: 'active',
        priority: 'high',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
      {
        id: 'T1',
        title: 'Done task',
        type: 'task',
        status: 'done',
        priority: 'high',
        parentId: 'E1',
        depends: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
      {
        id: 'T2',
        title: 'Cancelled',
        type: 'task',
        status: 'cancelled',
        priority: 'low',
        parentId: 'E1',
        depends: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
      {
        id: 'T3',
        title: 'Ready',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        parentId: 'E1',
        depends: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
    ]);

    const result = await orchestrateReport('E1', TEST_ROOT);
    expect(result.success).toBe(true);
    const groups = (result.data as any).groups;
    const readyGroup = groups.find((g: any) => g.group === 'ready');
    expect(readyGroup.count).toBe(1);
    expect(readyGroup.tasks[0].id).toBe('T3');
  });

  it('handles pagination', async () => {
    const tasks: any[] = [
      {
        id: 'E1',
        title: 'Epic',
        type: 'epic',
        status: 'active',
        priority: 'high',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
    ];
    for (let i = 1; i <= 5; i++) {
      tasks.push({
        id: `T${i}`,
        title: `Task ${i}`,
        type: 'task',
        status: 'pending',
        priority: 'medium',
        parentId: 'E1',
        depends: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      });
    }
    await seedTasks(TEST_ROOT, tasks);

    const result = await orchestrateReport('E1', TEST_ROOT, { page: 1, pageSize: 2 });
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.pagination.page).toBe(1);
    expect(data.pagination.pageSize).toBe(2);
    expect(data.pagination.totalPages).toBe(3);
    expect(data.pagination.totalEntries).toBe(5);
    const readyGroup = data.groups.find((g: any) => g.group === 'ready');
    expect(readyGroup.tasks.length).toBe(2);
    expect(readyGroup.tasks.map((t: any) => t.id)).toEqual(['T1', 'T2']);
  });

  it('returns error for nonexistent epic', async () => {
    const result = await orchestrateReport('NONEXISTENT', TEST_ROOT);
    expect(result.success).toBe(false);
    // Error code may vary — just ensure it's a failure
    expect(result.success).toBe(false);
  });

  it('all groups have correct labels and shapes', async () => {
    await seedTasks(TEST_ROOT, [
      {
        id: 'E1',
        title: 'Epic',
        type: 'epic',
        status: 'active',
        priority: 'high',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
      {
        id: 'T1',
        title: 'Ready',
        type: 'task',
        status: 'pending',
        priority: 'high',
        parentId: 'E1',
        depends: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
      {
        id: 'T2',
        title: 'Blocked',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        parentId: 'E1',
        depends: ['T99'],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
    ]);

    const result = await orchestrateReport('E1', TEST_ROOT);
    expect(result.success).toBe(true);
    const groups = (result.data as any).groups;

    expect(groups.length).toBe(5);
    const expectedGroups = ['ready', 'blocked', 'blockedBy', 'gateBlocked', 'invalid'];
    for (const g of expectedGroups) {
      const found = groups.find((grp: any) => grp.group === g);
      expect(found).toBeDefined();
      expect(found.label).toBeTruthy();
      expect(typeof found.count).toBe('number');
      expect(Array.isArray(found.tasks)).toBe(true);
    }
  });
});
