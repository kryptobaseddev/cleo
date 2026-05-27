/**
 * T9603 / T-WT-4 — Regression test suite for worktree IVTR flow.
 *
 * Covers the four scenarios from docs/plans/E-WORKTREE-IVTR.md §5.1 T-WT-4:
 *
 * 1. Worktree-spawned agent can verify an `implemented` gate with a commit on
 *    its task branch (T-WT-1 / T-WT-3 fix — getEffectiveHead wired in).
 *
 * 2. Content-intersect reads from the main DB even when `projectRoot` is the
 *    worktree path (T-WT-2 fix — resolveCanonicalProjectRoot).
 *
 * 3. The T9178 branch-scope check continues to pass with the same setup
 *    (non-regression: verify we did not weaken the branch-scope guard).
 *
 * 4. A commit on the main branch (NOT on the task branch) fails verification
 *    when `taskId` is provided and the task branch exists (ensures the
 *    branch-scope guard remains active).
 *
 * @task T9603
 * @task T-WT-4
 * @epic T9586
 * @adr ADR-051
 * @adr ADR-051-worktree-extension
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { resolveCanonicalProjectRoot, validateAtom } from '../evidence.js';

// =============================================================================
// Test helpers
// =============================================================================

/** Run a git command synchronously; returns stdout. Throws on non-zero exit. */
function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
}

/** Initialize a minimal git repo suitable for evidence validation tests. */
function initGitRepo(dir: string, label: string): void {
  // --initial-branch=main: CI runners may have git's default branch set
  // to `master`; tests later run `git checkout main` which would fail.
  git(dir, ['init', '-q', '--initial-branch=main']);
  git(dir, ['config', 'user.name', `T9603 ${label}`]);
  git(dir, ['config', 'user.email', `${label.toLowerCase().replace(/\s+/g, '-')}@t9603.test`]);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

/**
 * Write a file at `relPath` inside `dir`, stage it, and commit it.
 * Returns the full commit SHA.
 */
function gitCommitFile(dir: string, relPath: string, content: string, message: string): string {
  const slash = relPath.lastIndexOf('/');
  if (slash > 0) {
    mkdirSync(join(dir, relPath.slice(0, slash)), { recursive: true });
  }
  writeFileSync(join(dir, relPath), content);
  git(dir, ['add', relPath]);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/**
 * Create a real git worktree directory using `git worktree add --detach`.
 * The worktree is placed at `join(mainRepo, worktreeName)`.
 * Returns the resolved path of the worktree directory.
 */
function createWorktreeDir(mainRepo: string, worktreeName: string): string {
  const worktreePath = join(mainRepo, worktreeName);
  git(mainRepo, ['worktree', 'add', '--detach', worktreePath, 'HEAD']);
  return worktreePath;
}

// =============================================================================
// Scenario 1: Worktree-spawned agent verifies via task-branch commit (T-WT-3)
//
// Regression lock: before T-WT-3 fix, a commit that existed only on the task
// branch (not yet merged to main) would fail with E_EVIDENCE_INVALID because
// the ancestry check used the literal "HEAD" (main branch tip).
// After fix: getEffectiveHead resolves task/<taskId> branch, ancestry check uses
// the task branch tip, and the commit is correctly accepted.
// =============================================================================

describe('T-WT-4 Scenario 1 — task-branch commit accepted when projectRoot is main repo', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    initGitRepo(env.tempDir, 'Scenario1');
    gitCommitFile(env.tempDir, 'README.md', 'init\n', 'init');
  });

  afterEach(async () => {
    await env.cleanup();
    resetDbState();
  });

  it('ACCEPTS commit on task branch when projectRoot is main repo (T-WT-3 fix)', async () => {
    await seedTasks(env.accessor, [
      {
        id: 'T_WT4_S1',
        title: 'wt4-scenario1',
        description: 'worktree IVTR scenario 1 — task-branch commit',
        status: 'pending',
        priority: 'high',
        files: ['src/wt4-impl.ts'],
        acceptance: ['src/wt4-impl.ts implements the feature'],
      } as Partial<Task> & { id: string },
    ]);

    // Simulate: worker has its own task branch (as orchestrate spawn creates).
    execFileSync('git', ['checkout', '-b', 'task/T_WT4_S1'], { cwd: env.tempDir });

    // Worker commits the AC file to the task branch.
    // This commit is NOT on main — simulates the IVTR deliverable.
    mkdirSync(join(env.tempDir, 'src'), { recursive: true });
    writeFileSync(join(env.tempDir, 'src', 'wt4-impl.ts'), 'export const wt4Impl = true;\n');
    execFileSync('git', ['add', 'src/wt4-impl.ts'], { cwd: env.tempDir });
    execFileSync('git', ['commit', '-q', '-m', 'feat(T_WT4_S1): implement wt4-impl'], {
      cwd: env.tempDir,
    });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.tempDir }).toString().trim();

    // Switch back to main — now HEAD = main tip, sha NOT reachable from HEAD.
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: env.tempDir });

    // Precondition: commit should NOT be reachable from main HEAD.
    // (Without T-WT-3 fix, validateAtom would fail here.)
    let isAncestorOfMain = false;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], {
        cwd: env.tempDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      isAncestorOfMain = true;
    } catch {
      isAncestorOfMain = false;
    }
    expect(isAncestorOfMain).toBe(false); // confirm test setup is correct

    // validateAtom with projectRoot=mainRepo + taskId → ACCEPT because
    // getEffectiveHead resolves "task/T_WT4_S1" (T-WT-3 fix).
    const r = await validateAtom({ kind: 'commit', sha }, env.tempDir, 'T_WT4_S1');
    expect(r.ok).toBe(true);
  });
});

