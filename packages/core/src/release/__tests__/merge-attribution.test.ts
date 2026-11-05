/**
 * Merge attribution receipt (T14252): the first-parent differential, judged
 * on job logs from the 2026-11-05 dry run (trimmed from the real GitHub job
 * logs, under `fixtures/merge-attribution/`).
 *
 * @task T14252
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CommitCheck } from '../ci-evidence.js';
import {
  attributeMergedPr,
  computeMergeAttribution,
  MERGE_ATTRIBUTION_FILE,
  type MergeAttributionInput,
  type MergeAttributionIo,
  readMergeAttributions,
  resolveUnknownReceipt,
  storeMergeAttribution,
} from '../merge-attribution.js';

/** A trimmed real job log from the dry run. */
function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/merge-attribution/${name}.txt`, import.meta.url)),
    'utf-8',
  );
}

/** A completed push job on `sha`. */
function job(
  sha: string,
  name: string,
  conclusion: string,
  id: number,
  over: Partial<CommitCheck> = {},
): CommitCheck {
  return {
    name,
    source: 'check-run',
    status: 'completed',
    conclusion,
    headSha: sha,
    id,
    appSlug: 'github-actions',
    event: 'push',
    ...over,
  };
}

/** The input for a merge and its parent, with logs by job id. */
function input(
  over: Partial<MergeAttributionInput> & Pick<MergeAttributionInput, 'mergeSha' | 'mergeChecks'>,
  logs: Record<number, string> = {},
): MergeAttributionInput {
  return {
    prNumber: 1,
    headSha: 'head',
    parentSha: 'parent',
    parentChecks: [],
    log: async (check) => logs[check.id] ?? null,
    ...over,
  };
}

const BUILD = 'Build & Verify (ubuntu-latest)';
const SHARD4 = 'Unit Tests (ubuntu-latest, shard 4)';
const SHARD1 = 'Unit Tests (ubuntu-latest, shard 1)';

describe('merge attribution from the dry-run fixtures (T14252 AC5)', () => {
  it('#1729 is pr-caused: the cleo-os test was green on parent ea64b433ce; the bundle budget is disjoint', async () => {
    const merge = 'db5ba1967a82';
    const parent = 'ea64b433ce92';
    const receipt = await computeMergeAttribution(
      input(
        {
          prNumber: 1729,
          mergeSha: merge,
          parentSha: parent,
          mergeChecks: [
            job(merge, BUILD, 'failure', 109712622537),
            job(merge, SHARD4, 'failure', 109714087749),
            job(merge, 'Type Check', 'success', 3),
          ],
          parentChecks: [
            job(parent, BUILD, 'failure', 109710221195),
            job(parent, SHARD4, 'success', 109712028733),
          ],
        },
        {
          109712622537: fixture('pr1729-merge-build'),
          109714087749: fixture('pr1729-merge-unit-shard4'),
          109710221195: fixture('pr1729-parent-build'),
        },
      ),
    );
    expect(receipt?.verdict).toBe('pr-caused');
    expect(receipt?.claim).toBe('none');
    const shard = receipt?.failures.find((f) => f.job === SHARD4);
    expect(shard).toMatchObject({
      verdict: 'pr-caused',
      tests: ['@cleocode/cleo-os:src/harnesses/__tests__/provider-verification.test.ts'],
    });
    const build = receipt?.failures.find((f) => f.job === BUILD);
    expect(build?.verdict).toBe('disjoint');
    expect(build?.cause).toBe('step:node packages/core/scripts/check-core-bundle-budget.mjs');
    expect(receipt?.reason).toContain(SHARD4);
  });

  it('#2004 is unknown: the parent unit-test matrix was skipped, so there is no observation', async () => {
    const merge = '0e01cc34456b';
    const receipt = await computeMergeAttribution(
      input(
        {
          prNumber: 2004,
          mergeSha: merge,
          parentSha: '511454c9c8dd',
          mergeChecks: [job(merge, SHARD1, 'failure', 114162981272)],
          parentChecks: [job('511454c9c8dd', 'Type Check', 'success', 9)],
        },
        { 114162981272: fixture('pr2004-merge-unit-shard1') },
      ),
    );
    expect(receipt?.verdict).toBe('unknown');
    expect(receipt?.failures[0]?.reason).toMatch(/parent has no such job/);
    expect(receipt?.claim).toBe('none');
  });

  it('a quarantine-only merge over a green parent is main-health, not attributed (D11225)', async () => {
    const merge = '0e01cc34456b';
    const parent = '511454c9c8dd';
    const receipt = await computeMergeAttribution(
      input(
        {
          prNumber: 2004,
          mergeSha: merge,
          parentSha: parent,
          mergeChecks: [job(merge, SHARD1, 'failure', 114162981272)],
          parentChecks: [job(parent, SHARD1, 'success', 7)],
        },
        { 114162981272: fixture('pr2004-merge-unit-shard1') },
      ),
    );
    expect(receipt).toMatchObject({ verdict: 'main-health', claim: 'holds-on-main' });
    expect(receipt?.failures[0]).toMatchObject({
      verdict: 'main-health',
      cause: 'flaky-quarantine-budget',
      tests: [],
    });
  });

  it('#1978 is main-health, not budget-crossed: its parent shard was still under the quarantine limit (T14254)', async () => {
    const merge = '683a0fd97a12';
    const parent = '90296358f712';
    const receipt = await computeMergeAttribution(
      input(
        {
          prNumber: 1978,
          mergeSha: merge,
          parentSha: parent,
          mergeChecks: [job(merge, SHARD1, 'failure', 114144784474)],
          parentChecks: [job(parent, SHARD1, 'success', 114141428099)],
        },
        { 114144784474: fixture('pr1978-merge-unit-shard1') },
      ),
    );
    expect(receipt).toMatchObject({ verdict: 'main-health', claim: 'holds-on-main' });
    expect(receipt?.failures[0]?.cause).toBe('flaky-quarantine-budget');
  });

  it('#1726 is budget-crossed naming the PR: core dist 48.02 MB over 48 MB, under it on the parent (T14254)', async () => {
    const merge = 'ea64b433ce92';
    const parent = '948e5dc730ef';
    const receipt = await computeMergeAttribution(
      input(
        {
          prNumber: 1726,
          mergeSha: merge,
          parentSha: parent,
          mergeChecks: [job(merge, BUILD, 'failure', 109710221195)],
          parentChecks: [job(parent, BUILD, 'success', 109708934101)],
        },
        // The build log of #1726's merge is #1729's parent build fixture (same commit).
        { 109710221195: fixture('pr1729-parent-build') },
      ),
    );
    expect(receipt).toMatchObject({ verdict: 'budget-crossed', claim: 'none' });
    expect(receipt?.failures[0]?.cause).toBe(
      'step:node packages/core/scripts/check-core-bundle-budget.mjs',
    );
    expect(receipt?.reason).toMatch(/crossed here, by PR #1726$/);
  });

  it('#1022 is superseded: its merge runs were only cancelled', async () => {
    const merge = '2da444f52891';
    const receipt = await computeMergeAttribution(
      input({
        prNumber: 1022,
        mergeSha: merge,
        mergeChecks: [
          job(merge, BUILD, 'cancelled', 1),
          job(merge, SHARD1, 'cancelled', 2),
          job(merge, 'Type Check', 'skipped', 3),
        ],
      }),
    );
    expect(receipt).toMatchObject({ verdict: 'superseded', claim: 'green-at-head', failures: [] });
  });

  it('#2045 is disjoint: the parent was already over the gate-39 startup budget', async () => {
    const merge = '241d15c42b05';
    const parent = 'e1786ddbe099';
    const receipt = await computeMergeAttribution(
      input(
        {
          prNumber: 2045,
          mergeSha: merge,
          parentSha: parent,
          mergeChecks: [job(merge, BUILD, 'failure', 114297356239)],
          parentChecks: [job(parent, BUILD, 'failure', 114296695658)],
        },
        {
          114297356239: fixture('pr2045-merge-build'),
          114296695658: fixture('pr2045-parent-build'),
        },
      ),
    );
    expect(receipt).toMatchObject({ verdict: 'disjoint', claim: 'holds-on-main' });
    expect(receipt?.failures[0]?.cause).toBe('step:node scripts/check-cli-startup-graph.mjs');
  });

  it('a same-sha green rerun is clean: only the latest attempt of each job counts', async () => {
    const merge = 'abc';
    const receipt = await computeMergeAttribution(
      input({
        mergeSha: merge,
        mergeChecks: [job(merge, BUILD, 'failure', 10), job(merge, BUILD, 'success', 11)],
      }),
    );
    expect(receipt).toMatchObject({ verdict: 'clean', claim: 'holds-on-main', failures: [] });
  });
});

describe('the differential rule (T14252 AC2, AC3)', () => {
  const merge = 'm';
  const parent = 'p';
  const failing = (file: string) =>
    [
      '##[group]Run pnpm test',
      ` FAIL   @cleocode/core  ${file} > suite > case`,
      '##[error]Process completed with exit code 1.',
    ].join('\n');

  it('disjoint only when the same test identity fails on the parent; a new one is pr-caused', async () => {
    const same = await computeMergeAttribution(
      input(
        {
          mergeSha: merge,
          parentSha: parent,
          mergeChecks: [job(merge, SHARD1, 'failure', 1)],
          parentChecks: [job(parent, SHARD1, 'failure', 2)],
        },
        { 1: failing('src/a.test.ts'), 2: failing('src/a.test.ts') },
      ),
    );
    expect(same?.verdict).toBe('disjoint');
    const other = await computeMergeAttribution(
      input(
        {
          mergeSha: merge,
          parentSha: parent,
          mergeChecks: [job(merge, SHARD1, 'failure', 1)],
          parentChecks: [job(parent, SHARD1, 'failure', 2)],
        },
        { 1: failing('src/a.test.ts'), 2: failing('src/b.test.ts') },
      ),
    );
    expect(other?.verdict).toBe('pr-caused');
    expect(other?.failures[0]?.reason).toContain('@cleocode/core:src/a.test.ts');
  });

  it('a failure new at the merge whose PR head passed that job is a combination', async () => {
    const receipt = await computeMergeAttribution(
      input(
        {
          mergeSha: merge,
          parentSha: parent,
          mergeChecks: [job(merge, SHARD1, 'failure', 1)],
          parentChecks: [job(parent, SHARD1, 'success', 2)],
          headChecks: [job('head', SHARD1, 'success', 3, { event: 'pull_request' })],
        },
        { 1: failing('src/a.test.ts') },
      ),
    );
    expect(receipt?.verdict).toBe('combination');
  });

  it('a missing parent observation is unknown with its reason, never a guess', async () => {
    const one = (over: Partial<MergeAttributionInput>, logs: Record<number, string>) =>
      computeMergeAttribution(
        input(
          {
            mergeSha: merge,
            parentSha: parent,
            mergeChecks: [job(merge, SHARD1, 'failure', 1)],
            ...over,
          },
          logs,
        ),
      );
    const log = { 1: failing('src/a.test.ts') };
    const reasons = await Promise.all([
      one({ parentChecks: null }, log),
      one({ parentSha: null }, log),
      one({ parentChecks: [job(parent, SHARD1, 'cancelled', 2)] }, log),
      one({ parentChecks: [job(parent, SHARD1, 'failure', 2)] }, log), // parent log unreadable
      one({ parentChecks: [job(parent, SHARD1, 'failure', 2)] }, {}), // merge log unreadable
      one(
        {
          mergeChecks: [job(merge, SHARD1, 'failure', 1, { startedAt: '2026-10-13T00:00:00Z' })],
          parentChecks: [job(parent, SHARD1, 'success', 2, { startedAt: '2026-10-06T00:00:00Z' })],
        },
        log,
      ),
    ]);
    for (const r of reasons) expect(r?.verdict).toBe('unknown');
    expect(reasons.map((r) => r?.failures[0]?.reason)).toEqual([
      'no parent run was observed',
      'no parent run was observed',
      'the parent job was cancelled',
      'the parent job log is unreadable',
      'the merge job log is unreadable',
      expect.stringMatching(/not the same point in time/),
    ]);
  });

  it('no receipt while a merge job is still running', async () => {
    const receipt = await computeMergeAttribution(
      input({
        mergeSha: merge,
        mergeChecks: [
          job(merge, SHARD1, 'success', 1),
          { ...job(merge, BUILD, 'failure', 2), status: 'in_progress', conclusion: null },
        ],
      }),
    );
    expect(receipt).toBeNull();
  });
});

describe('merge attribution storage (T14252 AC1)', () => {
  it('appends one jsonl line per (PR, merge sha) with no task, and reads it back', async () => {
    const store = mkdtempSync(join(tmpdir(), 'merge-attribution-'));
    try {
      expect(readMergeAttributions(store)).toEqual([]);
      const receipt = await computeMergeAttribution(
        input({ prNumber: 7, mergeSha: 'm7', mergeChecks: [job('m7', SHARD1, 'success', 1)] }),
      );
      if (receipt === null) throw new Error('expected a receipt');
      await storeMergeAttribution(store, receipt, null);
      appendFileSync(join(store, MERGE_ATTRIBUTION_FILE), 'not json\n', 'utf-8');
      expect(readMergeAttributions(store)).toEqual([receipt]);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });
});

describe('the receipt pins the run attempt and judges the parent at that time (T14253)', () => {
  /** One job of a run attempt, as `actions/runs/<id>/attempts/<n>/jobs` reports it. */
  const attempt = (
    sha: string,
    name: string,
    conclusion: string,
    id: number,
    runId: number,
    runAttempt: number,
    startedAt: string,
    completedAt: string,
  ): CommitCheck => job(sha, name, conclusion, id, { runId, runAttempt, startedAt, completedAt });

  it('#1980 is judged on attempt 1, not the 2026-10-12 rerun that died on a missing artifact', async () => {
    const merge = '4aa2c96a5422';
    const parent = 'd447367f54a2';
    const [mergeRun, parentRun] = [38029070477, 38028862987];
    const lint = 'Lint & Format';
    const receipt = await computeMergeAttribution(
      input(
        {
          prNumber: 1980,
          mergeSha: merge,
          parentSha: parent,
          aggregates: ['CI'],
          mergeChecks: [
            attempt(
              merge,
              SHARD1,
              'failure',
              114152599610,
              mergeRun,
              1,
              '2026-10-10T06:51:16Z',
              '2026-10-10T06:58:10Z',
            ),
            attempt(
              merge,
              SHARD1,
              'failure',
              114816569869,
              mergeRun,
              2,
              '2026-10-12T13:03:38Z',
              '2026-10-12T13:04:07Z',
            ),
            attempt(
              merge,
              lint,
              'success',
              114146005036,
              mergeRun,
              1,
              '2026-10-10T06:09:14Z',
              '2026-10-10T06:09:36Z',
            ),
            attempt(
              merge,
              lint,
              'success',
              114816620267,
              mergeRun,
              2,
              '2026-10-10T06:09:14Z',
              '2026-10-10T06:09:36Z',
            ),
            attempt(
              merge,
              'CI',
              'failure',
              114160172202,
              mergeRun,
              1,
              '2026-10-10T07:25:26Z',
              '2026-10-10T07:25:29Z',
            ),
            attempt(
              merge,
              'CI',
              'failure',
              114831036624,
              mergeRun,
              2,
              '2026-10-12T13:36:02Z',
              '2026-10-12T13:36:05Z',
            ),
          ],
          parentChecks: [
            attempt(
              parent,
              SHARD1,
              'failure',
              114151792050,
              parentRun,
              1,
              '2026-10-10T06:43:32Z',
              '2026-10-10T06:50:15Z',
            ),
            attempt(
              parent,
              SHARD1,
              'failure',
              114816592105,
              parentRun,
              2,
              '2026-10-12T13:05:28Z',
              '2026-10-12T13:06:00Z',
            ),
          ],
        },
        // Only attempt 1's logs are readable here: reading a rerun's would make it unknown.
        {
          114152599610: fixture('pr1980-merge-unit-shard1-attempt1'),
          114151792050: fixture('pr1980-parent-unit-shard1-attempt1'),
        },
      ),
    );
    expect(receipt).toMatchObject({ verdict: 'main-health', claim: 'holds-on-main' });
    expect(receipt?.failures).toHaveLength(1);
    expect(receipt?.failures[0]).toMatchObject({ job: SHARD1, cause: 'flaky-quarantine-budget' });
    expect(receipt?.mergeRuns).toEqual([
      { runId: mergeRun, attempt: 1, completedAt: '2026-10-10T06:58:10Z' },
    ]);
    expect(receipt?.parentRuns).toEqual([
      { runId: parentRun, attempt: 1, completedAt: '2026-10-10T06:50:15Z' },
    ]);
  });

  it('#1910 is judged on its 2026-10-06 attempt: the 2026-10-13 rerun neither fails nor passes it', async () => {
    const merge = 'f8822ef4ee2a';
    const run = 37510901935;
    const agentSurface =
      'Arch Gates / Agent Surface + Write Chokepoint Gates (T12658 · gates 23, 26-28)';
    const receipt = await computeMergeAttribution(
      input({
        prNumber: 1910,
        mergeSha: merge,
        parentSha: '7631eecfe0ea',
        aggregates: ['CI'],
        mergeChecks: [
          attempt(
            merge,
            'Agent-Outputs Registration Lint (T1617)',
            'cancelled',
            112431467591,
            run,
            1,
            '2026-10-06T18:23:59Z',
            '2026-10-06T18:26:16Z',
          ),
          attempt(
            merge,
            'Agent-Outputs Registration Lint (T1617)',
            'success',
            115404644715,
            run,
            2,
            '2026-10-13T16:14:52Z',
            '2026-10-13T16:15:12Z',
          ),
          attempt(
            merge,
            agentSurface,
            'success',
            112431469652,
            run,
            1,
            '2026-10-06T18:24:04Z',
            '2026-10-06T18:24:19Z',
          ),
          attempt(
            merge,
            agentSurface,
            'failure',
            115404647012,
            run,
            2,
            '2026-10-13T16:13:57Z',
            '2026-10-13T16:14:08Z',
          ),
          attempt(
            merge,
            'Arch Gates / Arch Boundary Check',
            'success',
            112433842212,
            run,
            1,
            '2026-10-06T18:30:06Z',
            '2026-10-06T18:30:10Z',
          ),
          attempt(
            merge,
            'Arch Gates / Arch Boundary Check',
            'failure',
            115406771754,
            run,
            2,
            '2026-10-13T16:17:20Z',
            '2026-10-13T16:17:23Z',
          ),
          attempt(
            merge,
            'CI',
            'failure',
            112440745626,
            run,
            1,
            '2026-10-06T18:44:22Z',
            '2026-10-06T18:44:25Z',
          ),
          attempt(
            merge,
            'CI',
            'failure',
            115413743573,
            run,
            2,
            '2026-10-13T16:31:56Z',
            '2026-10-13T16:31:59Z',
          ),
        ],
      }),
    );
    expect(receipt).toMatchObject({
      verdict: 'superseded',
      claim: 'green-at-head',
      failures: [],
      reason: '1 merge job(s) were cancelled; none failed',
    });
    expect(receipt?.mergeRuns).toEqual([
      { runId: run, attempt: 1, completedAt: '2026-10-06T18:30:10Z' },
    ]);
  });

  it('a green rerun counts only on the same sha within a day: never on another sha, never after 24h', async () => {
    const red = [
      '##[group]Run pnpm test',
      ' FAIL   @cleocode/core  src/a.test.ts > s > c',
      '##[error]Process completed with exit code 1.',
    ].join('\n');
    const judge = (rerun: CommitCheck) =>
      computeMergeAttribution(
        input(
          {
            mergeSha: 'm',
            parentSha: 'p',
            mergeChecks: [
              attempt(
                'm',
                SHARD1,
                'failure',
                1,
                10,
                1,
                '2026-10-10T06:51:00Z',
                '2026-10-10T06:58:00Z',
              ),
              rerun,
            ],
            parentChecks: [
              attempt(
                'p',
                SHARD1,
                'success',
                3,
                20,
                1,
                '2026-10-10T06:43:00Z',
                '2026-10-10T06:50:00Z',
              ),
            ],
          },
          { 1: red },
        ),
      );
    // Same sha, two hours later: the tree can pass.
    expect(
      (
        await judge(
          attempt('m', SHARD1, 'success', 2, 10, 2, '2026-10-10T08:51:00Z', '2026-10-10T08:58:00Z'),
        )
      )?.verdict,
    ).toBe('clean');
    // Same sha, 25 hours later: main and its base moved on; attempt 1 stands.
    const late = await judge(
      attempt('m', SHARD1, 'success', 2, 10, 2, '2026-10-11T07:51:00Z', '2026-10-11T07:58:00Z'),
    );
    expect(late?.verdict).toBe('pr-caused');
    expect(late?.mergeRuns).toEqual([
      { runId: 10, attempt: 1, completedAt: '2026-10-10T06:58:00Z' },
    ]);
    // Another sha (a later commit's run), minutes later: never the merge's evidence.
    const other = await judge(
      attempt('other', SHARD1, 'success', 2, 11, 1, '2026-10-10T07:00:00Z', '2026-10-10T07:07:00Z'),
    );
    expect(other?.verdict).toBe('pr-caused');
    expect(other?.mergeRuns).toEqual([
      { runId: 10, attempt: 1, completedAt: '2026-10-10T06:58:00Z' },
    ]);
  });

  it('the parent is judged at the attempt that had started when the merge job ran, not its latest', async () => {
    const red = [
      '##[group]Run pnpm test',
      ' FAIL   @cleocode/core  src/a.test.ts > s > c',
      '##[error]Process completed with exit code 1.',
    ].join('\n');
    const receipt = await computeMergeAttribution(
      input(
        {
          mergeSha: 'm',
          parentSha: 'p',
          mergeChecks: [
            attempt(
              'm',
              SHARD1,
              'failure',
              1,
              10,
              1,
              '2026-10-10T06:51:00Z',
              '2026-10-10T06:58:00Z',
            ),
          ],
          parentChecks: [
            attempt(
              'p',
              SHARD1,
              'failure',
              2,
              20,
              1,
              '2026-10-10T06:43:00Z',
              '2026-10-10T06:50:00Z',
            ),
            // A later green rerun of the parent cannot make the merge's failure new.
            attempt(
              'p',
              SHARD1,
              'success',
              3,
              20,
              2,
              '2026-10-10T09:00:00Z',
              '2026-10-10T09:07:00Z',
            ),
          ],
        },
        { 1: red, 2: red },
      ),
    );
    expect(receipt?.verdict).toBe('disjoint');
    expect(receipt?.parentRuns).toEqual([
      { runId: 20, attempt: 1, completedAt: '2026-10-10T06:50:00Z' },
    ]);
  });

  it('a rerun after the receipt is written does not change the stored verdict', async () => {
    const store = mkdtempSync(join(tmpdir(), 'merge-attribution-'));
    const red = [
      '##[group]Run pnpm test',
      ' FAIL   @cleocode/core  src/a.test.ts > s > c',
      '##[error]Process completed with exit code 1.',
    ].join('\n');
    let mergeJobs: CommitCheck[] = [
      attempt('m', SHARD1, 'failure', 1, 10, 1, '2026-10-10T06:51:00Z', '2026-10-10T06:58:00Z'),
    ];
    let fetches = 0;
    const io: MergeAttributionIo = {
      fetchRunJobs: async (sha) => {
        fetches++;
        return { ok: true, checks: sha === 'm' ? mergeJobs : [] };
      },
      fetchHeadChecks: async () => ({ ok: true, checks: [] }),
      firstParentOf: () => 'p',
      fetchJobLog: async (id) => (id === 1 ? red : null),
      laterMainCommits: () => ({ via: 'ancestry', shas: [] }),
    };
    const pr = { number: 5, headRefOid: 'h', mergeCommitSha: 'm' };
    try {
      const first = await attributeMergedPr(store, store, pr, null, ['CI'], false, io);
      expect(first?.verdict).toBe('unknown');
      mergeJobs = [
        ...mergeJobs,
        attempt('m', SHARD1, 'success', 2, 10, 2, '2026-10-10T07:30:00Z', '2026-10-10T07:37:00Z'),
      ];
      const again = await attributeMergedPr(store, store, pr, null, ['CI'], false, io);
      expect(again).toEqual(first);
      expect(fetches).toBe(2);
      expect(readMergeAttributions(store)).toHaveLength(1);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });
});

describe('an unknown receipt resolves only on a later green main run containing the change (T14255)', () => {
  const merge = '0e01cc34456b';
  /** An #2004-shaped unknown: shard 1 failed on the merge; the parent matrix was skipped. */
  const unknown = async () => {
    const receipt = await computeMergeAttribution(
      input(
        {
          prNumber: 2004,
          mergeSha: merge,
          parentSha: '511454c9c8dd',
          aggregates: ['CI'],
          mergeChecks: [job(merge, SHARD1, 'failure', 114162981272)],
          parentChecks: [job('511454c9c8dd', 'Type Check', 'success', 9)],
        },
        { 114162981272: fixture('pr2004-merge-unit-shard1') },
      ),
    );
    if (receipt === null) throw new Error('expected a receipt');
    return receipt;
  };
  /** Shard 1 on a later main commit, attempt 1, with the CI aggregate beside it. */
  const later = (sha: string, conclusion: string, id: number): CommitCheck[] => [
    job(sha, SHARD1, conclusion, id, {
      runId: id * 10,
      runAttempt: 1,
      completedAt: '2026-10-10T09:00:00Z',
    }),
    job(sha, 'CI', conclusion, id + 1),
  ];
  const io = (
    runs: Record<string, CommitCheck[]>,
    shas: string[] | null,
    fetched: string[] = [],
  ): MergeAttributionIo => ({
    fetchRunJobs: async (sha) => {
      fetched.push(sha);
      return { ok: true, checks: runs[sha] ?? [] };
    },
    fetchHeadChecks: async () => ({ ok: true, checks: [] }),
    firstParentOf: () => null,
    fetchJobLog: async () => null,
    laterMainCommits: () => (shas === null ? null : { via: 'ancestry', shas }),
  });

  it('resolves on the first later main commit whose undecided job passed, recording its sha and attempt', async () => {
    const receipt = await unknown();
    expect(receipt.verdict).toBe('unknown');
    const resolved = await resolveUnknownReceipt(
      receipt,
      '/repo',
      ['CI'],
      io({ l1: later('l1', 'failure', 100), l2: later('l2', 'success', 200) }, ['l1', 'l2']),
    );
    expect(resolved.resolution).toEqual({
      claim: 'holds-on-main',
      sha: 'l2',
      via: 'ancestry',
      runs: [{ runId: 2000, attempt: 1, completedAt: '2026-10-10T09:00:00Z' }],
    });
    // An unknown never closes anything by itself: its verdict and claim stand.
    expect(resolved).toMatchObject({ verdict: 'unknown', claim: 'none' });
  });

  it('stays unknown when the later runs are red, and the next look starts after the last commit read', async () => {
    const receipt = await unknown();
    const red = await resolveUnknownReceipt(
      receipt,
      '/repo',
      ['CI'],
      io({ l1: later('l1', 'failure', 100), l2: later('l2', 'failure', 200) }, ['l1', 'l2']),
    );
    expect(red.resolution).toBeUndefined();
    expect(red.unresolvedThrough).toBe('l2');
    const fetched: string[] = [];
    const next = await resolveUnknownReceipt(
      red,
      '/repo',
      ['CI'],
      io(
        {
          l1: later('l1', 'failure', 100),
          l2: later('l2', 'failure', 200),
          l3: later('l3', 'success', 300),
        },
        ['l1', 'l2', 'l3'],
        fetched,
      ),
    );
    expect(fetched).toEqual(['l3']);
    expect(next.resolution?.sha).toBe('l3');
  });

  it('stays unknown when no later main commit contains the change, or the job is still running', async () => {
    const receipt = await unknown();
    expect(await resolveUnknownReceipt(receipt, '/repo', ['CI'], io({}, []))).toBe(receipt);
    expect(await resolveUnknownReceipt(receipt, '/repo', ['CI'], io({}, null))).toBe(receipt);
    const running = later('l1', 'success', 100).map((c) => ({
      ...c,
      status: 'in_progress',
      conclusion: null,
    }));
    expect(await resolveUnknownReceipt(receipt, '/repo', ['CI'], io({ l1: running }, ['l1']))).toBe(
      receipt,
    );
    // A later commit whose matrix skipped the job does not cover it.
    const skipped = { l1: [job('l1', 'Type Check', 'success', 5)] };
    const moved = await resolveUnknownReceipt(receipt, '/repo', ['CI'], io(skipped, ['l1']));
    expect(moved.resolution).toBeUndefined();
    expect(moved.unresolvedThrough).toBe('l1');
  });

  it('a stored unknown gains its resolution as a newer line; the verdict line is kept', async () => {
    const store = mkdtempSync(join(tmpdir(), 'merge-attribution-'));
    try {
      const receipt = await unknown();
      await storeMergeAttribution(store, receipt, null);
      const pr = { number: 2004, headRefOid: null, mergeCommitSha: merge };
      const resolved = await attributeMergedPr(
        store,
        store,
        pr,
        null,
        ['CI'],
        false,
        io({ l1: later('l1', 'success', 100) }, ['l1']),
      );
      expect(resolved?.resolution?.sha).toBe('l1');
      const lines = readMergeAttributions(store);
      expect(lines).toHaveLength(2);
      expect(lines[0]?.resolution).toBeUndefined();
      // Resolved once; the next sweep reads it back without a GitHub read.
      const fetched: string[] = [];
      const again = await attributeMergedPr(
        store,
        store,
        pr,
        null,
        ['CI'],
        false,
        io({}, ['l1'], fetched),
      );
      expect(again).toEqual(resolved);
      expect(fetched).toEqual([]);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  it('no receipt code path triggers a workflow rerun', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../merge-attribution.ts', import.meta.url)),
      'utf-8',
    );
    expect(source).not.toMatch(/\/rerun|'rerun'|run rerun|rerun-failed-jobs/);
  });
});
