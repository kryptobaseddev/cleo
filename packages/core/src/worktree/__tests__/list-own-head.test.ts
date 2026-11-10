/**
 * Worktree classification reads each worktree's OWN HEAD (T14236), against a
 * real git repository: a detached worktree carrying an unmerged commit, a
 * fresh branch at main and a `fix/T1-x` branch are never `merged`, and
 * `cleo worktree prune --orphaned` removes none of them, while genuinely
 * merged work is still found.
 *
 * Only the task store is stubbed (task statuses); git is real.
 *
 * @task T14236
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TASKS = new Map<string, string>();
// The foreign-store verdict is stubbed readable: these fixtures live under a
// tmpdir with no resolvable `.cleo/`, and the real probe would skip the
// (mocked) store (T14440 review P1a).
vi.mock('../../doctor/migrations.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../doctor/migrations.js')>()),
  projectStoreReadVerdict: vi.fn(() => 'readable'),
}));
vi.mock('../../store/sqlite.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../store/sqlite.js')>()),
  getDb: vi.fn(async () => ({}) as never),  getNativeTasksDb: vi.fn(
    () =>
      ({
        prepare: () => ({
          all: (...ids: string[]) =>
            ids.filter((id) => TASKS.has(id)).map((id) => ({ id, status: TASKS.get(id) })),
        }),
      }) as never,
  ),
}));

import { computeProjectHash } from '@cleocode/paths';
import { acquireWorktreeTaskLock } from '@cleocode/worktree';
import { listWorktrees } from '../list.js';
import { pruneOrphanedWorktreesByStatus } from '../prune.js';
import { taskIdFromWorktreeDir } from '../sentinel-index.js';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

const prevCleoHome = process.env['CLEO_HOME'];
let base: string;
let repo: string;

function commit(cwd: string, file: string): string {
  writeFileSync(join(cwd, file), `${file}\n`);
  git(cwd, ['add', file]);
  git(cwd, ['-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', file]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'wt-own-head-')));
  process.env['CLEO_HOME'] = join(base, 'cleo-home');
  repo = join(base, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  commit(repo, 'a.txt');
  commit(repo, 'b.txt');
  TASKS.clear();
});

afterEach(() => {
  if (prevCleoHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = prevCleoHome;
  rmSync(base, { recursive: true, force: true });
});

describe('worktree classification uses each worktree own HEAD (T14236)', () => {
  it('detached-unmerged, fresh-at-main and fix/T1-x are never merged, and prune removes none', async () => {
    const wts = join(base, 'wts');
    // (a) a detached worktree carrying a commit main does not have.
    const detached = join(wts, 'T3');
    git(repo, ['worktree', 'add', '-q', '--detach', detached, 'main']);
    commit(detached, 'detached-work.txt');
    // (b) a freshly provisioned branch at main: zero commits of its own.
    const fresh = join(wts, 'T2');
    git(repo, ['worktree', 'add', '-q', '-b', 'task/T2', fresh, 'main']);
    // (c) a fix/ branch with an unmerged commit.
    const fix = join(wts, 'T1-x');
    git(repo, ['worktree', 'add', '-q', '-b', 'fix/T1-x', fix, 'main']);
    commit(fix, 'fix.txt');
    // Control: work that really was merged (--no-ff) for a done task.
    const done = join(wts, 'T4');
    git(repo, ['worktree', 'add', '-q', '-b', 'task/T4', done, 'main']);
    commit(done, 'done.txt');
    git(repo, [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@e.x',
      'merge',
      '-q',
      '--no-ff',
      '-m',
      'm',
      'task/T4',
    ]);
    for (const id of ['T1', 'T2', 'T3']) TASKS.set(id, 'pending');
    TASKS.set('T4', 'done');

    const listed = await listWorktrees({ projectRoot: repo });
    if (!listed.success) throw new Error(JSON.stringify(listed.error));
    const at = (p: string) => listed.data.worktrees.find((w) => realpathSync(w.path) === p);

    // AC1: detached at an unmerged commit, read through ITS head, not the primary's.
    expect(at(detached)).toMatchObject({ taskId: 'T3', isMerged: false, statusCategory: 'active' });
    // AC2: 0 commits, pending task: active, not merged.
    expect(at(fresh)).toMatchObject({ taskId: 'T2', isMerged: false, statusCategory: 'active' });
    // AC3: a fix/ branch names its task.
    expect(at(fix)).toMatchObject({ taskId: 'T1', isMerged: false, statusCategory: 'active' });
    // Merged work is still recognised, and a done task's clean merged worktree is redundant (T14274).
    expect(at(done)).toMatchObject({ taskId: 'T4', isMerged: true, statusCategory: 'redundant' });

    const pruned = await pruneOrphanedWorktreesByStatus({
      projectRoot: repo,
      auditLogPath: join(base, 'audit.jsonl'),
    });
    expect(pruned.success, JSON.stringify(pruned)).toBe(true);
    for (const p of [detached, fresh, fix]) expect(existsSync(p)).toBe(true);
    expect(existsSync(done)).toBe(false);
  });

  it('T14274: each category from real git; keep names its clause; prune acts only on redundant', async () => {
    const wts = join(base, 'wts');
    const add = (id: string) => {
      const p = join(wts, id);
      git(repo, ['worktree', 'add', '-q', '-b', `task/${id}`, p, 'main']);
      return p;
    };
    const active = add('T10'); // pending task
    const redundant = add('T11'); // done, clean, nothing of its own
    const unpushed = add('T12'); // done, but a commit only on its own branch
    commit(unpushed, 'unpushed.txt');
    const dirty = add('T13'); // done, untracked work
    writeFileSync(join(dirty, 'wip.txt'), 'wip\n');
    const broken = add('T14'); // done, git cannot read it
    writeFileSync(join(broken, '.git'), 'gitdir: /nonexistent/worktree\n');
    TASKS.set('T10', 'pending');
    for (const id of ['T11', 'T12', 'T13', 'T14']) TASKS.set(id, 'done');

    const listed = await listWorktrees({ projectRoot: repo });
    if (!listed.success) throw new Error(JSON.stringify(listed.error));
    const at = (p: string) =>
      listed.data.worktrees.find((w) => w.path === p || realpathSync(w.path) === p);
    expect(at(active)?.statusCategory).toBe('active');
    expect(at(redundant)?.statusCategory).toBe('redundant');
    expect(at(unpushed)).toMatchObject({ statusCategory: 'keep' });
    expect(at(unpushed)?.keepReason).toContain('commit(s) on no remote');
    expect(at(dirty)).toMatchObject({ statusCategory: 'keep' });
    expect(at(dirty)?.keepReason).toContain('uncommitted or untracked');
    // AC2: a git error is unknown, never redundant.
    expect(at(broken)?.statusCategory).toBe('unknown');
    // AC1: only the four categories.
    for (const w of listed.data.worktrees) {
      expect(['active', 'redundant', 'keep', 'unknown']).toContain(w.statusCategory);
    }

    const pruned = await pruneOrphanedWorktreesByStatus({
      projectRoot: repo,
      auditLogPath: join(base, 'audit.jsonl'),
    });
    if (!pruned.success) throw new Error(JSON.stringify(pruned.error));
    expect(pruned.data.outcomes.map((o) => o.path)).toEqual([at(redundant)?.path]);
    expect(existsSync(redundant)).toBe(false);
    for (const p of [active, unpushed, dirty, broken]) expect(existsSync(p)).toBe(true);
  });

  it('T14274: a git-locked done clean worktree is redundant and removed; a live task lock keeps one out', async () => {
    const wts = join(base, 'wts');
    const add = (id: string) => {
      const p = join(wts, id);
      git(repo, ['worktree', 'add', '-q', '-b', `task/${id}`, p, 'main']);
      git(repo, ['worktree', 'lock', '--reason', `cleo-agent-${id}`, p]); // as spawn does
      return p;
    };
    const lockedDone = add('T20');
    const lockedHeld = add('T21');
    TASKS.set('T20', 'done');
    TASKS.set('T21', 'done');
    acquireWorktreeTaskLock({ projectHash: computeProjectHash(repo), taskId: 'T21' });

    const listed = await listWorktrees({ projectRoot: repo });
    if (!listed.success) throw new Error(JSON.stringify(listed.error));
    const at = (p: string) => listed.data.worktrees.find((w) => realpathSync(w.path) === p);
    expect(at(lockedDone)).toMatchObject({ isLocked: true, statusCategory: 'redundant' });
    // The in-use probe wins over the proof: never redundant while its task lock is held.
    expect(at(lockedHeld)).toMatchObject({ isLocked: true, statusCategory: 'keep' });
    expect(at(lockedHeld)?.keepReason).toContain('task lock held');

    const pruned = await pruneOrphanedWorktreesByStatus({
      projectRoot: repo,
      auditLogPath: join(base, 'audit.jsonl'),
    });
    if (!pruned.success) throw new Error(JSON.stringify(pruned.error));
    expect(existsSync(lockedDone)).toBe(false);
    expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(lockedDone);
    expect(existsSync(lockedHeld)).toBe(true);
  });

  it('a T####[-slug] directory names its task when the branch does not', () => {
    expect(taskIdFromWorktreeDir('/x/worktrees/abc/T14236')).toBe('T14236');
    expect(taskIdFromWorktreeDir('/x/worktrees/abc/T7-slug/')).toBe('T7');
    expect(taskIdFromWorktreeDir('/x/worktrees/abc/release-23')).toBeNull();
  });
});
