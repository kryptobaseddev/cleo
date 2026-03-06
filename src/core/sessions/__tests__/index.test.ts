import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mocks = vi.hoisted(() => ({
  bridgeSessionToMemory: vi.fn(),
  dispatch: vi.fn(),
  register: vi.fn(),
}));

vi.mock('../session-memory-bridge.js', () => ({
  bridgeSessionToMemory: mocks.bridgeSessionToMemory,
}));

vi.mock('../../hooks/registry.js', () => ({
  hooks: {
    dispatch: mocks.dispatch,
    register: mocks.register,
  },
}));

import { endSession, startSession } from '../index.js';

describe('sessions index memory bridge wiring', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-session-index-'));
    await mkdir(join(tempDir, '.cleo', 'backups', 'operational'), { recursive: true });

    mocks.bridgeSessionToMemory.mockReset();
    mocks.bridgeSessionToMemory.mockResolvedValue(undefined);

    mocks.dispatch.mockReset();
    mocks.dispatch.mockResolvedValue(undefined);

    mocks.register.mockReset();
    mocks.register.mockReturnValue(undefined);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('calls bridgeSessionToMemory with derived end-session payload', async () => {
    const started = await startSession({
      name: 'Bridge wiring test',
      scope: 'epic:T5417',
    }, tempDir);

    const ended = await endSession({}, tempDir);

    expect(ended.id).toBe(started.id);
    expect(ended.status).toBe('ended');
    expect(mocks.bridgeSessionToMemory).toHaveBeenCalledTimes(1);
    expect(mocks.bridgeSessionToMemory).toHaveBeenCalledWith(
      tempDir,
      expect.objectContaining({
        sessionId: started.id,
        scope: 'epic:T5417',
        tasksCompleted: [],
      }),
    );
  });

  it('keeps session end successful when bridge rejects', async () => {
    mocks.bridgeSessionToMemory.mockRejectedValue(new Error('bridge unavailable'));

    const started = await startSession({
      name: 'Bridge failure resilience',
      scope: 'global',
    }, tempDir);

    await expect(endSession({}, tempDir)).resolves.toEqual(
      expect.objectContaining({
        id: started.id,
        status: 'ended',
      }),
    );

    expect(mocks.bridgeSessionToMemory).toHaveBeenCalledTimes(1);
  });
});