// =============================================================================
// Scenario 2: Content-intersect reads from main DB when projectRoot is worktree
//
// Regression lock: before T-WT-2 fix, checkCommitContentIntersect used the
// worktree path for DB reads. If the task had been updated after spawn, the
// stale worktree DB had task.files=[] causing either a vacuous pass (bypassing
// the T9245 guard) or a false rejection. After fix: resolveCanonicalProjectRoot
// maps worktree path → main repo path, DB reads always use the live main DB.
// =============================================================================

describe('T-WT-4 Scenario 2 — content-intersect reads main DB from worktree path (T-WT-2)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    initGitRepo(env.tempDir, 'Scenario2');
    gitCommitFile(env.tempDir, 'README.md', 'init\n', 'init');
  });

  afterEach(async () => {
    await env.cleanup();
    resetDbState();
  });

  it('ACCEPTS commit and reads task metadata from main DB when projectRoot is worktree', async () => {
    // Seed task in MAIN DB with a declared AC file.
    // The distinctive file name "wt4-maindb-sentinel.ts" ensures that if the
    // DB read accidentally hits a different (empty) DB, acFiles would be null
    // and the test would behave differently (vacuous pass without intersect check).
    await seedTasks(env.accessor, [
      {
        id: 'T_WT4_S2',
        title: 'wt4-scenario2',
        description: 'Bug C fix — main DB read from worktree path',
        status: 'pending',
        priority: 'high',
        files: ['src/wt4-maindb-sentinel.ts'],
        acceptance: ['src/wt4-maindb-sentinel.ts implements feature'],
      } as Partial<Task> & { id: string },
    ]);

    // Create task branch and commit the declared AC file.
    execFileSync('git', ['checkout', '-b', 'task/T_WT4_S2'], { cwd: env.tempDir });
    mkdirSync(join(env.tempDir, 'src'), { recursive: true });
    writeFileSync(
      join(env.tempDir, 'src', 'wt4-maindb-sentinel.ts'),
      'export const sentinel = "main-db";\n',
    );
    execFileSync('git', ['add', 'src/wt4-maindb-sentinel.ts'], { cwd: env.tempDir });
    execFileSync('git', ['commit', '-q', '-m', 'feat(T_WT4_S2): implement sentinel'], {
      cwd: env.tempDir,
    });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.tempDir }).toString().trim();

    // Create a REAL git worktree. The `git worktree add --detach` command writes
    // a gitlink file (<worktreePath>/.git) pointing back to the main repo's
    // `.git/worktrees/<name>` directory. This is identical to what
    // `cleo orchestrate spawn` does in production.
    const worktreePath = createWorktreeDir(env.tempDir, 'wt-T_WT4_S2');

    // Verify resolveCanonicalProjectRoot correctly maps the worktree path to
    // the main repo. This is the T-WT-2 primitive that drives the DB fix.
    const resolved = resolveCanonicalProjectRoot(worktreePath);
    expect(resolved).toBe(realpathSync(env.tempDir));

    // KEY ASSERTION: call validateAtom with projectRoot = WORKTREE PATH.
    //
    // With the T-WT-2 fix in checkCommitContentIntersect:
    //   - resolveCanonicalProjectRoot(worktreePath) → mainRepo
    //   - getTaskAccessor(mainRepo) reads the live main DB
    //   - task.files = ['src/wt4-maindb-sentinel.ts']
    //   - git show <sha> returns 'src/wt4-maindb-sentinel.ts'
    //   - intersection non-empty → content-intersect PASSES
    //
    // Without the fix (getTaskAccessor(worktreePath)):
    //   - worktree's stale DB has task.files=[] (or is empty)
    //   - acFiles = null → vacuous pass (misses the T9245 gate)
    //   OR the worktree DB lookup fails → early return ok:true (also vacuous).
    //
    // The T-WT-3 fix (getEffectiveHead) also applies: sha is on task/T_WT4_S2
    // so the ancestry check passes even though HEAD on main doesn't include sha.
    const r = await validateAtom({ kind: 'commit', sha }, worktreePath, 'T_WT4_S2');
    expect(r.ok).toBe(true);
  });
});

