/**
 * Tests for session handoff scope resolution and data computation.
 *
 * Validates that getScopeTaskIds (via public API) correctly resolves
 * task scope using rootTaskId, epicId, explicitTaskIds, and global mode.
 *
 * @task T4915
 * @epic T4914
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '../../../types/session.js';

// Mock data-accessor before importing handoff module
vi.mock('../../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
  createDataAccessor: vi.fn(),
}));

// Mock decisions module
vi.mock('../decisions.js', () => ({
  getDecisionLog: vi.fn().mockResolvedValue([]),
}));

import { computeHandoff, getLastHandoff } from '../handoff.js';
import { getAccessor } from '../../../store/data-accessor.js';

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

function makeMockTasks() {
  return [
    { id: 'T100', status: 'active', parentId: undefined, title: 'Epic', description: 'Epic task', type: 'epic', priority: 'high' },
    { id: 'T101', status: 'pending', parentId: 'T100', title: 'Child 1', description: 'Child task 1', priority: 'medium' },
    { id: 'T102', status: 'blocked', parentId: 'T100', title: 'Child 2 (blocked)', description: 'Blocked child', priority: 'medium' },
    { id: 'T103', status: 'pending', parentId: 'T101', title: 'Grandchild', description: 'Grandchild task', priority: 'low' },
    { id: 'T200', status: 'pending', parentId: undefined, title: 'Outside epic', description: 'Not in scope', priority: 'medium' },
    { id: 'T300', status: 'active', parentId: undefined, title: 'Bug', description: 'Bug task', type: 'bug', labels: ['bug'], priority: 'high' },
  ];
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-test-1',
    name: 'Test session',
    status: 'active',
    scope: { type: 'epic', epicId: 'T100' },
    taskWork: { taskId: null, setAt: null },
    startedAt: '2026-02-01T10:00:00Z',
    tasksCompleted: [],
    tasksCreated: [],
    notes: [],
    ...overrides,
  };
}

function setupMockAccessor(sessions: Session[], tasks: unknown[] = makeMockTasks()) {
  const mockAccessor = {
    loadSessions: vi.fn().mockResolvedValue({
      version: '1.0.0',
      sessions,
      _meta: { schemaVersion: '1.0.0', lastUpdated: new Date().toISOString() },
    }),
    saveSessions: vi.fn().mockResolvedValue(undefined),
    loadTaskFile: vi.fn().mockResolvedValue({
      tasks,
      focus: { currentTask: null, currentPhase: null },
      _meta: { schemaVersion: '2.10.0' },
    }),
    loadArchive: vi.fn().mockResolvedValue(null),
    saveArchive: vi.fn().mockResolvedValue(undefined),
    saveTaskFile: vi.fn().mockResolvedValue(undefined),
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

describe('computeHandoff scope resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scopes tasks to epicId and its descendants', async () => {
    const session = makeSession({
      scope: { type: 'epic', epicId: 'T100' },
    });
    setupMockAccessor([session]);

    const handoff = await computeHandoff('/fake/project', {
      sessionId: 'session-test-1',
    });

    // T100 has children T101, T102 and grandchild T103 — all in scope.
    // computeNextSuggested includes non-done/completed/archived/cancelled tasks,
    // sorted by priority and limited to top 3.
    // In scope: T100 (active, high), T101 (pending, medium), T102 (blocked, medium), T103 (pending, low)
    // Top 3 by priority: T100, T101, T102 — T103 is cut by the limit.
    expect(handoff.nextSuggested).toContain('T100');
    expect(handoff.nextSuggested).toContain('T101');
    // Out-of-scope tasks must never appear
    expect(handoff.nextSuggested).not.toContain('T200');
    expect(handoff.nextSuggested).not.toContain('T300');

    // openBlockers should include T102 (blocked, in scope) but not anything outside
    expect(handoff.openBlockers).toContain('T102');

    // openBugs: T300 is a bug but outside scope
    expect(handoff.openBugs).not.toContain('T300');
  });

  it('scopes tasks to rootTaskId when epicId is absent', async () => {
    const session = makeSession({
      scope: { type: 'epic', rootTaskId: 'T100' },
    });
    // Remove epicId to ensure rootTaskId is the only key
    delete (session.scope as Record<string, unknown>).epicId;

    setupMockAccessor([session]);

    const handoff = await computeHandoff('/fake/project', {
      sessionId: 'session-test-1',
    });

    // rootTaskId=T100 should still scope correctly
    expect(handoff.nextSuggested).toEqual(expect.arrayContaining(['T101']));
    expect(handoff.nextSuggested).not.toContain('T200');
    expect(handoff.openBlockers).toContain('T102');
  });

  it('rootTaskId takes precedence when both epicId and rootTaskId are present', async () => {
    // Session has epicId=T200 but rootTaskId=T100 — rootTaskId wins
    const session = makeSession({
      scope: { type: 'epic', epicId: 'T200', rootTaskId: 'T100' },
    });
    setupMockAccessor([session]);

    const handoff = await computeHandoff('/fake/project', {
      sessionId: 'session-test-1',
    });

    // rootTaskId=T100 takes precedence, so descendants of T100 should be in scope
    expect(handoff.nextSuggested).toEqual(expect.arrayContaining(['T101']));
    expect(handoff.nextSuggested).not.toContain('T200');
    expect(handoff.openBlockers).toContain('T102');
  });

  it('global scope includes all tasks', async () => {
    const session = makeSession({
      scope: { type: 'global' },
    });
    setupMockAccessor([session]);

    const handoff = await computeHandoff('/fake/project', {
      sessionId: 'session-test-1',
    });

    // Global scope includes ALL tasks. nextSuggested is top 3 by priority.
    // High priority: T100 (active, high), T300 (active, high)
    // Medium priority: T101, T102, T200
    // Low priority: T103
    // Top 3: T100, T300, and one of the medium-priority tasks (T101 by array order)
    expect(handoff.nextSuggested).toContain('T100');
    expect(handoff.nextSuggested).toContain('T300');
    expect(handoff.nextSuggested).toHaveLength(3);

    // T102 is blocked — should be in openBlockers
    expect(handoff.openBlockers).toContain('T102');

    // T300 is a bug — should be in openBugs
    expect(handoff.openBugs).toContain('T300');
  });

  it('falls back to global when epic scope has no rootTaskId or epicId', async () => {
    const session = makeSession({
      scope: { type: 'epic' },
    });
    // Remove both epicId and rootTaskId
    delete (session.scope as Record<string, unknown>).epicId;
    delete (session.scope as Record<string, unknown>).rootTaskId;

    setupMockAccessor([session]);

    const handoff = await computeHandoff('/fake/project', {
      sessionId: 'session-test-1',
    });

    // Should fall back to global — all tasks in scope.
    // Verify out-of-hierarchy tasks are now included (T300 is a bug and active).
    expect(handoff.openBugs).toContain('T300');
    // T102 is blocked in the full set
    expect(handoff.openBlockers).toContain('T102');
    // nextSuggested should include tasks from the full set
    expect(handoff.nextSuggested.length).toBeGreaterThan(0);
  });

  it('includes explicitTaskIds in scope set', async () => {
    const session = makeSession({
      scope: { type: 'epic', epicId: 'T100' },
    });
    // Add explicitTaskIds via runtime-safe cast (matches handoff.ts pattern)
    (session.scope as unknown as Record<string, unknown>).explicitTaskIds = ['T200', 'T300'];

    setupMockAccessor([session]);

    const handoff = await computeHandoff('/fake/project', {
      sessionId: 'session-test-1',
    });

    // T200 and T300 are outside T100's hierarchy but included via explicitTaskIds.
    // T300 is a bug and active — should appear in openBugs (proves it's in scope).
    expect(handoff.openBugs).toContain('T300');

    // The scope now includes T100 hierarchy + T200 + T300.
    // Without explicitTaskIds, T200 and T300 would NOT be in scope.
    // nextSuggested top-3 by priority: T100(high), T300(high), then a medium task.
    // The key assertion: T300 is in scope (via explicitTaskIds) and appears in bugs.
    // Also verify T200 is in scope by checking it could appear in suggestions
    // (it has medium priority, so it may or may not be in top 3).
    // Instead, verify the total scope indirectly: openBlockers should still have T102.
    expect(handoff.openBlockers).toContain('T102');
    // And nextSuggested should have tasks from both the hierarchy and explicit set
    expect(handoff.nextSuggested.length).toBeGreaterThan(0);
    expect(handoff.nextSuggested).toContain('T100');
  });

  it('applies human overrides to handoff', async () => {
    const session = makeSession({
      scope: { type: 'global' },
    });
    setupMockAccessor([session]);

    const handoff = await computeHandoff('/fake/project', {
      sessionId: 'session-test-1',
      note: 'Remember to check T200',
      nextAction: 'Start with T101',
    });

    expect(handoff.note).toBe('Remember to check T200');
    expect(handoff.nextAction).toBe('Start with T101');
  });

  it('throws when session not found', async () => {
    setupMockAccessor([]);

    await expect(
      computeHandoff('/fake/project', { sessionId: 'session-nonexistent' }),
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// getLastHandoff tests
// ---------------------------------------------------------------------------

describe('getLastHandoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no sessions exist', async () => {
    setupMockAccessor([]);

    const result = await getLastHandoff('/fake/project');
    expect(result).toBeNull();
  });

  it('returns null when no ended sessions have handoff data', async () => {
    const session = makeSession({
      status: 'ended',
      endedAt: '2026-02-01T12:00:00Z',
    });
    // No handoffJson set
    setupMockAccessor([session]);

    const result = await getLastHandoff('/fake/project');
    expect(result).toBeNull();
  });

  it('returns handoff from most recent ended session', async () => {
    const handoffData = {
      lastTask: 'T101',
      tasksCompleted: ['T103'],
      tasksCreated: [],
      decisionsRecorded: 0,
      nextSuggested: ['T101'],
      openBlockers: [],
      openBugs: [],
    };

    const older = makeSession({
      id: 'session-old',
      status: 'ended',
      endedAt: '2026-02-01T10:00:00Z',
      handoffJson: JSON.stringify({ ...handoffData, lastTask: 'T200' }),
    });
    const newer = makeSession({
      id: 'session-new',
      status: 'ended',
      endedAt: '2026-02-01T14:00:00Z',
      handoffJson: JSON.stringify(handoffData),
    });

    setupMockAccessor([older, newer]);

    const result = await getLastHandoff('/fake/project');
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('session-new');
    expect(result!.handoff.lastTask).toBe('T101');
  });

  it('filters by epic scope matching rootTaskId', async () => {
    const handoffA = {
      lastTask: 'T101',
      tasksCompleted: [],
      tasksCreated: [],
      decisionsRecorded: 0,
      nextSuggested: [],
      openBlockers: [],
      openBugs: [],
    };
    const handoffB = { ...handoffA, lastTask: 'T200' };

    const sessionA = makeSession({
      id: 'session-epic-a',
      status: 'ended',
      scope: { type: 'epic', epicId: 'T100', rootTaskId: 'T100' },
      endedAt: '2026-02-01T12:00:00Z',
      handoffJson: JSON.stringify(handoffA),
    });
    const sessionB = makeSession({
      id: 'session-epic-b',
      status: 'ended',
      scope: { type: 'epic', epicId: 'T500', rootTaskId: 'T500' },
      endedAt: '2026-02-01T14:00:00Z',
      handoffJson: JSON.stringify(handoffB),
    });

    setupMockAccessor([sessionA, sessionB]);

    // Filter by epicId=T100 — should return sessionA
    const result = await getLastHandoff('/fake/project', {
      type: 'epic',
      epicId: 'T100',
    });
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('session-epic-a');
    expect(result!.handoff.lastTask).toBe('T101');
  });

  it('matches rootTaskId when scope only has rootTaskId (no epicId)', async () => {
    const handoffData = {
      lastTask: 'T101',
      tasksCompleted: [],
      tasksCreated: [],
      decisionsRecorded: 0,
      nextSuggested: [],
      openBlockers: [],
      openBugs: [],
    };

    const session = makeSession({
      id: 'session-root-only',
      status: 'ended',
      scope: { type: 'epic', rootTaskId: 'T100' },
      endedAt: '2026-02-01T12:00:00Z',
      handoffJson: JSON.stringify(handoffData),
    });
    // Remove epicId to simulate engine-layer session
    delete (session.scope as Record<string, unknown>).epicId;

    setupMockAccessor([session]);

    const result = await getLastHandoff('/fake/project', {
      type: 'epic',
      epicId: 'T100',
    });
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('session-root-only');
  });

  it('filters by global scope', async () => {
    const handoffData = {
      lastTask: null,
      tasksCompleted: [],
      tasksCreated: [],
      decisionsRecorded: 0,
      nextSuggested: [],
      openBlockers: [],
      openBugs: [],
    };

    const epicSession = makeSession({
      id: 'session-epic',
      status: 'ended',
      scope: { type: 'epic', epicId: 'T100' },
      endedAt: '2026-02-01T14:00:00Z',
      handoffJson: JSON.stringify(handoffData),
    });
    const globalSession = makeSession({
      id: 'session-global',
      status: 'ended',
      scope: { type: 'global' },
      endedAt: '2026-02-01T12:00:00Z',
      handoffJson: JSON.stringify(handoffData),
    });

    setupMockAccessor([epicSession, globalSession]);

    const result = await getLastHandoff('/fake/project', { type: 'global' });
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('session-global');
  });

  it('skips sessions with malformed handoffJson', async () => {
    const validHandoff = {
      lastTask: 'T101',
      tasksCompleted: [],
      tasksCreated: [],
      decisionsRecorded: 0,
      nextSuggested: [],
      openBlockers: [],
      openBugs: [],
    };

    const malformed = makeSession({
      id: 'session-bad',
      status: 'ended',
      endedAt: '2026-02-01T14:00:00Z',
      handoffJson: '{invalid json',
    });
    const valid = makeSession({
      id: 'session-good',
      status: 'ended',
      endedAt: '2026-02-01T12:00:00Z',
      handoffJson: JSON.stringify(validHandoff),
    });

    setupMockAccessor([malformed, valid]);

    const result = await getLastHandoff('/fake/project');
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('session-good');
  });
});
