/**
 * A merge of a branch cut from older history credits only its first-parent
 * diff (T14166). `diff-tree -m --first-parent` listed the diff against EVERY
 * parent (--first-parent limits a revision walk, not diff-tree), so each
 * caller also reported what the base gained after the branch was cut.
 *
 * @task T14166
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ChangeSetTask,
  deriveTaskChangeSet,
  taskCarryScope,
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
let merge: string;

/**
 * `docs` is cut from the root and adds notes.md. Main then adds main.ts and
 * deletes gone.ts, and merges `docs` with a subject citing T600. The merge's
 * first-parent diff is notes.md alone; against `docs` it also holds main.ts
 * and the deletion of gone.ts.
 */
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'first-parent-')));
  const origin = join(base, 'origin.git');
  repo = join(base, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'T']);
  git(repo, ['config', 'user.email', 't@e.x']);
  writeFileSync(join(repo, 'base.ts'), 'export const base = 1;\n');
  writeFileSync(join(repo, 'gone.ts'), 'export const gone = 1;\n');
  commit(repo, 'init');
  git(repo, ['switch', '-q', '-c', 'docs']);
  writeFileSync(join(repo, 'notes.md'), '# Notes\n');
  commit(repo, 'docs: notes');
  git(repo, ['switch', '-q', 'main']);
  writeFileSync(join(repo, 'main.ts'), 'export const main = 1;\n');
  commit(repo, 'main: later work');
  unlinkSync(join(repo, 'gone.ts'));
  commit(repo, 'main: drop gone');
  git(repo, ['merge', '-q', '--no-ff', '-m', 'T600: merge the notes', 'docs']);
  merge = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);
  git(repo, ['remote', 'set-head', 'origin', 'main']);
  repo = realpathSync(repo);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function task(id: string, extra: Partial<ChangeSetTask> = {}): ChangeSetTask {
  return { id, kind: 'work', labels: [], files: undefined, acceptance: [], ...extra };
}

describe('a merge of a branch cut from older history (T14166)', () => {
  it('the PR change set lists only the merge first-parent changes', async () => {
    const cs = await deriveTaskChangeSet(
      { task: task('T600'), storeRoot: repo, cwd: repo },
      {
        listMergedPrs: async () => ({
          ok: true,
          prs: [{ number: 7, title: 'T600: notes', body: '', headRefName: 'docs' }],
        }),
        viewPr: async (number) => ({
          number,
          title: '',
          headRefName: '',
          baseRefName: 'main',
          state: 'MERGED',
          mergedAt: '2026-11-01T00:00:00Z',
          headRefOid: null,
          mergeCommitSha: null,
        }),
        findPrByHead: async () => null,
        resolvePr: async (prNumber) => ({
          ok: true,
          prNumber,
          mergeCommitSha: merge,
          mergedAt: '2026-11-01T00:00:00Z',
          successCount: 1,
          totalChecks: 1,
          cacheHit: false,
          title: '',
          body: '',
          headRefName: '',
          changedPaths: ['notes.md'],
          changedFileCount: 1,
        }),
        listTaskDocs: async () => [],
        listTaskDecisions: async () => [],
        env: {},
      },
    );
    expect(cs.files).toEqual(['notes.md']);
    expect(cs.deletedFiles).toEqual([]);
  });

  it('the carry scope narrows the carrier to the merge first-parent files', () => {
    const target = {
      executionRoot: repo,
      mergeCommitSha: merge,
      files: ['main.ts', 'notes.md'],
      deletedFiles: ['gone.ts'],
    };
    expect(taskCarryScope(target, task('T600'), [merge])).toEqual({
      ...target,
      files: ['notes.md'],
      deletedFiles: [],
    });
  });

  it("the task's own work holds only the merge first-parent paths", async () => {
    expect(
      await taskOwnWorkPaths(repo, 'T600', repo, { listMergedPrHeads: async () => [] }),
    ).toEqual({ ok: true, paths: ['notes.md'] });
  });

  it('a commit: atom naming the merge reads only its first-parent paths', async () => {
    const verification: ChangeSetTask['verification'] = {
      passed: false,
      round: 1,
      gates: { implemented: true },
      failureLog: [],
      lastAgent: null,
      lastUpdated: null,
      evidence: {
        implemented: {
          atoms: [{ kind: 'commit', sha: merge, shortSha: merge.slice(0, 9) }],
          capturedAt: '2026-11-01T00:00:00Z',
          capturedBy: 'test',
        },
      },
    };
    // T601 is cited nowhere, so only the commit: atom supplies paths.
    expect(
      await taskEvidenceKindReport(task('T601', { kind: 'research', verification }), repo),
    ).toEqual({ kind: 'research' });
  });
});
