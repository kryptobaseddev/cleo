/**
 * The one rule for when an affected-scope `testsPassed` stops counting
 * (owner decision D11150): before merge only. Shared by `cleo done` planning
 * and `cleo complete`.
 *
 * @task T12656
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceAtom, Task, TaskChangeSet } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import {
  isScopedOnly,
  mergeStateOfChangeSet,
  scopedRunSupersededReason,
  taskChangeMergeState,
  testRunTreeMismatchReason,
  testsPassedSupersededReason,
} from '../affected-scope.js';
import { type ChangeSetDeps, hasPatchEquivalent } from '../change-set.js';

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
