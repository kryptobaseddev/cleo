import { beforeEach, describe, expect, it, vi } from 'vitest';

const observeBrainMock = vi.fn();

vi.mock('../../../../core/memory/brain-retrieval.js', () => ({
  observeBrain: observeBrainMock,
}));

import { handleToolComplete, handleToolStart } from '../task-hooks.js';

describe('task hook handlers', () => {
  beforeEach(() => {
    observeBrainMock.mockReset();
  });

  it('handleToolStart calls observeBrain with task ID and title', async () => {
    observeBrainMock.mockResolvedValue(undefined);

    await handleToolStart('/tmp/project', {
      taskId: 'T5375',
      taskTitle: 'Add test coverage',
      timestamp: '2026-03-05T00:00:00.000Z',
    });

    expect(observeBrainMock).toHaveBeenCalledTimes(1);
    expect(observeBrainMock).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({
        text: 'Started work on T5375: Add test coverage',
        title: 'Task start: T5375',
        type: 'change',
        sourceType: 'agent',
      }),
    );
  });

  it('handleToolStart swallows brain schema missing error', async () => {
    observeBrainMock.mockRejectedValue(
      new Error('SQLITE_ERROR: no such table: brain_observations'),
    );

    await expect(
      handleToolStart('/tmp/project', {
        taskId: 'T5375',
        taskTitle: 'Add test coverage',
        timestamp: '2026-03-05T00:00:00.000Z',
      }),
    ).resolves.toBeUndefined();
  });

  it('handleToolStart rethrows non-schema errors', async () => {
    observeBrainMock.mockRejectedValue(new Error('database is locked'));

    await expect(
      handleToolStart('/tmp/project', {
        taskId: 'T5375',
        taskTitle: 'Add test coverage',
        timestamp: '2026-03-05T00:00:00.000Z',
      }),
    ).rejects.toThrow('database is locked');
  });

  it('handleToolComplete calls observeBrain with task ID and status', async () => {
    observeBrainMock.mockResolvedValue(undefined);

    await handleToolComplete('/tmp/project', {
      taskId: 'T5375',
      taskTitle: 'Add test coverage',
      status: 'done',
      timestamp: '2026-03-05T00:30:00.000Z',
    });

    expect(observeBrainMock).toHaveBeenCalledTimes(1);
    expect(observeBrainMock).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({
        text: 'Task T5375 completed with status: done',
        title: 'Task complete: T5375',
        type: 'change',
        sourceType: 'agent',
      }),
    );
  });

  it('handleToolComplete swallows brain schema missing error', async () => {
    observeBrainMock.mockRejectedValue(new Error('no such table: brain_decisions'));

    await expect(
      handleToolComplete('/tmp/project', {
        taskId: 'T5375',
        taskTitle: 'Add test coverage',
        status: 'done',
        timestamp: '2026-03-05T00:30:00.000Z',
      }),
    ).resolves.toBeUndefined();
  });

  it('handleToolComplete rethrows non-schema errors', async () => {
    observeBrainMock.mockRejectedValue(new Error('disk full'));

    await expect(
      handleToolComplete('/tmp/project', {
        taskId: 'T5375',
        taskTitle: 'Add test coverage',
        status: 'done',
        timestamp: '2026-03-05T00:30:00.000Z',
      }),
    ).rejects.toThrow('disk full');
  });
});
