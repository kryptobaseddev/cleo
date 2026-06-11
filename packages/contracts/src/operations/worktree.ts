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
  /**
   * Sparse-checkout scope pattern (T9807). When set, `createWorktree` runs
   * `git sparse-checkout init --cone` followed by
   * `git sparse-checkout set <spawnScope>` after `git worktree add` completes,
   * limiting the worktree's checked-out tree to paths matching `<spawnScope>`.
   *
   * Exposed on `cleo orchestrate spawn` as the `--scope` flag so callers can
   * request a lean worktree containing only the paths relevant to a task
   * (e.g. `packages/cleo` to contain a CLI-only fix).
   *
   * Cone mode (`--cone`) is used for maximum checkout performance — the scope
   * string must be a directory prefix, not an arbitrary glob.
   *
   * Failures are silently swallowed (best-effort) — the worktree is returned
   * in full-checkout mode when sparse-checkout setup fails.
   *
   * @task T9807
   */
  spawnScope?: string;
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
  /**
   * Free-form reason string appended to the lifecycle audit log (T9805).
   *
   * Examples: `'pr-merged'`, `'manual'`, `'idle-timeout'`.
   *
   * @default 'manual'
   */
  reason?: string;
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
  /**
   * Abandonment-timeout threshold in days (T9805 AC2).
   *
   * When set, worktrees whose branch has had no commits for at least this many
   * days AND which have no open PR associated are eligible for pruning, even
   * if their task ID is not in a known-stale set.
   *
   * @default undefined — disabled; no idle-age check is performed.
   */
  idleDays?: number;
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
  /** Number of worktrees quarantined (dirty/unpushed — preserved, not deleted). */
  quarantined: number;
  /** Absolute paths of quarantined worktrees. */
  quarantinedPaths: string[];
  /** Entries that failed to remove (with reasons). */
  errors: Array<{ path: string; reason: string }>;
  /** Whether `git worktree prune` was run. */
  gitPruneRan: boolean;
  /**
   * True when pruning was skipped entirely because the preserve set was empty
   * or the task store was unreadable while worktrees exist (fail-closed guard,
   * T11996). A structured audit warning is written to the lifecycle log.
   */
  skippedFailClosed?: boolean;
}

// ---------------------------------------------------------------------------
// Structured listing (T9546 — worktree-lifecycle 2/5)
// ---------------------------------------------------------------------------

/**
 * Mutually-exclusive worktree status category assigned by orphan-detection
 * heuristics in {@link WorktreeInfo}.
 *
 * Resolution precedence (first match wins):
 *  1. `active` — primary worktree guard: the canonical project checkout
 *     (the directory containing `.git/`, not a `git worktree add` derivative)
 *     is ALWAYS active, regardless of merge state. Without this guard the
 *     `main` branch would classify as `merged` (it is trivially its own
 *     ancestor) and `cleo worktree prune --orphaned` would offer to delete
 *     the project root. (T9686-D)
 *  2. `locked` — git porcelain reports the worktree is locked.
 *  3. `orphan` — owning task is cancelled OR the branch has been deleted.
 *  4. `merged` — the branch is reachable from `main` (already integrated).
 *  5. `stale`  — no commits in N days AND (task=done OR no live owner).
 *  6. `active` — everything else (default).
 *
 * @task T9546
 */
export type WorktreeStatusCategory = 'active' | 'stale' | 'merged' | 'orphan' | 'locked';

/**
 * Source classifier for a worktree entry.
 *
 * - `cleo-spawn`   — Created by `cleo orchestrate spawn` via the canonical XDG path.
 * - `claude-agent` — Created by Claude Code Agent `isolation:worktree` dispatch (T9804).
 * - `manual`       — Created directly via `git worktree add` without CLEO CLI involvement.
 * - `adopted`      — Registered via `cleo worktree adopt` from an unknown origin.
 *
 * The `source` field enables downstream consumers (prune, dashboard, sentient daemon)
 * to apply different policies per origin without re-querying git.
 *
 * @task T9804
 */
export type WorktreeSource = 'cleo-spawn' | 'claude-agent' | 'manual' | 'adopted';

