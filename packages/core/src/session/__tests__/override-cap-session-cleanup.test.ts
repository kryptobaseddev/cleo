/**
 * T9505 — BUG #5: override-cap session-end cleanup.
 *
 * Verifies that `sessionEnd` resets the CLEO_OWNER_OVERRIDE counter for the
 * ending session so that a subsequent session always starts at zero.
 *
 * Previously the counter was never cleared, causing it to accumulate across
 * sessions indefinitely (production symptom: "823 of 10 overrides used").
 *
 * @task T9505
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkAndIncrementOverrideCap,
  readSessionOverrideCount,
} from '../../security/override-cap.js';
import { getTaskAccessor } from '../../store/data-accessor.js';
import { sessionEnd, sessionStart, sessionStatus } from '../engine-ops.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tempDir: string;
let cleoDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-override-cap-session-'));
  cleoDir = join(tempDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
  // Write minimal config: disable session enforcement and lifecycle gates
  // so tests can call session operations without full project scaffolding.
  await writeFile(
    join(cleoDir, 'config.json'),
    JSON.stringify({
      enforcement: { session: { requiredForMutate: false } },
      lifecycle: { mode: 'off' },
      verification: { enabled: false },
    }),
  );
});

afterEach(async () => {
  try {
    const { closeAllDatabases } = await import('../../store/sqlite.js');
    await closeAllDatabases();
  } catch {
    /* ignore */
  }
  // Allow fire-and-forget async ops (e.g. bridgeSessionToMemory) to settle.
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  try {
    const { closeAllDatabases } = await import('../../store/sqlite.js');
    await closeAllDatabases();
  } catch {
    /* ignore */
  }
  await Promise.race([
    rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
  ]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('override-cap session-end cleanup (T9505)', () => {
  it('counter starts at 0 for a new session', async () => {
    const startResult = await sessionStart(tempDir, { scope: 'global', name: 'test-session-1' });
    expect(startResult.success).toBe(true);

    const sessionId = (startResult.data as { id: string }).id;
    const count = readSessionOverrideCount(tempDir, sessionId);
    expect(count).toBe(0);
  });

  it('sessionEnd clears the CLEO_OWNER_OVERRIDE counter', async () => {
    // 1. Start a session.
    const startResult = await sessionStart(tempDir, { scope: 'global', name: 'test-session-2' });
    expect(startResult.success).toBe(true);
    const sessionId = (startResult.data as { id: string }).id;

    // 2. Increment the override counter 3 times.
    checkAndIncrementOverrideCap(tempDir, sessionId);
    checkAndIncrementOverrideCap(tempDir, sessionId);
    checkAndIncrementOverrideCap(tempDir, sessionId);
    expect(readSessionOverrideCount(tempDir, sessionId)).toBe(3);

    // 3. End the session.
    const endResult = await sessionEnd(tempDir);
    expect(endResult.success).toBe(true);

    // 4. Assert the counter for that sessionId is now 0 (file deleted).
    const countAfter = readSessionOverrideCount(tempDir, sessionId);
    expect(countAfter).toBe(0);
  });

  it('new session starts with override counter at 0 after prior session end', async () => {
    // Session 1: start → increment counter → end.
    const start1 = await sessionStart(tempDir, { scope: 'global', name: 'session-one' });
    expect(start1.success).toBe(true);
    const session1Id = (start1.data as { id: string }).id;

    checkAndIncrementOverrideCap(tempDir, session1Id);
    checkAndIncrementOverrideCap(tempDir, session1Id);
    expect(readSessionOverrideCount(tempDir, session1Id)).toBe(2);

    await sessionEnd(tempDir);
    expect(readSessionOverrideCount(tempDir, session1Id)).toBe(0);

    // Session 2: start → assert counter is 0.
    const start2 = await sessionStart(tempDir, { scope: 'global', name: 'session-two' });
    expect(start2.success).toBe(true);
    const session2Id = (start2.data as { id: string }).id;

    expect(session2Id).not.toBe(session1Id);
    const count2 = readSessionOverrideCount(tempDir, session2Id);
    expect(count2).toBe(0);
  });

  it('sessionStatus surfaces overrideCount as 0 after session reset and restart', async () => {
    // Start → increment → end → start fresh → check status shows count=0.
    const s1 = await sessionStart(tempDir, { scope: 'global', name: 'status-check-s1' });
    expect(s1.success).toBe(true);
    const s1Id = (s1.data as { id: string }).id;

    checkAndIncrementOverrideCap(tempDir, s1Id);
    checkAndIncrementOverrideCap(tempDir, s1Id);
    checkAndIncrementOverrideCap(tempDir, s1Id);

    const statusBeforeEnd = await sessionStatus(tempDir);
    expect(statusBeforeEnd.success).toBe(true);
    expect(statusBeforeEnd.data?.overrideCount).toBe(3);

    await sessionEnd(tempDir);

    const s2 = await sessionStart(tempDir, { scope: 'global', name: 'status-check-s2' });
    expect(s2.success).toBe(true);

    const statusAfterRestart = await sessionStatus(tempDir);
    expect(statusAfterRestart.success).toBe(true);
    expect(statusAfterRestart.data?.overrideCount).toBe(0);
  });

  it('sessionStatus selects the newest active session instead of a stale fixture scope (T9156)', async () => {
    const accessor = await getTaskAccessor(tempDir);
    await accessor.upsertSingleSession({
      id: 'session-stale-fixture',
      name: 'stale T001 fixture',
      status: 'active',
      scope: { type: 'epic', epicId: 'T001', rootTaskId: 'T001' },
      taskWork: { taskId: 'T001', setAt: '2026-01-01T00:00:00.000Z' },
      startedAt: '2026-01-01T00:00:00.000Z',
      lastActivity: '2026-01-01T00:00:00.000Z',
      resumeCount: 0,
      scopeKind: 'epic',
      scopeId: 'T001',
      stats: {
        tasksCompleted: 0,
        tasksCreated: 0,
        tasksUpdated: 0,
        focusChanges: 0,
        totalActiveMinutes: 0,
        suspendCount: 0,
      },
    });

    const fresh = await sessionStart(tempDir, {
      scope: 'global',
      name: 'fresh agent session',
      agentHandle: 'fresh-agent',
    });
    expect(fresh.success).toBe(true);

    const status = await sessionStatus(tempDir);
    expect(status.success).toBe(true);
    expect(status.data?.session?.id).toBe(fresh.data?.id);
    expect(status.data?.session?.scope).toEqual({ type: 'global' });
    expect(status.data?.session?.scope).not.toEqual({
      type: 'epic',
      epicId: 'T001',
      rootTaskId: 'T001',
    });
  });

  it('counter is keyed by sessionId — each session has an independent bucket', async () => {
    // Manually write a count for a hypothetical old session (simulates leaked orphan).
    const oldSessionId = 'ses_orphan_from_prior_run';
    checkAndIncrementOverrideCap(tempDir, oldSessionId);
    checkAndIncrementOverrideCap(tempDir, oldSessionId);
    expect(readSessionOverrideCount(tempDir, oldSessionId)).toBe(2);

    // Start a new session — its counter should be independent (starts at 0).
    const newSession = await sessionStart(tempDir, { scope: 'global', name: 'new-isolated' });
    expect(newSession.success).toBe(true);
    const newId = (newSession.data as { id: string }).id;

    expect(readSessionOverrideCount(tempDir, newId)).toBe(0);

    // End the new session — old orphan counter must NOT be affected.
    checkAndIncrementOverrideCap(tempDir, newId);
    await sessionEnd(tempDir);

    expect(readSessionOverrideCount(tempDir, newId)).toBe(0);
    // Orphan counter is unaffected by a different session's end.
    expect(readSessionOverrideCount(tempDir, oldSessionId)).toBe(2);
  });
});
