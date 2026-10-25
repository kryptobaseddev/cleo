/**
 * `cleo complete` proves testsPassed/qaPassed from merged CI itself (T12960):
 * merged-and-green records `ci:<pr>`, unmerged leaves the ordinary gate checks
 * in charge, and red or pending CI is a wait-for-CI refusal — never a demand
 * for a local full run.
 *
 * @task T12960
 * @task T12656
 * @task T12965
 * @task T13644
 * @task T14026
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const standsOverride = vi.hoisted(() => ({
  value: null as null | { ok: true } | { ok: false; why: string },
}));

vi.mock('../affected-scope.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../affected-scope.js')>();
  return {
    ...actual,
    taskChangeMergeState: async (
      ...args: Parameters<typeof actual.taskChangeMergeState>
    ): ReturnType<typeof actual.taskChangeMergeState> =>
      mergeOverride.value ?? actual.taskChangeMergeState(...args),
    scopedRunStandsAfterRedCi: (...args: Parameters<typeof actual.scopedRunStandsAfterRedCi>) =>
      standsOverride.value ?? actual.scopedRunStandsAfterRedCi(...args),
  };
});

afterEach(() => {
  mergeOverride.value = null;
  standsOverride.value = null;
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

function task(opts: {
  implemented?: EvidenceAtom[];
  tests?: EvidenceAtom[];
  qa?: boolean | EvidenceAtom[];
}): Task {
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
        ...(Array.isArray(opts.qa)
          ? {
              qaPassed: {
                atoms: opts.qa,
                capturedAt: now,
                capturedBy: 'test',
                scope: scope('qaPassed'),
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
    // T13515: complete's write never executes typed gate commands.
    expect(w.calls[0]?.noRun).toBe(true);
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

  describe('red merged CI with a test-run recorded on main after the merge (T13623)', () => {
    const afterMerge: EvidenceAtom = {
      kind: 'test-run',
      path: 'r.json',
      sha256: 'c'.repeat(64),
      passCount: 3,
      failCount: 0,
      skipCount: 0,
      headSha: 'b'.repeat(40),
      treeHash: 'f'.repeat(40),
      testFiles: ['src/a.test.ts'],
    };
    const red = () =>
      recorder(
        engineError<GateVerifyResult>(
          'E_EVIDENCE_TESTS_FAILED',
          "Required CI on PR #42's merge commit is not green:\n  - CI: failure",
        ),
      );
    const merged = () => {
      mergeOverride.value = {
        state: 'merged',
        prRef: '42',
        changeSet: changeSet({
          source: 'pr',
          prNumber: 42,
          mergeState: 'merged',
          mergeCommitSha: 'a'.repeat(40),
          files: ['src/a.ts', 'src/a.test.ts'],
        }),
      };
    };

    it('stands in for testsPassed when it covers the change, so nothing is refused', async () => {
      merged();
      standsOverride.value = { ok: true };
      const w = red();
      const out = await satisfyGatesFromMergedCi(
        task({ tests: [afterMerge], qa: true }),
        '/nonexistent',
        REQUIRED,
        deps({ recordGates: w.recordGates }),
      );
      expect(out).toEqual({ kind: 'skipped', testsPassedReason: null, qaPassedReason: null });
      expect(w.calls).toHaveLength(1);
    });

    it('stays ci-red and says why the run cannot stand in', async () => {
      merged();
      standsOverride.value = { ok: false, why: 'the test-run did not run src/a.test.ts' };
      const out = await satisfyGatesFromMergedCi(
        task({ tests: [afterMerge], qa: true }),
        '/nonexistent',
        REQUIRED,
        deps({ recordGates: red().recordGates }),
      );
      expect(out.kind).toBe('ci-red');
      expect(out.kind === 'ci-red' && out.reason).toMatch(
        /^the test-run did not run src\/a\.test\.ts\. The ci:42 fallback also does not hold: Required CI on PR #42's merge commit is not green:.*CI: failure\. A targeted test-run recorded on the default branch after the merge.*stands in for testsPassed \(T13623\)$/s,
      );
    });

    it('still refuses when qaPassed also needs evidence', async () => {
      merged();
      standsOverride.value = { ok: true };
      const out = await satisfyGatesFromMergedCi(
        task({ tests: [afterMerge] }),
        '/nonexistent',
        REQUIRED,
        deps({ recordGates: red().recordGates }),
      );
      expect(out.kind === 'ci-red' && out.reason).toMatch(/^qaPassed still needs evidence/);
    });
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
    expect(out).toEqual({ kind: 'skipped', testsPassedReason: null, qaPassedReason: null });
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

  describe('a qa-run receipt whose tree moved (T13427)', () => {
    const qa = (treeHash: string): EvidenceAtom[] => [
      {
        kind: 'qa-run',
        path: 'r/typecheck.json',
        sha256: 'c'.repeat(64),
        check: 'typecheck',
        command: ['tsc'],
        roots: ['src'],
        treeHash,
      },
      { kind: 'tool', tool: 'lint', exitCode: 0 },
    ];
    const full: EvidenceAtom = { kind: 'tool', tool: 'test', exitCode: 0, scope: 'full' };

    it('is superseded by merged CI', async () => {
      const w = recorder(ok);
      const out = await satisfyGatesFromMergedCi(
        task({ tests: [full], qa: qa('e'.repeat(40)) }),
        '/nonexistent',
        REQUIRED,
        deps({ recordGates: w.recordGates }),
      );
      expect(out).toEqual({ kind: 'recorded', pr: '42', gates: ['qaPassed'] });
    });

    it('without ciSatisfies, is reported for the ordinary refusal', async () => {
      const out = await satisfyGatesFromMergedCi(
        task({ tests: [full], qa: qa('e'.repeat(40)) }),
        '/nonexistent',
        REQUIRED,
        deps({ ciSatisfies: () => false }),
      );
      expect(out.kind === 'skipped' && out.qaPassedReason).toMatch(
        /qaPassed rests on qa-run:r\/typecheck\.json.*no longer describes this code/,
      );
    });

    it('stands while its tree matches', async () => {
      const out = await satisfyGatesFromMergedCi(
        task({ tests: [full], qa: qa('f'.repeat(40)) }),
        '/nonexistent',
        REQUIRED,
        deps({
          recordGates: async () => {
            throw new Error('must not write');
          },
        }),
      );
      expect(out).toEqual({ kind: 'skipped', testsPassedReason: null, qaPassedReason: null });
    });
  });

  describe('T13644: qa-run receipts on main after the merge stand in for red merged CI (T13224 shape)', () => {
    /**
     * T13224 / PR #1910: the change edits src/a.ts and its test, merges, CI on
     * the merge is red (cancelled, then environmental), and main then edits
     * src/a.ts again, so byte-identity carry fails. Test-run and qa-run
     * receipts are recorded on the newest main HEAD.
     */
    function landed() {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t13644-')));
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
      git('add', '.');
      git('commit', '-q', '-m', 'init');
      git('switch', '-q', '-c', 'task/T9001');
      writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n');
      writeFileSync(join(root, 'src/a.test.ts'), "import './a.js'; // 2\n");
      git('commit', '-q', '-am', 'T9001');
      const branchHead = git('rev-parse', 'HEAD');
      git('switch', '-q', 'main');
      git('merge', '-q', '--no-ff', '-m', 'Merge pull request #42', 'task/T9001');
      const merge = git('rev-parse', 'HEAD');
      writeFileSync(join(root, 'src/a.ts'), 'export const a = 3;\n');
      git('commit', '-q', '-am', 'a later PR edits a.ts');
      const head = git('rev-parse', 'HEAD');
      const tree = git('rev-parse', 'HEAD^{tree}');
      git('update-ref', 'refs/remotes/origin/main', head);
      mergeOverride.value = {
        state: 'merged',
        prRef: '42',
        changeSet: changeSet({
          source: 'pr',
          executionRoot: root,
          prNumber: 42,
          mergeState: 'merged',
          mergeCommitSha: merge,
          files: ['src/a.test.ts', 'src/a.ts'],
        }),
      };
      return { root, head, tree, branchHead };
    }
    const testRun = (headSha: string, treeHash: string): EvidenceAtom => ({
      kind: 'test-run',
      path: 'r.json',
      sha256: 'c'.repeat(64),
      passCount: 1,
      failCount: 0,
      skipCount: 0,
      headSha,
      treeHash,
      testFiles: ['src/a.test.ts'],
    });
    const qaRun = (
      check: 'typecheck' | 'lint',
      headSha: string,
      treeHash: string,
      roots = ['src'],
    ): EvidenceAtom => ({
      kind: 'qa-run',
      path: `${check}.json`,
      sha256: 'c'.repeat(64),
      check,
      command: [check === 'lint' ? 'biome' : 'tsc'],
      roots,
      headSha,
      treeHash,
    });
    const red = () =>
      recorder(
        engineError<GateVerifyResult>(
          'E_EVIDENCE_TESTS_FAILED',
          "Required CI on PR #42's merge commit is not green:\n  - CI: cancelled",
        ),
      );

    it('carries: a typecheck and a lint qa-run on a descendant main HEAD, covering the change, stand for qaPassed', async () => {
      const c = landed();
      try {
        const w = red();
        const out = await satisfyGatesFromMergedCi(
          task({
            tests: [testRun(c.head, c.tree)],
            qa: [qaRun('typecheck', c.head, c.tree), qaRun('lint', c.head, c.tree)],
          }),
          '/nonexistent',
          REQUIRED,
          deps({ recordGates: w.recordGates, currentTree: () => c.tree }),
        );
        expect(out).toEqual({ kind: 'skipped', testsPassedReason: null, qaPassedReason: null });
        expect(w.calls).toHaveLength(0);
      } finally {
        rmSync(c.root, { recursive: true, force: true });
      }
    });

    it('refuses receipts recorded on a commit that does not descend from the merge', async () => {
      const c = landed();
      try {
        const out = await satisfyGatesFromMergedCi(
          task({
            tests: [testRun(c.head, c.tree)],
            qa: [qaRun('typecheck', c.branchHead, c.tree), qaRun('lint', c.branchHead, c.tree)],
          }),
          '/nonexistent',
          REQUIRED,
          deps({ recordGates: red().recordGates, currentTree: () => c.tree }),
        );
        expect(out.kind).toBe('ci-red');
        expect(out.kind === 'ci-red' && out.reason).toMatch(
          /^qaPassed still needs evidence \(qaPassed rests on qa-run receipts.*qa-run:typecheck\.json was recorded at \w+, which does not descend from merge commit.*The ci:42 fallback also does not hold: .*CI: cancelled/s,
        );
      } finally {
        rmSync(c.root, { recursive: true, force: true });
      }
    });

    it('refuses receipts whose roots do not cover the change', async () => {
      const c = landed();
      try {
        const out = await satisfyGatesFromMergedCi(
          task({
            tests: [testRun(c.head, c.tree)],
            qa: [
              qaRun('typecheck', c.head, c.tree, ['lib']),
              qaRun('lint', c.head, c.tree, ['src']),
            ],
          }),
          '/nonexistent',
          REQUIRED,
          deps({ recordGates: red().recordGates, currentTree: () => c.tree }),
        );
        expect(out.kind === 'ci-red' && out.reason).toMatch(
          /qa-run typecheck receipt \(roots lib\) does not cover the changed path\(s\) src\/a\.test\.ts, src\/a\.ts/,
        );
      } finally {
        rmSync(c.root, { recursive: true, force: true });
      }
    });

    it('without ciSatisfies, a non-descendant receipt is the ordinary qaPassed refusal', async () => {
      const c = landed();
      try {
        const out = await satisfyGatesFromMergedCi(
          task({
            tests: [testRun(c.head, c.tree)],
            qa: [qaRun('typecheck', c.branchHead, c.tree), qaRun('lint', c.branchHead, c.tree)],
          }),
          '/nonexistent',
          REQUIRED,
          deps({ ciSatisfies: () => false, currentTree: () => c.tree }),
        );
        expect(out.kind === 'skipped' && out.qaPassedReason).toMatch(/does not descend/);
      } finally {
        rmSync(c.root, { recursive: true, force: true });
      }
    });
  });

  describe('T14026: pr: + test-run + tool:lint, red merge CI (the T740 / PR #160 shape)', () => {
    /**
     * T740: implemented rests on a recorded pr:160 atom alone (no commit
     * atoms, so no change set is derived), CI on merge commit 7e517edf5464 is
     * red, and testsPassed is a test-run recorded on the default branch after
     * the merge, qaPassed a tool:lint run.
     */
    function landed() {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t14026-')));
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
      writeFileSync(join(root, 'src/b.test.ts'), 'export {};\n');
      git('add', '.');
      git('commit', '-q', '-m', 'init');
      git('switch', '-q', '-c', 'task/T9001');
      writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n');
      writeFileSync(join(root, 'src/a.test.ts'), "import './a.js'; // 2\n");
      git('commit', '-q', '-am', 'T9001');
      git('switch', '-q', 'main');
      git('merge', '-q', '--no-ff', '-m', 'Merge pull request #160', 'task/T9001');
      const merge = git('rev-parse', 'HEAD');
      // A later PR edits a.ts again, so byte-identity carry fails and only the
      // later-main stand-in can hold.
      writeFileSync(join(root, 'src/a.ts'), 'export const a = 3;\n');
      git('commit', '-q', '-am', 'a later PR');
      const head = git('rev-parse', 'HEAD');
      const tree = git('rev-parse', 'HEAD^{tree}');
      git('update-ref', 'refs/remotes/origin/main', head);
      const pr: EvidenceAtom = {
        kind: 'pr',
        prNumber: 160,
        mergeCommitSha: merge,
        mergedAt: now,
        successCount: 1,
        totalChecks: 2,
        changedPaths: ['src/a.test.ts', 'src/a.ts'],
      };
      return { root, head, tree, pr };
    }
    const testRun = (
      headSha: string,
      treeHash: string,
      testFiles = ['src/a.test.ts'],
    ): EvidenceAtom => ({
      kind: 'test-run',
      path: 'r.json',
      sha256: 'c'.repeat(64),
      passCount: 1,
      failCount: 0,
      skipCount: 0,
      headSha,
      treeHash,
      testFiles,
    });
    const lint: EvidenceAtom = { kind: 'tool', tool: 'lint', exitCode: 0 };
    const red = () =>
      recorder(
        engineError<GateVerifyResult>(
          'E_EVIDENCE_TESTS_FAILED',
          "Required CI on PR #160's merge commit is not green:\n  - Doppler secrets (dev): failure",
        ),
      );

    it('a covering test-run on main after the merge and tool:lint stand: complete never re-derives ci:<pr>', async () => {
      const c = landed();
      try {
        const w = red();
        const out = await satisfyGatesFromMergedCi(
          task({ implemented: [c.pr], tests: [testRun(c.head, c.tree)], qa: [lint] }),
          c.root,
          REQUIRED,
          deps({
            recordGates: w.recordGates,
            currentTree: () => c.tree,
            merge: { executionRoot: c.root },
          }),
        );
        expect(out).toEqual({ kind: 'skipped', testsPassedReason: null, qaPassedReason: null });
        expect(w.calls).toHaveLength(0);
      } finally {
        rmSync(c.root, { recursive: true, force: true });
      }
    });

    it('a run that cannot stand in is refused with its own reason, judged at the merge the pr: atom names', async () => {
      const c = landed();
      try {
        const w = red();
        const out = await satisfyGatesFromMergedCi(
          task({
            implemented: [c.pr],
            tests: [testRun(c.head, c.tree, ['src/b.test.ts'])],
            qa: [lint],
          }),
          c.root,
          REQUIRED,
          deps({
            recordGates: w.recordGates,
            currentTree: () => c.tree,
            merge: { executionRoot: c.root },
          }),
        );
        expect(w.calls).toHaveLength(1);
        expect(out.kind).toBe('ci-red');
        const reason = out.kind === 'ci-red' ? out.reason : '';
        expect(reason).not.toMatch(/merge commit is not known here/);
        expect(reason).toMatch(
          /^test-run report does not run the change.*src\/a\.test\.ts.*\. The ci:160 fallback also does not hold: .*Doppler secrets \(dev\): failure\./s,
        );
      } finally {
        rmSync(c.root, { recursive: true, force: true });
      }
    });
  });

  describe("T14026: the escapeplan PR #160 history (later merges edit the PR's files)", () => {
    /**
     * PR #160 (T740) adds form primitives, two test files and a changeset to
     * the escapeplan-web app of a pnpm workspace. Later PRs (#169, #172, #188,
     * #202, #226) edit five of its files again before the test-run is
     * recorded on the development HEAD, so byte-identity carry fails.
     */
    const FORM = 'apps/web/src/lib/components/form';
    function history() {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t14026-ep-')));
      const git = (...a: string[]): string =>
        execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...a], {
          cwd: root,
          encoding: 'utf-8',
        }).trim();
      const write = (path: string, body: string): void => {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), body);
      };
      const mergePr = (n: number, branch: string, edit: () => void, subject: string): string => {
        git('switch', '-q', '-c', branch);
        edit();
        git('add', '.');
        git('commit', '-q', '-m', subject);
        git('switch', '-q', 'development');
        git('merge', '-q', '--no-ff', '-m', `Merge pull request #${n} from o/${branch}`, branch);
        return git('rev-parse', 'HEAD');
      };
      git('init', '-q', '-b', 'development');
      write('package.json', '{"name":"escapeplan","private":true}\n');
      write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n');
      write('apps/web/package.json', '{"name":"escapeplan-web","type":"module"}\n');
      write('apps/web/src/app.css', ':root{}\n');
      write('packages/contracts/package.json', '{"name":"@escapeplan/contracts"}\n');
      write('packages/contracts/src/index.ts', 'export {};\n');
      git('add', '.');
      git('commit', '-q', '-m', 'init');
      const merge = mergePr(
        160,
        'feat/T733-form-fields',
        () => {
          write('.changeset/t733-form-fields.md', '---\n---\nform fields\n');
          write('apps/web/src/app.css', ':root{--a:1}\n');
          for (const f of ['FieldShell.svelte', 'TextField.svelte', 'form.css', 'index.ts'])
            write(`${FORM}/${f}`, `// ${f} v1\n`);
          write(`${FORM}/format.ts`, 'export const f = 1;\n');
          write(`${FORM}/format.test.ts`, "import './format.js';\n");
          write(`${FORM}/fields.test.ts`, "import './index.js';\n");
          write('apps/web/src/routes/dev/forms/+page.svelte', '<p>v1</p>\n');
        },
        'feat(T9001): floating-label form field primitives',
      );
      const changed = git('diff', '--name-only', `${merge}^1`, merge).split('\n');
      let n = 169;
      for (const f of [
        'apps/web/src/app.css',
        `${FORM}/FieldShell.svelte`,
        `${FORM}/form.css`,
        `${FORM}/index.ts`,
        'apps/web/src/routes/dev/forms/+page.svelte',
      ])
        mergePr(
          n,
          `feat/T7${n}`,
          () => write(f, `// later edit by #${n}\n`),
          `feat(T7${n++}): later`,
        );
      const head = git('rev-parse', 'HEAD');
      const tree = git('rev-parse', 'HEAD^{tree}');
      git('update-ref', 'refs/remotes/origin/development', head);
      git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/development');
      const pr: EvidenceAtom = {
        kind: 'pr',
        prNumber: 160,
        mergeCommitSha: merge,
        mergedAt: now,
        successCount: 1,
        totalChecks: 2,
        changedPaths: changed,
      };
      return { root, git, write, head, tree, pr };
    }
    const testRun = (headSha: string, treeHash: string): EvidenceAtom => ({
      kind: 'test-run',
      path: '/tmp/vitest.json',
      sha256: 'c'.repeat(64),
      passCount: 9,
      failCount: 0,
      skipCount: 0,
      headSha,
      treeHash,
      testFiles: [`${FORM}/fields.test.ts`, `${FORM}/format.test.ts`],
    });
    const lint: EvidenceAtom = { kind: 'tool', tool: 'lint', exitCode: 0 };
    const red = () =>
      recorder(
        engineError<GateVerifyResult>(
          'E_EVIDENCE_TESTS_FAILED',
          "Required CI on PR #160's merge commit is not green:\n  - Doppler secrets (dev): failure",
        ),
      );

    it("a run of the PR's test files on the development HEAD stands in, though later merges edited its files", async () => {
      const c = history();
      try {
        const w = red();
        const out = await satisfyGatesFromMergedCi(
          task({ implemented: [c.pr], tests: [testRun(c.head, c.tree)], qa: [lint] }),
          c.root,
          REQUIRED,
          deps({
            recordGates: w.recordGates,
            currentTree: () => c.tree,
            merge: { executionRoot: c.root },
          }),
        );
        expect(out).toEqual({ kind: 'skipped', testsPassedReason: null, qaPassedReason: null });
        expect(w.calls).toHaveLength(0);
      } finally {
        rmSync(c.root, { recursive: true, force: true });
      }
    });

    it("a run recorded before a later merge edited the PR's files no longer stands, and says which file moved", async () => {
      const c = history();
      try {
        c.write(`${FORM}/FieldShell.svelte`, '// edited after the run by #230\n');
        c.git('commit', '-q', '-am', 'feat(T7230): after the run');
        const now2 = c.git('rev-parse', 'HEAD');
        const tree2 = c.git('rev-parse', 'HEAD^{tree}');
        c.git('update-ref', 'refs/remotes/origin/development', now2);
        const out = await satisfyGatesFromMergedCi(
          task({ implemented: [c.pr], tests: [testRun(c.head, c.tree)], qa: [lint] }),
          c.root,
          REQUIRED,
          deps({
            recordGates: red().recordGates,
            currentTree: () => tree2,
            merge: { executionRoot: c.root },
          }),
        );
        expect(out.kind).toBe('ci-red');
        expect(out.kind === 'ci-red' && out.reason).toMatch(
          /^testsPassed rests on test-run:\/tmp\/vitest\.json, but the change's files.*differ between the tree it was recorded on .*FieldShell\.svelte.*\. The ci:160 fallback also does not hold: Required CI on PR #160's merge commit is not green:.*Doppler secrets \(dev\): failure\./s,
        );
      } finally {
        rmSync(c.root, { recursive: true, force: true });
      }
    });
  });

  it('T13516: a typed-gate cache refusal names cleo verify --run, not --no-run', async () => {
    const out = await satisfyGatesFromMergedCi(
      task({}),
      '/nonexistent',
      REQUIRED,
      deps({
        recordGates: async () =>
          engineError(
            'E_GATE_CACHE_DISABLED',
            'this project sets evidence.allowCachedGates to false; drop --no-run to verify',
          ) as never,
      }),
    );
    expect(out.kind).toBe('skipped');
    const why = out.kind === 'skipped' ? (out.ciUnavailable ?? '') : '';
    expect(why).toContain('cleo verify T9001 --run');
    expect(why).not.toMatch(/--no-run/);
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
    expect(out).toEqual({ kind: 'skipped', testsPassedReason: null, qaPassedReason: null });
  });
});
