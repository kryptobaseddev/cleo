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

import type { ProcessCaptureResult, ProcessLaunchExecution } from './resource-governor.js';

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
  /** Assessment provenance; absent only on legacy results. New assessments always emit it.
   * @defaultValue undefined on legacy records only
   */
  assessment?: ReconstructAssessment;

  /** The task ID being reconstructed (e.g. `T991`). */
  taskId: string;

  /**
   * Commits whose message directly references `taskId`.
   * Exact word-boundary task tokens in the full subject and body, never numeric prefixes.
   */
  directCommits: CommitEntry[];

  /**
   * Numeric child ID range inferred from commit-message mining and numeric proximity (not authoritative containment).
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

/** Options for bounded Git-backed lineage assessment.
 * @remarks These options may shorten but never extend an inherited operation lifetime.
 * @example
 * ```ts
 * const options: ReconstructOptions = { execution: { deadlineAt: Date.now() + 1000 } };
 * ```
 */
export interface ReconstructOptions {
  /** Original caller deadline and cancellation.
   * @defaultValue inherited context, otherwise one two-second foreground budget
   */
  execution?: ProcessLaunchExecution;
  /** Combined capture byte ceiling across all commands.
   * @defaultValue 8388608
   */
  maxOutputBytes?: number;
}

/** Observed bounded command outcome without duplicating captured Git history.
 * @remarks Target outcome and cleanup evidence remain distinct.
 * @example
 * ```ts
 * const stopped = command.stopped;
 * ```
 */
export interface ReconstructCommand extends Omit<ProcessCaptureResult, 'stdout' | 'stderr'> {
  /** Exact requested Git arguments. */
  args: readonly string[];
  /** Diagnostic stderr, bounded by the shared output limit. */
  stderr: string;
}

/** Coverage and failure truth for a lineage assessment.
 * @remarks Current means the observed local Git scope was assessed, not complete remote history
 * or proven task containment. Partial results must not authorize provenance repair.
 * @example
 * ```ts
 * if (result.assessment?.coverage !== 'current') return;
 * ```
 */
export interface ReconstructAssessment {
  /** Absolute repository root captured before asynchronous work. */
  repositoryRoot: string;
  /** One absolute execution deadline, shared with every command and computation stage. */
  deadlineAt: number;
  /** Completeness of the observed local Git history and release-tag assessment. */
  coverage: 'current' | 'partial' | 'failed';
  /** Shallow history is explicitly incomplete; null means the probe did not complete. */
  shallow: boolean | null;
  /** Number of commits parsed from the bounded history, not total remote commits. */
  observedCommits: number;
  /** Whether all history records were parsed successfully. */
  historyComplete: boolean;
  /** Whether every commit-targeting tag was assessed successfully. */
  tagsComplete: boolean;
  /** Captured process verdicts and cleanup observations. */
  commands: ReconstructCommand[];
  /** Explicit failures and incomplete-scope reasons; never replaced with healthy empty arrays. */
  diagnostics: Array<{ code: string; stage: string; message: string }>;
  /** Non-authoritative inference and local-scope limitations retained even for current coverage. */
  limitations: string[];
}
