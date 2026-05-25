/**
 * Unit tests for minimal mutate envelope projection (T9931 / Saga T9855 / E9.4).
 *
 * Verifies the per-op extractors, the dispatch-level routing table, and the
 * defensive fallback when an extractor cannot find any ID.
 */

import { describe, expect, it } from 'vitest';
import { applyMutateProjection, MUTATE_PROJECTION_PLANS } from '../mutate-projection.js';

const FULL_TASK = {
  id: 'T9931',
  title: 'Minimal mutate envelopes',
  description: 'Verbose body — should be stripped under MVI.',
  status: 'pending',
  priority: 'high',
  type: 'task',
  parentId: 'T9927',
  acceptance: ['ac1', 'ac2'],
  verification: { passed: false, round: 1 },
  createdAt: '2026-05-21T16:31:48.186Z',
  labels: ['e9'],
} as const;

describe('MUTATE_PROJECTION_PLANS — SSoT for mutate ops', () => {
  it('declares plans for the 5 T9931 mutate ops', () => {
    expect(MUTATE_PROJECTION_PLANS['tasks.add']).toBeDefined();
    expect(MUTATE_PROJECTION_PLANS['tasks.add-batch']).toBeDefined();
    expect(MUTATE_PROJECTION_PLANS['tasks.update']).toBeDefined();
    expect(MUTATE_PROJECTION_PLANS['tasks.complete']).toBeDefined();
    expect(MUTATE_PROJECTION_PLANS['tasks.delete']).toBeDefined();
  });

  it('does not project read ops', () => {
    expect(MUTATE_PROJECTION_PLANS['tasks.show']).toBeUndefined();
    expect(MUTATE_PROJECTION_PLANS['tasks.list']).toBeUndefined();
    expect(MUTATE_PROJECTION_PLANS['tasks.find']).toBeUndefined();
  });
});

describe('applyMutateProjection — full mode is always a no-op', () => {
  it('returns the original data ref under full mode', () => {
    const data = { task: FULL_TASK, duplicate: false };
    expect(applyMutateProjection(data, 'tasks.add', 'full')).toBe(data);
  });
});

describe('applyMutateProjection — tasks.add', () => {
  it('extracts {count, ids, status}', () => {
    const data = { task: FULL_TASK, duplicate: false };
    const out = applyMutateProjection(data, 'tasks.add', 'mvi') as Record<string, unknown>;
    expect(out['count']).toBe(1);
    expect(out['created']).toEqual(['T9931']);
    expect(out['updated']).toEqual([]);
    expect(out['deleted']).toEqual([]);
    expect(out['ids']).toEqual(['T9931']);
    expect(out['fieldPathHints']).toMatchObject({
      '/data/ids/0': expect.stringContaining('deprecated'),
    });
    expect(out['status']).toBe('pending');
    // Verbose fields stripped:
    expect(out['title']).toBeUndefined();
    expect(out['description']).toBeUndefined();
    expect(out['acceptance']).toBeUndefined();
    expect(out['task']).toBeUndefined();
  });

  it('stamps duplicate: true when the core op flagged it', () => {
    const data = { task: FULL_TASK, duplicate: true };
    const out = applyMutateProjection(data, 'tasks.add', 'mvi') as Record<string, unknown>;
    expect(out['duplicate']).toBe(true);
  });

  it('stamps dryRun: true on dry-run path', () => {
    const data = { task: FULL_TASK, duplicate: false, dryRun: true };
    const out = applyMutateProjection(data, 'tasks.add', 'mvi') as Record<string, unknown>;
    expect(out['dryRun']).toBe(true);
  });

  it('falls back to original data when the task id is missing', () => {
    const data = { task: { title: 'nope' }, duplicate: false };
    // No id → envelope would be {count:0, ids:[]} → caller sees full payload
    expect(applyMutateProjection(data, 'tasks.add', 'mvi')).toBe(data);
  });
});

