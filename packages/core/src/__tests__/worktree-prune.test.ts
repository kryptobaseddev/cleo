/**
 * Integration tests for `pruneOrphanedWorktreesByStatus` (T9547 — AC4 + AC5).
 *
 * Unlike `packages/core/src/worktree/__tests__/prune.test.ts` (which mocks
 * both `listWorktrees` and `execFileSync` so unit coverage stays hermetic),
 * this suite spins up a REAL on-disk git repository, real linked worktrees,
 * and real merged branches so the end-to-end prune flow is validated against
 * actual git behaviour and a real filesystem.
 *
 * Coverage matrix (T9547 acceptance criteria):
 *  - AC4 (orphan): a merged branch + matching worktree → reclassified as
 *                  `merged` by {@link listWorktrees} → pruned by
 *                  {@link pruneOrphanedWorktreesByStatus}.
 *  - AC4 (non-orphan): an active (unmerged) branch worktree → left in place.
 *  - AC5 (idempotency): re-running prune after a successful sweep returns
 *                       `prunedCount=0` with no audit-log appendage.
 *  - AC3 (audit log): every successful prune writes one JSONL entry to
 *                     `.cleo/audit/worktree-lifecycle.jsonl`.
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

import { pruneOrphanedWorktreesByStatus } from '../worktree/prune.js';

interface Fixture {
  /** Absolute path to the project root (primary worktree) inside a fresh tmp dir. */
  projectRoot: string;
  /** Absolute path to the sibling directory used as the worktree parent. */
  worktreesRoot: string;
  /** Absolute path to the worktree-lifecycle audit log. */
  auditLogPath: string;
  /** Cleanup callback — removes the tmp dir tree. */
  cleanup: () => void;
}

/**
 * Build a fresh on-disk repo with one commit on `main`, plus a sibling
 * `worktrees/` directory that holds the linked worktrees this test creates.
 *
 * macOS resolves `/var/folders/...` through a symlink to `/private/...`. Git
 * porcelain emits the realpath, so canonicalise the tmp root for portability.
 */
