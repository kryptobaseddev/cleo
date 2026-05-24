/**
 * Tests for the unified urgency surface in `cleo briefing` (T9905).
 *
 * The session briefing now exposes an `urgentTasks` array that aggregates the
 * two orthogonal urgency axes (priority high|critical OR severity P0|P1) so a
 * fresh orchestrator session sees urgent work in a single section header
 * instead of having to scan `openBugs` + `nextTasks` separately.
 *
 * @task T9905
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
  getTaskAccessor: vi.fn(),
  createDataAccessor: vi.fn(),
}));

vi.mock('../handoff.js', () => ({
  getLastHandoff: vi.fn().mockResolvedValue(null),
}));

import { getAccessor, getTaskAccessor } from '../../store/data-accessor.js';
import { computeBriefing } from '../briefing.js';

function setupMockAccessor(tasks: unknown[]): void {
  const meta: Record<string, unknown> = {
    focus_state: { currentTask: null, currentPhase: null },
    file_meta: { schemaVersion: '2.10.0' },
  };
  const mockAccessor = {
    loadSessions: vi.fn().mockResolvedValue([]),
    saveSessions: vi.fn().mockResolvedValue(undefined),
    getActiveSession: vi.fn().mockResolvedValue(null),
    upsertSingleSession: vi.fn().mockResolvedValue(undefined),
    removeSingleSession: vi.fn().mockResolvedValue(undefined),
    queryTasks: vi.fn().mockImplementation(() => Promise.resolve({ tasks, total: tasks.length })),
    getMetaValue: vi.fn().mockImplementation((key: string) => Promise.resolve(meta[key] ?? null)),
    setMetaValue: vi.fn().mockResolvedValue(undefined),
    loadArchive: vi.fn().mockResolvedValue(null),
    saveArchive: vi.fn().mockResolvedValue(undefined),
    appendLog: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    engine: 'sqlite' as const,
  };
  (getAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockAccessor);
  (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockAccessor);
}

describe('briefing urgent section (T9905)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('surfaces tasks with priority critical|high under urgentTasks', async () => {
    setupMockAccessor([
      { id: 'T-CRIT', title: 'Critical task', status: 'pending', priority: 'critical' },
      { id: 'T-HIGH', title: 'High task', status: 'pending', priority: 'high' },
      { id: 'T-MED', title: 'Medium task', status: 'pending', priority: 'medium' },
    ]);
    const briefing = await computeBriefing('/mock', {});
    expect(briefing.urgentTasks).toBeDefined();
    const ids = (briefing.urgentTasks ?? []).map((t) => t.id).sort();
    expect(ids).toEqual(['T-CRIT', 'T-HIGH']);
  });

  it('surfaces tasks with severity P0|P1 regardless of priority', async () => {
    setupMockAccessor([
      { id: 'T-P0', title: 'P0 task', status: 'pending', priority: 'medium', severity: 'P0' },
      { id: 'T-P1', title: 'P1 task', status: 'pending', priority: 'low', severity: 'P1' },
      { id: 'T-P2', title: 'P2 task', status: 'pending', priority: 'medium', severity: 'P2' },
    ]);
    const briefing = await computeBriefing('/mock', {});
    expect(briefing.urgentTasks).toBeDefined();
    const ids = (briefing.urgentTasks ?? []).map((t) => t.id).sort();
    expect(ids).toEqual(['T-P0', 'T-P1']);
  });

  it('excludes completed and cancelled tasks from urgent', async () => {
    setupMockAccessor([
      { id: 'T-DONE', title: 'Done crit', status: 'done', priority: 'critical' },
      { id: 'T-CANCEL', title: 'Cancelled P0', status: 'cancelled', severity: 'P0' },
      { id: 'T-LIVE', title: 'Live high', status: 'pending', priority: 'high' },
    ]);
    const briefing = await computeBriefing('/mock', {});
    expect((briefing.urgentTasks ?? []).map((t) => t.id)).toEqual(['T-LIVE']);
  });

  it('returns an empty array (not undefined) when nothing is urgent', async () => {
    setupMockAccessor([
      { id: 'T-MED', title: 'Medium', status: 'pending', priority: 'medium' },
      { id: 'T-LOW', title: 'Low', status: 'pending', priority: 'low' },
    ]);
    const briefing = await computeBriefing('/mock', {});
    expect(briefing.urgentTasks).toEqual([]);
  });

  it('exposes priority and severity on each urgent entry', async () => {
    setupMockAccessor([
      { id: 'T-CRIT', title: 'Crit', status: 'pending', priority: 'critical', severity: 'P0' },
    ]);
    const briefing = await computeBriefing('/mock', {});
    const entry = briefing.urgentTasks?.[0];
    expect(entry).toBeDefined();
    expect(entry?.priority).toBe('critical');
    expect(entry?.severity).toBe('P0');
  });
});
