/**
 * Unit tests for the structured worktree-list primitive (T9546).
 *
 * Covers:
 *  - Happy path: porcelain output → classified WorktreeInfo entries
 *  - Each statusCategory (`active|stale|merged|orphan|locked`) is reachable
 *  - --status filter narrows results
 *  - taskIdFromBranch convention
 *  - classifyStatus precedence (locked > orphan > merged > stale > active)
 *  - 50-worktree performance budget (<500ms with mocked git/db calls)
 *
 * @task T9546
 * @epic T9515
 */

import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock node:child_process for porcelain + log + merge-base invocations.
// All git calls in list.ts route through execFileSync — the mock lets us
// drive every code-path deterministically without spawning real git.
// ---------------------------------------------------------------------------
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Mock openCleoDb chokepoint — returns a stub DatabaseSync that yields the
// tasks-by-id rows the current test configured via `MOCK_TASK_ROWS`.
// ---------------------------------------------------------------------------
const MOCK_TASK_ROWS = new Map<string, string>();
vi.mock('../../store/open-cleo-db.js', () => ({
  openCleoDb: vi.fn(async () => ({
    db: {
      prepare: (_sql: string) => ({
        all: (...ids: string[]) =>
          ids
            .filter((id) => MOCK_TASK_ROWS.has(id))
            .map((id) => ({ id, status: MOCK_TASK_ROWS.get(id) })),
      }),
    },
    role: 'tasks',
    close: async () => {},
  })),
}));

const mockExec = vi.mocked(execFileSync);

import {
  branchIsMergedToMain,
  classifyStatus,
  enumerateWorktrees,
  listWorktrees,
  taskIdFromBranch,
} from '../list.js';

/**
 * Build a stub porcelain payload for `git worktree list --porcelain`.
 * Each entry produces a record matching the documented git porcelain grammar.
 */
function porcelain(
  entries: Array<{ path: string; branch: string; locked?: boolean; detached?: boolean }>,
): string {
  const blocks = entries.map((e) => {
    const lines: string[] = [`worktree ${e.path}`, 'HEAD abc123'];
    if (e.detached) {
      lines.push('detached');
    } else {
      lines.push(`branch refs/heads/${e.branch}`);
    }
    if (e.locked) lines.push('locked');
    return lines.join('\n');
  });
  return `${blocks.join('\n\n')}\n`;
}

/**
 * Build a per-call execFileSync mock implementation that knows how to respond
 * to: `worktree list --porcelain`, `log -1 --format=%cI`, `merge-base --is-ancestor`,
 * `rev-parse --verify refs/heads/main`.
 */
function installGitMock(opts: {
  porcelainOutput: string;
  /** Per-branch ISO timestamp returned by `git log -1 --format=%cI`. */
  branchTimestamps?: Record<string, string>;
  /** Branches reported as merged into main (via `merge-base --is-ancestor`). */
  mergedBranches?: Set<string>;
  /** Whether `refs/heads/main` resolves locally. */
  mainExists?: boolean;
}): void {
  const merged = opts.mergedBranches ?? new Set<string>();
  const timestamps = opts.branchTimestamps ?? {};
  const mainExists = opts.mainExists !== false;

  mockExec.mockImplementation((_cmd: string, args?: readonly string[]) => {
    const argv = (args ?? []) as readonly string[];
    if (argv[0] === 'worktree' && argv[1] === 'list') {
      return opts.porcelainOutput as never;
    }
    if (argv[0] === 'log' && argv[1] === '-1') {
      const branch = argv[3];
      if (branch && timestamps[branch]) return `${timestamps[branch]}\n` as never;
      throw new Error('no log for branch');
    }
    if (argv[0] === 'merge-base' && argv[1] === '--is-ancestor') {
      const branch = argv[2];
      if (branch && merged.has(branch)) return '' as never;
      const err = new Error('not an ancestor');
      throw err;
    }
    if (argv[0] === 'rev-parse' && argv[1] === '--verify') {
      if (mainExists) return '' as never;
      throw new Error('no main');
    }
    throw new Error(`unexpected git call: ${argv.join(' ')}`);
  });
}

