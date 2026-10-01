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
import type { ChangeMergeState } from '../affected-scope.js';
import type { ChangeSetDeps } from '../change-set.js';
import { type MergedCiDeps, satisfyGatesFromMergedCi } from '../complete-ci.js';

const mergeOverride = vi.hoisted(() => ({
  value: null as null | { state: ChangeMergeState; changeSet: TaskChangeSet | null },
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

  it('red or pending CI is a wait-for-CI refusal, never a local-run demand', async () => {
    const w = recorder(
      engineError<GateVerifyResult>(
        'E_EVIDENCE_TESTS_FAILED',
        "Required CI on PR #42's merge commit is not green: CI: in_progress",
      ),
    );
    const out = await satisfyGatesFromMergedCi(
      task({ tests: [affected], qa: true }),
      '/nonexistent',
      REQUIRED,
      deps({ recordGates: w.recordGates }),
    );
    expect(out.kind).toBe('wait-for-ci');
    expect(out.kind === 'wait-for-ci' && out.reason).toMatch(/ci:42 does not hold.*in_progress/);
  });

  it('merged, but the PR behind the change set was refused: wait for CI', async () => {
    mergeOverride.value = {
      state: 'merged',
      changeSet: changeSet({
        source: 'branch',
        mergeState: 'merged',
        warnings: ['PR #42 failed the pr: check — derived from the task branch instead.'],
        blockers: [],
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
    expect(out.kind).toBe('wait-for-ci');
    expect(out.kind === 'wait-for-ci' && out.reason).toMatch(/merged.*PR #42 failed the pr: check/);
    expect(w.calls).toHaveLength(0);
  });

  it('a change set from a merged PR supplies the PR when no pr: atom is recorded', async () => {
    mergeOverride.value = {
      state: 'merged',
      changeSet: changeSet({
        source: 'pr',
        prNumber: 77,
        warnings: [],
        blockers: [],
      }),
    };
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
  });

  it('unmerged: nothing is recorded and an affected-only testsPassed still stands', async () => {
    const unmerged: ChangeSetDeps = {
      listMergedPrs: async () => ({ ok: true, prs: [] }),
      listTaskDocs: async () => [],
      listTaskDecisions: async () => [],
      env: {},
    };
    const w = recorder(ok);
    const out = await satisfyGatesFromMergedCi(
      task({
        implemented: [{ kind: 'commit', sha: 'b'.repeat(40), shortSha: 'bbbbbbb' }],
        tests: [affected],
      }),
      '/nonexistent',
      REQUIRED,
      deps({ recordGates: w.recordGates, changeSet: unmerged }),
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
    expect(out.kind === 'skipped' && out.testsPassedReason).toMatch(/affected-scope run/);
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
