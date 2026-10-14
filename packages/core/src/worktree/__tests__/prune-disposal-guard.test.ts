/**
 * `cleo worktree prune` (`pruneOrphanedWorktreesByStatus`) runs the same
 * disposal guard as complete and cancel: it skips a merged worktree another
 * checkout links into, honours the keep marker an earlier disposal wrote, and
 * disposes (clearing the marker) once the blockers are gone (T13700).
 *
 * @task T13700
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreeInfo } from '@cleocode/contracts';
import { keepMarkerPath, readKeepMarker } from '@cleocode/worktree';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listed = vi.hoisted(() => ({ worktrees: [] as WorktreeInfo[] }));
const destroyed = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock('../list.js', () => ({
  listWorktrees: async () => ({ success: true, data: { worktrees: listed.worktrees } }),
  resolvePrimaryWorktreePath: () => null,
  isPrimaryWorktree: () => false,
}));

// The NAPI addon is not built in every checkout; stand in with a plain removal.
vi.mock('@cleocode/worktree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/worktree')>()),
  napiDestroyWorktree: ({ worktreePath }: { worktreePath: string }) => {
    destroyed.paths.push(worktreePath);
    rmSync(worktreePath, { recursive: true, force: true });
    return { removed: true, branchDeleted: false };
  },
}));

import { pruneOrphanWorktrees } from '../../gc/cleanup.js';
import { pruneWorktree, resolveAgentWorktreeRoot } from '../../spawn/branch-lock.js';
import { pruneOrphanedWorktreesByStatus } from '../prune.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

const prevCleoHome = process.env['CLEO_HOME'];
let base: string;
let repo: string;

function addWorktree(taskId: string): string {
  const wt = join(base, 'worktrees', taskId);
  git(repo, ['worktree', 'add', '-q', '-b', `task/${taskId}`, wt]);
  return wt;
}

function merged(path: string): WorktreeInfo {
  return {
    path,
    branch: 'task/x',
    // No owning task: the guard must rely on the dependents scan and the marker.
    taskId: null,
    owningAgent: null,
    lastActivity: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    isLocked: false,
    lockState: 'unlocked',
    isStale: false,
    isMerged: false,
    owningTaskStatus: null,
    statusCategory: 'merged',
    source: 'cleo-spawn',
  };
}

const prune = () =>
  pruneOrphanedWorktreesByStatus({ projectRoot: repo, auditLogPath: join(base, 'audit.jsonl') });

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'prune-guard-')));
  process.env['CLEO_HOME'] = join(base, 'cleo-home');
  repo = join(base, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'T']);
  git(repo, ['config', 'user.email', 't@e.x']);
  writeFileSync(join(repo, '.gitignore'), 'node_modules\ntmp\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'init']);
  listed.worktrees = [];
  destroyed.paths = [];
});

afterEach(() => {
  if (prevCleoHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = prevCleoHome;
  rmSync(base, { recursive: true, force: true });
});

describe('pruneOrphanedWorktreesByStatus disposal guard (T13700)', () => {
  it('skips a merged worktree a sibling links into, then prunes it once the link is gone', async () => {
    const owner = addWorktree('T981');
    const sibling = addWorktree('T982');
    mkdirSync(join(owner, 'node_modules'));
    const link = join(sibling, 'node_modules');
    symlinkSync(join(owner, 'node_modules'), link);
    listed.worktrees = [merged(owner)];

    const first = await prune();
    expect(first.success && first.data.prunedCount).toBe(0);
    const outcome = first.success ? first.data.outcomes[0] : undefined;
    expect(outcome?.pruned).toBe(false);
    expect(outcome?.kept?.dependents).toEqual([link]);
    expect(destroyed.paths).toEqual([]);
    expect(existsSync(owner)).toBe(true);
    expect(readKeepMarker(owner)?.dependents).toEqual([link]);

    unlinkSync(link);
    const second = await prune();
    expect(second.success && second.data.prunedCount).toBe(1);
    expect(destroyed.paths).toEqual([owner]);
    expect(existsSync(keepMarkerPath(owner))).toBe(false);
  });

  it('honours the marker complete left for evidence, and disposes once the root holds a copy', async () => {
    // pruneWorktree resolves the canonical path, so create the worktree there.
    const path = join(resolveAgentWorktreeRoot(repo), 'T983');
    git(repo, ['worktree', 'add', '-q', '-b', 'task/T983', path]);
    mkdirSync(join(path, 'tmp'));
    const receipt = join(path, 'tmp', 'vitest.json');
    writeFileSync(receipt, '{"numPassedTests":3}\n');
    const sha256 = createHash('sha256').update(readFileSync(receipt)).digest('hex');

    // `cleo complete` keeps it and records why.
    const completed = pruneWorktree('T983', repo, {
      auditLogPath: join(base, 'prune.jsonl'),
      evidence: [
        { kind: 'files', files: [{ path: 'tmp/vitest.json', sha256, resolvedPath: receipt }] },
      ],
    });
    expect(completed.kept?.evidence).toEqual([receipt]);
    expect(readKeepMarker(path)).toMatchObject({ taskId: 'T983', reason: 'complete' });

    // The status prune has no task evidence for it: the marker alone keeps it.
    listed.worktrees = [merged(path)];
    const first = await prune();
    expect(first.success && first.data.outcomes[0]?.kept?.evidence).toEqual([receipt]);
    expect(existsSync(receipt)).toBe(true);
    expect(destroyed.paths).toEqual([]);

    mkdirSync(join(repo, 'tmp'));
    writeFileSync(join(repo, 'tmp', 'vitest.json'), readFileSync(receipt));
    const second = await prune();
    expect(second.success && second.data.prunedCount).toBe(1);
    expect(existsSync(keepMarkerPath(path))).toBe(false);
  });

  it('dry run reports a kept worktree without writing a marker', async () => {
    const owner = addWorktree('T984');
    const sibling = addWorktree('T985');
    mkdirSync(join(owner, 'node_modules'));
    symlinkSync(join(owner, 'node_modules'), join(sibling, 'node_modules'));
    listed.worktrees = [merged(owner)];

    const result = await pruneOrphanedWorktreesByStatus({ projectRoot: repo, dryRun: true });
    expect(result.success && result.data.outcomes[0]?.kept?.dependents).toHaveLength(1);
    expect(existsSync(keepMarkerPath(owner))).toBe(false);
  });

  it('cleo gc worktrees skips a worktree a sibling links into', () => {
    const worktreesRoot = join(base, 'gc-root');
    const owner = join(worktreesRoot, 'h', 'T986');
    const sibling = join(worktreesRoot, 'h', 'T987');
    git(repo, ['worktree', 'add', '-q', '-b', 'task/T986', owner]);
    git(repo, ['worktree', 'add', '-q', '-b', 'task/T987', sibling]);
    mkdirSync(join(owner, 'node_modules'));
    const link = join(sibling, 'node_modules');
    symlinkSync(join(owner, 'node_modules'), link);

    const result = pruneOrphanWorktrees({
      worktreesRoot,
      projectHash: 'h',
      activeTaskIds: new Set(['T000']),
    });

    expect(result.removedPaths).not.toContain(owner);
    expect(result.errors).toContainEqual({ path: owner, reason: expect.stringContaining(link) });
    expect(existsSync(owner)).toBe(true);
  });
});
