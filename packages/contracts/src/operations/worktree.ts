/**
 * Worktree backend SDK operation types (T1161).
 *
 * Wire-format types for the `@cleocode/worktree` SDK surface.
 * Defines the contract for createWorktree, destroyWorktree, listWorktrees,
 * and pruneWorktrees operations with XDG path canon (D029) and declarative
 * hooks (D030 native lift of worktrunk missing features).
 *
 * Worktree integration uses `git merge --no-ff` per ADR-062. The legacy
 * cherry-pick integration path was removed in T1624.
 *
 * @task T1161
 * @adr ADR-055
 * @adr ADR-062
 */

// ---------------------------------------------------------------------------
// Hooks framework
// ---------------------------------------------------------------------------

/**
 * A declarative lifecycle hook definition for worktree events.
 *
 * Hooks are executed synchronously (shell commands) or via node spawns
 * in the worktree directory. Mirrors the worktrunk hooks contract lifted
 * natively per D030.
 *
 * @task T1161
 */
export interface WorktreeHook {
  /** Shell command to run (executed via `sh -c` in the worktree dir). */
  command: string;
  /**
   * When to run the hook.
   *
   * - `post-create` — immediately after `git worktree add` succeeds.
   * - `post-start`  — after the agent CWD is established (env vars injected).
   */
  event: 'post-create' | 'post-start' | 'pre-remove' | 'post-destroy';
  /**
   * Optional timeout in milliseconds before the hook is killed.
   *
   * @default 30000
   */
  timeoutMs?: number;
  /**
   * When true, a non-zero exit from this hook causes the worktree operation
   * to fail. When false (default), errors are logged but ignored.
   *
   * @default false
   */
  failOnError?: boolean;
}

/**
 * Result of a single hook execution.
 *
 * @task T1161
 */
