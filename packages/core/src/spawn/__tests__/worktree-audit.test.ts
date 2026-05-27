/**
 * Tests for completeAgentWorktreeIntegration (T9043 / ADR-062).
 *
 * Verifies that the post-merge integration helper:
 * - Delegates to completeAgentWorktreeViaMerge correctly
 * - Writes an audit log entry to .cleo/audit/worktree-integration.jsonl
 * - Returns auditLogEntry pointing at the correct file
 * - Does NOT throw when the merge has no commits (empty branch)
 *
 * Each test builds a real on-disk git repo under tmpdir.
 *
 * @task T9043
 * @adr ADR-062
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { completeAgentWorktreeIntegration, createAgentWorktree } from '../branch-lock.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface Fixture {
  root: string;
  cleanup: () => void;
}

function makeRepo(branch: string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-integration-test-'));
  const xdg = join(dir, '.xdg');
  mkdirSync(xdg, { recursive: true });
  process.env['XDG_DATA_HOME'] = xdg;

  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

  git('init', '-q', '-b', branch);
  git('config', 'user.email', 'cleo-test@example.com');
  git('config', 'user.name', 'CLEO Test');
  git('config', 'commit.gpgsign', 'false');

  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'init');

  return {
    root: dir,
    cleanup: () => {
      delete process.env['XDG_DATA_HOME'];
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('completeAgentWorktreeIntegration', () => {
  let fixture: Fixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it('writes audit log and returns auditLogEntry path on successful merge', () => {
    fixture = makeRepo('main');

    const worktree = createAgentWorktree('T9043-audit', fixture.root);

    // Add a commit in the worktree.
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: worktree.path,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    writeFileSync(join(worktree.path, 'agent-work.ts'), '// work\n');
    git('add', 'agent-work.ts');
    git('commit', '-q', '-m', 'feat(T9043-audit): add agent work');

    const auditLogPath = join(fixture.root, '.cleo', 'audit', 'worktree-integration.jsonl');

    const result = completeAgentWorktreeIntegration('T9043-audit', fixture.root, {
      targetBranch: 'main',
      taskTitle: 'Audit test',
      skipFetch: true,
      auditLogPath,
    });

    expect(result.merged).toBe(true);
    expect(result.auditLogEntry).toBe(auditLogPath);
    expect(existsSync(auditLogPath)).toBe(true);

    const logContent = readFileSync(auditLogPath, 'utf-8').trim();
    const entry = JSON.parse(logContent) as {
      taskId: string;
      merged: boolean;
      mergeCommit: string;
    };
    expect(entry.taskId).toBe('T9043-audit');
    expect(entry.merged).toBe(true);
    expect(entry.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('still writes audit log when merge has no commits (empty branch)', () => {
    fixture = makeRepo('main');

    // Create worktree but add no commits — empty branch.
    createAgentWorktree('T9043-empty', fixture.root);
    const auditLogPath = join(fixture.root, '.cleo', 'audit', 'worktree-integration.jsonl');

    const result = completeAgentWorktreeIntegration('T9043-empty', fixture.root, {
      targetBranch: 'main',
      skipFetch: true,
      auditLogPath,
    });

    // merged=true (no-op merge of 0 commits is OK)
    expect(result.merged).toBe(true);
    expect(result.auditLogEntry).toBe(auditLogPath);
    expect(existsSync(auditLogPath)).toBe(true);

    const logContent = readFileSync(auditLogPath, 'utf-8').trim();
    const entry = JSON.parse(logContent) as {
      taskId: string;
      merged: boolean;
    };
    expect(entry.taskId).toBe('T9043-empty');
  });

  it('returns auditLogEntry = null when the audit dir cannot be written', () => {
    fixture = makeRepo('main');

    const worktree = createAgentWorktree('T9043-no-audit', fixture.root);

    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: worktree.path,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    writeFileSync(join(worktree.path, 'f.ts'), '// f\n');
    git('add', 'f.ts');
    git('commit', '-q', '-m', 'feat(T9043-no-audit): add f');

    // Use a path inside a non-existent grandparent dir (mkdirSync will fail because
    // we pass a file path, not a directory, as part of the audit dir chain).
    // Actually the safest approach: pass a path whose parent is a FILE, not a dir.
    const conflictFile = join(fixture.root, 'conflicting-file');
    writeFileSync(conflictFile, 'not a dir\n');
    const badAuditLogPath = join(conflictFile, 'sub', 'worktree-integration.jsonl');

    const result = completeAgentWorktreeIntegration('T9043-no-audit', fixture.root, {
      targetBranch: 'main',
      skipFetch: true,
      auditLogPath: badAuditLogPath,
    });

    // The merge itself should succeed; audit is best-effort.
    expect(result.merged).toBe(true);
    expect(result.auditLogEntry).toBeNull();
  });

  it('integration result extends WorktreeMergeResult with auditLogEntry', () => {
    fixture = makeRepo('main');
    createAgentWorktree('T9043-shape', fixture.root);

    const auditLogPath = join(fixture.root, '.cleo', 'audit', 'test.jsonl');
    const result = completeAgentWorktreeIntegration('T9043-shape', fixture.root, {
      targetBranch: 'main',
      skipFetch: true,
      auditLogPath,
    });

    // Structural check: must have all WorktreeMergeResult fields.
    expect(result).toHaveProperty('taskId');
    expect(result).toHaveProperty('targetBranch');
    expect(result).toHaveProperty('merged');
    expect(result).toHaveProperty('mergeCommit');
    expect(result).toHaveProperty('commitCount');
    expect(result).toHaveProperty('rebased');
    expect(result).toHaveProperty('worktreeRemoved');
    expect(result).toHaveProperty('branchDeleted');
    // T9043 extension.
    expect(result).toHaveProperty('auditLogEntry');
  });
});
