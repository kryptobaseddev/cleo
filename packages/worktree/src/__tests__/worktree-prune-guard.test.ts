/**
 * Tests for T11996: worktree auto-prune data-loss guard.
 *
 * Validates the dirty/unpushed guard, quarantine, non-terminal preservation,
 * fail-closed, and idempotency requirements added in T11996.
 *
 * Test strategy:
 *  - "clean orphan" = plain directory with no git repo. git commands fail
 *    gracefully → isWorktreeDirty=false, hasUnpushedCommits=false → removable.
 *  - "dirty orphan" = git repo with uncommitted changes.
 *  - "unpushed orphan" = git repo with commits but no remote → quarantined.
 *  - Real git repos in temp dirs only — never touching
 *    ~/.local/share/cleo/worktrees.
 *
 * @task T11996
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
 * Add a plain directory (no git repo) to the worktreeRoot.
 * isWorktreeDirty → false, hasUnpushedCommits → false → clean orphan.
 */
function addCleanOrphan(fixture: Fixture, taskId: string): string {
  const path = join(fixture.worktreeRoot, taskId);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'placeholder.txt'), 'placeholder\n');
  return path;
}

/**
 * Add a git repo under worktreeRoot with uncommitted changes.
 * isWorktreeDirty → true → quarantine candidate.
 */
function addDirtyOrphan(fixture: Fixture, taskId: string): string {
  const path = join(fixture.worktreeRoot, taskId);
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-b', `task/${taskId}`, path], { stdio: 'pipe' });
  execFileSync('git', ['-C', path, 'config', 'user.email', 'test@test.invalid'], { stdio: 'pipe' });
  execFileSync('git', ['-C', path, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
  writeFileSync(join(path, 'base.txt'), 'base\n');
  execFileSync('git', ['-C', path, 'add', 'base.txt'], { stdio: 'pipe' });
  execFileSync('git', ['-C', path, 'commit', '-q', '-m', 'base'], { stdio: 'pipe' });
  // Now make it dirty.
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

describe('pruneWorktrees — T11996 dirty guard + quarantine', () => {
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

  it('AC1: dirty orphaned worktree is quarantined, not deleted', () => {
    const wt = addDirtyOrphan(fixture, 'T9010');

    const result = pruneWorktrees({
      projectRoot: fixture.projectRoot,
      preserveTaskIds: new Set(['NON-EXISTENT-PRESERVED']),
      gitPrune: false,
    });

    // Dirty T9010 should be quarantined (not removed).
    expect(result.removed).toBe(0);
    expect(result.quarantined).toBe(1);
    expect(result.quarantinedPaths).toHaveLength(1);
    expect(result.quarantinedPaths[0]).toContain('T9010');

    // The original directory must still exist (quarantine preserves it).
    expect(existsSync(wt)).toBe(true);

    // A quarantine archive must have been created.
    const quarantineDir = join(fixture.projectRoot, '.cleo', 'quarantine', 'worktrees');
    expect(existsSync(quarantineDir)).toBe(true);
    const archives = readdirSync(quarantineDir);
    expect(archives.filter((f) => f.startsWith('T9010') && f.endsWith('.tar.gz'))).toHaveLength(1);
  });

  it('AC1: worktree with uncommitted staged changes is quarantined', () => {
    const wt = addCleanOrphan(fixture, 'T9012');
    // Turn the dir into a git repo with staged changes.
    execFileSync('git', ['init', '-b', 'main', wt], { stdio: 'pipe' });
    execFileSync('git', ['-C', wt, 'config', 'user.email', 'test@test.invalid'], { stdio: 'pipe' });
    execFileSync('git', ['-C', wt, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
    writeFileSync(join(wt, 'base.ts'), 'export const x = 1;\n');
    execFileSync('git', ['-C', wt, 'add', 'base.ts'], { stdio: 'pipe' });
    execFileSync('git', ['-C', wt, 'commit', '-q', '-m', 'base'], { stdio: 'pipe' });
    writeFileSync(join(wt, 'staged.ts'), 'export const y = 2;\n');
    execFileSync('git', ['-C', wt, 'add', 'staged.ts'], { stdio: 'pipe' });
    // staged.ts is staged but not committed.

    const result = pruneWorktrees({
      projectRoot: fixture.projectRoot,
      preserveTaskIds: new Set(['NON-EXISTENT-PRESERVED']),
      gitPrune: false,
    });

    expect(result.quarantined).toBe(1);
    expect(existsSync(wt)).toBe(true);
  });

  it('AC1: quarantine archive captures untracked files including .env', () => {
    const wt = addDirtyOrphan(fixture, 'T9014');
    // Add untracked .env file on top of the dirty state.
    writeFileSync(join(wt, '.env'), 'SECRET=topsecret\n');

    pruneWorktrees({
      projectRoot: fixture.projectRoot,
      preserveTaskIds: new Set(['NON-EXISTENT-PRESERVED']),
      gitPrune: false,
    });

    const quarantineDir = join(fixture.projectRoot, '.cleo', 'quarantine', 'worktrees');
    const archives = readdirSync(quarantineDir).filter(
      (f) => f.startsWith('T9014') && f.endsWith('.tar.gz'),
    );
    expect(archives).toHaveLength(1);

    const archivePath = join(quarantineDir, archives[0]!);
    const tarList = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf-8' });
    // .env must be captured (not excluded).
    expect(tarList).toContain('.env');
    // dirty.txt (untracked from addDirtyOrphan) must also be captured.
    expect(tarList).toContain('dirty.txt');
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

    // T9022 is not in preserve set → orphan → removed (plain dir = clean).
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
    // Clean plain-dir orphans (no git repos → clean → removable).
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
