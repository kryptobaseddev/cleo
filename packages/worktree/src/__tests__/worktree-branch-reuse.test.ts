/**
 * Tests for the T1878 branch-reuse fix in `createWorktree`.
 *
 * Covers two behavioural contracts:
 *
 * 1. Clean first-time creation — new branch is created, `reused` is `false`.
 * 2. Existing-branch reuse — when a prior aborted spawn left a `task/<taskId>`
 *    branch behind (no worktree directory), `createWorktree` attaches to it
 *    via `git worktree add <path> <branch>` (no `-b`), and `reused` is `true`.
 *
 * Both tests use a real temporary git repository; no DB is needed because
 * `createWorktree` only runs git commands.
 *
 * @task T1878
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree } from '../worktree-create.js';

/** Initialise a bare-minimum git repository in a temp directory. */
function initTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-wt-test-'));

  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });

  // Commit something so HEAD is resolvable.
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });

  return dir;
}

describe('createWorktree — branch provisioning (T1878)', () => {
  let projectRoot: string;
  let cleoHome: string;
  let originalCleoHome: string | undefined;

  beforeEach(() => {
    projectRoot = initTempRepo();
    cleoHome = mkdtempSync(join(tmpdir(), 'cleo-home-'));
    originalCleoHome = process.env['CLEO_HOME'];
    // Route XDG worktree storage to the temp dir so we don't touch real state.
    process.env['CLEO_HOME'] = cleoHome;
  });

  afterEach(() => {
    if (originalCleoHome === undefined) {
      delete process.env['CLEO_HOME'];
    } else {
      process.env['CLEO_HOME'] = originalCleoHome;
    }
    rmSync(cleoHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('creates a new branch and returns reused=false on first spawn', async () => {
    const result = await createWorktree(projectRoot, { taskId: 'T9001', lockWorktree: false });

    expect(result.path).toBeTruthy();
    expect(result.branch).toBe('task/T9001');
    expect(result.reused).toBe(false);
    expect(existsSync(result.path)).toBe(true);
  });

  it('reuses an existing task branch and returns reused=true', async () => {
    // Simulate a prior aborted spawn: create the branch but leave no worktree dir.
    execFileSync('git', ['branch', 'task/T9002', 'HEAD'], { cwd: projectRoot, stdio: 'pipe' });

    // At this point only the branch exists — no worktree directory.
    const result = await createWorktree(projectRoot, { taskId: 'T9002', lockWorktree: false });

    expect(result.branch).toBe('task/T9002');
    expect(result.reused).toBe(true);
    // Provisioning must not throw and the path must be populated.
    expect(result.path).toBeTruthy();
    expect(existsSync(result.path)).toBe(true);
  });
});
