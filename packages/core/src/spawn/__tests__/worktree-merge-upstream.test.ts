/**
 * T12773 — `cleo done` / `cleo complete` must never create a local
 * `merge task/<id>` commit when the task already landed upstream, nor merge
 * into a local default branch that is behind origin.
 *
 * Reproduces the 2026-09-29 incident: local `main` far behind `origin/main`,
 * the task's PR already merged upstream, and the completion-time worktree
 * integration ran `git merge --no-ff task/<id>` into the stale local `main`
 * ("Merge made by the 'ort' strategy"), forking it from origin.
 *
 * Fixtures: a bare `origin`, the project clone (stale `main`), and a second
 * "upstream developer" clone that lands the task branch on origin.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assessUpstreamIntegration,
  completeAgentWorktreeViaMerge,
  createAgentWorktree,
} from '../branch-lock.js';

/** Run git at `cwd`, returning trimmed stdout. */
function gitAt(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** Configure a deterministic committer identity in a repo/worktree. */
function identity(cwd: string): void {
  gitAt(cwd, 'config', 'user.email', 'cleo-test@example.com');
  gitAt(cwd, 'config', 'user.name', 'CLEO Test');
  gitAt(cwd, 'config', 'commit.gpgsign', 'false');
}

/** Write + commit a file at `cwd`. */
function commitFile(cwd: string, file: string, body: string, msg: string): string {
  writeFileSync(join(cwd, file), body);
  gitAt(cwd, 'add', file);
  gitAt(cwd, 'commit', '-q', '-m', msg);
  return gitAt(cwd, 'rev-parse', 'HEAD');
}

interface UpstreamFixture {
  /** Project checkout (clone of origin, on `main`). */
  root: string;
  /** Second clone that plays the upstream merger. */
  dev: string;
  /** Tear-down. */
  cleanup: () => void;
}

/** Bare origin + project clone + dev clone, all sharing one `main` commit. */
function makeUpstreamFixture(): UpstreamFixture {
  const base = mkdtempSync(join(tmpdir(), 'cleo-t12773-'));
  const xdg = join(base, '.xdg');
  mkdirSync(xdg, { recursive: true });
  vi.stubEnv('XDG_DATA_HOME', xdg);
  vi.stubEnv('CLEO_HOME', join(xdg, 'cleo'));

  const origin = join(base, 'origin.git');
  gitAt(base, 'init', '-q', '--bare', '-b', 'main', origin);

  const seed = join(base, 'seed');
  gitAt(base, 'init', '-q', '-b', 'main', seed);
  identity(seed);
  commitFile(seed, 'README.md', '# fixture\n', 'initial commit');
  gitAt(seed, 'remote', 'add', 'origin', origin);
  gitAt(seed, 'push', '-q', 'origin', 'main');

  const root = join(base, 'project');
  gitAt(base, 'clone', '-q', origin, root);
  identity(root);
  const dev = join(base, 'dev');
  gitAt(base, 'clone', '-q', origin, dev);
  identity(dev);

  return {
    root,
    dev,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** Agent worktree for `taskId` with one commit, pushed to origin. */
function agentCommitAndPush(root: string, taskId: string): string {
  const wt = createAgentWorktree(taskId, root);
  identity(wt.path);
  const tip = commitFile(wt.path, `${taskId}.ts`, 'export const x = 1;\n', `${taskId}: work`);
  gitAt(wt.path, 'push', '-q', 'origin', `task/${taskId}`);
  return tip;
}

/** Merge commits on local `main` that origin/main does not have. */
function localOnlyCommits(root: string): string[] {
  const out = gitAt(root, 'rev-list', 'refs/remotes/origin/main..refs/heads/main');
  return out.length > 0 ? out.split('\n') : [];
}

afterEach(() => vi.unstubAllEnvs());

describe('T12773 — no local merge of a task that already landed upstream', () => {
  let fx: UpstreamFixture;
  afterEach(() => fx?.cleanup());

  it('PR merged upstream (--no-ff) + stale local main → no local merge, checkout NOT moved, sync hint', () => {
    fx = makeUpstreamFixture();
    const taskId = 'T9912773';
    const tip = agentCommitAndPush(fx.root, taskId);

    // Upstream lands the PR, then main moves on (local main goes stale).
    gitAt(fx.dev, 'fetch', '-q', 'origin');
    gitAt(fx.dev, 'merge', '-q', '--no-ff', `origin/task/${taskId}`, '-m', 'Merge PR');
    commitFile(fx.dev, 'later.ts', 'export const later = 1;\n', 'later upstream work');
    gitAt(fx.dev, 'push', '-q', 'origin', 'main');
    const headBefore = gitAt(fx.root, 'rev-parse', 'HEAD');
    const localBefore = gitAt(fx.root, 'rev-parse', 'main');

    const result = completeAgentWorktreeViaMerge(taskId, fx.root, { targetBranch: 'main' });

    expect(result.merged, JSON.stringify(result)).toBe(false);
    expect(result.landedUpstream).toBe(true);
    expect(result.nothingToIntegrate).toBe(true);
    expect(result.staleTarget).toBeUndefined();
    expect(result.mergeCommit).toBe('');
    expect(result.error).toBeUndefined();
    // The core assertion: no local-only commit (no `merge task/<id>`) on main.
    expect(localOnlyCommits(fx.root)).toEqual([]);
    // Hint-only policy: the operator's checkout never moves.
    expect(gitAt(fx.root, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(gitAt(fx.root, 'rev-parse', 'main')).toBe(localBefore);
    expect(gitAt(fx.root, 'reflog', '-n', '5', 'main')).not.toMatch(/merge task\//);
    // ... but the exact sync command is handed back.
    expect(result.syncCommand).toMatch(
      /^git -C '.+' switch 'main' && git -C '.+' merge --ff-only 'origin\/main'$/,
    );
    expect(result.hint).toMatch(/merge --ff-only 'origin\/main'/);
    expect(result.hint).toMatch(/3 commit\(s\) behind origin\/main/);
    expect(gitAt(fx.root, 'merge-base', '--is-ancestor', tip, 'refs/remotes/origin/main')).toBe('');
    // Commits are safe on origin, so the clean worktree is pruned and the
    // task branch deleted explicitly — pruneWorktree alone would keep it
    // (it is not contained in the stale, deliberately unsynced checkout HEAD).
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(gitAt(fx.root, 'branch', '--list', `task/${taskId}`)).toBe('');
  });

  it('PR squash-merged upstream → detected as landed, no local merge', () => {
    fx = makeUpstreamFixture();
    const taskId = 'T9912774';
    agentCommitAndPush(fx.root, taskId);

    gitAt(fx.dev, 'fetch', '-q', 'origin');
    gitAt(fx.dev, 'merge', '-q', '--squash', `origin/task/${taskId}`);
    gitAt(fx.dev, 'commit', '-q', '-m', 'Squash PR');
    gitAt(fx.dev, 'push', '-q', 'origin', 'main');

    const result = completeAgentWorktreeViaMerge(taskId, fx.root, { targetBranch: 'main' });

    expect(result.landedUpstream, JSON.stringify(result)).toBe(true);
    expect(result.merged).toBe(false);
    expect(localOnlyCommits(fx.root)).toEqual([]);
    // A squash merge never makes the task commits ancestors of anything, so
    // only the explicit landed-branch delete keeps task/<id> from piling up.
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(gitAt(fx.root, 'branch', '--list', `task/${taskId}`)).toBe('');
  });

  it('dirty checkout → landed; local main untouched, hint given', () => {
    fx = makeUpstreamFixture();
    const taskId = 'T9912775';
    agentCommitAndPush(fx.root, taskId);
    gitAt(fx.dev, 'fetch', '-q', 'origin');
    gitAt(fx.dev, 'merge', '-q', '--no-ff', `origin/task/${taskId}`, '-m', 'Merge PR');
    gitAt(fx.dev, 'push', '-q', 'origin', 'main');

    writeFileSync(join(fx.root, 'README.md'), '# locally edited\n');
    const localBefore = gitAt(fx.root, 'rev-parse', 'main');

    const result = completeAgentWorktreeViaMerge(taskId, fx.root, { targetBranch: 'main' });

    expect(result.landedUpstream, JSON.stringify(result)).toBe(true);
    expect(gitAt(fx.root, 'rev-parse', 'main')).toBe(localBefore);
    expect(result.hint).toMatch(/merge --ff-only 'origin\/main'/);
  });

  it('task NOT landed but local main is behind origin → refused, no merge commit', () => {
    fx = makeUpstreamFixture();
    const taskId = 'T9912776';
    const wt = createAgentWorktree(taskId, fx.root);
    identity(wt.path);
    commitFile(wt.path, 'unlanded.ts', 'export const u = 1;\n', `${taskId}: unlanded`);

    commitFile(fx.dev, 'other.ts', 'export const o = 1;\n', 'unrelated upstream work');
    gitAt(fx.dev, 'push', '-q', 'origin', 'main');
    const localBefore = gitAt(fx.root, 'rev-parse', 'main');

    const result = completeAgentWorktreeViaMerge(taskId, fx.root, { targetBranch: 'main' });

    expect(result.merged, JSON.stringify(result)).toBe(false);
    expect(result.landedUpstream).toBeUndefined();
    expect(result.nothingToIntegrate).toBeUndefined();
    expect(result.error).toMatch(/behind origin\/main/);
    expect(gitAt(fx.root, 'rev-parse', 'main')).toBe(localBefore);
    // Worktree + branch preserved for recovery.
    expect(existsSync(wt.path)).toBe(true);
    expect(gitAt(fx.root, 'branch', '--list', `task/${taskId}`)).not.toBe('');
  });

  it('task NOT landed + local main DIVERGED (ahead and behind) → refused with merge (never rebase) hint', () => {
    fx = makeUpstreamFixture();
    const taskId = 'T9912778';
    const wt = createAgentWorktree(taskId, fx.root);
    identity(wt.path);
    commitFile(wt.path, 'diverged.ts', 'export const d = 1;\n', `${taskId}: work`);

    commitFile(fx.dev, 'up1.ts', 'export const a = 1;\n', 'upstream 1');
    commitFile(fx.dev, 'up2.ts', 'export const b = 1;\n', 'upstream 2');
    gitAt(fx.dev, 'push', '-q', 'origin', 'main');
    commitFile(fx.root, 'local.ts', 'export const l = 1;\n', 'unpushed local work');
    const headBefore = gitAt(fx.root, 'rev-parse', 'HEAD');

    const result = completeAgentWorktreeViaMerge(taskId, fx.root, { targetBranch: 'main' });

    expect(result.merged, JSON.stringify(result)).toBe(false);
    expect(result.staleTarget).toBe(true);
    expect(result.hint).toMatch(/has 1 unpushed commit\(s\) and is 2 behind origin\/main/);
    // A rebase would drop local ADR-062 --no-ff task merges and rewrite SHAs.
    expect(result.syncCommand).toMatch(
      /^git -C '.+' switch 'main' && git -C '.+' merge 'origin\/main'$/,
    );
    expect(result.syncCommand).not.toMatch(/rebase|--ff-only/);
    expect(result.hint).toContain(result.syncCommand);
    expect(result.hint).not.toMatch(/pull --rebase/);
    expect(result.hint).toMatch(new RegExp(`worktree-complete ${taskId}`));
    expect(gitAt(fx.root, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(existsSync(wt.path)).toBe(true);
  });

  it('squash-merged then upstream edits the same lines → not landed; refused on stale main', () => {
    fx = makeUpstreamFixture();
    const taskId = 'T9912779';
    const wt = createAgentWorktree(taskId, fx.root);
    identity(wt.path);
    commitFile(wt.path, 'README.md', '# task edit\n', `${taskId}: edit readme`);
    gitAt(wt.path, 'push', '-q', 'origin', `task/${taskId}`);

    gitAt(fx.dev, 'fetch', '-q', 'origin');
    gitAt(fx.dev, 'merge', '-q', '--squash', `origin/task/${taskId}`);
    gitAt(fx.dev, 'commit', '-q', '-m', 'Squash PR');
    commitFile(fx.dev, 'README.md', '# upstream rewrote it\n', 'upstream edit');
    gitAt(fx.dev, 'push', '-q', 'origin', 'main');
    const headBefore = gitAt(fx.root, 'rev-parse', 'HEAD');

    // The containment check is a false negative here (merge-tree conflicts):
    // the branch is NOT reported landed, and the stale-target guard refuses.
    const result = completeAgentWorktreeViaMerge(taskId, fx.root, { targetBranch: 'main' });

    expect(result.landedUpstream, JSON.stringify(result)).toBeUndefined();
    expect(result.merged).toBe(false);
    expect(result.staleTarget).toBe(true);
    expect(localOnlyCommits(fx.root)).toEqual([]);
    expect(gitAt(fx.root, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(gitAt(fx.root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  });

  it('zero-commit task branch → nothing to integrate, NOT labelled landed upstream', () => {
    fx = makeUpstreamFixture();
    const taskId = 'T9912780';
    const wt = createAgentWorktree(taskId, fx.root);
    const headBefore = gitAt(fx.root, 'rev-parse', 'HEAD');

    const result = completeAgentWorktreeViaMerge(taskId, fx.root, { targetBranch: 'main' });

    expect(result.nothingToIntegrate, JSON.stringify(result)).toBe(true);
    expect(result.landedUpstream).toBeUndefined();
    expect(result.merged).toBe(false);
    expect(result.hint).toMatch(/no commits beyond local 'main'/);
    expect(gitAt(fx.root, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(existsSync(wt.path)).toBe(false);
  });

  it('fetch fails (offline remote) → no hang, best-effort on the last-known origin ref', () => {
    fx = makeUpstreamFixture();
    const taskId = 'T9912781';
    agentCommitAndPush(fx.root, taskId);
    gitAt(fx.dev, 'fetch', '-q', 'origin');
    gitAt(fx.dev, 'merge', '-q', '--no-ff', `origin/task/${taskId}`, '-m', 'Merge PR');
    gitAt(fx.dev, 'push', '-q', 'origin', 'main');
    // Learn about the merge, then lose the network.
    gitAt(fx.root, 'fetch', '-q', 'origin');
    gitAt(fx.root, 'remote', 'set-url', 'origin', join(fx.root, '..', 'gone.git'));

    const a = assessUpstreamIntegration(fx.root, `task/${taskId}`, 'main');
    expect(a.fetched).toBe(true);
    expect(a.kind).toBe('landed');
  });

  it('fetch that would hang (ssh never answers) is bounded by fetchTimeoutMs', () => {
    fx = makeUpstreamFixture();
    gitAt(fx.root, 'branch', 'task/T9912782');
    const hang = join(fx.root, '..', 'hang-ssh.sh');
    writeFileSync(hang, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    vi.stubEnv('GIT_SSH_COMMAND', hang);
    gitAt(fx.root, 'remote', 'set-url', 'origin', 'ssh://git@example.invalid/x.git');

    const started = Date.now();
    const a = assessUpstreamIntegration(fx.root, 'task/T9912782', 'main', {
      fetchTimeoutMs: 1_500,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(a.fetched).toBe(true);
    expect(a.kind).toBe('nothing');
  });

  it('assessUpstreamIntegration → proceed when there is no remote', () => {
    fx = makeUpstreamFixture();
    gitAt(fx.root, 'branch', 'task/T9912777');
    gitAt(fx.root, 'remote', 'remove', 'origin');
    const a = assessUpstreamIntegration(fx.root, 'task/T9912777', 'main', { skipFetch: true });
    expect(a.kind).toBe('proceed');
    expect(a.upstreamRef).toBeNull();
  });
});
