/**
 * Doctor domain contracts — types for `cleo doctor` worktree-orphan audit/prune.
 *
 * These types describe orphan `.cleo/` directories left behind under
 * `<projectRoot>/.claude/worktrees/` by the T9550/T9580 SSoT bug (fixed in
 * v2026.5.83) and the schema for the audit JSONL line written per prune.
 *
 * Also contains the comprehensive worktree audit types (T9808) covering:
 *   - Orphan `.cleo/` dirs inside ANY git worktree (not just .claude/worktrees/)
 *   - Worktrees outside the canonical XDG location
 *   - Rogue `.cleo/worktrees/` DIRECTORY (council D009 — only .json sentinel allowed)
 *
 * Consumed by:
 *   - `packages/core/src/doctor/worktree-orphans.ts` (scan + prune primitives)
 *   - `packages/cleo/src/cli/commands/doctor.ts` (CLI flags)
 *
 * @task T9790
 * @task T9808
 * @epic T9790
 * @epic T9808
 */

/**
 * One orphan `.cleo/` directory discovered under
 * `<projectRoot>/.claude/worktrees/`.
 *
 * Worktrees are nested 1-3 levels deep — examples:
 *   - `<projectRoot>/.claude/worktrees/agent-X/.cleo/`            (depth 1)
 *   - `<projectRoot>/.claude/worktrees/agent-X/T9220/.cleo/`     (depth 2)
 *
 * Each entry carries full provenance so the operator can decide whether
 * the orphan represents lost work before pruning.
 */
export interface OrphanEntry {
  /**
   * The worktree root that contains the orphan — the first directory under
   * `.claude/worktrees/` (e.g. `<projectRoot>/.claude/worktrees/agent-X`).
   * Used as the boundary that `pruneWorktreeOrphans` validates against.
   */
  worktreePath: string;

  /**
   * Absolute path to the orphan `.cleo/` directory itself. Always lives
   * under `worktreePath` (the security check rejects anything that doesn't).
   */
  orphanPath: string;

  /**
   * List of `tasks.db`, `brain.db`, `nexus.db`, or `config.json` paths
   * found inside the orphan. Empty array means the orphan exists but is
   * structurally empty (still pruned — it shouldn't be there at all).
   */
  dbFiles: string[];

  /** Total byte size of the orphan tree (sum of regular file sizes). */
  sizeBytes: number;

  /** ISO-8601 timestamp of the most recent file modification under the orphan. */
  lastModifiedAt: string;

  /**
   * Seconds since `lastModifiedAt` (relative to scan time). Surfaces "stale
   * vs recent" without forcing the caller to compute date math.
   */
  ageSeconds: number;

  /**
   * `true` when the orphan contains more than just stray DB files — e.g. a
   * full duplicate of `adrs/`, `agent-outputs/`, `rcasd/`, etc. These need
   * heightened operator review before pruning.
   */
  isFullDuplicate: boolean;
}

/**
 * Result of one prune operation. Reports the archive location, the per-entry
 * outcome, and any entries rejected by the security gate.
 */
export interface PruneResult {
  /**
   * Absolute path to the `.tar.gz` archive written before any deletion.
   * `null` only when `dryRun: true` AND no archive was produced.
   */
  archivePath: string | null;

  /** Whether this was a dry run (no archive, no rm, no audit-log line). */
  dryRun: boolean;

  /** Entries that were successfully pruned (or would be in dry-run mode). */
  pruned: OrphanEntry[];

  /**
   * Entries that failed validation and were skipped. The `reason` is a
   * stable machine-readable code (e.g. `path-outside-worktrees-root`,
   * `path-not-found`, `rm-failed`).
   */
  rejected: Array<{ entry: OrphanEntry; reason: string }>;

  /** Total bytes archived (sum of `pruned[].sizeBytes`). */
  totalSizeBytes: number;

  /** ISO-8601 timestamp the prune completed. */
  prunedAt: string;
}

// ============================================================================
// Comprehensive Worktree Audit (T9808 — council D009)
// ============================================================================

/**
 * Anomaly kinds surfaced by {@link auditWorktreeOrphansComprehensive}.
 *
 * - `orphan-cleo-dir`: a `.cleo/` directory found inside a git worktree path
 *   (any worktree, not just those under `.claude/worktrees/`)
 * - `non-canonical-location`: a worktree exists outside the canonical XDG
 *   path (`~/.local/share/cleo/worktrees/<projectHash>/<taskId>/`)
 * - `rogue-worktrees-directory`: `.cleo/worktrees/` exists as a DIRECTORY
 *   (council D009: only a `.json` sentinel file is permitted there)
 */
