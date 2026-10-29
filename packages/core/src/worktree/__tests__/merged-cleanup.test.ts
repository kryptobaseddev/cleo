/**
 * Merged-work cleanup (T14142) over a real git fixture: a bare `origin`, a
 * project clone and canonical task worktrees under a sandboxed CLEO_HOME.
 *
 * @task T14142
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Tasks the fixture's store holds as still open; every other task is done. */
const openTasks = new Set<string>();
vi.mock('../../store/data-accessor.js', () => ({
  getTaskAccessor: async () => ({
    loadSingleTask: async (id: string) => ({ id, status: openTasks.has(id) ? 'active' : 'done' }),
  }),
}));
const lockedTasks = new Set<string>();
vi.mock('@cleocode/worktree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/worktree')>();
  return {
    ...actual,
    readWorktreeTaskLock: (_hash: string, taskId: string) =>
      lockedTasks.has(taskId)
        ? ({ taskId } as ReturnType<typeof actual.readWorktreeTaskLock>)
        : actual.readWorktreeTaskLock(_hash, taskId),
  };
});

const { cleanupMergedWork } = await import('../merged-cleanup.js');
const { computeProjectHash, resolveWorktreeRootForHash } = await import('@cleocode/paths');

let tmp: string;
let project: string;
let wtRoot: string;
const savedHome = process.env['CLEO_HOME'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-C', cwd, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

/** A canonical task worktree on `task/<id>-x`, with one commit. */
function taskWorktree(taskId: string): string {
  const path = join(wtRoot, taskId);
  git(project, 'worktree', 'add', '-q', '-b', `task/${taskId}-x`, path, 'origin/main');
  writeFileSync(join(path, `${taskId}.txt`), taskId);
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', taskId);
  return path;
}

/** Merge a task branch into main and push it (the PR merged). */
function mergeTask(taskId: string): void {
  git(project, 'merge', '-q', '--no-ff', '-m', `merge ${taskId}`, `task/${taskId}-x`);
  git(project, 'push', '-q', 'origin', 'main', `task/${taskId}-x`);
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-merged-cleanup-')));
  process.env['CLEO_HOME'] = join(tmp, 'cleo-home');
  const origin = join(tmp, 'origin.git');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  project = join(tmp, 'project');
  git(tmp, 'clone', '-q', origin, project);
  writeFileSync(join(project, 'README.md'), 'x');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'root');
  git(project, 'push', '-q', '-u', 'origin', 'main');
  git(project, 'remote', 'set-head', 'origin', 'main');
  wtRoot = resolveWorktreeRootForHash(computeProjectHash(project));
  mkdirSync(wtRoot, { recursive: true });
  lockedTasks.clear();
  openTasks.clear();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

const noOpenPrs = { openPrHeads: () => new Set<string>() };

describe('cleanupMergedWork', () => {
  it('dry run (the default) lists a clean merged worktree and its branches, deleting nothing', async () => {
    const path = taskWorktree('T1');
    mergeTask('T1');
    const r = await cleanupMergedWork({ projectRoot: project, taskIds: ['T1'] }, noOpenPrs);
    expect(r.dryRun).toBe(true);
    expect(r.worktrees).toMatchObject([{ target: path, taskId: 'T1', removed: true }]);
    expect(r.worktrees[0]?.bytes).toBeGreaterThan(0);
    expect(r.localBranches).toMatchObject([{ target: 'task/T1-x', removed: true }]);
    expect(r.remoteBranches).toMatchObject([{ target: 'task/T1-x', removed: true }]);
    expect(r.bytesReclaimed).toBe(r.worktrees[0]?.bytes);
    expect(existsSync(path)).toBe(true);
    expect(git(project, 'branch', '--list', 'task/T1-x')).not.toBe('');
  });

  it('applies: removes the worktree, the local branch and the branch on origin', async () => {
    const path = taskWorktree('T1');
    mergeTask('T1');
    const r = await cleanupMergedWork(
      { projectRoot: project, taskIds: ['T1'], dryRun: false },
      noOpenPrs,
    );
    expect(r.worktrees[0]?.removed).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(git(project, 'branch', '--list', 'task/T1-x')).toBe('');
    expect(git(project, 'ls-remote', '--heads', 'origin', 'task/T1-x')).toBe('');
    // The audit row names the deleted tip and the command that restores it.
    const sha = r.remoteBranches[0]?.sha ?? '';
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const audit = readFileSync(join(project, '.cleo', 'audit', 'worktree-lifecycle.jsonl'), 'utf8');
    expect(audit).toContain(`git push origin ${sha}:refs/heads/task/T1-x`);
  });

  it('keeps a branch whose tip moved after the proof, locally and on origin', async () => {
    taskWorktree('T8');
    mergeTask('T8');
    const moveTips = () => {
      const tip = git(project, 'rev-parse', 'task/T8-x');
      const moved = git(project, 'commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'landed late');
      git(project, 'update-ref', 'refs/heads/task/T8-x', moved);
      git(project, 'push', '-q', 'origin', `${moved}:refs/heads/task/T8-x`);
      return moved;
    };
    let moved = '';
    const r = await cleanupMergedWork(
      { projectRoot: project, taskIds: ['T8'], dryRun: false },
      { ...noOpenPrs, afterProof: () => (moved = moveTips()) },
    );
    expect(r.localBranches).toMatchObject([
      { target: 'task/T8-x', removed: false, reason: 'tip moved after the proof' },
    ]);
    expect(r.remoteBranches).toMatchObject([
      {
        target: 'task/T8-x',
        removed: false,
        reason: 'tip moved after the proof, or the push failed',
      },
    ]);
    expect(git(project, 'rev-parse', 'task/T8-x')).toBe(moved);
    expect(git(project, 'ls-remote', '--heads', 'origin', 'task/T8-x')).toContain(moved);
  });

  it('keeps a worktree with ignored content the main checkout lacks; an unchanged seeded copy is fine', async () => {
    writeFileSync(join(project, '.gitignore'), '.env\n');
    writeFileSync(join(project, '.env'), 'SEED=1\n');
    git(project, 'add', '.gitignore');
    git(project, 'commit', '-q', '-m', 'ignore .env');
    git(project, 'push', '-q', 'origin', 'main');
    for (const id of ['T10', 'T11']) {
      taskWorktree(id);
      mergeTask(id);
    }
    writeFileSync(join(wtRoot, 'T10', '.env'), 'SEED=1\n'); // seeded, unchanged
    writeFileSync(join(wtRoot, 'T11', '.env'), 'SEED=1\nSECRET=edited\n'); // edited
    const r = await cleanupMergedWork(
      { projectRoot: project, taskIds: ['T10', 'T11'], dryRun: false },
      noOpenPrs,
    );
    const byTask = Object.fromEntries(r.worktrees.map((w) => [w.taskId, [w.removed, w.reason]]));
    expect(byTask['T10']?.[0]).toBe(true);
    expect(byTask['T11']).toEqual([false, 'ignored content not in the main checkout: .env']);
    expect(existsSync(join(wtRoot, 'T11', '.env'))).toBe(true);
  });

  it("keeps a worktree holding an agent's nested .claude/worktrees checkout", async () => {
    writeFileSync(join(project, '.gitignore'), '.claude/worktrees/\n');
    git(project, 'add', '.gitignore');
    git(project, 'commit', '-q', '-m', 'ignore agent worktrees');
    git(project, 'push', '-q', 'origin', 'main');
    const path = taskWorktree('T12');
    mergeTask('T12');
    const agent = join(path, '.claude', 'worktrees', 'agent-1');
    git(project, 'worktree', 'add', '-q', '--detach', agent, 'origin/main');
    writeFileSync(join(agent, 'work-in-progress.txt'), 'uncommitted');
    const r = await cleanupMergedWork(
      { projectRoot: project, taskIds: ['T12'], dryRun: false },
      noOpenPrs,
    );
    expect(r.worktrees).toMatchObject([{ taskId: 'T12', removed: false }]);
    expect(existsSync(join(agent, 'work-in-progress.txt'))).toBe(true);
  });

  it('never follows a symlink out of the worktree root', async () => {
    symlinkSync(project, join(wtRoot, 'escape'));
    const host = join(wtRoot, 'wave-b');
    git(project, 'worktree', 'add', '-q', host, 'origin/main');
    symlinkSync(project, join(host, 'scratch'));
    const r = await cleanupMergedWork(
      { projectRoot: project, taskIds: [], dryRun: false },
      noOpenPrs,
    );
    expect(r.nestedCopies).toEqual([]);
    expect(existsSync(join(project, 'README.md'))).toBe(true);
    expect(existsSync(join(project, '.git'))).toBe(true);
  });

  it('keeps a nested copy whose only extra commit is on a tag, or only in its HEAD reflog', async () => {
    const host = join(wtRoot, 'wave-c');
    git(project, 'worktree', 'add', '-q', host, 'origin/main');
    const tagged = join(host, 'tagged');
    const reflogged = join(host, 'reflogged');
    for (const copy of [tagged, reflogged]) {
      cpSync(project, copy, { recursive: true });
      git(copy, 'commit', '-q', '--allow-empty', '-m', 'not on origin');
    }
    git(tagged, 'tag', 'only-here');
    git(tagged, 'reset', '-q', '--hard', 'HEAD~1');
    git(reflogged, 'reset', '-q', '--hard', 'HEAD~1');
    const r = await cleanupMergedWork(
      { projectRoot: project, taskIds: [], dryRun: false },
      noOpenPrs,
    );
    const reasons = Object.fromEntries(r.nestedCopies.map((n) => [n.target, n.reason]));
    expect(reasons[tagged]).toBe('holds commits not on origin');
    expect(reasons[reflogged]).toBe('holds commits not on origin');
    expect(existsSync(tagged)).toBe(true);
    expect(existsSync(reflogged)).toBe(true);
  });

  it('deletes nothing of any kind when the fetch fails', async () => {
    const path = taskWorktree('T13');
    mergeTask('T13');
    git(project, 'remote', 'set-url', 'origin', join(tmp, 'no-such-origin.git'));
    const r = await cleanupMergedWork(
      { projectRoot: project, taskIds: ['T13'], dryRun: false },
      noOpenPrs,
    );
    expect(r.skippedReason).toContain('git fetch origin failed');
    expect(r.worktrees).toEqual([]);
    expect(r.localBranches).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  it('keeps a dirty, a git-locked, a lock-held and an unmerged worktree', async () => {
    for (const id of ['T2', 'T3', 'T4']) {
      taskWorktree(id);
      mergeTask(id);
    }
    const unmerged = taskWorktree('T5');
    git(project, 'push', '-q', 'origin', 'task/T5-x');
    writeFileSync(join(wtRoot, 'T2', 'scratch.txt'), 'uncommitted');
    git(project, 'worktree', 'lock', join(wtRoot, 'T3'));
    lockedTasks.add('T4');

    const r = await cleanupMergedWork(
      { projectRoot: project, taskIds: ['T2', 'T3', 'T4', 'T5'], dryRun: false },
      noOpenPrs,
    );
    const reasons = Object.fromEntries(r.worktrees.map((w) => [w.taskId, [w.removed, w.reason]]));
    expect(reasons).toEqual({
      T2: [false, 'uncommitted or untracked changes'],
      T3: [false, 'git-locked'],
      T4: [false, 'task lock held'],
      T5: [false, 'unmerged: not in origin/main'],
    });
    for (const id of ['T2', 'T3', 'T4']) expect(existsSync(join(wtRoot, id))).toBe(true);
    expect(existsSync(unmerged)).toBe(true);
    // Their branches stay too: checked out, or (T5) unmerged on both sides.
    expect(r.localBranches.every((b) => !b.removed)).toBe(true);
    expect(r.remoteBranches.find((b) => b.taskId === 'T5')).toMatchObject({
      removed: false,
      reason: 'unmerged: not in origin/main',
    });
    expect(git(project, 'ls-remote', '--heads', 'origin', 'task/T5-x')).not.toBe('');
  });

  it('never touches a named task that is still open (a Refs: PR, more to come)', async () => {
    const path = taskWorktree('T9');
    mergeTask('T9');
    openTasks.add('T9');
    const r = await cleanupMergedWork(
      { projectRoot: project, taskIds: ['T9'], dryRun: false },
      noOpenPrs,
    );
    expect(r.worktrees).toEqual([]);
    expect(r.localBranches).toEqual([]);
    expect(r.remoteBranches).toEqual([]);
    expect(existsSync(path)).toBe(true);
    expect(git(project, 'ls-remote', '--heads', 'origin', 'task/T9-x')).not.toBe('');
  });

  it('never touches tasks outside the scope, nor origin when open PRs cannot be read', async () => {
    taskWorktree('T6');
    mergeTask('T6');
    const r = await cleanupMergedWork(
      { projectRoot: project, taskIds: ['T7'], dryRun: false },
      { openPrHeads: () => null },
    );
    expect(r.worktrees).toEqual([]);
    expect(existsSync(join(wtRoot, 'T6'))).toBe(true);
    const r2 = await cleanupMergedWork(
      { projectRoot: project, taskIds: ['T6'] },
      { openPrHeads: () => null },
    );
    expect(r2.remoteBranches).toMatchObject([
      { target: 'task/T6-x', removed: false, reason: 'open pull requests could not be read' },
    ]);
  });

  it('removes a redundant nested repo copy and keeps one holding an unpushed commit, reporting bytes', async () => {
    const host = join(wtRoot, 'wave-a');
    git(project, 'worktree', 'add', '-q', host, 'origin/main');
    const redundant = join(host, 'copy-a');
    const unpushed = join(host, 'nested', 'copy-b');
    cpSync(project, redundant, { recursive: true });
    cpSync(project, unpushed, { recursive: true });
    writeFileSync(join(unpushed, 'local.txt'), 'only here');
    git(unpushed, 'add', '.');
    git(unpushed, 'commit', '-q', '-m', 'local only');

    const r = await cleanupMergedWork(
      { projectRoot: project, taskIds: [], dryRun: false },
      noOpenPrs,
    );
    const byPath = Object.fromEntries(r.nestedCopies.map((n) => [n.target, n]));
    expect(byPath[redundant]).toMatchObject({ removed: true });
    expect(byPath[redundant]?.bytes).toBeGreaterThan(0);
    expect(byPath[unpushed]).toMatchObject({
      removed: false,
      reason: 'holds commits not on origin',
    });
    expect(existsSync(redundant)).toBe(false);
    expect(existsSync(unpushed)).toBe(true);
    expect(r.bytesReclaimed).toBe(byPath[redundant]?.bytes);
  });
});
