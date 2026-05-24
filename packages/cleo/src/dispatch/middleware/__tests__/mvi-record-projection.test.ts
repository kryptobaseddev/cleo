/**
 * Unit tests for the MVI record projection middleware
 * (T9922 / Saga T9855 / E8.3).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetProjectionOptOut, setProjectionOptOut } from '../../../cli/projection-context.js';
import type { DispatchRequest, DispatchResponse } from '../../types.js';
import { createMviRecordProjection } from '../mvi-record-projection.js';

const FULL_TASK = {
  id: 'T9922',
  title: 'MVI projection default',
  description: 'Long description that should be stripped under MVI.',
  status: 'pending' as const,
  priority: 'high' as const,
  type: 'task',
  parentId: 'T9919',
  acceptance: ['ac1', 'ac2'],
  verification: { passed: false, round: 1 },
};

function makeRequest(
  domain: string,
  operation: string,
  params?: Record<string, unknown>,
): DispatchRequest {
  return {
    gateway: 'query',
    domain,
    operation,
    params,
    source: 'cli',
    requestId: 'req-1',
  };
}

function makeSuccessResponse(data: unknown): DispatchResponse {
  return {
    meta: {
      gateway: 'query',
      domain: 'tasks',
      operation: 'show',
      timestamp: '2026-05-24T00:00:00.000Z',
      duration_ms: 1,
      source: 'cli',
      requestId: 'req-1',
    },
    success: true,
    data,
  };
}

describe('createMviRecordProjection middleware', () => {
  beforeEach(() => {
    resetProjectionOptOut();
  });

  it('projects tasks.show data.task to MVI under default (no opt-out)', async () => {
    const mw = createMviRecordProjection();
    const req = makeRequest('tasks', 'show', { taskId: 'T9922' });
    const response = await mw(req, async () =>
      makeSuccessResponse({ task: FULL_TASK, view: null, attachments: [] }),
    );
    const data = response.data as { task: Record<string, unknown> };
    expect(data.task['description']).toBeUndefined();
    expect(data.task['verification']).toBeUndefined();
    expect(data.task['acceptance']).toBeUndefined();
    expect(data.task['id']).toBe('T9922');
    expect(data.task['title']).toBe('MVI projection default');
    expect(response.meta.projection).toBe('mvi');
  });

  it('passes data through unchanged when --verbose opt-out is set', async () => {
    setProjectionOptOut(true);
    const mw = createMviRecordProjection();
    const req = makeRequest('tasks', 'show', { taskId: 'T9922' });
    const response = await mw(req, async () =>
      makeSuccessResponse({ task: FULL_TASK, view: null, attachments: [] }),
    );
    const data = response.data as { task: Record<string, unknown> };
    expect(data.task['description']).toBe(FULL_TASK.description);
    expect(data.task['verification']).toEqual(FULL_TASK.verification);
    expect(response.meta.projection).toBe('full');
  });

  it('honours a per-request _projection override even when the global flag is set', async () => {
    setProjectionOptOut(true);
    const mw = createMviRecordProjection();
    const req = makeRequest('tasks', 'show', {
      taskId: 'T9922',
      _projection: 'mvi',
    });
    const response = await mw(req, async () =>
      makeSuccessResponse({ task: FULL_TASK, view: null, attachments: [] }),
    );
    const data = response.data as { task: Record<string, unknown> };
    expect(data.task['description']).toBeUndefined();
    expect(response.meta.projection).toBe('mvi');
    // Override token must be stripped before the handler runs.
    expect(req.params).toBeDefined();
    expect(req.params?.['_projection']).toBeUndefined();
  });

  it('does not project ops absent from PROJECTION_PLANS', async () => {
    const mw = createMviRecordProjection();
    const req = makeRequest('tasks', 'add', { title: 'x' });
    const response = await mw(req, async () =>
      makeSuccessResponse({ id: 'T1', title: 'x', description: 'kept' }),
    );
    const data = response.data as Record<string, unknown>;
    expect(data['description']).toBe('kept');
    // No plan → no projection meta stamp.
    expect(response.meta.projection).toBeUndefined();
  });

  it('projects tasks.list arrays under default', async () => {
    const mw = createMviRecordProjection();
    const req = makeRequest('tasks', 'list');
    const response = await mw(req, async () =>
      makeSuccessResponse({
        tasks: [FULL_TASK, { ...FULL_TASK, id: 'T2' }],
        total: 2,
        filtered: 2,
      }),
    );
    const data = response.data as { tasks: Record<string, unknown>[] };
    expect(data.tasks).toHaveLength(2);
    for (const t of data.tasks) {
      expect(t['description']).toBeUndefined();
      expect(t['id']).toBeDefined();
    }
    expect(response.meta.projection).toBe('mvi');
  });

  it('stamps meta.projection on the response even when the handler returns an error', async () => {
    const mw = createMviRecordProjection();
    const req = makeRequest('tasks', 'show', { taskId: 'T1' });
    const errResponse: DispatchResponse = {
      meta: {
        gateway: 'query',
        domain: 'tasks',
        operation: 'show',
        timestamp: '2026-05-24T00:00:00.000Z',
        duration_ms: 1,
        source: 'cli',
        requestId: 'req-1',
      },
      success: false,
      error: { code: 'E_NOT_FOUND', message: 'no task' },
    };
    const response = await mw(req, async () => errResponse);
    expect(response.meta.projection).toBe('mvi');
    expect(response.success).toBe(false);
  });
});