/**
 * A single structured worktree entry with full status classification.
 *
 * Returned by `cleo worktree list` and the `worktree.list` dispatch operation.
 * Each entry combines filesystem state, git state, and owning-task state into
 * a single JSON envelope payload that downstream consumers (prune, dashboard,
 * sentient daemon) can act on without re-querying git.
 *
 * @task T9546
 * @task T9804 — added `source` field for multi-source listing
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
  /**
   * ISO-8601 timestamp recording when this worktree was first created.
   *
   * Resolution order:
   *  1. For git-native entries — mtime of the per-worktree admin file
   *     `<gitCommonDir>/worktrees/<basename(path)>/HEAD`. Git writes this once
   *     at `git worktree add` time and never rewrites it during normal usage,
   *     making it a faithful proxy for creation time.
   *  2. For sentinel-only entries — the `adoptedAt` timestamp persisted in
   *     `.cleo/worktrees.json`.
   *  3. Fallback — mtime of the worktree directory itself.
   *
   * Distinct from {@link lastActivity}, which moves with each new commit on
   * the branch. The two values diverge for any worktree that has had at least
   * one commit since creation.
   *
   * @task T9546
   */
  createdAt: string;
  /** Whether `git worktree list --porcelain` reports the worktree as locked. */
  isLocked: boolean;
  /**
   * Lock-state string mirroring {@link isLocked} as a discriminated literal.
   *
   * Provided for downstream consumers that want a single human-readable token
   * rather than a boolean — `'locked'` when porcelain reports the worktree as
   * locked, `'unlocked'` otherwise. Always equivalent to
   * `isLocked ? 'locked' : 'unlocked'`.
   *
   * @task T9546
   */
  lockState: 'locked' | 'unlocked';
  /** Whether the worktree is stale: no activity > N days AND (task done/cancelled OR branch merged). */
  isStale: boolean;
  /** Whether the branch is reachable from `main` (already integrated). */
  isMerged: boolean;
  /** Status of the owning task (if {@link taskId} is present and resolvable), or null. */
  owningTaskStatus: string | null;
  /** Mutually-exclusive status category — see {@link WorktreeStatusCategory}. */
  statusCategory: WorktreeStatusCategory;
  /**
   * Origin of this worktree entry.
   *
   * - `cleo-spawn`   — Canonical XDG worktree created by `cleo orchestrate spawn`.
   * - `claude-agent` — Created by Claude Code Agent `isolation:worktree` (T9804).
   * - `manual`       — Created via direct `git worktree add`.
   * - `adopted`      — Registered via `cleo worktree adopt`.
   *
   * For backward-compatibility this field defaults to `cleo-spawn` for entries
   * that originated from `git worktree list --porcelain` and are NOT present in
   * the sentinel index.
   *
   * @task T9804
   * @default 'cleo-spawn'
   */
  source: WorktreeSource;
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

// ---------------------------------------------------------------------------
// Lifecycle prune + force-unlock (T9547 — worktree-lifecycle 3/5)
// ---------------------------------------------------------------------------

/**
 * Canonical action recorded in `.cleo/audit/worktree-lifecycle.jsonl`.
 *
 * - `create` — worktree was created via `cleo orchestrate spawn` (T9805).
 * - `destroy` — worktree was explicitly destroyed (PR-merged cleanup or manual) (T9805).
 * - `adopt` — an existing worktree directory was attached to a new task ID (T9805).
 * - `prune` — orphaned/merged worktree was removed.
 * - `prune-skip` — orphan was detected but skipped (user said N, or had uncommitted changes).
 * - `force-unlock` — git index.lock removed + `git worktree unlock` ran.
 * - `complete` — worktree was merged (`--no-ff`) into the default branch and pruned (T9548).
 * - `complete-skip` — idempotent no-op (worktree already integrated or branch absent) (T9548).
 * - `complete-manual` — operator marked the worktree as manually-handled via
 *                       `--resolve manual`; no automatic merge attempted (T9548).
 * - `complete-conflict` — auto-merge attempted but failed (e.g. rebase/merge conflict);
 *                          worktree was preserved for manual resolution (T9548).
 * - `adopt` — externally-created worktree (e.g. Claude Code Agent `isolation:worktree`)
 *             registered in the CLEO SSoT via `cleo worktree adopt` (T9804).
 *
 * @task T9547
 * @task T9548
 * @task T9804
 * @task T9805
 */