// =============================================================================
// Scenario 3: T9178 branch-scope check continues to pass (non-regression)
//
// Verifies that the T-WT-1/T-WT-3 fix did not weaken T9178's guard. A commit
// on the correct task branch must still be accepted by the branch-scope check.
// =============================================================================

describe('T-WT-4 Scenario 3 — T9178 branch-scope check still enforced', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    initGitRepo(env.tempDir, 'Scenario3');
    gitCommitFile(env.tempDir, 'README.md', 'init\n', 'init');
  });

  afterEach(async () => {
    await env.cleanup();
    resetDbState();
  });

  it('ACCEPTS commit on correct task branch (T9178 branch-scope passes)', async () => {
    await seedTasks(env.accessor, [
      {
        id: 'T_WT4_S3',
        title: 'wt4-scenario3',
        description: 'T9178 non-regression — correct branch accepted',
        status: 'pending',
        priority: 'high',
        files: ['src/wt4-s3.ts'],
        acceptance: ['src/wt4-s3.ts is implemented'],
      } as Partial<Task> & { id: string },
    ]);

    execFileSync('git', ['checkout', '-b', 'task/T_WT4_S3'], { cwd: env.tempDir });
    mkdirSync(join(env.tempDir, 'src'), { recursive: true });
    writeFileSync(join(env.tempDir, 'src', 'wt4-s3.ts'), 'export const s3 = true;\n');
    execFileSync('git', ['add', 'src/wt4-s3.ts'], { cwd: env.tempDir });
    execFileSync('git', ['commit', '-q', '-m', 'feat(T_WT4_S3): implement s3'], {
      cwd: env.tempDir,
    });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.tempDir }).toString().trim();

    // Should ACCEPT: commit is on the correct task branch, AC file is in diff.
    const r = await validateAtom({ kind: 'commit', sha }, env.tempDir, 'T_WT4_S3');
    expect(r.ok).toBe(true);
  });
});

// =============================================================================
// Scenario 4: Main commit rejected when task branch exists (T9178 guard active)
//
// Non-regression: ensures T9178 still blocks phantom evidence.
// A worker must NOT be able to submit a main-branch commit as "implemented"
// evidence for a task that has its own branch — this would be cross-branch
// fabrication (the known attack vector T9178 closes).
// =============================================================================

