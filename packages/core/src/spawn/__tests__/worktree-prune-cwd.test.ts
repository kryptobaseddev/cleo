/**
 * `pruneWorktree` leaves a worktree the process is standing in before removing
 * it (T12671): `cleo done` run inside a task worktree completes the task, the
 * completion prunes that worktree, and a process whose cwd is gone printed
 * "No CLEO project found" beside `success: true`.
 *
 * @task T12671
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneWorktree, resolveAgentWorktreeRoot } from '../branch-lock.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

const startCwd = process.cwd();
let repo: string;

afterEach(() => {
  process.chdir(startCwd);
  rmSync(repo, { recursive: true, force: true });
});

describe('pruneWorktree and the process cwd', () => {
  it('moves the process to the repository root before removing the worktree it stands in', () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'prune-cwd-')));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'T']);
    git(repo, ['config', 'user.email', 't@e.x']);
    writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'T900: init']);
    const wt = join(resolveAgentWorktreeRoot(repo), 'T900');
    git(repo, ['worktree', 'add', '-q', '-b', 'task/T900', wt]);

    process.chdir(wt);
    const result = pruneWorktree('T900', repo);

    expect(result.worktreeRemoved).toBe(true);
    expect(existsSync(wt)).toBe(false);
    // Unfixed, process.cwd() throws ENOENT here: the directory is gone.
    expect(process.cwd()).toBe(repo);
  });

  it('leaves the cwd alone when the process stands elsewhere', () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'prune-cwd-')));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'T']);
    git(repo, ['config', 'user.email', 't@e.x']);
    writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'T901: init']);
    const wt = join(resolveAgentWorktreeRoot(repo), 'T901');
    git(repo, ['worktree', 'add', '-q', '-b', 'task/T901', wt]);
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'prune-elsewhere-')));
    process.chdir(elsewhere);
    pruneWorktree('T901', repo);
    expect(process.cwd()).toBe(elsewhere);
    process.chdir(startCwd);
    rmSync(elsewhere, { recursive: true, force: true });
  });
});