export type WorktreeLifecycleAction =
  | 'create'
  | 'destroy'
  | 'adopt'
  | 'prune'
  | 'prune-skip'
  | 'quarantine'
  | 'force-unlock'
  | 'complete'
  | 'complete-skip'
  | 'complete-manual'
  | 'complete-conflict'
  | 'adopt';

/**
 * One append-only entry written to `.cleo/audit/worktree-lifecycle.jsonl` by
 * the prune + force-unlock commands.
 *
 * The shape intentionally mirrors the existing audit-jsonl pattern used by
 * `worktree-prune.jsonl` (single-task path) so downstream log shippers can
 * unify both streams. Optional fields are omitted (not null) when absent,
 * keeping the JSONL surface compact and grep-friendly.
 *
 * @task T9547
 */
export interface WorktreeLifecycleAuditEntry {
  /** ISO-8601 timestamp when the action was attempted. */
  timestamp: string;
  /** Agent / actor that initiated the action (env `CLEO_AGENT_ID` ?? `'cleo'`). */
  actor: string;
  /** The action performed — see {@link WorktreeLifecycleAction}. */
  action: WorktreeLifecycleAction;
  /** Absolute path to the worktree directory the action targeted. */
  target: string;
  /** Branch name (e.g. `task/T9547`) when known. */
  branch?: string;
  /** Task ID parsed from the branch name when known. */
  taskId?: string;
  /** Free-form reason — e.g. `orphaned-merged`, `dirty-skip`, `index-lock`. */
  reason?: string;
  /** Whether the action completed without error. */
  success: boolean;
  /** Error message when {@link success} is false. */
  error?: string;
}

/**
 * Options for {@link pruneOrphanedWorktreesByStatus} — the SDK primitive behind
 * `cleo worktree prune --orphaned`.
 *
 * Per-orphan Y/N confirmation is the responsibility of the CLI layer; the SDK
 * primitive itself is non-interactive and acts on the input set wholesale.
 *
 * @task T9547
 */
export interface PruneOrphanedWorktreesOpts {
  /** Absolute path to the project root used for git invocations + audit log. */
  projectRoot: string;
  /**
   * When true, do not actually remove worktrees — return the set that WOULD
   * be pruned with `success: true` and the appropriate `reason`. The audit
   * log is NOT written under `--dry-run`.
   *
   * @default false
   */
  dryRun?: boolean;
  /**
   * Staleness threshold in days passed through to {@link listWorktrees} when
   * the caller wants a non-default `isStale` window.
   *
   * @default 7
   */
  staleDays?: number;
  /**
   * Optional subset of paths to prune. When supplied, only worktrees whose
   * absolute `path` matches one of these strings are removed. The CLI passes
   * this set after the user has confirmed per-orphan; in pure SDK use, omit
   * the field to prune every orphan/merged entry the listing surfaces.
   */
  paths?: readonly string[];
  /**
   * Override actor name written to the audit log. Defaults to
   * `process.env.CLEO_AGENT_ID ?? 'cleo'`.
   */
  actor?: string;
  /**
   * Optional override for the audit-log file path (testing). When omitted,
   * writes to `<projectRoot>/.cleo/audit/worktree-lifecycle.jsonl`.
   */
  auditLogPath?: string;
}

/**
 * Per-worktree outcome from a prune attempt.
 *
 * @task T9547
 */
export interface PrunedWorktreeOutcome {
  /** Absolute path of the worktree. */
  path: string;
  /** Branch name (when known) — used by callers to render audit summaries. */
  branch: string;
  /** Task ID derived from the branch (when known). */
  taskId: string | null;
  /** Why this worktree was selected — e.g. `orphaned-merged`, `orphan-cancelled`. */
  reason: string;
  /** Whether the worktree was actually removed (false under --dry-run or on error). */
  pruned: boolean;
  /** Whether the task branch was deleted (only true when it was safe to do so). */
  branchDeleted: boolean;
  /** Error message when prune failed (set only on `pruned=false` + error path). */
  error?: string;
}

