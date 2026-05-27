// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! High-level agent worktree provisioning primitive.
//!
//! Wraps the low-level [`provision_worktree`], [`destroy_worktree`],
//! [`lock_worktree`], and [`unlock_worktree`] primitives from [`git_wt`]
//! with policy-aware lifecycle logic currently scattered across
//! TypeScript (`packages/worktree/src/worktree-create.ts` and
//! `packages/core/src/spawn/branch-lock.ts`).
//!
//! Implemented as part of T10653 (T3: Design Rust API) and T10654 (T4:
//! Implement) within epic T10650 (P0: Restore Worktrunk Rust SSoT).
//!
//! # Design Principles
//!
//! - **Path computation stays in TypeScript** (ADR-087-A5). Rust receives
//!   fully resolved `repo_root` and `target_path` strings; it never
//!   computes XDG canonical paths or project hashes.
//! - **Error classification is machine-readable**. Unlike the current
//!   TS path where callers parse `err.message` strings (e.g.,
//!   `E_DIRTY_BRANCH:` prefix matching), Rust returns an explicit
//!   [`AgentWorktreeProvisionError`] enum with numeric codes.
//! - **Stale worktree handling is policy-driven**. The caller selects one
//!   of three [`StalePolicy`] variants; the function branches accordingly.
//! - **Branch reuse honours orphan detection** per T1927. When
//!   `BranchPolicy::ReuseIfClean` and orphan commits are found,
//!   `force_reset` determines whether the branch is reset or an error is
//!   returned.
//!
//! # Edge Case Coverage (T10824)
//!
//! | TS Scenario | Rust Behaviour |
//! |---|---|
//! | Stale clean worktree at target_path | unlock → remove → delete branch → provision fresh |
//! | Dirty worktree at target_path (StalePolicy::PreserveIfDirty) | warn in result, skip provision |
//! | Dirty worktree at target_path (StalePolicy::ForceRemove) | force-remove → delete branch → provision fresh |
//! | Orphan branch exists, no worktree dir, force_reset=false | return `AgentWorktreeProvisionError::OrphanBranch` |
//! | Orphan branch exists, no worktree dir, force_reset=true | delete branch → provision fresh |
//! | Clean branch exists, no worktree dir (BranchPolicy::ReuseIfClean) | `git worktree add <path> <branch>` (reuse) |
//! | Clean branch exists, no worktree dir (BranchPolicy::Recreate) | delete branch → provision fresh |
//! | Lock with --reason succeeds | lock applied, `locked=true` in result |
//! | Lock with --reason fails, fallback succeeds | lock applied, `locked=true` in result |
//! | Lock entirely fails | lock skipped, `locked=false` in result (non-fatal) |
//!
//! @task T10653, T10822, T10823, T10824

// Path and PathBuf are reserved for the provision_agent_worktree function
// (T10654 — T4: Implementation). The design spec defines types only.
// Command is reserved for the same implementation phase.

/// Policy for handling an existing directory at `target_path`.
///
/// Maps to the three behaviours in `worktree-create.ts` lines 202-217.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StalePolicy {
    /// If the target path exists and is clean (no uncommitted changes),
    /// unlock + force-remove the stale worktree and delete the stale
    /// branch before provisioning fresh.
    ///
    /// If the target path is dirty, preserve it and return
    /// `dirty_preserved=true` in the result — the worktree is NOT
    /// provisioned. This is the safest default.
    RemoveIfClean,

    /// Preserve the existing directory regardless of dirtiness.
    /// Returns `dirty_preserved=true` and skips provisioning entirely.
    PreserveIfDirty,

    /// Force-remove the existing directory (and its branch) even if it
    /// has uncommitted changes. No warning is emitted; the worktree is
    /// unconditionally recreated from `base_ref`.
    ForceRemove,
}

