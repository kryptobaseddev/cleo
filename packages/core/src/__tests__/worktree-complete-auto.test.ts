/**
 * Integration tests for the T9548 auto-invoke hook
 * ({@link maybeAutoCompleteWorktreeForTask}) wired into `taskComplete`.
 *
 * Covers:
 *
 *  1. Happy path     — task complete triggers auto-merge of the CLEO worktree;
 *                       audit log gains a `complete` row; envelope surfaces
 *                       `worktreeAutoComplete.outcome === 'merged'`.
 *  2. Idempotency    — re-running `taskComplete` on the same task (after
 *                       worktree is gone) is graceful; outcome === 'no-worktree'.
 *  3. Re-invoke same-worktree → `noop` (audit gains `complete-skip`).
 *  4. Env-var skip   — `CLEO_NO_AUTO_WORKTREE_COMPLETE=1` short-circuits
 *                       the hook; no audit entries written; outcome ===
 *                       'env-disabled'.
 *  5. No worktree    — when no CLEO worktree exists for the task, the hook
 *                       is a pure no-op (no audit row); outcome ===
 *                       'no-worktree'.
 *
 * These tests intentionally drive the SDK helper directly rather than the
 * full `taskComplete` engine wrapper — that wrapper requires a fully-seeded
 * DataAccessor + config + session store, which would dwarf the actual T9548
 * surface under test. The integration-level happy path is already covered
 * by the existing `completeWorktreeForTask` test suite; here we focus on
 * the new wrapper's branch coverage.
 *
 * @task T9548
 * @epic T10192
 * @saga T10176
 * @adr ADR-062
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreeLifecycleAuditEntry } from '@cleocode/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTO_WORKTREE_COMPLETE_ENV,
  isAutoWorktreeCompleteDisabled,
  maybeAutoCompleteWorktreeForTask,
} from '../orchestrate/worktree-complete.js';
import { createAgentWorktree } from '../spawn/branch-lock.js';

// ---------------------------------------------------------------------------
// Fixture helpers (mirrors the pattern in
// packages/core/src/orchestrate/__tests__/worktree-complete.test.ts)
// ---------------------------------------------------------------------------

interface Fixture {
  root: string;
  cleanup: () => void;
}

function makeRepo(branch: string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-t9548-auto-'));
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
      delete process.env[AUTO_WORKTREE_COMPLETE_ENV];
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

describe('maybeAutoCompleteWorktreeForTask (T9548 auto-invoke wrapper)', () => {
  let fixture: Fixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  // -------------------------------------------------------------------------
  // 1. Happy path — auto-merges worktree on task complete
  // -------------------------------------------------------------------------

  it('happy path: auto-merges the CLEO worktree + records merged outcome', () => {
    fixture = makeRepo('main');

    const worktree = createAgentWorktree('T9548-auto-happy', fixture.root);
    writeFileSync(join(worktree.path, 'work.ts'), '// agent work\n');
    gitIn(worktree.path, 'add', 'work.ts');
    gitIn(worktree.path, 'commit', '-q', '-m', 'feat(T9548-auto-happy): add work');

    const integrationAuditPath = join(fixture.root, '.cleo', 'audit', 'worktree-integration.jsonl');
    const lifecycleAuditPath = join(fixture.root, '.cleo', 'audit', 'worktree-lifecycle.jsonl');

    const envelope = maybeAutoCompleteWorktreeForTask('T9548-auto-happy', fixture.root, {
      targetBranch: 'main',
      skipFetch: true,
      integrationAuditPath,
      lifecycleAuditPath,
    });

    expect(envelope.ran).toBe(true);
    expect(envelope.outcome).toBe('merged');
    expect(envelope.integration?.outcome).toBe('merged');
    expect(envelope.integration?.integration?.merged).toBe(true);
    expect(envelope.integration?.integration?.commitCount).toBeGreaterThan(0);

    const lifecycleRows = readAuditLines(lifecycleAuditPath);
    const completeRow = lifecycleRows.find((r) => r.action === 'complete');
    expect(completeRow).toBeDefined();
    expect(completeRow?.taskId).toBe('T9548-auto-happy');
    expect(completeRow?.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. Idempotency — second invocation on a removed worktree returns no-worktree
  // -------------------------------------------------------------------------

  it('idempotent: second invocation after worktree gone returns no-worktree', () => {
    fixture = makeRepo('main');

    const worktree = createAgentWorktree('T9548-auto-idem-A', fixture.root);
    writeFileSync(join(worktree.path, 'work.ts'), '// agent work\n');
    gitIn(worktree.path, 'add', 'work.ts');
    gitIn(worktree.path, 'commit', '-q', '-m', 'feat(T9548-auto-idem-A): add work');

    const integrationAuditPath = join(fixture.root, '.cleo', 'audit', 'worktree-integration.jsonl');
    const lifecycleAuditPath = join(fixture.root, '.cleo', 'audit', 'worktree-lifecycle.jsonl');

    // First — merges + prunes the worktree.
    const first = maybeAutoCompleteWorktreeForTask('T9548-auto-idem-A', fixture.root, {
      targetBranch: 'main',
      skipFetch: true,
      integrationAuditPath,
      lifecycleAuditPath,
    });
    expect(first.outcome).toBe('merged');

    // Second — worktree no longer exists on disk. Wrapper must short-circuit
    // BEFORE invoking the SDK so we get outcome='no-worktree' (not 'noop').
    const second = maybeAutoCompleteWorktreeForTask('T9548-auto-idem-A', fixture.root, {
      targetBranch: 'main',
      skipFetch: true,
      integrationAuditPath,
      lifecycleAuditPath,
    });
    expect(second.ran).toBe(false);
    expect(second.outcome).toBe('no-worktree');
    expect(second.integration).toBeUndefined();

    // No new audit rows should have been emitted by the second call.
    const lifecycleRowsAfterSecond = readAuditLines(lifecycleAuditPath);
    const skipRowsAfterSecond = lifecycleRowsAfterSecond.filter(
      (r) => r.action === 'complete-skip',
    );
    expect(skipRowsAfterSecond).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 3. Idempotency — same worktree re-invoked → SDK returns 'noop' + audit row
  // -------------------------------------------------------------------------

  it('idempotent: same-worktree re-invocation hits SDK noop path + complete-skip audit', () => {
    fixture = makeRepo('main');

    const worktree = createAgentWorktree('T9548-auto-idem-B', fixture.root);
    writeFileSync(join(worktree.path, 'work.ts'), '// agent work\n');
    gitIn(worktree.path, 'add', 'work.ts');
    gitIn(worktree.path, 'commit', '-q', '-m', 'feat(T9548-auto-idem-B): add work');

    const integrationAuditPath = join(fixture.root, '.cleo', 'audit', 'worktree-integration.jsonl');
    const lifecycleAuditPath = join(fixture.root, '.cleo', 'audit', 'worktree-lifecycle.jsonl');

    // First — merges normally.
    const first = maybeAutoCompleteWorktreeForTask('T9548-auto-idem-B', fixture.root, {
      targetBranch: 'main',
      skipFetch: true,
      integrationAuditPath,
      lifecycleAuditPath,
    });
    expect(first.outcome).toBe('merged');

    // Re-create the worktree directory so the absence check passes again, but
    // the audit-log already has a `merged: true` entry — SDK must report noop.
    const recreated = createAgentWorktree('T9548-auto-idem-B', fixture.root);
    expect(existsSync(recreated.path)).toBe(true);

    const second = maybeAutoCompleteWorktreeForTask('T9548-auto-idem-B', fixture.root, {
      targetBranch: 'main',
      skipFetch: true,
      integrationAuditPath,
      lifecycleAuditPath,
    });
    expect(second.ran).toBe(true);
    expect(second.outcome).toBe('noop');

    // Audit log gains a complete-skip row.
    const lifecycleRows = readAuditLines(lifecycleAuditPath);
    const skipRows = lifecycleRows.filter((r) => r.action === 'complete-skip');
    expect(skipRows.length).toBeGreaterThanOrEqual(1);
    expect(skipRows[0]?.taskId).toBe('T9548-auto-idem-B');
  });

  // -------------------------------------------------------------------------
  // 4. Env-var skip — CLEO_NO_AUTO_WORKTREE_COMPLETE=1 short-circuits
  // -------------------------------------------------------------------------

  it('env-var skip: CLEO_NO_AUTO_WORKTREE_COMPLETE=1 disables the hook entirely', () => {
    fixture = makeRepo('main');

    // Create a worktree so the absence-check would NOT short-circuit — proves
    // the env-var path takes precedence.
    const worktree = createAgentWorktree('T9548-auto-envskip', fixture.root);
    writeFileSync(join(worktree.path, 'work.ts'), '// agent work\n');
    gitIn(worktree.path, 'add', 'work.ts');
    gitIn(worktree.path, 'commit', '-q', '-m', 'feat(T9548-auto-envskip): add work');

    const lifecycleAuditPath = join(fixture.root, '.cleo', 'audit', 'worktree-lifecycle.jsonl');

    process.env[AUTO_WORKTREE_COMPLETE_ENV] = '1';
    try {
      expect(isAutoWorktreeCompleteDisabled()).toBe(true);

      const envelope = maybeAutoCompleteWorktreeForTask('T9548-auto-envskip', fixture.root, {
        targetBranch: 'main',
        skipFetch: true,
        lifecycleAuditPath,
      });

      expect(envelope.ran).toBe(false);
      expect(envelope.outcome).toBe('env-disabled');
      expect(envelope.integration).toBeUndefined();

      // No audit rows whatsoever — the env-disabled path must not touch the
      // audit log at all.
      const lifecycleRows = readAuditLines(lifecycleAuditPath);
      expect(lifecycleRows).toHaveLength(0);

      // Worktree must still exist — no integration was attempted.
      expect(existsSync(worktree.path)).toBe(true);
    } finally {
      delete process.env[AUTO_WORKTREE_COMPLETE_ENV];
    }
  });

  // -------------------------------------------------------------------------
  // 4b. Env-var falsy values are correctly identified as opt-in
  // -------------------------------------------------------------------------

  it('env-var falsy values (0, false, empty) DO NOT disable the hook', () => {
    for (const value of ['', '0', 'false', 'FALSE']) {
      process.env[AUTO_WORKTREE_COMPLETE_ENV] = value;
      try {
        expect(isAutoWorktreeCompleteDisabled()).toBe(false);
      } finally {
        delete process.env[AUTO_WORKTREE_COMPLETE_ENV];
      }
    }
    // Absent env-var also returns false.
    delete process.env[AUTO_WORKTREE_COMPLETE_ENV];
    expect(isAutoWorktreeCompleteDisabled()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 5. No worktree path
  // -------------------------------------------------------------------------

  it('no-worktree: returns no-worktree without touching the audit log', () => {
    fixture = makeRepo('main');

    const lifecycleAuditPath = join(fixture.root, '.cleo', 'audit', 'worktree-lifecycle.jsonl');

    const envelope = maybeAutoCompleteWorktreeForTask('T9548-NEVER-CREATED', fixture.root, {
      targetBranch: 'main',
      skipFetch: true,
      lifecycleAuditPath,
    });

    expect(envelope.ran).toBe(false);
    expect(envelope.outcome).toBe('no-worktree');
    expect(envelope.integration).toBeUndefined();

    // No audit entries whatsoever.
    const lifecycleRows = readAuditLines(lifecycleAuditPath);
    expect(lifecycleRows).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 6. Diagnostic envelope shape — ensures CLI can rely on the contract
  // -------------------------------------------------------------------------

  it('diagnostic envelope shape: always exposes ran/outcome/reason', () => {
    fixture = makeRepo('main');

    const lifecycleAuditPath = join(fixture.root, '.cleo', 'audit', 'worktree-lifecycle.jsonl');

    // No worktree — short-circuit path.
    const envelope = maybeAutoCompleteWorktreeForTask('T9548-shape', fixture.root, {
      targetBranch: 'main',
      skipFetch: true,
      lifecycleAuditPath,
    });

    expect(envelope).toHaveProperty('ran');
    expect(typeof envelope.ran).toBe('boolean');
    expect(envelope).toHaveProperty('outcome');
    expect(typeof envelope.outcome).toBe('string');
    expect(envelope).toHaveProperty('reason');
    expect(typeof envelope.reason).toBe('string');
    expect(envelope.reason.length).toBeGreaterThan(0);
  });
});
