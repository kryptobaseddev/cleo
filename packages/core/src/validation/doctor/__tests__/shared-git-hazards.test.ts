/**
 * Tests for the shared-worktree git hazard checks (T12161).
 *
 * Both checks exist because a `.git` directory shared by several worktrees
 * shares things most people think of as tree-local: the stash stack and the
 * committing identity. Both hazards were observed live in this repository on
 * 2026-09-12 — a bare `git stash pop` took another session's entry from a
 * 26-deep stack, and three commits were authored under a throwaway identity
 * (`compose probe <probe@local>`) left behind by an unrelated experiment.
 *
 * These tests build REAL repositories with REAL worktrees and REAL stash
 * entries rather than mocking git. The behaviour under test is precisely how
 * git shares state between worktrees, so a mock would assert our belief about
 * git instead of git's actual semantics — and the belief is the thing that was
 * wrong in the first place.
 *
 * @task T12161
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSharedGitIdentity, checkSharedWorktreeStashes } from '../checks.js';

const AUTHOR_EMAIL = 'historical-author@example.test';

/** Directories created by a test, removed in afterEach. */
const created: string[] = [];

/** Run git in `cwd`, throwing with readable context on failure. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Build a repository with one commit authored by {@link AUTHOR_EMAIL}.
 *
 * Includes `.cleo/` + `project-info.json` so `getProjectRoot()` takes its
 * primary validation path rather than the legacy fallback.
 */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'cleo-git-hazard-'));
  created.push(root);
  mkdirSync(join(root, '.cleo'), { recursive: true });
  writeFileSync(
    join(root, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: 'hazard-test' }),
  );
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.email', AUTHOR_EMAIL);
  git(root, 'config', 'user.name', 'Historical Author');
  writeFileSync(join(root, 'tracked.txt'), 'v1\n');
  git(root, 'add', 'tracked.txt');
  git(root, 'commit', '-m', 'initial');
  return root;
}

/** Add a second worktree so the repo's `.git` is genuinely shared. */
function addWorktree(root: string): string {
  const wt = `${root}-wt`;
  created.push(wt);
  git(root, 'worktree', 'add', '-b', 'second', wt);
  return wt;
}

/** Create one stash entry by modifying a tracked file and stashing it. */
function pushStash(root: string, content: string): void {
  writeFileSync(join(root, 'tracked.txt'), content);
  git(root, 'stash', 'push', '-m', `wip ${content.trim()}`);
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('T12161 — checkSharedWorktreeStashes', () => {
  it('passes when there is no stash at all', () => {
    const root = makeRepo();
    const result = checkSharedWorktreeStashes(root);
    expect(result.status).toBe('passed');
    expect(result.details).toMatchObject({ stashCount: 0 });
  });

  it('stays silent for a stash in a single-worktree repo — that stash is private', () => {
    const root = makeRepo();
    pushStash(root, 'v2\n');
    const result = checkSharedWorktreeStashes(root);
    expect(result.status).toBe('passed');
    expect(result.details).toMatchObject({ stashCount: 1, worktrees: 1 });
  });

  it('warns when a stash stack is shared by more than one worktree', () => {
    const root = makeRepo();
    addWorktree(root);
    pushStash(root, 'v2\n');
    const result = checkSharedWorktreeStashes(root);
    expect(result.status).toBe('warning');
    expect(result.details).toMatchObject({ stashCount: 1, worktrees: 2 });
    expect(result.fix).toContain('git stash apply stash@{N}');
  });

  it('reports the true depth, because the risk scales with what a bare pop could take', () => {
    const root = makeRepo();
    addWorktree(root);
    pushStash(root, 'v2\n');
    pushStash(root, 'v3\n');
    pushStash(root, 'v4\n');
    const result = checkSharedWorktreeStashes(root);
    expect(result.status).toBe('warning');
    expect(result.details).toMatchObject({ stashCount: 3 });
  });

  it('a second worktree SEES the first worktree stash — the premise of the check', () => {
    const root = makeRepo();
    const wt = addWorktree(root);
    pushStash(root, 'v2\n');
    // Observed from the OTHER tree: the stack is repository-wide, so a bare
    // `git stash pop` run here would take the entry pushed in `root`.
    expect(git(wt, 'stash', 'list')).toContain('wip v2');
  });

  it('returns info rather than a false pass outside a git repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-git-hazard-nogit-'));
    created.push(root);
    mkdirSync(join(root, '.cleo'), { recursive: true });
    writeFileSync(join(root, '.cleo', 'project-info.json'), JSON.stringify({ projectId: 'x' }));
    const result = checkSharedWorktreeStashes(root);
    expect(result.status).toBe('info');
    expect(result.details).toMatchObject({ isGitRepo: false });
  });
});

describe('T12161 — checkSharedGitIdentity', () => {
  it('passes in a single-worktree repo even when the local identity is unusual', () => {
    const root = makeRepo();
    git(root, 'config', '--local', 'user.email', 'probe@local');
    const result = checkSharedGitIdentity(root);
    expect(result.status).toBe('passed');
    expect(result.details).toMatchObject({ worktrees: 1 });
  });

  it('passes when the repo-local identity appears in recent history', () => {
    const root = makeRepo();
    addWorktree(root);
    const result = checkSharedGitIdentity(root);
    expect(result.status).toBe('passed');
    expect(result.details).toMatchObject({ localOverride: AUTHOR_EMAIL });
  });

  it('warns when a shared repo-local identity authored none of recent history', () => {
    const root = makeRepo();
    addWorktree(root);
    // Exactly the 2026-09-12 incident: a throwaway identity left in the shared
    // config by one session, silently re-authoring every other session.
    git(root, 'config', '--local', 'user.email', 'probe@local');
    const result = checkSharedGitIdentity(root);
    expect(result.status).toBe('warning');
    expect(result.details).toMatchObject({
      localOverride: 'probe@local',
      mostRecentHistoricalAuthor: AUTHOR_EMAIL,
    });
    // The remedy must REMOVE the override, not set another value — the
    // committer's own global identity is the thing to fall back to.
    expect(result.fix).toContain('--unset user.email');
  });

  it('does NOT warn when there is no repo-local override, even with no matching history', () => {
    // Regression guard for the first version of this check, which read the
    // MERGED identity (`git config user.email`). That value falls through to
    // the committer's global config, so every first-time contributor tripped
    // it. Only a repo-local override can be imposed by one session on another.
    const root = makeRepo();
    addWorktree(root);
    git(root, 'config', '--local', '--unset', 'user.email');
    const result = checkSharedGitIdentity(root);
    expect(result.status).toBe('passed');
    expect(result.details).toMatchObject({ localOverride: null });
  });

  it('returns info rather than a false pass outside a git repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-git-hazard-nogit2-'));
    created.push(root);
    mkdirSync(join(root, '.cleo'), { recursive: true });
    writeFileSync(join(root, '.cleo', 'project-info.json'), JSON.stringify({ projectId: 'x' }));
    const result = checkSharedGitIdentity(root);
    expect(result.status).toBe('info');
    expect(result.details).toMatchObject({ isGitRepo: false });
  });
});
