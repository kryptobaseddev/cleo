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

  it('PR merged upstream (--no-ff) + stale local main → no local merge, main fast-forwarded', () => {
    fx = makeUpstreamFixture();
    const taskId = 'T9912773';
    const tip = agentCommitAndPush(fx.root, taskId);

    // Upstream lands the PR, then main moves on (local main goes stale).
    gitAt(fx.dev, 'fetch', '-q', 'origin');
    gitAt(fx.dev, 'merge', '-q', '--no-ff', `origin/task/${taskId}`, '-m', 'Merge PR');
    commitFile(fx.dev, 'later.ts', 'export const later = 1;\n', 'later upstream work');
    gitAt(fx.dev, 'push', '-q', 'origin', 'main');
    const localBefore = gitAt(fx.root, 'rev-parse', 'main');

    const result = completeAgentWorktreeViaMerge(taskId, fx.root, { targetBranch: 'main' });

    expect(result.merged, JSON.stringify(result)).toBe(false);
    expect(result.landedUpstream).toBe(true);
    expect(result.nothingToIntegrate).toBe(true);
    expect(result.mergeCommit).toBe('');
    expect(result.error).toBeUndefined();
    // The core assertion: no local-only commit (no `merge task/<id>`) on main.
    expect(localOnlyCommits(fx.root)).toEqual([]);
    // Clean fast-forward of the checked-out default branch to origin.
    const localAfter = gitAt(fx.root, 'rev-parse', 'main');
    expect(localAfter).not.toBe(localBefore);
    expect(localAfter).toBe(gitAt(fx.root, 'rev-parse', 'refs/remotes/origin/main'));
    expect(gitAt(fx.root, 'reflog', '-n', '5', 'main')).not.toMatch(/merge task\//);
    expect(gitAt(fx.root, 'merge-base', '--is-ancestor', tip, 'main')).toBe('');
    // Commits are safe on origin, so the clean worktree + branch are pruned.
    expect(result.worktreeRemoved).toBe(true);
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
  });

  it('dirty checkout → landed but NOT fast-forwarded; local main untouched, hint given', () => {
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
    expect(result.hint).toMatch(/merge --ff-only origin\/main/);
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

  it('assessUpstreamIntegration → proceed when there is no remote', () => {
    fx = makeUpstreamFixture();
    gitAt(fx.root, 'branch', 'task/T9912777');
    gitAt(fx.root, 'remote', 'remove', 'origin');
    const a = assessUpstreamIntegration(fx.root, 'task/T9912777', 'main', { skipFetch: true });
    expect(a.kind).toBe('proceed');
    expect(a.upstreamRef).toBeNull();
  });
});
