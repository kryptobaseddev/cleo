/**
 * `cleo complete` proves testsPassed/qaPassed from merged CI itself (T12960):
 * merged-and-green records `ci:<pr>`, unmerged leaves the ordinary gate checks
 * in charge, and red or pending CI is a wait-for-CI refusal — never a demand
 * for a local full run.
 *
 * @task T12960
 * @task T12656
 * @task T12965
 */

import type {
  AcRow,
  EvidenceAtom,
  GateEvidence,
  Task,
  TaskChangeSet,
  VerificationGate,
} from '@cleocode/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type EngineResult, engineError, engineSuccess } from '../../engine-result.js';
import type { GateVerifyParams, GateVerifyResult } from '../../validation/engine-ops.js';
import type { TaskMergeInfo } from '../affected-scope.js';
import { isPendingCiReason, type MergedCiDeps, satisfyGatesFromMergedCi } from '../complete-ci.js';

const mergeOverride = vi.hoisted(() => ({
  value: null as null | TaskMergeInfo,
}));

vi.mock('../affected-scope.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../affected-scope.js')>();
  return {
    ...actual,
    taskChangeMergeState: async (
      ...args: Parameters<typeof actual.taskChangeMergeState>
    ): ReturnType<typeof actual.taskChangeMergeState> =>
      mergeOverride.value ?? actual.taskChangeMergeState(...args),
  };
});

afterEach(() => {
  mergeOverride.value = null;
});

const now = '2026-10-01T00:00:00Z';
const REQUIRED: VerificationGate[] = ['implemented', 'testsPassed', 'qaPassed'];
const criterion: AcRow = {
  id: '11111111-1111-4111-8111-111111111111',
  taskId: 'T9001',
  ordinal: 1,
  kind: 'text',
  sourceKey: 'ac1',
  targetTaskId: null,
  projection: 'it works',
  text: 'it works',
  createdAt: now,
  updatedAt: now,
  contentHash: null,
};

function changeSet(over: Partial<TaskChangeSet>): TaskChangeSet {
  return {
    source: 'branch',
    executionRoot: '/nonexistent',
    rootSource: 'store',
    files: [],
    deletedFiles: [],
    docs: [],
    decisions: [],
    candidates: [],
    implementedEvidence: null,
    blockers: [],
    warnings: [],
    ...over,
  };
}

const prAtom: EvidenceAtom = {
  kind: 'pr',
  prNumber: 42,
  mergeCommitSha: 'a'.repeat(40),
  mergedAt: now,
  successCount: 1,
  totalChecks: 1,
};
const affected: EvidenceAtom = {
  kind: 'tool',
  tool: 'test',
  exitCode: 0,
  scope: 'affected',
  affectedPackages: ['@x/a'],
};

function task(opts: { implemented?: EvidenceAtom[]; tests?: EvidenceAtom[]; qa?: boolean }): Task {
  const scope = (gate: VerificationGate): GateEvidence['scope'] => ({
    taskId: 'T9001',
    gate,
    classification: 'code' as const,
    criteria: [
      {
        criterionId: criterion.id,
        criterionHash: 'h',
        artifactPaths: ['src/a.ts'],
        resultAtomIndices: [0],
      },
    ],
  });
  const fixture: Task = {
    id: 'T9001',
    title: 'merged-ci fixture',
    description: 'merged-ci fixture',
    status: 'active',
    priority: 'medium',
    createdAt: now,
    verification: {
      passed: false,
      round: 1,
      gates: {
        implemented: true,
        ...(opts.tests ? { testsPassed: true } : {}),
        ...(opts.qa ? { qaPassed: true } : {}),
      },
      lastAgent: null,
      lastUpdated: now,
      failureLog: [],
      evidence: {
        implemented: {
          atoms: opts.implemented ?? [prAtom],
          capturedAt: now,
          capturedBy: 'test',
          scope: scope('implemented'),
        },
        ...(opts.tests
          ? {
              testsPassed: {
                atoms: opts.tests,
                capturedAt: now,
                capturedBy: 'test',
                scope: scope('testsPassed'),
              },
            }
          : {}),
      },
    },
  };
  return fixture;
}

