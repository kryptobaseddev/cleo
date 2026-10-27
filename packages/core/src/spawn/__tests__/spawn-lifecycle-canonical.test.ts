/**
 * Integration smoke for the spawn lifecycle (T10872 / T10874): with the real
 * `@cleocode/worktree` facade, core's spawn path creates the task worktree at
 * the canonical XDG location `<cleoHome>/worktrees/<projectHash>/<taskId>/`,
 * registers it with git and records its provisioning row.
 *
 * @task T10872
 * @task T10874
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeProjectHash, getCleoWorktreesRoot, resolveTaskWorktreePath } from '@cleocode/paths';
import { isCleoProvisionedWorktree } from '@cleocode/worktree';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnWorktree } from '../../sentient/worktree-dispatch.js';
import { createAgentWorktree, pruneWorktree } from '../branch-lock.js';

let root: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'spawn-canonical-')));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@e.x');
  git(root, 'config', 'user.name', 'T');
  writeFileSync(join(root, 'README.md'), 'x\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
});

afterEach(() => {
  for (const taskId of ['T10874A', 'T10874B']) pruneWorktree(taskId, root);
  rmSync(root, { recursive: true, force: true });
});

/** Absolute paths git has registered, canonicalised. */
function registered(): string[] {
  return git(root, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => realpathSync(line.slice('worktree '.length)));
}

describe('spawn lifecycle lands on the canonical XDG path (T10874)', () => {
  it('spawnWorktree (orchestrate spawn) creates the worktree under <cleoHome>/worktrees/<hash>/<taskId>', async () => {
    const result = await spawnWorktree(root, {
      taskId: 'T10874A',
      skipInstall: true,
      gitShim: { dir: join(root, '.shim'), installed: false },
    });
    const canonical = resolveTaskWorktreePath(computeProjectHash(root), 'T10874A');
    expect(result.path).toBe(canonical);
    expect(canonical.startsWith(getCleoWorktreesRoot())).toBe(true);
    expect(registered()).toContain(realpathSync(canonical));
    expect(isCleoProvisionedWorktree(root, 'T10874A', canonical)).toBe(true);
  });

  it('createAgentWorktree (branch-lock replacement path) lands on the same canonical path', async () => {
    const state = await createAgentWorktree('T10874B', root);
    const canonical = resolveTaskWorktreePath(computeProjectHash(root), 'T10874B');
    expect(state.path).toBe(canonical);
    expect(state.branch).toBe('task/T10874B');
    expect(registered()).toContain(realpathSync(canonical));
    expect(isCleoProvisionedWorktree(root, 'T10874B', canonical)).toBe(true);
  });
});
