/**
 * Tests for session briefing scope filtering.
 *
 * Validates that computeBriefing correctly scope-filters nextTasks, openBugs,
 * blockedTasks, and activeEpics based on the active session scope.
 *
 * @task T4916
 * @epic T4914
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock data-accessor before importing briefing module
vi.mock('../../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
  createDataAccessor: vi.fn(),
}));

// Mock handoff module — getLastHandoff is called by computeLastSession
vi.mock('../handoff.js', () => ({
  getLastHandoff: vi.fn().mockResolvedValue(null),
}));

import { computeBriefing } from '../briefing.js';
import { getAccessor } from '../../../store/data-accessor.js';

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

/**
 * Task hierarchy:
 *
 *   T100 (epic, active)
 *     T101 (pending, medium)
 *     T102 (blocked, medium)
 *     T103 (pending, low)      — child of T101
 *
 *   T200 (pending, high)       — outside T100 hierarchy
 *   T300 (active, bug, high)   — outside T100 hierarchy
 *   T400 (epic, active)        — separate epic outside T100
 *     T401 (pending, medium)
 *   T500 (pending, has unresolved dep on T200)
 */
function makeMockTasks() {
  return [
    {
      id: 'T100', status: 'active', parentId: undefined,
      title: 'Epic A', description: 'Epic task A',
      type: 'epic', priority: 'high',
    },
    {
      id: 'T101', status: 'pending', parentId: 'T100',
      title: 'Child 1', description: 'Child task 1',
      priority: 'medium',
    },
    {
      id: 'T102', status: 'blocked', parentId: 'T100',
      title: 'Child 2 (blocked)', description: 'Blocked child',
      priority: 'medium', blockedBy: 'T999',
    },
    {
      id: 'T103', status: 'pending', parentId: 'T101',
      title: 'Grandchild', description: 'Grandchild task',
      priority: 'low',
    },
    {
      id: 'T200', status: 'pending', parentId: undefined,
      title: 'Outside epic', description: 'Not in scope',
      priority: 'high',
    },
    {
      id: 'T300', status: 'active', parentId: undefined,
      title: 'Bug outside scope', description: 'Bug task',
      type: 'bug', labels: ['bug'], priority: 'high',
      origin: 'bug-report',
    },
    {
      id: 'T400', status: 'active', parentId: undefined,
      title: 'Epic B', description: 'Another epic',
      type: 'epic', priority: 'medium',
    },
    {
      id: 'T401', status: 'pending', parentId: 'T400',
      title: 'Epic B child', description: 'Child of epic B',
      priority: 'medium',
    },
    {
      id: 'T500', status: 'pending', parentId: undefined,
      title: 'Dependent task', description: 'Has unresolved dep',
      priority: 'medium', depends: ['T200'],
    },
  ];
}

