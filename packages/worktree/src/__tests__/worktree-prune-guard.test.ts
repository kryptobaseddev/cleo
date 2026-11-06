/**
 * Tests for T11996: worktree auto-prune data-loss guard, now enforced by the
 * one disposal engine (T13924).
 *
 * Validates the dirty/unpushed guard, non-terminal preservation, fail-closed,
 * and idempotency requirements added in T11996.
 *
 * Test strategy:
 *  - "clean orphan" = a linked worktree of the project on a branch at main's
 *    commit, with no changes: every commit is on `main` → removable.
 *  - "dirty orphan" = a linked worktree with an untracked file → kept on disk
 *    untouched and reported in `quarantined` (no tar archive any more).
 *  - "unpushed orphan" = a linked worktree with a commit only on its branch → kept.
 *  - A plain directory git cannot read is kept: a failed probe is not proof.
 *  - Real git repos in temp dirs only — never touching
 *    ~/.local/share/cleo/worktrees.
 *
 * @task T11996
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
import { computeProjectHash } from '../paths.js';
import { pruneWorktrees } from '../worktree-prune.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface Fixture {
  projectRoot: string;
  worktreeRoot: string;
  base: string;
  cleanup: () => void;
}

/**
 * Build a minimal project root (real git repo) + CLEO_HOME layout.
 *
 * The projectRoot needs to be a real git repo so `getGitRoot` does not throw;
 * the individual worktree directories do NOT need to be git repos unless the
 * test specifically requires dirty/unpushed detection.
 */
