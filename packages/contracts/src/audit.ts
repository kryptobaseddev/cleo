/**
 * Audit domain contracts — lineage reconstruction and integrity types.
 *
 * These types are consumed by `packages/core/src/audit/reconstruct.ts`
 * (the SDK primitive) and by T1216 audit tasks for their 4-outcome verdict:
 * verified-complete | verified-incomplete | schema-artifact-not-work-defect | inconclusive.
 *
 * Design note: git IS the immutable hash-chained ledger. This contract
 * represents the structured result of querying git — not a parallel
 * record-keeping format (per FP peer note, T1322 council verdict).
 *
 * @task T1322
 * @epic T1216
 */

/**
 * A single commit entry extracted from git log.
 */
export interface CommitEntry {
  /** Full 40-character commit SHA. */
  sha: string;
  /** The full commit subject line. */
  subject: string;
  /** ISO-8601 author date. */
  authorDate: string;
  /** Author name from git log. */
  author: string;
}

/**
 * A release tag entry associated with one or more work commits.
 */
export interface ReleaseTagEntry {
  /** The git tag name (e.g. `v2026.4.98`). */
  tag: string;
  /** The commit SHA the tag points to. */
  commitSha: string;
  /** The commit subject of the tagged commit (e.g. `chore(release): ...`). */
  subject: string;
}

/**
 * Structured result of `reconstructLineage(taskId)`.
 *
 * Represents the full git-backed lineage for a task and its inferred
 * children — commits, release tags, and timing bounds — as consumed by
 * the T1216 audit layer.
 *
 * The `inferredChildren` field lists child task IDs that were discovered
 * through commit-message mining or numeric adjacency heuristics, not
 * necessarily from the task DB.
 */
export interface ReconstructResult {
  /** The task ID being reconstructed (e.g. `T991`). */
  taskId: string;

  /**
   * Commits whose message directly references `taskId`.
   * Pattern: `<taskId>:`, `(<taskId>):`, or `<taskId> ` (space-delimited).
   */
  directCommits: CommitEntry[];

  /**
   * Numeric child ID range inferred from commit-message mining and DB lookup.
   * Both bounds are inclusive. `null` when no children could be inferred.
   */
  childIdRange: { min: string; max: string } | null;

  /**
   * All commits referencing any inferred child task ID.
   * Keyed by child task ID for O(1) lookup by consumers.
   */
  childCommits: Record<string, CommitEntry[]>;

  /**
   * Release tags that contain any of the direct or child commits.
   * Sorted by tag name ascending.
   */
  releaseTags: ReleaseTagEntry[];

  /**
   * Convenience flat list of commit SHAs for all release commits found.
   * Used by the T1216 verdict engine for hash-chain verification.
   */
  releaseCommitShas: string[];

  /**
   * ISO-8601 timestamp of the earliest commit across direct + child work.
   * `null` when no commits were found.
   */
  firstSeenAt: string | null;

  /**
   * ISO-8601 timestamp of the most recent commit across direct + child work.
   * `null` when no commits were found.
   */
  lastSeenAt: string | null;

  /**
   * Child task IDs discovered through commit-message mining or adjacency
   * heuristics. May include IDs not present in the task DB.
   */
  inferredChildren: string[];
}
