import { beforeEach, describe, expect, it, vi } from 'vitest';

const { observeBrainMock, refreshMock, correlateMock } = vi.hoisted(() => ({
  observeBrainMock: vi.fn(),
  refreshMock: vi.fn(),
  correlateMock: vi.fn(),
}));
vi.mock('../../../memory/brain-retrieval.js', () => ({ observeBrain: observeBrainMock }));
vi.mock('../../../memory/quality-feedback.js', () => ({ correlateOutcomes: correlateMock }));
vi.mock('../memory-bridge-refresh.js', () => ({ maybeRefreshMemoryBridge: refreshMock }));

import { handleToolComplete, handleToolStart } from '../task-hooks.js';

describe('task hook handlers', () => {
  beforeEach(() => {
    observeBrainMock.mockReset();
    refreshMock.mockReset();
    correlateMock.mockReset();
  });
  it('does not turn task start into a content-free observation', async () => {
    await handleToolStart('/tmp/project', {
      taskId: 'T5375',
      taskTitle: 'Add test coverage',
      timestamp: '2026-03-05T00:00:00.000Z',
    });
    expect(observeBrainMock).not.toHaveBeenCalled();
  });
  it('keeps completion metadata out of memory and refreshes the bridge', async () => {
    await handleToolComplete('/tmp/project', {
      taskId: 'T5375',
      taskTitle: 'Add test coverage',
      status: 'done',
      timestamp: '2026-03-05T00:30:00.000Z',
    });
    expect(observeBrainMock).not.toHaveBeenCalled();
    expect(refreshMock).toHaveBeenCalledWith('/tmp/project');
  });
  it('does not finish dispatch while correlation remains pending', async () => {
    const gate = Promise.withResolvers<void>();
    correlateMock.mockReturnValue(gate.promise);
    let settled = false;
    const dispatch = handleToolComplete('/tmp/project', {
      taskId: 'T1',
      taskTitle: 'Scope',
      status: 'done',
      timestamp: '2026-09-19T00:00:00Z',
    }).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(correlateMock).toHaveBeenCalledWith('/tmp/project'));
    expect(settled).toBe(false);
    expect(refreshMock).not.toHaveBeenCalled();
    gate.resolve();
    await dispatch;
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it('surfaces correlation failure to the registry while retaining bridge refresh', async () => {
    const failure = new Error('correlation failed');
    correlateMock.mockRejectedValue(failure);
    await expect(
      handleToolComplete('/tmp/project', {
        taskId: 'T1',
        taskTitle: 'Scope',
        status: 'done',
        timestamp: '2026-09-19T00:00:00Z',
      }),
    ).rejects.toBe(failure);
    expect(refreshMock).toHaveBeenCalledOnce();
  });
});
