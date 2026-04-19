/**
 * Unit tests for the Pattern Extraction module.
 *
 * Tests pattern extraction from history, pattern matching against tasks,
 * pattern storage, and stat updates. All external dependencies are mocked.
 */

import type { Task } from '@cleocode/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataAccessor } from '../../store/data-accessor.js';
import type { BrainDataAccessor } from '../../store/memory-accessor.js';
import type { BrainObservationRow, BrainPatternRow } from '../../store/memory-schema.js';
import {
  extractPatternsFromHistory,
  matchPatterns,
  storeDetectedPattern,
  updatePatternStats,
} from '../patterns.js';
import type { DetectedPattern } from '../types.js';

// ---- helpers ----------------------------------------------------------------

function makeTask(overrides: Partial<Task> & { id: string; title: string }): Task {
  return {
    status: 'pending',
    priority: 'medium',
    description: `Description for ${overrides.id}`,
    createdAt: new Date().toISOString(),
    labels: [],
    depends: [],
    ...overrides,
  } as Task;
}

function makePattern(overrides: Partial<BrainPatternRow> = {}): BrainPatternRow {
  return {
    id: `P-${Math.random().toString(36).slice(2, 10)}`,
    type: 'success',
    pattern: 'test pattern',
    context: 'test context',
    frequency: 1,
    successRate: null,
    impact: null,
    antiPattern: null,
    mitigation: null,
    examplesJson: '[]',
    extractedAt: new Date().toISOString(),
    updatedAt: null,
    ...overrides,
  };
}

function makeObservation(overrides: Partial<BrainObservationRow> = {}): BrainObservationRow {
  return {
    id: `O-${Math.random().toString(36).slice(2, 10)}`,
    type: 'feature',
    title: 'Test observation',
    subtitle: null,
    narrative: null,
    factsJson: null,
    conceptsJson: null,
    project: null,
    filesReadJson: null,
    filesModifiedJson: null,
    sourceSessionId: null,
    sourceType: 'agent',
    contentHash: null,
    discoveryTokens: null,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    ...overrides,
  };
}

function mockTaskAccessor(tasks: Task[]): DataAccessor {
  return {
    loadSingleTask: vi
      .fn()
      .mockImplementation((id: string) => Promise.resolve(tasks.find((t) => t.id === id) ?? null)),
    queryTasks: vi.fn().mockResolvedValue({ tasks, total: tasks.length }),
    countChildren: vi.fn().mockResolvedValue(0),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as DataAccessor;
}

function mockBrainAccessor(
  patterns: BrainPatternRow[] = [],
  observations: BrainObservationRow[] = [],
): BrainDataAccessor {
  return {
    findPatterns: vi.fn().mockImplementation((params?: { type?: string; limit?: number }) => {
      let filtered = patterns;
      if (params?.type) {
        filtered = filtered.filter((p) => p.type === params.type);
      }
      if (params?.limit) {
        filtered = filtered.slice(0, params.limit);
      }
      return Promise.resolve(filtered);
    }),
    findObservations: vi.fn().mockResolvedValue(observations),
    findLearnings: vi.fn().mockResolvedValue([]),
    addPattern: vi.fn().mockImplementation((row: BrainPatternRow) => Promise.resolve(row)),
    getPattern: vi
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve(patterns.find((p) => p.id === id) ?? null),
      ),
    updatePattern: vi.fn().mockResolvedValue(undefined),
  } as unknown as BrainDataAccessor;
}

