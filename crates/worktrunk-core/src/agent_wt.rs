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
//! | Dirty worktree at target_path (PreserveIfDirty) | warn in result, skip provision |
//! | Dirty worktree at target_path (ForceRemove) | force-remove → delete branch → provision fresh |
//! | Orphan branch, no worktree dir, force_reset=false | return OrphanBranch error |
//! | Orphan branch, no worktree dir, force_reset=true | delete branch → provision fresh |
//! | Clean branch, no worktree dir (ReuseIfClean) | git worktree add <path> <branch> (reuse) |
//! | Clean branch, no worktree dir (Recreate) | delete branch → provision fresh |
//! | Lock with --reason succeeds | lock applied, locked=true in result |
//! | Lock with --reason fails, fallback succeeds | lock applied, locked=true in result |
//! | Lock entirely fails | lock skipped, locked=false (non-fatal) |
//!
//! @task T10653, T10822, T10823, T10824

/// Policy for handling an existing directory at `target_path`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StalePolicy {
    /// Unlock + force-remove stale clean worktree and delete branch
    /// before provisioning fresh. Preserve dirty worktrees.
    RemoveIfClean,
    /// Preserve the existing directory regardless of dirtiness.
    PreserveIfDirty,
    /// Force-remove the existing directory (and its branch) even if
    /// it has uncommitted changes. Unconditional recreation.
    ForceRemove,
}

/// Policy for handling an existing branch when no worktree directory
/// is present.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BranchPolicy {
    /// Reuse branch if clean (no orphan commits unreachable from
    /// base_ref). If orphans found: force_reset=true deletes+recreates;
    /// force_reset=false returns an error.
    ReuseIfClean,
    /// Always delete existing branch and create fresh from base_ref.
    Recreate,
    /// If orphan commits detected, return error regardless of force_reset.
    ErrorIfOrphan,
}

/// Machine-classified error codes for agent worktree provisioning.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProvisionErrorCode {
    StaleDirDirty = 1,
    OrphanCommitsDetected = 2,
    BranchAlreadyExists = 3,
    WorktreeAddFailed = 4,
    LockFailed = 5,
    StaleCleanupFailed = 6,
    BranchDeleteFailed = 7,
    HeadResolutionFailed = 8,
}

impl ProvisionErrorCode {
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

/// Structured error returned by `provision_agent_worktree`.
#[derive(Clone, Debug)]
pub struct AgentWorktreeProvisionError {
    pub code: ProvisionErrorCode,
    pub label: &'static str,
    pub message: String,
    pub details: Option<String>,
}

impl AgentWorktreeProvisionError {
    pub fn new(code: ProvisionErrorCode, message: impl Into<String>) -> Self {
        let label = code.label();
        Self { code, label, message: message.into(), details: None }
    }

    pub fn with_details(mut self, details: impl Into<String>) -> Self {
        self.details = Some(details.into());
        self
    }

    /// Format as TS-compatible `E_CODE: message` string.
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

/// Options for `provision_agent_worktree`.
#[derive(Clone, Debug)]
pub struct AgentWorktreeProvisionOpts {
    pub repo_root: String,
    pub target_path: String,
    pub branch: String,
    pub base_ref: String,
    pub task_id: String,
    pub stale_policy: StalePolicy,
    pub branch_policy: BranchPolicy,
    pub force_reset: bool,
    pub lock_reason: Option<String>,
    pub lock_fallback: bool,
    pub lock_after_create: bool,
}

impl AgentWorktreeProvisionOpts {
    /// Create options with CLEO defaults.
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

/// Structured result returned by `provision_agent_worktree`.
#[derive(Clone, Debug)]
pub struct AgentWorktreeProvisionResult {
    pub path: String,
    pub branch: String,
    pub head: String,
    pub task_id: String,
    pub created: bool,
    pub locked: bool,
    pub stale_cleaned: bool,
    pub dirty_preserved: bool,
    pub branch_reused: bool,
    pub orphan_commits_found: bool,
    pub stale_branch_deleted: bool,
    pub created_at: Option<String>,
}
