import { beforeEach, describe, expect, it, vi } from 'vitest';

const observeBrainMock = vi.fn();

vi.mock('../../../memory/brain-retrieval.js', () => ({
  observeBrain: observeBrainMock,
}));

import { handleError } from '../error-hooks.js';

describe('error hook handlers', () => {
  beforeEach(() => {
    observeBrainMock.mockReset();
  });

  it('calls observeBrain with error details', async () => {
    observeBrainMock.mockResolvedValue(undefined);

    await handleError('/tmp/project', {
      timestamp: '2026-03-04T00:00:00.000Z',
      errorCode: 42,
      message: 'Validation failed',
      domain: 'tasks',
      operation: 'add',
      gateway: 'mutate',
    });

    expect(observeBrainMock).toHaveBeenCalledTimes(1);
    expect(observeBrainMock).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({
        text: expect.stringContaining('Error in tasks.add'),
        title: 'Error: tasks.add',
        type: 'discovery',
        sourceType: 'agent',
      }),
    );
    // Verify error details are in the text
    const callText = observeBrainMock.mock.calls[0][1].text as string;
    expect(callText).toContain('Validation failed');
    expect(callText).toContain('Code: 42');
    expect(callText).toContain('Gateway: mutate');
  });

  it('swallows brain schema missing error', async () => {
    observeBrainMock.mockRejectedValue(
      new Error('SQLITE_ERROR: no such table: brain_observations'),
    );

    await expect(
      handleError('/tmp/project', {
        timestamp: '2026-03-04T00:00:00.000Z',
        errorCode: 1,
        message: 'Something broke',
        domain: 'tasks',
        operation: 'show',
      }),
    ).resolves.toBeUndefined();
  });

  it('skips observation when _fromHook flag is set', async () => {
    await handleError('/tmp/project', {
      timestamp: '2026-03-04T00:00:00.000Z',
      errorCode: 1,
      message: 'Hook-triggered error',
      domain: 'memory',
      operation: 'observe',
      metadata: { _fromHook: true },
    });

    expect(observeBrainMock).not.toHaveBeenCalled();
  });

  it('includes domain/operation in observation text', async () => {
    observeBrainMock.mockResolvedValue(undefined);

    await handleError('/tmp/project', {
      timestamp: '2026-03-04T00:00:00.000Z',
      errorCode: 'E_NOT_FOUND',
      message: 'Task not found',
      domain: 'tasks',
      operation: 'show',
    });

    const callText = observeBrainMock.mock.calls[0][1].text as string;
    expect(callText).toContain('tasks.show');
    expect(callText).toContain('E_NOT_FOUND');
  });

  it('uses "unknown" when domain/operation are absent', async () => {
    observeBrainMock.mockResolvedValue(undefined);

    await handleError('/tmp/project', {
      timestamp: '2026-03-04T00:00:00.000Z',
      errorCode: 1,
      message: 'Something broke',
    });

    expect(observeBrainMock).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({
        title: 'Error: unknown',
      }),
    );
  });

  it('rethrows non-schema errors', async () => {
    observeBrainMock.mockRejectedValue(new Error('database is locked'));

    await expect(
      handleError('/tmp/project', {
        timestamp: '2026-03-04T00:00:00.000Z',
        errorCode: 1,
        message: 'Something broke',
        domain: 'tasks',
        operation: 'add',
      }),
    ).rejects.toThrow('database is locked');
  });
});
