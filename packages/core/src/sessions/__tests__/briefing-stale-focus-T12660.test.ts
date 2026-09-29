/**
 * T12660 — the briefing never presents a finished task as current, and it
 * annotates the last handoff's suggestions with their live status.
 *
 * @task T12660
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
import { getLastHandoff } from '../handoff.js';

const TASKS = [
  { id: 'T458', title: 'Finished long ago', status: 'done', priority: 'medium' },
  { id: 'T324', title: 'Dropped', status: 'cancelled', priority: 'medium' },
  { id: 'T500', title: 'Ready', status: 'pending', priority: 'high' },
];

function setupAccessor(focusTask: string | null, endedSession = false) {
  const meta: Record<string, unknown> = {
    focus_state: { currentTask: focusTask, currentPhase: null },
    file_meta: { schemaVersion: '2.10.0' },
  };
  const sessions = endedSession
    ? [
        {
          id: 'ses_prev',
          status: 'ended',
          startedAt: '2026-09-18T00:00:00Z',
          endedAt: '2026-09-18T01:00:00Z',
        },
      ]
    : [];
  const accessor = {
    loadSessions: vi.fn().mockResolvedValue(sessions),
    saveSessions: vi.fn().mockResolvedValue(undefined),
    getActiveSession: vi.fn().mockResolvedValue(null),
    resolveCurrentSession: vi.fn().mockResolvedValue(null),
    upsertSingleSession: vi.fn().mockResolvedValue(undefined),
    removeSingleSession: vi.fn().mockResolvedValue(undefined),
    queryTasks: vi.fn().mockResolvedValue({ tasks: TASKS, total: TASKS.length }),
    loadSingleTask: vi.fn((id: string) => Promise.resolve(TASKS.find((t) => t.id === id) ?? null)),
    getMetaValue: vi.fn((key: string) => Promise.resolve(meta[key] ?? null)),
    setMetaValue: vi.fn((key: string, value: unknown) => {
      meta[key] = value;
      return Promise.resolve();
    }),
    loadArchive: vi.fn().mockResolvedValue(null),
    saveArchive: vi.fn().mockResolvedValue(undefined),
    appendLog: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    engine: 'sqlite' as const,
  };
  (getAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(accessor);
  (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(accessor);
  return accessor;
}

describe('T12660 — briefing stale focus and handoff suggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CLEO_SESSION_ID', undefined);
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', undefined);
  });

  it('a legacy pointer at a done task is not currentTask; a stale warning names it and the next task', async () => {
    const accessor = setupAccessor('T458');
    const briefing = await computeBriefing('/fake/project', { scope: 'global' });
    expect(briefing.currentTask).toBeNull();
    expect(briefing.warnings?.join('\n')).toContain(
      'Stale focus pointer: T458 is done, not current. Next ready task: T500',
    );
    // T12684: the warning carries its code, and the pointer is a field.
    expect(briefing.warnings?.join('\n')).toContain('W_STALE_FOCUS: Stale focus pointer: T458');
    expect(briefing.staleFocus).toEqual({ taskId: 'T458', status: 'done' });
    // T12698: the pointer is in the briefing's task map — no extra lookup.
    expect(accessor.loadSingleTask).not.toHaveBeenCalled();
  });

  it('a workable pointer is still currentTask, with no stale warning', async () => {
    setupAccessor('T500');
    const briefing = await computeBriefing('/fake/project', { scope: 'global' });
    expect(briefing.currentTask?.id).toBe('T500');
    expect(briefing.warnings?.join('\n') ?? '').not.toContain('Stale focus pointer');
  });

  it('annotates handoff.nextSuggested with live status and marks done, cancelled and missing ids stale', async () => {
    setupAccessor(null, true);
    (getLastHandoff as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessionId: 'ses_prev',
      handoff: {
        lastTask: 'T458',
        tasksCompleted: [],
        tasksCreated: [],
        decisionsRecorded: 0,
        nextSuggested: ['T458', 'T324', 'T500', 'T999'],
        openBlockers: [],
        openBugs: [],
        note: 'keep going',
        nextAction: 'T458',
      },
    });
    const briefing = await computeBriefing('/fake/project', { scope: 'global' });
    // The recorded handoff stays verbatim (historical); the live view sits beside it.
    expect(briefing.lastSession?.handoff.nextSuggested).toEqual(['T458', 'T324', 'T500', 'T999']);
    expect(briefing.lastSession?.nextSuggestedLive).toEqual([
      { id: 'T458', status: 'done', stale: true },
      { id: 'T324', status: 'cancelled', stale: true },
      { id: 'T500', status: 'pending', stale: false },
      { id: 'T999', status: 'missing', stale: true },
    ]);
    expect(briefing.warnings?.join('\n')).toContain(
      'Last handoff suggested work that is no longer current: T458 (done), T324 (cancelled), T999 (missing)',
    );
  });
});
