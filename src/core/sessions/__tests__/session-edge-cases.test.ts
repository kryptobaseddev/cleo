/**
 * Session system edge case tests - carry-over bug verification from Bash.
 * Tests scope parsing, concurrent sessions, GC, resume, and timeout edge cases.
 *
 * @task T4502
 * @epic T4498
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  startSession,
  endSession,
  sessionStatus,
  resumeSession,
  listSessions,
  gcSessions,
  parseScope,
} from '../index.js';

let tempDir: string;
let cleoDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-edge-'));
  cleoDir = join(tempDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ============================================================
// Scope Parsing Edge Cases
// ============================================================

describe('Scope parsing edge cases', () => {
  it('parses epic scope with multi-digit IDs', () => {
    expect(parseScope('epic:T9999')).toEqual({ type: 'epic', epicId: 'T9999' });
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
    const s1 = await startSession({ name: 'Epic 1', scope: 'epic:T001' }, tempDir);
    const s2 = await startSession({ name: 'Epic 2', scope: 'epic:T002' }, tempDir);
    const s3 = await startSession({ name: 'Epic 3', scope: 'epic:T003' }, tempDir);

    expect(s1.status).toBe('active');
    expect(s2.status).toBe('active');
    expect(s3.status).toBe('active');

    const all = await listSessions({ status: 'active' }, tempDir);
    expect(all).toHaveLength(3);
  });

  it('prevents same-scope epic session duplicate', async () => {
    await startSession({ name: 'First', scope: 'epic:T001' }, tempDir);

    await expect(
      startSession({ name: 'Duplicate', scope: 'epic:T001' }, tempDir),
    ).rejects.toThrow('Active session already exists');
  });

  it('allows new session after ending previous with same scope', async () => {
    await startSession({ name: 'First', scope: 'epic:T001' }, tempDir);
    await endSession({}, tempDir);

    const second = await startSession({ name: 'Second', scope: 'epic:T001' }, tempDir);
    expect(second.status).toBe('active');
  });

  it('multiple global sessions are blocked', async () => {
    await startSession({ name: 'Global 1', scope: 'global' }, tempDir);
    await expect(
      startSession({ name: 'Global 2', scope: 'global' }, tempDir),
    ).rejects.toThrow('Active session already exists');
  });

  it('global and epic sessions can coexist', async () => {
    const s1 = await startSession({ name: 'Global', scope: 'global' }, tempDir);
    const s2 = await startSession({ name: 'Epic', scope: 'epic:T001' }, tempDir);

    expect(s1.status).toBe('active');
    expect(s2.status).toBe('active');
  });
});

// ============================================================
// Session Resume Edge Cases
// ============================================================

describe('Session resume edge cases', () => {
  it('resume already active session returns it unchanged', async () => {
    const started = await startSession({ name: 'Active', scope: 'global' }, tempDir);
    const resumed = await resumeSession(started.id, tempDir);

    expect(resumed.id).toBe(started.id);
    expect(resumed.status).toBe('active');
  });

  it('resume non-existent session throws', async () => {
    await expect(
      resumeSession('session-nonexistent', tempDir),
    ).rejects.toThrow('Session not found');
  });

  it('resume ended session reactivates it', async () => {
    const started = await startSession({ name: 'Resumable', scope: 'global' }, tempDir);
    await endSession({ note: 'Pausing' }, tempDir);

    const resumed = await resumeSession(started.id, tempDir);
    expect(resumed.status).toBe('active');
    expect(resumed.endedAt).toBeNull();
  });

  it('ending session by ID works', async () => {
    const s1 = await startSession({ name: 'Session 1', scope: 'epic:T001' }, tempDir);
    await startSession({ name: 'Session 2', scope: 'epic:T002' }, tempDir);

    const ended = await endSession({ sessionId: s1.id }, tempDir);
    expect(ended.id).toBe(s1.id);
    expect(ended.status).toBe('ended');
  });
});

// ============================================================
// Session GC (Garbage Collection) Edge Cases
// ============================================================

describe('Session GC edge cases', () => {
  it('GC with no sessions is a no-op', async () => {
    const result = await gcSessions(24, tempDir);
    expect(result.orphaned).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it('GC does not orphan recent sessions', async () => {
    await startSession({ name: 'Recent', scope: 'global' }, tempDir);
    const result = await gcSessions(24, tempDir);
    expect(result.orphaned).toHaveLength(0);
  });

  it('GC with 0 max age orphans all active sessions', async () => {
    await startSession({ name: 'Session', scope: 'global' }, tempDir);
    // Wait just a moment to ensure the session is "old enough" with 0 max age
    const result = await gcSessions(0, tempDir);
    expect(result.orphaned).toHaveLength(1);
  });

  it('GC preserves ended sessions within 30 days', async () => {
    await startSession({ name: 'Session', scope: 'global' }, tempDir);
    await endSession({}, tempDir);

    const result = await gcSessions(24, tempDir);
    expect(result.removed).toHaveLength(0);

    const sessions = await listSessions({}, tempDir);
    expect(sessions).toHaveLength(1);
  });

  it('session status returns null after all sessions ended', async () => {
    await startSession({ name: 'Session', scope: 'global' }, tempDir);
    await endSession({}, tempDir);

    const status = await sessionStatus(tempDir);
    expect(status).toBeNull();
  });
});

// ============================================================
// Session Focus and Notes
// ============================================================

describe('Session focus and notes', () => {
  it('session can start with focus task', async () => {
    const session = await startSession({
      name: 'Focused',
      scope: 'epic:T001',
      focus: 'T002',
    }, tempDir);

    expect(session.focus.taskId).toBe('T002');
    expect(session.focus.setAt).toBeDefined();
  });

  it('session without focus has null taskId', async () => {
    const session = await startSession({
      name: 'Unfocused',
      scope: 'global',
    }, tempDir);

    expect(session.focus.taskId).toBeNull();
  });

  it('ending session adds note', async () => {
    await startSession({ name: 'Noted', scope: 'global' }, tempDir);
    const ended = await endSession({ note: 'Completed milestone 1' }, tempDir);

    expect(ended.notes).toContain('Completed milestone 1');
  });

  it('ending session without note preserves existing notes', async () => {
    await startSession({ name: 'Empty note', scope: 'global' }, tempDir);
    const ended = await endSession({}, tempDir);

    expect(ended.notes).toEqual([]);
  });
});

// ============================================================
// Session Data Persistence
// ============================================================

describe('Session data persistence', () => {
  it('sessions persist across reads', async () => {
    const created = await startSession({ name: 'Persistent', scope: 'global' }, tempDir);

    // Read it back
    const status = await sessionStatus(tempDir);
    expect(status).not.toBeNull();
    expect(status!.id).toBe(created.id);
    expect(status!.name).toBe('Persistent');
  });

  it('session list is sorted by start time (newest first)', async () => {
    const s1 = await startSession({ name: 'First', scope: 'epic:T001' }, tempDir);
    const s2 = await startSession({ name: 'Second', scope: 'epic:T002' }, tempDir);
    const s3 = await startSession({ name: 'Third', scope: 'epic:T003' }, tempDir);

    const sessions = await listSessions({}, tempDir);
    expect(sessions[0]!.name).toBe('Third');
    expect(sessions[2]!.name).toBe('First');
  });

  it('list with limit returns only N sessions', async () => {
    await startSession({ name: 'S1', scope: 'epic:T001' }, tempDir);
    await startSession({ name: 'S2', scope: 'epic:T002' }, tempDir);
    await startSession({ name: 'S3', scope: 'epic:T003' }, tempDir);

    const limited = await listSessions({ limit: 2 }, tempDir);
    expect(limited).toHaveLength(2);
  });
});
