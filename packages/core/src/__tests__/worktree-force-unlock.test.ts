/**
 * Integration tests for `forceUnlockWorktree` (T9547).
 *
 * Unlike `packages/core/src/worktree/__tests__/force-unlock.test.ts` (which
 * mocks `listWorktrees` and `execFileSync`), this suite spins up a REAL git
 * repository, real linked worktrees, and exercises `git worktree lock` /
 * `git worktree unlock` so the end-to-end unlock flow is validated against
 * actual git behaviour.
 *
 * Coverage matrix (T9547 acceptance criteria):
 *  - AC2: `git worktree lock <path>` → `forceUnlockWorktree` clears the lock,
 *         `worktreeUnlocked=true`, and the worktree is unlocked in porcelain.
 *  - AC5 (idempotency): a second invocation on an unlocked worktree returns
 *         a no-op envelope (both flags false, success:true).
 *  - AC3 (audit log): every action writes a JSONL entry to
 *         `.cleo/audit/worktree-lifecycle.jsonl`.
 *
 * @task T9547
 * @epic T10192
 * @saga T10176
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

import { forceUnlockWorktree } from '../worktree/force-unlock.js';

interface Fixture {
  projectRoot: string;
  worktreesRoot: string;
  auditLogPath: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t9547-funlock-it-')));
  const projectRoot = join(tmp, 'project');
  const worktreesRoot = join(tmp, 'worktrees');
  mkdirSync(worktreesRoot, { recursive: true });

  execFileSync('git', ['init', '-b', 'main', projectRoot], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.name', 'Test'], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
  writeFileSync(join(projectRoot, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: projectRoot, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: projectRoot, stdio: 'pipe' });

  return {
    projectRoot,
    worktreesRoot,
    auditLogPath: join(projectRoot, '.cleo', 'audit', 'worktree-lifecycle.jsonl'),
    cleanup() {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

function addWorktree(fixture: Fixture, taskId: string): string {
  const path = join(fixture.worktreesRoot, taskId);
  execFileSync('git', ['worktree', 'add', '-b', `task/${taskId}`, path, 'main'], {
    cwd: fixture.projectRoot,
    stdio: 'pipe',
  });
  return path;
}

function lockWorktree(fixture: Fixture, worktreePath: string): void {
  execFileSync('git', ['worktree', 'lock', worktreePath], {
    cwd: fixture.projectRoot,
    stdio: 'pipe',
  });
}

function porcelainLocked(fixture: Fixture, worktreePath: string): boolean {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: fixture.projectRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Find the block for the given worktree and check for a "locked" marker.
  const blocks = out.split(/\n\n/);
  for (const block of blocks) {
    if (block.includes(`worktree ${worktreePath}`)) {
      return /\nlocked(\s|$)/.test(`\n${block}`);
    }
  }
  return false;
}

let fixture: Fixture;

beforeEach(() => {
  fixture = makeFixture();
});

afterEach(() => {
  fixture.cleanup();
});

describe('forceUnlockWorktree — integration (real git)', () => {
  it('AC2: clears `git worktree lock` and unlocks the worktree in porcelain', async () => {
    const wtPath = addWorktree(fixture, 'T9547');
    lockWorktree(fixture, wtPath);
    expect(porcelainLocked(fixture, wtPath)).toBe(true);

    const result = await forceUnlockWorktree({
      projectRoot: fixture.projectRoot,
      taskId: 'T9547',
      auditLogPath: fixture.auditLogPath,
      actor: 'integration-test',
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected envelope success');
    expect(result.data.worktreeUnlocked).toBe(true);
    expect(result.data.taskId).toBe('T9547');
    expect(result.data.path).toBe(wtPath);

    // Porcelain confirms the worktree is no longer locked.
    expect(porcelainLocked(fixture, wtPath)).toBe(false);

    // Audit-log entry recorded.
    expect(existsSync(fixture.auditLogPath)).toBe(true);
    const auditContent = readFileSync(fixture.auditLogPath, 'utf-8');
    const lines = auditContent.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['action']).toBe('force-unlock');
    expect(entry['actor']).toBe('integration-test');
    expect(entry['taskId']).toBe('T9547');
    expect(entry['success']).toBe(true);
  });

  it('AC5: re-running on an unlocked worktree is a no-op (idempotent)', async () => {
    const wtPath = addWorktree(fixture, 'T9548');
    // Don't lock the worktree — it starts unlocked.

    const result = await forceUnlockWorktree({
      projectRoot: fixture.projectRoot,
      taskId: 'T9548',
      auditLogPath: fixture.auditLogPath,
      actor: 'integration-test',
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected envelope success');
    expect(result.data.indexLockRemoved).toBe(false);
    expect(result.data.worktreeUnlocked).toBe(false);
    expect(result.data.path).toBe(wtPath);
    expect(result.data.success).toBe(true);

    // Audit entry IS written for the no-op (the operator asked for the unlock,
    // we record that we ran and nothing needed doing).
    const auditContent = readFileSync(fixture.auditLogPath, 'utf-8');
    const lines = auditContent.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['reason']).toContain('no-action-needed');
  });

  it('returns E_WORKTREE_NOT_FOUND when no worktree owns the task', async () => {
    // No worktree spawned for T9999.
    const result = await forceUnlockWorktree({
      projectRoot: fixture.projectRoot,
      taskId: 'T9999',
      auditLogPath: fixture.auditLogPath,
      actor: 'integration-test',
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error.code).toBe('E_WORKTREE_NOT_FOUND');

    // Audit entry recorded for the failed attempt.
    const auditContent = readFileSync(fixture.auditLogPath, 'utf-8');
    const lines = auditContent.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['success']).toBe(false);
    expect(entry['action']).toBe('force-unlock');
  });
});
