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
  computeMergeAttribution,
  MERGE_ATTRIBUTION_FILE,
  type MergeAttributionInput,
  readMergeAttributions,
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
