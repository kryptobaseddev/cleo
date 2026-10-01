/**
 * The one rule for when an affected-scope `testsPassed` stops counting
 * (owner decision D11150): before merge only. Shared by `cleo done` planning
 * and `cleo complete`.
 *
 * @task T12656
 */

import type { EvidenceAtom, Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import {
  isScopedOnly,
  mergeStateOfChangeSet,
  scopedRunSupersededReason,
  taskChangeMergeState,
  testRunTreeMismatchReason,
  testsPassedSupersededReason,
} from '../affected-scope.js';
import type { ChangeSetDeps } from '../change-set.js';

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
  const noDerive: ChangeSetDeps = {
    listMergedPrs: async () => {
      throw new Error('must not derive the change set');
    },
  };

  it('a recorded commit that has not landed means unmerged, whatever PR merged earlier', async () => {
    const t = task([affected], [pr(42, '2026-09-01T00:00:00Z'), commit('f'.repeat(40))]);
    const info = await taskChangeMergeState(t, '/nonexistent', {
      changeSet: noDerive,
      executionRoot: '/repo',
      isLanded: () => false,
      contains: () => true,
    });
    expect(info).toEqual({ state: 'unmerged', changeSet: null, prRef: null });
  });

  it('picks the newest merged PR that contains every recorded commit', async () => {
    const t = task(
      [affected],
      [pr(50, '2026-09-02T00:00:00Z'), pr(42, '2026-09-01T00:00:00Z'), commit('f'.repeat(40))],
    );
    const info = await taskChangeMergeState(t, '/nonexistent', {
      changeSet: noDerive,
      executionRoot: '/repo',
      isLanded: () => true,
      contains: (_r, _a, merge) => merge.endsWith('42'),
    });
    expect(info).toMatchObject({ state: 'merged', prRef: '42' });
  });

  it('pr atoms alone: the newest by mergedAt, not the last recorded', async () => {
    const t = task([affected], [pr(50, '2026-09-02T00:00:00Z'), pr(42, '2026-09-01T00:00:00Z')]);
    const info = await taskChangeMergeState(t, '/nonexistent', { changeSet: noDerive });
    expect(info).toMatchObject({ state: 'merged', prRef: '50' });
  });

  it('commits that landed without a recorded PR are merged (fail closed for scoped evidence)', async () => {
    const t = task([affected], [commit('f'.repeat(40))]);
    const info = await taskChangeMergeState(t, '/nonexistent', {
      changeSet: {
        listMergedPrs: async () => ({ ok: true, prs: [] }),
        listTaskDocs: async () => [],
        listTaskDecisions: async () => [],
        env: {},
      },
      executionRoot: '/repo',
      isLanded: () => true,
      contains: () => false,
    });
    expect(info.state).toBe('merged');
    expect(info.prRef).toBeNull();
    expect(
      scopedRunSupersededReason(t.verification?.evidence?.testsPassed?.atoms ?? [], info.state),
    ).toMatch(/merged change needs merged CI/);
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
