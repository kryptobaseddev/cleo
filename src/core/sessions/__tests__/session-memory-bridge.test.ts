import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  observeBrain: vi.fn(),
}));

vi.mock('../../memory/brain-retrieval.js', () => ({
  observeBrain: mocks.observeBrain,
}));

import { bridgeSessionToMemory } from '../session-memory-bridge.js';

describe('bridgeSessionToMemory', () => {
  beforeEach(() => {
    mocks.observeBrain.mockReset();
  });

  it('records a session summary observation on success', async () => {
    mocks.observeBrain.mockResolvedValue(undefined);

    await bridgeSessionToMemory('/tmp/project', {
      sessionId: 'session-100',
      scope: 'epic:T5417',
      tasksCompleted: ['T5464', 'T5466'],
      duration: 125,
    });

    expect(mocks.observeBrain).toHaveBeenCalledTimes(1);
    expect(mocks.observeBrain).toHaveBeenCalledWith('/tmp/project', {
      text: 'Session session-100 ended. Scope: epic:T5417. Duration: 2 min. Tasks completed: T5464, T5466.',
      title: 'Session summary: session-100',
      type: 'change',
      sourceSessionId: 'session-100',
      sourceType: 'agent',
    });
  });

  it('uses "none" for empty task completion lists', async () => {
    mocks.observeBrain.mockResolvedValue(undefined);

    await bridgeSessionToMemory('/tmp/project', {
      sessionId: 'session-101',
      scope: 'global',
      tasksCompleted: [],
      duration: 59,
    });

    expect(mocks.observeBrain).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({
        text: 'Session session-101 ended. Scope: global. Duration: 1 min. Tasks completed: none.',
      }),
    );
  });

  it('swallows persistence errors to preserve session-end flow', async () => {
    mocks.observeBrain.mockRejectedValue(new Error('database is locked'));

    await expect(
      bridgeSessionToMemory('/tmp/project', {
        sessionId: 'session-102',
        scope: 'global',
        tasksCompleted: ['T1'],
        duration: 30,
      }),
    ).resolves.toBeUndefined();
  });
});