/// Policy for handling an existing branch when `branch_exists` is true
/// but no worktree directory is present.
///
/// Corresponds to `worktree-create.ts` lines 220-271.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BranchPolicy {
    /// Reuse the branch if it is clean (no orphan commits unreachable
    /// from `base_ref`). If orphan commits are found and `force_reset`
    /// is true, delete the branch and recreate. If `force_reset` is
    /// false, return an error.
    ///
    /// This is the current TS default: branch reuse succeeds when the
    /// branch is an ancestor of (or equal to) `base_ref`.
    ReuseIfClean,

    /// Always delete the existing branch and create a fresh one from
    /// `base_ref`. No orphan detection is performed — the branch is
    /// unconditionally recreated.
    Recreate,

    /// If orphan commits are detected, return an error regardless of
    /// `force_reset`. This policy is for callers that want an explicit
    /// HITL decision before discarding orphan history.
    ErrorIfOrphan,
}

/// Machine-classified error codes for agent worktree provisioning.
///
/// Unlike the TS path where error codes are embedded as string prefixes
/// in `Error.message` (e.g. `E_DIRTY_BRANCH: ...`), these numeric
/// codes enable callers to match on error kind without string parsing.
///
/// Error codes are allocated in the WT01–WT99 range. The leading `WT`
/// prefix is for human readers; code consumers should match on the
/// numeric value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProvisionErrorCode {
    /// WT01 — stale worktree at `target_path` is dirty and
    /// `StalePolicy::PreserveIfDirty` (or `RemoveIfClean`)
    /// prevented cleanup.
    StaleDirDirty = 1,

    /// WT02 — orphan commits detected on existing branch and
    /// `force_reset` is false (or policy is `ErrorIfOrphan`).
    OrphanCommitsDetected = 2,

    /// WT03 — the `branch` name already exists and cannot be reused
    /// (BranchPolicy::Recreate rejected, or reuse check failed).
    BranchAlreadyExists = 3,

    /// WT04 — `git worktree add` failed.
    WorktreeAddFailed = 4,

    /// WT05 — `git worktree lock` failed (non-fatal: the worktree
    /// is still provisioned, just not locked).
    LockFailed = 5,

    /// WT06 — `git worktree unlock` or `git worktree remove` failed
    /// during stale cleanup.
    StaleCleanupFailed = 6,

    /// WT07 — `git branch -D` failed during stale branch deletion.
    BranchDeleteFailed = 7,

    /// WT08 — `git rev-parse HEAD` failed in the newly provisioned
    /// worktree (the worktree exists but is in an indeterminate state).
    HeadResolutionFailed = 8,
}

impl ProvisionErrorCode {
    /// Human-readable label for each code (matches `E_*` conventions
    /// from `BRANCH_LOCK_ERROR_CODES`).
    pub fn label(&self) -> &'static str {
        match self {
            Self::StaleDirDirty => "E_WT_STALE_DIRTY",
            Self::OrphanCommitsDetected => "E_WT_ORPHAN_COMMITS",
            Self::BranchAlreadyExists => "E_WT_BRANCH_EXISTS",
            Self::WorktreeAddFailed => "E_WT_ADD_FAILED",
            Self::LockFailed => "E_WT_LOCK_FAILED",
            Self::StaleCleanupFailed => "E_WT_CLEANUP_FAILED",
            Self::BranchDeleteFailed => "E_WT_BRANCH_DELETE_FAILED",
            Self::HeadResolutionFailed => "E_WT_HEAD_RESOLVE_FAILED",
        }
    }
}

/// Structured error returned by [`provision_agent_worktree`].
///
/// Carries a machine-readable [`ProvisionErrorCode`] plus contextual
/// fields so callers can construct a rich error message without parsing
/// the string. All errors that reach TypeScript are shaped into the
/// `{ code, message, details }` pattern expected by
/// `BRANCH_LOCK_ERROR_CODES`.
#[derive(Clone, Debug)]
pub struct AgentWorktreeProvisionError {
    /// Machine-classified error code.
    pub code: ProvisionErrorCode,
    /// Human-readable label (e.g. `"E_WT_ORPHAN_COMMITS"`).
    pub label: &'static str,
    /// A short description suitable for `Error.message`.
    pub message: String,
    /// Optional contextual details for downstream consumers.
    pub details: Option<String>,
}

