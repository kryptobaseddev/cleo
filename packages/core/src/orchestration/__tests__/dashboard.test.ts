import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { DataAccessor } from '../../store/data-accessor.js';
import {
  collectOrchestrateDashboard,
  type DashboardWorktreeState,
  formatDashboardPromptSummary,
} from '../dashboard.js';

// T14552: count disposal proofs and full listings; statuses come from a stub.
const { proofs, listings } = vi.hoisted(() => ({ proofs: { n: 0 }, listings: { n: 0 } }));
vi.mock('@cleocode/worktree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/worktree')>();
  return {
    ...actual,
    disposeWorktree: (...args: Parameters<typeof actual.disposeWorktree>) => {
      proofs.n += 1;
      return actual.disposeWorktree(...args);
    },
  };
});
vi.mock('../../worktree/list.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../worktree/list.js')>();
  return {
    ...actual,
    listWorktrees: (...args: Parameters<typeof actual.listWorktrees>) => {
      listings.n += 1;
      return actual.listWorktrees(...args);
    },
    // T1..T20 done, T21..T40 active; no task store needed.
    loadOwningTaskStatuses: async (ids: string[]) => ({
      success: true as const,
      data: new Map(ids.map((id) => [id, Number(id.slice(1)) <= 20 ? 'done' : 'active'])),
    }),
  };
});

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
    ...(overrides.reasons ?? []),
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
        worktreeState('redundant'),
        worktreeState('keep'),
      ],
    });

    expect(metrics.queueDepth).toBe(1);
    expect(metrics.queue).toEqual({ ready: 1, pending: 2, active: 1, blocked: 1 });
    expect(metrics.adminMergeRate).toEqual({ count: 1, perHour: 0.04, windowHours: 24 });
    expect(metrics.forceBypassRate).toEqual({ count: 2, perHour: 0.08, windowHours: 24 });
    expect(metrics.activeWorktreeCount).toBe(2);
    expect(metrics.worktrees.total).toBe(4);
    expect(metrics.worktrees).toMatchObject({ active: 2, redundant: 1, keep: 1, unknown: 0 });
    expect(metrics.worktrees.stalled).toBe(0);
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
        // T14274: stale is an annotation (a reason), not a category.
        worktreeState('keep', {
          path: '/worker/stale',
          branch: 'task/T12',
          taskId: 'T12',
          reasons: ['stale'],
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

  it('T14552 — proveWorktrees:false classifies 40 worktrees with no disposal proof or full listing', async () => {
    const base = realpathSync(await mkdtemp(join(tmpdir(), 'dashboard-unproven-')));
    try {
      const repo = join(base, 'repo');
      await mkdir(repo);
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
      git('init', '-q', '-b', 'main');
      git(
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@e.x',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      );
      for (let i = 1; i <= 40; i++) {
        git('worktree', 'add', '-q', '-b', `task/T${i}`, join(base, 'wt', `T${i}`));
      }
      proofs.n = 0;
      listings.n = 0;
      const metrics = await collectOrchestrateDashboard(repo, {
        accessor: accessor([]),
        now: new Date(),
        proveWorktrees: false,
      });
      expect(proofs.n).toBe(0);
      expect(listings.n).toBe(0);
      expect(metrics.worktreeProof).toBe('unproven');
      // The primary checkout plus 20 open-task worktrees; 20 finished, unproven.
      expect(metrics.worktrees).toMatchObject({
        total: 41,
        active: 21,
        unproven: 20,
        redundant: 0,
      });
      expect(formatDashboardPromptSummary(metrics)).toContain(
        'worktrees=21 active, 20 finished (unproven: cleo worktree list)',
      );
      // The counter is wired: the default (proven) dashboard does list.
      await collectOrchestrateDashboard(repo, { accessor: accessor([]) });
      expect(listings.n).toBe(1);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
