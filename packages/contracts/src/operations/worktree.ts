/**
 * Worktree backend SDK operation types (T1161).
 *
 * Wire-format types for the `@cleocode/worktree-backend` SDK surface.
 * Defines the contract for createWorktree, destroyWorktree, listWorktrees,
 * and pruneWorktrees operations with XDG path canon (D029) and declarative
 * hooks (D030 native lift of worktrunk missing features).
 *
 * @task T1161
 * @adr ADR-055
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
  event: 'post-create' | 'post-start';
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
  /** Environment variables to inject into the spawned agent process. */
  envVars: Record<string, string>;
  /** Prompt preamble text for agent isolation context. */
  preamble: string;
  /** Results of any post-create hooks that were executed. */
  hookResults: WorktreeHookResult[];
  /** Include patterns that were applied (empty if none). */
  appliedPatterns: WorktreeIncludePattern[];
}

// ---------------------------------------------------------------------------
// Destroy operation
// ---------------------------------------------------------------------------

/**
 * Options for destroying a worktree.
 *
 * @task T1161
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
   * When true, cherry-pick any commits on the task branch back to the
   * orchestrator's current branch before destroying.
   *
   * @default false
   */
  cherryPickFirst?: boolean;
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
  /** Whether cherry-pick was attempted and succeeded. */
  cherryPicked: boolean;
  /** Number of commits cherry-picked (0 if none or not requested). */
  commitCount: number;
  /** Error message if any step failed (non-fatal — caller decides). */
  error?: string;
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
