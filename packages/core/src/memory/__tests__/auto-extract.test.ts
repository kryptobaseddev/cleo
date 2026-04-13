/**
 * Unit tests for auto-extract memory pipeline.
 *
 * extractTaskCompletionMemory and extractSessionEndMemory are disabled no-ops
 * per T523 CA1 specification. Tests verify the no-op contract holds.
 *
 * @task T526
 * @epic T523
 */

import type { Task } from '@cleocode/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- mocks ----------------------------------------------------------------

vi.mock('../learnings.js', () => ({
  storeLearning: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../patterns.js', () => ({
  storePattern: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../decisions.js', () => ({
  storeDecision: vi.fn().mockResolvedValue(undefined),
}));

// Mock getAccessor — should never be called by disabled functions
vi.mock('../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
}));

// ---- imports after mocks --------------------------------------------------

import type { SessionBridgeData } from '../../sessions/session-memory-bridge.js';
import { getAccessor } from '../../store/data-accessor.js';
import {
  extractSessionEndMemory,
  extractTaskCompletionMemory,
  resolveTaskDetails,
} from '../auto-extract.js';
import { storeDecision } from '../decisions.js';
import { storeLearning } from '../learnings.js';
import { storePattern } from '../patterns.js';

// ---- helpers --------------------------------------------------------------

function makeTask(overrides: Partial<Task> & { id: string; title: string }): Task {
  return {
    status: 'done',
    priority: 'medium',
    description: `Description for ${overrides.id}`,
    createdAt: new Date().toISOString(),
    labels: [],
    depends: [],
    ...overrides,
  } as Task;
}

function makeSessionData(overrides: Partial<SessionBridgeData> = {}): SessionBridgeData {
  return {
    sessionId: 'S-test-001',
    scope: 'test scope',
    tasksCompleted: [],
    duration: 3600,
    ...overrides,
  };
}

function setupAccessor(tasks: Task[]): void {
  (getAccessor as ReturnType<typeof vi.fn>).mockResolvedValue({
    queryTasks: vi.fn().mockResolvedValue({ tasks, total: tasks.length }),
    loadTasks: vi.fn().mockImplementation((ids: string[]) => {
      return Promise.resolve(tasks.filter((t) => ids.includes(t.id)));
    }),
    close: vi.fn().mockResolvedValue(undefined),
  });
}

// ---- tests ----------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractTaskCompletionMemory', () => {
  it('is a no-op — does not write learnings', async () => {
    const task = makeTask({ id: 'T001', title: 'Fix auth bug', description: 'Auth was broken' });
    setupAccessor([task]);

    await extractTaskCompletionMemory('/mock/root', task);

    expect(storeLearning).not.toHaveBeenCalled();
  });

  it('is a no-op — does not write dependency learnings', async () => {
    const task = makeTask({
      id: 'T002',
      title: 'Deploy feature',
      description: 'Deploy the thing',
      depends: ['T001', 'T003'],
    });
    setupAccessor([task]);

    await extractTaskCompletionMemory('/mock/root', task);

    expect(storeLearning).not.toHaveBeenCalled();
  });

  it('is a no-op — does not write label patterns', async () => {
    const completedTasks = [
      makeTask({ id: 'T010', title: 'A', labels: ['bug'] }),
      makeTask({ id: 'T011', title: 'B', labels: ['bug'] }),
      makeTask({ id: 'T012', title: 'C', labels: ['bug'] }),
    ];
    const trigger = makeTask({ id: 'T013', title: 'D', labels: ['bug'] });
    setupAccessor([...completedTasks, trigger]);

    await extractTaskCompletionMemory('/mock/root', trigger);

    expect(storePattern).not.toHaveBeenCalled();
    expect(getAccessor).not.toHaveBeenCalled();
  });

  it('resolves to undefined without throwing', async () => {
    setupAccessor([]);

    await expect(
      extractTaskCompletionMemory('/mock/root', makeTask({ id: 'T099', title: 'X' })),
    ).resolves.toBeUndefined();
  });
});

describe('extractSessionEndMemory', () => {
  it('is a no-op — does not write a session decision', async () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'Task one' }),
      makeTask({ id: 'T002', title: 'Task two' }),
    ];
    const session = makeSessionData({ sessionId: 'S-001', tasksCompleted: ['T001', 'T002'] });

    await extractSessionEndMemory('/mock/root', session, tasks);

    expect(storeDecision).not.toHaveBeenCalled();
  });

  it('is a no-op — does not write per-task learnings', async () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'Task one', description: 'Desc one' }),
      makeTask({ id: 'T002', title: 'Task two', description: 'Desc two' }),
    ];
    const session = makeSessionData({ sessionId: 'S-002', tasksCompleted: ['T001', 'T002'] });

    await extractSessionEndMemory('/mock/root', session, tasks);

    expect(storeLearning).not.toHaveBeenCalled();
  });

  it('is a no-op — does not write workflow patterns', async () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'A', labels: ['feature'] }),
      makeTask({ id: 'T002', title: 'B', labels: ['feature'] }),
    ];
    const session = makeSessionData({ sessionId: 'S-003', tasksCompleted: ['T001', 'T002'] });

    await extractSessionEndMemory('/mock/root', session, tasks);

    expect(storePattern).not.toHaveBeenCalled();
  });

  it('resolves to undefined without throwing', async () => {
    const tasks = [makeTask({ id: 'T001', title: 'X' })];
    const session = makeSessionData({ tasksCompleted: ['T001'] });

    await expect(extractSessionEndMemory('/mock/root', session, tasks)).resolves.toBeUndefined();
  });
});

describe('resolveTaskDetails', () => {
  it('resolves task IDs to task objects', async () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'Alpha' }),
      makeTask({ id: 'T002', title: 'Beta' }),
      makeTask({ id: 'T003', title: 'Gamma' }),
    ];
    setupAccessor(tasks);

    const result = await resolveTaskDetails('/mock/root', ['T001', 'T003']);

    expect(result).toHaveLength(2);
    expect(result.map((t) => t.id)).toEqual(expect.arrayContaining(['T001', 'T003']));
  });

  it('filters out missing tasks', async () => {
    const tasks = [makeTask({ id: 'T001', title: 'Alpha' })];
    setupAccessor(tasks);

    const result = await resolveTaskDetails('/mock/root', ['T001', 'T999']);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('T001');
  });

  it('returns empty array when taskIds is empty', async () => {
    setupAccessor([]);

    const result = await resolveTaskDetails('/mock/root', []);

    expect(result).toEqual([]);
    // getAccessor should not be called for empty input
    expect(getAccessor).not.toHaveBeenCalled();
  });
});
