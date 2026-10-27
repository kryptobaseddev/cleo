/**
 * `--include-deps` integration commit (T14045): dependency branches merged
 * `--no-ff` onto the base in a temporary worktree, never the primary checkout.
 *
 * @task T14045
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDependencyIntegration } from '../include-deps.js';

let root: string;
let home: string;

function git(args: string[], cwd = root): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

/** Commit `file` on a new branch `task/<id>` cut from `from`, then return to main. */
function depBranch(id: string, file: string, from = 'main'): string {
  git(['switch', '-q', '-c', `task/${id}`, from]);
  writeFileSync(join(root, file), `${id}\n`);
  git(['add', file]);
  git(['commit', '-q', '-m', `${id} work`]);
  const sha = git(['rev-parse', 'HEAD']);
  git(['switch', '-q', 'main']);
  return sha;
}

function auditRows(): Record<string, unknown>[] {
  return readFileSync(join(root, '.cleo', 'audit', 'worktree-integration.jsonl'), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'include-deps-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'include-deps-home-')));
  vi.stubEnv('CLEO_HOME', home);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'T']);
  git(['config', 'user.email', 't@e.x']);
  writeFileSync(join(root, '.gitignore'), '.cleo/\n');
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('buildDependencyIntegration (T14045)', () => {
  it('linear dependency: the dependency commit is reachable and the primary checkout never moves', async () => {
    const head = git(['rev-parse', 'HEAD']);
    const t1 = depBranch('T1', 'one.txt');
    const result = await buildDependencyIntegration(root, 'T2', ['T1']);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    // --no-ff: a merge commit whose parents are the base and the dependency.
    expect(git(['rev-list', '--parents', '-n', '1', result.sha]).split(' ').slice(1)).toEqual([
      head,
      t1,
    ]);
    expect(git(['rev-parse', 'HEAD'])).toBe(head);
    expect(git(['branch', '--show-current'])).toBe('main');
    expect(git(['status', '--porcelain'])).toBe('');
    // The temporary integration worktree is gone.
    expect(git(['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
    // Detached: the scratch worktree created no branch.
    expect(git(['branch', '--format=%(refname:short)']).split('\n').sort()).toEqual([
      'main',
      'task/T1',
    ]);
    expect(auditRows()).toContainEqual(
      expect.objectContaining({
        action: 'include-deps',
        taskId: 'T2',
        baseRef: 'HEAD',
        baseSha: head,
        integrationSha: result.sha,
        dependencies: [{ taskId: 'T1', branch: 'task/T1', sha: t1 }],
      }),
    );
  });

  it('sibling dependencies: both branches are merged and reachable, no rewrite', async () => {
    const t1 = depBranch('T1', 'one.txt');
    const t2 = depBranch('T2', 'two.txt');
    const result = await buildDependencyIntegration(root, 'T3', ['T1', 'T2'], 'main');
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    for (const sha of [t1, t2]) {
      expect(() => git(['merge-base', '--is-ancestor', sha, result.sha])).not.toThrow();
    }
    expect(git(['show', `${result.sha}:one.txt`])).toBe('T1');
    expect(git(['show', `${result.sha}:two.txt`])).toBe('T2');
    expect(result.baseRef).toBe('main');
    expect(result.dependencies.map((d) => d.sha)).toEqual([t1, t2]);
  });

  it('a dependency with no branch is refused', async () => {
    const result = await buildDependencyIntegration(root, 'T2', ['T1']);
    expect(result).toMatchObject({ ok: false, code: 'E_INCLUDE_DEPS_MISSING' });
  });

  it('a conflicting dependency is refused and leaves no worktree or audit row', async () => {
    depBranch('T1', 'same.txt');
    depBranch('T2', 'same.txt');
    const head = git(['rev-parse', 'HEAD']);
    const result = await buildDependencyIntegration(root, 'T3', ['T1', 'T2']);
    expect(result).toMatchObject({ ok: false, code: 'E_INCLUDE_DEPS_DIVERGED' });
    expect(git(['rev-parse', 'HEAD'])).toBe(head);
    expect(git(['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
    expect(() => auditRows()).toThrow();
  });

  it('a base that does not resolve is refused', async () => {
    depBranch('T1', 'one.txt');
    expect(await buildDependencyIntegration(root, 'T2', ['T1'], 'no-such-ref')).toMatchObject({
      ok: false,
      code: 'E_WORKTREE_BASE_INVALID',
    });
  });
});
