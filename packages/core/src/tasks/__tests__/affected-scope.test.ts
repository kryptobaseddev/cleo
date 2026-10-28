/**
 * The one rule for when an affected-scope `testsPassed` stops counting
 * (owner decision D11150): before merge only. Shared by `cleo done` planning
 * and `cleo complete`.
 *
 * @task T12656
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceAtom, Task, TaskChangeSet } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import {
  isScopedOnly,
  mergeStateOfChangeSet,
  scopedRunCarriedAcrossMerge,
  scopedRunStandsAfterRedCi,
  scopedRunSupersededReason,
  taskChangeMergeState,
  testRunTreeMismatchReason,
  testsPassedSupersededReason,
} from '../affected-scope.js';
import { type ChangeSetDeps, hasPatchEquivalent, isLandedOnOriginDefault } from '../change-set.js';

const affected: EvidenceAtom = {
  kind: 'tool',
  tool: 'test-affected',
  exitCode: 0,
  scope: 'affected',
  affectedPackages: ['@x/a'],
};
const fullTest: EvidenceAtom = { kind: 'tool', tool: 'test', exitCode: 0 };

function task(tests: EvidenceAtom[], implemented: EvidenceAtom[] = []): Task {
  const now = '2026-09-28T00:00:00Z';
  return {
    id: 'T9001',
    title: 'affected-scope fixture',
    description: 'affected-scope fixture',
    status: 'active',
    priority: 'medium',
    createdAt: now,
    verification: {
      passed: true,
      round: 1,
      gates: { implemented: true, testsPassed: true },
      lastAgent: null,
      lastUpdated: now,
      failureLog: [],
      evidence: {
        testsPassed: { atoms: tests, capturedAt: now, capturedBy: 'test' },
        ...(implemented.length > 0
          ? { implemented: { atoms: implemented, capturedAt: now, capturedBy: 'test' } }
          : {}),
      },
    },
  } as Task;
}

describe('scopedRunSupersededReason', () => {
  it('an affected-only result stands before merge and not after', () => {
    expect(scopedRunSupersededReason([affected], 'unmerged')).toBeNull();
    expect(scopedRunSupersededReason([affected], 'merged')).toMatch(/ci:<pr>.*tool:test/);
  });

  it('appends the evidence.ciSatisfies remedy after merge when one is given (T13096)', () => {
    const remedy = 'Add to .cleo/project-context.json: "evidence": {"ciSatisfies":true}';
    expect(scopedRunSupersededReason([affected], 'merged', undefined, undefined, remedy)).toMatch(
      /tool:test\)\. Add to \.cleo\/project-context\.json: "evidence"/,
    );
    // A ciSatisfies project (no remedy) keeps the CI-first message unchanged.
    expect(scopedRunSupersededReason([affected], 'merged', undefined, undefined, null)).toBe(
      scopedRunSupersededReason([affected], 'merged'),
    );
  });

  it('fails closed when the merge state is unknown', () => {
    expect(scopedRunSupersededReason([affected], 'unknown')).toMatch(
      /before merge only.*gh unreachable.*gh auth status.*retry, or record tool:test/,
    );
  });

  it('a full tool:test or ci: result keeps testsPassed standing after merge', () => {
    expect(scopedRunSupersededReason([affected, fullTest], 'merged')).toBeNull();
    expect(isScopedOnly([fullTest])).toBe(false);
    expect(isScopedOnly([])).toBe(false);
  });

  it('a merged-PR change set is merged; a failed PR lookup is unknown', () => {
    expect(mergeStateOfChangeSet({ source: 'pr' })).toBe('merged');
    expect(mergeStateOfChangeSet({ source: 'branch', prDiscoveryFailed: true })).toBe('unknown');
    expect(mergeStateOfChangeSet({ source: 'branch' })).toBe('unmerged');
    // What the PR lookup found wins over `source` (T12656 review HIGH).
    expect(mergeStateOfChangeSet({ source: 'branch', mergeState: 'merged' })).toBe('merged');
  });
});

describe('test-runs are scoped too (T12959 review)', () => {
  const testRun: Extract<EvidenceAtom, { kind: 'test-run' }> = {
    kind: 'test-run',
    path: 'r.json',
    sha256: 'c'.repeat(64),
    passCount: 1,
    failCount: 0,
    skipCount: 0,
  };
  it('a targeted test-run stops standing after merge, like an affected run', () => {
    expect(isScopedOnly([testRun])).toBe(true);
    expect(scopedRunSupersededReason([testRun], 'unmerged')).toBeNull();
    expect(scopedRunSupersededReason([testRun], 'merged')).toMatch(/scoped run.*ci:<pr>/);
    expect(scopedRunSupersededReason([testRun, fullTest], 'merged')).toBeNull();
  });

  it('a moved tree under a test-run is not judged while a full tool:test stands', async () => {
    const bound: EvidenceAtom = { ...testRun, treeHash: '1'.repeat(40) };
    expect(testRunTreeMismatchReason([bound], '2'.repeat(40))).toMatch(/no longer describes/);
    expect(testRunTreeMismatchReason([bound, fullTest], '2'.repeat(40))).toBeNull();
    expect(
      await testsPassedSupersededReason([bound], {
        mergeState: () => 'unmerged',
        currentTree: () => '2'.repeat(40),
      }),
    ).toMatch(/no longer describes/);
  });
});

describe('taskChangeMergeState judges the LATEST implementation (T12960 review)', () => {
  const pr = (prNumber: number, mergedAt: string): EvidenceAtom => ({
    kind: 'pr',
    prNumber,
    mergeCommitSha: String(prNumber).padStart(40, '0'),
    mergedAt,
    successCount: 1,
    totalChecks: 1,
  });
  const commit = (sha: string): EvidenceAtom => ({
    kind: 'commit',
    sha,
    shortSha: sha.slice(0, 7),
  });
  const B = 'b'.repeat(40);
  const noDerive: ChangeSetDeps = {
    listMergedPrs: async () => {
      throw new Error('must not derive the change set');
    },
    viewPr: async () => null,
    listPrsForCommit: async () => [],
  };
  /** A derived change set: PR #10 cites the task and merged as `merge`. */
  const derivedPr10 = (over: Partial<TaskChangeSet> = {}): TaskChangeSet => ({
    source: 'pr',
    executionRoot: '/repo',
    rootSource: 'store',
    prNumber: 10,
    mergeCommitSha: 'c'.repeat(40),
    mergeState: 'merged',
    files: ['src/a.ts'],
    deletedFiles: [],
    docs: [],
    decisions: [],
    candidates: [],
    implementedEvidence: 'pr:10;files:src/a.ts',
    blockers: [],
    warnings: [],
    ...over,
  });
  it('new work built on top of an earlier merged PR is unmerged, whatever that PR was', async () => {
    const merge42 = String(42).padStart(40, '0');
    const t = task([affected], [pr(42, '2026-09-01T00:00:00Z'), commit(B)]);
    const info = await taskChangeMergeState(t, '/nonexistent', {
      changeSet: noDerive,
      derived: derivedPr10({ prNumber: 42, mergeCommitSha: merge42 }),
      executionRoot: '/repo',
      isLanded: () => false,
      // B descends from #42's merge: it came after that PR.
      contains: (_r, ancestor, descendant) => ancestor === merge42 && descendant === B,
    });
    expect(info).toMatchObject({ state: 'unmerged', prRef: null });
  });

  it('picks the newest recorded PR that carries every commit', async () => {
    const t = task(
      [affected],
      [pr(50, '2026-09-02T00:00:00Z'), pr(42, '2026-09-01T00:00:00Z'), commit('f'.repeat(40))],
    );
    const info = await taskChangeMergeState(t, '/nonexistent', {
      changeSet: noDerive,
      executionRoot: '/repo',
      isLanded: () => true,
      contains: (_r, a, merge) => a === 'f'.repeat(40) && merge.endsWith('42'),
    });
    expect(info).toMatchObject({ state: 'merged', prRef: '42' });
  });

  it('pr atoms alone: the newest by mergedAt, not the last recorded', async () => {
    const t = task([affected], [pr(50, '2026-09-02T00:00:00Z'), pr(42, '2026-09-01T00:00:00Z')]);
    const info = await taskChangeMergeState(t, '/nonexistent', { changeSet: noDerive });
    expect(info).toMatchObject({ state: 'merged', prRef: '50' });
  });

  it('when the merged-PR lookup fails, the state is unknown and a scoped testsPassed does not stand', async () => {
    const failing: ChangeSetDeps = {
      listMergedPrs: async () => ({ ok: false, reason: 'gh unavailable' }),
      listTaskDocs: async () => [],
      listTaskDecisions: async () => [],
      env: {},
    };
    const info = await taskChangeMergeState(task([affected]), '/nonexistent', {
      changeSet: failing,
    });
    expect(info.state).toBe('unknown');
    expect(scopedRunSupersededReason([affected], info.state)).toMatch(/before merge only/);
  });
});

