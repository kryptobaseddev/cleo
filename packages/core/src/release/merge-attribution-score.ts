/**
 * Score shadow merge attribution receipts against the current closure path
 * (T14256, D11224, Council change 3). The Phase 3 deletions wait for this
 * score. They unblock only when at least 80% of the scored PRs are decidable
 * (a receipt whose verdict is not `unknown`) and no receipt would close a
 * failure that is new at the merge.
 *
 * @task T14256
 */

import type { MergeAttributionReceipt, MergeAttributionVerdict } from '@cleocode/contracts';

/** The decidable share the Phase 3 deletions need (T14256). */
export const MERGE_ATTRIBUTION_DECIDABLE_BAR = 0.8;

/** Failure verdicts that are new at the merge: never closed. */
const NEW_AT_MERGE: ReadonlySet<MergeAttributionVerdict> = new Set(['pr-caused', 'combination']);

/** One scored PR: its receipt (or why none) beside what the current path did. */
export interface MergeAttributionScoreRow {
  /** The PR. */
  readonly prNumber: number;
  /** The task the PR delivers, when known. */
  readonly taskId: string | null;
  /** Which scored set the row came from (refused, rewritten, backfill, dry-run, …). */
  readonly set: string;
  /** The shadow receipt, or `null` when none could be computed. */
  readonly receipt: Pick<
    MergeAttributionReceipt,
    'verdict' | 'claim' | 'reason' | 'failures' | 'resolution'
  > | null;
  /** Why no receipt could be computed. */
  readonly noReceipt?: string;
  /** What the current path did with the task. */
  readonly current: 'closed' | 'refused' | 'cancelled' | 'open';
}

/** A row where the receipt and the current path disagree. */
export interface MergeAttributionDisagreement {
  readonly prNumber: number;
  readonly taskId: string | null;
  readonly receipt: string;
  readonly current: MergeAttributionScoreRow['current'];
  readonly cause: string;
}

/** The score over a set of rows. */
export interface MergeAttributionScore {
  /** Rows scored. */
  readonly scored: number;
  /** Rows with a non-`unknown` receipt. */
  readonly decidable: number;
  /** `decidable / scored`; a row with no receipt counts as undecided. */
  readonly share: number;
  /** `unknown` receipts a later green main run resolved (T14255); not counted as decidable. */
  readonly resolvedUnknown: number;
  /** Rows per verdict (`none` for no receipt). */
  readonly verdicts: Readonly<Record<string, number>>;
  /** Rows with no receipt, and why. */
  readonly noReceipt: ReadonlyArray<{ prNumber: number; taskId: string | null; why: string }>;
  /** Receipts that would close although a failure is new at the merge (must be none). */
  readonly receiptClosedNewFailures: ReadonlyArray<{ prNumber: number; taskId: string | null }>;
  /** Tasks the current path closed whose receipt says a failure is new at the merge. */
  readonly currentClosedNewFailures: ReadonlyArray<{ prNumber: number; taskId: string | null }>;
  /** Every disagreement with the current path. */
  readonly disagreements: readonly MergeAttributionDisagreement[];
  /** Whether the Phase 3 deletions may proceed on this score. */
  readonly unblocks: boolean;
}

/**
 * Whether the closure rule would close the task on this receipt: it claims the
 * change holds (on main or at the head), a later green main run resolved it
 * (T14255), or it only crossed a budget (D11225). It reads the claim, never the
 * failures, so a receipt that claims to hold despite a failure new at the merge
 * is counted in `receiptClosedNewFailures` instead of being filtered out.
 */
function wouldClose(receipt: NonNullable<MergeAttributionScoreRow['receipt']>): boolean {
  return (
    receipt.claim !== 'none' ||
    receipt.resolution !== undefined ||
    receipt.verdict === 'budget-crossed'
  );
}

/**
 * Score shadow receipts (T14256): the decidable share, the bar, every
 * disagreement with the current path and every missing receipt.
 *
 * @param rows - The scored PRs.
 * @returns The score.
 * @task T14256
 */
