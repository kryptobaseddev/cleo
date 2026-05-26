/**
 * Integration tests for coreTaskSlice localized WorkGraph context.
 * @task T10628
 */

import type { Task } from '@cleocode/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
  getTaskAccessor: vi.fn(),
}));

vi.mock('../../store/file-utils.js', () => ({
  readJsonFile: vi.fn(() => null),
  getDataPath: vi.fn((_root: string, file: string) => `/mock/${file}`),
}));

vi.mock('../deps-ready.js', () => ({
  depsReady: vi.fn(() => true),
}));

import { getAccessor, getTaskAccessor } from '../../store/data-accessor.js';
import { coreTaskSlice } from '../task-ops.js';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    description: `Description for ${overrides.id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    updatedAt: null,
    ...overrides,
  } as Task;
}

function setupTasks(tasks: Task[]): void {
  const mockImpl = {
    queryTasks: vi.fn().mockResolvedValue({ tasks, total: tasks.length }),
  };
  (getAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockImpl);
  (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockImpl);
}

describe('coreTaskSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns center, direct upstream, direct downstream, and siblings', async () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'Parent', type: 'epic' }),
      makeTask({ id: 'T002', title: 'Upstream', parentId: 'T001' }),
      makeTask({ id: 'T003', title: 'Center', parentId: 'T001', depends: ['T002'] }),
      makeTask({ id: 'T004', title: 'Sibling', parentId: 'T001' }),
      makeTask({ id: 'T005', title: 'Downstream', parentId: 'T001', depends: ['T003'] }),
      makeTask({ id: 'T006', title: 'Unrelated' }),
    ];
    setupTasks(tasks);

    const result = await coreTaskSlice('/mock', 'T003');

    expect(result.taskId).toBe('T003');
    expect(result.direction).toBe('around');
    expect(result.depth).toBe(1);
    expect(result.radius).toBe(1);
    expect(result.center).toMatchObject({
      id: 'T003',
      title: 'Center',
      parent: 'T001',
      children: [],
      depends: ['T002'],
      dependents: ['T005'],
      depth: 1,
    });
    expect(result.upstream.map((node) => node.id)).toEqual(['T002']);
    expect(result.downstream.map((node) => node.id)).toEqual(['T005']);
    expect(result.siblings.map((node) => node.id).sort()).toEqual(['T002', 'T004', 'T005']);
  });

  it('expands dependency neighborhoods when radius is greater than one', async () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
      makeTask({ id: 'T003', depends: ['T002'] }),
      makeTask({ id: 'T004', depends: ['T003'] }),
    ];
    setupTasks(tasks);

    const result = await coreTaskSlice('/mock', 'T003', { radius: 2 });

    expect(result.upstream.map((node) => node.id)).toEqual(['T002', 'T001']);
    expect(result.downstream.map((node) => node.id)).toEqual(['T004']);
  });

  it('supports direction, include-relates, depth, and budget options', async () => {
    const tasks = [
      makeTask({ id: 'T001', depends: ['T000'] }),
      makeTask({ id: 'T002', depends: ['T001'] }),
      makeTask({
        id: 'T003',
        depends: ['T002'],
        relates: [{ taskId: 'T006', type: 'related-to' }],
      }),
      makeTask({ id: 'T004', depends: ['T003'] }),
      makeTask({ id: 'T005', depends: ['T004'] }),
      makeTask({ id: 'T006' }),
      makeTask({ id: 'T000' }),
    ];
    setupTasks(tasks);

    const upstream = await coreTaskSlice('/mock', 'T003', {
      direction: 'upstream',
      depth: 2,
      includeRelates: true,
    });
    expect(upstream.upstream.map((node) => node.id)).toEqual(['T002', 'T001']);
    expect(upstream.downstream).toEqual([]);
    expect(upstream.related?.map((node) => node.id)).toEqual(['T006']);

    const downstream = await coreTaskSlice('/mock', 'T003', {
      direction: 'downstream',
      depth: 2,
      budget: 1,
    });
    expect(downstream.downstream.map((node) => node.id)).toEqual(['T004']);
    expect(downstream.upstream).toEqual([]);
    expect(downstream.budget).toBe(1);
  });

  it('throws when the center task does not exist', async () => {
    setupTasks([makeTask({ id: 'T001' })]);

    await expect(coreTaskSlice('/mock', 'T999')).rejects.toThrow("Task 'T999' not found");
  });
});
