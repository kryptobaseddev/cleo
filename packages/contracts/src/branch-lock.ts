/**
 * Branch-lock and owner-override authentication contracts for T1118.
 *
 * Defines types, error codes, and interfaces for the four-layer agent
 * branch-protection system:
 *
 * - L1: Git worktree isolation per spawned agent (create + merge-complete + cleanup)
 * - L2: git-shim binary on PATH for harness-agnostic enforcement
 * - L3: Filesystem hardening via chmod (+ optional chattr on Linux)
 * - L4: Owner-override HMAC session authentication with TTY + rate-limit gates
 *
 * Worktree integration uses `git merge --no-ff` per ADR-062. The legacy
 * cherry-pick path was removed in T1624.
 *
 * @task T1118
 * @adr ADR-055
 * @adr ADR-062
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
 * Result from the orchestrate.worktree.complete operation (ADR-062 merge path).
 *
 * Integration uses `git merge --no-ff` to preserve the full agent commit graph.
 * `git log --grep "T<id>"` returns full provenance without SHA rewriting.
 *
 * @task T1587
 * @adr ADR-062
 */
export interface WorktreeMergeResult {
  /** Task ID that was integrated. */
  taskId: string;
  /** Branch the worktree was merged into (project-agnostic — `main`/`master`/etc). */
  targetBranch: string;
  /** Whether the merge succeeded. */
  merged: boolean;
  /** SHA of the merge commit on target (empty when merge skipped — no commits ahead). */
  mergeCommit: string;
  /** Number of agent commits preserved by the merge (ahead of target before merge). */
  commitCount: number;
  /** Whether the worktree branch was successfully rebased onto target before merge. */
  rebased: boolean;
  /** Whether the worktree filesystem entry was removed. */
  worktreeRemoved: boolean;
  /** Whether `task/<taskId>` was deleted post-merge. */
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
  /** L1: merge --no-ff failed during worktree.complete (ADR-062). */
  E_MERGE_FAILED: 'E_MERGE_FAILED',
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
  /**
   * T1851 / P0: an absolute path provided to an Edit/Write SDK tool operation
   * does not start with the agent's `worktreeRoot` prefix. This closes the
   * bypass vector discovered in T1763 where a worker used Edit/Write with
   * absolute paths into `/mnt/projects/cleocode/.cleo/rcasd/...`, circumventing
   * the git-shim which only intercepts `git` binary calls.
   */
  E_BOUNDARY_VIOLATION: 'E_BOUNDARY_VIOLATION',
} as const;

/** Union of all branch-lock error code strings. */
export type BranchLockErrorCode =
  (typeof BRANCH_LOCK_ERROR_CODES)[keyof typeof BRANCH_LOCK_ERROR_CODES];

// ---------------------------------------------------------------------------
// Centralized worktree isolation contract (T1759)
// ---------------------------------------------------------------------------

/**
 * The canonical set of environment variable keys injected into every isolated
 * agent shell by `provisionIsolatedShell`.
 *
 * Exported as a frozen const tuple so git-shim, harness adapters, and test
 * utilities can reference the authoritative key list without duplication.
 *
 * @task T1759
 */
export const ISOLATION_ENV_KEYS = [
  'CLEO_WORKTREE_ROOT',
  'CLEO_AGENT_ROLE',
  'CLEO_WORKTREE_BRANCH',
  'CLEO_PROJECT_HASH',
] as const satisfies readonly string[];

/** Union of all isolation env key strings. */
export type IsolationEnvKey = (typeof ISOLATION_ENV_KEYS)[number];

/**
 * Absolute-path validation rules enforced for Edit/Write SDK tool operations.
 *
 * Closes the bypass vector discovered in T1763: a worker used Edit/Write with
 * absolute paths pointing outside its worktree (into `/mnt/projects/...`),
 * which the git-shim could not catch because it only intercepts `git` binary
 * calls. This contract layer enforces path restrictions at the SDK tool level.
 *
 * @task T1851
 */
export interface AbsolutePathRules {
  /**
   * List of absolute path prefixes the agent is permitted to write to.
   *
   * The worktree root is always included as the first entry by
   * `provisionIsolatedShell`. Additional prefixes (e.g. `/tmp`) may be added
   * by the caller when the task genuinely requires writes outside the worktree
   * (test fixtures, CI artefacts, etc.).
   */
  allowedPrefixes: readonly string[];
  /**
   * When `true` (the default), any absolute path that does NOT start with one
   * of the `allowedPrefixes` entries is rejected with `E_BOUNDARY_VIOLATION`.
   *
   * Set to `false` only for orchestrator-role agents that legitimately need
   * write access to the full project tree (e.g. the merge-complete flow).
   * Audit logs should record any `false` instance.
   */
  deniedOutsideWorktree: boolean;
}

