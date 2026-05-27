/**
 * Session system edge case tests - carry-over bug verification from Bash.
 * Tests scope parsing, concurrent sessions, GC, resume, and timeout edge cases.
 *
 * @task T4502
 * @epic T4498
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  endSession,
  gcSessions,
  listSessions,
  parseScope,
  resumeSession,
  sessionStatus,
  startSession,
} from '../index.js';

let tempDir: string;
let cleoDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-edge-'));
  cleoDir = join(tempDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
  // Disable session enforcement and lifecycle so unit tests don't require active sessions.
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
  // Allow fire-and-forget async ops (e.g. bridgeSessionToMemory) to settle,
  // then close any db connections they may have re-opened.
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  try {
    const { closeAllDatabases } = await import('../../store/sqlite.js');
    await closeAllDatabases();
  } catch {
    /* ignore */
  }
  // Race rm against an 8s timeout. On Windows, fs.rm can block indefinitely
  // on locked SQLite WAL files — racing prevents the hook from timing out.
  await Promise.race([
    rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
  ]);
});

// ============================================================
// Scope Parsing Edge Cases
// ============================================================

describe('Scope parsing edge cases', () => {
  it('parses epic scope with multi-digit IDs', () => {
    expect(parseScope('epic:T9999')).toEqual({
      type: 'epic',
      epicId: 'T9999',
      rootTaskId: 'T9999',
    });
  });

  it('rejects scope without colon separator', () => {
    expect(() => parseScope('epicT001')).toThrow('Invalid scope format');
  });

  it('rejects scope with empty epic ID', () => {
    expect(() => parseScope('epic:')).toThrow('Invalid scope format');
  });

  it('rejects task scope (only epic and global supported)', () => {
    // task: scope format is not supported in the current parser
    expect(() => parseScope('task:T001')).toThrow('Invalid scope format');
  });

  it('rejects empty string scope', () => {
    expect(() => parseScope('')).toThrow('Invalid scope format');
  });

  it('rejects scope with special characters', () => {
    expect(() => parseScope('epic:T001;rm -rf')).toThrow('Invalid scope format');
  });
});

// ============================================================
// Concurrent Session Handling
// ============================================================

describe('Concurrent session handling', () => {
  it('allows multiple sessions with different epic scopes', async () => {
    const s1 = await startSession(tempDir, { name: 'Epic 1', scope: 'epic:T001' });
    const s2 = await startSession(tempDir, { name: 'Epic 2', scope: 'epic:T002' });
    const s3 = await startSession(tempDir, { name: 'Epic 3', scope: 'epic:T003' });

    expect(s1.status).toBe('active');
    expect(s2.status).toBe('active');
    expect(s3.status).toBe('active');

    const all = await listSessions(tempDir, { status: 'active' });
    expect(all).toHaveLength(3);
  });

  it('prevents same-scope epic session duplicate', async () => {
    await startSession(tempDir, { name: 'First', scope: 'epic:T001' });

    await expect(startSession(tempDir, { name: 'Duplicate', scope: 'epic:T001' })).rejects.toThrow(
      'Active session already exists',
    );
  });

  it('allows new session after ending previous with same scope', async () => {
    await startSession(tempDir, { name: 'First', scope: 'epic:T001' });
    await endSession(tempDir, {});

    const second = await startSession(tempDir, { name: 'Second', scope: 'epic:T001' });
    expect(second.status).toBe('active');
  });

  it('multiple global sessions are blocked', async () => {
    await startSession(tempDir, { name: 'Global 1', scope: 'global' });
    await expect(startSession(tempDir, { name: 'Global 2', scope: 'global' })).rejects.toThrow(
      'Active session already exists',
    );
  });

  it('global and epic sessions can coexist', async () => {
    const s1 = await startSession(tempDir, { name: 'Global', scope: 'global' });
    const s2 = await startSession(tempDir, { name: 'Epic', scope: 'epic:T001' });

    expect(s1.status).toBe('active');
    expect(s2.status).toBe('active');
  });
});

// ============================================================
// Session Resume Edge Cases
// ============================================================

describe('Session resume edge cases', () => {
  it('resume already active session returns it unchanged', async () => {
    const started = await startSession(tempDir, { name: 'Active', scope: 'global' });
    const resumed = await resumeSession(tempDir, { sessionId: started.id });

    expect(resumed.id).toBe(started.id);
    expect(resumed.status).toBe('active');
  });

  it('resume non-existent session throws', async () => {
    await expect(resumeSession(tempDir, { sessionId: 'session-nonexistent' })).rejects.toThrow(
      'Session not found',
    );
  });

  it('resume ended session reactivates it', async () => {
    const started = await startSession(tempDir, { name: 'Resumable', scope: 'global' });
    await endSession(tempDir, { note: 'Pausing' });

    const resumed = await resumeSession(tempDir, { sessionId: started.id });
    expect(resumed.status).toBe('active');
    expect(resumed.endedAt).toBeUndefined();
  });

  it('ending most recent active session works', async () => {
    await startSession(tempDir, { name: 'Session 1', scope: 'epic:T001' });
    const s2 = await startSession(tempDir, { name: 'Session 2', scope: 'epic:T002' });

    const ended = await endSession(tempDir, {});
    expect(ended.id).toBe(s2.id);
    expect(ended.status).toBe('ended');
  });
});

