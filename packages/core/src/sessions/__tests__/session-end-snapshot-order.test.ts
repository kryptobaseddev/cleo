/**
 * The session-end snapshot runs LAST in `endSession`: after the SessionEnd
 * hooks, after the memory bridge, and after the session row is persisted as
 * ended — so the snapshot contains the session's final state (T12508 NEW-3).
 *
 * The snapshot module is mocked: when it is called it reads the session back
 * from the store and records the status it sees.
 *
 * @task T12508
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  statusAtSnapshot: [] as Array<string | undefined>,
}));

vi.mock('../session-memory-bridge.js', () => ({
  bridgeSessionToMemory: vi.fn(async () => {
    mocks.events.push('memory-bridge');
  }),
}));

vi.mock('../../hooks/registry.js', () => ({
  hooks: {
    dispatch: vi.fn(async (event: string) => {
      mocks.events.push(`hook:${event}`);
    }),
    register: vi.fn(),
  },
}));

vi.mock('../session-end-snapshot.js', () => ({
  snapshotAfterSessionEnd: vi.fn(async (projectRoot: string) => {
    mocks.events.push('snapshot');
    const { readSessions } = await import('../index.js');
    const sessions = await readSessions(projectRoot);
    mocks.statusAtSnapshot.push(sessions[0]?.status);
    return null;
  }),
}));

import { endSession, startSession } from '../index.js';

describe('endSession takes the SQLite snapshot after persisting (T12508)', {
  timeout: 60_000,
}, () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-t12508-session-end-'));
    await mkdir(join(tempDir, '.cleo', 'backups', 'operational'), { recursive: true });
    mocks.events.length = 0;
    mocks.statusAtSnapshot.length = 0;
  });

  afterEach(async () => {
    try {
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
    } catch {
      /* may not be loaded */
    }
    try {
      const { closeDb } = await import('../../store/sqlite.js');
      closeDb();
    } catch {
      /* may not be loaded */
    }
    await Promise.race([
      rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
  });

  it('runs the snapshot after the hooks and memory bridge, with the session already ended', async () => {
    await startSession(tempDir, { name: 'snapshot order', scope: 'global' });
    mocks.events.length = 0;

    await endSession(tempDir, {});

    const endEvents = mocks.events.filter((e) => e !== 'hook:SessionStart');
    expect(endEvents).toEqual(['hook:SessionEnd', 'memory-bridge', 'snapshot']);
    expect(mocks.statusAtSnapshot).toEqual(['ended']);
  });
});
