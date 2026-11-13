import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
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

// T14552: count disposal proofs, full listings, git spawns and sync fs calls
// (the profile's cost centres: lstat, git spawnSync, readdir); statuses come from a stub.
const { proofs, listings } = vi.hoisted(() => ({
  proofs: { n: 0 },
  listings: { n: 0 },
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
    spawnSync: vi.fn(actual.spawnSync),
  };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const spies = {
    lstatSync: vi.fn(actual.lstatSync),
    statSync: vi.fn(actual.statSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
  return { ...actual, ...spies, default: { ...actual, ...spies } };
});
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
    // Odd task numbers done, even active; no task store needed.
    loadOwningTaskStatuses: async (ids: string[]) => ({
      success: true as const,
      data: new Map(ids.map((id) => [id, Number(id.slice(1)) % 2 === 1 ? 'done' : 'active'])),
    }),
  };
});

/** Git spawns recorded by the delegating `node:child_process` spies (T14552). */
function gitCallCount(): number {
  return [...vi.mocked(execFileSync).mock.calls, ...vi.mocked(spawnSync).mock.calls].filter(
    (call) => call[0] === 'git',
  ).length;
}

/** lstat / stat / readdir calls recorded by the delegating `node:fs` spies (T14552). */
function fsCallCount(): number {
  return (
    vi.mocked(lstatSync).mock.calls.length +
    vi.mocked(statSync).mock.calls.length +
    vi.mocked(readdirSync).mock.calls.length
  );
}

/** Reset the git and fs counters. */
function resetCallCounts(): void {
  for (const spy of [execFileSync, spawnSync, lstatSync, statSync, readdirSync]) {
    vi.mocked(spy).mockClear();
  }
}

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

  it('T14552 — proveWorktrees:false costs the same for 5 and 185 worktrees: no proof, no per-worktree git or fs', async () => {
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
      const addWorktrees = (from: number, to: number) => {
        for (let i = from; i <= to; i++) {
          git('worktree', 'add', '-q', '-b', `task/T${i}`, join(base, 'wt', `T${i}`));
        }
      };
      const measure = async () => {
        proofs.n = 0;
        listings.n = 0;
        resetCallCounts();
        const metrics = await collectOrchestrateDashboard(repo, {
          accessor: accessor([]),
          now: new Date(),
          proveWorktrees: false,
        });
        return {
          metrics,
          proofs: proofs.n,
          listings: listings.n,
          git: gitCallCount(),
          fs: fsCallCount(),
        };
      };

      addWorktrees(1, 5);
      await measure(); // warm module-level caches
      const small = await measure();
      addWorktrees(6, 185);
      const large = await measure();

      for (const run of [small, large]) {
        expect(run.proofs).toBe(0);
        expect(run.listings).toBe(0);
        expect(run.metrics.worktreeProof).toBe('unproven');
      }
      // The cost does not grow with the worktree count: 180 more worktrees
      // add zero git spawns and zero sync fs calls.
      expect(large.git).toBe(small.git);
      expect(large.fs).toBe(small.fs);
      expect(large.git).toBeLessThanOrEqual(5);
      // One porcelain read (the git counter is live); no lstat/stat/readdir at all.
      expect(small.git).toBeGreaterThan(0);
      expect(small.fs).toBe(0);
      // The primary checkout plus 92 open-task worktrees; 93 finished, unproven.
      expect(large.metrics.worktrees).toMatchObject({
        total: 186,
        active: 93,
        unproven: 93,
        redundant: 0,
      });
      expect(formatDashboardPromptSummary(large.metrics)).toContain(
        'worktrees=93 active, 93 finished (unproven: cleo worktree list)',
      );
      // The counters are wired: the default (proven) dashboard lists and its
      // per-worktree probes touch the filesystem.
      proofs.n = 0;
      resetCallCounts();
      await collectOrchestrateDashboard(repo, { accessor: accessor([]) });
      expect(listings.n).toBe(1);
      expect(fsCallCount()).toBeGreaterThan(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }, 120_000);
});
