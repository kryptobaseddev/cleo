/**
 * Branch-lock and owner-override authentication contracts for T1118.
 *
 * Defines types, error codes, and interfaces for the four-layer agent
 * branch-protection system:
 *
 * - L1: Git worktree isolation per spawned agent
 * - L2: git-shim binary on PATH for harness-agnostic enforcement
 * - L3: Filesystem hardening via chmod (+ optional chattr on Linux)
 * - L4: Owner-override HMAC session authentication with TTY + rate-limit gates
 *
 * @task T1118
 * @adr ADR-055
 */

// ---------------------------------------------------------------------------
// L1 — Worktree lifecycle types
// ---------------------------------------------------------------------------

/**
 * State of an agent worktree created by orchestrate.spawn.
 *
 * @task T1118
 * @task T1120
 */
export interface AgentWorktreeState {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch name (format: task/<taskId>). */
  branch: string;
  /** Task ID that owns this worktree. */
  taskId: string;
  /** Base ref the branch was created from (e.g. "main"). */
  baseRef: string;
  /** Project hash for env-var injection. */
  projectHash: string;
  /** ISO 8601 timestamp when the worktree was created. */
  createdAt: string;
  /** Whether git worktree lock was applied to this entry. */
  locked: boolean;
}

/**
 * Result of creating a worktree during spawn.
 *
 * @task T1118
 * @task T1120
 */
export interface WorktreeSpawnResult {
  /** The created worktree state. */
  worktree: AgentWorktreeState;
  /** Environment variables to inject into the agent's process. */
  envVars: Record<string, string>;
  /** CWD the agent MUST be started in. */
  cwd: string;
  /** Preamble text to prepend to the agent's spawn prompt. */
  preamble: string;
}

/**
 * Result from the orchestrate.worktree.complete operation.
 *
 * @task T1118
 * @task T1120
 */
export interface WorktreeCompleteResult {
  /** Task ID that was completed. */
  taskId: string;
  /** Whether the cherry-pick succeeded. */
  cherryPicked: boolean;
  /** Number of commits cherry-picked. */
  commitCount: number;
  /** Whether the worktree was removed. */
  worktreeRemoved: boolean;
  /** Whether the task branch was deleted. */
  branchDeleted: boolean;
  /** Error message if any step failed (non-fatal — caller decides). */
  error?: string;
}

/**
 * Result from the orchestrate.worktree.cleanup operation.
 *
 * @task T1118
 * @task T1120
 */
