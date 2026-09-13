/**
 * Tests for completeAgentWorktreeViaMerge + getDefaultBranch (T1587 / ADR-062).
 *
 * Strategy: build a real on-disk git repo + worktree fixture so we can assert
 * the integration genuinely preserves the agent's commit SHAs (which
 * cherry-pick destroys). Each test is self-isolated under tmpdir.
 *
 * Project-agnostic invariant: every test passes a non-default branch name
 * (`trunk`, `develop`, etc.) to verify zero hardcoded `main`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  completeAgentWorktreeViaMerge,
  createAgentWorktree,
  getDefaultBranch,
  resolveAgentWorktreeRoot,
} from '../branch-lock.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface Fixture {
  /** Project root (= git root) */
  root: string;
  /** Tear-down — call from afterEach. */
  cleanup: () => void;
}

/**
 * Build a fresh git repository at a tmpdir with one commit on `<branch>`.
 *
 * The XDG_DATA_HOME for the duration of the fixture is also set under the
 * tmpdir so {@link resolveAgentWorktreeRoot} writes to a contained location.
 */
function makeRepo(branch: string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-merge-test-'));
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
  git('commit', '-q', '-m', 'initial commit');

  return {
    root: dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      delete process.env['XDG_DATA_HOME'];
    },
  };
}

