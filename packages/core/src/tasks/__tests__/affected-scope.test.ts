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
  affectedScopeSupersededReason,
  isAffectedOnly,
  mergeStateOfChangeSet,
  taskAffectedScopeSupersededReason,
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

describe('affectedScopeSupersededReason', () => {
  it('an affected-only result stands before merge and not after', () => {
    expect(affectedScopeSupersededReason([affected], 'unmerged')).toBeNull();
    expect(affectedScopeSupersededReason([affected], 'merged')).toMatch(/ci:<pr>.*tool:test/);
  });

  it('fails closed when the merge state is unknown', () => {
    expect(affectedScopeSupersededReason([affected], 'unknown')).toMatch(/before merge only/);
  });

  it('a full tool:test or ci: result keeps testsPassed standing after merge', () => {
    expect(affectedScopeSupersededReason([affected, fullTest], 'merged')).toBeNull();
    expect(isAffectedOnly([fullTest])).toBe(false);
    expect(isAffectedOnly([])).toBe(false);
  });

  it('a merged-PR change set is merged; a failed PR lookup is unknown', () => {
    expect(mergeStateOfChangeSet({ source: 'pr' })).toBe('merged');
    expect(mergeStateOfChangeSet({ source: 'branch', prDiscoveryFailed: true })).toBe('unknown');
    expect(mergeStateOfChangeSet({ source: 'branch' })).toBe('unmerged');
  });
});

describe('taskAffectedScopeSupersededReason', () => {
  const noCall: ChangeSetDeps = {
    listMergedPrs: async () => {
      throw new Error('must not derive the change set');
    },
  };

  it('a recorded pr: implemented atom proves the merge without deriving anything', async () => {
    const t = task(
      [affected],
      [
        {
          kind: 'pr',
          prNumber: 42,
          mergeCommitSha: 'a'.repeat(40),
          mergedAt: '2026-09-28T00:00:00Z',
          successCount: 1,
          totalChecks: 1,
        },
      ],
    );
    expect(await taskAffectedScopeSupersededReason(t, '/nonexistent', noCall)).toMatch(/merged/);
  });

  it('a task whose testsPassed is not affected-only pays nothing', async () => {
    expect(await taskAffectedScopeSupersededReason(task([fullTest]), '/nonexistent', noCall)).toBe(
      null,
    );
  });

  it('when the merged-PR lookup fails, an affected-only testsPassed does not stand', async () => {
    const failing: ChangeSetDeps = {
      listMergedPrs: async () => ({ ok: false, reason: 'gh unavailable' }),
      listTaskDocs: async () => [],
      listTaskDecisions: async () => [],
      env: {},
    };
    expect(
      await taskAffectedScopeSupersededReason(task([affected]), '/nonexistent', failing),
    ).toMatch(/before merge only/);
  });
});
