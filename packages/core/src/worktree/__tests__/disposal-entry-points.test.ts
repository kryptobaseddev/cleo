/**
 * Every former worktree disposal path now goes through the one engine
 * (T13924, T14276 AC4): given a dirty worktree, one with a commit on no
 * remote and no other branch, and a clean one whose work is merged, each
 * entry point removes only the last and leaves the other two untouched.
 *
 * Real git: a bare `origin`, a project clone and canonical task worktrees
 * under a sandboxed CLEO_HOME. The CI workflow, the seventh former path,
 * calls `cleo worktree destroy` (covered here through `destroyWorktree`).
 *
 * @task T13924
 * @task T14276
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreeInfo } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../store/data-accessor.js', () => ({
  getTaskAccessor: async () => ({
    loadSingleTask: async (id: string) => ({ id, status: 'done' }),
  }),
}));

/** What the status listing reports; set per test (the classifier is not under test). */
const listed = vi.hoisted(() => ({ worktrees: [] as WorktreeInfo[] }));
vi.mock('../list.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../list.js')>()),
  listWorktrees: async () => ({ success: true, data: { worktrees: listed.worktrees } }),
  resolvePrimaryWorktreePath: () => null,
  isPrimaryWorktree: () => false,
}));

const { computeProjectHash, resolveWorktreeRootForHash } = await import('@cleocode/paths');
const { destroyWorktree, pruneWorktrees } = await import('@cleocode/worktree');
const { pruneOrphanWorktrees } = await import('../../gc/cleanup.js');
const { pruneWorktree } = await import('../../spawn/branch-lock.js');
const { cleanupMergedWork } = await import('../merged-cleanup.js');
const { pruneOrphanedWorktreesByStatus } = await import('../prune.js');

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

/** A canonical worktree on `task/<id>` at origin/main. */
function worktree(taskId: string): string {
  const path = join(wtRoot, taskId);
  git(project, 'worktree', 'add', '-q', '-b', `task/${taskId}`, path, 'origin/main');
  return path;
}

/** Commit a file on the worktree's own branch. */
function commitIn(path: string, file: string): void {
  writeFileSync(join(path, file), `${file}\n`);
  git(path, 'add', file);
  git(path, 'commit', '-q', '-m', file);
}

const DIRTY = 'T101';
const UNPUSHED = 'T102';
const MERGED = 'T103';

/** The three worktrees every entry point is given. */
function threeWorktrees(): Record<string, string> {
  const dirty = worktree(DIRTY);
  writeFileSync(join(dirty, 'wip.ts'), 'wip\n');
  const unpushed = worktree(UNPUSHED);
  commitIn(unpushed, 'unpushed.ts');
  const merged = worktree(MERGED);
  commitIn(merged, 'merged.ts');
  git(project, 'merge', '-q', '--no-ff', '-m', 'merge', `task/${MERGED}`);
  git(project, 'push', '-q', 'origin', 'main');
  return { [DIRTY]: dirty, [UNPUSHED]: unpushed, [MERGED]: merged };
}

function info(path: string, taskId: string): WorktreeInfo {
  return {
    path,
    branch: `task/${taskId}`,
    taskId,
    owningAgent: null,
    lastActivity: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    isLocked: false,
    lockState: 'unlocked',
    isStale: false,
    isMerged: false,
    owningTaskStatus: 'cancelled',
    statusCategory: 'redundant',
    source: 'cleo-spawn',
  };
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-disposal-entry-')));
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
  listed.worktrees = [];
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

const ids = [DIRTY, UNPUSHED, MERGED];

const entryPoints: Array<[string, (paths: Record<string, string>) => Promise<void>]> = [
  [
    'cleo complete (pruneWorktree)',
    async () => {
      for (const id of ids) pruneWorktree(id, project);
    },
  ],
  [
    'cleo worktree destroy (destroyWorktree)',
    async () => {
      for (const id of ids) await destroyWorktree(project, { taskId: id });
    },
  ],
  [
    'cleo worktree prune --orphaned (pruneOrphanedWorktreesByStatus)',
    async (paths) => {
      listed.worktrees = ids.map((id) => info(paths[id] ?? '', id));
      await pruneOrphanedWorktreesByStatus({
        projectRoot: project,
        auditLogPath: join(tmp, 'a.jsonl'),
      });
    },
  ],
  [
    'the merge sweep (cleanupMergedWork)',
    async () => {
      await cleanupMergedWork(
        { projectRoot: project, taskIds: ids, dryRun: false, remote: false },
        { openPrHeads: () => new Set<string>() },
      );
    },
  ],
  [
    'the sentient prune (pruneWorktrees)',
    async () => {
      pruneWorktrees({ projectRoot: project, preserveTaskIds: new Set(['T0']), gitPrune: false });
    },
  ],
  [
    'cleo gc worktrees (pruneOrphanWorktrees)',
    async () => {
      await pruneOrphanWorktrees({
        worktreesRoot: join(tmp, 'cleo-home', 'worktrees'),
        projectHash: computeProjectHash(project),
        activeTaskIds: new Set(['T0']),
      });
    },
  ],
];

describe('every disposal entry point removes only the clean merged worktree (T14276 AC4)', () => {
  it.each(entryPoints)('%s', async (_name, run) => {
    const paths = threeWorktrees();
    await run(paths);
    expect(existsSync(join(paths[DIRTY] ?? '', 'wip.ts'))).toBe(true);
    expect(existsSync(join(paths[UNPUSHED] ?? '', 'unpushed.ts'))).toBe(true);
    expect(existsSync(paths[MERGED] ?? '')).toBe(false);
  });
});
