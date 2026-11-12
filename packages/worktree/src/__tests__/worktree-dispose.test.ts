/**
 * The one worktree disposal engine (T13924): removal only with proof that
 * nothing is lost, every failed probe counts as not safe, and `force`
 * archives (ref + patch + receipt) before it removes.
 *
 * Real git: a project repository with a bare `origin`, and linked worktrees
 * under a sandboxed CLEO_HOME.
 *
 * @task T13924
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeProjectHash, resolveWorktreeRootForHash } from '../paths.js';
import { destroyWorktree } from '../worktree-destroy.js';
import { disposeWorktree, unpreservedCommits } from '../worktree-dispose.js';
import { pruneWorktrees } from '../worktree-prune.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

const prevCleoHome = process.env['CLEO_HOME'];
let base: string;
let repo: string;
let wtRoot: string;

/** A linked worktree for `taskId` on `task/<taskId>`, at main's commit. */
function worktree(taskId: string): string {
  const path = join(wtRoot, taskId);
  git(repo, 'worktree', 'add', '-q', '-b', `task/${taskId}`, path);
  return path;
}

/** Commit `file` on the worktree's own branch. */
function commitIn(path: string, file: string, body: string): void {
  writeFileSync(join(path, file), body);
  git(path, 'add', file);
  git(path, 'commit', '-q', '-m', `add ${file}`);
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dispose-engine-')));
  process.env['CLEO_HOME'] = base;
  const origin = join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  repo = join(base, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'user.email', 't@e.x');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n.env\ndist\n');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  wtRoot = resolveWorktreeRootForHash(computeProjectHash(repo));
  mkdirSync(wtRoot, { recursive: true });
});

