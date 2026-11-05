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
vi.mock('../../store/sqlite.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../store/sqlite.js')>()),
  getDb: vi.fn(async () => ({}) as never),
  getNativeTasksDb: vi.fn(
    () =>
      ({
        prepare: () => ({
          all: (...ids: string[]) =>
            ids.filter((id) => TASKS.has(id)).map((id) => ({ id, status: TASKS.get(id) })),
        }),
      }) as never,
  ),
}));

const destroyed = vi.hoisted(() => ({ paths: [] as string[] }));
// The NAPI addon is not built in every checkout; stand in with a plain removal.
vi.mock('@cleocode/worktree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/worktree')>()),
  napiDestroyWorktree: ({ worktreePath }: { worktreePath: string }) => {
    destroyed.paths.push(worktreePath);
    rmSync(worktreePath, { recursive: true, force: true });
    return { removed: true, branchDeleted: false };
  },
}));

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
  destroyed.paths = [];
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
    // Merged work is still recognised.
    expect(at(done)).toMatchObject({ taskId: 'T4', isMerged: true, statusCategory: 'merged' });

    const pruned = await pruneOrphanedWorktreesByStatus({
      projectRoot: repo,
      auditLogPath: join(base, 'audit.jsonl'),
    });
    expect(pruned.success, JSON.stringify(pruned)).toBe(true);
    for (const p of [detached, fresh, fix]) {
      expect(destroyed.paths).not.toContain(p);
      expect(existsSync(p)).toBe(true);
    }
  });

  it('a T####[-slug] directory names its task when the branch does not', () => {
    expect(taskIdFromWorktreeDir('/x/worktrees/abc/T14236')).toBe('T14236');
    expect(taskIdFromWorktreeDir('/x/worktrees/abc/T7-slug/')).toBe('T7');
    expect(taskIdFromWorktreeDir('/x/worktrees/abc/release-23')).toBeNull();
  });
});
