/**
 * Unit tests for the structured worktree-list primitive (T9546).
 *
 * Covers:
 *  - Happy path: porcelain output → classified WorktreeInfo entries
 *  - Each statusCategory (`active|redundant|keep|unknown`, T14274) is reachable
 *  - --status filter narrows results
 *  - taskIdFromBranch convention
 *  - isDisposalCandidate / classifyStatus (the disposal proof decides candidates)
 *  - 50-worktree performance budget (<500ms with mocked git/db calls)
 *
 * @task T9546
 * @epic T9515
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
// Mock the project tasks store (E6-L6 / T11526): loadOwningTaskStatuses now
// resolves task statuses via getDb()/getNativeTasksDb() against the consolidated
// project cleo.db (which carries the legacy `tasks` table). We stub the native
// handle so it yields the rows the current test configured via `MOCK_TASK_ROWS`.
// ---------------------------------------------------------------------------
const MOCK_TASK_ROWS = new Map<string, string>();
const stubNativeTasksDb = {
  prepare: (_sql: string) => ({
    all: (...ids: string[]) =>
      ids
        .filter((id) => MOCK_TASK_ROWS.has(id))
        .map((id) => ({ id, status: MOCK_TASK_ROWS.get(id) })),
  }),
};
vi.mock('../../store/sqlite.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/sqlite.js')>();
  return {
    ...actual,
    getDb: vi.fn(async () => ({}) as never),
    getNativeTasksDb: vi.fn(() => stubNativeTasksDb as never),
  };
});

const mockExec = vi.mocked(execFileSync);

import type { DisposeWorktreeResult } from '@cleocode/contracts';
import {
  branchIsMergedToMain,
  classifyStatus,
  enumerateWorktrees,
  isDisposalCandidate,
  isPrimaryWorktree,
  listWorktrees,
  resolvePrimaryWorktreePath,
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
    // T14236: each entry reports its own HEAD; the git mock maps `sha-<branch>`
    // back to the branch so per-branch fixtures keep working.
    const lines: string[] = [`worktree ${e.path}`, `HEAD sha-${e.branch || 'detached'}`];
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
  /**
   * Optional absolute path to the primary worktree's `.git` directory, returned by
   * `git rev-parse --path-format=absolute --git-common-dir` (T9686-D primary
   * guard). When omitted, the call throws so the guard falls back gracefully.
   */
  gitCommonDir?: string;
}): void {
  const merged = opts.mergedBranches ?? new Set<string>();
  const timestamps = opts.branchTimestamps ?? {};
  const mainExists = opts.mainExists !== false;

  mockExec.mockImplementation((_cmd: string, args?: readonly string[]) => {
    const argv = (args ?? []) as readonly string[];
    if (argv[0] === 'worktree' && argv[1] === 'list') {
      return opts.porcelainOutput as never;
    }
    if (argv[0] === 'rev-list' && argv[1] === '--first-parent') {
      return 'sha-main\n' as never;
    }
    if (argv[0] === 'log' && argv[1] === '-1') {
      const branch = argv[3]?.replace(/^sha-/, '');
      if (branch && timestamps[branch]) return `${timestamps[branch]}\n` as never;
      throw new Error('no log for branch');
    }
    if (argv[0] === 'merge-base' && argv[1] === '--is-ancestor') {
      const branch = argv[2]?.replace(/^sha-/, '');
      if (branch && merged.has(branch)) return '' as never;
      const err = new Error('not an ancestor');
      throw err;
    }
    if (argv[0] === 'rev-parse' && argv[1] === '--verify') {
      if (mainExists) return '' as never;
      throw new Error('no main');
    }
    if (argv[0] === 'rev-parse' && argv.includes('--git-common-dir')) {
      if (opts.gitCommonDir !== undefined) return `${opts.gitCommonDir}\n` as never;
      throw new Error('git-common-dir unavailable');
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

  it('T14236: also fix/, test/ and chore/ branches', () => {
    expect(taskIdFromBranch('fix/T13098-x')).toBe('T13098');
    expect(taskIdFromBranch('test/T12895')).toBe('T12895');
    expect(taskIdFromBranch('chore/T1-y')).toBe('T1');
  });

  it('returns null for non-task branches', () => {
    expect(taskIdFromBranch('main')).toBeNull();
    expect(taskIdFromBranch('feat/foo')).toBeNull();
    expect(taskIdFromBranch('release/v2026.5.78')).toBeNull();
    expect(taskIdFromBranch('task/foo')).toBeNull();
  });
});

describe('isDisposalCandidate (T14274)', () => {
  const flags = (owningTaskStatus: string | null, idlePastWindow = false, isPrimary = false) => ({
    isPrimary,
    owningTaskStatus,
    idlePastWindow,
  });

  it('a done or cancelled task makes a candidate; an open task never does', () => {
    expect(isDisposalCandidate(flags('done'))).toBe(true);
    expect(isDisposalCandidate(flags('cancelled'))).toBe(true);
    expect(isDisposalCandidate(flags('active', true))).toBe(false);
    expect(isDisposalCandidate(flags('pending', true))).toBe(false);
  });

  it('a worktree with no stored task is a candidate only once idle past the window', () => {
    expect(isDisposalCandidate(flags(null, false))).toBe(false);
    expect(isDisposalCandidate(flags(null, true))).toBe(true);
  });

  it('primary-worktree guard: the primary checkout is never a candidate (T9686-D)', () => {
    expect(isDisposalCandidate(flags('done', true, true))).toBe(false);
  });
});

describe('classifyStatus (T14274)', () => {
  const proof = (extra: Partial<DisposeWorktreeResult>): DisposeWorktreeResult => ({
    worktreePath: '/wt',
    removed: false,
    ...extra,
  });

  it('a non-candidate is active', () => {
    expect(classifyStatus(null)).toEqual({ statusCategory: 'active' });
  });

  it('a holding proof is redundant', () => {
    expect(classifyStatus(proof({}))).toEqual({ statusCategory: 'redundant' });
  });

  it('a failed clause is keep, naming it', () => {
    const keptReason = 'not proven preserved: uncommitted or untracked changes';
    expect(classifyStatus(proof({ keptReason, unpreserved: 'x' }))).toEqual({
      statusCategory: 'keep',
      keepReason: keptReason,
    });
  });

  it('a probe that could not answer is unknown, never redundant', () => {
    const keptReason = 'not proven preserved: git status failed';
    expect(classifyStatus(proof({ keptReason, indeterminate: true }))).toEqual({
      statusCategory: 'unknown',
      keepReason: keptReason,
    });
  });
});

// ---------------------------------------------------------------------------
// Primary-worktree detection (T9686-D)
// ---------------------------------------------------------------------------

describe('resolvePrimaryWorktreePath', () => {
  it('strips trailing .git from the git-common-dir output', () => {
    mockExec.mockReturnValueOnce('/repo/.git\n' as never);
    expect(resolvePrimaryWorktreePath('/repo')).toBe('/repo');
  });

  it('strips trailing .git/ with slash', () => {
    mockExec.mockReturnValueOnce('/repo/.git/\n' as never);
    expect(resolvePrimaryWorktreePath('/repo')).toBe('/repo');
  });

  it('returns null when git fails', () => {
    mockExec.mockImplementationOnce(() => {
      throw new Error('not a git repo');
    });
    expect(resolvePrimaryWorktreePath('/elsewhere')).toBeNull();
  });

  it('returns null when stdout is empty', () => {
    mockExec.mockReturnValueOnce('\n' as never);
    expect(resolvePrimaryWorktreePath('/repo')).toBeNull();
  });
});

describe('isPrimaryWorktree', () => {
  it('returns true when worktree path equals primary path', () => {
    expect(isPrimaryWorktree('/repo', '/repo')).toBe(true);
  });

  it('returns true after path normalization', () => {
    expect(isPrimaryWorktree('/repo/./foo/..', '/repo')).toBe(true);
  });

  it('returns false for a different path', () => {
    expect(isPrimaryWorktree('/repo/wt/T1', '/repo')).toBe(false);
  });

  it('returns false when primaryPath is null', () => {
    expect(isPrimaryWorktree('/repo', null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Porcelain parsing
// ---------------------------------------------------------------------------

describe('enumerateWorktrees', () => {
  it('parses a single worktree entry', () => {
    mockExec.mockReturnValue(porcelain([{ path: '/tmp/wt/T1', branch: 'task/T1' }]) as never);
    const out = enumerateWorktrees('/tmp/project');
    expect(out).toEqual([
      { path: '/tmp/wt/T1', branch: 'task/T1', locked: false, head: 'sha-task/T1' },
    ]);
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

  it('a done task idle > 7 days is a candidate: redundant, with the stale annotation', async () => {
    MOCK_TASK_ROWS.set('T100', 'done');
    installGitMock({
      porcelainOutput: porcelain([{ path: '/tmp/wt/T100', branch: 'task/T100' }]),
      branchTimestamps: { 'task/T100': nowIso(30) },
      mergedBranches: new Set(),
    });

    const result = await listWorktrees({ projectRoot: '/tmp/project' });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.worktrees[0]?.statusCategory).toBe('redundant');
    expect(result.data.worktrees[0]?.isStale).toBe(true);
  });

  it('merged work of an open task stays active; isMerged is an annotation', async () => {
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
    expect(wt?.statusCategory).toBe('active');
  });

  it('kept: reports the keep marker a disposal left beside the worktree (T13701)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'list-kept-'));
    const path = join(dir, 'T250');
    const marker = {
      taskId: 'T250',
      reason: 'complete',
      projectRoot: '/tmp/project',
      dependents: [join(dir, 'T251', 'node_modules')],
      evidence: [],
      keptAt: nowIso(0),
    };
    writeFileSync(`${path}.keep.json`, JSON.stringify(marker));
    installGitMock({
      porcelainOutput: porcelain([
        { path, branch: 'task/T250' },
        { path: join(dir, 'T251'), branch: 'task/T251' },
      ]),
      branchTimestamps: { 'task/T250': nowIso(0), 'task/T251': nowIso(0) },
    });

    try {
      const result = await listWorktrees({ projectRoot: '/tmp/project' });
      if (!result.success) throw new Error('expected success');
      expect(result.data.worktrees[0]?.kept).toEqual(marker);
      expect(result.data.worktrees[1]).not.toHaveProperty('kept');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a git-locked worktree of an open task is active; isLocked is an annotation', async () => {
    MOCK_TASK_ROWS.set('T300', 'active');
    installGitMock({
      porcelainOutput: porcelain([{ path: '/tmp/wt/T300', branch: 'task/T300', locked: true }]),
      branchTimestamps: { 'task/T300': nowIso(0) },
      mergedBranches: new Set(),
    });

    const result = await listWorktrees({ projectRoot: '/tmp/project' });
    if (!result.success) throw new Error('expected success');
    expect(result.data.worktrees[0]?.statusCategory).toBe('active');
    expect(result.data.worktrees[0]?.isLocked).toBe(true);
  });

  it('a cancelled task is a candidate: redundant when the proof holds', async () => {
    MOCK_TASK_ROWS.set('T400', 'cancelled');
    installGitMock({
      porcelainOutput: porcelain([{ path: '/tmp/wt/T400', branch: 'task/T400' }]),
      branchTimestamps: { 'task/T400': nowIso(0) },
      mergedBranches: new Set(),
    });

    const result = await listWorktrees({ projectRoot: '/tmp/project' });
    if (!result.success) throw new Error('expected success');
    expect(result.data.worktrees[0]?.statusCategory).toBe('redundant');
    expect(result.data.worktrees[0]?.owningTaskStatus).toBe('cancelled');
  });

  it('a missing task row inside the stale window is active (a fresh worktree)', async () => {
    // T500 is NOT in MOCK_TASK_ROWS — simulating a deleted task / dangling branch.
    installGitMock({
      porcelainOutput: porcelain([{ path: '/tmp/wt/T500', branch: 'task/T500' }]),
      branchTimestamps: { 'task/T500': nowIso(0) },
      mergedBranches: new Set(),
    });

    const result = await listWorktrees({ projectRoot: '/tmp/project' });
    if (!result.success) throw new Error('expected success');
    expect(result.data.worktrees[0]?.statusCategory).toBe('active');
    expect(result.data.worktrees[0]?.owningTaskStatus).toBeNull();
  });

  it('primary worktree on main is classified active, NOT merged (T9686-D)', async () => {
    // Simulates the production bug: the canonical project checkout sits on
    // `main` which is trivially its own ancestor, so without the
    // primary-worktree guard the classifier would label it `merged` and
    // `cleo worktree prune --orphaned` would offer to delete the project root.
    installGitMock({
      porcelainOutput: porcelain([{ path: '/repo', branch: 'main' }]),
      branchTimestamps: { main: nowIso(0) },
      mergedBranches: new Set(['main']),
      gitCommonDir: '/repo/.git',
    });

    const result = await listWorktrees({ projectRoot: '/repo' });
    if (!result.success) throw new Error('expected success');
    const wt = result.data.worktrees[0];
    expect(wt?.path).toBe('/repo');
    expect(wt?.statusCategory).toBe('active');
    // T14236: a HEAD on main's own line carries no commits of its own, so it is
    // not merged work; the category guard still keeps it out of prune.
    expect(wt?.isMerged).toBe(false);
  });

  it('primary-guard does not affect secondary worktrees (T9686-D)', async () => {
    MOCK_TASK_ROWS.set('T9001', 'active');
    installGitMock({
      porcelainOutput: porcelain([
        { path: '/repo', branch: 'main' },
        { path: '/repo/.cleo/worktrees/T9001', branch: 'task/T9001' },
      ]),
      branchTimestamps: { main: nowIso(0), 'task/T9001': nowIso(0) },
      mergedBranches: new Set(['main', 'task/T9001']),
      gitCommonDir: '/repo/.git',
    });

    const result = await listWorktrees({ projectRoot: '/repo' });
    if (!result.success) throw new Error('expected success');
    const byPath = new Map(result.data.worktrees.map((w) => [w.path, w]));
    expect(byPath.get('/repo')?.statusCategory).toBe('active');
    // Secondary worktree: the guard only protects the primary; this one is
    // active because its task is open (T14274), not because of the guard.
    expect(byPath.get('/repo/.cleo/worktrees/T9001')?.statusCategory).toBe('active');
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
      statusFilter: ['redundant'],
    });
    if (!result.success) throw new Error('expected success');
    // T1 (open task) is active; T2 (cancelled) and T3 (done) are redundant.
    expect(result.data.worktrees.map((w) => w.path).sort()).toEqual(['/wt/T2', '/wt/T3']);
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