export type WorktreeAnomalyKind =
  | 'orphan-cleo-dir'
  | 'non-canonical-location'
  | 'rogue-worktrees-directory';

/**
 * One anomaly surfaced by the comprehensive worktree audit.
 */
export interface WorktreeAnomaly {
  /** Machine-readable anomaly type. */
  kind: WorktreeAnomalyKind;
  /**
   * Absolute path of the affected location.
   * - For `orphan-cleo-dir`: path to the offending `.cleo/` directory.
   * - For `non-canonical-location`: path to the non-canonical worktree root.
   * - For `rogue-worktrees-directory`: path to the `.cleo/worktrees/` directory.
   */
  path: string;
  /** Human-readable description including suggested remediation. */
  description: string;
  /**
   * The git worktree path that triggered this anomaly (from `git worktree list`),
   * or `null` for anomalies not tied to a specific worktree entry.
   */
  worktreePath: string | null;
}

/**
 * Result returned by {@link auditWorktreeOrphansComprehensive}.
 */
export interface ComprehensiveAuditResult {
  /** Absolute path to the project root that was audited. */
  projectRoot: string;
  /** Canonical XDG worktrees root for this project (expected location). */
  canonicalWorktreesRoot: string;
  /** All anomalies detected. Sorted by `kind` then `path`. */
  anomalies: WorktreeAnomaly[];
  /** Total anomaly count. Non-zero triggers exit code 2. */
  count: number;
  /**
   * `true` when the audit was aborted early due to a width budget overflow
   * or a timeout. The `anomalies` list reflects only the entries scanned
   * before the abort — results may be incomplete.
   */
  isPartial?: boolean;
  /**
   * Machine-readable reason the scan was cut short.
   * - `'timeout'`: the configured `timeoutMs` was exceeded.
   * - `'overflow'`: a per-level entry count exceeded `maxEntriesPerLevel`.
   */
  partialReason?: 'timeout' | 'overflow';
}

/**
 * Result shape returned by the budgeted orphan scanner
 * ({@link scanWorktreeOrphansBudgeted}).
 *
 * Wraps the bare `OrphanEntry[]` from `scanWorktreeOrphans` with optional
 * partial-result metadata so callers can surface incomplete scans to the
 * operator without changing the existing `OrphanEntry[]` return type.
 */
export interface OrphanScanResult {
  /** Discovered orphan entries (may be incomplete when `isPartial` is `true`). */
  orphans: OrphanEntry[];
  /**
   * `true` when the scan was aborted before completion due to a budget
   * overflow or timeout. The `orphans` list reflects only entries found
   * before the abort.
   */
  isPartial: boolean;
  /**
   * Machine-readable reason the scan was cut short.
   * - `'timeout'`: the configured `timeoutMs` was exceeded.
   * - `'overflow'`: a per-level entry count exceeded `maxEntriesPerLevel`.
   * `undefined` when `isPartial` is `false`.
   */
  partialReason?: 'timeout' | 'overflow';
  /**
   * Human-readable warning message produced when the soft-warn threshold
   * was crossed (entries per level exceeded `softWarnEntriesPerLevel` but
   * stayed under the hard stop). `undefined` when no warning was triggered.
   */
  softWarnMessage?: string;
}

/**
 * One line appended to `.cleo/audit/worktree-prune.jsonl` per prune
 * operation. Extends the existing audit-log schema (timestamp +
 * worktreePath + action + agent) with the orphan-specific fields needed
 * to reconstruct what was removed.
 *
 * Existing fields preserved for schema continuity:
 *   - `timestamp`, `worktreePath`, `action`, `agent`
 *
 * New fields for orphan prune:
 *   - `orphanPath`, `sizeBytes`, `dbFileCount`, `archivePath`, `dryRun`
 */
export interface PruneAuditEntry {
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Worktree root that contained the orphan. */
  worktreePath: string;
  /** Absolute path to the orphan `.cleo/` directory removed. */
  orphanPath: string;
  /** Action code — fixed to `'prune-worktree-orphan'` for this flow. */
  action: 'prune-worktree-orphan';
  /** Always `'cleo'` — written by `cleo doctor`. */
  agent: 'cleo';
  /** Byte size of the pruned tree. */
  sizeBytes: number;
  /** Number of DB files found in the orphan (informational). */
  dbFileCount: number;
  /** Absolute path to the archive. `null` only on dry-run lines. */
  archivePath: string | null;
  /** Whether this entry represents a dry-run plan (no actual removal). */
  dryRun: boolean;
}
