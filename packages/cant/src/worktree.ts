/**
 * Type-only deprecation shim for the legacy cant worktree API.
 *
 * @remarks
 * This file was 298 LOC of runtime worktree logic (the "2nd creation site"
 * flagged by the T9801 audit). Per T9986 / E9-RIP-LEGACY, the runtime has
 * been removed — all callers now route through `@cleocode/worktree` (the
 * canonical napi-backed SSoT).
 *
 * Two downstream consumers (`@cleocode/caamp`) still import
 * {@link WorktreeHandle} as a TYPE for their `SpawnOptions.worktree` and
 * `SubagentSpawnOptions.worktree` fields. To avoid a breaking change to
 * the spawn-adapter contract in the same release that rips the legacy
 * runtime, the type definitions are preserved here as a one-cycle
 * deprecation shim. The runtime functions (`createWorktree`,
 * `mergeWorktree`, `listWorktrees`, `resolveWorktreeRoot`) had ZERO
 * production consumers and have been deleted.
 *
 * Removal target: the next minor cycle after caamp migrates to
 * `@cleocode/worktree`'s `CreateWorktreeResult` shape directly.
 *
 * @packageDocumentation
 * @deprecated Import worktree primitives from `@cleocode/worktree` instead.
 *   This module retains only type shims for one deprecation cycle.
 * @task T9986
 */

/**
 * Request payload for creating a new git worktree.
 *
 * @deprecated Use `CreateWorktreeOptions` from `@cleocode/worktree` instead.
 */
export interface WorktreeRequest {
  /** The base ref to branch from (e.g. "main", "develop", a SHA). */
  baseRef: string;
  /** Branch name for the worktree. If absent, derived from taskId. */
  branchName?: string;
  /** Task ID driving this worktree. */
  taskId: string;
  /** Why this worktree is being created. */
  reason: 'subagent' | 'experiment' | 'parallel-wave';
}

/**
 * Handle returned after worktree creation; used for merge, env-var binding, and cleanup.
 *
 * @remarks
 * The `projectHash` field was added in T380/ADR-041 so callers can populate
 * `CLEO_PROJECT_HASH` in spawned subagent environments without threading
 * {@link WorktreeConfig} through every call site.
 *
 * Still consumed (as a type) by `@cleocode/caamp` for its
 * `SpawnOptions.worktree` and `SubagentSpawnOptions.worktree` fields.
 *
 * @task T380
 * @deprecated Migrate to `CreateWorktreeResult` from `@cleocode/worktree`.
 */
export interface WorktreeHandle {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch name created for this worktree. */
  branch: string;
  /** The base ref it was branched from. */
  baseRef: string;
  /** Task ID. */
  taskId: string;
  /**
   * Project hash used to scope this worktree under the XDG worktree root.
   *
   * @remarks
   * Sourced from {@link WorktreeConfig.projectHash} at creation time.
   * Exposed here so spawn adapters can populate the `CLEO_PROJECT_HASH`
   * environment variable without re-threading the full config.
   *
   * @task T380
   */
  projectHash: string;
  /** Clean up: remove the worktree and optionally delete the branch. */
  cleanup(deleteBranch?: boolean): void;
}

/**
 * Configuration for worktree path resolution and git operations.
 *
 * @deprecated `@cleocode/worktree` derives paths from `@cleocode/paths`
 *   directly; configuration is no longer threaded through call sites.
 */
export interface WorktreeConfig {
  /** Root directory for worktrees. Defaults to $XDG_DATA_HOME/cleo/worktrees/<projectHash>/ */
  worktreeRoot?: string;
  /** Project hash for path scoping. */
  projectHash: string;
  /** The project's git root directory. */
  gitRoot: string;
}

/**
 * Result of a merge operation.
 *
 * @deprecated Use `WorktreeMergeResult` from `@cleocode/contracts` instead.
 */
export interface MergeResult {
  /** Whether the merge succeeded. */
  success: boolean;
  /** Error message if the merge failed. */
  error?: string;
}

/**
 * Entry in the list of active worktrees.
 *
 * @deprecated Use `WorktreeListEntry` from `@cleocode/contracts` instead.
 */
export interface WorktreeEntry {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch checked out in this worktree. */
  branch: string;
}