export interface WorktreeCleanupResult {
  /** Number of stale worktrees removed. */
  removed: number;
  /** Paths that were removed. */
  removedPaths: string[];
  /** Paths that failed to remove (with reasons). */
  errors: Array<{ path: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// L2 — Git shim contract types
// ---------------------------------------------------------------------------

/**
 * Environment variables read by the git-shim binary.
 *
 * @task T1118
 * @task T1121
 */
export interface GitShimEnv {
  /** Agent role. When set to worker|lead|subagent, branch-mutating ops are blocked. */
  CLEO_AGENT_ROLE?: 'orchestrator' | 'worker' | 'lead' | 'subagent';
  /** When set to "1", bypass the branch-mutation denylist for one command. */
  CLEO_ALLOW_BRANCH_OPS?: '1';
  /** Worktree root path — informational for shim error messages. */
  CLEO_WORKTREE_ROOT?: string;
  /** Branch protection mode. */
  CLEO_BRANCH_PROTECTION?: 'strict' | 'permissive' | 'off';
}

/**
 * A blocked git subcommand entry in the denylist.
 *
 * @task T1118
 * @task T1121
 */
export interface DeniedGitOp {
  /** The git subcommand (e.g. "checkout"). */
  subcommand: string;
  /** Optional flag that triggers the denial (e.g. "--hard" for reset). */
  flag?: string;
  /** Human-readable reason shown in the shim's stderr output. */
  reason: string;
}

// ---------------------------------------------------------------------------
// L3 — Filesystem hardening types
// ---------------------------------------------------------------------------

/**
 * Platform capability report for filesystem hardening.
 *
 * @task T1118
 * @task T1122
 */
export interface FsHardenCapabilities {
  /** Whether chmod is available (always true on POSIX). */
  chmod: boolean;
  /** Whether chattr is available (Linux ext2/3/4/xfs only). */
  chattr: boolean;
  /** Whether chflags is available (macOS). */
  chflags: boolean;
  /** Detected platform. */
  platform: 'linux' | 'macos' | 'windows' | 'wsl' | 'unknown';
}

/**
 * State of the filesystem hard-lock for the orchestrator's HEAD.
 *
 * @task T1118
 * @task T1122
 */
export interface FsHardenState {
  /** Whether any lock is currently active. */
  active: boolean;
  /** Which mechanism was applied (chmod, chattr, or chflags). */
  mechanism: 'chmod' | 'chattr' | 'chflags' | 'none';
  /** Absolute path(s) that were locked. */
  lockedPaths: string[];
  /** ISO 8601 timestamp when the lock was applied. */
  appliedAt?: string;
}

// ---------------------------------------------------------------------------
// L4 — Owner override authentication types
// ---------------------------------------------------------------------------

/**
 * Record appended to force-bypass.jsonl when an override is used.
 *
 * Extends the base ForceBypassRecord with L4-specific authentication fields.
 *
 * @task T1118
 * @task T1123
 */
export interface OwnerOverrideAuditRecord {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Task ID being verified (may be "*" for session-level). */
  taskId: string;
  /** Gate being bypassed. */
  gate: string;
  /** Write action performed. */
  action: string;
  /** Agent ID that performed the bypass. */
  agent_id: string;
  /** Session ID. */
  session_id: string | null;
  /** Whether the HMAC token was validated (L4a). */
  token_validated: boolean;
  /** Whether TTY was present (L4c). */
  tty_present: boolean;
  /** Override count within the current session (L4d). */
  override_count: number;
  /** Webhook delivery status (L4d). */
  webhook_delivered?: boolean;
  /** Reason supplied by the operator. */
  reason: string;
  /** Process ID. */
  pid: number;
}

/**
 * Configuration for the owner override system.
 *
 * @task T1118
 * @task T1123
 */
export interface OwnerOverrideConfig {
  /** Maximum number of overrides allowed per session (default: 3). */
  maxPerSession: number;
  /** Optional webhook URL to POST on each bypass. */
  alertWebhook?: string;
}

// ---------------------------------------------------------------------------
// Error codes for branch-lock enforcement
// ---------------------------------------------------------------------------

/**
 * Error codes emitted by the branch-lock + override-auth system.
 *
 * @task T1118
 * @task T1501
 * @task T1502
 */
export const BRANCH_LOCK_ERROR_CODES = {
  /** L2: git shim blocked a branch-mutating operation. */
  E_GIT_OP_BLOCKED: 'E_GIT_OP_BLOCKED',
  /** L1: spawn attempted without a worktree handle. */
  E_WORKTREE_REQUIRED: 'E_WORKTREE_REQUIRED',
  /** L1: worktree path does not exist or is not a valid git worktree. */
  E_WORKTREE_INVALID: 'E_WORKTREE_INVALID',
  /** L1: cherry-pick failed during worktree.complete. */
  E_CHERRY_PICK_FAILED: 'E_CHERRY_PICK_FAILED',
  /** L3: filesystem harden failed. */
  E_FS_HARDEN_FAILED: 'E_FS_HARDEN_FAILED',
  /** L4a: HMAC token invalid or missing. */
  E_OVERRIDE_TOKEN_INVALID: 'E_OVERRIDE_TOKEN_INVALID',
  /** L4b: caller has CLEO_AGENT_ROLE=worker|lead|subagent — override forbidden. */
  E_OVERRIDE_FORBIDDEN_AGENT_ROLE: 'E_OVERRIDE_FORBIDDEN_AGENT_ROLE',
  /** L4c: override requires TTY but stdin/stderr is not a TTY. */
  E_OVERRIDE_NEEDS_TTY: 'E_OVERRIDE_NEEDS_TTY',
  /** L4d: session override limit exceeded. */
  E_OVERRIDE_RATE_LIMIT: 'E_OVERRIDE_RATE_LIMIT',
  /**
   * T1501 / P0-5: per-session cap (default 3) exceeded without a valid waiver doc.
   * Set CLEO_OWNER_OVERRIDE_WAIVER=<absolute path> to a file containing
   * `cap-waiver: true` in its frontmatter to bypass the cap.
   */
  E_OVERRIDE_CAP_EXCEEDED: 'E_OVERRIDE_CAP_EXCEEDED',
  /**
   * T1502 / P0-6: the same evidence atom was used across >3 distinct tasks and
   * `--shared-evidence` was not passed (or CLEO_STRICT_EVIDENCE=1 is set in CI).
   */
  E_SHARED_EVIDENCE_FLAG_REQUIRED: 'E_SHARED_EVIDENCE_FLAG_REQUIRED',
} as const;

/** Union of all branch-lock error code strings. */
export type BranchLockErrorCode =
  (typeof BRANCH_LOCK_ERROR_CODES)[keyof typeof BRANCH_LOCK_ERROR_CODES];
