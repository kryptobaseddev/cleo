/**
 * Change-set derivation for `cleo done` (T12624).
 *
 * Every fixture is a real git repository with a real `origin`, because the
 * behaviours under test ARE git behaviours: merge-base against origin's
 * default branch, a squash commit's name-status, a worktree the task owns, a
 * declared git root among sibling checkouts. Only `gh` and the CLEO stores are
 * injected — `gh` cannot run offline, and the store readers are not what this
 * module decides.
 *
 * @task T12624
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceAtom } from '@cleocode/contracts';
import { validateEvidenceForGate } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrAtomResolution } from '../../release/pr-evidence.js';
import {
  type ChangeSetDeps,
  type ChangeSetTask,
  deriveTaskChangeSet,
  type MergedPrSummary,
  type PrDetails,
} from '../change-set.js';
import { parseEvidence, validateAtom } from '../evidence.js';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
}

/** A bare origin plus a clone whose `origin/HEAD` points at `main`. */
function repoWithOrigin(base: string, name: string): string {
  const origin = join(base, `${name}-origin.git`);
  const work = join(base, name);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  mkdirSync(work, { recursive: true });
  git(work, ['init', '-q', '-b', 'main']);
  git(work, ['config', 'user.name', 'Test']);
  git(work, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(work, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(work, 'old.ts'), 'export const old = 1;\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-q', '-m', 'init']);
  git(work, ['remote', 'add', 'origin', origin]);
  git(work, ['push', '-q', '-u', 'origin', 'main']);
  git(work, ['remote', 'set-head', 'origin', 'main']);
  return realpathSync(work);
}

/** Modify a.ts, delete old.ts, add new.ts and commit on the current branch. */
function commitTaskWork(dir: string, taskId: string): string {
  writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
  unlinkSync(join(dir, 'old.ts'));
  writeFileSync(join(dir, 'new.ts'), 'export const n = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', `${taskId}: work`]);
  return git(dir, ['rev-parse', 'HEAD']);
}

function task(id: string, extra: Partial<ChangeSetTask> = {}): ChangeSetTask {
  return { id, kind: 'work', labels: [], files: undefined, acceptance: [], ...extra };
}

const noPrs: ChangeSetDeps['listMergedPrs'] = async () => ({ ok: true, prs: [] });

/** gh pr view stand-in: every PR merged into `main` unless overridden. */
function details(number: number, extra: Partial<PrDetails> = {}): PrDetails {
  return {
    number,
    title: '',
    headRefName: '',
    baseRefName: 'main',
    state: 'MERGED',
    mergedAt: '2026-09-28T00:00:00Z',
    headRefOid: null,
    mergeCommitSha: null,
    ...extra,
  };
}
const onMain: Pick<ChangeSetDeps, 'viewPr' | 'findPrByHead'> = {
  viewPr: async (n) => details(n),
  findPrByHead: async () => null,
};
const noDocs: Pick<ChangeSetDeps, 'listTaskDocs' | 'listTaskDecisions'> = {
  listTaskDocs: async () => [],
  listTaskDecisions: async () => [],
};

function prResolution(
  prNumber: number,
  mergeCommitSha: string,
  changedPaths: string[],
): PrAtomResolution {
  return {
    ok: true,
    prNumber,
    mergeCommitSha,
    mergedAt: '2026-09-28T00:00:00Z',
    successCount: 1,
    totalChecks: 1,
    cacheHit: false,
    title: '',
    body: '',
    headRefName: '',
    changedPaths,
    changedFileCount: changedPaths.length,
  };
}

const TRACKED_ENV = ['CLEO_EVIDENCE_GIT_ROOT', 'GIT_WORK_TREE', 'GIT_DIR'] as const;
const saved: Record<string, string | undefined> = {};
let base: string;

