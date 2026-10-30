/**
 * A train or integration PR with no component PR names a task only in a merge
 * commit it carries (T14164, axiom T2206 via release PR #1939). The PR links
 * to the task through that merge, crediting the merge's own diff only.
 *
 * @task T14164
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taskMergesInLanding } from '../component-pr.js';
import { checkPrTaskLinkage, linkedPrChange } from '../evidence.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

let repo: string;
let trainTip: string;
let landingMerge: string;

/** Commit `file` on a new branch off the train, then merge it with `subject`. */
function mergeIntoTrain(
  branch: string,
  file: string,
  commitSubject: string,
  mergeSubject: string,
): void {
  git(repo, ['switch', '-q', '-c', branch, 'main']);
  writeFileSync(join(repo, file), `export const x = '${branch}';\n`);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', commitSubject]);
  const tip = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['switch', '-q', 'release/v7']);
  git(repo, [
    'merge',
    '-q',
    '--no-ff',
    '-m',
    mergeSubject.replace('<sha>', tip.slice(0, 10)),
    branch,
  ]);
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'train-merge-')));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'T']);
  git(repo, ['config', 'user.email', 't@e.x']);
  writeFileSync(join(repo, 'base.ts'), 'export const base = 1;\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'init']);
  git(repo, ['switch', '-q', '-c', 'release/v7']);
  writeFileSync(join(repo, 'train-only.ts'), 'export const train = 1;\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'release: bump candidate']);
  // The #1939 shape: the merge subject names the task.
  mergeIntoTrain(
    'wip/a',
    'app.ts',
    'fix the importer',
    'merge: T2206 importer fix @<sha> into release candidate v7',
  );
  // Another task's merge on the same train.
  mergeIntoTrain(
    'wip/b',
    'other.ts',
    'T9999: other work',
    'merge: T9999 other @<sha> into release candidate v7',
  );
  // A generic merge whose second parent's subject names the task.
  mergeIntoTrain(
    'wip/c',
    'lib.ts',
    'T3000: library change',
    "Merge branch 'wip/c' into release/v7",
  );
  trainTip = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['switch', '-q', 'main']);
  git(repo, ['merge', '-q', '--no-ff', '-m', 'Release candidate v7 (#1939)', 'release/v7']);
  landingMerge = git(repo, ['rev-parse', 'HEAD']);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

const train = () => ({
  title: 'Release candidate v7',
  body: 'Train of fixes',
  headRefName: 'release/v7',
  headRefOid: trainTip,
  mergeCommitSha: landingMerge,
  changedPaths: ['app.ts', 'lib.ts', 'other.ts', 'train-only.ts'],
  changedFileCount: 4,
});

const ctx = (id: string) => ({
  task: { id, kind: 'work' as const, labels: [], files: [], acceptance: [] },
  gates: ['implemented' as const],
  criteria: [],
});

const roots = () => ({ storeRoot: repo, executionRoot: repo });

describe('linkedPrChange: a train PR links through a merge that names the task (T14164)', () => {
  it('a merge whose subject names the task links the PR, crediting only that merge', async () => {
    const linked = await linkedPrChange(1939, train(), roots(), undefined, undefined, 'T2206');
    expect(linked.ok && linked.prNumber).toBe(1939);
    expect(linked.ok && linked.pr.changedPaths).toEqual(['app.ts']);
    expect(linked.ok && checkPrTaskLinkage(linked.prNumber, linked.pr, ctx('T2206'))).toBeNull();
  });

  it("a merge whose second parent's subject names the task links it too", async () => {
    const linked = await linkedPrChange(1939, train(), roots(), undefined, undefined, 'T3000');
    expect(linked.ok && linked.pr.changedPaths).toEqual(['lib.ts']);
    expect(linked.ok && checkPrTaskLinkage(linked.prNumber, linked.pr, ctx('T3000'))).toBeNull();
  });

  it('never credits the whole train: other merges and train commits stay out', () => {
    const merged = taskMergesInLanding(repo, 'T2206', train());
    expect(merged?.merges.map((m) => m.subject)).toEqual([
      expect.stringMatching(/^merge: T2206 importer fix @[0-9a-f]{10} into release candidate v7$/),
    ]);
    expect(merged?.files).toEqual(['app.ts']);
  });

  it('a task no merge names is still refused', async () => {
    const linked = await linkedPrChange(1939, train(), roots(), undefined, undefined, 'T4242');
    expect(linked.ok && linked.pr.changedPaths).toEqual(train().changedPaths);
    expect(
      linked.ok && checkPrTaskLinkage(linked.prNumber, linked.pr, ctx('T4242'))?.reason,
    ).toMatch(/does not cite task T4242/);
  });

  it('a PR that cites the task itself keeps its own files', async () => {
    const cited = { ...train(), title: 'T2206: release candidate v7' };
    const linked = await linkedPrChange(1939, cited, roots(), undefined, undefined, 'T2206');
    expect(linked.ok && linked.pr.changedPaths).toEqual(cited.changedPaths);
  });
});
