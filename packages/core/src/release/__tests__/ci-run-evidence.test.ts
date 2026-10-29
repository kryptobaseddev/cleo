/**
 * `ci-run:` evidence (T14149): a green repeat-run.yml run on the default
 * branch, cross-checked against its uploaded report, relevant to the task,
 * and containing the task's implemented commit. GitHub is injected; no network.
 *
 * @task T14149
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceAtom } from '@cleocode/contracts';
import { parseEvidenceString, validateEvidenceForGate } from '@cleocode/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boundHeadGapReason } from '../../tasks/evidence.js';
import {
  type CiRunRecord,
  type RepeatReport,
  recheckCiRunAtom,
  resolveCiRunEvidenceAtom,
} from '../ci-run-evidence.js';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
}

let repo: string;
let base: string;
let work: string;

beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-ci-run-evidence-')));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(repo, 'base.ts'), 'export const v = 0;\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
  base = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'work.ts'), 'export const v = 1;\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'T13047: work']);
  work = git(repo, ['rev-parse', 'HEAD']);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

const roots = () => ({ storeRoot: repo, executionRoot: repo });

/** T13047 AC2's shape: 50 consecutive process-exit-no-hang runs. */
const TEST = 'packages/core/src/resources/__tests__/process-exit-no-hang.test.ts';
const RUN_ID = 40812345678;

const record = (over: Partial<CiRunRecord> = {}): CiRunRecord => ({
  path: '.github/workflows/repeat-run.yml',
  event: 'workflow_dispatch',
  headBranch: 'main',
  headSha: work,
  status: 'completed',
  conclusion: 'success',
  attempt: 1,
  displayTitle: `repeat-run ${TEST} x50`,
  defaultBranch: 'main',
  ...over,
});

const report = (over: Partial<RepeatReport> = {}): RepeatReport => ({
  test: TEST,
  runs: 50,
  sha: work,
  iterations: Array.from({ length: 50 }, (_, i) => ({
    run: i + 1,
    exitCode: 0,
    numPassedTests: 3,
    numFailedTests: 0,
  })),
  ...over,
});

const resolve = (
  run: CiRunRecord = record(),
  rep: RepeatReport | null = report(),
  opts: { changedPaths?: string[]; criteriaTexts?: string[] } = {},
) =>
  resolveCiRunEvidenceAtom(RUN_ID, roots(), {
    taskId: 'T13047',
    changedPaths: opts.changedPaths ?? [TEST],
    criteriaTexts: opts.criteriaTexts ?? [],
    fetchRun: () => run,
    fetchReport: () => rep,
  });

describe('ci-run: atom parsing (T14149)', () => {
  it('parses ci-run:<runId> and refuses a non-integer id', () => {
    expect(parseEvidenceString(`ci-run:${RUN_ID}`)).toEqual([{ kind: 'ci-run', runId: RUN_ID }]);
    expect(() => parseEvidenceString('ci-run:abc')).toThrow(/positive integer run id/);
  });

  it('never satisfies testsPassed on its own', () => {
    const alone = validateEvidenceForGate('testsPassed', [{ kind: 'ci-run', runId: RUN_ID }]);
    expect(alone.ok).toBe(false);
  });
});

