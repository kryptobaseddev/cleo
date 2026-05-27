/**
 * Tests for completeWorktreeForTask (T9548).
 *
 * Covers the four outcome paths exposed by the SDK:
 *
 *  - Happy path: worker returned success → auto-merge → audit + prune.
 *  - Idempotency: re-run on a completed worktree → noop + complete-skip audit.
 *  - Merge conflict: error envelope + recovery instructions; worktree preserved.
 *  - --resolve manual: skips merge; writes complete-manual audit.
 *  - Idempotent absence: no branch exists → noop-ish error envelope (no crash).
 *  - Lifecycle audit shape: every action writes a structured JSONL row.
 *
 * @task T9548
 * @epic T9515
 * @adr ADR-062
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreeLifecycleAuditEntry } from '@cleocode/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { createAgentWorktree } from '../../spawn/branch-lock.js';
import { completeWorktreeForTask } from '../worktree-complete.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface Fixture {
  root: string;
  cleanup: () => void;
}

function makeRepo(branch: string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-t9548-'));
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

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function readAuditLines(filePath: string): WorktreeLifecycleAuditEntry[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf-8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as WorktreeLifecycleAuditEntry);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('completeWorktreeForTask (T9548)', () => {
  let fixture: Fixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  // -------------------------------------------------------------------------
  // 1. Happy path
  // -------------------------------------------------------------------------

  it('happy path: auto-merges worker worktree + writes complete audit row', () => {
    fixture = makeRepo('main');

    const worktree = createAgentWorktree('T9548-happy', fixture.root);
    writeFileSync(join(worktree.path, 'work.ts'), '// agent work\n');
    gitIn(worktree.path, 'add', 'work.ts');
    gitIn(worktree.path, 'commit', '-q', '-m', 'feat(T9548-happy): add work');

    const integrationAuditPath = join(fixture.root, '.cleo', 'audit', 'worktree-integration.jsonl');
    const lifecycleAuditPath = join(fixture.root, '.cleo', 'audit', 'worktree-lifecycle.jsonl');

    const result = completeWorktreeForTask('T9548-happy', fixture.root, {
      targetBranch: 'main',
      skipFetch: true,
      integrationAuditPath,
      lifecycleAuditPath,
    });

    expect(result.outcome).toBe('merged');
    expect(result.integration).not.toBeNull();
    expect(result.integration?.merged).toBe(true);
    expect(result.integration?.commitCount).toBeGreaterThan(0);

    // Lifecycle audit row must exist with action='complete'.
    const lifecycleEntries = readAuditLines(lifecycleAuditPath);
    expect(lifecycleEntries.length).toBeGreaterThanOrEqual(1);
    const completeRow = lifecycleEntries.find((r) => r.action === 'complete');
    expect(completeRow).toBeDefined();
    expect(completeRow?.taskId).toBe('T9548-happy');
    expect(completeRow?.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. Idempotency: re-run on completed worktree is a no-op
  // -------------------------------------------------------------------------

  it('idempotent: re-run on completed worktree returns noop + writes complete-skip', () => {
    fixture = makeRepo('main');

    const worktree = createAgentWorktree('T9548-idem', fixture.root);
    writeFileSync(join(worktree.path, 'work.ts'), '// agent work\n');
    gitIn(worktree.path, 'add', 'work.ts');
    gitIn(worktree.path, 'commit', '-q', '-m', 'feat(T9548-idem): add work');

    const integrationAuditPath = join(fixture.root, '.cleo', 'audit', 'worktree-integration.jsonl');
    const lifecycleAuditPath = join(fixture.root, '.cleo', 'audit', 'worktree-lifecycle.jsonl');

    // First run — auto-merges.
    const first = completeWorktreeForTask('T9548-idem', fixture.root, {
      targetBranch: 'main',
      skipFetch: true,
      integrationAuditPath,
      lifecycleAuditPath,
    });
    expect(first.outcome).toBe('merged');

    // Second run — must be a no-op courtesy of the audit-log check.
    const second = completeWorktreeForTask('T9548-idem', fixture.root, {
      targetBranch: 'main',
      skipFetch: true,
      integrationAuditPath,
      lifecycleAuditPath,
    });
    expect(second.outcome).toBe('noop');
    expect(second.integration).toBeNull();

    // Lifecycle log should have both rows: 'complete' and 'complete-skip'.
    const lifecycleEntries = readAuditLines(lifecycleAuditPath);
    const actions = lifecycleEntries.map((r) => r.action);
    expect(actions).toContain('complete');
    expect(actions).toContain('complete-skip');
  });

  // -------------------------------------------------------------------------
  // 3. Merge conflict path: error envelope + recovery; worktree preserved
  // -------------------------------------------------------------------------

  it('merge conflict: returns conflict outcome with recovery + preserves worktree', () => {
    fixture = makeRepo('main');

    // Set up a conflict scenario: agent and main both modify the same line.
    const worktree = createAgentWorktree('T9548-conflict', fixture.root);

    // Main branch changes README.md
    writeFileSync(join(fixture.root, 'README.md'), '# main change\n');
    gitIn(fixture.root, 'add', 'README.md');
    gitIn(fixture.root, 'commit', '-q', '-m', 'chore: main edit');

    // Worker branch changes the SAME line
    writeFileSync(join(worktree.path, 'README.md'), '# worker change\n');
    gitIn(worktree.path, 'add', 'README.md');
    gitIn(worktree.path, 'commit', '-q', '-m', 'feat(T9548-conflict): worker edit');

    const integrationAuditPath = join(fixture.root, '.cleo', 'audit', 'worktree-integration.jsonl');
    const lifecycleAuditPath = join(fixture.root, '.cleo', 'audit', 'worktree-lifecycle.jsonl');

    const result = completeWorktreeForTask('T9548-conflict', fixture.root, {
      targetBranch: 'main',
      skipFetch: true,
      integrationAuditPath,
      lifecycleAuditPath,
    });

    expect(result.outcome).toBe('conflict');
    expect(result.integration?.merged).toBe(false);
    expect(result.recovery).toBeDefined();
    expect(result.recovery?.steps.length).toBeGreaterThan(0);
    // Recovery steps should mention the manual-resolve incantation.
    expect(result.recovery?.steps.join('\n')).toContain('--resolve manual');

    // Worktree directory must still exist — conflict path must NOT prune.
    expect(existsSync(result.recovery?.worktreePath ?? '')).toBe(true);

    // Lifecycle audit row should be 'complete-conflict' with success=false.
    const lifecycleEntries = readAuditLines(lifecycleAuditPath);
    const conflictRow = lifecycleEntries.find((r) => r.action === 'complete-conflict');
    expect(conflictRow).toBeDefined();
    expect(conflictRow?.success).toBe(false);
    expect(conflictRow?.taskId).toBe('T9548-conflict');
  });

  // -------------------------------------------------------------------------
  // 4. --resolve manual: skips merge attempt
  // -------------------------------------------------------------------------

  it('resolve=manual: skips merge attempt and writes complete-manual audit row', () => {
    fixture = makeRepo('main');

    // Create the worktree but do NOT add commits — proves manual path doesn't
    // depend on the underlying merge attempt's outcome.
    createAgentWorktree('T9548-manual', fixture.root);

    const lifecycleAuditPath = join(fixture.root, '.cleo', 'audit', 'worktree-lifecycle.jsonl');

    const result = completeWorktreeForTask('T9548-manual', fixture.root, {
      targetBranch: 'main',
      skipFetch: true,
      resolve: 'manual',
      lifecycleAuditPath,
    });

    expect(result.outcome).toBe('manual');
    expect(result.integration).toBeNull();

    const lifecycleEntries = readAuditLines(lifecycleAuditPath);
    expect(lifecycleEntries).toHaveLength(1);
    expect(lifecycleEntries[0]?.action).toBe('complete-manual');
    expect(lifecycleEntries[0]?.taskId).toBe('T9548-manual');
    expect(lifecycleEntries[0]?.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. Branch absence: branch never existed → no-op-ish (no throw)
  // -------------------------------------------------------------------------

  it('returns gracefully when task branch does not exist (never created)', () => {
    fixture = makeRepo('main');

    const lifecycleAuditPath = join(fixture.root, '.cleo', 'audit', 'worktree-lifecycle.jsonl');

    const result = completeWorktreeForTask('T9548-NEVER', fixture.root, {
      targetBranch: 'main',
      skipFetch: true,
      lifecycleAuditPath,
    });

    // The underlying merge helper returns merged=false with "branch does not exist",
    // which surfaces as outcome=conflict from the SDK. Worktree path obviously
    // does not exist on disk — but the function must NOT throw.
    expect(result.outcome).toBe('conflict');
    expect(result.integration?.merged).toBe(false);
    expect(result.integration?.error).toMatch(/does not exist/);
  });

  // -------------------------------------------------------------------------
  // 6. Lifecycle audit shape compliance
  // -------------------------------------------------------------------------

  it('every audit row matches WorktreeLifecycleAuditEntry shape', () => {
    fixture = makeRepo('main');

    const worktree = createAgentWorktree('T9548-shape', fixture.root);
    writeFileSync(join(worktree.path, 'work.ts'), '// shape\n');
    gitIn(worktree.path, 'add', 'work.ts');
    gitIn(worktree.path, 'commit', '-q', '-m', 'feat(T9548-shape): add work');

    const integrationAuditPath = join(fixture.root, '.cleo', 'audit', 'worktree-integration.jsonl');
    const lifecycleAuditPath = join(fixture.root, '.cleo', 'audit', 'worktree-lifecycle.jsonl');

    completeWorktreeForTask('T9548-shape', fixture.root, {
      targetBranch: 'main',
      skipFetch: true,
      integrationAuditPath,
      lifecycleAuditPath,
    });

    const entries = readAuditLines(lifecycleAuditPath);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).toHaveProperty('timestamp');
      expect(typeof entry.timestamp).toBe('string');
      expect(new Date(entry.timestamp).toString()).not.toBe('Invalid Date');
      expect(entry).toHaveProperty('actor');
      expect(typeof entry.actor).toBe('string');
      expect(entry).toHaveProperty('action');
      expect(entry).toHaveProperty('target');
      expect(typeof entry.target).toBe('string');
      expect(entry).toHaveProperty('success');
      expect(typeof entry.success).toBe('boolean');
    }
  });
});
