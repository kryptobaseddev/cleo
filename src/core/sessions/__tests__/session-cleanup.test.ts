/**
 * Tests for session cleanup and auto-end of stale active sessions.
 *
 * @task T2304
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '../../../types/session.js';

// Mock data-accessor before importing cleanup module
vi.mock('../../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
}));

// Mock config module to control retention settings
vi.mock('../../config.js', () => ({
  getRawConfigValue: vi.fn(),
}));

import { cleanupSessions } from '../session-cleanup.js';
import { getAccessor } from '../../../store/data-accessor.js';
import { getRawConfigValue } from '../../config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-test-1',
    name: 'Test session',
    status: 'active',
    scope: { type: 'epic', epicId: 'T100' },
    taskWork: { taskId: null, setAt: null },
    startedAt: new Date().toISOString(),
    tasksCompleted: [],
    tasksCreated: [],
    notes: [],
    ...overrides,
  };
}

/** Create a date N days in the past. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function setupMockAccessor(sessions: Session[]) {
  const mockAccessor = {
    loadSessions: vi.fn().mockResolvedValue(sessions),
    saveSessions: vi.fn().mockResolvedValue(undefined),
    loadTaskFile: vi.fn().mockResolvedValue({
      tasks: [],
      _meta: {
        schemaVersion: '2.10.0',
      },
    }),
    saveTaskFile: vi.fn().mockResolvedValue(undefined),
    loadArchive: vi.fn().mockResolvedValue(null),
    saveArchive: vi.fn().mockResolvedValue(undefined),
    appendLog: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    engine: 'sqlite' as const,
  };

  (getAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockAccessor);
  return mockAccessor;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleanupSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no config override (use default 7 days)
    (getRawConfigValue as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  // ---- Auto-end stale active sessions (T2304) ----

  describe('auto-end stale active sessions', () => {
    it('auto-ends sessions older than the default threshold (7 days)', async () => {
      const staleSession = makeSession({
        id: 'session-stale',
        startedAt: daysAgo(8),
      });
      const store = setupMockAccessor([staleSession]);

      const result = await cleanupSessions('/fake/project');

      expect(result.autoEnded).toContain('session-stale');
      expect(result.cleaned).toBe(true);

      // Verify the session was mutated to 'ended'
      const savedSessions = store.saveSessions.mock.calls[0]![0] as Session[];
      const ended = savedSessions.find((s) => s.id === 'session-stale')!;
      expect(ended.status).toBe('ended');
      expect(ended.endedAt).toBeDefined();
      expect(ended.notes).toEqual(
        expect.arrayContaining([expect.stringContaining('Auto-ended')]),
      );
    });

    it('does NOT auto-end recently active sessions', async () => {
      const recentSession = makeSession({
        id: 'session-recent',
        startedAt: daysAgo(1), // 1 day old, well within threshold
      });
      setupMockAccessor([recentSession]);

      const result = await cleanupSessions('/fake/project');

      expect(result.autoEnded).toHaveLength(0);
      expect(result.cleaned).toBe(false);
    });

    it('does NOT auto-end sessions that are already ended', async () => {
      const endedSession = makeSession({
        id: 'session-ended',
        status: 'ended',
        startedAt: daysAgo(30),
        endedAt: daysAgo(29),
      });
      setupMockAccessor([endedSession]);

      const result = await cleanupSessions('/fake/project');

      expect(result.autoEnded).toHaveLength(0);
    });

    it('auto-ends multiple stale sessions at once', async () => {
      const sessions = [
        makeSession({ id: 'stale-1', startedAt: daysAgo(10) }),
        makeSession({ id: 'stale-2', startedAt: daysAgo(15) }),
        makeSession({ id: 'recent', startedAt: daysAgo(2) }),
      ];
      setupMockAccessor(sessions);

      const result = await cleanupSessions('/fake/project');

      expect(result.autoEnded).toEqual(['stale-1', 'stale-2']);
      expect(result.autoEnded).not.toContain('recent');
    });

    it('preserves session data when auto-ending (only changes status, endedAt, notes)', async () => {
      const originalSession = makeSession({
        id: 'session-preserve',
        name: 'Important Work',
        scope: { type: 'epic', epicId: 'T500' },
        startedAt: daysAgo(10),
        tasksCompleted: ['T501', 'T502'],
        tasksCreated: ['T503'],
        notes: ['Started work on feature X'],
      });
      const store = setupMockAccessor([originalSession]);

      await cleanupSessions('/fake/project');

      const savedSessions = store.saveSessions.mock.calls[0]![0] as Session[];
      const ended = savedSessions.find((s) => s.id === 'session-preserve')!;

      // Data preserved
      expect(ended.name).toBe('Important Work');
      expect(ended.scope).toEqual({ type: 'epic', epicId: 'T500' });
      expect(ended.tasksCompleted).toEqual(['T501', 'T502']);
      expect(ended.tasksCreated).toEqual(['T503']);
      // Original note preserved, auto-end note appended
      expect(ended.notes).toContain('Started work on feature X');
      expect(ended.notes!.length).toBe(2);
    });
  });

  // ---- Configurable timeout ----

  describe('configurable timeout', () => {
    it('uses retention.autoEndActiveAfterDays from config', async () => {
      // Config says 3 days
      (getRawConfigValue as ReturnType<typeof vi.fn>).mockResolvedValue(3);

      const session = makeSession({
        id: 'session-4days',
        startedAt: daysAgo(4), // 4 days old, exceeds 3-day threshold
      });
      setupMockAccessor([session]);

      const result = await cleanupSessions('/fake/project');

      expect(result.autoEnded).toContain('session-4days');
    });

    it('does NOT auto-end session within custom threshold', async () => {
      // Config says 10 days
      (getRawConfigValue as ReturnType<typeof vi.fn>).mockResolvedValue(10);

      const session = makeSession({
        id: 'session-8days',
        startedAt: daysAgo(8), // 8 days old, within 10-day threshold
      });
      setupMockAccessor([session]);

      const result = await cleanupSessions('/fake/project');

      expect(result.autoEnded).toHaveLength(0);
    });

    it('falls back to default 7 days when config value is invalid', async () => {
      (getRawConfigValue as ReturnType<typeof vi.fn>).mockResolvedValue('not-a-number');

      const session = makeSession({
        id: 'session-8days',
        startedAt: daysAgo(8),
      });
      setupMockAccessor([session]);

      const result = await cleanupSessions('/fake/project');

      // 8 days > 7 day default → auto-ended
      expect(result.autoEnded).toContain('session-8days');
    });
  });

  // ---- Existing cleanup behavior preserved ----

  describe('existing cleanup behavior', () => {
    it('identifies archived sessions for removal', async () => {
      const archivedSession = makeSession({
        id: 'session-archived',
        status: 'archived' as Session['status'],
        startedAt: daysAgo(20),
      });
      setupMockAccessor([archivedSession]);

      const result = await cleanupSessions('/fake/project');

      expect(result.removed).toContain('session-archived');
    });

    it('cleans stale activeSession reference in task file', async () => {
      const endedSession = makeSession({
        id: 'session-ended',
        status: 'ended',
        startedAt: daysAgo(2),
      });
      const store = setupMockAccessor([endedSession]);
      // Override task file to have a stale activeSession reference
      store.loadTaskFile.mockResolvedValue({
        tasks: [],
        _meta: {
          schemaVersion: '2.10.0',
          activeSession: 'session-ended', // Points to a non-active session
          generation: 5,
        },
      });

      const result = await cleanupSessions('/fake/project');

      expect(result.cleaned).toBe(true);
      expect(store.saveTaskFile).toHaveBeenCalled();
    });
  });
});