afterEach(() => {
  if (prevCleoHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = prevCleoHome;
  rmSync(base, { recursive: true, force: true });
});

describe('disposeWorktree proof (T13924)', () => {
  it('a report-only proof leaves the Git index unchanged when file metadata changes', () => {
    const wt = worktree('T20');
    const tracked = join(wt, 'a.ts');
    const stat = statSync(tracked);
    utimesSync(tracked, stat.atime, new Date(stat.mtimeMs - 60_000));
    const index = git(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    const before = readFileSync(index);
    const result = disposeWorktree({
      worktreePath: wt,
      taskId: 'T20',
      reason: 'test',
      dryRun: true,
    });
    expect(result).toEqual({ worktreePath: wt, removed: false });
    expect(readFileSync(index)).toEqual(before);
    expect(existsSync(wt)).toBe(true);
  });

  it('removes a clean worktree whose commits are on another branch, node_modules and all', () => {
    const wt = worktree('T1');
    mkdirSync(join(wt, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(wt, 'node_modules', 'dep', 'i.js'), 'x\n');
    const r = disposeWorktree({ worktreePath: wt, taskId: 'T1', reason: 'test' });
    expect(r).toMatchObject({ removed: true });
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(wt);
  });

  it('treats an untracked node_modules symlink as redundant, and the archive skips it', () => {
    const wt = worktree('T15');
    // A `node_modules/` ignore pattern misses a symlink: it shows as untracked.
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.env\ndist\n');
    git(repo, 'commit', '-qam', 'dir-only ignore');
    git(wt, 'merge', '-q', 'main');
    mkdirSync(join(repo, 'node_modules'));
    symlinkSync(join(repo, 'node_modules'), join(wt, 'node_modules'));
    writeFileSync(join(wt, 'wip.ts'), 'wip\n');
    const r = disposeWorktree({ worktreePath: wt, taskId: 'T15', reason: 'test', force: true });
    expect(r.removed).toBe(true);
    expect(git(repo, 'ls-tree', '-r', '--name-only', r.archive?.archiveSha ?? '')).not.toContain(
      'node_modules',
    );
    expect(existsSync(join(repo, 'node_modules'))).toBe(true);
    // Without wip.ts it needs no archive at all.
    const clean = worktree('T16');
    symlinkSync(join(repo, 'node_modules'), join(clean, 'node_modules'));
    expect(disposeWorktree({ worktreePath: clean, taskId: 'T16', reason: 'test' })).toMatchObject({
      removed: true,
    });
  });

  it('removes a git-locked clean worktree and drops its registration', () => {
    const wt = worktree('T2');
    git(repo, 'worktree', 'lock', wt);
    expect(disposeWorktree({ worktreePath: wt, taskId: 'T2', reason: 'test' }).removed).toBe(true);
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it.each([
    [
      'a tracked change',
      (wt: string) => writeFileSync(join(wt, 'a.ts'), 'changed\n'),
      'uncommitted',
    ],
    ['an untracked file', (wt: string) => writeFileSync(join(wt, 'new.ts'), 'x\n'), 'uncommitted'],
    [
      'an ignored file not in the main checkout',
      (wt: string) => writeFileSync(join(wt, '.env'), 'S=1\n'),
      '.env',
    ],
    [
      'a commit held by no remote and no other branch',
      (wt: string) => commitIn(wt, 'w.ts', 'w\n'),
      'commit',
    ],
  ])('keeps a worktree holding %s, untouched', (_label, change, clause) => {
    const wt = worktree('T3');
    change(wt);
    const r = disposeWorktree({ worktreePath: wt, taskId: 'T3', reason: 'test' });
    expect(r.removed).toBe(false);
    expect(r.unpreserved).toContain(clause);
    expect(r.keptReason).toContain('not proven preserved');
    expect(r.indeterminate).toBeUndefined();
    expect(existsSync(wt)).toBe(true);
  });

  it('a commit held only by a sibling task branch is kept; once on local main it may go', () => {
    const wt = worktree('T17');
    commitIn(wt, 'w.ts', 'w\n');
    git(repo, 'branch', 'task/T18', 'task/T17'); // a sibling task branch holds it too
    expect(unpreservedCommits(wt)).toContain('not on the default branch');
    expect(disposeWorktree({ worktreePath: wt, taskId: 'T17', reason: 'test' }).removed).toBe(
      false,
    );
    git(repo, 'merge', '-q', '--no-ff', '-m', 'local integration', 'task/T17');
    expect(unpreservedCommits(wt)).toBeNull();
    expect(disposeWorktree({ worktreePath: wt, taskId: 'T17', reason: 'test' }).removed).toBe(true);
  });

  it('a commit integrated into the named default branch (core getDefaultBranch) is preserved', () => {
    const wt = worktree('T19');
    commitIn(wt, 'w.ts', 'w\n');
    git(repo, 'branch', 'trunk', 'main');
    git(repo, 'checkout', '-q', 'trunk');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'integrate', 'task/T19');
    git(repo, 'checkout', '-q', 'main');
    // Without the name, main is the default branch, and main lacks the commit.
    expect(unpreservedCommits(wt)).toContain('not on the default branch');
    expect(unpreservedCommits(wt, 'trunk')).toBeNull();
    const r = disposeWorktree({
      worktreePath: wt,
      taskId: 'T19',
      reason: 'test',
      defaultBranch: 'trunk',
    });
    expect(r.removed).toBe(true);
  });

  it('a commit pushed to origin is preserved; the worktree goes', () => {
    const wt = worktree('T4');
    commitIn(wt, 'w.ts', 'w\n');
    expect(unpreservedCommits(wt)).not.toBeNull();
    git(wt, 'push', '-q', 'origin', 'task/T4');
    expect(unpreservedCommits(wt)).toBeNull();
    expect(disposeWorktree({ worktreePath: wt, taskId: 'T4', reason: 'test' }).removed).toBe(true);
  });

  it('a failed probe is not safe: a directory git cannot read is kept', () => {
    const dir = join(wtRoot, 'T5');
    mkdirSync(dir);
    writeFileSync(join(dir, 'notes.txt'), 'only copy\n');
    const r = disposeWorktree({ worktreePath: dir, taskId: 'T5', reason: 'test' });
    expect(r.removed).toBe(false);
    // T14274: a probe that could not answer is marked, so listing says `unknown`.
    expect(r.indeterminate).toBe(true);
    expect(readFileSync(join(dir, 'notes.txt'), 'utf-8')).toBe('only copy\n');
    // With force too: nothing can be archived, so nothing is removed.
    expect(
      disposeWorktree({ worktreePath: dir, taskId: 'T5', reason: 'test', force: true }).removed,
    ).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps a worktree in use, and one whose in-use probe throws', () => {
    const wt = worktree('T6');
    expect(
      disposeWorktree({
        worktreePath: wt,
        taskId: 'T6',
        reason: 'test',
        inUse: () => 'task lock held',
      }),
    ).toMatchObject({ removed: false, keptReason: 'in use: task lock held' });
    const throwing = () => {
      throw new Error('store locked');
    };
    expect(
      disposeWorktree({ worktreePath: wt, taskId: 'T6', reason: 'test', inUse: throwing }).removed,
    ).toBe(false);
    expect(existsSync(wt)).toBe(true);
  });

  it('a dry run or a probe decides without removing or archiving', () => {
    const wt = worktree('T7');
    expect(
      disposeWorktree({ worktreePath: wt, taskId: 'T7', reason: 'test', dryRun: true }),
    ).toEqual({
      worktreePath: wt,
      removed: false,
    });
    writeFileSync(join(wt, 'new.ts'), 'x\n');
    const probe = disposeWorktree({
      worktreePath: wt,
      taskId: 'T7',
      reason: 'test',
      probe: true,
      force: true,
    });
    expect(probe).toMatchObject({
      removed: false,
      unpreserved: 'uncommitted or untracked changes',
    });
    expect(probe.archive).toBeUndefined();
    expect(existsSync(join(wt, 'new.ts'))).toBe(true);
  });
});

describe('force archives before it removes (T13924 AC3)', () => {
  it('writes a verified ref, patch and receipt holding every change and commit, then removes', () => {
    const wt = worktree('T8');
    commitIn(wt, 'committed.ts', 'committed\n');
    const head = git(wt, 'rev-parse', 'HEAD');
    writeFileSync(join(wt, 'a.ts'), 'edited\n');
    writeFileSync(join(wt, 'untracked.ts'), 'untracked\n');
    writeFileSync(join(wt, '.env'), 'SECRET=1\n');
    mkdirSync(join(wt, 'node_modules'));
    writeFileSync(join(wt, 'node_modules', 'big.js'), 'skip\n');

    const r = disposeWorktree({ worktreePath: wt, taskId: 'T8', reason: 'manual', force: true });

    expect(r.removed).toBe(true);
    expect(existsSync(wt)).toBe(false);
    const a = r.archive;
    if (a === undefined) throw new Error('no archive');
    expect(a.archiveRef).toMatch(/^refs\/cleo\/archive\/T8\//);
    expect(git(repo, 'rev-parse', a.archiveRef)).toBe(a.archiveSha);
    expect(git(repo, 'rev-parse', `${a.archiveSha}^`)).toBe(head);
    expect(a).toMatchObject({ taskId: 'T8', reason: 'manual', branch: 'task/T8', head });
    // The archive commit holds the edit, the untracked and the ignored file, not node_modules.
    expect(git(repo, 'show', `${a.archiveSha}:a.ts`)).toBe('edited');
    expect(git(repo, 'show', `${a.archiveSha}:untracked.ts`)).toBe('untracked');
    expect(git(repo, 'show', `${a.archiveSha}:.env`)).toBe('SECRET=1');
    expect(git(repo, 'ls-tree', '-r', '--name-only', a.archiveSha)).not.toContain('node_modules');
    // The commit stays reachable after the branch is gone.
    git(repo, 'branch', '-D', 'task/T8');
    expect(git(repo, 'show', `${a.archiveSha}:committed.ts`)).toBe('committed');
    // Patch and receipt live under the main checkout's .cleo/archive/worktrees/.
    expect(a.patchPath.startsWith(join(repo, '.cleo', 'archive', 'worktrees'))).toBe(true);
    expect(readFileSync(a.patchPath, 'utf-8')).toContain('+edited');
    expect(JSON.parse(readFileSync(a.receiptPath, 'utf-8'))).toEqual(a);
  });
});

describe('destroyWorktree goes through the engine (T13924 AC4)', () => {
  it('keeps a dirty worktree without --force, archives and removes it with --force', async () => {
    const wt = worktree('T9');
    writeFileSync(join(wt, 'wip.ts'), 'wip\n');

    const kept = await destroyWorktree(repo, { taskId: 'T9', deleteBranch: false });
    expect(kept.worktreeRemoved).toBe(false);
    expect(kept.dirty).toBe(true);
    expect(kept.error).toContain('not proven preserved');
    expect(existsSync(join(wt, 'wip.ts'))).toBe(true);

    const forced = await destroyWorktree(repo, { taskId: 'T9', deleteBranch: false, force: true });
    expect(forced.worktreeRemoved).toBe(true);
    expect(forced.archive?.archiveSha).toBeTruthy();
    expect(git(repo, 'show', `${forced.archive?.archiveSha}:wip.ts`)).toBe('wip');
  });

  it('keeps a worktree with an unpushed commit; removes a clean merged one', async () => {
    const unpushed = worktree('T10');
    commitIn(unpushed, 'w.ts', 'w\n');
    const merged = worktree('T11');
    commitIn(merged, 'm.ts', 'm\n');
    git(repo, 'merge', '-q', 'task/T11');
    git(repo, 'push', '-q', 'origin', 'main');

    expect((await destroyWorktree(repo, { taskId: 'T10' })).worktreeRemoved).toBe(false);
    expect(existsSync(join(unpushed, 'w.ts'))).toBe(true);
    const r = await destroyWorktree(repo, { taskId: 'T11' });
    expect(r.worktreeRemoved).toBe(true);
    expect(r.branchDeleted).toBe(true);
  });
});

describe('pruneWorktrees goes through the engine (T13924)', () => {
  it('removes only the clean merged worktree of a dirty, an unpushed and a clean one', () => {
    const dirty = worktree('T12');
    writeFileSync(join(dirty, 'wip.ts'), 'wip\n');
    const unpushed = worktree('T13');
    commitIn(unpushed, 'w.ts', 'w\n');
    const clean = worktree('T14');

    const r = pruneWorktrees({
      projectRoot: repo,
      preserveTaskIds: new Set(['T0']),
      gitPrune: false,
    });

    expect(r.removedPaths).toEqual([clean]);
    expect(r.quarantinedPaths.sort()).toEqual([dirty, unpushed].sort());
    expect(existsSync(join(dirty, 'wip.ts'))).toBe(true);
    expect(existsSync(join(unpushed, 'w.ts'))).toBe(true);
  });
});
