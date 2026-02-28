/**
 * Tests for session briefing blocked-focus warnings.
 * @task T5069
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
  createDataAccessor: vi.fn(),
}));

vi.mock('../handoff.js', () => ({
  getLastHandoff: vi.fn().mockResolvedValue(null),
}));

import { computeBriefing } from '../briefing.js';
import { getAccessor } from '../../../store/data-accessor.js';

function setupMockAccessor(
  tasks: unknown[],
  focus: { currentTask: string | null; currentPhase: string | null } = { currentTask: null, currentPhase: null },
) {
  const mockAccessor = {
    loadSessions: vi.fn().mockResolvedValue({
      version: '1.0.0',
      sessions: [],
      _meta: { schemaVersion: '1.0.0', lastUpdated: new Date().toISOString() },
    }),
    saveSessions: vi.fn().mockResolvedValue(undefined),
    loadTaskFile: vi.fn().mockResolvedValue({
      tasks,
      focus,
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
  return mockAccessor;
}

describe('briefing blocked-focus warnings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('warns when focused task has unresolved dependencies', async () => {
    setupMockAccessor(
      [
        { id: 'T001', title: 'Blocker', status: 'pending', priority: 'medium' },
        { id: 'T002', title: 'Blocked task', status: 'pending', priority: 'medium', depends: ['T001'] },
      ],
      { currentTask: 'T002', currentPhase: null },
    );

    const briefing = await computeBriefing('/fake/project', { scope: 'global' });

    expect(briefing.currentTask).not.toBeNull();
    expect(briefing.currentTask!.blockedBy).toEqual(['T001']);
    expect(briefing.warnings).toBeDefined();
    expect(briefing.warnings).toHaveLength(1);
    expect(briefing.warnings![0]).toContain('T002');
    expect(briefing.warnings![0]).toContain('T001');
  });

  it('does not warn when focused task has all deps resolved', async () => {
    setupMockAccessor(
      [
        { id: 'T001', title: 'Done dep', status: 'done', priority: 'medium' },
        { id: 'T002', title: 'Ready task', status: 'pending', priority: 'medium', depends: ['T001'] },
      ],
      { currentTask: 'T002', currentPhase: null },
    );

    const briefing = await computeBriefing('/fake/project', { scope: 'global' });

    expect(briefing.currentTask).not.toBeNull();
    expect(briefing.currentTask!.blockedBy).toBeUndefined();
    expect(briefing.warnings).toBeUndefined();
  });

  it('does not warn when no task is focused', async () => {
    setupMockAccessor(
      [
        { id: 'T001', title: 'Blocker', status: 'pending', priority: 'medium' },
      ],
      { currentTask: null, currentPhase: null },
    );

    const briefing = await computeBriefing('/fake/project', { scope: 'global' });

    expect(briefing.currentTask).toBeNull();
    expect(briefing.warnings).toBeUndefined();
  });

  it('lists multiple blockers in warning', async () => {
    setupMockAccessor(
      [
        { id: 'T001', title: 'Blocker A', status: 'pending', priority: 'medium' },
        { id: 'T002', title: 'Blocker B', status: 'active', priority: 'medium' },
        { id: 'T003', title: 'Blocked task', status: 'pending', priority: 'medium', depends: ['T001', 'T002'] },
      ],
      { currentTask: 'T003', currentPhase: null },
    );

    const briefing = await computeBriefing('/fake/project', { scope: 'global' });

    expect(briefing.currentTask!.blockedBy).toEqual(['T001', 'T002']);
    expect(briefing.warnings).toHaveLength(1);
    expect(briefing.warnings![0]).toContain('T001, T002');
  });

  it('does not warn when focused task has no dependencies', async () => {
    setupMockAccessor(
      [
        { id: 'T001', title: 'Simple task', status: 'pending', priority: 'medium' },
      ],
      { currentTask: 'T001', currentPhase: null },
    );

    const briefing = await computeBriefing('/fake/project', { scope: 'global' });

    expect(briefing.currentTask).not.toBeNull();
    expect(briefing.currentTask!.blockedBy).toBeUndefined();
    expect(briefing.warnings).toBeUndefined();
  });
});