impl AgentWorktreeProvisionError {
    pub fn new(code: ProvisionErrorCode, message: impl Into<String>) -> Self {
        let label = code.label();
        Self {
            code,
            label,
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: impl Into<String>) -> Self {
        self.details = Some(details.into());
        self
    }

    /// Format as a TypeScript-compatible error message following the
    /// `E_CODE: message` convention used by `BRANCH_LOCK_ERROR_CODES`.
    pub fn to_ts_message(&self) -> String {
        match &self.details {
            Some(d) => format!("{}: {} ({})", self.label, self.message, d),
            None => format!("{}: {}", self.label, self.message),
        }
    }
}

impl std::fmt::Display for AgentWorktreeProvisionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.to_ts_message())
    }
}

impl std::error::Error for AgentWorktreeProvisionError {}

/// Options for [`provision_agent_worktree`].
///
/// This is the Rust equivalent of the TypeScript `CreateWorktreeOptions`
/// interface from `@cleocode/contracts`. Path computation (project hash,
/// XDG root, task worktree path) remains in TypeScript per ADR-087-A5;
/// Rust receives fully resolved string paths.
///
/// # Design justification
///
/// The options are deliberately flat (no nesting of optional sub-structs)
/// so the NAPI binding is a single `#[napi(object)]` struct. Every field
/// has a reasonable default that matches the current TS behaviour.
#[derive(Clone, Debug)]
pub struct AgentWorktreeProvisionOpts {
    /// Absolute path to the git repository root (the directory containing
    /// `.git/`). Used as `current_dir` for all git subprocess invocations.
    pub repo_root: String,

    /// Absolute target path where the new worktree should be created.
    /// In CLEO's XDG layout this is
    /// `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/`.
    ///
    /// The caller MUST ensure this path is within the canonical XDG
    /// worktrees root (checked by `assertCanonicalWorktreeLocation` in
    /// TypeScript before calling into Rust).
    pub target_path: String,

    /// Branch name for the new worktree (default: `task/<task_id>`).
    ///
    /// Passed as `-b <branch>` to `git worktree add` when creating
    /// fresh; used as the branch to attach to when reusing.
    pub branch: String,

    /// Base ref (commit-ish) to root the new branch at (default:
    /// `HEAD`). Resolved by the caller; Rust uses it as-is.
    pub base_ref: String,

    /// Task ID that owns this worktree. Used for the lock reason
    /// (`cleo-agent-<task_id>`) and surfaced in the result for
    /// downstream env-var construction.
    pub task_id: String,

    /// How to handle an existing directory at `target_path`.
    ///
    /// Default: `RemoveIfClean` (matches current TS behaviour:
    /// stale clean worktrees are removed; dirty ones are preserved).
    pub stale_policy: StalePolicy,

    /// How to handle an existing branch when no worktree directory
    /// is present.
    ///
    /// Default: `ReuseIfClean` (matches current TS behaviour:
    /// reuse the branch if clean; error on orphans unless
    /// `force_reset` is true).
    pub branch_policy: BranchPolicy,

    /// When `true`, forcibly reset an existing branch that has orphan
    /// commits (commits unreachable from `base_ref`). When `false`,
    /// return [`AgentWorktreeProvisionError::OrphanCommitsDetected`].
    ///
    /// Default: `false`. Corresponds to TS `CreateWorktreeOptions.forceReset`.
    pub force_reset: bool,

    /// Optional reason string for the git worktree lock. When `Some`,
    /// passed as `--reason <value>` to `git worktree lock` (requires
    /// git ≥ 2.37). When `None`, locked with no reason.
    ///
    /// Default for CLEO spawns: `Some("cleo-agent-{task_id}")`.
    pub lock_reason: Option<String>,

    /// When `true` and the lock with `--reason` fails, retry the lock
    /// without `--reason` (compatibility with git < 2.37).
    ///
    /// Default: `true` (matches current TS fallback behaviour).
    pub lock_fallback: bool,

    /// When `true`, apply `git worktree lock` after provisioning.
    /// When `false`, skip locking entirely.
    ///
    /// Default: `true` (matches TS `lockWorktree` default).
    pub lock_after_create: bool,
}

