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

  it('returns error when the task branch does not exist', () => {
    fixture = makeRepo('trunk');
    const result = completeAgentWorktreeViaMerge('T-NEVER-CREATED', fixture.root, {
      targetBranch: 'trunk',
      skipFetch: true,
    });
    expect(result.merged).toBe(false);
    expect(result.error).toMatch(/does not exist/);
  });
});
