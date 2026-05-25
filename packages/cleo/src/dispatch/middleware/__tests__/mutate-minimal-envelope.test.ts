/**
 * Unit tests for the minimal mutate envelope middleware
 * (T9931 / Saga T9855 / E9.4).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { setFieldContext } from '../../../cli/field-context.js';
import { resetProjectionOptOut, setProjectionOptOut } from '../../../cli/projection-context.js';
import type { DispatchRequest, DispatchResponse } from '../../types.js';
import { createMutateMinimalEnvelope } from '../mutate-minimal-envelope.js';

const FULL_TASK = {
  id: 'T9931',
  title: 'Minimal mutate envelopes',
  description: 'Verbose body that the middleware should strip.',
  status: 'pending' as const,
  priority: 'high' as const,
  type: 'task',
  parentId: 'T9927',
  acceptance: ['ac1', 'ac2'],
  verification: { passed: false, round: 1 },
};

function makeRequest(
  domain: string,
  operation: string,
  params?: Record<string, unknown>,
): DispatchRequest {
  return {
    gateway: 'mutate',
    domain,
    operation,
    params,
    source: 'cli',
    requestId: 'req-1',
  };
}

function makeSuccessResponse(
  operation: string,
  data: unknown,
  metaExtra?: Record<string, unknown>,
): DispatchResponse {
  return {
    meta: {
      gateway: 'mutate',
      domain: 'tasks',
      operation,
      timestamp: '2026-05-24T00:00:00.000Z',
      duration_ms: 1,
      source: 'cli',
      requestId: 'req-1',
      ...metaExtra,
    },
    success: true,
    data,
  };
}

describe('createMutateMinimalEnvelope middleware', () => {
  beforeEach(() => {
    resetProjectionOptOut();
    setFieldContext({ mvi: 'minimal', mviSource: 'default', expectsCustomMvi: false });
  });

  // ---------------------------------------------------------------------
  // Each of the 5 mutate ops returns minimal shape by default
  // ---------------------------------------------------------------------

  it('tasks.add — returns {count, ids[], status} by default', async () => {
    const mw = createMutateMinimalEnvelope();
    const req = makeRequest('tasks', 'add', { title: 'x' });
    const response = await mw(req, async () =>
      makeSuccessResponse('add', {
        task: FULL_TASK,
        duplicate: false,
        createdIds: { tasks: ['T9931'], acceptanceCriteria: ['ac-child', 'ac-parent'] },
      }),
    );
    const data = response.data as Record<string, unknown>;
    expect(data['count']).toBe(1);
    expect(data['created']).toEqual(['T9931']);
    expect(data['updated']).toEqual([]);
    expect(data['deleted']).toEqual([]);
    expect(data['ids']).toEqual(['T9931']);
    expect(data['fieldPathHints']).toMatchObject({
      '/data/ids/0': expect.stringContaining('deprecated'),
    });
    expect(data['status']).toBe('pending');
    expect(data['acceptanceCriteriaIds']).toEqual(['ac-child', 'ac-parent']);
    expect(data['task']).toBeUndefined();
    expect(data['description']).toBeUndefined();
    expect(response.meta.mutateProjection).toBe('mvi');
  });

  it('tasks.add-batch — returns {count, ids[]} for the entire batch', async () => {
    const mw = createMutateMinimalEnvelope();
    const req = makeRequest('tasks', 'add-batch', { tasks: [{ title: 'a' }, { title: 'b' }] });
    const response = await mw(req, async () =>
      makeSuccessResponse('add-batch', {
        created: 2,
        tasks: [{ task: { id: 'T100', title: 'a' } }, { task: { id: 'T101', title: 'b' } }],
      }),
    );
    const data = response.data as Record<string, unknown>;
    expect(data['count']).toBe(2);
    expect(data['created']).toEqual(['T100', 'T101']);
    expect(data['ids']).toEqual(['T100', 'T101']);
    expect(data['tasks']).toBeUndefined();
    expect(response.meta.mutateProjection).toBe('mvi');
  });

  it('tasks.update — returns {count, ids[], changes, status}', async () => {
    const mw = createMutateMinimalEnvelope();
    const req = makeRequest('tasks', 'update', { taskId: 'T9931', title: 'new' });
    const response = await mw(req, async () =>
      makeSuccessResponse('update', { task: FULL_TASK, changes: ['title'] }),
    );
    const data = response.data as Record<string, unknown>;
    expect(data['count']).toBe(1);
    expect(data['updated']).toEqual(['T9931']);
    expect(data['ids']).toEqual(['T9931']);
    expect(data['changes']).toEqual(['title']);
    expect(data['status']).toBe('pending');
    expect(data['task']).toBeUndefined();
    expect(response.meta.mutateProjection).toBe('mvi');
  });

  it('tasks.complete — returns {count, ids[], status, completedAt}', async () => {
    const mw = createMutateMinimalEnvelope();
    const req = makeRequest('tasks', 'complete', { taskId: 'T9931' });
    const completedTask = {
      ...FULL_TASK,
      status: 'completed' as const,
      completedAt: '2026-05-24T00:00:00.000Z',
    };
    const response = await mw(req, async () =>
      makeSuccessResponse('complete', { task: completedTask }),
    );
    const data = response.data as Record<string, unknown>;
    expect(data['count']).toBe(1);
    expect(data['updated']).toEqual(['T9931']);
    expect(data['ids']).toEqual(['T9931']);
    expect(data['status']).toBe('completed');
    expect(data['completedAt']).toBe('2026-05-24T00:00:00.000Z');
    expect(data['task']).toBeUndefined();
    expect(response.meta.mutateProjection).toBe('mvi');
  });

  it('tasks.delete — returns {count, ids[], status}', async () => {
    const mw = createMutateMinimalEnvelope();
    const req = makeRequest('tasks', 'delete', { taskId: 'T9931' });
    const response = await mw(req, async () =>
      makeSuccessResponse('delete', { deletedTask: FULL_TASK }),
    );
    const data = response.data as Record<string, unknown>;
    expect(data['count']).toBe(1);
    expect(data['deleted']).toEqual(['T9931']);
    expect(data['ids']).toEqual(['T9931']);
    expect(data['status']).toBe('pending');
    expect(data['deletedTask']).toBeUndefined();
    expect(response.meta.mutateProjection).toBe('mvi');
  });

  // ---------------------------------------------------------------------
  // --full / --verbose / --human opt-out restores full shape
  // ---------------------------------------------------------------------

  it('--full opt-out (global) restores the full record for every mutate op', async () => {
    setProjectionOptOut(true);
    const mw = createMutateMinimalEnvelope();

    for (const op of ['add', 'update', 'complete'] as const) {
      const req = makeRequest('tasks', op);
      const response = await mw(req, async () =>
        makeSuccessResponse(op, { task: FULL_TASK, changes: ['title'] }),
      );
      const data = response.data as Record<string, unknown>;
      const task = data['task'] as Record<string, unknown>;
      expect(task).toBeDefined();
      expect(task['description']).toBe(FULL_TASK.description);
      expect(task['verification']).toEqual(FULL_TASK.verification);
      expect(response.meta.mutateProjection).toBe('full');
    }
  });

  it('honours a per-request _projection override even when the global flag is set', async () => {
    setProjectionOptOut(true);
    const mw = createMutateMinimalEnvelope();
    const req = makeRequest('tasks', 'add', { _projection: 'mvi' });
    const response = await mw(req, async () =>
      makeSuccessResponse('add', { task: FULL_TASK, duplicate: false }),
    );
    const data = response.data as Record<string, unknown>;
    expect(data['count']).toBe(1);
    expect(data['ids']).toEqual(['T9931']);
    expect(data['task']).toBeUndefined();
    expect(response.meta.mutateProjection).toBe('mvi');
  });

  it('prevalidates projected --field paths before invoking the mutation', async () => {
    setFieldContext({
      mvi: 'minimal',
      mviSource: 'default',
      expectsCustomMvi: false,
      field: '/data/task/id',
    });
    const mw = createMutateMinimalEnvelope();
    const req = makeRequest('tasks', 'add', { title: 'x' });
    let wrote = false;
    const response = await mw(req, async () => {
      wrote = true;
      return makeSuccessResponse('add', { task: FULL_TASK, duplicate: false });
    });

    expect(wrote).toBe(false);
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('E_FIELD_NOT_FOUND');
    expect(response.error?.details).toMatchObject({
      phase: 'prewrite-field-projection-validation',
    });
  });

  it('allows deprecated /data/ids/0 field paths through to the projected envelope', async () => {
    setFieldContext({
      mvi: 'minimal',
      mviSource: 'default',
      expectsCustomMvi: false,
      field: '/data/ids/0',
    });
    const mw = createMutateMinimalEnvelope();
    const req = makeRequest('tasks', 'add', { title: 'x' });
    const response = await mw(req, async () =>
      makeSuccessResponse('add', { task: FULL_TASK, duplicate: false }),
    );
    const data = response.data as Record<string, unknown>;

    expect(response.success).toBe(true);
    expect(data['ids']).toEqual(['T9931']);
    expect(data['fieldPathHints']).toMatchObject({
      '/data/ids/0': expect.stringContaining('deprecated'),
    });
  });

  // ---------------------------------------------------------------------
  // Meta preservation
  // ---------------------------------------------------------------------

  it('preserves meta.suggestedNext set by the upstream handler (T9921)', async () => {
    const mw = createMutateMinimalEnvelope();
    const req = makeRequest('tasks', 'add', { title: 'x' });
    const response = await mw(req, async () =>
      makeSuccessResponse(
        'add',
        { task: FULL_TASK, duplicate: false },
        { suggestedNext: ['cleo show T9931', 'cleo verify T9931'] },
      ),
    );
    expect(response.meta.suggestedNext).toEqual(['cleo show T9931', 'cleo verify T9931']);
    expect(response.meta.mutateProjection).toBe('mvi');
  });

  // ---------------------------------------------------------------------
  // Ops with no plan are passed through untouched
  // ---------------------------------------------------------------------

  it('does not project ops absent from MUTATE_PROJECTION_PLANS', async () => {
    const mw = createMutateMinimalEnvelope();
    const req = makeRequest('tasks', 'archive', { taskIds: ['T9931'] });
    const response = await mw(req, async () =>
      makeSuccessResponse('archive', { archivedIds: ['T9931'], count: 1 }),
    );
    const data = response.data as Record<string, unknown>;
    // Original shape preserved — no `count`/`ids` rewrite.
    expect(data['archivedIds']).toEqual(['T9931']);
    expect(response.meta.mutateProjection).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // Error responses still get the projection stamp
  // ---------------------------------------------------------------------

  it('stamps meta.mutateProjection on error envelopes too', async () => {
    const mw = createMutateMinimalEnvelope();
    const req = makeRequest('tasks', 'add', { title: 'x' });
    const errResponse: DispatchResponse = {
      meta: {
        gateway: 'mutate',
        domain: 'tasks',
        operation: 'add',
        timestamp: '2026-05-24T00:00:00.000Z',
        duration_ms: 1,
        source: 'cli',
        requestId: 'req-1',
      },
      success: false,
      error: { code: 'E_VALIDATION', message: 'bad input' },
    };
    const response = await mw(req, async () => errResponse);
    expect(response.meta.mutateProjection).toBe('mvi');
    expect(response.success).toBe(false);
  });
});