/** Drive a git command at a specific cwd. */
function gitAt(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

// ---------------------------------------------------------------------------
// getDefaultBranch
// ---------------------------------------------------------------------------

describe('getDefaultBranch (project-agnostic resolution)', () => {
  let fixture: Fixture;
  afterEach(() => fixture?.cleanup());

  it('reads .cleo/config.json::git.defaultBranch when present', () => {
    fixture = makeRepo('main');
    const cleoDir = join(fixture.root, '.cleo');
    mkdirSync(cleoDir, { recursive: true });
    writeFileSync(
      join(cleoDir, 'config.json'),
      JSON.stringify({ git: { defaultBranch: 'release' } }),
    );
    expect(getDefaultBranch(fixture.root)).toBe('release');
  });

  it('falls back to local branch probing when no config + no remote', () => {
    fixture = makeRepo('trunk');
    expect(getDefaultBranch(fixture.root)).toBe('trunk');
  });

  it('does not hardcode main — discovers `master` repos correctly', () => {
    fixture = makeRepo('master');
    expect(getDefaultBranch(fixture.root)).toBe('master');
  });

  it('returns "main" as last-resort fallback when nothing matches', () => {
    fixture = makeRepo('feature-x');
    // feature-x exists, so probe order picks up nothing in main/master/develop/trunk;
    // verify the fallback contract is respected.
    expect(getDefaultBranch(fixture.root)).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// completeAgentWorktreeViaMerge — provenance preservation
// ---------------------------------------------------------------------------

describe('completeAgentWorktreeViaMerge (ADR-062)', () => {
  let fixture: Fixture;
  afterEach(() => fixture?.cleanup());

  it('preserves agent commit SHAs in target branch history (provenance contract)', () => {
    fixture = makeRepo('trunk');

    // Spawn an agent worktree.
    const wt = createAgentWorktree('T1587', fixture.root);
    expect(existsSync(wt.path)).toBe(true);

    // Configure git identity inside the worktree.
    gitAt(wt.path, 'config', 'user.email', 'agent@example.com');
    gitAt(wt.path, 'config', 'user.name', 'Agent');
    gitAt(wt.path, 'config', 'commit.gpgsign', 'false');

    // Agent makes two commits.
    writeFileSync(join(wt.path, 'feature.ts'), 'export const a = 1;\n');
    gitAt(wt.path, 'add', 'feature.ts');
    gitAt(wt.path, 'commit', '-q', '-m', 'T1587: add feature.ts');
    const agentSha1 = gitAt(wt.path, 'rev-parse', 'HEAD');

    writeFileSync(join(wt.path, 'feature.ts'), 'export const a = 1;\nexport const b = 2;\n');
    gitAt(wt.path, 'add', 'feature.ts');
    gitAt(wt.path, 'commit', '-q', '-m', 'T1587: extend feature.ts');
    const agentSha2 = gitAt(wt.path, 'rev-parse', 'HEAD');

    // Integrate via merge.
    const result = completeAgentWorktreeViaMerge('T1587', fixture.root, {
      targetBranch: 'trunk',
      taskTitle: 'add feature module',
      skipFetch: true,
    });

    expect(result.merged).toBe(true);
    expect(result.commitCount).toBe(2);
    expect(result.targetBranch).toBe('trunk');
    expect(result.mergeCommit.length).toBe(40);
    expect(result.error).toBeUndefined();

    // CRITICAL CONTRACT: the agent's SHAs must still be in trunk's history.
    // This is what cherry-pick would have destroyed.
    const trunkLog = gitAt(fixture.root, 'log', '--format=%H', 'trunk');
    const trunkShas = new Set(
      trunkLog
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    expect(trunkShas.has(agentSha1)).toBe(true);
    expect(trunkShas.has(agentSha2)).toBe(true);

    // The merge commit subject must contain the task ID (grep contract).
    const mergeMsg = gitAt(fixture.root, 'log', '-1', '--format=%s', result.mergeCommit);
    expect(mergeMsg).toMatch(/T1587/);

    // git log --grep "T1587" must return at least the merge + the 2 agent commits.
    const grepOut = gitAt(fixture.root, 'log', '--format=%H', '--grep=T1587', 'trunk');
    const grepShas = grepOut
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(grepShas.length).toBeGreaterThanOrEqual(3);
  });

  it('does not hardcode `main` — works against an arbitrary target branch', () => {
    fixture = makeRepo('develop');
    const wt = createAgentWorktree('T1587b', fixture.root);
    gitAt(wt.path, 'config', 'user.email', 'agent@example.com');
    gitAt(wt.path, 'config', 'user.name', 'Agent');
    gitAt(wt.path, 'config', 'commit.gpgsign', 'false');

    writeFileSync(join(wt.path, 'a.txt'), 'a\n');
    gitAt(wt.path, 'add', 'a.txt');
    gitAt(wt.path, 'commit', '-q', '-m', 'T1587b: add a');

    const result = completeAgentWorktreeViaMerge('T1587b', fixture.root, {
      targetBranch: 'develop',
      skipFetch: true,
    });

    expect(result.merged).toBe(true);
    expect(result.targetBranch).toBe('develop');
    expect(result.commitCount).toBe(1);

    const headBranch = gitAt(fixture.root, 'rev-parse', '--abbrev-ref', 'HEAD');
    expect(headBranch).toBe('develop');
  });

  it('returns merged: true with empty mergeCommit when no commits ahead', () => {
    fixture = makeRepo('trunk');
    const wt = createAgentWorktree('T1587c', fixture.root);
    // No commits in worktree — branch is at parity with trunk.

    const result = completeAgentWorktreeViaMerge('T1587c', fixture.root, {
      targetBranch: 'trunk',
      skipFetch: true,
    });

    expect(result.merged).toBe(true);
    expect(result.commitCount).toBe(0);
    expect(result.mergeCommit).toBe('');
    // Worktree should still be cleaned up via prune.
    const wtRoot = resolveAgentWorktreeRoot(fixture.root);
    expect(existsSync(join(wtRoot, 'T1587c'))).toBe(false);
  });

  it('classifies a missing task branch as nothing-to-integrate (T12153)', () => {
    fixture = makeRepo('trunk');
    const result = completeAgentWorktreeViaMerge('T-NEVER-CREATED', fixture.root, {
      targetBranch: 'trunk',
      skipFetch: true,
    });
    expect(result.merged).toBe(false);

    // T12153 rewrote this path deliberately: a task that never had a branch is
    // a no-work outcome, not an integration failure. This assertion used to be
    // `toMatch(/does not exist/)`, which pinned the INCIDENTAL WORDING of the
    // old message — so T12153's rename broke it while the behaviour it was
    // meant to protect was working exactly as intended.
    //
    // It now asserts the contract the implementation actually publishes, which
    // is the one `branch-lock.ts` states at the callsite: "A caller
    // distinguishes no-work from failure by the FLAG, never by the presence of
    // a string." The message is checked only for the substring T12153
    // guarantees, not for a phrasing nobody promised to keep.
    expect(result.nothingToIntegrate).toBe(true);
    expect(result.error).toContain('nothing to integrate');
  });
});

// ---------------------------------------------------------------------------
// T12153 (GH #1223) — "nothing to integrate" is not a failure
// ---------------------------------------------------------------------------

describe('completeAgentWorktreeViaMerge — nothing to integrate (T12153)', () => {
  let fixture: Fixture;

  afterEach(() => {
    fixture?.cleanup();
  });

  /**
   * The reported case. Most tasks are worked on a feature branch and merged by
   * PR, so no `task/<id>` branch and no agent worktree ever exist. Before
   * T12153 that produced `merged: false` with
   * `error: "task branch 'task/T1655' does not exist"`, and `cleo complete`
   * logged it at WARN as an integration failure — on most completions.
   */
  it('reports nothingToIntegrate when neither branch nor worktree exists', () => {
    fixture = makeRepo('main');
    const result = completeAgentWorktreeViaMerge('T9999001', fixture.root);

    // The FLAG is the classification a caller must branch on.
    expect(result.nothingToIntegrate).toBe(true);
    expect(result.merged).toBe(false);
  });

  /**
   * `error` is deliberately still populated here, and the first draft of this
   * change cleared it. That was wrong: `orchestrate worktree-complete` renders
   * `integration.error ?? 'unknown merge failure'`, so dropping the string
   * replaced an accurate message with a misleading one on a second surface.
   *
   * So the split is: `error` is a human-readable MESSAGE, `nothingToIntegrate`
   * is the machine-readable CLASSIFICATION. A caller must never infer failure
   * from the mere presence of a string.
   */
  it('keeps a descriptive message, but one that does not read as a failure', () => {
    fixture = makeRepo('main');
    const result = completeAgentWorktreeViaMerge('T9999005', fixture.root);

    expect(result.error).toContain('nothing to integrate');
    expect(result.error).not.toMatch(/fail|conflict|error/i);
  });

  it('leaves the other result fields in their no-work state', () => {
    fixture = makeRepo('trunk');
    const result = completeAgentWorktreeViaMerge('T9999002', fixture.root);

    expect(result.mergeCommit).toBe('');
    expect(result.commitCount).toBe(0);
    expect(result.rebased).toBe(false);
    expect(result.worktreeRemoved).toBe(false);
    expect(result.branchDeleted).toBe(false);
    expect(result.targetBranch).toBe('trunk');
  });

  it('does NOT claim nothingToIntegrate when a task branch DOES exist', () => {
    // The dangerous inverse: suppressing a genuine integration failure would
    // be worse than the noise this change removes. A task branch that exists
    // must still go through the real integration path.
    fixture = makeRepo('main');
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: fixture.root,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    git('branch', 'task/T9999003');

    const result = completeAgentWorktreeViaMerge('T9999003', fixture.root);
    expect(result.nothingToIntegrate).toBeUndefined();
  });

  it('is not a git repo → still an error, not nothingToIntegrate', () => {
    // A non-git directory is a real problem and must keep reporting as one.
    const dir = mkdtempSync(join(tmpdir(), 'cleo-nogit-'));
    try {
      const result = completeAgentWorktreeViaMerge('T9999004', dir);
      expect(result.nothingToIntegrate).toBeUndefined();
      expect(result.error).toMatch(/Not a git repo/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