export function scoreMergeAttributions(
  rows: readonly MergeAttributionScoreRow[],
): MergeAttributionScore {
  const verdicts: Record<string, number> = {};
  const noReceipt: Array<{ prNumber: number; taskId: string | null; why: string }> = [];
  const receiptClosedNewFailures: Array<{ prNumber: number; taskId: string | null }> = [];
  const currentClosedNewFailures: Array<{ prNumber: number; taskId: string | null }> = [];
  const disagreements: MergeAttributionDisagreement[] = [];
  let decidable = 0;
  let resolvedUnknown = 0;
  for (const row of rows) {
    const id = { prNumber: row.prNumber, taskId: row.taskId };
    const { receipt } = row;
    if (receipt === null) {
      verdicts.none = (verdicts.none ?? 0) + 1;
      noReceipt.push({ ...id, why: row.noReceipt ?? 'no receipt' });
      continue;
    }
    verdicts[receipt.verdict] = (verdicts[receipt.verdict] ?? 0) + 1;
    if (receipt.verdict !== 'unknown') decidable++;
    else if (receipt.resolution !== undefined) resolvedUnknown++;
    const closes = wouldClose(receipt);
    const newAtMerge =
      NEW_AT_MERGE.has(receipt.verdict) ||
      receipt.failures.some((f) => NEW_AT_MERGE.has(f.verdict));
    if (closes && newAtMerge) receiptClosedNewFailures.push(id);
    if (row.current === 'closed' && newAtMerge) currentClosedNewFailures.push(id);
    const currentCloses = row.current === 'closed';
    if (closes !== currentCloses)
      disagreements.push({
        ...id,
        receipt: `${receipt.verdict}${receipt.resolution ? ' (resolved)' : ''}: ${closes ? 'would close' : 'would refuse'}`,
        current: row.current,
        cause: receipt.reason,
      });
  }
  const share = rows.length === 0 ? 0 : decidable / rows.length;
  return {
    scored: rows.length,
    decidable,
    share,
    resolvedUnknown,
    verdicts,
    noReceipt,
    receiptClosedNewFailures,
    currentClosedNewFailures,
    disagreements,
    unblocks: share >= MERGE_ATTRIBUTION_DECIDABLE_BAR && receiptClosedNewFailures.length === 0,
  };
}

/**
 * The score as a Markdown report (T14256): the share against the bar, the
 * verdict counts, every missing receipt and every disagreement.
 *
 * @param score - The score.
 * @param title - The report's heading.
 * @returns The report.
 * @task T14256
 */
export function formatMergeAttributionScore(score: MergeAttributionScore, title: string): string {
  const pct = (n: number): string => `${Math.round(n * 1000) / 10}%`;
  const lines = [
    `## ${title}`,
    '',
    `- Decidable: ${score.decidable} of ${score.scored} = ${pct(score.share)} (bar ${pct(MERGE_ATTRIBUTION_DECIDABLE_BAR)}); ${score.resolvedUnknown} more unknown resolved on a later green main run.`,
    `- Receipts that would close a failure new at the merge: ${score.receiptClosedNewFailures.length}.`,
    `- Tasks the current path closed with a failure new at the merge: ${score.currentClosedNewFailures.length}${score.currentClosedNewFailures.length > 0 ? ` (${score.currentClosedNewFailures.map((r) => `#${r.prNumber}`).join(', ')})` : ''}.`,
    `- Phase 3 deletions: ${score.unblocks ? 'unblocked' : 'blocked'} on this score.`,
    `- Verdicts: ${Object.entries(score.verdicts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([v, n]) => `${v} ${n}`)
      .join(', ')}.`,
  ];
  if (score.noReceipt.length > 0) {
    lines.push('', '### No receipt', '', '| PR | Task | Why |', '|---|---|---|');
    for (const r of score.noReceipt)
      lines.push(`| #${r.prNumber} | ${r.taskId ?? ''} | ${r.why.replace(/\|/g, '\\|')} |`);
  }
  if (score.disagreements.length > 0) {
    lines.push(
      '',
      '### Disagreements with the current path',
      '',
      '| PR | Task | Receipt | Current | Cause |',
      '|---|---|---|---|---|',
    );
    for (const d of score.disagreements)
      lines.push(
        `| #${d.prNumber} | ${d.taskId ?? ''} | ${d.receipt} | ${d.current} | ${d.cause.replace(/\|/g, '\\|')} |`,
      );
  }
  return `${lines.join('\n')}\n`;
}
