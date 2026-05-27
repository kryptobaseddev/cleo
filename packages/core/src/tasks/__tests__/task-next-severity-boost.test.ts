/**
 * Tests that `coreTaskNext` boosts the score of P0/P1 severity tasks (T9905).
 *
 * Severity is the second urgency axis (orthogonal to priority). Before T9905
 * the scoring algorithm only consulted priority. A P0 incident filed with the
 * default `medium` priority would sit below an unrelated `high`-priority task,
 * which inverted real-world expectations. T9905 adds a +30/+15 bump for
 * severity P0/P1 so the unified urgent surface is consistent across `find`
 * and `next`.
 *
 * @task T9905
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
  depsReady: vi.fn((depends: string[] | undefined) => !depends || depends.length === 0),
}));

import { getTaskAccessor } from '../../store/data-accessor.js';
import { coreTaskNext } from '../task-next.js';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    title: overrides.id,
    description: `desc-${overrides.id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    updatedAt: null,
    depends: [],
    labels: [],
    acceptance: [],
    ...overrides,
  } as Task;
}

function setupAccessor(tasks: Task[]): void {
  const mockImpl = {
    queryTasks: vi.fn().mockResolvedValue({ tasks, total: tasks.length }),
    getMetaValue: vi.fn().mockResolvedValue(null),
    loadSingleTask: vi
      .fn()
      .mockImplementation(async (id: string) => tasks.find((t) => t.id === id) ?? null),
  };
  (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockImpl);
}

describe('coreTaskNext severity boost (T9905)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('places P0 severity above unrelated medium-priority tasks', async () => {
    setupAccessor([
      makeTask({ id: 'T-A', priority: 'medium' }),
      makeTask({ id: 'T-B', priority: 'medium', severity: 'P0' }),
    ]);
    const result = await coreTaskNext('/mock', { count: 2 });
    expect(result.suggestions[0]!.id).toBe('T-B');
  });

  it('boosts P0 (+30) by more than P1 (+15)', async () => {
    setupAccessor([
      makeTask({ id: 'T-P0', priority: 'medium', severity: 'P0' }),
      makeTask({ id: 'T-P1', priority: 'medium', severity: 'P1' }),
    ]);
    const result = await coreTaskNext('/mock', { count: 2, explain: true });
    expect(result.suggestions[0]!.id).toBe('T-P0');
    expect(result.suggestions[1]!.id).toBe('T-P1');
    expect(result.suggestions[0]!.score).toBeGreaterThan(result.suggestions[1]!.score);
  });

  it('does not boost P2 or P3', async () => {
    setupAccessor([
      makeTask({ id: 'T-NORM', priority: 'high' }),
      makeTask({ id: 'T-P2', priority: 'medium', severity: 'P2' }),
      makeTask({ id: 'T-P3', priority: 'medium', severity: 'P3' }),
    ]);
    const result = await coreTaskNext('/mock', { count: 3 });
    // T-NORM (high=75) should win against medium=50 with no severity boost
    expect(result.suggestions[0]!.id).toBe('T-NORM');
  });

  it('mentions severity in explain reasons when boost applies', async () => {
    setupAccessor([makeTask({ id: 'T-P0', priority: 'medium', severity: 'P0' })]);
    const result = await coreTaskNext('/mock', { count: 1, explain: true });
    const reasons = result.suggestions[0]!.reasons ?? [];
    expect(reasons.some((r) => /severity/i.test(r))).toBe(true);
  });
});
