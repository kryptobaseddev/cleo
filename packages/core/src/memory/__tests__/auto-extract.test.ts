/**
 * Unit tests for the auto-extract module.
 *
 * The legacy `extractTaskCompletionMemory` and `extractSessionEndMemory`
 * functions were removed entirely (the LLM extraction gate replaced the
 * keyword regex in extractFromTranscript). Only `resolveTaskDetails` and
 * `extractFromTranscript` remain.
 */

import type { Task } from '@cleocode/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- mocks ----------------------------------------------------------------

vi.mock('../llm-extraction.js', () => ({
  extractFromTranscript: vi.fn().mockResolvedValue({
    extractedCount: 0,
    storedCount: 0,
    mergedCount: 0,
    rejectedCount: 0,
    warnings: [],
  }),
}));

vi.mock('../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
}));

// ---- imports after mocks --------------------------------------------------

import { getAccessor } from '../../store/data-accessor.js';
import { extractFromTranscript, resolveTaskDetails } from '../auto-extract.js';
import { extractFromTranscript as llmExtractFromTranscript } from '../llm-extraction.js';

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

describe('extractFromTranscript (wrapper) — auto-extract unit', () => {
  it('delegates to the LLM extraction gate for non-empty input', async () => {
    await extractFromTranscript('/mock/root', 'S-100', 'some transcript content');

    expect(llmExtractFromTranscript).toHaveBeenCalledTimes(1);
    expect(llmExtractFromTranscript).toHaveBeenCalledWith({
      projectRoot: '/mock/root',
      sessionId: 'S-100',
      transcript: 'some transcript content',
    });
  });

  it('skips the LLM call when transcript is empty', async () => {
    await extractFromTranscript('/mock/root', 'S-101', '');
    expect(llmExtractFromTranscript).not.toHaveBeenCalled();
  });

  it('skips the LLM call when transcript is whitespace-only', async () => {
    await extractFromTranscript('/mock/root', 'S-102', '   \n  \t ');
    expect(llmExtractFromTranscript).not.toHaveBeenCalled();
  });

  it('swallows errors from the LLM extraction gate', async () => {
    (llmExtractFromTranscript as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('simulated failure'),
    );

    await expect(
      extractFromTranscript('/mock/root', 'S-103', 'meaningful content'),
    ).resolves.toBeUndefined();
  });

  it('returns undefined on non-string transcript input', async () => {
    await expect(
      extractFromTranscript('/mock/root', 'S-104', null as unknown as string),
    ).resolves.toBeUndefined();
    await expect(
      extractFromTranscript('/mock/root', 'S-104', 123 as unknown as string),
    ).resolves.toBeUndefined();
    expect(llmExtractFromTranscript).not.toHaveBeenCalled();
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
