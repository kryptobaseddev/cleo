/**
 * Tests for SQLite-backed session store operations.
 *
 * Covers session CRUD, focus operations, history tracking,
 * lifecycle management, and garbage collection.
 *
 * @task T4645
 * @epic T4638
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Session } from '../../types/session.js';

let tempDir: string;

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  const taskWork = overrides.taskWork ?? { taskId: null, setAt: null };
  return {
    name: `Session ${overrides.id}`,
    status: 'active',
    scope: { type: 'global' },
    taskWork,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('SQLite session-store', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-sessstore-'));
    const cleoDir = join(tempDir, '.cleo');
    process.env['CLEO_DIR'] = cleoDir;

    const { closeDb } = await import('../sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // === createSession ===

  describe('createSession', () => {
    it('creates a session and retrieves it', async () => {
      const { createSession, getSession } = await import('../session-store.js');

      const session = makeSession({
        id: 'sess-001',
        name: 'Dev session',
        scope: { type: 'epic', epicId: 'T001' },
      });

      const created = await createSession(session);
      expect(created.id).toBe('sess-001');

      const retrieved = await getSession('sess-001');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe('sess-001');
      expect(retrieved!.name).toBe('Dev session');
      expect(retrieved!.status).toBe('active');
      expect(retrieved!.scope.type).toBe('epic');
      expect(retrieved!.scope.epicId).toBe('T001');
    });

    it('preserves notes, tasksCompleted, tasksCreated', async () => {
      const { createSession, getSession } = await import('../session-store.js');

      const session = makeSession({
        id: 'sess-002',
        notes: ['Started work on auth'],
        tasksCompleted: ['T001'],
        tasksCreated: ['T002', 'T003'],
      });

      await createSession(session);
      const retrieved = await getSession('sess-002');

      expect(retrieved!.notes).toEqual(['Started work on auth']);
      expect(retrieved!.tasksCompleted).toEqual(['T001']);
      expect(retrieved!.tasksCreated).toEqual(['T002', 'T003']);
    });

    it('preserves taskWork state', async () => {
      const { createSession, getSession } = await import('../session-store.js');

      const now = new Date().toISOString();
      const session = makeSession({
        id: 'sess-003',
        taskWork: { taskId: 'T001', setAt: now },
      });

      await createSession(session);
      const retrieved = await getSession('sess-003');

      expect(retrieved!.taskWork.taskId).toBe('T001');
      expect(retrieved!.taskWork.setAt).toBe(now);
    });

    it('preserves agent field', async () => {
      const { createSession, getSession } = await import('../session-store.js');

      const session = makeSession({
        id: 'sess-004',
        agent: 'claude-opus',
      });

      await createSession(session);
      const retrieved = await getSession('sess-004');
      expect(retrieved!.agent).toBe('claude-opus');
    });
  });

  // === getSession ===

  describe('getSession', () => {
    it('returns null for non-existent session', async () => {
      const { getSession } = await import('../session-store.js');
      const result = await getSession('nonexistent');
      expect(result).toBeNull();
    });
  });

  // === updateSession ===

  describe('updateSession', () => {
    it('updates session name', async () => {
      const { createSession, updateSession } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001' }));

      const updated = await updateSession('sess-001', { name: 'Updated name' });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('Updated name');
    });

    it('updates session status', async () => {
      const { createSession, updateSession } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001' }));

      const updated = await updateSession('sess-001', { status: 'ended' });
      expect(updated!.status).toBe('ended');
    });

    it('updates scope', async () => {
      const { createSession, updateSession } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001' }));

      const updated = await updateSession('sess-001', {
        scope: { type: 'epic', epicId: 'T100' },
      });
      expect(updated!.scope.type).toBe('epic');
      expect(updated!.scope.epicId).toBe('T100');
    });

    it('updates notes', async () => {
      const { createSession, updateSession } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001' }));

      const updated = await updateSession('sess-001', {
        notes: ['Note 1', 'Note 2'],
      });
      expect(updated!.notes).toEqual(['Note 1', 'Note 2']);
    });

    it('updates tasksCompleted and tasksCreated', async () => {
      const { createSession, updateSession } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001' }));

      const updated = await updateSession('sess-001', {
        tasksCompleted: ['T001', 'T002'],
        tasksCreated: ['T003'],
      });
      expect(updated!.tasksCompleted).toEqual(['T001', 'T002']);
      expect(updated!.tasksCreated).toEqual(['T003']);
    });

    it('returns null for non-existent session', async () => {
      const { updateSession } = await import('../session-store.js');
      const result = await updateSession('nonexistent', { name: 'Nope' });
      expect(result).toBeNull();
    });
  });

  // === listSessions ===

  describe('listSessions', () => {
    it('lists all sessions', async () => {
      const { createSession, listSessions } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001' }));
      await createSession(makeSession({ id: 'sess-002', status: 'ended' }));

      const sessions = await listSessions();
      expect(sessions).toHaveLength(2);
    });

    it('filters active sessions only', async () => {
      const { createSession, listSessions } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001', status: 'active' }));
      await createSession(makeSession({ id: 'sess-002', status: 'ended' }));

      const active = await listSessions({ active: true });
      expect(active).toHaveLength(1);
      expect(active[0]!.id).toBe('sess-001');
    });

    it('respects limit parameter', async () => {
      const { createSession, listSessions } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001' }));
      await createSession(makeSession({ id: 'sess-002' }));
      await createSession(makeSession({ id: 'sess-003' }));

      const limited = await listSessions({ limit: 2 });
      expect(limited).toHaveLength(2);
    });

    it('orders by startedAt descending', async () => {
      const { createSession, listSessions } = await import('../session-store.js');
      const t1 = '2026-01-01T00:00:00.000Z';
      const t2 = '2026-01-02T00:00:00.000Z';
      const t3 = '2026-01-03T00:00:00.000Z';

      await createSession(makeSession({ id: 'sess-old', startedAt: t1 }));
      await createSession(makeSession({ id: 'sess-mid', startedAt: t2 }));
      await createSession(makeSession({ id: 'sess-new', startedAt: t3 }));

      const sessions = await listSessions();
      expect(sessions[0]!.id).toBe('sess-new');
      expect(sessions[2]!.id).toBe('sess-old');
    });
  });

  // === endSession ===

  describe('endSession', () => {
    it('ends a session', async () => {
      const { createSession, endSession, getSession } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001' }));

      const ended = await endSession('sess-001');
      expect(ended).not.toBeNull();
      expect(ended!.status).toBe('ended');
      expect(ended!.endedAt).toBeDefined();
    });

    it('appends note when ending', async () => {
      const { createSession, endSession } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001', notes: ['Existing note'] }));

      const ended = await endSession('sess-001', 'Completed all tasks');
      expect(ended!.notes).toContain('Existing note');
      expect(ended!.notes).toContain('Completed all tasks');
    });

    it('returns null for non-existent session', async () => {
      const { endSession } = await import('../session-store.js');
      const result = await endSession('nonexistent');
      expect(result).toBeNull();
    });
  });

  // === Focus operations ===

  describe('setFocus', () => {
    it('sets focus on a task', async () => {
      const { createSession, setFocus, getFocus } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001' }));

      await setFocus('sess-001', 'T001');

      const focus = await getFocus('sess-001');
      expect(focus.taskId).toBe('T001');
      expect(focus.since).toBeDefined();
    });

    it('updates focus when set again', async () => {
      const { createSession, setFocus, getFocus } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001' }));

      await setFocus('sess-001', 'T001');
      await setFocus('sess-001', 'T002');

      const focus = await getFocus('sess-001');
      expect(focus.taskId).toBe('T002');
    });
  });

  describe('getFocus', () => {
    it('returns null taskId when no focus is set', async () => {
      const { createSession, getFocus } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001' }));

      const focus = await getFocus('sess-001');
      expect(focus.taskId).toBeNull();
    });

    it('returns null for non-existent session', async () => {
      const { getFocus } = await import('../session-store.js');
      const focus = await getFocus('nonexistent');
      expect(focus.taskId).toBeNull();
      expect(focus.since).toBeNull();
    });
  });

  describe('clearFocus', () => {
    it('clears the current focus', async () => {
      const { createSession, setFocus, clearFocus, getFocus } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001' }));
      await setFocus('sess-001', 'T001');

      await clearFocus('sess-001');

      const focus = await getFocus('sess-001');
      expect(focus.taskId).toBeNull();
    });
  });

  describe('focusHistory', () => {
    it('records focus changes in history', async () => {
      const { createSession, setFocus, focusHistory } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001' }));

      await setFocus('sess-001', 'T001');
      await setFocus('sess-001', 'T002');
      await setFocus('sess-001', 'T003');

      const history = await focusHistory('sess-001');
      // History should contain entries for T001, T002, T003
      // Ordered by setAt descending
      expect(history.length).toBeGreaterThanOrEqual(3);
      expect(history[0]!.taskId).toBe('T003');
    });

    it('respects limit parameter', async () => {
      const { createSession, setFocus, focusHistory } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001' }));

      await setFocus('sess-001', 'T001');
      await setFocus('sess-001', 'T002');
      await setFocus('sess-001', 'T003');

      const history = await focusHistory('sess-001', 2);
      expect(history).toHaveLength(2);
    });

    it('returns empty array for no history', async () => {
      const { createSession, focusHistory } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001' }));

      const history = await focusHistory('sess-001');
      expect(history).toEqual([]);
    });
  });

  // === Lifecycle ===

  describe('getActiveSession', () => {
    it('returns the active session', async () => {
      const { createSession, getActiveSession } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001', status: 'active' }));
      await createSession(makeSession({ id: 'sess-002', status: 'ended' }));

      const active = await getActiveSession();
      expect(active).not.toBeNull();
      expect(active!.id).toBe('sess-001');
    });

    it('returns null when no active session', async () => {
      const { createSession, getActiveSession } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001', status: 'ended' }));

      const active = await getActiveSession();
      expect(active).toBeNull();
    });

    it('returns most recent active session when multiple exist', async () => {
      const { createSession, getActiveSession } = await import('../session-store.js');
      await createSession(makeSession({
        id: 'sess-old',
        status: 'active',
        startedAt: '2026-01-01T00:00:00.000Z',
      }));
      await createSession(makeSession({
        id: 'sess-new',
        status: 'active',
        startedAt: '2026-01-02T00:00:00.000Z',
      }));

      const active = await getActiveSession();
      expect(active!.id).toBe('sess-new');
    });
  });

  describe('gcSessions', () => {
    it('marks ended sessions as orphaned', async () => {
      const { createSession, gcSessions, getSession } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001', status: 'ended' }));

      const count = await gcSessions();
      expect(count).toBe(1);

      const session = await getSession('sess-001');
      expect(session!.status).toBe('orphaned');
    });

    it('does not affect active sessions', async () => {
      const { createSession, gcSessions, getSession } = await import('../session-store.js');
      await createSession(makeSession({ id: 'sess-001', status: 'active' }));

      const count = await gcSessions();
      expect(count).toBe(0);

      const session = await getSession('sess-001');
      expect(session!.status).toBe('active');
    });
  });
});