describe('the PR named must carry the implementation commits (T12959 review HIGH)', () => {
  const B = 'b'.repeat(40);
  const implementedB = (): Task =>
    task([affected], [{ kind: 'commit', sha: B, shortSha: B.slice(0, 7) }]);
  const derived = (over: Partial<TaskChangeSet> = {}): TaskChangeSet => ({
    source: 'pr',
    executionRoot: '/repo',
    rootSource: 'store',
    prNumber: 10,
    mergeCommitSha: 'c'.repeat(40),
    mergeState: 'merged',
    files: ['src/a.ts'],
    deletedFiles: [],
    docs: [],
    decisions: [],
    candidates: [],
    implementedEvidence: 'pr:10;files:src/a.ts',
    blockers: [],
    warnings: [],
    ...over,
  });
  const view =
    (commits: Record<number, string[]>): NonNullable<ChangeSetDeps['viewPr']> =>
    async (n) => ({
      number: n,
      title: '',
      headRefName: 'task/T9001',
      baseRefName: 'main',
      state: 'MERGED',
      mergedAt: '2026-09-01T00:00:00Z',
      headRefOid: null,
      mergeCommitSha: null,
      commits: commits[n] ?? [],
    });

  it('red: B landed later on its own; the PR that cites the task (#10) never ran it, so no PR is named', async () => {
    const info = await taskChangeMergeState(implementedB(), '/nonexistent', {
      derived: derived(),
      changeSet: {
        viewPr: view({ 10: ['a'.repeat(40)] }),
        listPrsForCommit: async () => [],
      },
      executionRoot: '/repo',
      contains: () => false,
      equivalent: () => false,
      isLanded: () => true,
    });
    expect(info.state).toBe('merged');
    expect(info.prRef).toBeNull();
    expect(info.unproven).toMatch(/bbbbbbbbbbbb reached the default branch.*PR #10.*does not/);
  });

  it('green: the derived PR whose own commits include B (a squash merge) is named', async () => {
    const info = await taskChangeMergeState(implementedB(), '/nonexistent', {
      derived: derived(),
      changeSet: { viewPr: view({ 10: ['a'.repeat(40), B] }), listPrsForCommit: async () => [] },
      executionRoot: '/repo',
      contains: () => false,
      equivalent: () => false,
      isLanded: () => false,
    });
    expect(info).toMatchObject({ state: 'merged', prRef: '10' });
  });

  it('green: a merged PR GitHub associates with B is named when it carries B, though it does not cite the task', async () => {
    const info = await taskChangeMergeState(implementedB(), '/nonexistent', {
      derived: derived(),
      changeSet: {
        viewPr: view({ 10: ['a'.repeat(40)], 12: [B] }),
        listPrsForCommit: async () => [
          { number: 12, mergedAt: '2026-09-05T00:00:00Z', baseRefName: 'main' },
          { number: 11, mergedAt: null, baseRefName: 'main' },
        ],
        defaultBranch: () => 'main',
      },
      executionRoot: '/repo',
      contains: () => false,
      equivalent: () => false,
      isLanded: () => false,
    });
    expect(info).toMatchObject({ state: 'merged', prRef: '12' });
  });

  it('red (L2): a PR GitHub associates with B but whose commits do not carry it is never named', async () => {
    const info = await taskChangeMergeState(implementedB(), '/nonexistent', {
      derived: derived(),
      changeSet: {
        viewPr: view({ 10: ['a'.repeat(40)], 12: ['e'.repeat(40)] }),
        listPrsForCommit: async () => [
          { number: 12, mergedAt: '2026-09-05T00:00:00Z', baseRefName: 'main' },
        ],
        defaultBranch: () => 'main',
      },
      executionRoot: '/repo',
      contains: () => false,
      equivalent: () => false,
      isLanded: () => false,
    });
    expect(info).toMatchObject({ state: 'unmerged', prRef: null });
  });

  it('red (L2): with no origin default ref, a PR merged into another branch (a stacked base) never counts', async () => {
    const opts = (base: string) => ({
      derived: derived(),
      changeSet: {
        viewPr: view({ 10: ['a'.repeat(40)], 12: [B] }),
        listPrsForCommit: async () => [
          { number: 12, mergedAt: '2026-09-05T00:00:00Z', baseRefName: base },
        ],
        defaultBranch: () => 'main',
      },
      executionRoot: '/repo',
      contains: () => false,
      equivalent: () => false,
      isLanded: () => false,
    });
    expect(
      await taskChangeMergeState(implementedB(), '/nonexistent', opts('feat/T1-base')),
    ).toMatchObject({ state: 'unmerged', prRef: null });
    expect(await taskChangeMergeState(implementedB(), '/nonexistent', opts('main'))).toMatchObject({
      state: 'merged',
      prRef: '12',
    });
  });

  it('an unresolvable default branch is a failed lookup, never an unfiltered match', async () => {
    const info = await taskChangeMergeState(implementedB(), '/nonexistent', {
      derived: derived(),
      changeSet: {
        viewPr: view({ 10: ['a'.repeat(40)], 12: [B] }),
        listPrsForCommit: async () => [
          { number: 12, mergedAt: '2026-09-05T00:00:00Z', baseRefName: 'main' },
        ],
        defaultBranch: () => null,
      },
      executionRoot: '/repo',
      contains: () => false,
      equivalent: () => false,
      isLanded: () => false,
    });
    expect(info.state).toBe('unknown');
    expect(info.prRef).toBeNull();
    expect(info.lookupFailed).toMatch(/default branch is unknown/);
  });

  it('green: a commit rebased before its PR merged is carried by patch equivalence', async () => {
    const rebased = 'd'.repeat(40);
    const info = await taskChangeMergeState(implementedB(), '/nonexistent', {
      derived: derived(),
      changeSet: { viewPr: view({ 10: [rebased] }), listPrsForCommit: async () => [] },
      executionRoot: '/repo',
      contains: () => false,
      equivalent: (_r, sha, candidates) => sha === B && candidates.includes(rebased),
      isLanded: () => false,
    });
    expect(info).toMatchObject({ state: 'merged', prRef: '10' });
  });
});

describe('ancestry is a positive signal only (T12959 review MEDIUM)', () => {
  const B = 'b'.repeat(40);
  const implementedB = (): Task =>
    task([affected], [{ kind: 'commit', sha: B, shortSha: B.slice(0, 7) }]);
  const derived: TaskChangeSet = {
    source: 'pr',
    executionRoot: '/repo',
    rootSource: 'store',
    prNumber: 12,
    mergeCommitSha: 'e'.repeat(40),
    mergeState: 'merged',
    files: ['src/a.ts'],
    deletedFiles: [],
    docs: [],
    decisions: [],
    candidates: [],
    implementedEvidence: 'pr:12;files:src/a.ts',
    blockers: [],
    warnings: [],
  };

  it('a stale origin (merge commit never fetched) still finds the merged PR through gh', async () => {
    const info = await taskChangeMergeState(implementedB(), '/nonexistent', {
      derived,
      changeSet: {
        viewPr: async (n) => ({
          number: n,
          title: '',
          headRefName: 'task/T9001',
          baseRefName: 'main',
          state: 'MERGED',
          mergedAt: '2026-09-05T00:00:00Z',
          headRefOid: B,
          mergeCommitSha: 'e'.repeat(40),
          commits: [B],
        }),
        listPrsForCommit: async () => [],
      },
      executionRoot: '/repo',
      // Nothing is an ancestor of anything locally: origin/main is stale.
      contains: () => false,
      equivalent: () => null,
      isLanded: () => false,
    });
    expect(info).toMatchObject({ state: 'merged', prRef: '12' });
    expect(
      scopedRunSupersededReason(
        implementedB().verification?.evidence?.testsPassed?.atoms ?? [],
        info.state,
      ),
    ).toMatch(/merged change needs merged CI/);
  });

  it('a gh view that fails, with nothing landed, is unknown — never unmerged', async () => {
    const info = await taskChangeMergeState(implementedB(), '/nonexistent', {
      derived,
      changeSet: { viewPr: async () => null, listPrsForCommit: async () => [] },
      executionRoot: '/repo',
      contains: () => false,
      equivalent: () => false,
      isLanded: () => false,
    });
    expect(info.state).toBe('unknown');
  });

  it('L1: landed, and the carrier lookup failed (gh pr view): carrier unknown, never "no PR carries it"', async () => {
    const info = await taskChangeMergeState(implementedB(), '/nonexistent', {
      derived,
      changeSet: { viewPr: async () => null, listPrsForCommit: async () => [] },
      executionRoot: '/repo',
      contains: () => false,
      equivalent: () => false,
      isLanded: () => true,
    });
    expect(info).toMatchObject({ state: 'merged', prRef: null });
    expect(info.unproven).toBeUndefined();
    expect(info.lookupFailed).toMatch(/gh pr view 12 failed.*gh unreachable/);
  });

  it('L1: a commits/<sha>/pulls failure is reported apart from "no PRs"', async () => {
    const base = {
      derived: { ...derived, mergeCommitSha: undefined },
      executionRoot: '/repo',
      contains: () => false,
      equivalent: () => false,
    };
    const viewPr = async (n: number) => ({
      number: n,
      title: '',
      headRefName: 'task/T9001',
      baseRefName: 'main',
      state: 'MERGED',
      mergedAt: '2026-09-05T00:00:00Z',
      headRefOid: null,
      mergeCommitSha: null,
      commits: ['c'.repeat(40)],
    });
    const failed = await taskChangeMergeState(implementedB(), '/nonexistent', {
      ...base,
      changeSet: { viewPr, listPrsForCommit: async () => null },
      isLanded: () => true,
    });
    expect(failed.lookupFailed).toMatch(/commits\/bbbbbbbbbbbb\/pulls failed/);
    expect(failed.unproven).toBeUndefined();
    const none = await taskChangeMergeState(implementedB(), '/nonexistent', {
      ...base,
      changeSet: { viewPr, listPrsForCommit: async () => [] },
      isLanded: () => true,
    });
    expect(none.lookupFailed).toBeUndefined();
    expect(none.unproven).toMatch(/no merged PR is known to carry them/);
    const notLanded = await taskChangeMergeState(implementedB(), '/nonexistent', {
      ...base,
      changeSet: { viewPr, listPrsForCommit: async () => null },
      isLanded: () => false,
    });
    expect(notLanded.state).toBe('unknown');
  });

  it('L1: a failed merged-PR discovery behind a landed commit is a carrier-unknown result', async () => {
    const info = await taskChangeMergeState(implementedB(), '/nonexistent', {
      derived: {
        ...derived,
        source: 'branch',
        prNumber: undefined,
        mergeState: 'unknown',
        prDiscoveryFailed: true,
      },
      changeSet: { viewPr: async () => null, listPrsForCommit: async () => [] },
      executionRoot: '/repo',
      contains: () => false,
      equivalent: () => false,
      isLanded: () => true,
    });
    expect(info).toMatchObject({ state: 'merged', prRef: null });
    expect(info.lookupFailed).toMatch(/merged-PR lookup failed/);
  });

  it('commits missing locally are named as such, not as gh unreachable', async () => {
    const info = await taskChangeMergeState(implementedB(), '/nonexistent', {
      derived,
      changeSet: {
        viewPr: async (n) => ({
          number: n,
          title: '',
          headRefName: 'task/T9001',
          baseRefName: 'main',
          state: 'MERGED',
          mergedAt: '2026-09-05T00:00:00Z',
          headRefOid: null,
          mergeCommitSha: null,
          commits: ['d'.repeat(40)],
        }),
        listPrsForCommit: async () => [],
      },
      executionRoot: '/repo',
      contains: () => false,
      equivalent: () => ({ missing: ['d'.repeat(40)] }),
      isLanded: () => false,
    });
    expect(info.state).toBe('unknown');
    expect(info.lookupFailed).toMatch(/dddddddddddd are not in the local object store.*git fetch/);
    expect(info.lookupFailed).not.toMatch(/gh unreachable/);
    expect(scopedRunSupersededReason([affected], info.state, info.lookupFailed)).toMatch(
      /cannot be determined \(commit\(s\) dddddddddddd are not in the local object store/,
    );
  });

  it('a commit no PR carries and that never landed is unmerged', async () => {
    const info = await taskChangeMergeState(implementedB(), '/nonexistent', {
      derived: {
        source: 'branch',
        executionRoot: '/repo',
        rootSource: 'store',
        files: ['src/a.ts'],
        deletedFiles: [],
        docs: [],
        decisions: [],
        candidates: [],
        implementedEvidence: `commit:${B};files:src/a.ts`,
        blockers: [],
        warnings: [],
      },
      changeSet: { viewPr: async () => null, listPrsForCommit: async () => [] },
      executionRoot: '/repo',
      contains: () => false,
      equivalent: () => false,
      isLanded: () => false,
    });
    expect(info).toMatchObject({ state: 'unmerged', prRef: null });
  });
});

describe('hasPatchEquivalent (real git)', () => {
  it('matches a commit to its rebased copy, and nothing else', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'patch-equivalent-')));
    const run = (args: string[]): string =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
    try {
      run(['init', '-q', '-b', 'main']);
      run(['config', 'user.name', 'T']);
      run(['config', 'user.email', 't@e.x']);
      writeFileSync(join(dir, 'a'), 'a\n');
      run(['add', '.']);
      run(['commit', '-q', '-m', 'init']);
      run(['switch', '-q', '-c', 'task']);
      writeFileSync(join(dir, 'b'), 'b\n');
      run(['add', '.']);
      run(['commit', '-q', '-m', 'work']);
      const original = run(['rev-parse', 'HEAD']);
      run(['switch', '-q', 'main']);
      writeFileSync(join(dir, 'c'), 'c\n');
      run(['add', '.']);
      run(['commit', '-q', '-m', 'main moved']);
      const other = run(['rev-parse', 'HEAD']);
      run(['switch', '-q', 'task']);
      run(['rebase', '-q', 'main']);
      const rebased = run(['rev-parse', 'HEAD']);
      expect(rebased).not.toBe(original);
      expect(hasPatchEquivalent(dir, original, [rebased])).toBe(true);
      expect(hasPatchEquivalent(dir, original, [other])).toBe(false);
      const absent = '4'.repeat(40);
      expect(hasPatchEquivalent(dir, original, [absent])).toEqual({ missing: [absent] });
      // A missing candidate does not hide a match among the present ones.
      expect(hasPatchEquivalent(dir, original, [absent, rebased])).toBe(true);
      expect(hasPatchEquivalent(dir, original, [absent, other])).toEqual({ missing: [absent] });
      expect(hasPatchEquivalent(dir, absent, [rebased])).toEqual({ missing: [absent] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a tree-pinned scoped run carries across the merge (T13495)', () => {
  function repo(): { root: string; git: (...a: string[]) => string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'scoped-merge-')));
    const git = (...a: string[]): string =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...a], {
        cwd: root,
        encoding: 'utf-8',
      }).trim();
    git('init', '-q', '-b', 'main');
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'other.ts'), 'export const o = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    return { root, git };
  }

  /** Branch change to a.ts, its tree, then a squash merge on main (with another PR's change first). */
  function mergedChange(alterAtMerge = false) {
    const { root, git } = repo();
    git('switch', '-q', '-c', 'task/T1');
    writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
    git('commit', '-q', '-am', 'T1');
    const tested = git('rev-parse', 'HEAD^{tree}');
    git('switch', '-q', 'main');
    // Another PR lands first, touching a file the change did not.
    writeFileSync(join(root, 'other.ts'), 'export const o = 2;\n');
    git('commit', '-q', '-am', 'other PR');
    git('merge', '-q', '--squash', 'task/T1');
    if (alterAtMerge) writeFileSync(join(root, 'a.ts'), 'export const a = 3;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'T1 (#5)');
    const merge = git('rev-parse', 'HEAD');
    const changeSet = {
      mergeCommitSha: merge,
      files: ['a.ts'],
      deletedFiles: [],
      executionRoot: root,
    };
    return { root, tested, changeSet };
  }

  const run = (treeHash?: string): EvidenceAtom => ({
    kind: 'test-run',
    path: 'r.json',
    sha256: 'c'.repeat(64),
    passCount: 1,
    failCount: 0,
    skipCount: 0,
    ...(treeHash ? { treeHash } : {}),
  });

  it('carries when the changed files are byte-identical at the merge commit, even with other PRs on main', async () => {
    const { root, tested, changeSet } = mergedChange();
    try {
      expect(scopedRunCarriedAcrossMerge([run(tested)], changeSet)).toEqual({ ok: true });
      const reason = await testsPassedSupersededReason([run(tested)], {
        mergeState: () => ({ state: 'merged', changeSet: changeSet as unknown as TaskChangeSet }),
        currentTree: () => tested,
      });
      expect(reason).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not carry when the change differs at the merge commit, and says why with the supported paths', async () => {
    const { root, tested, changeSet } = mergedChange(true);
    try {
      expect(scopedRunCarriedAcrossMerge([run(tested)], changeSet)).toMatchObject({
        ok: false,
        why: expect.stringMatching(/differ from the tree the scoped run tested/),
      });
      const reason = await testsPassedSupersededReason([run(tested)], {
        mergeState: () => ({ state: 'merged', changeSet: changeSet as unknown as TaskChangeSet }),
        currentTree: () => tested,
      });
      expect(reason).toMatch(
        /does not carry across the merge because the change's files at merge commit .* differ.*ci:<pr>, with evidence\.ciSatisfies.*tool:test/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed: no tree pin, no merge commit, or no changed files', () => {
    const { root, tested, changeSet } = mergedChange();
    try {
      expect(scopedRunCarriedAcrossMerge([run()], changeSet)).toMatchObject({
        ok: false,
        why: expect.stringMatching(/no recorded tree/),
      });
      expect(scopedRunCarriedAcrossMerge([run(tested)], null)).toMatchObject({ ok: false });
      expect(scopedRunCarriedAcrossMerge([run(tested)], { ...changeSet, files: [] })).toMatchObject(
        { ok: false, why: expect.stringMatching(/lists no files/) },
      );
      expect(scopedRunCarriedAcrossMerge([run('f'.repeat(40))], changeSet)).toMatchObject({
        ok: false,
        why: expect.stringMatching(/could not compare/),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a merge verdict without a change set keeps the old refusal (nothing to compare)', async () => {
    const reason = await testsPassedSupersededReason([run('a'.repeat(40))], {
      mergeState: () => 'merged',
      currentTree: () => 'a'.repeat(40),
    });
    expect(reason).toMatch(
      /does not carry across the merge because the merge commit is not known here/,
    );
  });
});

describe('T13608: a scoped run after a fast-forward or direct landing (no merge commit)', () => {
  const sh = (cwd: string, args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.invalid',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    }).trim();
  const noChangeSet: TaskChangeSet = {
    source: 'none',
    executionRoot: '/repo',
    rootSource: 'store',
    files: [],
    deletedFiles: [],
    docs: [],
    decisions: [],
    candidates: [],
    implementedEvidence: '',
    blockers: [],
    warnings: [],
  };
  const run = (treeHash: string): EvidenceAtom => ({
    kind: 'test-run',
    path: 'reports/r.json',
    sha256: 'c'.repeat(64),
    passCount: 1,
    failCount: 0,
    skipCount: 0,
    treeHash,
  });

  /** A repo whose implementing commit is fast-forwarded onto main. */
  function landed(): { root: string; impl: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t13608-')));
    sh(root, ['init', '-q', '-b', 'main']);
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
    sh(root, ['add', '.']);
    sh(root, ['commit', '-q', '-m', 'base']);
    writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
    sh(root, ['commit', '-q', '-am', 'T9001: implement']);
    return { root, impl: sh(root, ['rev-parse', 'HEAD']) };
  }

  async function reason(root: string, impl: string): Promise<string | null> {
    const tree = sh(root, ['rev-parse', 'HEAD^{tree}']);
    const t = task([run(tree)], [{ kind: 'commit', sha: impl, shortSha: impl.slice(0, 7) }]);
    const info = await taskChangeMergeState(t, root, {
      derived: { ...noChangeSet, executionRoot: root },
      executionRoot: root,
      isLanded: () => true,
      changeSet: { viewPr: async () => null, listPrsForCommit: async () => [] },
    });
    return testsPassedSupersededReason(t.verification?.evidence?.testsPassed?.atoms ?? [], {
      mergeState: () => info,
      currentTree: () => tree,
    });
  }

  it('stands: the run tested the landed commit, and later unrelated main commits do not matter', async () => {
    const { root, impl } = landed();
    try {
      expect(await reason(root, impl)).toBeNull();
      writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
      sh(root, ['commit', '-q', '-am', 'unrelated']);
      expect(await reason(root, impl)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses once main edits a file the implementing commit changed', async () => {
    const { root, impl } = landed();
    try {
      writeFileSync(join(root, 'a.ts'), 'export const a = 3;\n');
      sh(root, ['commit', '-q', '-am', 'later edit']);
      expect(await reason(root, impl)).toMatch(
        new RegExp(`files at merge commit ${impl.slice(0, 12)} differ`),
      );
      // T13637: the refusal names the file that moved, so it can be acted on.
      expect(await reason(root, impl)).toMatch(/\): a\.ts/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('T13634: a recorded pr: atom gives the scoped run its merge commit to compare', () => {
  const git = (cwd: string, ...a: string[]): string =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...a], {
      cwd,
      encoding: 'utf-8',
    }).trim();
  const run = (treeHash: string): EvidenceAtom => ({
    kind: 'test-run',
    path: 'r.json',
    sha256: 'c'.repeat(64),
    passCount: 1,
    failCount: 0,
    skipCount: 0,
    treeHash,
  });

  /** A branch change to a.ts squash-merged onto main, recorded as `pr:` evidence. */
  function merged(alterAtMerge = false) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t13634-')));
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'init');
    git(root, 'switch', '-q', '-c', 'task/T9001');
    writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
    git(root, 'commit', '-q', '-am', 'T9001');
    const impl = git(root, 'rev-parse', 'HEAD');
    const tested = git(root, 'rev-parse', 'HEAD^{tree}');
    git(root, 'switch', '-q', 'main');
    git(root, 'merge', '-q', '--squash', 'task/T9001');
    if (alterAtMerge) writeFileSync(join(root, 'a.ts'), 'export const a = 3;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'T9001 (#7)');
    const pr: EvidenceAtom = {
      kind: 'pr',
      prNumber: 7,
      mergeCommitSha: git(root, 'rev-parse', 'HEAD'),
      mergedAt: '2026-10-12T00:00:00Z',
      successCount: 1,
      totalChecks: 1,
      changedPaths: ['a.ts'],
    };
    return { root, impl, tested, pr };
  }

  async function reason(t: Task, root: string, tree: string): Promise<string | null> {
    const info = await taskChangeMergeState(t, root, { executionRoot: root, contains: () => true });
    return testsPassedSupersededReason(t.verification?.evidence?.testsPassed?.atoms ?? [], {
      mergeState: () => info,
      currentTree: () => tree,
    });
  }

  it('stands with only a pr: atom (no commit atoms) when the merged files match', async () => {
    const { root, tested, pr } = merged();
    try {
      expect(await reason(task([run(tested)], [pr]), root, tested)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stands when a recorded pr: atom carries the commit atoms and the merged files match', async () => {
    const { root, impl, tested, pr } = merged();
    try {
      const t = task(
        [run(tested)],
        [{ kind: 'commit', sha: impl, shortSha: impl.slice(0, 7) }, pr],
      );
      expect(await reason(t, root, tested)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('T13636: with no file inventory, the merge commit gives the PR files (files: atoms list receipts only)', async () => {
    const { root, tested, pr } = merged();
    try {
      const { changedPaths: _omit, ...bare } = pr as Extract<EvidenceAtom, { kind: 'pr' }>;
      // T1770's shape: the files: atom binds a receipt, not the PR's source.
      const files: EvidenceAtom = {
        kind: 'files',
        files: [{ path: 'receipt.json', sha256: 'd'.repeat(64) }],
      };
      expect(await reason(task([run(tested)], [bare, files]), root, tested)).toBeNull();
      expect(await reason(task([run(tested)], [bare]), root, tested)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('T13636: the merge-commit file list cannot narrow — a merged file that moved still refuses', async () => {
    const { root, tested, pr } = merged(true);
    try {
      const { changedPaths: _omit, ...bare } = pr as Extract<EvidenceAtom, { kind: 'pr' }>;
      const files: EvidenceAtom = {
        kind: 'files',
        files: [{ path: 'receipt.json', sha256: 'd'.repeat(64) }],
      };
      expect(await reason(task([run(tested)], [bare, files]), root, tested)).toMatch(
        /differ from the tree.*: a\.ts/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('T13637: a commit-backed GitHub carrier (no pr: atom) gives its merge commit to compare', async () => {
    const { root, impl, tested, pr } = merged();
    try {
      const mergeSha = (pr as Extract<EvidenceAtom, { kind: 'pr' }>).mergeCommitSha as string;
      const t = task(
        [run(tested)],
        [
          { kind: 'commit', sha: impl, shortSha: impl.slice(0, 7) },
          { kind: 'files', files: [{ path: 'a.ts', sha256: 'd'.repeat(64) }] },
        ],
      );
      const info = await taskChangeMergeState(t, root, {
        executionRoot: root,
        derived: {
          source: 'none',
          executionRoot: root,
          rootSource: 'store',
          files: ['a.ts'],
          deletedFiles: [],
          docs: [],
          decisions: [],
          candidates: [],
          implementedEvidence: '',
          blockers: [],
          warnings: [],
        },
        changeSet: {
          listPrsForCommit: async () => [
            {
              number: 7,
              mergedAt: '2026-10-12T00:00:00Z',
              baseRefName: 'main',
              mergeCommitSha: mergeSha,
            },
          ],
          viewPr: async () => ({
            number: 7,
            title: 'T9001',
            headRefName: 'task/T9001',
            baseRefName: 'main',
            state: 'MERGED',
            mergedAt: '2026-10-12T00:00:00Z',
            headRefOid: impl,
            mergeCommitSha: mergeSha,
            commits: [impl],
          }),
          defaultBranch: () => 'main',
        },
        contains: () => false,
        equivalent: () => false,
        isLanded: () => false,
      });
      expect(info).toMatchObject({ state: 'merged', prRef: '7' });
      const why = await testsPassedSupersededReason(
        t.verification?.evidence?.testsPassed?.atoms ?? [],
        { mergeState: () => info, currentTree: () => tested },
      );
      expect(why).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still refuses when the merge changed a file the scoped run tested', async () => {
    const { root, tested, pr } = merged(true);
    try {
      expect(await reason(task([run(tested)], [pr]), root, tested)).toMatch(/differ from the tree/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('T13655: plan and complete scope a carrier PR to the task the same way', () => {
  const git = (cwd: string, ...a: string[]): string =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...a], {
      cwd,
      encoding: 'utf-8',
    }).trim();
  const run = (treeHash: string): EvidenceAtom => ({
    kind: 'test-run',
    path: 'r.json',
    sha256: 'c'.repeat(64),
    passCount: 1,
    failCount: 0,
    skipCount: 0,
    treeHash,
  });

  /**
   * A PR merged with --no-ff, then main edits `moved` again. `shared`: a
   * sibling's commit (b.ts) and this task's commit (a.ts), T1947's shape; else
   * one task commit that changes both files.
   */
  function carrier(shared: boolean, moved: 'a.ts' | 'b.ts') {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t13655-')));
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'init');
    git(root, 'switch', '-q', '-c', 'feature');
    if (shared) {
      writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
      git(root, 'commit', '-q', '-am', 'sibling code');
      writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
      // Like T1947's f76f2d38, the task's commit does not cite the task id.
      git(root, 'commit', '-q', '-am', 'test edit');
    } else {
      writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
      writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
      git(root, 'commit', '-q', '-am', 'T9001');
    }
    const impl = git(root, 'rev-parse', 'HEAD');
    git(root, 'switch', '-q', 'main');
    git(root, 'merge', '-q', '--no-ff', '-m', 'Merge PR #7', 'feature');
    const merge = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, moved), 'export const x = 3;\n');
    git(root, 'commit', '-q', '-am', 'later edit on main');
    return { root, impl, merge, tested: git(root, 'rev-parse', 'HEAD^{tree}') };
  }

  const NONE: TaskChangeSet = {
    source: 'none',
    executionRoot: '',
    rootSource: 'store',
    files: [],
    deletedFiles: [],
    docs: [],
    decisions: [],
    candidates: [],
    implementedEvidence: '',
    blockers: [],
    warnings: [],
  };

  /**
   * The carry verdict for a task that declares only a.ts, through the change
   * set planned with `--pr` (plan) or through GitHub's commit carrier (a plain
   * complete). `implemented` defaults to the task's commit.
   */
  async function verdict(
    c: ReturnType<typeof carrier>,
    viaPr: boolean,
    implemented: EvidenceAtom[] = [{ kind: 'commit', sha: c.impl, shortSha: c.impl.slice(0, 7) }],
  ): Promise<string | null> {
    const t: Task = { ...task([run(c.tested)], implemented), files: ['a.ts'] };
    const base = { ...NONE, executionRoot: c.root };
    const info = await taskChangeMergeState(t, c.root, {
      executionRoot: c.root,
      // `cleo done --plan --pr 7` derives the PR change set, files as declared.
      derived: viaPr
        ? { ...base, source: 'pr', prNumber: 7, mergeCommitSha: c.merge, files: ['a.ts'] }
        : base,
      changeSet: {
        listPrsForCommit: async () => [
          {
            number: 7,
            mergedAt: '2026-10-13T00:00:00Z',
            baseRefName: 'main',
            mergeCommitSha: c.merge,
          },
        ],
        viewPr: async () => ({
          number: 7,
          title: 'parent',
          headRefName: 'feature',
          baseRefName: 'main',
          state: 'MERGED',
          mergedAt: '2026-10-13T00:00:00Z',
          headRefOid: c.impl,
          mergeCommitSha: c.merge,
          commits: [c.impl],
        }),
        defaultBranch: () => 'main',
      },
      contains: (_root, ancestor, descendant) => ancestor === c.impl && descendant === c.merge,
      equivalent: () => false,
      isLanded: () => true,
    });
    return testsPassedSupersededReason(t.verification?.evidence?.testsPassed?.atoms ?? [], {
      mergeState: () => info,
      currentTree: () => c.tested,
    });
  }

  it('(1) a shared parent PR whose sibling file moved later: plan and complete both carry', async () => {
    const c = carrier(true, 'b.ts');
    try {
      expect(await verdict(c, true)).toBeNull();
      expect(await verdict(c, false)).toBeNull();
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('(2) a single-task PR whose undeclared file moved: plan and complete both refuse', async () => {
    const c = carrier(false, 'b.ts');
    try {
      const plan = await verdict(c, true);
      expect(plan).toMatch(/differ from the tree.*: b\.ts/);
      expect(await verdict(c, false)).toBe(plan);
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('(3) a task with no own commits: the whole merge counts, on both paths', async () => {
    const c = carrier(true, 'b.ts');
    try {
      const pr: EvidenceAtom = {
        kind: 'pr',
        prNumber: 7,
        mergeCommitSha: c.merge,
        mergedAt: '2026-10-13T00:00:00Z',
        successCount: 1,
        totalChecks: 1,
      };
      const plan = await verdict(c, true, [pr]);
      expect(plan).toMatch(/differ from the tree.*: b\.ts/);
      expect(await verdict(c, false, [pr])).toBe(plan);
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  /**
   * T1919's shape (T13662): one test-only commit recorded as implemented, while
   * another commit of the same PR adds the migration-journal entry. `branch`
   * names the merged branch; `cite` puts the task id in the journal commit's
   * message. Main appends to the journal after the merge.
   */
  function journalPr(branch: string, cite: boolean) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t13662-')));
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'a.test.ts'), 'export const t = 1;\n');
    writeFileSync(join(root, 'journal.json'), '{"entries":[1]}\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'init');
    git(root, 'switch', '-q', '-c', branch);
    writeFileSync(join(root, 'journal.json'), '{"entries":[1,2]}\n');
    git(
      root,
      'commit',
      '-q',
      '-am',
      cite ? 'chore(t9001): number the migration' : 'chore: number a migration',
    );
    writeFileSync(join(root, 'a.test.ts'), 'export const t = 2;\n');
    git(root, 'commit', '-q', '-am', 'test: native suite');
    const impl = git(root, 'rev-parse', 'HEAD');
    git(root, 'switch', '-q', 'main');
    git(root, 'merge', '-q', '--no-ff', '-m', `Merge pull request #7 from owner/${branch}`, branch);
    const merge = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'journal.json'), '{"entries":[1,2,3]}\n');
    git(root, 'commit', '-q', '-am', 'later migration on main');
    return { root, impl, merge, tested: git(root, 'rev-parse', 'HEAD^{tree}') };
  }

  it("T13662: the task's own branch counts whole — a recorded test-only commit does not hide its journal entry", async () => {
    const c = journalPr('fix/t9001-verified-phone', false);
    try {
      const plan = await verdict(c, true);
      expect(plan).toMatch(/differ from the tree.*: journal\.json/);
      expect(await verdict(c, false)).toBe(plan);
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('T13662: on another branch, a commit citing the task counts; one that does not, does not', async () => {
    const cited = journalPr('fix/shared-wave', true);
    const uncited = journalPr('fix/shared-wave', false);
    try {
      expect(await verdict(cited, false)).toMatch(/differ from the tree.*: journal\.json/);
      expect(await verdict(cited, true)).toBe(await verdict(cited, false));
      expect(await verdict(uncited, false)).toBeNull();
      expect(await verdict(uncited, true)).toBeNull();
    } finally {
      rmSync(cited.root, { recursive: true, force: true });
      rmSync(uncited.root, { recursive: true, force: true });
    }
  });

  it("the task's own file moving after the merge refuses on both paths", async () => {
    const c = carrier(true, 'a.ts');
    try {
      const plan = await verdict(c, true);
      expect(plan).toMatch(/differ from the tree.*: a\.ts/);
      expect(await verdict(c, false)).toBe(plan);
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });
});

describe('T13623: a test-run on main after the merge stands in for red merged CI', () => {
  /** A standalone project: the change edits src/a.ts and its test, merges, then main moves on. */
  function landed() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'red-ci-')));
    const git = (...a: string[]): string =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...a], {
        cwd: root,
        encoding: 'utf-8',
      }).trim();
    git('init', '-q', '-b', 'main');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), '{"name":"x","type":"module"}\n');
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'src/a.test.ts'), "import './a.js';\n");
    writeFileSync(join(root, 'src/other.ts'), 'export const o = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('switch', '-q', '-c', 'task/T1');
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n');
    writeFileSync(join(root, 'src/a.test.ts'), "import './a.js'; // 2\n");
    git('commit', '-q', '-am', 'T1');
    const branchHead = git('rev-parse', 'HEAD');
    git('switch', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'Merge #5', 'task/T1');
    const merge = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'src/other.ts'), 'export const o = 2;\n');
    git('commit', '-q', '-am', 'a later PR');
    const head = git('rev-parse', 'HEAD');
    const tree = git('rev-parse', 'HEAD^{tree}');
    git('update-ref', 'refs/remotes/origin/main', head);
    const changeSet = {
      mergeCommitSha: merge,
      files: ['src/a.ts', 'src/a.test.ts'],
      executionRoot: root,
    };
    return { root, git, head, tree, branchHead, changeSet };
  }

  const run = (o: Partial<Extract<EvidenceAtom, { kind: 'test-run' }>>): EvidenceAtom => ({
    kind: 'test-run',
    path: 'r.json',
    sha256: 'c'.repeat(64),
    passCount: 1,
    failCount: 0,
    skipCount: 0,
    testFiles: ['src/a.test.ts'],
    ...o,
  });

  it('stands when it ran on a descendant of the merge, on the current tree, covering the change', () => {
    const { root, head, tree, changeSet } = landed();
    try {
      expect(
        scopedRunStandsAfterRedCi(
          [run({ headSha: head, treeHash: tree })],
          changeSet,
          tree,
          isLandedOnOriginDefault,
        ),
      ).toEqual({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed: a moved tree, a pre-merge HEAD, an uncovered test file, no pin, or an affected tool run', () => {
    const { root, head, tree, branchHead, changeSet } = landed();
    try {
      const judge = (atoms: EvidenceAtom[], current = tree) =>
        scopedRunStandsAfterRedCi(atoms, changeSet, current, isLandedOnOriginDefault);
      expect(judge([run({ headSha: head, treeHash: tree })], 'f'.repeat(40))).toMatchObject({
        ok: false,
        why: expect.stringMatching(/but the tree is now/),
      });
      expect(judge([run({ headSha: branchHead, treeHash: tree })])).toMatchObject({
        ok: false,
        why: expect.stringMatching(/does not descend from merge commit/),
      });
      expect(judge([run({ headSha: head, treeHash: tree, testFiles: [] })])).toMatchObject({
        ok: false,
      });
      expect(judge([run({ treeHash: tree })])).toMatchObject({
        ok: false,
        why: expect.stringMatching(/records no HEAD and tree/),
      });
      expect(judge([run({ headSha: head, treeHash: tree }), affected])).toMatchObject({
        ok: false,
        why: expect.stringMatching(/only test-run reports/),
      });
      expect(
        scopedRunStandsAfterRedCi(
          [run({ headSha: head, treeHash: tree })],
          null,
          tree,
          isLandedOnOriginDefault,
        ),
      ).toMatchObject({ ok: false, why: expect.stringMatching(/merge commit is not known/) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('refuses a run on a branch that merged main and added its own fix (T13627)', () => {
    const { root, git, changeSet } = landed();
    try {
      git('switch', '-q', '-c', 'feature/fix-the-red-test');
      writeFileSync(join(root, 'src/a.test.ts'), "import './a.js'; // fixed only here\n");
      git('commit', '-q', '-am', 'fix the test only on this branch');
      const branchHead = git('rev-parse', 'HEAD');
      const branchTree = git('rev-parse', 'HEAD^{tree}');
      expect(
        scopedRunStandsAfterRedCi(
          [run({ headSha: branchHead, treeHash: branchTree })],
          changeSet,
          branchTree,
          isLandedOnOriginDefault,
        ),
      ).toMatchObject({ ok: false, why: expect.stringMatching(/not on origin's default branch/) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('T13673: a later-main test-run stands in for any merged change (owner decision 2026-10-13)', () => {
  /**
   * T1919's shape: the change edits src/a.ts, its test and a migration journal;
   * after the merge, main appends to the journal, so byte-identity carry fails.
   */
  function journalLanded() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t13673-')));
    const git = (...a: string[]): string =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...a], {
        cwd: root,
        encoding: 'utf-8',
      }).trim();
    git('init', '-q', '-b', 'main');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), '{"name":"x","type":"module"}\n');
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'src/a.test.ts'), "import './a.js';\n");
    writeFileSync(join(root, 'journal.json'), '{"entries":[1]}\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('switch', '-q', '-c', 'task/T9001');
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n');
    writeFileSync(join(root, 'src/a.test.ts'), "import './a.js'; // 2\n");
    writeFileSync(join(root, 'journal.json'), '{"entries":[1,2]}\n');
    git('commit', '-q', '-am', 'T9001');
    const branchHead = git('rev-parse', 'HEAD');
    git('switch', '-q', 'main');
    git(
      'merge',
      '-q',
      '--no-ff',
      '-m',
      'Merge pull request #7 from owner/task/T9001',
      'task/T9001',
    );
    const merge = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'journal.json'), '{"entries":[1,2,3]}\n');
    git('commit', '-q', '-am', 'a later migration');
    const head = git('rev-parse', 'HEAD');
    const tree = git('rev-parse', 'HEAD^{tree}');
    git('update-ref', 'refs/remotes/origin/main', head);
    const changeSet: TaskChangeSet = {
      source: 'pr',
      executionRoot: root,
      rootSource: 'store',
      files: ['journal.json', 'src/a.test.ts', 'src/a.ts'],
      deletedFiles: [],
      docs: [],
      decisions: [],
      candidates: [],
      implementedEvidence: '',
      blockers: [],
      warnings: [],
      prNumber: 7,
      mergeCommitSha: merge,
    };
    return { root, head, tree, branchHead, changeSet };
  }

  const run = (o: Partial<Extract<EvidenceAtom, { kind: 'test-run' }>>): EvidenceAtom => ({
    kind: 'test-run',
    path: 'r.json',
    sha256: 'c'.repeat(64),
    passCount: 1,
    failCount: 0,
    skipCount: 0,
    testFiles: ['src/a.test.ts'],
    ...o,
  });

  /** The one rule plan and complete share, for a merged change. */
  const judge = (c: ReturnType<typeof journalLanded>, atoms: EvidenceAtom[]) =>
    testsPassedSupersededReason(atoms, {
      mergeState: () => ({ state: 'merged', changeSet: c.changeSet }),
      currentTree: () => c.tree,
      landed: isLandedOnOriginDefault,
    });

  it('a targeted run on a main HEAD descending from the merge, on the current tree, covering the change, stands', async () => {
    const c = journalLanded();
    try {
      // Byte identity alone refuses: the journal moved after the merge.
      expect(scopedRunCarriedAcrossMerge([run({ treeHash: c.tree })], c.changeSet)).toMatchObject({
        ok: false,
      });
      expect(await judge(c, [run({ headSha: c.head, treeHash: c.tree })])).toBeNull();
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('a run on a non-descendant HEAD, or one not covering the change, still refuses with both reasons', async () => {
    const c = journalLanded();
    try {
      const stale = await judge(c, [run({ headSha: c.branchHead, treeHash: c.tree })]);
      expect(stale).toMatch(
        /differ from the tree.*journal\.json.*no test-run on main after the merge stands in.*does not descend/s,
      );
      const uncovered = await judge(c, [run({ headSha: c.head, treeHash: c.tree, testFiles: [] })]);
      expect(uncovered).toMatch(/no test-run on main after the merge stands in/);
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });
});

describe('T13784: staleness considers only the change files and the tests the run ran', () => {
  /** The T13673 fixture, then main gains one more commit editing `path`. */
  function movedOn(path: string) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t13784-')));
    const git = (...a: string[]): string =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...a], {
        cwd: root,
        encoding: 'utf-8',
      }).trim();
    git('init', '-q', '-b', 'main');
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'tooling'));
    writeFileSync(join(root, 'package.json'), '{"name":"x","type":"module"}\n');
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'src/a.test.ts'), "import './a.js';\n");
    writeFileSync(join(root, 'tooling/print-bridge.mjs'), 'export const p = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('switch', '-q', '-c', 'task/T9001');
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n');
    git('commit', '-q', '-am', 'T9001');
    git('switch', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'Merge pull request #7', 'task/T9001');
    const merge = git('rev-parse', 'HEAD');
    const ranHead = git('rev-parse', 'HEAD');
    const ranTree = git('rev-parse', 'HEAD^{tree}');
    writeFileSync(join(root, path), `// moved on ${path}\n`);
    git('commit', '-q', '-am', `later main commit: ${path}`);
    const head = git('rev-parse', 'HEAD');
    const tree = git('rev-parse', 'HEAD^{tree}');
    git('update-ref', 'refs/remotes/origin/main', head);
    const changeSet: TaskChangeSet = {
      source: 'pr',
      executionRoot: root,
      rootSource: 'store',
      files: ['src/a.ts'],
      deletedFiles: [],
      docs: [],
      decisions: [],
      candidates: [],
      implementedEvidence: '',
      blockers: [],
      warnings: [],
      prNumber: 7,
      mergeCommitSha: merge,
    };
    return { root, merge, ranHead, ranTree, head, tree, changeSet };
  }

  const run = (o: Partial<Extract<EvidenceAtom, { kind: 'test-run' }>>): EvidenceAtom => ({
    kind: 'test-run',
    path: 'r.json',
    sha256: 'c'.repeat(64),
    passCount: 1,
    failCount: 0,
    skipCount: 0,
    testFiles: ['src/a.test.ts'],
    ...o,
  });

  const judge = (c: ReturnType<typeof movedOn>, atoms: EvidenceAtom[]) =>
    testsPassedSupersededReason(atoms, {
      mergeState: () => ({ state: 'merged', changeSet: c.changeSet }),
      currentTree: () => c.tree,
      landed: isLandedOnOriginDefault,
    });

  it('green: an unrelated commit after verify (tree moved) does not stale the run', async () => {
    const c = movedOn('tooling/print-bridge.mjs');
    try {
      const atoms = [run({ headSha: c.ranHead, treeHash: c.ranTree })];
      expect(await judge(c, atoms)).toBeNull();
      expect(
        scopedRunStandsAfterRedCi(atoms, c.changeSet, c.tree, isLandedOnOriginDefault),
      ).toEqual({ ok: true });
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('green: an unrelated commit landed between the run and verify (runHeadSha) does not stale it', async () => {
    const c = movedOn('tooling/print-bridge.mjs');
    try {
      const atoms = [run({ runHeadSha: c.ranHead, headSha: c.head, treeHash: c.tree })];
      expect(await judge(c, atoms)).toBeNull();
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it("red: a later commit touching the change's own file stales it, on both paths", async () => {
    const c = movedOn('src/a.ts');
    try {
      const after = await judge(c, [run({ headSha: c.ranHead, treeHash: c.ranTree })]);
      expect(after).toMatch(/differ between the tree it was recorded on.*: src\/a\.ts/);
      const between = await judge(c, [
        run({ runHeadSha: c.ranHead, headSha: c.head, treeHash: c.tree }),
      ]);
      expect(between).toMatch(/differ between HEAD as of the run.*: src\/a\.ts/);
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('red: a later commit touching a test file the run ran stales it', async () => {
    const c = movedOn('src/a.test.ts');
    try {
      expect(await judge(c, [run({ headSha: c.ranHead, treeHash: c.ranTree })])).toMatch(
        /: src\/a\.test\.ts/,
      );
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  /**
   * Review of #2295: the change is packages/a/src/x.ts; main then edits one
   * test input of packages/a (or an unrelated package's manifest).
   */
  function packageMovedOn(path: string) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t13784-pkg-')));
    const git = (...a: string[]): string =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...a], {
        cwd: root,
        encoding: 'utf-8',
      }).trim();
    const files: Record<string, string> = {
      'package.json': '{"name":"root","private":true}\n',
      'packages/a/package.json': '{"name":"@x/a"}\n',
      'packages/a/vitest.config.ts': 'export default {};\n',
      'packages/a/src/test-setup.ts': 'export {};\n',
      'packages/a/src/test/setup.ts': 'export {};\n',
      'packages/a/src/x.ts': 'export const x = 1;\n',
      'packages/a/src/x.test.ts': "import './x.js';\n",
      'packages/b/package.json': '{"name":"@x/b"}\n',
      'packages/b/src/setup-wizard.ts': 'export const w = 1;\n',
      'packages/b/src/b.setup.ts': 'export {};\n',
      'packages/b/src/test/setup.ts': 'export {};\n',
    };
    git('init', '-q', '-b', 'main');
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(join(root, f, '..'), { recursive: true });
      writeFileSync(join(root, f), body);
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    writeFileSync(join(root, 'packages/a/src/x.ts'), 'export const x = 2;\n');
    git('commit', '-q', '-am', 'T9001');
    const ranHead = git('rev-parse', 'HEAD');
    const ranTree = git('rev-parse', 'HEAD^{tree}');
    writeFileSync(join(root, path), `${files[path]?.trimEnd() ?? ''} // moved\n`);
    git('commit', '-q', '-am', `later main commit: ${path}`);
    const tree = git('rev-parse', 'HEAD^{tree}');
    const scope = { root, changed: ['packages/a/src/x.ts'] };
    const atoms = [
      run({ headSha: ranHead, treeHash: ranTree, testFiles: ['packages/a/src/x.test.ts'] }),
    ];
    return { root, verdict: () => testRunTreeMismatchReason(atoms, tree, scope) };
  }

  it.each([
    'packages/a/vitest.config.ts',
    'packages/a/package.json',
    'packages/a/src/test-setup.ts',
    'packages/a/src/test/setup.ts',
  ])("red (review of #2295): a later commit to the package's test input %s stales the run", (path) => {
    const c = packageMovedOn(path);
    try {
      expect(c.verdict()).toMatch(new RegExp(`test inputs.*: ${path.replace(/\./g, '\\.')}`));
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it.each([
    'packages/b/package.json',
    'packages/b/src/setup-wizard.ts',
    'packages/b/src/b.setup.ts',
    'packages/b/src/test/setup.ts',
  ])("green: another package's %s moving on main does not stale the run", (path) => {
    const c = packageMovedOn(path);
    try {
      expect(c.verdict()).toBeNull();
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('red: without the change scope, a moved tree or unseen commits still refuse', () => {
    const c = movedOn('tooling/print-bridge.mjs');
    try {
      expect(
        testRunTreeMismatchReason([run({ headSha: c.ranHead, treeHash: c.ranTree })], c.tree),
      ).toMatch(/but the tree is now/);
      expect(
        testRunTreeMismatchReason(
          [run({ runHeadSha: c.ranHead, headSha: c.head, treeHash: c.tree })],
          c.tree,
        ),
      ).toMatch(/did not see the commits/);
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });
});