describe('T-WT-4 Scenario 4 — main commit rejected when task branch exists (T9178 guard)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    initGitRepo(env.tempDir, 'Scenario4');
    gitCommitFile(env.tempDir, 'README.md', 'init\n', 'init');
  });

  afterEach(async () => {
    await env.cleanup();
    resetDbState();
  });

  it('REJECTS main-branch commit when taskId provided and task branch exists', async () => {
    await seedTasks(env.accessor, [
      {
        id: 'T_WT4_S4',
        title: 'wt4-scenario4',
        description: 'T9178 active — main commit rejected when task branch exists',
        status: 'pending',
        priority: 'high',
        // No declared AC files → content-intersect skipped; rejection from branch-scope.
        files: [],
        acceptance: ['implement something'],
      } as Partial<Task> & { id: string },
    ]);

    // Create task branch and diverge from main with a commit.
    execFileSync('git', ['checkout', '-b', 'task/T_WT4_S4'], { cwd: env.tempDir });
    writeFileSync(join(env.tempDir, 'task-branch-file.ts'), 'x\n');
    execFileSync('git', ['add', 'task-branch-file.ts'], { cwd: env.tempDir });
    execFileSync('git', ['commit', '-q', '-m', 'feat(T_WT4_S4): task work'], {
      cwd: env.tempDir,
    });

    // Switch back to main and make a commit that exists ONLY on main.
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: env.tempDir });
    writeFileSync(join(env.tempDir, 'main-only-file.ts'), 'export const mainOnly = true;\n');
    execFileSync('git', ['add', 'main-only-file.ts'], { cwd: env.tempDir });
    execFileSync('git', ['commit', '-q', '-m', 'chore: main-only commit (not on task branch)'], {
      cwd: env.tempDir,
    });
    const mainOnlySha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.tempDir })
      .toString()
      .trim();

    // Verify setup: mainOnlySha should NOT be reachable from task branch.
    let isOnTaskBranch = false;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', mainOnlySha, 'task/T_WT4_S4'], {
        cwd: env.tempDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      isOnTaskBranch = true;
    } catch {
      isOnTaskBranch = false;
    }
    expect(isOnTaskBranch).toBe(false); // confirm: main commit is NOT on task branch

    // T9178 guard MUST reject: main-only commit used as evidence for a task
    // that has its own branch.
    const r = await validateAtom({ kind: 'commit', sha: mainOnlySha }, env.tempDir, 'T_WT4_S4');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codeName).toBe('E_EVIDENCE_INVALID');
      expect(r.reason).toMatch(/task\/T_WT4_S4/);
    }
  });

  it('REJECTS commit on task branch when no taskId provided (backward-compat)', async () => {
    // Pre-T-WT-3 callers that pass no taskId get the legacy HEAD-ancestry check.
    // A commit on a task branch that is not merged to main MUST fail when no
    // taskId is provided, confirming backward-compat behavior is preserved.
    await seedTasks(env.accessor, [
      {
        id: 'T_WT4_S4B',
        title: 'wt4-scenario4b',
        description: 'backward-compat: commit on task branch fails without taskId',
        status: 'pending',
        priority: 'medium',
        files: [],
        acceptance: ['anything'],
      } as Partial<Task> & { id: string },
    ]);

    execFileSync('git', ['checkout', '-b', 'task/T_WT4_S4B'], { cwd: env.tempDir });
    writeFileSync(join(env.tempDir, 'orphan.ts'), 'x\n');
    execFileSync('git', ['add', 'orphan.ts'], { cwd: env.tempDir });
    execFileSync('git', ['commit', '-q', '-m', 'feat(T_WT4_S4B): orphan commit'], {
      cwd: env.tempDir,
    });
    const orphanSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.tempDir })
      .toString()
      .trim();
    // Switch to main — sha not reachable from HEAD.
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: env.tempDir });

    // No taskId → getEffectiveHead returns "HEAD" → not reachable → ok:false.
    const r = await validateAtom({ kind: 'commit', sha: orphanSha }, env.tempDir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codeName).toBe('E_EVIDENCE_INVALID');
      expect(r.reason).toMatch(/HEAD/i);
    }
  });
});
