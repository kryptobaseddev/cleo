/**
 * Integration tests for coreTaskDepends with transitive hints.
 * @task T5069
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../../../types/task.js';

// Mock the data accessor
vi.mock('../../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
}));

// Mock file-utils since loadAllTasks path goes through it indirectly
vi.mock('../../../store/file-utils.js', () => ({
  readJsonFile: vi.fn(() => null),
  readLogFileEntries: vi.fn(() => []),
  getDataPath: vi.fn((_root: string, file: string) => `/mock/${file}`),
}));

// Mock deps-ready (used by coreTaskNext but imported at module level)
vi.mock('../deps-ready.js', () => ({
  depsReady: vi.fn(() => true),
}));

import { getAccessor } from '../../../store/data-accessor.js';
import { coreTaskDepends } from '../task-ops.js';

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
  (getAccessor as ReturnType<typeof vi.fn>).mockResolvedValue({
    loadTaskFile: vi.fn().mockResolvedValue({ tasks }),
  });
}

describe('coreTaskDepends transitive hints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('unresolvedChain count matches transitive depth', async () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
      makeTask({ id: 'T003', depends: ['T002'] }),
    ];
    setupTasks(tasks);

    const result = await coreTaskDepends('/mock', 'T003');
    expect(result.unresolvedChain).toBe(2);
  });

  it('leafBlockers resolves to correct objects', async () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'Root task' }),
      makeTask({ id: 'T002', title: 'Middle task', depends: ['T001'] }),
      makeTask({ id: 'T003', title: 'Leaf task', depends: ['T002'] }),
    ];
    setupTasks(tasks);

    const result = await coreTaskDepends('/mock', 'T003');
    expect(result.leafBlockers).toEqual([
      { id: 'T001', title: 'Root task', status: 'pending' },
    ]);
  });

  it('hint is present when chain > 0, absent when resolved', async () => {
    const pendingTasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
      makeTask({ id: 'T003', depends: ['T002'] }),
    ];
    setupTasks(pendingTasks);

    const withHint = await coreTaskDepends('/mock', 'T003');
    expect(withHint.hint).toBeDefined();
    expect(withHint.hint).toContain('ct deps show');

    // All deps resolved
    const resolvedTasks = [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'done', depends: ['T001'] }),
      makeTask({ id: 'T003', depends: ['T002'] }),
    ];
    setupTasks(resolvedTasks);

    const withoutHint = await coreTaskDepends('/mock', 'T003');
    expect(withoutHint.hint).toBeUndefined();
  });

  it('allDepsReady is true when all deps are done', async () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'done', depends: ['T001'] }),
      makeTask({ id: 'T003', depends: ['T002'] }),
    ];
    setupTasks(tasks);

    const result = await coreTaskDepends('/mock', 'T003');
    expect(result.allDepsReady).toBe(true);
    expect(result.unresolvedChain).toBe(0);
  });

  it('upstreamTree is populated when tree option is true', async () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
      makeTask({ id: 'T003', depends: ['T002'] }),
    ];
    setupTasks(tasks);

    const result = await coreTaskDepends('/mock', 'T003', 'both', { tree: true });
    expect(result.upstreamTree).toBeDefined();
    expect(result.upstreamTree).toHaveLength(1);

    const t002Node = result.upstreamTree![0];
    expect(t002Node.id).toBe('T002');
    expect(t002Node.children).toHaveLength(1);
    expect(t002Node.children[0].id).toBe('T001');
  });

  it('upstreamTree is absent when tree option is not set', async () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
      makeTask({ id: 'T003', depends: ['T002'] }),
    ];
    setupTasks(tasks);

    const result = await coreTaskDepends('/mock', 'T003');
    expect(result.upstreamTree).toBeUndefined();
  });
});
