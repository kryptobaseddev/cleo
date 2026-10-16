/**
 * `destroyWorktree` — the removal `cleo cancel` runs — and the batch
 * `pruneWorktrees` keep a worktree another checkout links into (T13696).
 *
 * @task T13696
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeProjectHash } from '../paths.js';
import { guardWorktreeDisposal, keepMarkerPath, readKeepMarker } from '../worktree-dependents.js';
import { destroyWorktree } from '../worktree-destroy.js';
import { pruneWorktrees } from '../worktree-prune.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

const prevCleoHome = process.env['CLEO_HOME'];
let base: string;
let repo: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'wt-dependents-')));
  process.env['CLEO_HOME'] = base;
  repo = join(base, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'T']);
  git(repo, ['config', 'user.email', 't@e.x']);
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'init']);
  root = join(base, 'worktrees', computeProjectHash(repo));
});

afterEach(() => {
  if (prevCleoHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = prevCleoHome;
  rmSync(base, { recursive: true, force: true });
});

describe('destroyWorktree disposal guard (T13696)', () => {
  it('keeps a worktree a sibling links into through node_modules/.pnpm', async () => {
    const owner = join(root, 'T971');
    const sibling = join(root, 'T972');
    git(repo, ['worktree', 'add', '-q', '-b', 'task/T971', owner]);
    git(repo, ['worktree', 'add', '-q', '-b', 'task/T972', sibling]);
    mkdirSync(join(owner, 'node_modules', '.pnpm', 'dep@1.0.0'), { recursive: true });
    writeFileSync(join(owner, 'node_modules', '.pnpm', 'dep@1.0.0', 'x.js'), 'x\n');
    mkdirSync(join(sibling, 'node_modules', '.pnpm'), { recursive: true });
    const link = join(sibling, 'node_modules', '.pnpm', 'dep@1.0.0');
    symlinkSync(join(owner, 'node_modules', '.pnpm', 'dep@1.0.0'), link);

    const result = await destroyWorktree(repo, { taskId: 'T971', force: true });

    expect(result.worktreeRemoved).toBe(false);
    expect(result.branchDeleted).toBe(false);
    expect(result.kept?.dependents).toEqual([link]);
    expect(existsSync(owner)).toBe(true);
    expect(readFileSync(join(link, 'x.js'), 'utf-8')).toBe('x\n');
    // T13700: the keep is durable, so a later batch prune sees it.
    expect(readKeepMarker(owner)).toMatchObject({
      taskId: 'T971',
      reason: 'manual',
      projectRoot: repo,
      dependents: [link],
    });
  });
});

describe('keep marker honoured by the batch prune (T13700)', () => {
  it('skips a worktree kept for evidence, then clears the marker once the root holds a copy', () => {
    const wt = join(root, 'T973');
    git(repo, ['worktree', 'add', '-q', '-b', 'task/T973', wt]);
    // Gitignored, so the worktree is clean and only the marker can protect it.
    mkdirSync(join(wt, 'node_modules'));
    const receipt = join(wt, 'node_modules', 'vitest.json');
    writeFileSync(receipt, '{"numPassedTests":3}\n');
    const sha256 = createHash('sha256').update(readFileSync(receipt)).digest('hex');

    // What `cleo complete` does when it keeps the worktree.
    const kept = guardWorktreeDisposal(wt, {
      taskId: 'T973',
      reason: 'complete',
      projectRoot: repo,
      evidence: [{ kind: 'files', files: [{ path: receipt, sha256, resolvedPath: receipt }] }],
    });
    expect(kept?.evidence).toEqual([receipt]);

    // The batch prune has no task evidence: only the marker carries it.
    const first = pruneWorktrees({ projectRoot: repo, preserveTaskIds: new Set(['T000']) });
    expect(existsSync(receipt)).toBe(true);
    expect(first.removedPaths).toEqual([]);
    expect(first.errors).toEqual([{ path: wt, reason: expect.stringContaining('evidence') }]);
    // The marker file beside the worktree is never itself a prune candidate.
    expect(existsSync(keepMarkerPath(wt))).toBe(true);

    mkdirSync(join(repo, 'node_modules'));
    writeFileSync(join(repo, 'node_modules', 'vitest.json'), readFileSync(receipt));
    const second = pruneWorktrees({ projectRoot: repo, preserveTaskIds: new Set(['T000']) });
    expect(second.errors).toEqual([]);
    expect(existsSync(keepMarkerPath(wt))).toBe(false);
  });
});