function makeFixture(): Fixture {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t9547-prune-it-')));
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

/**
 * Create a linked git worktree on `task/<taskId>` rooted at the worktrees
 * parent, returning the absolute worktree path.
 */
function addWorktree(fixture: Fixture, taskId: string): string {
  const path = join(fixture.worktreesRoot, taskId);
  execFileSync('git', ['worktree', 'add', '-b', `task/${taskId}`, path, 'main'], {
    cwd: fixture.projectRoot,
    stdio: 'pipe',
  });
  return path;
}

/**
 * Add a worktree on a non-task branch. The classifier only treats branches
 * matching `task/T####` as belonging to a known task — non-task branches with
 * no matching DB row stay `active` (no orphan classification). Used by the
 * "leaves active worktrees alone" cases below.
 */
function addNonTaskWorktree(fixture: Fixture, name: string): string {
  const path = join(fixture.worktreesRoot, name);
  execFileSync('git', ['worktree', 'add', '-b', `feat/${name}`, path, 'main'], {
    cwd: fixture.projectRoot,
    stdio: 'pipe',
  });
  return path;
}

/**
 * Merge `task/<taskId>` into `main` via a no-ff merge — mirrors the canonical
 * release path (ADR-062) so the branch is reachable from `main` and the
 * {@link listWorktrees} classifier labels the worktree `merged`.
 */
function mergeTaskBranch(fixture: Fixture, taskId: string): void {
  // Author one commit on the task branch so the merge is non-trivial.
  const wt = join(fixture.worktreesRoot, taskId);
  writeFileSync(join(wt, `${taskId}.txt`), `${taskId} change\n`);
  execFileSync('git', ['add', `${taskId}.txt`], { cwd: wt, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', `feat(${taskId}): change`], {
    cwd: wt,
    stdio: 'pipe',
  });

  // Merge --no-ff into main from the primary worktree.
  execFileSync('git', ['merge', '--no-ff', `task/${taskId}`, '-m', `merge(${taskId})`], {
    cwd: fixture.projectRoot,
    stdio: 'pipe',
  });
}

let fixture: Fixture;

beforeEach(() => {
  fixture = makeFixture();
});

afterEach(() => {
  fixture.cleanup();
});

describe('pruneOrphanedWorktreesByStatus — integration (real git)', () => {
  it('AC4: prunes merged worktrees and leaves active worktrees in place', async () => {
    // Setup: one merged worktree (orphan candidate) + one active worktree.
    addWorktree(fixture, 'T1001');
    mergeTaskBranch(fixture, 'T1001');

    // Non-task branch with one unmerged commit → classifier leaves it `active`.
    // We MUST author a commit so the branch is NOT trivially an ancestor of
    // main; otherwise `git merge-base --is-ancestor` returns true and the
    // classifier labels the worktree `merged` (and prunes it).
    const activePath = addNonTaskWorktree(fixture, 'experimental-1002');
    writeFileSync(join(activePath, 'experimental.txt'), 'wip\n');
    execFileSync('git', ['add', 'experimental.txt'], { cwd: activePath, stdio: 'pipe' });
    execFileSync('git', ['commit', '-q', '-m', 'wip on experimental branch'], {
      cwd: activePath,
      stdio: 'pipe',
    });

    const result = await pruneOrphanedWorktreesByStatus({
      projectRoot: fixture.projectRoot,
      auditLogPath: fixture.auditLogPath,
      actor: 'integration-test',
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected envelope success');
    expect(result.data.prunedCount).toBe(1);
    expect(result.data.outcomes).toHaveLength(1);
    expect(result.data.outcomes[0]?.path).toBe(join(fixture.worktreesRoot, 'T1001'));
    // The classifier's precedence is orphan > merged (when both apply): a
    // missing tasks-DB row on a `task/T####` branch produces `orphan` even
    // though the branch is also merged into main. We assert on the union of
    // valid reasons so the test stays robust against precedence tweaks while
    // still proving the worktree was identified for prune.
    expect(['orphaned-merged', 'orphan-missing-task']).toContain(result.data.outcomes[0]?.reason);
    // Branch deletion runs whenever `isMerged` was true (T1001 was merged into
    // main before the prune sweep), regardless of the surfacing reason.
    expect(result.data.outcomes[0]?.branchDeleted).toBe(true);

    // Filesystem: merged worktree gone, active worktree untouched.
    expect(existsSync(join(fixture.worktreesRoot, 'T1001'))).toBe(false);
    expect(existsSync(activePath)).toBe(true);

    // Audit log written.
    expect(existsSync(fixture.auditLogPath)).toBe(true);
    const auditContent = readFileSync(fixture.auditLogPath, 'utf-8');
    const lines = auditContent.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['action']).toBe('prune');
    expect(entry['actor']).toBe('integration-test');
    expect(entry['success']).toBe(true);
    expect(entry['target']).toBe(join(fixture.worktreesRoot, 'T1001'));
    expect(typeof entry['timestamp']).toBe('string');
  });

  it('AC5: re-running prune is a no-op (idempotent)', async () => {
    addWorktree(fixture, 'T2001');
    mergeTaskBranch(fixture, 'T2001');

    // First sweep — should prune the merged worktree.
    const first = await pruneOrphanedWorktreesByStatus({
      projectRoot: fixture.projectRoot,
      auditLogPath: fixture.auditLogPath,
      actor: 'integration-test',
    });
    expect(first.success).toBe(true);
    if (!first.success) throw new Error('first sweep should succeed');
    expect(first.data.prunedCount).toBe(1);

    // Second sweep — same state, no candidates left.
    const second = await pruneOrphanedWorktreesByStatus({
      projectRoot: fixture.projectRoot,
      auditLogPath: fixture.auditLogPath,
      actor: 'integration-test',
    });
    expect(second.success).toBe(true);
    if (!second.success) throw new Error('second sweep should succeed');
    expect(second.data.prunedCount).toBe(0);
    expect(second.data.outcomes).toHaveLength(0);
    expect(second.data.errors).toHaveLength(0);

    // Audit log should still only contain the first sweep's single entry.
    const auditContent = readFileSync(fixture.auditLogPath, 'utf-8');
    const lines = auditContent.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it('dry-run reports candidates without removing them or writing audit', async () => {
    addWorktree(fixture, 'T3001');
    mergeTaskBranch(fixture, 'T3001');

    const result = await pruneOrphanedWorktreesByStatus({
      projectRoot: fixture.projectRoot,
      auditLogPath: fixture.auditLogPath,
      actor: 'integration-test',
      dryRun: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected envelope success');
    expect(result.data.dryRun).toBe(true);
    expect(result.data.prunedCount).toBe(0);
    expect(result.data.skippedCount).toBe(1);
    expect(result.data.outcomes).toHaveLength(1);
    expect(result.data.outcomes[0]?.pruned).toBe(false);

    // Worktree still on disk; no audit entry written.
    expect(existsSync(join(fixture.worktreesRoot, 'T3001'))).toBe(true);
    expect(existsSync(fixture.auditLogPath)).toBe(false);
  });
});
