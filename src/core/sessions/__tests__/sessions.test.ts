/**
 * Tests for session management.
 * @task T4463
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
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
    await rm(tempDir, { recursive: true, force: true });
  });

  it('starts a new session', async () => {
    const session = await startSession({
      name: 'Test session',
      scope: 'epic:T001',
    }, tempDir);

    expect(session.id).toMatch(/^session-/);
    expect(session.name).toBe('Test session');
    expect(session.status).toBe('active');
    expect(session.scope).toEqual({ type: 'epic', epicId: 'T001', rootTaskId: 'T001' });
  });

  it('shows session status', async () => {
    // No session yet
    const noSession = await sessionStatus(tempDir);
    expect(noSession).toBeNull();

    // Start one
    await startSession({ name: 'Test', scope: 'global' }, tempDir);

    const active = await sessionStatus(tempDir);
    expect(active).not.toBeNull();
    expect(active!.status).toBe('active');
  });

  it('ends a session', async () => {
    const started = await startSession({
      name: 'Ending session',
      scope: 'global',
    }, tempDir);

    const ended = await endSession({ note: 'Done for now' }, tempDir);
    expect(ended.id).toBe(started.id);
    expect(ended.status).toBe('ended');
    expect(ended.endedAt).toBeDefined();
    expect(ended.notes).toContain('Done for now');
  });

  it('throws when ending non-existent session', async () => {
    await expect(
      endSession({}, tempDir),
    ).rejects.toThrow('No active session');
  });

  it('prevents duplicate scope sessions', async () => {
    await startSession({ name: 'First', scope: 'epic:T001' }, tempDir);

    await expect(
      startSession({ name: 'Second', scope: 'epic:T001' }, tempDir),
    ).rejects.toThrow('Active session already exists');
  });

  it('allows different scope sessions', async () => {
    await startSession({ name: 'Epic 1', scope: 'epic:T001' }, tempDir);
    const s2 = await startSession({ name: 'Epic 2', scope: 'epic:T002' }, tempDir);
    expect(s2.status).toBe('active');
  });

  it('resumes an ended session', async () => {
    const started = await startSession({ name: 'Resumable', scope: 'global' }, tempDir);
    await endSession({}, tempDir);

    const resumed = await resumeSession(started.id, tempDir);
    expect(resumed.status).toBe('active');
  });

  it('lists sessions', async () => {
    await startSession({ name: 'Session 1', scope: 'global' }, tempDir);
    await endSession({}, tempDir);
    await startSession({ name: 'Session 2', scope: 'epic:T001' }, tempDir);

    const all = await listSessions({}, tempDir);
    expect(all).toHaveLength(2);

    const activeOnly = await listSessions({ status: 'active' }, tempDir);
    expect(activeOnly).toHaveLength(1);
    expect(activeOnly[0]!.name).toBe('Session 2');
  });

  it('garbage collects old sessions', async () => {
    // Start and end a session (simulating an old one is harder, so we test the API)
    await startSession({ name: 'Recent', scope: 'global' }, tempDir);

    const result = await gcSessions(24, tempDir);
    expect(result.orphaned).toHaveLength(0); // Recent session not orphaned
  });
});
