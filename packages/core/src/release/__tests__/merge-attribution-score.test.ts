/**
 * Scoring shadow receipts (T14256): the decidable share against the 80% bar,
 * receipts that would close a failure new at the merge, missing receipts and
 * disagreements with the current path. AC5: the 2026-11-05 dry run's 16 PRs
 * (all refused by the current path) score 13 of 16 decidable.
 *
 * @task T14256
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { MergeAttributionVerdict } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import {
  formatMergeAttributionScore,
  type MergeAttributionScoreRow,
  scoreMergeAttributions,
} from '../merge-attribution-score.js';

const VERDICTS: readonly MergeAttributionVerdict[] = [
  'clean',
  'superseded',
  'disjoint',
  'pr-caused',
  'combination',
  'budget-crossed',
  'main-health',
  'unknown',
];

/** The dry run's rows: PR, task, set, differential verdict, current outcome. */
function dryRun(): MergeAttributionScoreRow[] {
  const text = readFileSync(
    fileURLToPath(new URL('./fixtures/merge-attribution/dry-run-2026-11-05.tsv', import.meta.url)),
    'utf-8',
  );
  return text
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const [pr, task, set, verdict, current] = line.split('\t');
      const v = VERDICTS.find((x) => x === verdict);
      if (v === undefined || current !== 'refused') throw new Error(`bad fixture row: ${line}`);
      return {
        prNumber: Number(pr),
        taskId: task ?? null,
        set: set ?? '',
        receipt: { verdict: v, reason: `dry run: ${v}`, failures: [] },
        current,
      };
    });
}

describe('shadow receipt score (T14256)', () => {
  it('AC5: the dry run scores 13 of 16 decidable, above the 80% bar', () => {
    const score = scoreMergeAttributions(dryRun());
    expect(score).toMatchObject({ scored: 16, decidable: 13, unblocks: true });
    expect(score.share).toBeCloseTo(13 / 16);
    expect(score.receiptClosedNewFailures).toEqual([]);
    expect(score.verdicts).toEqual({
      'budget-crossed': 1,
      disjoint: 8,
      'pr-caused': 1,
      superseded: 3,
      unknown: 3,
    });
    // Every receipt that would close a refused task is a disagreement; #1729 and the unknowns agree.
    expect(score.disagreements).toHaveLength(12);
    const disagreeing = score.disagreements.map((d) => d.prNumber);
    for (const pr of [1729, 2004, 2662, 1910]) expect(disagreeing).not.toContain(pr);
    expect(formatMergeAttributionScore(score, 'Dry run')).toContain(
      'Decidable: 13 of 16 = 81.3% (bar 80%)',
    );
  });

  it('a missing receipt is undecided and named; a receipt closing a new failure blocks', () => {
    const score = scoreMergeAttributions([
      {
        prNumber: 1,
        taskId: 'T1',
        set: 'backfill',
        receipt: null,
        noReceipt: 'merge commit not found',
        current: 'open',
      },
      {
        prNumber: 2,
        taskId: 'T2',
        set: 'refused',
        receipt: {
          verdict: 'disjoint',
          reason: 'x',
          failures: [{ job: 'j', tests: ['a'], cause: null, verdict: 'pr-caused', reason: 'new' }],
        },
        current: 'closed',
      },
    ]);
    expect(score).toMatchObject({ scored: 2, decidable: 1, share: 0.5, unblocks: false });
    expect(score.noReceipt).toEqual([{ prNumber: 1, taskId: 'T1', why: 'merge commit not found' }]);
    expect(score.receiptClosedNewFailures).toEqual([]);
    expect(score.currentClosedNewFailures).toEqual([{ prNumber: 2, taskId: 'T2' }]);
    expect(score.disagreements).toEqual([
      {
        prNumber: 2,
        taskId: 'T2',
        receipt: 'disjoint: would refuse',
        current: 'closed',
        cause: 'x',
      },
    ]);
  });

  it('a resolved unknown would close but is not counted decidable', () => {
    const score = scoreMergeAttributions([
      {
        prNumber: 3,
        taskId: 'T3',
        set: 'refused',
        receipt: {
          verdict: 'unknown',
          reason: 'no parent',
          failures: [],
          resolution: { claim: 'holds-on-main', sha: 'l1', via: 'ancestry', runs: [] },
        },
        current: 'refused',
      },
    ]);
    expect(score).toMatchObject({ decidable: 0, resolvedUnknown: 1, unblocks: false });
    expect(score.disagreements[0]?.receipt).toBe('unknown (resolved): would close');
  });
});