export interface WorktreeHookResult {
  /** The hook that was executed. */
  hook: WorktreeHook;
  /** Whether the hook exited with code 0. */
  success: boolean;
  /** Hook stdout (trimmed). */
  stdout: string;
  /** Hook stderr (trimmed). */
  stderr: string;
  /** Exit code (null if killed by timeout). */
  exitCode: number | null;
  /** Duration in milliseconds. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Worktree-include glob pattern
// ---------------------------------------------------------------------------

/**
 * A parsed entry from `.cleo/worktree-include`.
 *
 * The file lists glob patterns (one per line, `#` comments stripped) that
 * control which files from the main project tree are symlinked or copied
 * into new worktrees on creation. This is a native lift of the worktrunk
 * `.cleo/worktree-include` feature (D030).
 *
 * @task T1161
 */
export interface WorktreeIncludePattern {
  /** The raw glob pattern string (e.g. `node_modules/.pnpm/**`). */
  pattern: string;
  /**
   * Whether this entry was negated (prefixed with `!`).
   *
   * @default false
   */
  negated: boolean;
}

// ---------------------------------------------------------------------------
// Create operation
// ---------------------------------------------------------------------------

/**
 * Options for creating a new agent worktree.
 *
 * @task T1161
 */
export interface CreateWorktreeOptions {
  /** The task ID that will own this worktree. */
  taskId: string;
  /** The base ref to branch from (default: current HEAD). */
  baseRef?: string;
  /** Explicit branch name. Defaults to `task/<taskId>`. */
  branchName?: string;
  /**
   * Reason for creation. Used for git worktree lock comment and audit logs.
   *
   * @default 'subagent'
   */
  reason?: 'subagent' | 'experiment' | 'parallel-wave';
  /** Declarative hooks to run after creation. */
  hooks?: WorktreeHook[];
  /**
   * When true, read `.cleo/worktree-include` from the project root and apply
   * any declared include patterns to the new worktree.
   *
   * @default true
   */
  applyIncludePatterns?: boolean;
  /**
   * When true, apply git worktree lock (`git worktree lock`) to prevent
   * accidental pruning by git.
   *
   * @default true
   */
  lockWorktree?: boolean;
  /**
   * Glob patterns to exclude from the worktree via sparse-checkout after
   * creation (T9226 spawn-clone-exclude filter).
   *
   * When set, `createWorktree` enables sparse-checkout on the new worktree
   * and hides all files matching any pattern. Callers should also supply
   * `spawnCloneExcludeExempt` to preserve the task-scoped file.
   *
   * @task T9226
   */
  spawnCloneExclude?: readonly string[];
  /**
   * When `true`, forcibly reset an existing `task/<taskId>` branch that has
   * orphan commits (commits not reachable from `baseRef`).
   *
   * Without this flag, `createWorktree` throws `E_DIRTY_BRANCH` when an orphan
   * branch is detected so the caller can investigate before losing history.
   * Set to `true` only when you are certain the prior branch state is stale and
   * safe to discard (e.g. CI retry or integration-test re-runs).
   *
   * @default false
   * @task T1927
   */
  forceReset?: boolean;
}

/**
 * Result of a successful worktree creation.
 *
 * @task T1161
 */
export interface CreateWorktreeResult {
  /**
   * Absolute path to the created worktree directory.
   *
   * Always under `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/`
   * per D029 canonical layout.
   */
  path: string;
  /** Branch name created for this worktree (format: `task/<taskId>`). */
  branch: string;
  /** Base ref the branch was created from. */
  baseRef: string;
  /** Task ID that owns this worktree. */
  taskId: string;
  /** Project hash scoping this worktree under the XDG root. */
  projectHash: string;
  /** ISO 8601 timestamp when the worktree was created. */
  createdAt: string;
  /** Whether git worktree lock was applied. */
  locked: boolean;
  /**
   * Whether the worktree was attached to a pre-existing `task/<taskId>` branch
   * instead of creating a fresh one. True when a prior aborted spawn left the
   * branch behind; false on a clean first-time creation.
   *
   * @task T1878
   */
  reused: boolean;
  /** Environment variables to inject into the spawned agent process. */
  envVars: Record<string, string>;
  /** Prompt preamble text for agent isolation context. */
  preamble: string;
  /** Results of any post-create hooks that were executed. */
  hookResults: WorktreeHookResult[];
  /** Include patterns that were applied (empty if none). */
  appliedPatterns: WorktreeIncludePattern[];
  /**
   * Dependency bootstrap results: paths copied via copy-on-write and
   * post-start hook results.
   */
  bootstrap?: {
    /** Paths successfully copied into the worktree. */
    copiedPaths: string[];
    /** Paths that failed to copy. */
    failedPaths: string[];
    /** Results of post-start hooks. */
    hookResults: WorktreeHookResult[];
  };
}

// ---------------------------------------------------------------------------
// Destroy operation
// ---------------------------------------------------------------------------

/**
 * Options for destroying a worktree.
 *
 * Integration (cherry-pick or merge) is performed separately via
 * `completeAgentWorktreeViaMerge` before calling destroy. Destroy only
 * removes the worktree filesystem entry and optionally the task branch.
 *
 * @task T1161
 * @adr ADR-062
 */
export interface DestroyWorktreeOptions {
  /** Task ID whose worktree to destroy. */
  taskId: string;
  /**
   * When true, delete the associated git branch after removing the worktree.
   *
   * @default true
   */
  deleteBranch?: boolean;
  /**
   * When true, force destruction even if the worktree has uncommitted changes.
   *
   * @default false
   */
  force?: boolean;
  /** Declarative hooks to run during destruction lifecycle. */
  hooks?: WorktreeHook[];
}

/**
 * Result of a worktree destroy operation.
 *
 * @task T1161
 */
export interface DestroyWorktreeResult {
  /** Task ID that was destroyed. */
  taskId: string;
  /** Whether the worktree directory was successfully removed. */
  worktreeRemoved: boolean;
  /** Whether the task branch was deleted. */
  branchDeleted: boolean;
  /** Error message if any step failed (non-fatal — caller decides). */
  error?: string;
  /** Whether the worktree had uncommitted changes when destruction was attempted. */
  dirty?: boolean;
  /** Whether force mode was used to override dirty detection. */
  force?: boolean;
  /** Results of pre-remove and post-destroy hooks. */
  hookResults?: WorktreeHookResult[];
}

// ---------------------------------------------------------------------------
// List operation
// ---------------------------------------------------------------------------

/**
 * A single entry from the worktree listing.
 *
 * @task T1161
 */
export interface WorktreeListEntry {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch checked out in this worktree. */
  branch: string;
  /**
   * Task ID derived from the worktree directory name.
   *
   * Convention: the last path segment is the taskId.
   */
  taskId: string;
  /** Project hash derived from the path. */
  projectHash: string;
}

/**
 * Options for listing worktrees.
 *
 * @task T1161
 */
export interface ListWorktreesOptions {
  /** Filter to only return worktrees for a specific project hash. */
  projectHash?: string;
}

// ---------------------------------------------------------------------------
// Prune operation
// ---------------------------------------------------------------------------

/**
 * Options for pruning orphaned worktrees.
 *
 * @task T1161
 */
export interface PruneWorktreesOptions {
  /** Absolute path to the project root (used to resolve the worktree root). */
  projectRoot: string;
  /**
   * Set of task IDs to preserve. Any worktree directory whose name is NOT in
   * this set will be pruned.
   *
   * When omitted, only stale git administrative entries are pruned (via
   * `git worktree prune`). No worktree directories are removed.
   */
  preserveTaskIds?: Set<string>;
  /**
   * When true, also run `git worktree prune` to clean up stale git
   * administrative entries even if `preserveTaskIds` is not provided.
   *
   * @default true
   */
  gitPrune?: boolean;
}

/**
 * Result of a prune operation.
 *
 * @task T1161
 */
export interface PruneWorktreesResult {
  /** Number of worktree directories removed. */
  removed: number;
  /** Absolute paths that were removed. */
  removedPaths: string[];
  /** Entries that failed to remove (with reasons). */
  errors: Array<{ path: string; reason: string }>;
  /** Whether `git worktree prune` was run. */
  gitPruneRan: boolean;
}

// ---------------------------------------------------------------------------
// Structured listing (T9546 — worktree-lifecycle 2/5)
// ---------------------------------------------------------------------------

/**
 * Mutually-exclusive worktree status category assigned by orphan-detection
 * heuristics in {@link WorktreeInfo}.
 *
 * Resolution precedence (first match wins):
 *  1. `locked` — git porcelain reports the worktree is locked.
 *  2. `orphan` — owning task is cancelled OR the branch has been deleted.
 *  3. `merged` — the branch is reachable from `main` (already integrated).
 *  4. `stale`  — no commits in N days AND (task=done OR no live owner).
 *  5. `active` — everything else (default).
 *
 * @task T9546
 */
export type WorktreeStatusCategory = 'active' | 'stale' | 'merged' | 'orphan' | 'locked';

/**
 * A single structured worktree entry with full status classification.
 *
 * Returned by `cleo worktree list` and the `worktree.list` dispatch operation.
 * Each entry combines filesystem state, git state, and owning-task state into
 * a single JSON envelope payload that downstream consumers (prune, dashboard,
 * sentient daemon) can act on without re-querying git.
 *
 * @task T9546
 */
export interface WorktreeInfo {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch checked out in this worktree. */
  branch: string;
  /** Task ID derived from the branch name (`task/T####`), or null. */
  taskId: string | null;
  /** Agent identifier that owns this worktree (from audit log / metadata), or null. */
  owningAgent: string | null;
  /** ISO-8601 timestamp of last activity (newest commit OR mtime of working tree). */
  lastActivity: string;
  /** Whether `git worktree list --porcelain` reports the worktree as locked. */
  isLocked: boolean;
  /** Whether the worktree is stale: no activity > N days AND (task done/cancelled OR branch merged). */
  isStale: boolean;
  /** Whether the branch is reachable from `main` (already integrated). */
  isMerged: boolean;
  /** Status of the owning task (if {@link taskId} is present and resolvable), or null. */
  owningTaskStatus: string | null;
  /** Mutually-exclusive status category — see {@link WorktreeStatusCategory}. */
  statusCategory: WorktreeStatusCategory;
}

/**
 * Options for the structured worktree listing operation.
 *
 * @task T9546
 */
export interface ListWorktreesOpts {
  /**
   * Absolute path to the project root (used to compute the project hash
   * and resolve the canonical worktrees directory).
   */
  projectRoot?: string;
  /**
   * Filter results to entries with one of these status categories.
   * When omitted, all entries are returned.
   */
  statusFilter?: WorktreeStatusCategory[];
  /**
   * Staleness threshold in days. An entry is marked stale when its last
   * activity is older than this AND either the owning task is done/cancelled
   * or no owning task can be resolved while the branch is merged.
   *
   * @default 7
   */
  staleDays?: number;
}

/**
 * Result of the structured worktree listing operation.
 *
 * @task T9546
 */
export interface ListWorktreesResult {
  /** All matched worktree entries (post-filter). */
  worktrees: WorktreeInfo[];
}