describe('applyMutateProjection — tasks.add-batch', () => {
  it('aggregates {count, ids[]} across the batch', () => {
    const data = {
      created: 3,
      tasks: [
        { task: { id: 'T100', title: 'a' } },
        { task: { id: 'T101', title: 'b' } },
        { task: { id: 'T102', title: 'c' } },
      ],
    };
    const out = applyMutateProjection(data, 'tasks.add-batch', 'mvi') as Record<string, unknown>;
    expect(out['count']).toBe(3);
    expect(out['created']).toEqual(['T100', 'T101', 'T102']);
    expect(out['updated']).toEqual([]);
    expect(out['deleted']).toEqual([]);
    expect(out['ids']).toEqual(['T100', 'T101', 'T102']);
    expect(out['tasks']).toBeUndefined();
  });

  it('reflects dryRun in the envelope', () => {
    const data = {
      created: 0,
      dryRun: true,
      tasks: [{ task: { id: 'T???' } }, { task: { id: 'T???' } }],
    };
    const out = applyMutateProjection(data, 'tasks.add-batch', 'mvi') as Record<string, unknown>;
    expect(out['dryRun']).toBe(true);
    expect(out['ids']).toEqual(['T???', 'T???']);
  });

  it('handles entries with an inline id (no `task` wrapper)', () => {
    const data = { created: 2, tasks: [{ id: 'T200' }, { id: 'T201' }] };
    const out = applyMutateProjection(data, 'tasks.add-batch', 'mvi') as Record<string, unknown>;
    expect(out['count']).toBe(2);
    expect(out['ids']).toEqual(['T200', 'T201']);
  });

  it('falls back to original data when nothing parseable is present', () => {
    const data = { created: 0, tasks: [] };
    // No ids → fallback so the caller sees the original shape and can debug.
    expect(applyMutateProjection(data, 'tasks.add-batch', 'mvi')).toBe(data);
  });
});

describe('applyMutateProjection — tasks.update', () => {
  it('extracts {count, ids, changes, status}', () => {
    const data = { task: FULL_TASK, changes: ['title', 'priority'] };
    const out = applyMutateProjection(data, 'tasks.update', 'mvi') as Record<string, unknown>;
    expect(out['count']).toBe(1);
    expect(out['created']).toEqual([]);
    expect(out['updated']).toEqual(['T9931']);
    expect(out['deleted']).toEqual([]);
    expect(out['ids']).toEqual(['T9931']);
    expect(out['changes']).toEqual(['title', 'priority']);
    expect(out['status']).toBe('pending');
    expect(out['task']).toBeUndefined();
    expect(out['description']).toBeUndefined();
  });
});

describe('applyMutateProjection — tasks.complete', () => {
  it('extracts {count, ids, status, completedAt}', () => {
    const completedTask = {
      ...FULL_TASK,
      status: 'completed',
      completedAt: '2026-05-24T00:00:00.000Z',
    };
    const data = { task: completedTask };
    const out = applyMutateProjection(data, 'tasks.complete', 'mvi') as Record<string, unknown>;
    expect(out['count']).toBe(1);
    expect(out['created']).toEqual([]);
    expect(out['updated']).toEqual(['T9931']);
    expect(out['deleted']).toEqual([]);
    expect(out['ids']).toEqual(['T9931']);
    expect(out['status']).toBe('completed');
    expect(out['completedAt']).toBe('2026-05-24T00:00:00.000Z');
    expect(out['task']).toBeUndefined();
  });

  it('attaches autoCompleted when non-empty', () => {
    const data = { task: FULL_TASK, autoCompleted: ['T9932', 'T9933'] };
    const out = applyMutateProjection(data, 'tasks.complete', 'mvi') as Record<string, unknown>;
    expect(out['autoCompleted']).toEqual(['T9932', 'T9933']);
  });
});

describe('applyMutateProjection — tasks.delete', () => {
  it('extracts {count, ids} from deletedTask wrapper', () => {
    const data = { deletedTask: FULL_TASK };
    const out = applyMutateProjection(data, 'tasks.delete', 'mvi') as Record<string, unknown>;
    expect(out['count']).toBe(1);
    expect(out['created']).toEqual([]);
    expect(out['updated']).toEqual([]);
    expect(out['deleted']).toEqual(['T9931']);
    expect(out['ids']).toEqual(['T9931']);
    expect(out['deletedTask']).toBeUndefined();
  });

  it('rolls cascadeDeleted ids into the envelope', () => {
    const data = { deletedTask: FULL_TASK, cascadeDeleted: ['T1', 'T2'] };
    const out = applyMutateProjection(data, 'tasks.delete', 'mvi') as Record<string, unknown>;
    expect(out['count']).toBe(3);
    expect(out['deleted']).toEqual(['T9931', 'T1', 'T2']);
    expect(out['ids']).toEqual(['T9931', 'T1', 'T2']);
    expect(out['cascadeDeleted']).toEqual(['T1', 'T2']);
  });
});

describe('applyMutateProjection — unknown ops + edge cases', () => {
  it('returns data unchanged when the op has no plan', () => {
    const data = { task: FULL_TASK };
    expect(applyMutateProjection(data, 'tasks.archive', 'mvi')).toBe(data);
    expect(applyMutateProjection(data, 'memory.observe', 'mvi')).toBe(data);
  });

  it('passes through null / undefined / primitive data', () => {
    expect(applyMutateProjection(null, 'tasks.add', 'mvi')).toBeNull();
    expect(applyMutateProjection(undefined, 'tasks.add', 'mvi')).toBeUndefined();
    expect(applyMutateProjection(42, 'tasks.add', 'mvi')).toBe(42);
  });
});