beforeEach(() => {
  MOCK_TASK_ROWS.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('taskIdFromBranch', () => {
  it('extracts task ID from canonical branch names', () => {
    expect(taskIdFromBranch('task/T9546')).toBe('T9546');
    expect(taskIdFromBranch('task/T1')).toBe('T1');
  });

  it('returns null for non-task branches', () => {
    expect(taskIdFromBranch('main')).toBeNull();
    expect(taskIdFromBranch('feat/foo')).toBeNull();
    expect(taskIdFromBranch('release/v2026.5.78')).toBeNull();
    expect(taskIdFromBranch('task/foo')).toBeNull();
  });
});

describe('classifyStatus precedence', () => {
  it('locked beats every other flag', () => {
    expect(classifyStatus({ isLocked: true, isOrphan: true, isMerged: true, isStale: true })).toBe(
      'locked',
    );
  });

  it('orphan beats merged and stale', () => {
    expect(classifyStatus({ isLocked: false, isOrphan: true, isMerged: true, isStale: true })).toBe(
      'orphan',
    );
  });

  it('merged beats stale', () => {
    expect(
      classifyStatus({ isLocked: false, isOrphan: false, isMerged: true, isStale: true }),
    ).toBe('merged');
  });

  it('stale wins over active when isolated', () => {
    expect(
      classifyStatus({ isLocked: false, isOrphan: false, isMerged: false, isStale: true }),
    ).toBe('stale');
  });

  it('returns active by default', () => {
    expect(
      classifyStatus({ isLocked: false, isOrphan: false, isMerged: false, isStale: false }),
    ).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Porcelain parsing
// ---------------------------------------------------------------------------

describe('enumerateWorktrees', () => {
  it('parses a single worktree entry', () => {
    mockExec.mockReturnValue(porcelain([{ path: '/tmp/wt/T1', branch: 'task/T1' }]) as never);
    const out = enumerateWorktrees('/tmp/project');
    expect(out).toEqual([{ path: '/tmp/wt/T1', branch: 'task/T1', locked: false }]);
  });

  it('parses multiple worktree entries separated by blank lines', () => {
    mockExec.mockReturnValue(
      porcelain([
        { path: '/tmp/wt/T1', branch: 'task/T1' },
        { path: '/tmp/wt/T2', branch: 'task/T2', locked: true },
      ]) as never,
    );
    const out = enumerateWorktrees('/tmp/project');
    expect(out).toHaveLength(2);
    expect(out[1]?.locked).toBe(true);
  });

  it('handles detached HEAD entries gracefully', () => {
    mockExec.mockReturnValue(
      porcelain([{ path: '/tmp/wt/detached', branch: '', detached: true }]) as never,
    );
    const out = enumerateWorktrees('/tmp/project');
    expect(out[0]?.branch).toBe('HEAD');
  });
});

// ---------------------------------------------------------------------------
// branchIsMergedToMain
// ---------------------------------------------------------------------------

describe('branchIsMergedToMain', () => {
  it('returns true when merge-base exits 0', () => {
    mockExec.mockReturnValue('' as never);
    expect(branchIsMergedToMain('task/T9546', '/tmp', 'main')).toBe(true);
  });

  it('returns false when merge-base throws', () => {
    mockExec.mockImplementation(() => {
      throw new Error('not an ancestor');
    });
    expect(branchIsMergedToMain('task/T9546', '/tmp', 'main')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listWorktrees — integration of all classifiers
// ---------------------------------------------------------------------------

describe('listWorktrees — status classification', () => {
  const nowIso = (offsetDays = 0): string =>
    new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000).toISOString();

  it('happy path: classifies an active worktree with a live task', async () => {
    MOCK_TASK_ROWS.set('T9546', 'active');
    installGitMock({
      porcelainOutput: porcelain([{ path: '/tmp/wt/T9546', branch: 'task/T9546' }]),
      branchTimestamps: { 'task/T9546': nowIso(0) },
      mergedBranches: new Set(),
    });

    const result = await listWorktrees({ projectRoot: '/tmp/project' });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.worktrees).toHaveLength(1);
    const wt = result.data.worktrees[0];
    expect(wt?.statusCategory).toBe('active');
    expect(wt?.taskId).toBe('T9546');
    expect(wt?.owningTaskStatus).toBe('active');
    expect(wt?.isMerged).toBe(false);
    expect(wt?.isStale).toBe(false);
    expect(wt?.isLocked).toBe(false);
  });

  it('stale detection: idle > 7 days AND task done → status=stale', async () => {
    MOCK_TASK_ROWS.set('T100', 'done');
    installGitMock({
      porcelainOutput: porcelain([{ path: '/tmp/wt/T100', branch: 'task/T100' }]),
      branchTimestamps: { 'task/T100': nowIso(30) },
      mergedBranches: new Set(),
    });

    const result = await listWorktrees({ projectRoot: '/tmp/project' });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.worktrees[0]?.statusCategory).toBe('stale');
    expect(result.data.worktrees[0]?.isStale).toBe(true);
  });

  it('merged detection: branch reachable from main → status=merged', async () => {
    MOCK_TASK_ROWS.set('T200', 'active');
    installGitMock({
      porcelainOutput: porcelain([{ path: '/tmp/wt/T200', branch: 'task/T200' }]),
      branchTimestamps: { 'task/T200': nowIso(0) },
      mergedBranches: new Set(['task/T200']),
    });

    const result = await listWorktrees({ projectRoot: '/tmp/project' });
    if (!result.success) throw new Error('expected success');
    const wt = result.data.worktrees[0];
    expect(wt?.isMerged).toBe(true);
    expect(wt?.statusCategory).toBe('merged');
  });

  it('locked detection: porcelain reports locked → status=locked', async () => {
    MOCK_TASK_ROWS.set('T300', 'active');
    installGitMock({
      porcelainOutput: porcelain([{ path: '/tmp/wt/T300', branch: 'task/T300', locked: true }]),
      branchTimestamps: { 'task/T300': nowIso(0) },
      mergedBranches: new Set(),
    });

    const result = await listWorktrees({ projectRoot: '/tmp/project' });
    if (!result.success) throw new Error('expected success');
    expect(result.data.worktrees[0]?.statusCategory).toBe('locked');
    expect(result.data.worktrees[0]?.isLocked).toBe(true);
  });

  it('orphan detection: owning task cancelled → status=orphan', async () => {
    MOCK_TASK_ROWS.set('T400', 'cancelled');
    installGitMock({
      porcelainOutput: porcelain([{ path: '/tmp/wt/T400', branch: 'task/T400' }]),
      branchTimestamps: { 'task/T400': nowIso(0) },
      mergedBranches: new Set(),
    });

    const result = await listWorktrees({ projectRoot: '/tmp/project' });
    if (!result.success) throw new Error('expected success');
    expect(result.data.worktrees[0]?.statusCategory).toBe('orphan');
    expect(result.data.worktrees[0]?.owningTaskStatus).toBe('cancelled');
  });

  it('orphan detection: task row missing → status=orphan', async () => {
    // T500 is NOT in MOCK_TASK_ROWS — simulating a deleted task / dangling branch.
    installGitMock({
      porcelainOutput: porcelain([{ path: '/tmp/wt/T500', branch: 'task/T500' }]),
      branchTimestamps: { 'task/T500': nowIso(0) },
      mergedBranches: new Set(),
    });

    const result = await listWorktrees({ projectRoot: '/tmp/project' });
    if (!result.success) throw new Error('expected success');
    expect(result.data.worktrees[0]?.statusCategory).toBe('orphan');
    expect(result.data.worktrees[0]?.owningTaskStatus).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe('listWorktrees — --status filter', () => {
  it('returns subset matching the requested category', async () => {
    MOCK_TASK_ROWS.set('T1', 'active');
    MOCK_TASK_ROWS.set('T2', 'cancelled');
    MOCK_TASK_ROWS.set('T3', 'done');
    installGitMock({
      porcelainOutput: porcelain([
        { path: '/wt/T1', branch: 'task/T1' },
        { path: '/wt/T2', branch: 'task/T2' },
        { path: '/wt/T3', branch: 'task/T3' },
      ]),
      branchTimestamps: {
        'task/T1': new Date().toISOString(),
        'task/T2': new Date().toISOString(),
        'task/T3': new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
      mergedBranches: new Set(['task/T3']),
    });

    const result = await listWorktrees({
      projectRoot: '/tmp/project',
      statusFilter: ['orphan', 'merged'],
    });
    if (!result.success) throw new Error('expected success');
    const categories = result.data.worktrees.map((w) => w.statusCategory).sort();
    expect(categories).toEqual(['merged', 'orphan']);
  });

  it('returns ALL entries when statusFilter is omitted', async () => {
    MOCK_TASK_ROWS.set('T1', 'active');
    MOCK_TASK_ROWS.set('T2', 'cancelled');
    installGitMock({
      porcelainOutput: porcelain([
        { path: '/wt/T1', branch: 'task/T1' },
        { path: '/wt/T2', branch: 'task/T2' },
      ]),
      branchTimestamps: {
        'task/T1': new Date().toISOString(),
        'task/T2': new Date().toISOString(),
      },
      mergedBranches: new Set(),
    });

    const result = await listWorktrees({ projectRoot: '/tmp/project' });
    if (!result.success) throw new Error('expected success');
    expect(result.data.worktrees).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Performance budget
// ---------------------------------------------------------------------------

describe('listWorktrees — performance budget', () => {
  it('returns 50 mock worktrees in < 500ms', async () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      path: `/tmp/wt/T${i + 1000}`,
      branch: `task/T${i + 1000}`,
    }));
    for (const entry of entries) {
      const taskId = entry.branch.slice('task/'.length);
      MOCK_TASK_ROWS.set(taskId, 'active');
    }
    const timestamps: Record<string, string> = {};
    for (const e of entries) timestamps[e.branch] = new Date().toISOString();
    installGitMock({
      porcelainOutput: porcelain(entries),
      branchTimestamps: timestamps,
      mergedBranches: new Set(),
    });

    const t0 = performance.now();
    const result = await listWorktrees({ projectRoot: '/tmp/project' });
    const elapsedMs = performance.now() - t0;

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.worktrees).toHaveLength(50);
    expect(elapsedMs).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Error surface
// ---------------------------------------------------------------------------

describe('listWorktrees — error surface', () => {
  it('returns engineError when git worktree list fails', async () => {
    mockExec.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });

    const result = await listWorktrees({ projectRoot: '/tmp/not-a-repo' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error.code).toBe('E_GIT_FAILED');
    expect(result.error.message).toContain('fatal: not a git repository');
  });
});