/** A gate writer that records what it was asked and answers `result`. */
function recorder(result: EngineResult<GateVerifyResult>): {
  calls: GateVerifyParams[];
  recordGates: NonNullable<MergedCiDeps['recordGates']>;
} {
  const calls: GateVerifyParams[] = [];
  return {
    calls,
    recordGates: async (_root, params) => {
      calls.push(params);
      return result;
    },
  };
}

const ok = engineSuccess<GateVerifyResult>({
  taskId: 'T9001',
  verification: {
    passed: true,
    round: 1,
    gates: {},
    lastAgent: null,
    lastUpdated: now,
    failureLog: [],
  },
  verificationStatus: 'passed',
  passed: true,
  round: 1,
  requiredGates: REQUIRED,
  missingGates: [],
});

function deps(extra: Partial<MergedCiDeps> = {}): MergedCiDeps {
  return {
    ciSatisfies: () => true,
    currentTree: () => 'f'.repeat(40),
    acRows: async () => [criterion],
    ...extra,
  };
}

describe('satisfyGatesFromMergedCi', () => {
  it('merged and green: records ci:<pr> for every missing CI gate, with a note and carried-over criteria', async () => {
    const w = recorder(ok);
    const out = await satisfyGatesFromMergedCi(
      task({}),
      '/nonexistent',
      REQUIRED,
      deps({ recordGates: w.recordGates }),
    );
    expect(out).toEqual({ kind: 'recorded', pr: '42', gates: ['testsPassed', 'qaPassed'] });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]?.agent).toBe('cleo-complete');
    for (const gate of ['testsPassed', 'qaPassed'] as const) {
      const ev = w.calls[0]?.gateEvidence?.[gate];
      expect(ev).toMatch(/^ci:42;note:recorded by cleo complete .*PR #42.*;satisfies:T9001#AC1$/);
    }
  });

  it('merged: an affected-only testsPassed is superseded by CI; a standing qaPassed is left alone', async () => {
    const w = recorder(ok);
    const out = await satisfyGatesFromMergedCi(
      task({ tests: [affected], qa: true }),
      '/nonexistent',
      REQUIRED,
      deps({ recordGates: w.recordGates }),
    );
    expect(out).toEqual({ kind: 'recorded', pr: '42', gates: ['testsPassed'] });
    expect(Object.keys(w.calls[0]?.gateEvidence ?? {})).toEqual(['testsPassed']);
  });

  it('pending CI is a wait-for-CI refusal, never a local-run demand', async () => {
    const w = recorder(
      engineError<GateVerifyResult>(
        'E_EVIDENCE_TESTS_FAILED',
        "Required CI on PR #42's merge commit is not green:\n  - CI: pending (in_progress) on aaaaaaaaaaaa",
      ),
    );
    const out = await satisfyGatesFromMergedCi(
      task({ tests: [affected], qa: true }),
      '/nonexistent',
      REQUIRED,
      deps({ recordGates: w.recordGates }),
    );
    expect(out.kind).toBe('wait-for-ci');
    expect(out.kind === 'wait-for-ci' && out.reason).toMatch(/ci:42 does not hold.*in_progress/s);
  });

  it('a final red or a skipped required job is ci-red, never an endless wait', async () => {
    for (const message of [
      "Required CI on PR #42's merge commit is not green:\n  - CI: failure on aaaaaaaaaaaa",
      'testsPassed for code task T9001 needs its jobs to have run on PR #42:\n  - Unit Tests: skipped',
      "Required CI on PR #42's merge commit is not green:\n  - CI: missing",
    ]) {
      const w = recorder(engineError<GateVerifyResult>('E_EVIDENCE_TESTS_FAILED', message));
      const out = await satisfyGatesFromMergedCi(
        task({ tests: [affected], qa: true }),
        '/nonexistent',
        REQUIRED,
        deps({ recordGates: w.recordGates }),
      );
      expect(out.kind, message).toBe('ci-red');
    }
  });

  it('a startup_failure (or any *_failure) beside a pending job is ci-red, never a wait', async () => {
    expect(isPendingCiReason('CI: startup_failure; Lint: pending (queued)')).toBe(false);
    expect(isPendingCiReason('Build: some_new_failure; Test: pending (in_progress)')).toBe(false);
    expect(isPendingCiReason('CI: pending (in_progress)')).toBe(true);
    const w = recorder(
      engineError<GateVerifyResult>(
        'E_EVIDENCE_TESTS_FAILED',
        "Required CI on PR #42's merge commit is not green:\n  - CI: startup_failure on aaaaaaaaaaaa\n  - Lint: pending (queued) on aaaaaaaaaaaa",
      ),
    );
    const out = await satisfyGatesFromMergedCi(
      task({ tests: [affected], qa: true }),
      '/nonexistent',
      REQUIRED,
      deps({ recordGates: w.recordGates }),
    );
    expect(out.kind).toBe('ci-red');
  });

  it('T12959 review HIGH: a fix commit the task-citing PR never ran is not proved by that PR', async () => {
    // T1 shipped in #42; fix commit B landed later on its own. #42's CI never ran B.
    const B = 'b'.repeat(40);
    const w = recorder(ok);
    const out = await satisfyGatesFromMergedCi(
      task({ implemented: [{ kind: 'commit', sha: B, shortSha: 'bbbbbbb' }], tests: [affected] }),
      '/nonexistent',
      REQUIRED,
      deps({
        recordGates: w.recordGates,
        merge: {
          derived: changeSet({ source: 'pr', prNumber: 42, mergeCommitSha: 'a'.repeat(40) }),
          changeSet: {
            viewPr: async (n) => ({
              number: n,
              title: '',
              headRefName: 'task/T9001',
              baseRefName: 'main',
              state: 'MERGED',
              mergedAt: now,
              headRefOid: null,
              mergeCommitSha: 'a'.repeat(40),
              commits: ['c'.repeat(40)],
            }),
            listPrsForCommit: async () => [],
          },
          executionRoot: '/repo',
          contains: () => false,
          equivalent: () => false,
          isLanded: () => true,
        },
      }),
    );
    expect(out.kind).toBe('ci-red');
    expect(out.kind === 'ci-red' && out.reason).toMatch(
      /no merged PR's required CI proves it.*bbbbbbbbbbbb.*PR #42, which cites T9001, does not/,
    );
    expect(w.calls).toHaveLength(0);
  });

  it('merged, but no merged PR passed the pr: check: ci-red with the refusal', async () => {
    mergeOverride.value = {
      state: 'merged',
      prRef: null,
      changeSet: changeSet({
        source: 'branch',
        mergeState: 'merged',
        warnings: ['PR #42 is documentation-only — derived from the task branch instead.'],
      }),
    };
    const w = recorder(ok);
    const out = await satisfyGatesFromMergedCi(
      task({
        implemented: [{ kind: 'commit', sha: 'b'.repeat(40), shortSha: 'bbbbbbb' }],
        tests: [affected],
      }),
      '/nonexistent',
      REQUIRED,
      deps({ recordGates: w.recordGates }),
    );
    expect(out.kind).toBe('ci-red');
    expect(out.kind === 'ci-red' && out.reason).toMatch(/merged.*PR #42 is documentation-only/);
    expect(w.calls).toHaveLength(0);
  });

  it('L1: merged, but a lookup failed: carrier unknown is skipped (retry or tool:test), never "fix CI"', async () => {
    mergeOverride.value = {
      state: 'merged',
      prRef: null,
      changeSet: changeSet({ source: 'branch', mergeState: 'merged' }),
      lookupFailed: 'gh pr view 42 failed (gh unreachable — check `gh auth status`)',
    };
    const w = recorder(ok);
    const out = await satisfyGatesFromMergedCi(
      task({
        implemented: [{ kind: 'commit', sha: 'b'.repeat(40), shortSha: 'bbbbbbb' }],
        tests: [affected],
      }),
      '/nonexistent',
      REQUIRED,
      deps({ recordGates: w.recordGates }),
    );
    expect(out.kind).toBe('skipped');
    expect(out.kind === 'skipped' && out.ciUnavailable).toMatch(
      /merged, but which merged PR carries it cannot be determined \(gh pr view 42 failed \(gh unreachable.*retry, or record tool:test/,
    );
    expect(out.kind === 'skipped' && out.testsPassedReason).toMatch(/scoped run/);
    expect(w.calls).toHaveLength(0);
  });

  it('merged, and the PR checks are still pending: wait for CI', async () => {
    mergeOverride.value = {
      state: 'merged',
      prRef: null,
      changeSet: changeSet({
        source: 'branch',
        mergeState: 'merged',
        warnings: [
          'Required PR checks are still pending: CI (CI). Re-run verify after CI completes.',
        ],
      }),
    };
    const out = await satisfyGatesFromMergedCi(
      task({
        implemented: [{ kind: 'commit', sha: 'b'.repeat(40), shortSha: 'bbbbbbb' }],
        tests: [affected],
      }),
      '/nonexistent',
      REQUIRED,
      deps({ recordGates: recorder(ok).recordGates }),
    );
    expect(out.kind).toBe('wait-for-ci');
  });

  it('the PR that contains the latest implementation is the one recorded', async () => {
    mergeOverride.value = { state: 'merged', prRef: '77', changeSet: null };
    const w = recorder(ok);
    const out = await satisfyGatesFromMergedCi(
      task({
        implemented: [{ kind: 'commit', sha: 'b'.repeat(40), shortSha: 'bbbbbbb' }],
        qa: true,
      }),
      '/nonexistent',
      REQUIRED,
      deps({ recordGates: w.recordGates }),
    );
    expect(out).toEqual({ kind: 'recorded', pr: '77', gates: ['testsPassed'] });
    expect(w.calls[0]?.gateEvidence?.testsPassed).toMatch(/^ci:77;/);
  });

  it('unmerged: nothing is recorded and a scoped testsPassed still stands', async () => {
    mergeOverride.value = { state: 'unmerged', prRef: null, changeSet: null };
    const w = recorder(ok);
    const out = await satisfyGatesFromMergedCi(
      task({
        implemented: [prAtom, { kind: 'commit', sha: 'b'.repeat(40), shortSha: 'bbbbbbb' }],
        tests: [affected],
      }),
      '/nonexistent',
      REQUIRED,
      deps({ recordGates: w.recordGates }),
    );
    expect(out).toEqual({ kind: 'skipped', testsPassedReason: null });
    expect(w.calls).toHaveLength(0);
  });

  it('a test-run whose tree moved is superseded by merged CI (T12965)', async () => {
    const bound: EvidenceAtom = {
      kind: 'test-run',
      path: 'r.json',
      sha256: 'c'.repeat(64),
      passCount: 3,
      failCount: 0,
      skipCount: 0,
      treeHash: 'e'.repeat(40),
    };
    const w = recorder(ok);
    const out = await satisfyGatesFromMergedCi(
      task({ tests: [bound], qa: true }),
      '/nonexistent',
      REQUIRED,
      deps({ recordGates: w.recordGates }),
    );
    expect(out).toEqual({ kind: 'recorded', pr: '42', gates: ['testsPassed'] });
  });

  it('without ciSatisfies, a superseded testsPassed is reported for the ordinary refusal', async () => {
    const w = recorder(ok);
    const out = await satisfyGatesFromMergedCi(
      task({ tests: [affected], qa: true }),
      '/nonexistent',
      REQUIRED,
      deps({ recordGates: w.recordGates, ciSatisfies: () => false }),
    );
    expect(out.kind).toBe('skipped');
    expect(out.kind === 'skipped' && out.testsPassedReason).toMatch(/scoped run/);
    expect(w.calls).toHaveLength(0);
  });

  it('standing gates pay nothing', async () => {
    const full: EvidenceAtom = { kind: 'tool', tool: 'test', exitCode: 0, scope: 'full' };
    const out = await satisfyGatesFromMergedCi(
      task({ tests: [full], qa: true }),
      '/nonexistent',
      REQUIRED,
      deps({
        recordGates: async () => {
          throw new Error('must not write');
        },
        ciSatisfies: () => {
          throw new Error('must not read config');
        },
      }),
    );
    expect(out).toEqual({ kind: 'skipped', testsPassedReason: null });
  });
});
