/**
 * Tests for conduit-hooks.ts
 *
 * Verifies that SubagentStart, SubagentStop, and SessionEnd handlers
 * write the correct structured messages to conduit via LocalTransport.
 *
 * Mocks the LocalTransport module so no real conduit.db is required.
 *
 * @task T268
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state — established before any module is imported
// ---------------------------------------------------------------------------

const transportMocks = vi.hoisted(() => {
  const pushFn = vi.fn().mockResolvedValue({ messageId: 'msg-1' });
  const disconnectFn = vi.fn().mockResolvedValue(undefined);
  const connectFn = vi.fn().mockResolvedValue(undefined);
  const isAvailableFn = vi.fn().mockReturnValue(true);
  const transportInstance = { connect: connectFn, push: pushFn, disconnect: disconnectFn };

  return { pushFn, disconnectFn, connectFn, isAvailableFn, transportInstance };
});

vi.mock('../../../conduit/local-transport.js', () => {
  class MockLocalTransport {
    connect = transportMocks.connectFn;
    push = transportMocks.pushFn;
    disconnect = transportMocks.disconnectFn;
    static isAvailable = transportMocks.isAvailableFn;
  }
  return { LocalTransport: MockLocalTransport };
});

// ---------------------------------------------------------------------------
// Subject under test — imported AFTER mocks are registered
// ---------------------------------------------------------------------------

import {
  handleConduitSessionEnd,
  handleConduitSubagentStart,
  handleConduitSubagentStop,
  tryGetLocalTransport,
} from '../conduit-hooks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse JSON content from the first push call argument at position `callIndex`. */
function parsePush(callIndex = 0): Record<string, unknown> {
  const rawContent = transportMocks.pushFn.mock.calls[callIndex][1] as string;
  return JSON.parse(rawContent) as Record<string, unknown>;
}

/** Reset all transport mocks to fresh state. */
function resetMocks() {
  transportMocks.pushFn.mockReset().mockResolvedValue({ messageId: 'msg-1' });
  transportMocks.disconnectFn.mockReset().mockResolvedValue(undefined);
  transportMocks.connectFn.mockReset().mockResolvedValue(undefined);
  transportMocks.isAvailableFn.mockReturnValue(true);
}

// ---------------------------------------------------------------------------
// tryGetLocalTransport
// ---------------------------------------------------------------------------

