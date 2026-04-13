import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  maybeRefreshMemoryBridge: vi.fn(),
  gradeSession: vi.fn(),
  loadConfig: vi.fn(),
}));

vi.mock('../memory-bridge-refresh.js', () => ({
  maybeRefreshMemoryBridge: mocks.maybeRefreshMemoryBridge,
}));

vi.mock('../../../sessions/session-grade.js', () => ({
  gradeSession: mocks.gradeSession,
}));

vi.mock('../../../config.js', () => ({
  loadConfig: mocks.loadConfig,
}));

import { handleSessionEnd, handleSessionStart } from '../session-hooks.js';

describe('session hook handlers', () => {
  beforeEach(() => {
    mocks.maybeRefreshMemoryBridge.mockReset();
    mocks.maybeRefreshMemoryBridge.mockResolvedValue(undefined);
    mocks.gradeSession.mockResolvedValue(undefined);
    mocks.loadConfig.mockResolvedValue({ brain: { autoCapture: false } });
  });

  it('handleSessionStart refreshes the memory bridge', async () => {
    await handleSessionStart('/tmp/project', {
      sessionId: 'ses-1',
      timestamp: '2026-03-04T00:00:00.000Z',
      name: 'Test Session',
      scope: 'T5306',
    });

    expect(mocks.maybeRefreshMemoryBridge).toHaveBeenCalledTimes(1);
    expect(mocks.maybeRefreshMemoryBridge).toHaveBeenCalledWith('/tmp/project');
  });

  it('handleSessionEnd refreshes the memory bridge', async () => {
    await handleSessionEnd('/tmp/project', {
      sessionId: 'ses-2',
      timestamp: '2026-03-04T00:30:00.000Z',
      duration: 1800,
      tasksCompleted: ['T5306', 'T5307'],
    });

    expect(mocks.maybeRefreshMemoryBridge).toHaveBeenCalledTimes(1);
    expect(mocks.maybeRefreshMemoryBridge).toHaveBeenCalledWith('/tmp/project');
  });

  it('handleSessionEnd resolves normally with no tasks', async () => {
    await expect(
      handleSessionEnd('/tmp/project', {
        sessionId: 'ses-3',
        timestamp: '2026-03-04T00:30:00.000Z',
        duration: 900,
        tasksCompleted: [],
      }),
    ).resolves.toBeUndefined();
  });
});