function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-worktree-test-')));
  const projectRoot = join(base, 'project');
  mkdirSync(projectRoot, { recursive: true });

  execFileSync('git', ['init', '-b', 'main', projectRoot], { stdio: 'pipe' });
  execFileSync('git', ['-C', projectRoot, 'config', 'user.email', 'test@test.invalid'], {
    stdio: 'pipe',
  });
  execFileSync('git', ['-C', projectRoot, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
  writeFileSync(join(projectRoot, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', projectRoot, 'add', 'README.md'], { stdio: 'pipe' });
  execFileSync('git', ['-C', projectRoot, 'commit', '-q', '-m', 'init'], { stdio: 'pipe' });

  const hash = computeProjectHash(projectRoot);
  const prevCleoHome = process.env['CLEO_HOME'];
  process.env['CLEO_HOME'] = base;

  const worktreeRoot = join(base, 'worktrees', hash);
  mkdirSync(worktreeRoot, { recursive: true });

  return {
    projectRoot,
    worktreeRoot,
    base,
    cleanup() {
      if (prevCleoHome === undefined) {
        delete process.env['CLEO_HOME'];
      } else {
        process.env['CLEO_HOME'] = prevCleoHome;
      }
      try {
        rmSync(base, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Add a clean linked worktree of the project under worktreeRoot, on a
 * `task/<id>` branch at main's commit: every commit it holds is on `main`.
 */
function addCleanOrphan(fixture: Fixture, taskId: string): string {
  const path = join(fixture.worktreeRoot, taskId);
  execFileSync(
    'git',
    ['-C', fixture.projectRoot, 'worktree', 'add', '-q', '-b', `task/${taskId}`, path],
    {
      stdio: 'pipe',
    },
  );
  return path;
}

/** Add a linked worktree with an untracked file: not proven preserved. */
function addDirtyOrphan(fixture: Fixture, taskId: string): string {
  const path = addCleanOrphan(fixture, taskId);
  writeFileSync(join(path, 'dirty.txt'), 'uncommitted change\n');
  return path;
}

let fixture: Fixture;

beforeEach(() => {
  fixture = makeFixture();
});

afterEach(() => {
  fixture.cleanup();
});

// ---------------------------------------------------------------------------
// Core acceptance criteria (T11996)
// ---------------------------------------------------------------------------

describe('pruneWorktrees — T11996 dirty guard (kept, T13924)', () => {
  it('AC1: fail-closed blocks removal when preserve set is empty', () => {
    // Empty preserve set with existing worktrees → fail-closed.
    addCleanOrphan(fixture, 'T9001');

    const result = pruneWorktrees({
      projectRoot: fixture.projectRoot,
      preserveTaskIds: new Set<string>(),
      gitPrune: false,
    });

    expect(result.skippedFailClosed).toBe(true);
    expect(result.removed).toBe(0);
    expect(existsSync(join(fixture.worktreeRoot, 'T9001'))).toBe(true);
  });

  it('AC1: clean orphan is removed when preserve set is non-empty', () => {
    // Clean orphan T9002 (plain dir) + preserved marker entry.
    addCleanOrphan(fixture, 'T9002');

    const result = pruneWorktrees({
      projectRoot: fixture.projectRoot,
      preserveTaskIds: new Set(['NON-EXISTENT-PRESERVED']), // non-empty so no fail-closed
      gitPrune: false,
    });

    expect(result.removed).toBe(1);
    expect(result.quarantined).toBe(0);
    expect(existsSync(join(fixture.worktreeRoot, 'T9002'))).toBe(false);
  });

  it('AC1: dirty orphaned worktree is kept, not deleted', () => {
    const wt = addDirtyOrphan(fixture, 'T9010');

    const result = pruneWorktrees({
      projectRoot: fixture.projectRoot,
      preserveTaskIds: new Set(['NON-EXISTENT-PRESERVED']),
      gitPrune: false,
    });

    // Dirty T9010 is kept (not removed) and reported in `quarantined`.
    expect(result.removed).toBe(0);
    expect(result.quarantined).toBe(1);
    expect(result.quarantinedPaths).toHaveLength(1);
    expect(result.quarantinedPaths[0]).toContain('T9010');

    // The original directory must still exist, its change intact.
    expect(existsSync(join(wt, 'dirty.txt'))).toBe(true);
  });

  it('AC1: worktree with uncommitted staged changes is kept', () => {
    const wt = addCleanOrphan(fixture, 'T9012');
    writeFileSync(join(wt, 'staged.ts'), 'export const y = 2;\n');
    execFileSync('git', ['-C', wt, 'add', 'staged.ts'], { stdio: 'pipe' });

    const result = pruneWorktrees({
      projectRoot: fixture.projectRoot,
      preserveTaskIds: new Set(['NON-EXISTENT-PRESERVED']),
      gitPrune: false,
    });

    expect(result.quarantined).toBe(1);
    expect(existsSync(join(wt, 'staged.ts'))).toBe(true);
  });

  it('AC1: a commit held only by the worktree branch keeps it', () => {
    const wt = addCleanOrphan(fixture, 'T9013');
    writeFileSync(join(wt, 'work.ts'), 'export const z = 3;\n');
    execFileSync('git', ['-C', wt, 'add', 'work.ts'], { stdio: 'pipe' });
    execFileSync('git', ['-C', wt, 'commit', '-q', '-m', 'unpushed'], { stdio: 'pipe' });

    const result = pruneWorktrees({
      projectRoot: fixture.projectRoot,
      preserveTaskIds: new Set(['NON-EXISTENT-PRESERVED']),
      gitPrune: false,
    });

    expect(result.removed).toBe(0);
    expect(result.quarantinedPaths).toEqual([wt]);
    expect(existsSync(join(wt, 'work.ts'))).toBe(true);
  });

  it('T13924: a directory git cannot read is kept, never treated as clean', () => {
    const path = join(fixture.worktreeRoot, 'T9015');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'notes.txt'), 'not in any repository\n');

    const result = pruneWorktrees({
      projectRoot: fixture.projectRoot,
      preserveTaskIds: new Set(['NON-EXISTENT-PRESERVED']),
      gitPrune: false,
    });

    expect(result.removed).toBe(0);
    expect(existsSync(join(path, 'notes.txt'))).toBe(true);
  });

  it('AC1: a kept worktree is left untouched, .env included, and nothing is written to quarantine', () => {
    const wt = addDirtyOrphan(fixture, 'T9014');
    writeFileSync(join(wt, '.env'), 'SECRET=topsecret\n');

    pruneWorktrees({
      projectRoot: fixture.projectRoot,
      preserveTaskIds: new Set(['NON-EXISTENT-PRESERVED']),
      gitPrune: false,
    });

    expect(readFileSync(join(wt, '.env'), 'utf-8')).toBe('SECRET=topsecret\n');
    expect(readFileSync(join(wt, 'dirty.txt'), 'utf-8')).toBe('uncommitted change\n');
    expect(existsSync(join(fixture.projectRoot, '.cleo', 'quarantine'))).toBe(false);
  });
});

describe('pruneWorktrees — T11996 PREDICATE BLOCKER (non-terminal preserve)', () => {
  it('Amendment 1: worktree in preserveTaskIds is NEVER removed regardless of idle age', () => {
    addCleanOrphan(fixture, 'T9020');

    // T9020 IS in the preserve set — must never be removed regardless of idle.
    const result = pruneWorktrees({
      projectRoot: fixture.projectRoot,
      preserveTaskIds: new Set(['T9020']),
      idleDays: 0,
      gitPrune: false,
    });

    expect(result.removed).toBe(0);
    expect(result.quarantined).toBe(0);
    expect(existsSync(join(fixture.worktreeRoot, 'T9020'))).toBe(true);
  });

  it('Amendment 1: orphan NOT in preserve set is pruned when idle', () => {
    // T9021 preserved, T9022 orphan (clean plain dir).
    addCleanOrphan(fixture, 'T9021');
    addCleanOrphan(fixture, 'T9022');

    const result = pruneWorktrees({
      projectRoot: fixture.projectRoot,
      preserveTaskIds: new Set(['T9021']),
      gitPrune: false,
    });

    // T9022 is not in preserve set → orphan → removed (clean, commits on main).
    expect(result.removed).toBe(1);
    expect(existsSync(join(fixture.worktreeRoot, 'T9021'))).toBe(true);
    expect(existsSync(join(fixture.worktreeRoot, 'T9022'))).toBe(false);
  });
});

describe('pruneWorktrees — T11996 fail-closed guard', () => {
  it('Amendment 2: empty preserve set with existing worktrees skips entirely', () => {
    addCleanOrphan(fixture, 'T9030');
    addCleanOrphan(fixture, 'T9031');

    const result = pruneWorktrees({
      projectRoot: fixture.projectRoot,
      preserveTaskIds: new Set<string>(),
      gitPrune: false,
    });

    expect(result.skippedFailClosed).toBe(true);
    expect(result.removed).toBe(0);
    expect(result.quarantined).toBe(0);
    expect(existsSync(join(fixture.worktreeRoot, 'T9030'))).toBe(true);
    expect(existsSync(join(fixture.worktreeRoot, 'T9031'))).toBe(true);
  });

  it('Amendment 2: fail-closed writes an audit warning entry', () => {
    addCleanOrphan(fixture, 'T9032');

    pruneWorktrees({
      projectRoot: fixture.projectRoot,
      preserveTaskIds: new Set<string>(),
      gitPrune: false,
    });

    const auditPath = join(fixture.projectRoot, '.cleo', 'audit', 'worktree-lifecycle.jsonl');
    expect(existsSync(auditPath)).toBe(true);
    const content = readFileSync(auditPath, 'utf-8');
    expect(content).toContain('fail-closed');
  });

  it('Amendment 2: empty worktree dir with empty preserve set does NOT trigger fail-closed', () => {
    // No worktrees exist — empty preserve set is fine.
    const result = pruneWorktrees({
      projectRoot: fixture.projectRoot,
      preserveTaskIds: new Set<string>(),
      gitPrune: false,
    });

    expect(result.skippedFailClosed).toBeFalsy();
    expect(result.removed).toBe(0);
  });
});

describe('pruneWorktrees — T11996 idempotency', () => {
  it('Amendment 5: second run against converged state performs zero actions', () => {
    // A clean orphan (commits on main → removable).
    addCleanOrphan(fixture, 'T9040');

    const opts = {
      projectRoot: fixture.projectRoot,
      preserveTaskIds: new Set(['NON-EXISTENT-PRESERVED']),
      gitPrune: false,
    };

    // First run removes T9040.
    const first = pruneWorktrees(opts);
    expect(first.removed).toBe(1);
    expect(existsSync(join(fixture.worktreeRoot, 'T9040'))).toBe(false);

    // Second run — T9040 is already gone: zero actions.
    const second = pruneWorktrees(opts);
    expect(second.removed).toBe(0);
    expect(second.quarantined).toBe(0);
    expect(second.errors).toHaveLength(0);
  });
});