describe('ci-run: validation (T14149)', () => {
  it("accepts T13047 AC2's shape: 50 green runs of the changed test on main", async () => {
    const r = await resolve();
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.ok && r.atom).toEqual({
      kind: 'ci-run',
      runId: RUN_ID,
      headSha: work,
      test: TEST,
      runs: 50,
      attempt: 1,
      workflow: '.github/workflows/repeat-run.yml',
      taskId: 'T13047',
    });
  });

  it('accepts a test file a linked criterion names, though the task did not change it', async () => {
    const r = await resolve(record(), report(), {
      changedPaths: ['packages/core/src/resources/exit.ts'],
      criteriaTexts: ['50 consecutive runs of process-exit-no-hang.test.ts pass'],
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('refuses a test the task did not change and no linked criterion names', async () => {
    const r = await resolve(record(), report(), {
      changedPaths: ['packages/core/src/resources/exit.ts'],
      criteriaTexts: ['the process exits without hanging'],
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.codeName).toBe('E_EVIDENCE_INSUFFICIENT');
    expect(!r.ok && r.reason).toMatch(/did not change and no criterion this write links/);
  });

  it('refuses a failed or cancelled run', async () => {
    for (const conclusion of ['failure', 'cancelled']) {
      const r = await resolve(record({ conclusion }));
      expect(r.ok, conclusion).toBe(false);
      expect(!r.ok && r.reason).toContain(`concluded ${conclusion}`);
    }
  });

  it('refuses a run dispatched on a branch other than the default branch', async () => {
    const r = await resolve(record({ headBranch: 'task/T13047' }));
    expect(!r.ok && r.reason).toMatch(/ran on task\/T13047, not the default branch main/);
  });

  it('refuses a run of another workflow, or one not started by workflow_dispatch', async () => {
    const other = await resolve(record({ path: '.github/workflows/ci.yml' }));
    expect(!other.ok && other.reason).toMatch(/is a run of \.github\/workflows\/ci\.yml/);
    const pushed = await resolve(record({ event: 'push' }));
    expect(!pushed.ok && pushed.reason).toMatch(/started by push/);
  });

  it('cross-checks the title against the uploaded report', async () => {
    const otherTest = await resolve(record(), report({ test: 'a.test.ts' }));
    expect(!otherTest.ok && otherTest.reason).toMatch(/report ran a\.test\.ts, but its title names/);
    const fewer = await resolve(record(), report({ iterations: report().iterations.slice(0, 10) }));
    expect(!fewer.ok && fewer.reason).toMatch(/records 10 runs, not 50/);
    const otherSha = await resolve(record(), report({ sha: base }));
    expect(!otherSha.ok && otherSha.reason).toMatch(/not the run's commit/);
    const missing = await resolve(record(), null);
    expect(!missing.ok && missing.reason).toMatch(/no readable repeat-report artifact/);
  });

  it('refuses a report with a failing iteration', async () => {
    const iterations = report().iterations.map((i) =>
      i.run === 37 ? { ...i, exitCode: 1, numFailedTests: 1 } : i,
    );
    const r = await resolve(record(), report({ iterations }));
    expect(!r.ok && r.codeName).toBe('E_EVIDENCE_TESTS_FAILED');
    expect(!r.ok && r.reason).toMatch(/run 37 of 50 did not pass/);
  });

  it("refuses a run whose commit does not contain the task's implemented commit", async () => {
    const task = {
      id: 'T13047',
      verification: {
        passed: false,
        round: 1,
        gates: {},
        lastAgent: null,
        lastUpdated: null,
        failureLog: [],
        evidence: {
          implemented: {
            atoms: [{ kind: 'commit' as const, sha: work }],
            capturedAt: '2026-10-29T00:00:00Z',
            capturedBy: 'test',
          },
        },
      },
    };
    const atom = (headSha: string): EvidenceAtom => ({
      kind: 'ci-run',
      runId: RUN_ID,
      headSha,
      test: TEST,
      runs: 50,
      attempt: 1,
      workflow: '.github/workflows/repeat-run.yml',
      taskId: 'T13047',
    });
    expect(await boundHeadGapReason(task, [atom(base)], repo)).toMatch(
      /does not contain T13047's implemented commit/,
    );
    expect(await boundHeadGapReason(task, [atom(work)], repo)).toBeNull();
  });
});

describe('ci-run: recheck at cleo complete (T14149)', () => {
  const recorded: Extract<EvidenceAtom, { kind: 'ci-run' }> = {
    kind: 'ci-run',
    runId: RUN_ID,
    headSha: 'f'.repeat(40),
    test: TEST,
    runs: 50,
    attempt: 1,
    workflow: '.github/workflows/repeat-run.yml',
    taskId: 'T13047',
  };

  it('stands while the latest attempt is still green on the same commit', () => {
    expect(recheckCiRunAtom(recorded, repo, () => record({ headSha: 'f'.repeat(40) }))).toEqual({
      ok: true,
    });
  });

  it('refuses a newer attempt that is not green', () => {
    const r = recheckCiRunAtom(recorded, repo, () =>
      record({ headSha: 'f'.repeat(40), attempt: 2, conclusion: 'failure' }),
    );
    expect(!r.ok && r.reason).toMatch(/attempt 2 concluded failure/);
  });
});
