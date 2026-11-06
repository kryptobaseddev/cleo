/**
 * Tests for pruneWorktree — single-task worktree cleanup (T1462 / P1-6).
 *
 * Since T13924 the removal goes through the worktree package's
 * `disposeWorktree` engine, so these run against a real repository and real
 * worktrees under a sandboxed CLEO_HOME: a dirty worktree is kept (never
 * force-removed), a clean one whose commits are on `main` is removed.
 *
 * @task T1462
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneWorktree, resolveAgentWorktreeRoot } from '../branch-lock.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

const prevCleoHome = process.env['CLEO_HOME'];
let base: string;
let repo: string;
let audit: string;

/** A worktree for `taskId` on `task/<taskId>` at main's commit. */
function addWorktree(taskId: string): string {
  const wt = join(resolveAgentWorktreeRoot(repo), taskId);
  git(repo, 'worktree', 'add', '-q', '-b', `task/${taskId}`, wt);
  return wt;
}

/** Commit a file on the worktree's own branch. */
function commitIn(wt: string, file: string): void {
  writeFileSync(join(wt, file), `${file}\n`);
  git(wt, 'add', file);
  git(wt, 'commit', '-q', '-m', `add ${file}`);
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'prune-worktree-')));
  process.env['CLEO_HOME'] = join(base, 'cleo-home');
  repo = join(base, 'repo');
  audit = join(base, 'audit.jsonl');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'user.email', 't@e.x');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
});

afterEach(() => {
  if (prevCleoHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = prevCleoHome;
  rmSync(base, { recursive: true, force: true });
});

describe('pruneWorktree', () => {
  describe('when worktree directory does not exist', () => {
    it('returns status=skipped and deletes a stale branch holding no new commits', () => {
      git(repo, 'branch', 'task/T9001');
      const result = pruneWorktree('T9001', repo);
      expect(result).toMatchObject({
        status: 'skipped',
        worktreeRemoved: false,
        branchDeleted: true,
      });
      expect(git(repo, 'branch', '--list', 'task/T9001')).toBe('');
    });

    it('keeps a stale branch that holds commits main does not (T13924)', () => {
      const wt = addWorktree('T9002');
      commitIn(wt, 'w.ts');
      git(repo, 'worktree', 'remove', '--force', wt);
      const result = pruneWorktree('T9002', repo);
      expect(result.status).toBe('skipped');
      expect(result.branchDeleted).toBe(false);
      expect(git(repo, 'branch', '--list', 'task/T9002')).toContain('task/T9002');
    });

    it('marks branchDeleted=true when there is no branch to delete', () => {
      expect(pruneWorktree('T9003', repo).branchDeleted).toBe(true);
    });
  });

  describe('when worktree exists and is clean', () => {
    it('removes it and its branch when every commit is on main', () => {
      const wt = addWorktree('T9004');
      const result = pruneWorktree('T9004', repo, { auditLogPath: audit });
      expect(result).toMatchObject({
        status: 'pruned',
        worktreeRemoved: true,
        branchDeleted: true,
        wasDirty: false,
      });
      expect(existsSync(wt)).toBe(false);
      expect(existsSync(audit)).toBe(false);
    });

    it('removes a git-locked worktree once merged, and leaves no registration', () => {
      const wt = addWorktree('T9005');
      commitIn(wt, 'm.ts');
      git(repo, 'merge', '-q', 'task/T9005');
      git(repo, 'worktree', 'lock', wt);
      expect(pruneWorktree('T9005', repo).worktreeRemoved).toBe(true);
      expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    });
  });

  describe('when worktree content or commits are not preserved (T13924)', () => {
    it.each([
      ['a tracked change', (wt: string) => writeFileSync(join(wt, 'a.ts'), 'changed\n')],
      ['an untracked file', (wt: string) => writeFileSync(join(wt, 'new.ts'), 'new\n')],
      ['a commit only on its branch', (wt: string) => commitIn(wt, 'w.ts')],
    ])('keeps a worktree with %s, wasDirty, and records a kept audit entry', (_label, change) => {
      const wt = addWorktree('T9006');
      change(wt);
      const result = pruneWorktree('T9006', repo, { auditLogPath: audit });
      expect(result).toMatchObject({
        status: 'skipped',
        worktreeRemoved: false,
        branchDeleted: false,
        wasDirty: true,
      });
      expect(result.error).toContain('not proven preserved');
      expect(existsSync(wt)).toBe(true);
      const entry = JSON.parse(readFileSync(audit, 'utf-8').trim());
      expect(entry).toMatchObject({ taskId: 'T9006', action: 'kept' });
      expect(entry.unpreserved).toBeTruthy();
    });
  });

  describe('error handling', () => {
    it('returns status=error when the directory is not a git repo', () => {
      const plain = join(base, 'plain');
      mkdirSync(plain);
      const result = pruneWorktree('T9008', plain);
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/Not a git repo/);
    });
  });
});