// ============================================================
// Session GC (Garbage Collection) Edge Cases
// ============================================================

describe('Session GC edge cases', () => {
  it('GC with no sessions is a no-op', async () => {
    const result = await gcSessions(tempDir, { maxAgeDays: 24 });
    expect(result.orphaned).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it('GC does not orphan recent sessions', async () => {
    await startSession(tempDir, { name: 'Recent', scope: 'global' });
    const result = await gcSessions(tempDir, { maxAgeDays: 24 });
    expect(result.orphaned).toHaveLength(0);
  });

  it('GC with 0 max age orphans all active sessions', async () => {
    await startSession(tempDir, { name: 'Session', scope: 'global' });
    // Wait just a moment to ensure the session is "old enough" with 0 max age
    const result = await gcSessions(tempDir, { maxAgeDays: 0 });
    expect(result.orphaned).toHaveLength(1);
  });

  it('GC preserves ended sessions within 30 days', async () => {
    await startSession(tempDir, { name: 'Session', scope: 'global' });
    await endSession(tempDir, {});

    const result = await gcSessions(tempDir, { maxAgeDays: 24 });
    expect(result.removed).toHaveLength(0);

    const sessions = await listSessions(tempDir, {});
    expect(sessions).toHaveLength(1);
  });

  it('session status returns null after all sessions ended', async () => {
    await startSession(tempDir, { name: 'Session', scope: 'global' });
    await endSession(tempDir, {});

    const status = await sessionStatus(tempDir, {});
    expect(status).toBeNull();
  });
});

// ============================================================
// Session Focus and Notes
// ============================================================

describe('Session focus and notes', () => {
  it('session can start with focus task', async () => {
    // Insert FK parent task: sessions.current_task -> tasks.id SET NULL.
    const { getDb } = await import('../../store/sqlite.js');
    const { tasks: tasksTable } = await import('../../store/tasks-schema.js');
    const db = await getDb(tempDir);
    db.insert(tasksTable)
      .values({
        id: 'T002',
        title: 'Focus task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      })
      .run();

    const session = await startSession(tempDir, {
      name: 'Focused',
      scope: 'epic:T001',
      startTask: 'T002',
    });

    expect(session.taskWork.taskId).toBe('T002');
    expect(session.taskWork.setAt).toBeDefined();
  });

  it('session without focus has null taskId', async () => {
    const session = await startSession(tempDir, {
      name: 'Unfocused',
      scope: 'global',
    });

    expect(session.taskWork.taskId).toBeNull();
  });

  it('ending session adds note', async () => {
    await startSession(tempDir, { name: 'Noted', scope: 'global' });
    const ended = await endSession(tempDir, { note: 'Completed milestone 1' });

    expect(ended.notes).toContain('Completed milestone 1');
  });

  it('ending session without note preserves existing notes', async () => {
    await startSession(tempDir, { name: 'Empty note', scope: 'global' });
    const ended = await endSession(tempDir, {});

    // SQLite round-trips empty arrays as undefined via safeParseJsonArray
    expect(ended.notes ?? []).toEqual([]);
  });
});

// ============================================================
// Session Data Persistence
// ============================================================

describe('Session data persistence', () => {
  it('sessions persist across reads', async () => {
    const created = await startSession(tempDir, { name: 'Persistent', scope: 'global' });

    // Read it back
    const status = await sessionStatus(tempDir, {});
    expect(status).not.toBeNull();
    expect(status!.id).toBe(created.id);
    expect(status!.name).toBe('Persistent');
  });

  it('session list is sorted by start time (newest first)', async () => {
    await startSession(tempDir, { name: 'First', scope: 'epic:T001' });
    await startSession(tempDir, { name: 'Second', scope: 'epic:T002' });
    await startSession(tempDir, { name: 'Third', scope: 'epic:T003' });

    const sessions = await listSessions(tempDir, {});
    expect(sessions[0]!.name).toBe('Third');
    expect(sessions[2]!.name).toBe('First');
  });

  it('list with limit returns only N sessions', async () => {
    await startSession(tempDir, { name: 'S1', scope: 'epic:T001' });
    await startSession(tempDir, { name: 'S2', scope: 'epic:T002' });
    await startSession(tempDir, { name: 'S3', scope: 'epic:T003' });

    const limited = await listSessions(tempDir, { limit: 2 });
    expect(limited).toHaveLength(2);
  });
});
