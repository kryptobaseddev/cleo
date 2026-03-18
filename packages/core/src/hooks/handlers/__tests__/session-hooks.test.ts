import { beforeEach, describe, expect, it, vi } from 'vitest';

const observeBrainMock = vi.fn();

vi.mock('../../../memory/brain-retrieval.js', () => ({
  observeBrain: observeBrainMock,
}));

import { handleSessionEnd, handleSessionStart } from '../session-hooks.js';

describe('session hook handlers', () => {
  beforeEach(() => {
    observeBrainMock.mockReset();
  });

  it('swallows missing brain schema errors on session start', async () => {
    observeBrainMock.mockRejectedValue(
      new Error('SQLITE_ERROR: no such table: brain_observations'),
    );

    await expect(
      handleSessionStart('/tmp/project', {
        sessionId: 'ses-1',
        timestamp: '2026-03-04T00:00:00.000Z',
        name: 'Test Session',
        scope: 'T5306',
      }),
    ).resolves.toBeUndefined();
  });

  it('swallows missing brain schema errors on session end', async () => {
    observeBrainMock.mockRejectedValue(new Error('no such table: brain_decisions'));

    await expect(
      handleSessionEnd('/tmp/project', {
        sessionId: 'ses-1',
        timestamp: '2026-03-04T00:30:00.000Z',
        duration: 1800,
        tasksCompleted: [],
      }),
    ).resolves.toBeUndefined();
  });

  it('rethrows non-schema errors', async () => {
    observeBrainMock.mockRejectedValue(new Error('database is locked'));

    await expect(
      handleSessionStart('/tmp/project', {
        sessionId: 'ses-1',
        timestamp: '2026-03-04T00:00:00.000Z',
        name: 'Test Session',
        scope: 'T5306',
      }),
    ).rejects.toThrow('database is locked');
  });

  it('records session context when observe succeeds', async () => {
    observeBrainMock.mockResolvedValue(undefined);

    await handleSessionEnd('/tmp/project', {
      sessionId: 'ses-2',
      timestamp: '2026-03-04T00:45:00.000Z',
      duration: 2700,
      tasksCompleted: ['T5306', 'T5307'],
    });

    expect(observeBrainMock).toHaveBeenCalledTimes(1);
    expect(observeBrainMock).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({
        title: 'Session end: ses-2',
        type: 'change',
        sourceSessionId: 'ses-2',
      }),
    );
  });
});