/**
 * Result of {@link pruneOrphanedWorktreesByStatus}.
 *
 * @task T9547
 */
export interface PruneOrphanedWorktreesResult {
  /** Number of worktrees successfully pruned. */
  prunedCount: number;
  /** Number of orphans detected but NOT pruned (filtered by `paths`, dry-run, or errored). */
  skippedCount: number;
  /** Per-worktree outcomes, one entry per orphan that was considered. */
  outcomes: PrunedWorktreeOutcome[];
  /** Per-worktree errors raised during prune (subset of {@link outcomes} where `error` is set). */
  errors: Array<{ path: string; error: string }>;
  /** Whether {@link PruneOrphanedWorktreesOpts.dryRun} was set. */
  dryRun: boolean;
}

/**
 * Options for {@link forceUnlockWorktree} — the SDK primitive behind
 * `cleo worktree force-unlock <taskId>`.
 *
 * @task T9547
 */
export interface ForceUnlockWorktreeOpts {
  /** Absolute path to the project root used for git invocations. */
  projectRoot: string;
  /** Task ID whose worktree should be force-unlocked. */
  taskId: string;
  /** Override actor name written to the audit log. */
  actor?: string;
  /** Optional override for the audit-log file path (testing). */
  auditLogPath?: string;
}

/**
 * Result of {@link forceUnlockWorktree}.
 *
 * @task T9547
 */
export interface ForceUnlockWorktreeResult {
  /** Task ID whose worktree was located. */
  taskId: string;
  /** Absolute path to the worktree (when located). */
  path: string | null;
  /** Whether `.git/index.lock` was present and removed. */
  indexLockRemoved: boolean;
  /** Whether `git worktree unlock` was executed (because porcelain reported `locked`). */
  worktreeUnlocked: boolean;
  /** Whether the worktree had uncommitted changes at the time of unlock (warn-only). */
  hadUncommittedChanges: boolean;
  /** Aggregate success — true when at least one unlock action ran without error. */
  success: boolean;
  /** Error message when no worktree could be located or all actions failed. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Adopt operation (T9804 — Claude Code Agent isolation:worktree bridge)
// ---------------------------------------------------------------------------

/**
 * Options for {@link adoptWorktree} — the SDK primitive behind
 * `cleo worktree adopt <path>`.
 *
 * @task T9804
 */
export interface AdoptWorktreeOpts {
  /**
   * Absolute path to the worktree directory to adopt.
   *
   * Typically a path under `.claude/worktrees/<sessionId>/` for Claude Code
   * Agent `isolation:worktree` spawns, but any valid worktree path is accepted.
   */
  worktreePath: string;
  /**
   * Absolute path to the project root. Used to resolve the sentinel index
   * and the audit-log file.
   *
   * @default process.cwd()
   */
  projectRoot?: string;
  /**
   * Source classification for this worktree.
   *
   * @default 'claude-agent'
   */
  source?: WorktreeSource;
  /**
   * Task ID to associate with this worktree. When not supplied the function
   * attempts to extract it from the branch name following the `task/T####`
   * convention, then falls back to null.
   */
  taskId?: string | null;
  /** Override actor name written to the audit log and sentinel index. */
  actor?: string;
  /** Optional override for the audit-log file path (testing). */
  auditLogPath?: string;
  /** Optional override for the sentinel index path (testing). */
  sentinelIndexPath?: string;
}

/**
 * Result of a successful `cleo worktree adopt` operation.
 *
 * @task T9804
 */
export interface AdoptWorktreeResult {
  /** Absolute path of the adopted worktree. */
  path: string;
  /** Branch name extracted from the worktree `.git` gitlink. */
  branch: string;
  /** Task ID associated with the worktree (null if not determinable). */
  taskId: string | null;
  /** Source classification applied to this entry. */
  source: WorktreeSource;
  /**
   * Whether this was a new adoption (`true`) or an idempotent re-adopt
   * of an already-registered worktree (`false`).
   */
  isNew: boolean;
  /** ISO-8601 timestamp when the sentinel entry was written. */
  adoptedAt: string;
}
