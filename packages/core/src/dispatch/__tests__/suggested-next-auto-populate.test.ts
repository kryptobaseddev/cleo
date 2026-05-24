/**
 * Unit tests for the per-op `suggestedNext` builders introduced in T9921.
 *
 * Each builder is a pure `(params, data) => string[]`. The dispatch layer
 * calls them on every successful tasks.* mutate/find op and stamps the
 * result onto `DispatchResponse.meta.suggestedNext`. Asserting the pure
 * function output here keeps the test free of the cleo dispatch
 * infrastructure; integration coverage of the wiring lives in
 * `packages/cleo/src/dispatch/domains/__tests__/`.
 *
 * @epic T9919
 * @task T9921
 * @saga T9855
 */

import { describe, expect, it } from 'vitest';
import {
  buildTasksAddBatchSuggestedNext,
  buildTasksAddSuggestedNext,
  buildTasksCompleteSuggestedNext,
  buildTasksFindSuggestedNext,
  buildTasksUpdateSuggestedNext,
  TASKS_SUGGESTED_NEXT_BUILDERS,
} from '../suggested-next.js';

describe('buildTasksAddSuggestedNext (T9921)', () => {
  it('interpolates the created task id into both suggestions', () => {
    const out = buildTasksAddSuggestedNext({}, { task: { id: 'T1234' } });
    expect(out).toEqual(['cleo show T1234', 'cleo focus T1234']);
  });

  it('returns [] when result has no task id', () => {
    expect(buildTasksAddSuggestedNext({}, undefined)).toEqual([]);
    expect(buildTasksAddSuggestedNext({}, {})).toEqual([]);
    expect(buildTasksAddSuggestedNext({}, { task: {} })).toEqual([]);
  });

  it('returns [] when task id is empty string', () => {
    expect(buildTasksAddSuggestedNext({}, { task: { id: '' } })).toEqual([]);
  });
});

describe('buildTasksAddBatchSuggestedNext (T9921)', () => {
  it('returns 2 entries referencing the defaultParent param', () => {
    const out = buildTasksAddBatchSuggestedNext({ defaultParent: 'T9999' }, {});
    expect(out).toEqual(['cleo list --parent T9999', 'cleo orchestrate ready --epic T9999']);
  });

  it('returns [] when defaultParent is absent', () => {
    expect(buildTasksAddBatchSuggestedNext({}, {})).toEqual([]);
  });

  it('returns [] when defaultParent is empty string', () => {
    expect(buildTasksAddBatchSuggestedNext({ defaultParent: '' }, {})).toEqual([]);
  });

  it('returns [] when defaultParent is not a string', () => {
    expect(buildTasksAddBatchSuggestedNext({ defaultParent: 42 }, {})).toEqual([]);
  });
});

describe('buildTasksUpdateSuggestedNext (T9921)', () => {
  it('interpolates the updated task id', () => {
    const out = buildTasksUpdateSuggestedNext({}, { task: { id: 'T555' } });
    expect(out).toEqual(['cleo show T555']);
  });

  it('returns [] when result has no task id', () => {
    expect(buildTasksUpdateSuggestedNext({}, {})).toEqual([]);
    expect(buildTasksUpdateSuggestedNext({}, undefined)).toEqual([]);
  });
});

describe('buildTasksCompleteSuggestedNext (T9921)', () => {
  it('emits 2 always-applicable next-step suggestions', () => {
    const out = buildTasksCompleteSuggestedNext({}, { task: { id: 'T42' } });
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('cleo next');
    expect(out[1]).toBe('cleo memory observe "..." --title "..."');
  });

  it('emits the same suggestions even when result payload is empty', () => {
    expect(buildTasksCompleteSuggestedNext({}, undefined)).toEqual([
      'cleo next',
      'cleo memory observe "..." --title "..."',
    ]);
  });
});

describe('buildTasksFindSuggestedNext (T9921)', () => {
  it('returns 2 entries for the first result id', () => {
    const out = buildTasksFindSuggestedNext(
      {},
      {
        results: [{ id: 'T100' }, { id: 'T101' }],
        total: 2,
      },
    );
    expect(out).toEqual(['cleo show T100', 'cleo focus T100']);
  });

  it('returns [] when there are zero results', () => {
    expect(buildTasksFindSuggestedNext({}, { results: [], total: 0 })).toEqual([]);
    expect(buildTasksFindSuggestedNext({}, { results: undefined })).toEqual([]);
    expect(buildTasksFindSuggestedNext({}, undefined)).toEqual([]);
  });

  it('returns [] when first result has no id', () => {
    expect(buildTasksFindSuggestedNext({}, { results: [{}] })).toEqual([]);
  });
});

describe('TASKS_SUGGESTED_NEXT_BUILDERS registry (T9921)', () => {
  it('exposes all 5 tasks.* mutate/find op builders', () => {
    expect(Object.keys(TASKS_SUGGESTED_NEXT_BUILDERS).sort()).toEqual(
      ['add', 'add-batch', 'complete', 'find', 'update'].sort(),
    );
  });

  it('looks up the correct builder by op key', () => {
    expect(TASKS_SUGGESTED_NEXT_BUILDERS['add']).toBe(buildTasksAddSuggestedNext);
    expect(TASKS_SUGGESTED_NEXT_BUILDERS['add-batch']).toBe(buildTasksAddBatchSuggestedNext);
    expect(TASKS_SUGGESTED_NEXT_BUILDERS['update']).toBe(buildTasksUpdateSuggestedNext);
    expect(TASKS_SUGGESTED_NEXT_BUILDERS['complete']).toBe(buildTasksCompleteSuggestedNext);
    expect(TASKS_SUGGESTED_NEXT_BUILDERS['find']).toBe(buildTasksFindSuggestedNext);
  });

  it('returns undefined for unknown ops', () => {
    expect(TASKS_SUGGESTED_NEXT_BUILDERS['delete']).toBeUndefined();
    expect(TASKS_SUGGESTED_NEXT_BUILDERS['unknown']).toBeUndefined();
  });
});