function setupMockAccessor(tasks: unknown[] = makeMockTasks(), meta: Record<string, unknown> = {}) {
  const mockAccessor = {
    loadSessions: vi.fn().mockResolvedValue({
      version: '1.0.0',
      sessions: [],
      _meta: { schemaVersion: '1.0.0', lastUpdated: new Date().toISOString() },
    }),
    saveSessions: vi.fn().mockResolvedValue(undefined),
    loadTaskFile: vi.fn().mockResolvedValue({
      tasks,
      focus: { currentTask: null, currentPhase: null },
      _meta: { schemaVersion: '2.10.0', activeSession: null, ...meta },
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

describe('computeBriefing scope filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scope-filters nextTasks with epic scope', async () => {
    setupMockAccessor();

    const briefing = await computeBriefing('/fake/project', {
      scope: 'epic:T100',
    });

    // nextTasks should only include pending tasks under T100
    const nextIds = briefing.nextTasks.map((t) => t.id);

    // T101, T103 are pending and under T100
    expect(nextIds).toContain('T101');
    expect(nextIds).toContain('T103');

    // T200, T401, T500 are outside T100 hierarchy
    expect(nextIds).not.toContain('T200');
    expect(nextIds).not.toContain('T401');
    expect(nextIds).not.toContain('T500');
  });

  it('scope-filters openBugs — bugs outside scope excluded', async () => {
    setupMockAccessor();

    const briefing = await computeBriefing('/fake/project', {
      scope: 'epic:T100',
    });

    // T300 is a bug but outside T100 hierarchy
    const bugIds = briefing.openBugs.map((b) => b.id);
    expect(bugIds).not.toContain('T300');
  });

  it('scope-filters blockedTasks — blocked tasks outside scope excluded', async () => {
    setupMockAccessor();

    const briefing = await computeBriefing('/fake/project', {
      scope: 'epic:T100',
    });

    // T102 is blocked and within T100 scope — should appear
    const blockedIds = briefing.blockedTasks.map((b) => b.id);
    expect(blockedIds).toContain('T102');

    // T500 has unresolved deps but is outside T100 — should not appear
    expect(blockedIds).not.toContain('T500');
  });

  it('scope-filters activeEpics — only in-scope epics appear', async () => {
    setupMockAccessor();

    const briefing = await computeBriefing('/fake/project', {
      scope: 'epic:T100',
    });

    const epicIds = briefing.activeEpics.map((e) => e.id);

    // T100 is the epic itself and is active — may or may not appear depending on
    // whether computeActiveEpics filters by hierarchy. T400 is outside scope.
    expect(epicIds).not.toContain('T400');
  });

  it('global scope includes all tasks', async () => {
    setupMockAccessor();

    const briefing = await computeBriefing('/fake/project', {
      scope: 'global',
    });

    const nextIds = briefing.nextTasks.map((t) => t.id);
    const bugIds = briefing.openBugs.map((b) => b.id);

    // Global scope should include tasks from everywhere
    expect(nextIds).toContain('T101');
    expect(nextIds).toContain('T200');

    // T300 is a bug — should appear in global scope
    expect(bugIds).toContain('T300');

    // T400 is an active epic — should appear
    const epicIds = briefing.activeEpics.map((e) => e.id);
    expect(epicIds).toContain('T400');
  });

  it('no scope returns all tasks (no filtering)', async () => {
    setupMockAccessor();

    const briefing = await computeBriefing('/fake/project', {});

    const nextIds = briefing.nextTasks.map((t) => t.id);

    // Without scope, all pending tasks should appear
    expect(nextIds).toContain('T101');
    expect(nextIds).toContain('T200');
  });

  it('returns empty arrays when no tasks exist', async () => {
    setupMockAccessor([]);

    const briefing = await computeBriefing('/fake/project', {
      scope: 'global',
    });

    expect(briefing.nextTasks).toHaveLength(0);
    expect(briefing.openBugs).toHaveLength(0);
    expect(briefing.blockedTasks).toHaveLength(0);
    expect(briefing.activeEpics).toHaveLength(0);
    expect(briefing.currentTask).toBeNull();
  });

  it('respects maxNextTasks limit', async () => {
    setupMockAccessor();

    const briefing = await computeBriefing('/fake/project', {
      scope: 'global',
      maxNextTasks: 2,
    });

    expect(briefing.nextTasks.length).toBeLessThanOrEqual(2);
  });

  it('currentTask is null when no focus set', async () => {
    setupMockAccessor();

    const briefing = await computeBriefing('/fake/project', {
      scope: 'global',
    });

    expect(briefing.currentTask).toBeNull();
  });

  it('currentTask is populated when focus is set', async () => {
    const tasks = makeMockTasks();
    const mockAccessor = {
      loadSessions: vi.fn().mockResolvedValue({
        version: '1.0.0',
        sessions: [],
        _meta: { schemaVersion: '1.0.0', lastUpdated: new Date().toISOString() },
      }),
      saveSessions: vi.fn().mockResolvedValue(undefined),
      loadTaskFile: vi.fn().mockResolvedValue({
        tasks,
        focus: { currentTask: 'T101', currentPhase: null },
        _meta: { schemaVersion: '2.10.0', activeSession: null },
      }),
      loadArchive: vi.fn().mockResolvedValue(null),
      saveArchive: vi.fn().mockResolvedValue(undefined),
      saveTaskFile: vi.fn().mockResolvedValue(undefined),
      appendLog: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      engine: 'sqlite' as const,
    };

    (getAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockAccessor);

    const briefing = await computeBriefing('/fake/project', {
      scope: 'global',
    });

    expect(briefing.currentTask).not.toBeNull();
    expect(briefing.currentTask!.id).toBe('T101');
    expect(briefing.currentTask!.title).toBe('Child 1');
  });

  it('pipelineStage is included when metadata has lifecycle state', async () => {
    setupMockAccessor(makeMockTasks(), { lifecycleState: 'implementation' });

    const briefing = await computeBriefing('/fake/project', {
      scope: 'global',
    });

    expect(briefing.pipelineStage).toBeDefined();
    expect(briefing.pipelineStage!.currentStage).toBe('implementation');
  });

  it('blocked tasks include those with unresolved dependencies', async () => {
    setupMockAccessor();

    const briefing = await computeBriefing('/fake/project', {
      scope: 'global',
    });

    const blockedIds = briefing.blockedTasks.map((b) => b.id);

    // T500 depends on T200 which is pending (not done) — should be blocked
    expect(blockedIds).toContain('T500');

    // T102 has status 'blocked' with blockedBy — should also appear
    expect(blockedIds).toContain('T102');
  });
});