// ---- tests ----------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractPatternsFromHistory', () => {
  it('returns empty array when no tasks exist', async () => {
    const taskAccessor = mockTaskAccessor([]);
    const brainAccessor = mockBrainAccessor();

    const result = await extractPatternsFromHistory(taskAccessor, brainAccessor);

    expect(result).toEqual([]);
  });

  it('extracts blocker patterns from blocked tasks', async () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'Task 1', status: 'blocked', blockedBy: 'API not ready' }),
      makeTask({ id: 'T002', title: 'Task 2', status: 'blocked', blockedBy: 'API not ready' }),
      makeTask({ id: 'T003', title: 'Task 3', status: 'active' }),
    ];
    const taskAccessor = mockTaskAccessor(tasks);
    const brainAccessor = mockBrainAccessor();

    const result = await extractPatternsFromHistory(taskAccessor, brainAccessor);

    const blockerPatterns = result.filter((p) => p.type === 'blocker');
    expect(blockerPatterns.length).toBeGreaterThan(0);
    expect(blockerPatterns.some((p) => p.pattern.includes('API not ready'))).toBe(true);
  });

  it('extracts success patterns from completed tasks with labels', async () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'Fix A', status: 'done', labels: ['bugfix'] }),
      makeTask({ id: 'T002', title: 'Fix B', status: 'done', labels: ['bugfix'] }),
      makeTask({ id: 'T003', title: 'Fix C', status: 'done', labels: ['bugfix'] }),
    ];
    const taskAccessor = mockTaskAccessor(tasks);
    const brainAccessor = mockBrainAccessor();

    const result = await extractPatternsFromHistory(taskAccessor, brainAccessor);

    const successPatterns = result.filter((p) => p.type === 'success');
    expect(successPatterns.length).toBeGreaterThan(0);
    expect(successPatterns.some((p) => p.pattern.includes('bugfix'))).toBe(true);
  });

  it('extracts workflow patterns from dependency hubs', async () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'Base task' }),
      makeTask({ id: 'T002', title: 'A', depends: ['T001'] }),
      makeTask({ id: 'T003', title: 'B', depends: ['T001'] }),
      makeTask({ id: 'T004', title: 'C', depends: ['T001'] }),
    ];
    const taskAccessor = mockTaskAccessor(tasks);
    const brainAccessor = mockBrainAccessor();

    const result = await extractPatternsFromHistory(taskAccessor, brainAccessor, {
      minFrequency: 2,
    });

    const workflowPatterns = result.filter((p) => p.type === 'workflow');
    expect(workflowPatterns.some((p) => p.pattern.includes('T001'))).toBe(true);
  });

  it('extracts observation patterns from brain observations', async () => {
    const observations = [
      makeObservation({ type: 'bugfix' }),
      makeObservation({ type: 'bugfix' }),
      makeObservation({ type: 'bugfix' }),
      makeObservation({ type: 'feature' }),
    ];
    const taskAccessor = mockTaskAccessor([]);
    const brainAccessor = mockBrainAccessor([], observations);

    const result = await extractPatternsFromHistory(taskAccessor, brainAccessor, {
      minFrequency: 2,
    });

    expect(result.some((p) => p.pattern.includes('bugfix'))).toBe(true);
  });

  it('filters by pattern type when specified', async () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'Task 1', status: 'blocked', blockedBy: 'deps' }),
      makeTask({ id: 'T002', title: 'Task 2', status: 'blocked', blockedBy: 'deps' }),
      makeTask({ id: 'T003', title: 'Done 1', status: 'done', labels: ['feature'] }),
      makeTask({ id: 'T004', title: 'Done 2', status: 'done', labels: ['feature'] }),
    ];
    const taskAccessor = mockTaskAccessor(tasks);
    const brainAccessor = mockBrainAccessor();

    const result = await extractPatternsFromHistory(taskAccessor, brainAccessor, {
      type: 'blocker',
    });

    for (const p of result) {
      expect(p.type).toBe('blocker');
    }
  });

  it('respects limit option', async () => {
    const tasks = Array.from({ length: 20 }, (_, i) =>
      makeTask({
        id: `T${String(i).padStart(3, '0')}`,
        title: `Task ${i}`,
        status: 'done',
        labels: [`label-${i % 3}`],
      }),
    );
    const taskAccessor = mockTaskAccessor(tasks);
    const brainAccessor = mockBrainAccessor();

    const result = await extractPatternsFromHistory(taskAccessor, brainAccessor, {
      limit: 3,
    });

    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('sorts by frequency descending', async () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'A', status: 'done', labels: ['common'] }),
      makeTask({ id: 'T002', title: 'B', status: 'done', labels: ['common'] }),
      makeTask({ id: 'T003', title: 'C', status: 'done', labels: ['common'] }),
      makeTask({ id: 'T004', title: 'D', status: 'done', labels: ['rare'] }),
      makeTask({ id: 'T005', title: 'E', status: 'done', labels: ['rare'] }),
    ];
    const taskAccessor = mockTaskAccessor(tasks);
    const brainAccessor = mockBrainAccessor();

    const result = await extractPatternsFromHistory(taskAccessor, brainAccessor);

    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].frequency).toBeGreaterThanOrEqual(result[i].frequency);
    }
  });
});

