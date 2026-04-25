/**
 * Tests for session management.
 * @task T4463
 * @epic T4454
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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

describe('parseScope', () => {
  it('parses global scope', () => {
    expect(parseScope('global')).toEqual({ type: 'global' });
  });

  it('parses epic scope', () => {
    expect(parseScope('epic:T001')).toEqual({ type: 'epic', epicId: 'T001', rootTaskId: 'T001' });
  });

  it('rejects invalid scope', () => {
    expect(() => parseScope('invalid')).toThrow('Invalid scope format');
  });
});

describe('Session lifecycle', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-test-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
  });

  afterEach(async () => {
    // Close ALL SQLite connections before cleanup — Windows locks open files
    try {
      const { closeAllDatabases } = await import('../../store/sqlite.js');
      await closeAllDatabases();
    } catch {
      /* module may not be loaded */
    }
    // Race rm against an 8s timeout. On Windows, fs.rm can block indefinitely
    // on locked SQLite WAL files — racing prevents the hook from timing out.
    await Promise.race([
      rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
  });

  it('starts a new session', async () => {
    const session = await startSession(tempDir, {
      name: 'Test session',
      scope: 'epic:T001',
    });

    expect(session.id).toMatch(/^session-/);
    expect(session.name).toBe('Test session');
    expect(session.status).toBe('active');
    expect(session.scope).toEqual({ type: 'epic', epicId: 'T001', rootTaskId: 'T001' });
  });

  it('shows session status', async () => {
    // No session yet
    const noSession = await sessionStatus(tempDir, {});
    expect(noSession).toBeNull();

    // Start one
    await startSession(tempDir, { name: 'Test', scope: 'global' });

    const active = await sessionStatus(tempDir, {});
    expect(active).not.toBeNull();
    expect(active!.status).toBe('active');
  });

  it('ends a session', async () => {
    const started = await startSession(tempDir, {
      name: 'Ending session',
      scope: 'global',
    });

    const ended = await endSession(tempDir, { note: 'Done for now' });
    expect(ended.id).toBe(started.id);
    expect(ended.status).toBe('ended');
    expect(ended.endedAt).toBeDefined();
    expect(ended.notes).toContain('Done for now');
  });

  it('throws when ending non-existent session', async () => {
    await expect(endSession(tempDir, {})).rejects.toThrow('No active session');
  });

  it('prevents duplicate scope sessions', async () => {
    await startSession(tempDir, { name: 'First', scope: 'epic:T001' });

    await expect(startSession(tempDir, { name: 'Second', scope: 'epic:T001' })).rejects.toThrow(
      'Active session already exists',
    );
  });

  it('allows different scope sessions', async () => {
    await startSession(tempDir, { name: 'Epic 1', scope: 'epic:T001' });
    const s2 = await startSession(tempDir, { name: 'Epic 2', scope: 'epic:T002' });
    expect(s2.status).toBe('active');
  });

  it('resumes an ended session', async () => {
    const started = await startSession(tempDir, { name: 'Resumable', scope: 'global' });
    await endSession(tempDir, {});

    const resumed = await resumeSession(tempDir, { sessionId: started.id });
    expect(resumed.status).toBe('active');
  });

  it('lists sessions', async () => {
    await startSession(tempDir, { name: 'Session 1', scope: 'global' });
    await endSession(tempDir, {});
    await startSession(tempDir, { name: 'Session 2', scope: 'epic:T001' });

    const all = await listSessions(tempDir, {});
    expect(all).toHaveLength(2);

    const activeOnly = await listSessions(tempDir, { status: 'active' });
    expect(activeOnly).toHaveLength(1);
    expect(activeOnly[0]!.name).toBe('Session 2');
  });

  it('garbage collects old sessions', async () => {
    // Start and end a session (simulating an old one is harder, so we test the API)
    await startSession(tempDir, { name: 'Recent', scope: 'global' });

    const result = await gcSessions(tempDir, { maxAgeDays: 24 });
    expect(result.orphaned).toHaveLength(0); // Recent session not orphaned
  });
});