describe('tryGetLocalTransport', () => {
  beforeEach(resetMocks);

  it('returns null when conduit.db is unavailable', async () => {
    transportMocks.isAvailableFn.mockReturnValue(false);

    const result = await tryGetLocalTransport('/tmp/project');

    expect(result).toBeNull();
    expect(transportMocks.connectFn).not.toHaveBeenCalled();
  });

  it('returns a connected transport instance when available', async () => {
    const result = await tryGetLocalTransport('/tmp/project');

    expect(result).not.toBeNull();
    expect(transportMocks.connectFn).toHaveBeenCalledTimes(1);
  });

  it('returns null when connect throws', async () => {
    transportMocks.connectFn.mockRejectedValue(new Error('connection refused'));

    const result = await tryGetLocalTransport('/tmp/project');

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleConduitSubagentStart
// ---------------------------------------------------------------------------

describe('handleConduitSubagentStart', () => {
  beforeEach(resetMocks);

  it('pushes a subagent.spawn message when conduit.db is available', async () => {
    await handleConduitSubagentStart('/tmp/project', {
      timestamp: '2026-04-13T10:00:00.000Z',
      agentId: 'worker-42',
      role: 'researcher',
      taskId: 'T999',
    });

    expect(transportMocks.pushFn).toHaveBeenCalledTimes(1);
    const msg = parsePush();
    expect(msg.type).toBe('subagent.spawn');
    expect(msg.from).toBe('cleo-orchestrator');
    expect(msg.to).toBe('worker-42');
    expect(msg.taskId).toBe('T999');
    expect(typeof msg.timestamp).toBe('string');
    expect((msg.content as string).includes('worker-42')).toBe(true);
  });

  it('includes role in content when provided', async () => {
    await handleConduitSubagentStart('/tmp/project', {
      timestamp: '2026-04-13T10:00:00.000Z',
      agentId: 'worker-99',
      role: 'implementer',
    });

    const msg = parsePush();
    expect((msg.content as string).includes('implementer')).toBe(true);
  });

  it('sets taskId to null when not provided', async () => {
    await handleConduitSubagentStart('/tmp/project', {
      timestamp: '2026-04-13T10:00:00.000Z',
      agentId: 'worker-no-task',
    });

    const msg = parsePush();
    expect(msg.taskId).toBeNull();
  });

  it('does nothing when conduit.db is unavailable', async () => {
    transportMocks.isAvailableFn.mockReturnValue(false);

    await handleConduitSubagentStart('/tmp/project', {
      timestamp: '2026-04-13T10:00:00.000Z',
      agentId: 'worker-offline',
    });

    expect(transportMocks.pushFn).not.toHaveBeenCalled();
  });

  it('swallows push errors so orchestration is never blocked', async () => {
    transportMocks.pushFn.mockRejectedValue(new Error('SQLITE_ERROR: disk full'));

    await expect(
      handleConduitSubagentStart('/tmp/project', {
        timestamp: '2026-04-13T10:00:00.000Z',
        agentId: 'worker-crash',
        taskId: 'T888',
      }),
    ).resolves.toBeUndefined();
  });

  it('always disconnects the transport after a successful push', async () => {
    await handleConduitSubagentStart('/tmp/project', {
      timestamp: '2026-04-13T10:00:00.000Z',
      agentId: 'worker-cleanup',
    });

    expect(transportMocks.disconnectFn).toHaveBeenCalledTimes(1);
  });

  it('still disconnects when push throws', async () => {
    transportMocks.pushFn.mockRejectedValue(new Error('push failed'));

    await handleConduitSubagentStart('/tmp/project', {
      timestamp: '2026-04-13T10:00:00.000Z',
      agentId: 'worker-cleanup-on-error',
    });

    expect(transportMocks.disconnectFn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// handleConduitSubagentStop
// ---------------------------------------------------------------------------

describe('handleConduitSubagentStop', () => {
  beforeEach(resetMocks);

  it('pushes a subagent.complete message when conduit.db is available', async () => {
    await handleConduitSubagentStop('/tmp/project', {
      timestamp: '2026-04-13T11:00:00.000Z',
      agentId: 'worker-42',
      status: 'complete',
      taskId: 'T999',
    });

    expect(transportMocks.pushFn).toHaveBeenCalledTimes(1);
    const msg = parsePush();
    expect(msg.type).toBe('subagent.complete');
    expect(msg.from).toBe('worker-42');
    expect(msg.to).toBe('cleo-system');
    expect(msg.taskId).toBe('T999');
  });

  it('includes status in content', async () => {
    await handleConduitSubagentStop('/tmp/project', {
      timestamp: '2026-04-13T11:00:00.000Z',
      agentId: 'worker-partial',
      status: 'partial',
    });

    const msg = parsePush();
    expect((msg.content as string).includes('partial')).toBe(true);
  });

  it('uses "unknown" when status is absent', async () => {
    await handleConduitSubagentStop('/tmp/project', {
      timestamp: '2026-04-13T11:00:00.000Z',
      agentId: 'worker-no-status',
    });

    const msg = parsePush();
    expect((msg.content as string).includes('unknown')).toBe(true);
  });

  it('does nothing when conduit.db is unavailable', async () => {
    transportMocks.isAvailableFn.mockReturnValue(false);

    await handleConduitSubagentStop('/tmp/project', {
      timestamp: '2026-04-13T11:00:00.000Z',
      agentId: 'worker-offline',
      status: 'complete',
    });

    expect(transportMocks.pushFn).not.toHaveBeenCalled();
  });

  it('swallows push errors so orchestration is never blocked', async () => {
    transportMocks.pushFn.mockRejectedValue(new Error('conduit.db locked'));

    await expect(
      handleConduitSubagentStop('/tmp/project', {
        timestamp: '2026-04-13T11:00:00.000Z',
        agentId: 'worker-crash',
        status: 'failed',
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleConduitSessionEnd
// ---------------------------------------------------------------------------

describe('handleConduitSessionEnd', () => {
  beforeEach(resetMocks);

  it('pushes a session.handoff message when conduit.db is available', async () => {
    await handleConduitSessionEnd('/tmp/project', {
      timestamp: '2026-04-13T12:00:00.000Z',
      sessionId: 'ses-test-1',
      duration: 3600,
      tasksCompleted: ['T100', 'T101'],
    });

    expect(transportMocks.pushFn).toHaveBeenCalledTimes(1);
    const msg = parsePush();
    expect(msg.type).toBe('session.handoff');
    expect(msg.from).toBe('cleo-orchestrator');
    expect(msg.to).toBe('cleo-system');
    expect((msg.content as string).includes('ses-test-1')).toBe(true);
  });

  it('includes nextTask in content and taskId when metadata.nextTask is set', async () => {
    await handleConduitSessionEnd('/tmp/project', {
      timestamp: '2026-04-13T12:00:00.000Z',
      sessionId: 'ses-handoff',
      duration: 1800,
      tasksCompleted: ['T200'],
      metadata: { nextTask: 'T201' },
    });

    const msg = parsePush();
    expect(msg.taskId).toBe('T201');
    expect((msg.content as string).includes('T201')).toBe(true);
  });

  it('sets taskId to null when no nextTask metadata', async () => {
    await handleConduitSessionEnd('/tmp/project', {
      timestamp: '2026-04-13T12:00:00.000Z',
      sessionId: 'ses-no-next',
      duration: 900,
      tasksCompleted: [],
    });

    const msg = parsePush();
    expect(msg.taskId).toBeNull();
  });

  it('ignores non-string nextTask metadata', async () => {
    await handleConduitSessionEnd('/tmp/project', {
      timestamp: '2026-04-13T12:00:00.000Z',
      sessionId: 'ses-bad-meta',
      duration: 100,
      tasksCompleted: [],
      metadata: { nextTask: 42 },
    });

    const msg = parsePush();
    expect(msg.taskId).toBeNull();
  });

  it('does nothing when conduit.db is unavailable', async () => {
    transportMocks.isAvailableFn.mockReturnValue(false);

    await handleConduitSessionEnd('/tmp/project', {
      timestamp: '2026-04-13T12:00:00.000Z',
      sessionId: 'ses-offline',
      duration: 0,
      tasksCompleted: [],
    });

    expect(transportMocks.pushFn).not.toHaveBeenCalled();
  });

  it('swallows push errors so session end is never blocked', async () => {
    transportMocks.pushFn.mockRejectedValue(new Error('conduit write timeout'));

    await expect(
      handleConduitSessionEnd('/tmp/project', {
        timestamp: '2026-04-13T12:00:00.000Z',
        sessionId: 'ses-crash',
        duration: 500,
        tasksCompleted: ['T300'],
      }),
    ).resolves.toBeUndefined();
  });

  it('always disconnects the transport after a successful push', async () => {
    await handleConduitSessionEnd('/tmp/project', {
      timestamp: '2026-04-13T12:00:00.000Z',
      sessionId: 'ses-cleanup',
      duration: 600,
      tasksCompleted: [],
    });

    expect(transportMocks.disconnectFn).toHaveBeenCalledTimes(1);
  });
});