beforeEach(() => {
  for (const key of TRACKED_ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  base = realpathSync(mkdtempSync(join(tmpdir(), 'change-set-')));
});

afterEach(() => {
  for (const key of TRACKED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(base, { recursive: true, force: true });
});

describe('unmerged task branch (AC2)', () => {
  it('yields commit:HEAD plus the merge-base diff, with the deleted file excluded', async () => {
    const repo = repoWithOrigin(base, 'repo');
    git(repo, ['switch', '-q', '-c', 'task/T900']);
    const head = commitTaskWork(repo, 'T900');

    const cs = await deriveTaskChangeSet(
      { task: task('T900'), storeRoot: repo, cwd: repo },
      { listMergedPrs: noPrs, ...noDocs, env: {} },
    );

    expect(cs.source).toBe('branch');
    expect(cs.rootSource).toBe('store');
    expect(cs.baseRef).toBe('origin/main');
    expect(cs.commitSha).toBe(head);
    expect(cs.files).toEqual(['a.ts', 'new.ts']);
    expect(cs.deletedFiles).toEqual(['old.ts']);
    expect(cs.implementedEvidence).toBe(`commit:${head};files:a.ts,new.ts`);
    expect(cs.blockers).toEqual([]);
  });

  it('diffs against origin/<default>, not a stale local main', async () => {
    const repo = repoWithOrigin(base, 'repo');
    git(repo, ['switch', '-q', '-c', 'task/T901']);
    commitTaskWork(repo, 'T901');
    // Local main moves ahead of origin/main to the task commit: a local-main
    // merge-base would report an EMPTY diff.
    git(repo, ['branch', '-f', 'main', 'task/T901']);

    const cs = await deriveTaskChangeSet(
      { task: task('T901'), storeRoot: repo, cwd: repo },
      { listMergedPrs: noPrs, ...noDocs, env: {} },
    );
    expect(cs.files).toEqual(['a.ts', 'new.ts']);
  });

  it('reports a dirty tree as a blocker, because evidence must describe a commit', async () => {
    const repo = repoWithOrigin(base, 'repo');
    git(repo, ['switch', '-q', '-c', 'task/T902']);
    commitTaskWork(repo, 'T902');
    writeFileSync(join(repo, 'a.ts'), 'export const a = 3;\n');

    const cs = await deriveTaskChangeSet(
      { task: task('T902'), storeRoot: repo, cwd: repo },
      { listMergedPrs: noPrs, ...noDocs, env: {} },
    );
    expect(cs.blockers.map((b) => b.code)).toEqual(['dirty-tree']);
    expect(cs.blockers[0]?.next.command).toContain('commit');
  });

  it('planned atoms pass the existing files: validator (no second validation path)', async () => {
    const repo = repoWithOrigin(base, 'repo');
    git(repo, ['switch', '-q', '-c', 'task/T903']);
    commitTaskWork(repo, 'T903');
    const cs = await deriveTaskChangeSet(
      { task: task('T903'), storeRoot: repo, cwd: repo },
      { listMergedPrs: noPrs, ...noDocs, env: {} },
    );
    const parsed = parseEvidence(cs.implementedEvidence ?? '');
    const files = parsed.atoms.find((a) => a.kind === 'files');
    expect(files).toBeDefined();
    const result = await validateAtom(files!, repo);
    expect(result.ok).toBe(true);
  });
});

describe('worktrees and declared git roots (AC4)', () => {
  it("from the main checkout, derives from the task's registered worktree", async () => {
    const repo = repoWithOrigin(base, 'repo');
    const wt = join(base, 'wt-T904');
    git(repo, ['worktree', 'add', '-q', '-b', 'task/T904', wt]);
    const head = commitTaskWork(wt, 'T904');

    const cs = await deriveTaskChangeSet(
      { task: task('T904'), storeRoot: repo, cwd: repo },
      { listMergedPrs: noPrs, ...noDocs, env: {} },
    );
    expect(cs.rootSource).toBe('task-worktree');
    expect(cs.executionRoot).toBe(realpathSync(wt));
    expect(cs.commitSha).toBe(head);
    expect(cs.files).toEqual(['a.ts', 'new.ts']);
  });

  it('from inside a worktree of the project, uses that worktree', async () => {
    const repo = repoWithOrigin(base, 'repo');
    const wt = join(base, 'wt-T905');
    git(repo, ['worktree', 'add', '-q', '-b', 'task/T905', wt]);
    commitTaskWork(wt, 'T905');

    const cs = await deriveTaskChangeSet(
      { task: task('T905'), storeRoot: repo, cwd: wt },
      { listMergedPrs: noPrs, ...noDocs, env: {} },
    );
    expect(cs.rootSource).toBe('invocation-worktree');
    expect(cs.source).toBe('branch');
  });

  it('a declared evidence.gitRoot outranks every inference in a multi-repo root', async () => {
    const store = join(base, 'store');
    mkdirSync(join(store, '.cleo'), { recursive: true });
    const appA = repoWithOrigin(store, 'app-a');
    const appB = repoWithOrigin(store, 'app-b');
    for (const app of [appA, appB]) {
      git(app, ['switch', '-q', '-c', 'task/T906']);
    }
    const headB = commitTaskWork(appB, 'T906');

    const undeclared = await deriveTaskChangeSet(
      { task: task('T906'), storeRoot: store, cwd: store },
      { listMergedPrs: noPrs, ...noDocs, env: {} },
    );
    expect(undeclared.source).toBe('none');

    writeFileSync(
      join(store, '.cleo', 'project-context.json'),
      JSON.stringify({ evidence: { gitRoot: 'app-b' } }),
    );
    const declared = await deriveTaskChangeSet(
      { task: task('T906'), storeRoot: store, cwd: appA },
      { listMergedPrs: noPrs, ...noDocs, env: {} },
    );
    expect(declared.rootSource).toBe('declared');
    expect(declared.executionRoot).toBe(appB);
    expect(declared.commitSha).toBe(headB);
  });
});

describe('merged PR (AC1, AC5)', () => {
  /** Squash-merge task/<id> into main and push; returns the squash commit. */
  function squashMerge(repo: string, taskId: string): string {
    git(repo, ['switch', '-q', '-c', `task/${taskId}`]);
    commitTaskWork(repo, taskId);
    git(repo, ['switch', '-q', 'main']);
    git(repo, ['merge', '-q', '--squash', `task/${taskId}`]);
    git(repo, ['commit', '-q', '-m', `${taskId}: squash (#42)`]);
    git(repo, ['push', '-q', 'origin', 'main']);
    return git(repo, ['rev-parse', 'HEAD']);
  }

  const pr = (number: number, title: string, headRefName = ''): MergedPrSummary => ({
    number,
    title,
    body: '',
    headRefName,
  });

  it('yields pr:<n> plus files read from the squash commit, deleted paths in the receipt', async () => {
    const repo = repoWithOrigin(base, 'repo');
    const squash = squashMerge(repo, 'T910');

    const cs = await deriveTaskChangeSet(
      { task: task('T910'), storeRoot: repo, cwd: repo },
      {
        // #43 cites T9100, which must NOT match T910.
        listMergedPrs: async () => ({
          ok: true,
          prs: [pr(42, 'T910: fix'), pr(43, 'T9100: other')],
        }),
        ...onMain,
        resolvePr: async (n) => prResolution(n, squash, ['a.ts', 'new.ts', 'old.ts']),
        ...noDocs,
        env: {},
      },
    );

    expect(cs.source).toBe('pr');
    expect(cs.candidates.map((c) => c.prNumber)).toEqual([42]);
    expect(cs.mergeCommitSha).toBe(squash);
    expect(cs.files).toEqual(['a.ts', 'new.ts']);
    expect(cs.deletedFiles).toEqual(['old.ts']);
    expect(cs.implementedEvidence).toBe('pr:42;files:a.ts,new.ts');
    expect(cs.blockers).toEqual([]);
  });

  it('several citing PRs that task.files cannot narrow yield a blocker listing them', async () => {
    const repo = repoWithOrigin(base, 'repo');
    const squash = squashMerge(repo, 'T911');
    const cs = await deriveTaskChangeSet(
      { task: task('T911', { files: ['a.ts'] }), storeRoot: repo, cwd: repo },
      {
        listMergedPrs: async () => ({
          ok: true,
          prs: [pr(44, 'follow-up T911', 'feat/x'), pr(42, 'T911: fix', 'hotfix/y')],
        }),
        ...onMain,
        resolvePr: async (n) => prResolution(n, squash, ['a.ts']),
        ...noDocs,
        env: {},
      },
    );
    expect(cs.implementedEvidence).toBeNull();
    expect(cs.blockers).toHaveLength(1);
    expect(cs.blockers[0]?.code).toBe('pr-ambiguous');
    expect(cs.blockers[0]?.message).toContain('#42, #44');
    expect(cs.blockers[0]?.next.command).toBe('cleo done T911 --plan --pr 42');
  });

  it("among several citing PRs, the one merged from the task's own branch wins", async () => {
    const repo = repoWithOrigin(base, 'repo');
    const squash = squashMerge(repo, 'T914');
    const cs = await deriveTaskChangeSet(
      { task: task('T914'), storeRoot: repo, cwd: repo },
      {
        listMergedPrs: async () => ({
          ok: true,
          prs: [
            pr(40, 'integration batch: T914, T915', 'integration/x'),
            pr(42, 'fix', 'task/T914'),
          ],
        }),
        ...onMain,
        resolvePr: async (n) => prResolution(n, squash, ['a.ts', 'new.ts', 'old.ts']),
        ...noDocs,
        env: {},
      },
    );
    expect(cs.prNumber).toBe(42);
    expect(cs.blockers).toEqual([]);
  });

  it('declared task.files narrow several candidates to the one that touched them', async () => {
    const repo = repoWithOrigin(base, 'repo');
    const squash = squashMerge(repo, 'T912');
    const cs = await deriveTaskChangeSet(
      { task: task('T912', { files: ['a.ts'] }), storeRoot: repo, cwd: repo },
      {
        listMergedPrs: async () => ({ ok: true, prs: [pr(42, 'T912'), pr(44, 'T912 docs')] }),
        ...onMain,
        resolvePr: async (n) =>
          prResolution(n, squash, n === 42 ? ['a.ts', 'new.ts', 'old.ts'] : ['README.md']),
        ...noDocs,
        env: {},
      },
    );
    expect(cs.prNumber).toBe(42);
    expect(cs.blockers).toEqual([]);
  });

  it('a merge commit absent locally is a blocker, never a working-tree read', async () => {
    const repo = repoWithOrigin(base, 'repo');
    const cs = await deriveTaskChangeSet(
      { task: task('T913'), storeRoot: repo, cwd: repo },
      {
        listMergedPrs: async () => ({ ok: true, prs: [pr(42, 'T913')] }),
        ...onMain,
        resolvePr: async (n) => prResolution(n, 'f'.repeat(40), ['a.ts']),
        ...noDocs,
        env: {},
      },
    );
    expect(cs.blockers.map((b) => b.code)).toEqual(['merge-commit-missing']);
  });
});

describe('stacked and reverted PRs', () => {
  /**
   * task/T940-base off main; task/T940 off the base with the work; the task PR
   * merges into the BASE branch (merge commit S), not into main.
   */
  function stackedFixture(repo: string): { stackedMerge: string; baseTip: string } {
    git(repo, ['switch', '-q', '-c', 'task/T940-base']);
    writeFileSync(join(repo, 'base.ts'), 'export const b = 1;\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base work']);
    git(repo, ['switch', '-q', '-c', 'task/T940']);
    commitTaskWork(repo, 'T940');
    git(repo, ['switch', '-q', 'task/T940-base']);
    git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge #42 T940 into base', 'task/T940']);
    return {
      stackedMerge: git(repo, ['rev-parse', 'HEAD']),
      baseTip: git(repo, ['rev-parse', 'HEAD']),
    };
  }

  const citing: ChangeSetDeps['listMergedPrs'] = async () => ({
    ok: true,
    prs: [{ number: 42, title: 'T940: work', body: '', headRefName: 'task/T940' }],
  });

  it('a PR merged into an unmerged base branch is pr-stacked, naming the base PR', async () => {
    const repo = repoWithOrigin(base, 'repo');
    const { stackedMerge } = stackedFixture(repo);
    const cs = await deriveTaskChangeSet(
      { task: task('T940'), storeRoot: repo, cwd: repo },
      {
        listMergedPrs: citing,
        viewPr: async (n) =>
          details(n, { baseRefName: 'task/T940-base', mergeCommitSha: stackedMerge }),
        findPrByHead: async () =>
          details(41, { state: 'OPEN', mergedAt: null, headRefName: 'task/T940-base' }),
        resolvePr: async () => {
          throw new Error('a stacked PR must not be sent to the pr: validator');
        },
        ...noDocs,
        env: {},
      },
    );
    expect(cs.implementedEvidence).toBeNull();
    expect(cs.blockers.map((b) => b.code)).toEqual(['pr-stacked']);
    expect(cs.blockers[0]?.message).toContain('task/T940-base');
    expect(cs.blockers[0]?.message).toContain('#41');
    expect(cs.blockers[0]?.next.command).toBe('cleo done T940 --plan');
    expect(cs.blockers[0]?.next.why).toContain('#41');
  });

  it('once the base PR merged to main and contains the stacked commits, attributes to its merge commit', async () => {
    const repo = repoWithOrigin(base, 'repo');
    const { stackedMerge, baseTip } = stackedFixture(repo);
    git(repo, ['switch', '-q', 'main']);
    git(repo, ['merge', '-q', '--squash', 'task/T940-base']);
    git(repo, ['commit', '-q', '-m', 'base (#41)']);
    const baseMerge = git(repo, ['rev-parse', 'HEAD']);

    const cs = await deriveTaskChangeSet(
      { task: task('T940'), storeRoot: repo, cwd: repo },
      {
        listMergedPrs: citing,
        viewPr: async (n) =>
          details(n, { baseRefName: 'task/T940-base', mergeCommitSha: stackedMerge }),
        findPrByHead: async () =>
          details(41, {
            headRefName: 'task/T940-base',
            headRefOid: baseTip,
            mergeCommitSha: baseMerge,
          }),
        resolvePr: async () => {
          throw new Error('attribution goes through commit:, not the stacked pr:');
        },
        ...noDocs,
        env: {},
      },
    );
    expect(cs.blockers).toEqual([]);
    expect(cs.source).toBe('pr');
    expect(cs.stackedOn).toEqual({ baseRef: 'task/T940-base', basePrNumber: 41 });
    expect(cs.mergeCommitSha).toBe(baseMerge);
    expect(cs.files).toEqual(['a.ts', 'new.ts']);
    expect(cs.deletedFiles).toEqual(['old.ts']);
    expect(cs.implementedEvidence).toBe(`commit:${baseMerge};files:a.ts,new.ts`);
    const filesAtom = parseEvidence(cs.implementedEvidence ?? '').atoms.find(
      (a) => a.kind === 'files',
    );
    expect((await validateAtom(filesAtom!, repo, undefined, baseMerge)).ok).toBe(true);
  });

  it('a base PR merged to main that does NOT contain the stacked commits stays pr-stacked', async () => {
    const repo = repoWithOrigin(base, 'repo');
    const { stackedMerge } = stackedFixture(repo);
    const mainTip = git(repo, ['rev-parse', 'main']);
    const cs = await deriveTaskChangeSet(
      { task: task('T940'), storeRoot: repo, cwd: repo },
      {
        listMergedPrs: citing,
        viewPr: async (n) =>
          details(n, { baseRefName: 'task/T940-base', mergeCommitSha: stackedMerge }),
        findPrByHead: async () =>
          details(41, {
            headRefName: 'task/T940-base',
            headRefOid: mainTip,
            mergeCommitSha: mainTip,
          }),
        resolvePr: async () => {
          throw new Error('unreachable');
        },
        ...noDocs,
        env: {},
      },
    );
    expect(cs.blockers.map((b) => b.code)).toEqual(['pr-stacked']);
    expect(cs.blockers[0]?.next.command).toBe('cleo done T940 --plan --pr 41');
  });

  it('a PR the pr: validator refuses falls back to the task branch, keeping the refusal as a warning', async () => {
    const repo = repoWithOrigin(base, 'repo');
    git(repo, ['switch', '-q', '-c', 'task/T960']);
    const head = commitTaskWork(repo, 'T960');
    const cs = await deriveTaskChangeSet(
      { task: task('T960'), storeRoot: repo, cwd: repo },
      {
        listMergedPrs: async () => ({
          ok: true,
          prs: [{ number: 42, title: 'T960', body: '', headRefName: 'task/T960' }],
        }),
        ...onMain,
        resolvePr: async () => ({
          ok: false,
          reason: 'required gates were not found on this PR',
          codeName: 'E_EVIDENCE_TESTS_FAILED',
        }),
        ...noDocs,
        env: {},
      },
    );
    expect(cs.source).toBe('branch');
    expect(cs.implementedEvidence).toBe(`commit:${head};files:a.ts,new.ts`);
    expect(cs.blockers).toEqual([]);
    expect(cs.warnings.join(' ')).toContain('PR #42 cannot serve as evidence');
  });

  it('a later merged Revert PR that cites the task blocks with pr-reverted', async () => {
    const repo = repoWithOrigin(base, 'repo');
    const cs = await deriveTaskChangeSet(
      { task: task('T950'), storeRoot: repo, cwd: repo },
      {
        listMergedPrs: async () => ({
          ok: true,
          prs: [
            { number: 42, title: 'fix(T950): thing', body: '', headRefName: 'task/T950' },
            {
              number: 45,
              title: 'Revert "fix(T950): thing"',
              body: 'Reverts kryptobaseddev/cleo#42',
              headRefName: 'revert-42-task/T950',
            },
          ],
        }),
        ...onMain,
        resolvePr: async () => {
          throw new Error('a reverted PR must not be attributed');
        },
        ...noDocs,
        env: {},
      },
    );
    expect(cs.implementedEvidence).toBeNull();
    expect(cs.candidates.map((c) => c.prNumber)).toEqual([42]);
    expect(cs.blockers.map((b) => b.code)).toEqual(['pr-reverted']);
    expect(cs.blockers[0]?.message).toContain('#45');
  });
});

describe('research task with attached docs (AC3)', () => {
  function seedBlob(store: string, content: string): string {
    const sha = createHash('sha256').update(content).digest('hex');
    mkdirSync(join(store, '.cleo', 'blobs', 'blobs'), { recursive: true });
    writeFileSync(join(store, '.cleo', 'blobs', 'blobs', sha), content);
    return sha;
  }

  it('yields decision + files for the doc blob + note, and it satisfies implemented without a commit', async () => {
    const store = repoWithOrigin(base, 'repo');
    const sha = seedBlob(store, '# findings\n');
    const cs = await deriveTaskChangeSet(
      { task: task('T920', { kind: 'research' }), storeRoot: store, cwd: store },
      {
        listMergedPrs: noPrs,
        listTaskDocs: async () => [{ id: 'att-1', slug: 'my-findings', sha256: sha }],
        listTaskDecisions: async () => ['D900'],
        env: {},
      },
    );
    expect(cs.source).toBe('docs');
    expect(cs.files).toEqual([`.cleo/blobs/blobs/${sha}`]);
    expect(cs.implementedEvidence).toBe(
      `decision:D900;files:.cleo/blobs/blobs/${sha};note:Deliverable: my-findings`,
    );
    const kinds = parseEvidence(cs.implementedEvidence ?? '').atoms.map((a) => ({ kind: a.kind }));
    expect(validateEvidenceForGate('implemented', kinds).ok).toBe(true);
    const filesAtom = parseEvidence(cs.implementedEvidence ?? '').atoms.find(
      (a) => a.kind === 'files',
    );
    const validated = await validateAtom(filesAtom!, store);
    expect(validated.ok).toBe(true);
    expect((validated as { atom: EvidenceAtom }).atom.kind).toBe('files');
  });

  it('without a linked decision, files+note would be refused, so it is a named blocker', async () => {
    const store = repoWithOrigin(base, 'repo');
    const sha = seedBlob(store, '# findings\n');
    const cs = await deriveTaskChangeSet(
      { task: task('T921', { kind: 'research' }), storeRoot: store, cwd: store },
      {
        listMergedPrs: noPrs,
        listTaskDocs: async () => [{ id: 'att-1', slug: null, sha256: sha }],
        listTaskDecisions: async () => [],
        env: {},
      },
    );
    expect(cs.blockers.map((b) => b.code)).toEqual(['decision-missing']);
    const kinds = parseEvidence(cs.implementedEvidence ?? '').atoms.map((a) => ({ kind: a.kind }));
    expect(validateEvidenceForGate('implemented', kinds).ok).toBe(false);
  });
});

describe('nothing found', () => {
  it('returns source none with one no-change-set next step', async () => {
    const repo = repoWithOrigin(base, 'repo');
    const cs = await deriveTaskChangeSet(
      { task: task('T930'), storeRoot: repo, cwd: repo },
      { listMergedPrs: noPrs, ...noDocs, env: {} },
    );
    expect(cs.source).toBe('none');
    expect(cs.blockers.map((b) => b.code)).toEqual(['no-change-set']);
    expect(cs.blockers[0]?.next.command).toBe('git switch -c task/T930');
  });
});