/**
 * Boundary contract returned by `provisionIsolatedShell`.
 *
 * Consumed by git-shim, SDK tool validators, and other enforcement layers to
 * verify that the agent is operating within its authorized boundary.
 *
 * @task T1759
 * @task T1851
 */
export interface BoundaryContract {
  /** Absolute path to the worktree root the agent is authorized within. */
  worktreeRoot: string;
  /** Role of the agent — drives git-shim denylist enforcement. */
  role: 'worker' | 'orchestrator';
  /** The canonical set of env keys that were injected (mirrors ISOLATION_ENV_KEYS). */
  envKeys: typeof ISOLATION_ENV_KEYS;
  /**
   * Absolute-path validation rules for Edit/Write SDK tool operations.
   *
   * Enforcement closes the T1763 bypass vector: workers MUST NOT use Edit/Write
   * with paths outside their `worktreeRoot`. The git-shim alone was insufficient
   * because it only intercepts `git` binary calls.
   *
   * @task T1851
   */
  absolutePathRules: AbsolutePathRules;
}

/**
 * Input options for `provisionIsolatedShell`.
 *
 * All fields are required — the utility never falls back to implicit CWD so
 * callers must be explicit about their isolation intent.
 *
 * @task T1759
 */
export interface IsolationOptions {
  /** Absolute path to the provisioned worktree directory. */
  worktreePath: string;
  /** Branch name for the worktree (e.g. `task/T1759`). */
  branch: string;
  /**
   * Agent role — drives git-shim denylist enforcement.
   *
   * Worker agents are denied branch-mutating git operations. Orchestrators
   * retain branch-mutation rights but are still confined to their worktree CWD.
   */
  role: 'worker' | 'orchestrator';
  /** Project hash scoping this worktree under the XDG root (sha256(projectRoot)[:16]). */
  projectHash: string;
}

/**
 * Result of `provisionIsolatedShell`.
 *
 * All fields are deterministic for the same inputs — callers may cache the
 * result and pass it through the spawn pipeline without re-computing.
 *
 * @task T1759
 */
export interface IsolationResult {
  /**
   * The working directory the agent MUST be started in.
   *
   * Always equals `options.worktreePath`. Exposed explicitly so callers
   * never re-derive it from other fields.
   */
  cwd: string;
  /**
   * Environment variables to merge into the agent's process environment.
   *
   * Keys are the canonical set from `ISOLATION_ENV_KEYS`. The object is a
   * fresh value each call — mutating it does not affect re-calls.
   */
  env: Record<(typeof ISOLATION_ENV_KEYS)[number], string>;
  /**
   * Shell preamble snippet to prepend to the agent's spawn prompt.
   *
   * The snippet:
   *  1. `cd`s to `worktreePath` (exits 1 on failure so the agent never runs
   *     in an unexpected directory).
   *  2. Verifies the resulting `$PWD` starts with `worktreePath` (guards
   *     against symlink traversal and shell quirks).
   *  3. Exports the isolation env vars so they are visible to child processes.
   *
   * The trailing newline is included so callers can concatenate directly.
   */
  preamble: string;
  /**
   * Boundary contract for downstream enforcement layers (git-shim, tests).
   *
   * The contract is a pure-data snapshot — it carries no runtime state.
   */
  boundaryContract: BoundaryContract;
}

/**
 * Provision an isolated shell context for an agent worktree.
 *
 * This is the single entry point for worktree isolation across all harness
 * adapters and spawn paths in CLEO. Callers MUST use the returned `cwd` and
 * `env` when starting an agent process, and MUST include the returned
 * `preamble` in the agent's spawn prompt.
 *
 * This function is pure — identical inputs always produce identical outputs,
 * with no I/O or side effects. It lives in `@cleocode/contracts` so that
 * harness adapters that cannot take a runtime dependency on `@cleocode/core`
 * (due to circular dep constraints) can still call the canonical implementation.
 * `packages/core/src/worktree/isolation.ts` re-exports this function as the
 * public API surface.
 *
 * @param options - Isolation input parameters.
 * @returns Fully-resolved isolation context.
 * @task T1759
 */
