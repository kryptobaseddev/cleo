import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import type { DataAccessor } from '../../store/data-accessor.js';
import {
  collectOrchestrateDashboard,
  type DashboardWorktreeState,
  formatDashboardPromptSummary,
} from '../dashboard.js';

function task(id: string, status: Task['status'], depends: string[] = []): Task {
  return {
    id,
    title: id,
    status,
    type: 'task',
    priority: 'medium',
    size: 'small',
    depends,
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
  } as Task;
}

function accessor(tasks: Task[]): DataAccessor {
  return {
    queryTasks: async () => ({ tasks, total: tasks.length }),
  } as unknown as DataAccessor;
}

function worktreeState(
  statusCategory: string,
  overrides: Partial<DashboardWorktreeState> = {},
): DashboardWorktreeState {
  const isDirty = overrides.isDirty ?? false;
  const hasUnpushedCommits = overrides.hasUnpushedCommits ?? false;
  const reasons = [
    ...(statusCategory === 'stale' ? ['stale'] : []),
    ...(isDirty ? ['dirty'] : []),
    ...(hasUnpushedCommits ? ['unpushed'] : []),
  ];
  return {
    path: `/tmp/${statusCategory}`,
    branch: 'task/T1',
    taskId: 'T1',
    statusCategory,
    isDirty,
    hasUnpushedCommits,
    isStalled: reasons.length > 0,
    reasons,
    ...overrides,
  };
}

describe('collectOrchestrateDashboard', () => {
  it('aggregates queue, audit rates, and active worktree counts from existing SSoTs', async () => {
    const projectRoot = join(process.cwd(), '.tmp-dashboard-test');
    await mkdir(join(projectRoot, '.cleo', 'audit'), { recursive: true });
    await writeFile(
      join(projectRoot, '.cleo', 'audit', 'worktree-lifecycle.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-05-24T10:00:00.000Z',
          action: 'complete',
          success: true,
        }),
        JSON.stringify({
          timestamp: '2026-05-24T09:00:00.000Z',
          action: 'complete-conflict',
          success: false,
        }),
        JSON.stringify({
          timestamp: '2026-05-22T09:00:00.000Z',
          action: 'complete',
          success: true,
        }),
      ].join('\n'),
    );
    await writeFile(
      join(projectRoot, '.cleo', 'audit', 'force-bypass.jsonl'),
      [
        JSON.stringify({ timestamp: '2026-05-24T08:00:00.000Z', taskId: 'T2' }),
        JSON.stringify({ timestamp: '2026-05-23T13:00:00.000Z', taskId: 'T3' }),
      ].join('\n'),
    );

    const metrics = await collectOrchestrateDashboard(projectRoot, {
      accessor: accessor([
        task('T1', 'done'),
        task('T2', 'pending', ['T1']),
        task('T3', 'pending', ['T9']),
        task('T4', 'active'),
        task('T5', 'blocked'),
      ]),
      now: new Date('2026-05-24T12:00:00.000Z'),
      rateWindowHours: 24,
      worktreeStates: [
        worktreeState('active'),
        worktreeState('active'),
        worktreeState('locked'),
        worktreeState('merged'),
      ],
    });

    expect(metrics.queueDepth).toBe(1);
    expect(metrics.queue).toEqual({ ready: 1, pending: 2, active: 1, blocked: 1 });
    expect(metrics.adminMergeRate).toEqual({ count: 1, perHour: 0.04, windowHours: 24 });
    expect(metrics.forceBypassRate).toEqual({ count: 2, perHour: 0.08, windowHours: 24 });
    expect(metrics.activeWorktreeCount).toBe(2);
    expect(metrics.worktrees.total).toBe(4);
    expect(metrics.worktrees.stalled).toBe(0);
    expect(metrics.lockContention).toMatchObject({
      dbLockCount: 0,
      evidenceLockCount: 0,
      staleLockCount: 0,
      worktreeLockedCount: 1,
      worktreeStaleCount: 0,
      hasContention: true,
    });
    expect(metrics.lockContention.cleanupGuidance).toContain(
      'For wedged agent worktrees, run `cleo worktree force-unlock <taskId>`.',
    );
  });

  it('surfaces stalled worker worktrees with dirty, unpushed, and stale reasons', async () => {
    const metrics = await collectOrchestrateDashboard('/project', {
      accessor: accessor([task('T1', 'active')]),
      now: new Date('2026-05-24T12:00:00.000Z'),
      worktreeStates: [
        worktreeState('active', {
          path: '/worker/dirty',
          branch: 'task/T10',
          taskId: 'T10',
          isDirty: true,
          isStalled: true,
          reasons: ['dirty'],
        }),
        worktreeState('active', {
          path: '/worker/unpushed',
          branch: 'task/T11',
          taskId: 'T11',
          hasUnpushedCommits: true,
          isStalled: true,
          reasons: ['unpushed'],
        }),
        worktreeState('stale', {
          path: '/worker/stale',
          branch: 'task/T12',
          taskId: 'T12',
        }),
      ],
    });

    expect(metrics.worktrees).toMatchObject({
      total: 3,
      active: 2,
      stale: 1,
      dirty: 1,
      unpushed: 1,
      stalled: 3,
    });
    expect(metrics.stalledWorktrees.map((worktree) => worktree.reasons)).toEqual([
      ['dirty'],
      ['unpushed'],
      ['stale'],
    ]);
  });

  it('surfaces DB/evidence lock markers and stale-lock cleanup guidance', async () => {
    const projectRoot = join(process.cwd(), '.tmp-dashboard-locks-test');
    await mkdir(join(projectRoot, '.cleo', 'audit'), { recursive: true });
    const dbLockPath = join(projectRoot, '.cleo', 'tasks.db-journal');
    const evidenceLockPath = join(
      projectRoot,
      '.cleo',
      'audit',
      'shared-evidence-recent.jsonl.lock',
    );
    await writeFile(dbLockPath, 'db lock');
    await writeFile(evidenceLockPath, 'evidence lock');
    const old = new Date('2026-05-24T11:00:00.000Z');
    await utimes(dbLockPath, old, old);

    const metrics = await collectOrchestrateDashboard(projectRoot, {
      accessor: accessor([task('T1', 'pending')]),
      now: new Date('2026-05-24T12:00:00.000Z'),
      worktreeStatusCategories: ['stale'],
    });

    expect(metrics.lockContention).toMatchObject({
      dbLockCount: 1,
      evidenceLockCount: 1,
      staleLockCount: 1,
      worktreeLockedCount: 0,
      worktreeStaleCount: 1,
      hasContention: true,
    });
    expect(metrics.lockContention.lockMarkers.map((marker) => marker.kind)).toEqual([
      'db',
      'evidence',
    ]);
    expect(metrics.lockContention.cleanupGuidance).toEqual(
      expect.arrayContaining([
        'If no CLEO process is actively writing, stale DB/evidence lock markers can be removed after inspection.',
        'Confirm no running CLEO writers, then delete stale lock marker files.',
        'Review stale worktrees with `cleo worktree list --status stale`.',
      ]),
    );
  });

  it('formats a compact prompt summary', async () => {
    const metrics = await collectOrchestrateDashboard('/project', {
      accessor: accessor([task('T1', 'pending')]),
      now: new Date('2026-05-24T12:00:00.000Z'),
      rateWindowHours: 24,
      worktreeStatusCategories: ['active'],
    });

    expect(formatDashboardPromptSummary(metrics)).toBe(
      'queue=1 ready / 0 active; worktrees=1 active (0 stalled: 0 dirty, 0 unpushed); adminMerge=0/h; forceBypass=0/h (24h)',
    );
  });
});
