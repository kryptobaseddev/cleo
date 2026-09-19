import { beforeEach, describe, expect, it, vi } from 'vitest';

const { observeBrainMock, refreshMock } = vi.hoisted(() => ({
  observeBrainMock: vi.fn(),
  refreshMock: vi.fn(),
}));
vi.mock('../../../memory/brain-retrieval.js', () => ({ observeBrain: observeBrainMock }));
vi.mock('../memory-bridge-refresh.js', () => ({ maybeRefreshMemoryBridge: refreshMock }));

import { handleToolComplete, handleToolStart } from '../task-hooks.js';

describe('task hook handlers', () => {
  beforeEach(() => {
    observeBrainMock.mockReset();
    refreshMock.mockReset();
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
});