export function provisionIsolatedShell(options: IsolationOptions): IsolationResult {
  const { worktreePath, branch, role, projectHash } = options;

  // --- cwd -----------------------------------------------------------------
  const cwd = worktreePath;

  // --- env -----------------------------------------------------------------
  const env: Record<(typeof ISOLATION_ENV_KEYS)[number], string> = {
    CLEO_WORKTREE_ROOT: worktreePath,
    CLEO_AGENT_ROLE: role,
    CLEO_WORKTREE_BRANCH: branch,
    CLEO_PROJECT_HASH: projectHash,
  };

  // --- preamble ------------------------------------------------------------
  // Shell snippet injected into the agent's spawn prompt. The guard pattern
  // (cd || exit 1) + pwd-verify combo defends against:
  //   - The worktree directory having been pruned before the agent starts.
  //   - A future change where cwd is silently coerced to something else.
  //   - Symlink traversal producing a path that doesn't share the prefix.
  const exportBlock = ISOLATION_ENV_KEYS.map((k) => `export ${k}="${env[k]}"`).join('\n');

  const preamble = [
    '## Worktree Isolation (REQUIRED — do not skip)',
    '',
    '# Step 1: Enter the worktree (exits immediately if path is missing)',
    `cd "${worktreePath}" || exit 1`,
    '',
    '# Step 2: Verify working directory (guards against shell/symlink quirks)',
    'case "$PWD" in',
    `  "${worktreePath}"*) ;;`,
    '  *) echo "ISOLATION ERROR: pwd=$PWD expected prefix=' + worktreePath + '" >&2; exit 1 ;;',
    'esac',
    '',
    '# Step 3: Export isolation env vars',
    exportBlock,
    '',
  ].join('\n');

  // --- boundaryContract ----------------------------------------------------
  const absolutePathRules: AbsolutePathRules = {
    // Worktree root is always the first (and, for workers, only) allowed prefix.
    allowedPrefixes: [worktreePath],
    // Workers are always denied writes outside their worktree.
    // Orchestrator-role spawns may loosen this via explicit overrides, but the
    // default remains `true` to follow the principle of least privilege.
    deniedOutsideWorktree: true,
  };

  const boundaryContract: BoundaryContract = {
    worktreeRoot: worktreePath,
    role,
    envKeys: ISOLATION_ENV_KEYS,
    absolutePathRules,
  };

  return { cwd, env, preamble, boundaryContract };
}

// ---------------------------------------------------------------------------
// Absolute-path validation (T1851)
// ---------------------------------------------------------------------------

/**
 * Result of validating an absolute path against a BoundaryContract.
 *
 * @task T1851
 */
export type AbsolutePathValidationResult =
  | { allowed: true }
  | {
      allowed: false;
      /** Always `E_BOUNDARY_VIOLATION`. */
      code: typeof BRANCH_LOCK_ERROR_CODES.E_BOUNDARY_VIOLATION;
      /** Human-readable rejection message for log output and error surfaces. */
      message: string;
    };

/**
 * Validate that an absolute path is permitted by the given BoundaryContract.
 *
 * This is the primary enforcement point for the P0 isolation fix (T1851).
 * It closes the bypass vector discovered in T1763: a worker committed files to
 * `/mnt/projects/cleocode/.cleo/rcasd/...` by passing absolute paths directly
 * to Edit/Write SDK tool calls, bypassing the git-shim (which only intercepts
 * `git` binary invocations).
 *
 * Rules:
 * - If `contract.absolutePathRules.deniedOutsideWorktree` is `false`, the path
 *   is always allowed (opt-out is explicitly recorded in the contract).
 * - Otherwise, the path MUST start with at least one entry in
 *   `contract.absolutePathRules.allowedPrefixes`. The check uses exact prefix
 *   matching with a trailing-slash normalisation to prevent the path
 *   `/home/user/.local/.../T1234-extra` from matching prefix
 *   `/home/user/.local/.../T1234`.
 *
 * This function is pure — no I/O, no side effects, deterministic.
 *
 * @param absolutePath - The absolute path to validate.
 * @param contract - The boundary contract for the agent.
 * @returns `{ allowed: true }` or `{ allowed: false, code, message }`.
 * @task T1851
 */
export function validateAbsolutePath(
  absolutePath: string,
  contract: BoundaryContract,
): AbsolutePathValidationResult {
  const { absolutePathRules } = contract;

  // Fast-path: enforcement is disabled for this contract (orchestrator opt-out).
  if (!absolutePathRules.deniedOutsideWorktree) {
    return { allowed: true };
  }

  // Normalise the candidate path once so all prefix comparisons are consistent.
  // Ensure the prefix check uses a trailing slash so a path like
  //   /worktrees/T1234-extra
  // does NOT match the allowed prefix
  //   /worktrees/T1234
  const normPath = absolutePath.endsWith('/') ? absolutePath : `${absolutePath}/`;

  for (const prefix of absolutePathRules.allowedPrefixes) {
    const normPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
    if (normPath.startsWith(normPrefix) || absolutePath === prefix) {
      return { allowed: true };
    }
  }

  return {
    allowed: false,
    code: BRANCH_LOCK_ERROR_CODES.E_BOUNDARY_VIOLATION,
    message:
      `E_BOUNDARY_VIOLATION: absolute path "${absolutePath}" is outside the ` +
      `permitted boundary. worktreeRoot="${contract.worktreeRoot}", ` +
      `allowedPrefixes=[${absolutePathRules.allowedPrefixes.map((p) => `"${p}"`).join(', ')}]. ` +
      `Use a path within the worktree or update AbsolutePathRules.allowedPrefixes.`,
  };
}