impl AgentWorktreeProvisionOpts {
    /// Create options with CLEO-typical defaults for all optional fields.
    ///
    /// The caller provides the 6 required fields; all policy fields
    /// default to the current TS behaviour.
    pub fn new(
        repo_root: impl Into<String>,
        target_path: impl Into<String>,
        branch: impl Into<String>,
        base_ref: impl Into<String>,
        task_id: impl Into<String>,
    ) -> Self {
        let task_id = task_id.into();
        let lock_reason = format!("cleo-agent-{task_id}");
        Self {
            repo_root: repo_root.into(),
            target_path: target_path.into(),
            branch: branch.into(),
            base_ref: base_ref.into(),
            task_id,
            stale_policy: StalePolicy::RemoveIfClean,
            branch_policy: BranchPolicy::ReuseIfClean,
            force_reset: false,
            lock_reason: Some(lock_reason),
            lock_fallback: true,
            lock_after_create: true,
        }
    }
}

/// Structured result returned by [`provision_agent_worktree`].
///
/// This is the Rust equivalent of `CreateWorktreeResult` from
/// `@cleocode/contracts`. It carries all state needed by the
/// TypeScript facade layer to construct env vars, audit log entries,
/// sentinel index updates, and the agent preamble.
///
/// Fields intentionally excluded (handled by TS per ADR-087-A2):
/// - `envVars` / `preamble` (TS constructs these)
/// - `hookResults` (TS runs hooks)
/// - `appliedPatterns` / `appliedExcludePatterns` / `appliedScope`
///   (TS applies sparse-checkout and worktree-include)
/// - `bootstrap` (TS runs pnpm install / copy-on-write)
/// - `projectHash` (computed by TS via `@cleocode/paths`)
///
/// All fields carried here are about the git lifecycle operation:
/// was the worktree created or reused, was it locked, was stale
/// state cleaned up, were orphan commits detected.
#[derive(Clone, Debug)]
pub struct AgentWorktreeProvisionResult {
    /// Absolute path to the provisioned (or preserved) worktree.
    pub path: String,

    /// The branch name (may differ from input `branch` only when
    /// branch reuse changed the semantics — in practice always
    /// equals `opts.branch`).
    pub branch: String,

    /// HEAD commit SHA in the worktree after provisioning.
    pub head: String,

    /// The task ID that owns this worktree (echoed from opts).
    pub task_id: String,

    /// When `true`, this is a fresh worktree created from
    /// `base_ref` via `git worktree add -b`. When `false`,
    /// an existing branch was reused.
    pub created: bool,

    /// When `true`, `git worktree lock` was applied successfully.
    /// When `false`, locking either failed (non-fatal) or
    /// `lock_after_create` was `false`.
    pub locked: bool,

    /// When `true`, a stale worktree at `target_path` was
    /// unlocked + force-removed before provisioning.
    pub stale_cleaned: bool,

    /// When `true`, a dirty worktree at `target_path` was
    /// preserved (not cleaned) — the result reflects the
    /// pre-existing worktree, not a fresh provision.
    pub dirty_preserved: bool,

    /// When `true`, an existing branch (without a worktree
    /// directory) was reused via `git worktree add <path> <branch>`
    /// (no `-b` flag).
    pub branch_reused: bool,

    /// When `true`, orphan commits were detected on the existing
    /// branch (commits unreachable from `base_ref`). This flag
    /// is informational when `force_reset=true` (branch was reset);
    /// it's an error condition when `force_reset=false`.
    pub orphan_commits_found: bool,

    /// When `true`, a stale branch was deleted during cleanup
    /// (either from stale worktree removal or from `Recreate`
    /// branch policy).
    pub stale_branch_deleted: bool,

    /// ISO-8601 timestamp when provisioning completed.
    /// The caller sets this to control the timezone; Rust uses
    /// the provided string verbatim. When `None`, the caller
    /// should set `new Date().toISOString()` on the TS side.
    pub created_at: Option<String>,
}
