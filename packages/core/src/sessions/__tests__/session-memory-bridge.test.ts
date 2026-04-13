import { describe, expect, it } from 'vitest';

import { bridgeSessionToMemory } from '../session-memory-bridge.js';

/**
 * T527: bridgeSessionToMemory is now a no-op. Session data already lives in
 * the sessions table; the duplicate observeBrain write and extractSessionEndMemory
 * call were removed to reduce brain.db noise.
 *
 * These tests verify the function remains safe to call from sessions/index.ts
 * without throwing.
 */
describe('bridgeSessionToMemory', () => {
  it('resolves without throwing for a normal session', async () => {
    await expect(
      bridgeSessionToMemory('/tmp/project', {
        sessionId: 'session-100',
        scope: 'epic:T5417',
        tasksCompleted: ['T5464', 'T5466'],
        duration: 125,
      }),
    ).resolves.toBeUndefined();
  });

  it('resolves without throwing for empty task completion list', async () => {
    await expect(
      bridgeSessionToMemory('/tmp/project', {
        sessionId: 'session-101',
        scope: 'global',
        tasksCompleted: [],
        duration: 59,
      }),
    ).resolves.toBeUndefined();
  });

  it('resolves without throwing even when called with minimal data', async () => {
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
