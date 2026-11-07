/**
 * The sessions page reads through `@cleocode/core` (T14330, core-first):
 * sessions newest first, each session's work history oldest first, and the
 * tasks they name with the status tasks read with (T14268).
 *
 * @task T14330
 */

import type { Session, Task } from '@cleocode/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectContext } from '$lib/server/project-context.js';

const sessions: Session[] = [
  {
    id: 'ses_old',
    name: 'old',
    status: 'ended',
    scope: { type: 'global' },
    taskWork: { taskId: null, setAt: null },
    startedAt: '2026-11-01T00:00:00.000Z',
    endedAt: '2026-11-01T01:00:00.000Z',
    tasksCompleted: ['T2'],
    tasksCreated: ['T2', 'T3'],
  },
  {
    id: 'ses_new',
    name: 'new',
    status: 'active',
    scope: { type: 'global' },
    taskWork: { taskId: 'T1', setAt: '2026-11-06T00:00:00.000Z' },
    startedAt: '2026-11-06T00:00:00.000Z',
    agent: 'lane-a',
  },
];

const task = (id: string, status: Task['status']): Task => ({
  id,
  title: `Task ${id}`,
  description: `Task ${id}`,
  status,
  priority: 'medium',
  createdAt: '2026-11-01T00:00:00.000Z',
});

vi.mock('@cleocode/core/store/data-accessor', () => ({
  getTaskAccessor: async () => ({
    loadSessions: async () => sessions,
    loadTasks: async (ids: string[]) =>
      [task('T1', 'active'), task('T2', 'done')].filter((t) => ids.includes(t.id)),
  }),
}));
vi.mock('@cleocode/core/store/session-store', () => ({
  workHistory: async (sessionId: string) =>
    sessionId === 'ses_old'
      ? [
          { taskId: 'T2', setAt: '2026-11-01T00:30:00.000Z', clearedAt: null },
          {
            taskId: 'T1',
            setAt: '2026-11-01T00:10:00.000Z',
            clearedAt: '2026-11-01T00:20:00.000Z',
          },
        ]
      : [],
}));

const ctx = (tasksDbExists: boolean): ProjectContext => ({
  projectId: 'p',
  name: 'p',
  projectPath: '/nonexistent-t14330',
  brainDbPath: '/nonexistent-t14330/.cleo/cleo.db',
  tasksDbPath: '/nonexistent-t14330/.cleo/cleo.db',
  brainDbExists: tasksDbExists,
  tasksDbExists,
});

describe('/tasks/sessions loads through core (T14330)', () => {
  it('orders sessions and history, and names tasks with their read status', async () => {
    const { _loadSessionEntries } = await import('../sessions/+page.server.js');
    const entries = await _loadSessionEntries(ctx(true));
    expect(entries.map((e) => e.id)).toEqual(['ses_new', 'ses_old']);
    const [active, ended] = entries;
    expect(active?.currentTask).toEqual({ id: 'T1', title: 'Task T1', status: 'active' });
    expect(active?.agent).toBe('lane-a');
    expect(ended?.completedTasks).toEqual([{ id: 'T2', title: 'Task T2', status: 'done' }]);
    expect(ended?.createdCount).toBe(2);
    expect(ended?.durationMs).toBe(3_600_000);
    expect(ended?.workedTasks.map((w) => w.id)).toEqual(['T1', 'T2']);
  });

  it('is empty when the project has no task store', async () => {
    const { _loadSessionEntries } = await import('../sessions/+page.server.js');
    expect(await _loadSessionEntries(ctx(false))).toEqual([]);
  });
});
