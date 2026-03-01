/**
 * Session Context Safety Integration Tests
 *
 * Engine-level tests verifying:
 * - session.find returns minimal records (no heavy fields)
 * - session.list enforces default limit=10 with _meta truncation
 * - session.list respects explicit limits
 * - session.find filters by status and scope
 * - Budget enforcement prevents unbounded queries
 *
 * @task T5122
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '../../../types/session.js';

// ---------------------------------------------------------------------------
// Mocks — mirror the pattern from session-handoff-fix.test.ts
// ---------------------------------------------------------------------------

const mockLoadSessions = vi.fn<() => Promise<Session[]>>();
const mockSaveSessions = vi.fn<(sessions: Session[]) => Promise<void>>();
const mockLoadTaskFile = vi.fn();
const mockSaveTaskFile = vi.fn();

vi.mock('../../../store/data-accessor.js', () => ({
  getAccessor: vi.fn().mockImplementation(() =>
    Promise.resolve({
      loadSessions: mockLoadSessions,
      saveSessions: mockSaveSessions,
      loadTaskFile: mockLoadTaskFile,
      saveTaskFile: mockSaveTaskFile,
    }),
  ),
}));

vi.mock('../../../core/sessions/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/sessions/index.js')>();
  return {
    ...actual,
    // Keep findSessions real — it's the core logic we're testing through the engine
    findSessions: actual.findSessions,
    // Mock the rest to prevent side effects
    showSession: vi.fn(),
    suspendSession: vi.fn(),
    getSessionHistory: vi.fn(),
    cleanupSessions: vi.fn(),
    getSessionStats: vi.fn(),
    switchSession: vi.fn(),
    archiveSessions: vi.fn(),
    getContextDrift: vi.fn(),
    recordDecision: vi.fn(),
    getDecisionLog: vi.fn(),
    recordAssumption: vi.fn(),
    computeHandoff: vi.fn(),
    persistHandoff: vi.fn(),
    getLastHandoff: vi.fn(),
    computeBriefing: vi.fn(),
  };
});

vi.mock('../../../core/sessions/handoff.js', () => ({
  computeDebrief: vi.fn(),
}));

vi.mock('../../../core/sessions/session-id.js', () => ({
  generateSessionId: vi.fn().mockReturnValue('ses-test-001'),
}));

vi.mock('../../../core/task-work/index.js', () => ({
  currentTask: vi.fn(),
  startTask: vi.fn(),
  stopTask: vi.fn(),
}));

import { sessionFind, sessionList } from '../session-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    name: overrides.name ?? `Session ${overrides.id}`,
    status: overrides.status ?? 'active',
    scope: overrides.scope ?? { type: 'epic', rootTaskId: 'T001', includeDescendants: true },
    taskWork: overrides.taskWork ?? { taskId: null, setAt: null },
    startedAt: overrides.startedAt ?? new Date().toISOString(),
    resumeCount: 0,
    stats: {
      tasksCompleted: 0,
      tasksCreated: 0,
      tasksUpdated: 0,
      focusChanges: 0,
      totalActiveMinutes: 0,
      suspendCount: 0,
    },
    ...overrides,
  } as Session;
}

function makeSessions(count: number, overrides?: Partial<Session>): Session[] {
  return Array.from({ length: count }, (_, i) =>
    makeSession({
      id: `session-${String(i + 1).padStart(3, '0')}`,
      name: `Session ${i + 1}`,
      status: 'active',
      startedAt: new Date(2026, 0, i + 1).toISOString(),
      ...overrides,
    }),
  );
}

const PROJECT_ROOT = '/mock/project';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session Context Safety (T5122)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // 1. session.find returns minimal records
  // =========================================================================

  describe('session.find returns minimal records', () => {
    it('returns only id, name, status, startedAt, scope fields', async () => {
      const sessions = [
        makeSession({
          id: 'ses-1',
          name: 'Alpha',
          notes: ['important note'],
          handoffJson: '{"key":"value"}',
          tasksCompleted: ['T100', 'T101'],
        }),
        makeSession({
          id: 'ses-2',
          name: 'Beta',
          notes: ['another note'],
          debriefJson: '{"data":"debrief"}',
          agentIdentifier: 'agent-007',
        }),
        makeSession({
          id: 'ses-3',
          name: 'Gamma',
        }),
      ];

      mockLoadSessions.mockResolvedValue(sessions);

      const result = await sessionFind(PROJECT_ROOT);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(3);

      for (const record of result.data!) {
        const keys = Object.keys(record).sort();
        expect(keys).toEqual(['id', 'name', 'scope', 'startedAt', 'status']);
      }
    });

    it('does NOT include heavy fields like notes, taskWork, handoffJson, tasksCompleted', async () => {
      const richSession = makeSession({
        id: 'ses-rich',
        notes: ['note1', 'note2'],
        handoffJson: '{"big":"payload"}',
        tasksCompleted: ['T200', 'T201', 'T202'],
        debriefJson: '{"debrief":"data"}',
        agentIdentifier: 'agent-x',
        previousSessionId: 'ses-prev',
        nextSessionId: 'ses-next',
        gradeMode: true,
      });

      mockLoadSessions.mockResolvedValue([richSession]);

      const result = await sessionFind(PROJECT_ROOT);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);

      const record = result.data![0] as Record<string, unknown>;
      // These heavy fields must NOT be present
      expect(record['notes']).toBeUndefined();
      expect(record['taskWork']).toBeUndefined();
      expect(record['handoffJson']).toBeUndefined();
      expect(record['tasksCompleted']).toBeUndefined();
      expect(record['tasksCreated']).toBeUndefined();
      expect(record['debriefJson']).toBeUndefined();
      expect(record['agentIdentifier']).toBeUndefined();
      expect(record['previousSessionId']).toBeUndefined();
      expect(record['nextSessionId']).toBeUndefined();
      expect(record['gradeMode']).toBeUndefined();
      expect(record['stats']).toBeUndefined();
      expect(record['resumeCount']).toBeUndefined();

      // These minimal fields MUST be present
      expect(record['id']).toBe('ses-rich');
      expect(record['name']).toBeDefined();
      expect(record['status']).toBeDefined();
      expect(record['startedAt']).toBeDefined();
      expect(record['scope']).toBeDefined();
    });
  });

  // =========================================================================
  // 2. session.list defaults to limit=10
  // =========================================================================

  describe('session.list defaults to limit=10', () => {
    it('returns at most 10 results when no limit is specified', async () => {
      const sessions = makeSessions(15);
      mockLoadSessions.mockResolvedValue(sessions);

      const result = await sessionList(PROJECT_ROOT);

      expect(result.success).toBe(true);
      expect(result.data!.sessions).toHaveLength(10);
    });

    it('sets _meta.truncated=true when total exceeds default limit', async () => {
      const sessions = makeSessions(15);
      mockLoadSessions.mockResolvedValue(sessions);

      const result = await sessionList(PROJECT_ROOT);

      expect(result.data!._meta.truncated).toBe(true);
    });

    it('sets _meta.total to actual total count', async () => {
      const sessions = makeSessions(15);
      mockLoadSessions.mockResolvedValue(sessions);

      const result = await sessionList(PROJECT_ROOT);

      expect(result.data!._meta.total).toBe(15);
    });
  });

  // =========================================================================
  // 3. session.list respects explicit limit
  // =========================================================================

  describe('session.list respects explicit limit', () => {
    it('returns exactly the requested number of sessions', async () => {
      const sessions = makeSessions(15);
      mockLoadSessions.mockResolvedValue(sessions);

      const result = await sessionList(PROJECT_ROOT, { limit: 5 });

      expect(result.success).toBe(true);
      expect(result.data!.sessions).toHaveLength(5);
    });

    it('sets _meta.truncated=true when limit < total', async () => {
      const sessions = makeSessions(15);
      mockLoadSessions.mockResolvedValue(sessions);

      const result = await sessionList(PROJECT_ROOT, { limit: 5 });

      expect(result.data!._meta.truncated).toBe(true);
      expect(result.data!._meta.total).toBe(15);
    });
  });

  // =========================================================================
  // 4. session.list with limit >= total sets truncated=false
  // =========================================================================

  describe('session.list with limit >= total sets truncated=false', () => {
    it('returns all sessions when limit exceeds total', async () => {
      const sessions = makeSessions(3);
      mockLoadSessions.mockResolvedValue(sessions);

      const result = await sessionList(PROJECT_ROOT, { limit: 100 });

      expect(result.success).toBe(true);
      expect(result.data!.sessions).toHaveLength(3);
      expect(result.data!._meta.truncated).toBe(false);
      expect(result.data!._meta.total).toBe(3);
    });

    it('returns all sessions when limit equals total', async () => {
      const sessions = makeSessions(5);
      mockLoadSessions.mockResolvedValue(sessions);

      const result = await sessionList(PROJECT_ROOT, { limit: 5 });

      expect(result.success).toBe(true);
      expect(result.data!.sessions).toHaveLength(5);
      expect(result.data!._meta.truncated).toBe(false);
      expect(result.data!._meta.total).toBe(5);
    });
  });

  // =========================================================================
  // 5. session.find filters by status
  // =========================================================================

  describe('session.find filters by status', () => {
    it('returns only sessions matching the requested status', async () => {
      const sessions = [
        makeSession({ id: 'ses-active-1', status: 'active', startedAt: '2026-01-01T00:00:00Z' }),
        makeSession({ id: 'ses-ended-1', status: 'ended', startedAt: '2026-01-02T00:00:00Z' }),
        makeSession({ id: 'ses-active-2', status: 'active', startedAt: '2026-01-03T00:00:00Z' }),
        makeSession({ id: 'ses-ended-2', status: 'ended', startedAt: '2026-01-04T00:00:00Z' }),
      ];

      mockLoadSessions.mockResolvedValue(sessions);

      const result = await sessionFind(PROJECT_ROOT, { status: 'ended' });

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.data!.every((r) => r.status === 'ended')).toBe(true);
    });

    it('returns empty array when no sessions match the status', async () => {
      const sessions = [
        makeSession({ id: 'ses-1', status: 'active' }),
        makeSession({ id: 'ses-2', status: 'active' }),
      ];

      mockLoadSessions.mockResolvedValue(sessions);

      const result = await sessionFind(PROJECT_ROOT, { status: 'ended' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });
  });

  // =========================================================================
  // 6. session.find filters by scope
  // =========================================================================

  describe('session.find filters by scope', () => {
    it('returns only sessions matching scope type and ID', async () => {
      const sessions = [
        makeSession({ id: 'ses-1', scope: { type: 'epic', rootTaskId: 'T001', includeDescendants: true }, startedAt: '2026-01-01T00:00:00Z' }),
        makeSession({ id: 'ses-2', scope: { type: 'epic', rootTaskId: 'T002', includeDescendants: true }, startedAt: '2026-01-02T00:00:00Z' }),
        makeSession({ id: 'ses-3', scope: { type: 'global' }, startedAt: '2026-01-03T00:00:00Z' }),
        makeSession({ id: 'ses-4', scope: { type: 'epic', rootTaskId: 'T001', includeDescendants: true }, startedAt: '2026-01-04T00:00:00Z' }),
      ];

      mockLoadSessions.mockResolvedValue(sessions);

      const result = await sessionFind(PROJECT_ROOT, { scope: 'epic:T001' });

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.data!.map((r) => r.id).sort()).toEqual(['ses-1', 'ses-4']);
    });

    it('returns only sessions matching scope type alone', async () => {
      const sessions = [
        makeSession({ id: 'ses-1', scope: { type: 'epic', rootTaskId: 'T001', includeDescendants: true }, startedAt: '2026-01-01T00:00:00Z' }),
        makeSession({ id: 'ses-2', scope: { type: 'global' }, startedAt: '2026-01-02T00:00:00Z' }),
        makeSession({ id: 'ses-3', scope: { type: 'global' }, startedAt: '2026-01-03T00:00:00Z' }),
      ];

      mockLoadSessions.mockResolvedValue(sessions);

      const result = await sessionFind(PROJECT_ROOT, { scope: 'global' });

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.data!.every((r) => r.scope.type === 'global')).toBe(true);
    });
  });

  // =========================================================================
  // 7. Budget enforcement prevents unbounded queries
  // =========================================================================

  describe('budget enforcement prevents unbounded queries', () => {
    it('returns at most 10 sessions when no limit is provided (default enforcement)', async () => {
      const sessions = makeSessions(20);
      mockLoadSessions.mockResolvedValue(sessions);

      const result = await sessionList(PROJECT_ROOT);

      expect(result.success).toBe(true);
      expect(result.data!.sessions.length).toBeLessThanOrEqual(10);
    });

    it('indicates truncation in _meta when results are capped', async () => {
      const sessions = makeSessions(20);
      mockLoadSessions.mockResolvedValue(sessions);

      const result = await sessionList(PROJECT_ROOT);

      expect(result.data!._meta.truncated).toBe(true);
      expect(result.data!._meta.total).toBe(20);
      expect(result.data!.sessions).toHaveLength(10);
    });

    it('does not truncate when total is within default limit', async () => {
      const sessions = makeSessions(7);
      mockLoadSessions.mockResolvedValue(sessions);

      const result = await sessionList(PROJECT_ROOT);

      expect(result.data!._meta.truncated).toBe(false);
      expect(result.data!._meta.total).toBe(7);
      expect(result.data!.sessions).toHaveLength(7);
    });
  });

  // =========================================================================
  // Additional edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('session.find returns empty array from empty store', async () => {
      mockLoadSessions.mockResolvedValue([]);

      const result = await sessionFind(PROJECT_ROOT);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });

    it('session.list returns empty array with correct _meta from empty store', async () => {
      mockLoadSessions.mockResolvedValue([]);

      const result = await sessionList(PROJECT_ROOT);

      expect(result.success).toBe(true);
      expect(result.data!.sessions).toEqual([]);
      expect(result.data!._meta.truncated).toBe(false);
      expect(result.data!._meta.total).toBe(0);
    });

    it('session.list with active=true filter still enforces default limit', async () => {
      const sessions = makeSessions(15, { status: 'active' });
      mockLoadSessions.mockResolvedValue(sessions);

      const result = await sessionList(PROJECT_ROOT, { active: true });

      expect(result.success).toBe(true);
      expect(result.data!.sessions).toHaveLength(10);
      expect(result.data!._meta.truncated).toBe(true);
      expect(result.data!._meta.total).toBe(15);
    });

    it('session.find combined status+scope filters work together', async () => {
      const sessions = [
        makeSession({ id: 'ses-1', status: 'active', scope: { type: 'epic', rootTaskId: 'T001', includeDescendants: true }, startedAt: '2026-01-01T00:00:00Z' }),
        makeSession({ id: 'ses-2', status: 'ended', scope: { type: 'epic', rootTaskId: 'T001', includeDescendants: true }, startedAt: '2026-01-02T00:00:00Z' }),
        makeSession({ id: 'ses-3', status: 'active', scope: { type: 'epic', rootTaskId: 'T002', includeDescendants: true }, startedAt: '2026-01-03T00:00:00Z' }),
        makeSession({ id: 'ses-4', status: 'ended', scope: { type: 'epic', rootTaskId: 'T002', includeDescendants: true }, startedAt: '2026-01-04T00:00:00Z' }),
      ];

      mockLoadSessions.mockResolvedValue(sessions);

      const result = await sessionFind(PROJECT_ROOT, { status: 'active', scope: 'epic:T001' });

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data![0].id).toBe('ses-1');
    });
  });
});
