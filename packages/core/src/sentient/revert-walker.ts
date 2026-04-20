/**
 * Revert Chain Walker — collects merge-commit SHAs from a receipt point forward.
 *
 * Walks the sentient audit log (NDJSON) starting at `fromReceiptId` and
 * collects every `kind:'merge'` event that was appended at or after the
 * specified receipt. Events of other kinds (baseline, verify, abort, etc.)
 * are silently skipped.
 *
 * The result is ordered chronologically (oldest first) so the caller can
 * feed the commit list directly to `git revert`.
 *
 * Delegates chain traversal to {@link walkChainFrom} from `chain-walker.ts`
 * (T1025) to avoid duplicating Merkle-walk logic.
 *
 * @see DESIGN.md §8 T1012-S1
 * @task T1036
 */

import { walkChainFrom } from './chain-walker.js';
import type { MergeEvent } from './events.js';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Result of {@link collectMergeCommits}.
 */
export interface CollectMergeCommitsResult {
  /** Commit SHAs referenced by `kind:'merge'` events, oldest first. */
  commits: string[];
  /** The merge events that were collected. */
  events: MergeEvent[];
  /**
   * Whether at least one non-sentient commit author was detected.
   *
   * This is a passive warning flag set by the executor — the walker itself
   * does not check git authorship. The executor populates this after
   * running git-log on the range.
   */
  humanCommitDetected: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect all `kind:'merge'` events (and their commit SHAs) that were logged
 * at or after `fromReceiptId` in the sentient audit log.
 *
 * The walk is purely log-based — it does NOT access the git repository. The
 * caller is responsible for validating commit reachability.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param fromReceiptId - The `receiptId` of the starting event (inclusive).
 * @returns Merge commits and events after the receipt, oldest first.
 * @throws With message prefix `E_RECEIPT_NOT_FOUND` if `fromReceiptId` is absent in the log.
 *
 * @example
 * ```ts
 * import { collectMergeCommits } from '@cleocode/core/sentient/revert-walker.js';
 *
 * const { commits, events } = await collectMergeCommits(projectRoot, 'ABC123receiptId');
 * // commits = ['sha1...', 'sha2...', 'sha3...'] ordered oldest first
 * ```
 */
export async function collectMergeCommits(
  projectRoot: string,
  fromReceiptId: string,
): Promise<CollectMergeCommitsResult> {
  // walkChainFrom throws E_RECEIPT_NOT_FOUND (as part of the error message)
  // when the receipt is absent. Propagate as-is.
  const events = await walkChainFrom(projectRoot, fromReceiptId);

  // Filter to only merge events.
  const mergeEvents = events.filter((ev): ev is MergeEvent => ev.kind === 'merge');

  // Commits in chronological order (oldest first, which is the log order).
  const commits = mergeEvents.map((ev) => ev.payload.commitSha);

  return { commits, events: mergeEvents, humanCommitDetected: false };
}