describe('matchPatterns', () => {
  it('returns empty array for not-found task', async () => {
    const taskAccessor = mockTaskAccessor([]);
    const brainAccessor = mockBrainAccessor();

    const result = await matchPatterns('T999', taskAccessor, brainAccessor);

    expect(result).toEqual([]);
  });

  it('matches patterns by label overlap', async () => {
    const task = makeTask({ id: 'T001', title: 'Auth task', labels: ['auth'] });
    const patterns = [
      makePattern({
        id: 'P-001',
        pattern: 'Auth modules require careful testing',
        context: 'auth best practices',
      }),
      makePattern({
        id: 'P-002',
        pattern: 'Database migration steps',
        context: 'database operations',
      }),
    ];
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor(patterns);

    const result = await matchPatterns('T001', taskAccessor, brainAccessor);

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].pattern.id).toBe('P-001');
    expect(result[0].relevanceScore).toBeGreaterThan(0);
    expect(result[0].matchReason).toContain('auth');
  });

  it('matches patterns by title keywords', async () => {
    const task = makeTask({ id: 'T001', title: 'Database migration refactor' });
    const patterns = [
      makePattern({
        id: 'P-001',
        pattern: 'Migration tasks need rollback plans',
        context: 'database migration best practices',
      }),
    ];
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor(patterns);

    const result = await matchPatterns('T001', taskAccessor, brainAccessor);

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].matchReason).toContain('migration');
  });

  it('identifies anti-pattern matches', async () => {
    const task = makeTask({ id: 'T001', title: 'Quick fix', labels: ['hotfix'] });
    const patterns = [
      makePattern({
        id: 'P-001',
        pattern: 'Hotfix without tests',
        context: 'hotfix anti-pattern',
        antiPattern: 'Deploying hotfixes without regression tests risks introducing new bugs',
        mitigation: 'Always add regression tests for hotfixes',
      }),
    ];
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor(patterns);

    const result = await matchPatterns('T001', taskAccessor, brainAccessor);

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].isAntiPattern).toBe(true);
  });

  it('sorts matches by relevance descending', async () => {
    const task = makeTask({ id: 'T001', title: 'Auth migration', labels: ['auth'] });
    const patterns = [
      makePattern({
        id: 'P-001',
        pattern: 'Auth tasks need special handling',
        context: 'auth context',
      }),
      makePattern({
        id: 'P-002',
        pattern: 'Migration requires rollback',
        context: 'migration context',
      }),
      makePattern({
        id: 'P-003',
        pattern: 'Auth migration is complex',
        context: 'auth migration combined',
      }),
    ];
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor(patterns);

    const result = await matchPatterns('T001', taskAccessor, brainAccessor);

    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].relevanceScore).toBeGreaterThanOrEqual(result[i].relevanceScore);
    }
  });
});

describe('storeDetectedPattern', () => {
  it('stores a pattern via brain accessor', async () => {
    const brainAccessor = mockBrainAccessor();
    const detected: DetectedPattern = {
      type: 'success',
      pattern: 'TDD approach leads to fewer bugs',
      context: 'Development methodology analysis',
      frequency: 5,
      successRate: 0.9,
      impact: 'high',
      antiPattern: null,
      mitigation: null,
      examples: ['T001', 'T002', 'T003'],
      confidence: 0.8,
    };

    const result = await storeDetectedPattern(detected, brainAccessor);

    expect(brainAccessor.addPattern).toHaveBeenCalledTimes(1);
    const call = (brainAccessor.addPattern as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.type).toBe('success');
    expect(call.pattern).toBe('TDD approach leads to fewer bugs');
    expect(call.context).toBe('Development methodology analysis');
    expect(call.frequency).toBe(5);
    expect(call.successRate).toBe(0.9);
    expect(call.impact).toBe('high');
    expect(call.examplesJson).toBe(JSON.stringify(['T001', 'T002', 'T003']));
    expect(call.id).toMatch(/^P-/);
    expect(result).toBeDefined();
  });
});

describe('updatePatternStats', () => {
  it('returns null for non-existent pattern', async () => {
    const brainAccessor = mockBrainAccessor();

    const result = await updatePatternStats('P-nonexistent', true, brainAccessor);

    expect(result).toBeNull();
  });

  it('increments frequency and recalculates success rate on success', async () => {
    const existing = makePattern({
      id: 'P-001',
      frequency: 4,
      successRate: 0.75,
    });
    const brainAccessor = mockBrainAccessor([existing]);

    const result = await updatePatternStats('P-001', true, brainAccessor);

    expect(result).not.toBeNull();
    expect(result!.patternId).toBe('P-001');
    expect(result!.newFrequency).toBe(5);
    expect(result!.outcomeSuccess).toBe(true);
    // New rate = (0.75 * 4 + 1) / 5 = 4.0 / 5 = 0.8
    expect(result!.newSuccessRate).toBe(0.8);

    expect(brainAccessor.updatePattern).toHaveBeenCalledWith('P-001', {
      frequency: 5,
      successRate: 0.8,
    });
  });

  it('decreases success rate on failure outcome', async () => {
    const existing = makePattern({
      id: 'P-002',
      frequency: 4,
      successRate: 0.75,
    });
    const brainAccessor = mockBrainAccessor([existing]);

    const result = await updatePatternStats('P-002', false, brainAccessor);

    expect(result!.newFrequency).toBe(5);
    // New rate = (0.75 * 4 + 0) / 5 = 3.0 / 5 = 0.6
    expect(result!.newSuccessRate).toBe(0.6);
    expect(result!.outcomeSuccess).toBe(false);
  });

  it('handles null success rate by defaulting to 0.5', async () => {
    const existing = makePattern({
      id: 'P-003',
      frequency: 1,
      successRate: null,
    });
    const brainAccessor = mockBrainAccessor([existing]);

    const result = await updatePatternStats('P-003', true, brainAccessor);

    expect(result!.newFrequency).toBe(2);
    // New rate = (0.5 * 1 + 1) / 2 = 1.5 / 2 = 0.75
    expect(result!.newSuccessRate).toBe(0.75);
  });
});
