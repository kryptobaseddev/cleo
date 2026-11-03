/**
 * A task branch that merged a newer default branch ("update branch") while
 * the local default-branch ref is older lists only its own commits' paths,
 * never what the merge brought in (T14191: a docs-only PR was warned that it
 * "owes the code gates: its work touches .github/workflows/ci.yml").
 *
 * @task T14191
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ChangeSetTask,
  deriveTaskChangeSet,
  resetTaskOwnWorkCache,
  taskOwnWorkPaths,
} from '../change-set.js';
import { taskEvidenceKindReport } from '../evidence.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function commit(cwd: string, message: string): void {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', message]);
}

let base: string;
let repo: string;

/**
 * `task/T700-readme` edits README.md. Main then changes ci.yml and is pushed;
 * the branch merges that newer main, but the local `origin/main` ref is left
 * at the older commit, as in a worktree that has not fetched since.
 */
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'own-work-')));
  const origin = join(base, 'origin.git');
  repo = join(base, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'T']);
  git(repo, ['config', 'user.email', 't@e.x']);
  writeFileSync(join(repo, 'README.md'), '# Project\n');
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
  commit(repo, 'init');
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);
  git(repo, ['remote', 'set-head', 'origin', 'main']);
  const stale = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['switch', '-q', '-c', 'task/T700-readme']);
  writeFileSync(join(repo, 'README.md'), '# Project\n\nWhat it is now.\n');
  commit(repo, 'T700: describe the current product');
  git(repo, ['switch', '-q', 'main']);
  writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'name: CI\non: push\n');
  commit(repo, 'ci: run on push');
  git(repo, ['push', '-q', 'origin', 'main']);
  git(repo, ['switch', '-q', 'task/T700-readme']);
  git(repo, ['merge', '-q', '--no-ff', '-m', "Merge branch 'main' into task/T700-readme", 'main']);
  // The worktree has not fetched since: its origin/main is the older commit.
  git(repo, ['update-ref', 'refs/remotes/origin/main', stale]);
  repo = realpathSync(repo);
  resetTaskOwnWorkCache();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const task = (extra: Partial<ChangeSetTask> = {}): ChangeSetTask => ({
  id: 'T700',
  kind: 'work',
  labels: [],
  files: undefined,
  acceptance: [],
  ...extra,
});

describe('a task branch that merged a newer main past a stale origin/main (T14191)', () => {
  it("its own work is the branch's own commits: README.md, never ci.yml", async () => {
    const work = await taskOwnWorkPaths(repo, 'T700', repo);
    expect(work).toEqual({ ok: true, paths: ['README.md'] });
  });

  it('the branch change set lists README.md alone', async () => {
    const cs = await deriveTaskChangeSet({ task: task(), storeRoot: repo, cwd: repo });
    expect(cs.source).toBe('branch');
    expect(cs.files).toEqual(['README.md']);
    expect(cs.deletedFiles).toEqual([]);
  });

  it('a documentation task is not told it owes the code gates', async () => {
    const report = await taskEvidenceKindReport(
      { ...task({ files: ['README.md'] }), verification: null },
      repo,
      ['README.md'],
      repo,
    );
    expect(report).toEqual({ kind: 'documentation' });
  });

  it("the branch's own code change is still found", async () => {
    git(repo, ['switch', '-q', 'task/T700-readme']);
    writeFileSync(join(repo, 'tool.ts'), 'export const tool = 1;\n');
    commit(repo, 'T700: add a tool');
    resetTaskOwnWorkCache();
    const work = await taskOwnWorkPaths(repo, 'T700', repo);
    expect(work.ok && [...work.paths].sort()).toEqual(['README.md', 'tool.ts']);
  });
});
