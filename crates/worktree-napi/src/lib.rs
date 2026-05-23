// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktree-napi in the CleoCode monorepo.

#![allow(unsafe_code)] // napi-rs FFI macros generate unsafe blocks internally
//! napi-rs bindings for `worktrunk-core`.
//!
//! This crate exposes the pure-Rust `worktrunk-core` SDK to JavaScript via
//! N-API. It is the foundation for E5 (`TS-WORKTREE-REWIRE`, T9982) which
//! will replace `packages/worktree/`'s TypeScript worktree-provisioning
//! engine with calls into this binding.
//!
//! # Exported functions
//!
//! - [`provision_worktree`] — `git worktree add` with optional lock.
//! - [`destroy_worktree`] — `git worktree remove [--force]`.
//! - [`copy_paths_parallel`] — reflink-aware parallel copy of explicit leaves.
//! - [`read_worktree_include`] — parse `<repo_root>/.worktreeinclude`.
//! - [`apply_include`] — read + filter + copy in one call.
//! - [`list_worktrees`] — parsed `git worktree list --porcelain` output.
//!
//! T10203 step-primitive bindings (SAGA T10176 · ADR-078):
//!
//! - [`prune_worktrees`] — build a [`worktrunk_core::step::prune::PrunePlan`].
//! - [`promote_branch`] — build a [`worktrunk_core::step::promote::PromotePlan`].
//! - [`relocate_worktree`] — build a [`worktrunk_core::step::relocate::RelocatePlan`].
//! - [`copy_ignored`] — plan + execute the `[copy-ignored]` step in one call.
//! - [`remove_dir`] — recursive parallel directory removal with counts.
//! - [`sync_worktree`] — seed a freshly-provisioned worktree from a source
//!   tree, honouring `<source>/.worktreeinclude` when present.
//! - [`run_step`] — generic dispatcher that routes a discriminated
//!   [`StepKind`] envelope to the matching primitive above.
//!
//! All errors from `worktrunk-core` (which use `anyhow::Result`) are funneled
//! through [`napi_err`] which wraps `to_string()` of the underlying error
//! chain into a `napi::Error` so the JS side gets a readable `Error.message`.

use std::path::{Path, PathBuf};

use napi_derive::napi;

use std::collections::HashMap;

use worktrunk_core::copy::{copy_dir_recursive, copy_leaf};
use worktrunk_core::git::{ProcessRepo, Repo};
use worktrunk_core::git_wt::{
    WorktreeHandle, WorktreeInfo, destroy_worktree as core_destroy_worktree,
    list_worktrees as core_list_worktrees, lock_worktree,
    provision_worktree as core_provision_worktree,
};
use worktrunk_core::progress::Progress;
use worktrunk_core::remove_dir::remove_dir_with_progress as core_remove_dir_with_progress;
use worktrunk_core::step::copy_ignored::{
    CopyIgnoredOutcome, CopyIgnoredPlan, plan_copy_ignored as core_plan_copy_ignored,
    run_copy_ignored as core_run_copy_ignored,
};
use worktrunk_core::step::promote::{PromotePlan, plan_promote as core_plan_promote};
use worktrunk_core::step::prune::{
    PruneCandidate, PrunePlan, build_prune_plan as core_build_prune_plan,
};
use worktrunk_core::step::relocate::{
    RelocateCandidate, RelocateCycleBreak, RelocatePlan,
    build_relocation_plan as core_build_relocation_plan,
};
use worktrunk_core::worktreeinclude::{
    IncludePattern, apply_include_matcher, read_include_patterns,
};

/// Convert an [`anyhow::Error`] into a [`napi::Error`] preserving the chain.
fn napi_err(e: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(format!("{e}"))
}

// ── provision_worktree ──────────────────────────────────────────────

/// Options for [`provision_worktree`].
///
/// Mirrors the arguments of [`worktrunk_core::git_wt::provision_worktree`]
/// plus an optional `lock_reason` — when present, the worktree is locked
/// immediately after creation via `git worktree lock --reason <reason>`.
#[napi(object)]
pub struct ProvisionOpts {
    /// Absolute path to the git repository whose worktrees we manage.
    pub repo_root: String,
    /// Absolute target path where the new worktree should live.
    pub target_path: String,
    /// Branch name to create + check out (passed as `-b <branch>`).
    pub branch: String,
    /// Base ref (commit-ish) to root the new worktree at.
    pub base_ref: String,
    /// When set, the new worktree is locked with this reason string.
    pub lock_reason: Option<String>,
}

/// JS-facing handle returned from [`provision_worktree`].
///
/// Mirrors [`worktrunk_core::git_wt::WorktreeHandle`] with `path` rendered as
/// a UTF-8 string for JS consumption.
#[napi(object)]
pub struct WorktreeHandleNapi {
    /// Absolute path to the newly created worktree directory.
    pub path: String,
    /// The branch the worktree checked out.
    pub branch: String,
    /// The HEAD commit SHA at the moment of creation.
    pub head: String,
}

impl From<WorktreeHandle> for WorktreeHandleNapi {
    fn from(h: WorktreeHandle) -> Self {
        Self {
            path: h.path.to_string_lossy().to_string(),
            branch: h.branch,
            head: h.head,
        }
    }
}

/// Provision a new git worktree and (optionally) lock it.
///
/// Wraps [`worktrunk_core::git_wt::provision_worktree`]. When
/// `opts.lock_reason` is `Some`, the worktree is locked with that reason
/// immediately after creation; lock failures bubble up as a napi error.
///
/// # Errors
///
/// Returns a [`napi::Error`] when the underlying `git worktree add` /
/// `git worktree lock` fails. The JS side sees the trimmed `git` stderr in
/// `Error.message`.
#[napi]
pub fn provision_worktree(opts: ProvisionOpts) -> napi::Result<WorktreeHandleNapi> {
    let repo_root = PathBuf::from(&opts.repo_root);
    let target_path = PathBuf::from(&opts.target_path);

    let handle = core_provision_worktree(&repo_root, &target_path, &opts.branch, &opts.base_ref)
        .map_err(napi_err)?;

    if let Some(reason) = opts.lock_reason.as_deref() {
        lock_worktree(&repo_root, &target_path, Some(reason)).map_err(napi_err)?;
    }

    Ok(handle.into())
}

// ── destroy_worktree ────────────────────────────────────────────────

/// Options for [`destroy_worktree`].
#[napi(object)]
pub struct DestroyOpts {
    /// Absolute path to the git repository whose worktrees we manage.
    pub repo_root: String,
    /// Absolute path to the worktree directory to remove.
    pub worktree_path: String,
    /// When `true`, pass `--force` to remove locked or dirty worktrees.
    pub force: bool,
}

/// Result of [`destroy_worktree`].
#[napi(object)]
pub struct DestroyResult {
    /// `true` once `git worktree remove` exited zero.
    pub removed: bool,
    /// Always `false` — branch deletion is the caller's responsibility.
    ///
    /// Reserved for future expansion if we ever wire `-b/--branch` deletion
    /// into the SDK; today `worktrunk-core` only removes the working copy.
    pub branch_deleted: bool,
}

/// Remove an existing worktree via `git worktree remove [--force]`.
///
/// Wraps [`worktrunk_core::git_wt::destroy_worktree`].
///
/// # Errors
///
/// Returns a [`napi::Error`] when the underlying `git worktree remove` fails.
#[napi]
pub fn destroy_worktree(opts: DestroyOpts) -> napi::Result<DestroyResult> {
    let repo_root = PathBuf::from(&opts.repo_root);
    let worktree_path = PathBuf::from(&opts.worktree_path);

    core_destroy_worktree(&repo_root, &worktree_path, opts.force).map_err(napi_err)?;

    Ok(DestroyResult {
        removed: true,
        branch_deleted: false,
    })
}

// ── copy_paths_parallel ─────────────────────────────────────────────

/// Options for [`copy_paths_parallel`] and [`apply_include`].
#[napi(object)]
pub struct CopyOpts {
    /// Overwrite existing entries at the destination.
    pub force: bool,
    /// When set, every destination must resolve inside this root (path
    /// canonicalization is tolerant of non-existent parents — see
    /// `worktrunk_core::path::canonicalize_with_parents`).
    pub root_guard: Option<String>,
    /// Reserved for future use — symlinks are always followed by
    /// [`worktrunk_core::copy::copy_leaf`] today.
    pub include_symlinks: bool,
}

/// Aggregated result of a parallel copy operation.
#[napi(object)]
pub struct CopyResult {
    /// Number of leaves successfully copied.
    pub copied_count: u32,
    /// Number of leaves skipped because they already existed at the destination.
    pub skipped_count: u32,
    /// Paths that failed to copy (relative to the source) — typically empty.
    pub failed_paths: Vec<String>,
    /// Total bytes copied. Capped at `u32::MAX` to fit napi's `u32` JS-number
    /// surface; callers that need >4 GiB should split the copy. This matches
    /// the worktree-provisioning use case where 4 GiB+ is exceptional.
    pub total_bytes: u32,
}

/// Copy a list of explicit leaf paths from `src_dir` to `dest_dir` in
/// parallel using `worktrunk-core`'s 4-thread reflink-aware pool.
///
/// `paths` must be repo-root relative — each `src_dir/path` is copied to
/// `dest_dir/path`. Destination parent directories are created on demand.
///
/// # Errors
///
/// Returns a [`napi::Error`] if `worktrunk_core::copy::copy_leaf` errors on
/// any leaf. The error chain is preserved via [`napi_err`].
#[napi]
pub fn copy_paths_parallel(
    src_dir: String,
    dest_dir: String,
    paths: Vec<String>,
    opts: CopyOpts,
) -> napi::Result<CopyResult> {
    let src_root = PathBuf::from(&src_dir);
    let dest_root = PathBuf::from(&dest_dir);
    let root_guard: Option<PathBuf> = opts.root_guard.as_ref().map(PathBuf::from);

    let mut copied: u32 = 0;
    let mut skipped: u32 = 0;
    let mut bytes: u64 = 0;
    let mut failed: Vec<String> = Vec::new();

    for rel in &paths {
        let src = src_root.join(rel);
        let dest = dest_root.join(rel);

        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(napi_err)?;
        }

        let root_ref: Option<&Path> = root_guard.as_deref();
        match copy_leaf(&src, &dest, root_ref, opts.force) {
            Ok(Some(n)) => {
                copied = copied.saturating_add(1);
                bytes = bytes.saturating_add(n);
            }
            Ok(None) => {
                skipped = skipped.saturating_add(1);
            }
            Err(_) => {
                failed.push(rel.clone());
            }
        }
    }

    Ok(CopyResult {
        copied_count: copied,
        skipped_count: skipped,
        failed_paths: failed,
        total_bytes: u32::try_from(bytes.min(u64::from(u32::MAX))).unwrap_or(u32::MAX),
    })
}

// ── read_worktree_include ───────────────────────────────────────────

/// JS-facing pattern from a `.worktreeinclude` file.
#[napi(object)]
pub struct IncludePatternNapi {
    /// The raw pattern text (gitignore-style), `!`-prefix stripped.
    pub pattern: String,
    /// Whether this entry began with `!` (re-includes after a prior exclusion).
    pub is_negation: bool,
}

impl From<IncludePattern> for IncludePatternNapi {
    fn from(p: IncludePattern) -> Self {
        Self {
            pattern: p.pattern,
            is_negation: p.is_negation,
        }
    }
}

impl From<IncludePatternNapi> for IncludePattern {
    fn from(p: IncludePatternNapi) -> Self {
        Self {
            pattern: p.pattern,
            is_negation: p.is_negation,
        }
    }
}

/// Read and parse `<repo_root>/.worktreeinclude`.
///
/// Returns an empty `Vec` when the file does not exist (callers can use
/// this as the "no filter, copy everything" signal).
///
/// # Errors
///
/// Returns a [`napi::Error`] when the file exists but cannot be read.
#[napi]
pub fn read_worktree_include(repo_root: String) -> napi::Result<Vec<IncludePatternNapi>> {
    let root = PathBuf::from(&repo_root);
    let patterns = read_include_patterns(&root).map_err(napi_err)?;
    Ok(patterns.into_iter().map(Into::into).collect())
}

// ── apply_include ───────────────────────────────────────────────────

/// Combine [`read_worktree_include`] + filtering + copying in one call.
///
/// Walks `src_dir` discovering candidate leaves, filters them through the
/// supplied gitignore-syntax patterns, and copies the matches into
/// `dest_dir` using [`copy_paths_parallel`] semantics. When `patterns` is
/// empty the full subtree is copied (mirroring `worktrunk-core`'s
/// "no filter when the file is absent" rule).
///
/// # Errors
///
/// Returns a [`napi::Error`] when matcher construction, walking, or copying
/// fails for any reason.
#[napi]
pub fn apply_include(
    patterns: Vec<IncludePatternNapi>,
    src_dir: String,
    dest_dir: String,
    opts: CopyOpts,
) -> napi::Result<CopyResult> {
    let src_root = PathBuf::from(&src_dir);
    let dest_root = PathBuf::from(&dest_dir);

    // Empty pattern list = bulk copy via worktrunk-core's recursive engine.
    if patterns.is_empty() {
        let root_guard: Option<PathBuf> = opts.root_guard.as_ref().map(PathBuf::from);
        let root_ref: Option<&Path> = root_guard.as_deref();
        let progress = Progress::disabled();
        let (files, bytes) =
            copy_dir_recursive(&src_root, &dest_root, root_ref, opts.force, &progress)
                .map_err(napi_err)?;
        return Ok(CopyResult {
            copied_count: u32::try_from(files).unwrap_or(u32::MAX),
            skipped_count: 0,
            failed_paths: Vec::new(),
            total_bytes: u32::try_from(bytes.min(u64::from(u32::MAX))).unwrap_or(u32::MAX),
        });
    }

    // Collect candidate files (walk only files, not directories — the matcher
    // is then anchored at `src_root`).
    let mut candidates: Vec<PathBuf> = Vec::new();
    for entry in walk_files(&src_root) {
        candidates.push(entry);
    }

    let core_patterns: Vec<IncludePattern> = patterns.into_iter().map(Into::into).collect();
    let kept = apply_include_matcher(&src_root, &core_patterns, &candidates).map_err(napi_err)?;

    // Convert each kept absolute path to a relative path and delegate to the
    // explicit-leaf copier.
    let rels: Vec<String> = kept
        .iter()
        .filter_map(|p| p.strip_prefix(&src_root).ok())
        .map(|rel| rel.to_string_lossy().to_string())
        .collect();

    copy_paths_parallel(src_dir, dest_dir, rels, opts)
}

/// Iteratively walk `root` collecting every regular file and symlink.
///
/// Used by [`apply_include`] to feed candidate paths into the gitignore-style
/// matcher. Errors during traversal are skipped (matching the donor's
/// best-effort behavior in `list_and_filter_*`).
fn walk_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() || ft.is_symlink() {
                out.push(path);
            }
        }
    }
    out
}

// ── list_worktrees ──────────────────────────────────────────────────

/// Options for [`list_worktrees`].
#[napi(object)]
pub struct ListOpts {
    /// Absolute path to the git repository whose worktrees we list.
    pub repo_root: String,
}

/// JS-facing worktree record (one entry from `git worktree list --porcelain`).
#[napi(object)]
pub struct WorktreeInfoNapi {
    /// Absolute path to the worktree directory.
    pub path: String,
    /// Branch name (`None` for detached HEAD).
    pub branch: Option<String>,
    /// HEAD commit SHA.
    pub head: String,
    /// Whether the worktree is locked.
    pub is_locked: bool,
    /// Whether the worktree is reported as prunable by git.
    pub is_prunable: bool,
}

impl From<WorktreeInfo> for WorktreeInfoNapi {
    fn from(w: WorktreeInfo) -> Self {
        Self {
            path: w.path.to_string_lossy().to_string(),
            branch: w.branch,
            head: w.head,
            is_locked: w.is_locked,
            is_prunable: w.is_prunable,
        }
    }
}

/// List all worktrees in `opts.repo_root`.
///
/// Wraps [`worktrunk_core::git_wt::list_worktrees`].
///
/// # Errors
///
/// Returns a [`napi::Error`] when the underlying `git worktree list` fails.
#[napi]
pub fn list_worktrees(opts: ListOpts) -> napi::Result<Vec<WorktreeInfoNapi>> {
    let repo_root = PathBuf::from(&opts.repo_root);
    let infos = core_list_worktrees(&repo_root).map_err(napi_err)?;
    Ok(infos.into_iter().map(Into::into).collect())
}

// ── prune_worktrees ─────────────────────────────────────────────────

/// Options for [`prune_worktrees`].
#[napi(object)]
pub struct PruneOpts {
    /// Absolute path to the git repository whose worktrees we plan to prune.
    pub repo_root: String,
    /// The integration target branch (e.g. `"main"` or `"master"`) the
    /// candidates are tested against for "is this merged in?".
    pub integration_target: String,
}

/// JS-facing prune candidate (worktree or branch eligible for removal).
#[napi(object)]
pub struct PruneCandidateNapi {
    /// Branch name (`None` for detached HEAD worktrees).
    pub branch: Option<String>,
    /// Display label (branch name or `(detached <short>)`).
    pub label: String,
    /// Worktree path (`None` for branch-only candidates).
    pub path: Option<String>,
    /// Candidate kind: `"current" | "worktree" | "branch_only"`.
    pub kind: String,
    /// Human-readable integration reason from `Repo::integration_reason`.
    pub reason: String,
}

impl From<PruneCandidate> for PruneCandidateNapi {
    fn from(c: PruneCandidate) -> Self {
        Self {
            branch: c.branch,
            label: c.label,
            path: c.path.map(|p| p.to_string_lossy().to_string()),
            kind: c.kind.as_str().to_string(),
            reason: c.reason,
        }
    }
}

/// JS-facing prune plan.
#[napi(object)]
pub struct PrunePlanNapi {
    /// The default branch this plan was computed against.
    pub integration_target: String,
    /// Candidates eligible for removal, in deterministic discovery order.
    pub candidates: Vec<PruneCandidateNapi>,
}

impl From<PrunePlan> for PrunePlanNapi {
    fn from(p: PrunePlan) -> Self {
        Self {
            integration_target: p.integration_target,
            candidates: p.candidates.into_iter().map(Into::into).collect(),
        }
    }
}

/// Build a prune plan for `opts.repo_root` against `opts.integration_target`.
///
/// Wraps [`worktrunk_core::step::prune::build_prune_plan`] with a
/// [`worktrunk_core::git::ProcessRepo`] constructed from `opts.repo_root`.
/// Read-only — no worktrees are removed.
///
/// # Errors
///
/// Returns a [`napi::Error`] when the repo cannot be opened, refs cannot be
/// captured, or worktrees cannot be listed.
#[napi]
pub fn prune_worktrees(opts: PruneOpts) -> napi::Result<PrunePlanNapi> {
    let repo = ProcessRepo::at(&opts.repo_root).map_err(napi_err)?;
    let snapshot = repo.capture_refs().map_err(napi_err)?;
    let worktrees = repo.list_worktrees().map_err(napi_err)?;
    let plan = core_build_prune_plan(&repo, &worktrees, &snapshot, &opts.integration_target)
        .map_err(napi_err)?;
    Ok(plan.into())
}

// ── promote_branch ──────────────────────────────────────────────────

/// Options for [`promote_branch`].
#[napi(object)]
pub struct PromoteOpts {
    /// Absolute path to the git repository whose worktrees we plan to swap.
    pub repo_root: String,
    /// The branch to promote into the main worktree slot.
    pub target_branch: String,
}

/// JS-facing promote plan.
#[napi(object)]
pub struct PromotePlanNapi {
    /// Main worktree root.
    pub main_path: String,
    /// Main worktree's current branch.
    pub main_branch: String,
    /// Target worktree root (the one to promote into main).
    pub target_path: String,
    /// Branch currently in `target_path`.
    pub target_branch: String,
    /// `true` when no swap is needed because target is already in main.
    pub already_in_main: bool,
}

impl From<PromotePlan> for PromotePlanNapi {
    fn from(p: PromotePlan) -> Self {
        Self {
            main_path: p.main_path.to_string_lossy().to_string(),
            main_branch: p.main_branch,
            target_path: p.target_path.to_string_lossy().to_string(),
            target_branch: p.target_branch,
            already_in_main: p.already_in_main,
        }
    }
}

/// Build a promote plan for swapping `opts.target_branch` into the main
/// worktree slot.
///
/// Wraps [`worktrunk_core::step::promote::plan_promote`]. Read-only — no git
/// state is mutated. Executing the swap (the four-step `git switch --detach`
/// dance) is the caller's responsibility because it needs interactive policy
/// (HITL approval, hook firing) that does NOT belong in the SDK.
///
/// # Errors
///
/// Returns a [`napi::Error`] when the repo cannot be opened, when the
/// worktree list is empty, when the main worktree has detached HEAD, when
/// the repo is bare, or when no worktree currently checks out
/// `opts.target_branch`.
#[napi]
pub fn promote_branch(opts: PromoteOpts) -> napi::Result<PromotePlanNapi> {
    let repo = ProcessRepo::at(&opts.repo_root).map_err(napi_err)?;
    let plan = core_plan_promote(&repo, &opts.target_branch).map_err(napi_err)?;
    Ok(plan.into())
}

// ── relocate_worktree ───────────────────────────────────────────────

/// Options for [`relocate_worktree`].
///
/// `expected_paths_branches` and `expected_paths_targets` are parallel arrays
/// (napi-rs does not expose `HashMap` directly to JS, so the caller passes
/// two equal-length arrays which the binding zips into a `HashMap` before
/// calling the SDK).
#[napi(object)]
pub struct RelocateOpts {
    /// Absolute path to the git repository.
    pub repo_root: String,
    /// Branch names to consider for relocation.
    pub expected_paths_branches: Vec<String>,
    /// Expected absolute paths for the branches above (same length).
    pub expected_paths_targets: Vec<String>,
}

/// JS-facing relocate candidate.
#[napi(object)]
pub struct RelocateCandidateNapi {
    /// Branch name.
    pub branch: String,
    /// Where the worktree currently lives.
    pub current_path: String,
    /// Where the worktree SHOULD live per the layout template.
    pub expected_path: String,
    /// HEAD commit at the time of plan construction.
    pub head: String,
}

impl From<RelocateCandidate> for RelocateCandidateNapi {
    fn from(c: RelocateCandidate) -> Self {
        Self {
            branch: c.branch,
            current_path: c.current_path.to_string_lossy().to_string(),
            expected_path: c.expected_path.to_string_lossy().to_string(),
            head: c.head,
        }
    }
}

/// JS-facing cycle-break instruction for a worktree relocation.
#[napi(object)]
pub struct RelocateCycleBreakNapi {
    /// Index into `RelocatePlanNapi.candidates`.
    pub candidate_index: u32,
    /// Temporary path the worktree should be moved to first.
    pub temp_path: String,
}

impl From<RelocateCycleBreak> for RelocateCycleBreakNapi {
    fn from(b: RelocateCycleBreak) -> Self {
        Self {
            candidate_index: u32::try_from(b.candidate_index).unwrap_or(u32::MAX),
            temp_path: b.temp_path.to_string_lossy().to_string(),
        }
    }
}

/// JS-facing relocate plan.
#[napi(object)]
pub struct RelocatePlanNapi {
    /// All candidates flagged for relocation.
    pub candidates: Vec<RelocateCandidateNapi>,
    /// Subset of candidates that participate in cycles and need a temp move.
    pub cycle_breaks: Vec<RelocateCycleBreakNapi>,
    /// Subset of candidate indices whose expected target is occupied by a
    /// non-worktree path.
    pub blocked_indices: Vec<u32>,
}

impl From<RelocatePlan> for RelocatePlanNapi {
    fn from(p: RelocatePlan) -> Self {
        Self {
            candidates: p.candidates.into_iter().map(Into::into).collect(),
            cycle_breaks: p.cycle_breaks.into_iter().map(Into::into).collect(),
            blocked_indices: p
                .blocked_indices
                .into_iter()
                .map(|i| u32::try_from(i).unwrap_or(u32::MAX))
                .collect(),
        }
    }
}

/// Build a worktree-relocation plan for `opts.repo_root`.
///
/// Wraps [`worktrunk_core::step::relocate::build_relocation_plan`]. Read-only
/// — no worktrees are moved. The SDK detects:
///
/// - Worktrees whose current path doesn't match the expected path.
/// - Cycles (A wants where B is, B wants where A is — needs a temp move).
/// - Blocked targets (expected path is occupied by a non-worktree filesystem
///   entry).
///
/// # Errors
///
/// Returns a [`napi::Error`] when the repo cannot be opened, when
/// `expected_paths_branches` and `expected_paths_targets` have different
/// lengths, or when worktrees cannot be listed.
#[napi]
pub fn relocate_worktree(opts: RelocateOpts) -> napi::Result<RelocatePlanNapi> {
    if opts.expected_paths_branches.len() != opts.expected_paths_targets.len() {
        return Err(napi::Error::from_reason(
            "expected_paths_branches and expected_paths_targets must have equal length",
        ));
    }
    let mut expected: HashMap<String, PathBuf> = HashMap::new();
    for (b, t) in opts
        .expected_paths_branches
        .into_iter()
        .zip(opts.expected_paths_targets.into_iter())
    {
        expected.insert(b, PathBuf::from(t));
    }
    let repo = ProcessRepo::at(&opts.repo_root).map_err(napi_err)?;
    let worktrees = repo.list_worktrees().map_err(napi_err)?;
    let plan =
        core_build_relocation_plan(&worktrees, &expected, |p| p.exists()).map_err(napi_err)?;
    Ok(plan.into())
}

// ── copy_ignored ────────────────────────────────────────────────────

/// Options for [`copy_ignored`].
#[napi(object)]
pub struct CopyIgnoredOpts {
    /// Source worktree path (absolute).
    pub source: String,
    /// Destination worktree path (absolute).
    pub destination: String,
    /// Tag string used in SDK errors to identify the caller's intent
    /// (e.g. `"step::copy_ignored"`). Passed through opaque to `list_and_filter_ignored_entries`.
    pub source_context: String,
    /// Absolute paths of OTHER worktrees in the repo — entries that resolve
    /// to one of these paths are skipped (nested-worktree avoidance).
    pub worktree_paths: Vec<String>,
    /// `[copy-ignored.exclude]` glob patterns to skip (relative to `source`).
    pub exclude_patterns: Vec<String>,
    /// When `true`, leaf files overwrite existing destination files.
    pub force: bool,
}

/// JS-facing copy-ignored plan entry: `[relative_path, is_dir]`.
#[napi(object)]
pub struct CopyIgnoredEntryNapi {
    /// Source-relative path of the entry.
    pub path: String,
    /// Whether the entry is a directory (and therefore copied recursively).
    pub is_dir: bool,
}

/// JS-facing copy-ignored plan.
#[napi(object)]
pub struct CopyIgnoredPlanNapi {
    /// Source worktree path.
    pub source: String,
    /// Destination worktree path.
    pub destination: String,
    /// Entries the plan would copy.
    pub entries: Vec<CopyIgnoredEntryNapi>,
    /// When `true`, source and destination resolved to the same path; the
    /// plan is a no-op.
    pub same_worktree: bool,
}

impl From<CopyIgnoredPlan> for CopyIgnoredPlanNapi {
    fn from(p: CopyIgnoredPlan) -> Self {
        let src = p.source.clone();
        let entries: Vec<CopyIgnoredEntryNapi> = p
            .entries
            .iter()
            .map(|(path, is_dir)| {
                let rel = path
                    .strip_prefix(&src)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .to_string();
                CopyIgnoredEntryNapi {
                    path: rel,
                    is_dir: *is_dir,
                }
            })
            .collect();
        Self {
            source: p.source.to_string_lossy().to_string(),
            destination: p.destination.to_string_lossy().to_string(),
            entries,
            same_worktree: p.same_worktree,
        }
    }
}

/// JS-facing copy-ignored outcome (counts only).
#[napi(object)]
pub struct CopyIgnoredOutcomeNapi {
    /// Number of leaf files successfully copied.
    pub files: u32,
    /// Total bytes copied. Capped at `u32::MAX` for napi compatibility.
    pub bytes: u32,
    /// The plan the executor consumed (echoed back for inspection).
    pub plan: CopyIgnoredPlanNapi,
}

impl From<CopyIgnoredOutcome> for CopyIgnoredOutcomeNapi {
    fn from(o: CopyIgnoredOutcome) -> Self {
        Self {
            files: u32::try_from(o.files).unwrap_or(u32::MAX),
            bytes: u32::try_from(o.bytes.min(u64::from(u32::MAX))).unwrap_or(u32::MAX),
            // Caller fills this from the planning step; default empty here.
            plan: CopyIgnoredPlanNapi {
                source: String::new(),
                destination: String::new(),
                entries: Vec::new(),
                same_worktree: false,
            },
        }
    }
}

/// Plan + execute the [copy-ignored] step in one call.
///
/// Wraps [`worktrunk_core::step::copy_ignored::plan_copy_ignored`] followed
/// by [`worktrunk_core::step::copy_ignored::run_copy_ignored`]. The returned
/// outcome embeds the plan so callers can inspect what was copied.
///
/// # Errors
///
/// Returns a [`napi::Error`] from listing/filtering ignored entries or from
/// the recursive copy engine.
#[napi]
pub fn copy_ignored(opts: CopyIgnoredOpts) -> napi::Result<CopyIgnoredOutcomeNapi> {
    let source = PathBuf::from(&opts.source);
    let destination = PathBuf::from(&opts.destination);
    let worktree_paths: Vec<PathBuf> = opts.worktree_paths.iter().map(PathBuf::from).collect();
    let plan = core_plan_copy_ignored(
        &source,
        &destination,
        &opts.source_context,
        &worktree_paths,
        &opts.exclude_patterns,
    )
    .map_err(napi_err)?;
    let plan_view: CopyIgnoredPlanNapi = plan.clone().into();
    let outcome =
        core_run_copy_ignored(&plan, opts.force, &Progress::disabled()).map_err(napi_err)?;
    let mut wire: CopyIgnoredOutcomeNapi = outcome.into();
    wire.plan = plan_view;
    Ok(wire)
}

// ── remove_dir ──────────────────────────────────────────────────────

/// Options for [`remove_dir`].
#[napi(object)]
pub struct RemoveDirOpts {
    /// Absolute path to the directory tree to remove.
    pub path: String,
}

/// JS-facing result of a `remove_dir` call.
#[napi(object)]
pub struct RemoveDirResult {
    /// Number of leaf files unlinked.
    pub files: u32,
    /// Total bytes unlinked. Capped at `u32::MAX` for napi compatibility.
    pub bytes: u32,
}

/// Recursively remove a directory tree using
/// [`worktrunk_core::remove_dir::remove_dir_with_progress`].
///
/// Best-effort — read/unlink/rmdir errors are silently skipped (the SDK runs
/// this as the "trash-cleanup phase" after a worktree has already been
/// pruned from git). The result reports what was actually removed.
///
/// # Errors
///
/// Currently never returns an error from the SDK — the napi return type is
/// `Result` for forward compatibility.
#[napi]
pub fn remove_dir(opts: RemoveDirOpts) -> napi::Result<RemoveDirResult> {
    let path = PathBuf::from(&opts.path);
    let (files, bytes) = core_remove_dir_with_progress(&path, &Progress::disabled());
    Ok(RemoveDirResult {
        files: u32::try_from(files).unwrap_or(u32::MAX),
        bytes: u32::try_from(bytes.min(u64::from(u32::MAX))).unwrap_or(u32::MAX),
    })
}

// ── sync_worktree ───────────────────────────────────────────────────

/// Options for [`sync_worktree`].
///
/// "Sync" composes two SDK primitives:
///
/// 1. Read `<source>/.worktreeinclude` via
///    [`worktrunk_core::worktreeinclude::read_include_patterns`].
/// 2. Walk + filter + copy matching files via
///    [`worktrunk_core::worktreeinclude::apply_include_matcher`] and
///    [`worktrunk_core::copy::copy_leaf`].
///
/// This is the thin composition `cleo orchestrate spawn` performs after a
/// new worktree is provisioned to seed it from the project root.
#[napi(object)]
pub struct SyncWorktreeOpts {
    /// Source root (typically the main worktree / project root).
    pub source: String,
    /// Destination worktree to seed.
    pub destination: String,
    /// Overwrite existing entries at the destination.
    pub force: bool,
    /// When set, every destination must resolve inside this root.
    pub root_guard: Option<String>,
}

/// JS-facing sync result.
#[napi(object)]
pub struct SyncWorktreeResult {
    /// Number of leaves successfully copied.
    pub copied_count: u32,
    /// Number of leaves skipped because they already existed at the destination.
    pub skipped_count: u32,
    /// Paths that failed to copy (relative to the source) — typically empty.
    pub failed_paths: Vec<String>,
    /// Total bytes copied. Capped at `u32::MAX` for napi compatibility.
    pub total_bytes: u32,
    /// Number of `.worktreeinclude` patterns that drove the filter
    /// (`0` means "no filter applied, full subtree copy").
    pub patterns_applied: u32,
}

/// Sync `opts.destination` from `opts.source` using the source's
/// `.worktreeinclude` file (if any).
///
/// Reads `<source>/.worktreeinclude` patterns, filters the source tree
/// against them, and copies the survivors into `destination`. When the
/// include file is absent or empty, the full subtree is copied via
/// [`worktrunk_core::copy::copy_dir_recursive`].
///
/// This binding is the canonical "sync from main into a freshly provisioned
/// worktree" call — it composes the SDK primitives without adding any
/// business logic.
///
/// # Errors
///
/// Returns a [`napi::Error`] from include parsing, walk traversal, matcher
/// construction, or the copy engine.
#[napi]
pub fn sync_worktree(opts: SyncWorktreeOpts) -> napi::Result<SyncWorktreeResult> {
    let source = PathBuf::from(&opts.source);
    let destination = PathBuf::from(&opts.destination);
    let root_guard: Option<PathBuf> = opts.root_guard.as_ref().map(PathBuf::from);
    let root_ref: Option<&Path> = root_guard.as_deref();

    let patterns = read_include_patterns(&source).map_err(napi_err)?;

    if patterns.is_empty() {
        let progress = Progress::disabled();
        let (files, bytes) =
            copy_dir_recursive(&source, &destination, root_ref, opts.force, &progress)
                .map_err(napi_err)?;
        return Ok(SyncWorktreeResult {
            copied_count: u32::try_from(files).unwrap_or(u32::MAX),
            skipped_count: 0,
            failed_paths: Vec::new(),
            total_bytes: u32::try_from(bytes.min(u64::from(u32::MAX))).unwrap_or(u32::MAX),
            patterns_applied: 0,
        });
    }

    let candidates: Vec<PathBuf> = walk_files(&source);
    let kept = apply_include_matcher(&source, &patterns, &candidates).map_err(napi_err)?;

    let mut copied: u32 = 0;
    let mut skipped: u32 = 0;
    let mut bytes: u64 = 0;
    let mut failed: Vec<String> = Vec::new();

    for src in &kept {
        let Ok(rel) = src.strip_prefix(&source) else {
            continue;
        };
        let dest = destination.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(napi_err)?;
        }
        match copy_leaf(src, &dest, root_ref, opts.force) {
            Ok(Some(n)) => {
                copied = copied.saturating_add(1);
                bytes = bytes.saturating_add(n);
            }
            Ok(None) => {
                skipped = skipped.saturating_add(1);
            }
            Err(_) => {
                failed.push(rel.to_string_lossy().to_string());
            }
        }
    }

    let patterns_applied = u32::try_from(patterns.len()).unwrap_or(u32::MAX);

    Ok(SyncWorktreeResult {
        copied_count: copied,
        skipped_count: skipped,
        failed_paths: failed,
        total_bytes: u32::try_from(bytes.min(u64::from(u32::MAX))).unwrap_or(u32::MAX),
        patterns_applied,
    })
}

// ── run_step (generic dispatcher) ────────────────────────────────────

/// Discriminator for [`run_step`]'s `kind` field.
///
/// Each variant routes to the matching SDK primitive. The JSON-tagged variant
/// pattern keeps the napi binding strictly typed at the boundary while
/// reusing the per-step option / result structs above.
#[napi(string_enum)]
pub enum StepKind {
    /// Routes to [`prune_worktrees`].
    Prune,
    /// Routes to [`promote_branch`].
    Promote,
    /// Routes to [`relocate_worktree`].
    Relocate,
    /// Routes to [`copy_ignored`].
    CopyIgnored,
    /// Routes to [`remove_dir`].
    RemoveDir,
    /// Routes to [`sync_worktree`].
    Sync,
}

/// Options for [`run_step`].
///
/// Only the field matching `kind` is consulted; the rest are ignored. This
/// shape keeps the napi binding side-effect-free: JS callers compose an
/// envelope and the binding routes it to the right SDK primitive without
/// dynamic loading.
#[napi(object)]
pub struct RunStepOpts {
    /// Which step to run.
    pub kind: StepKind,
    /// Options for `StepKind::Prune`.
    pub prune: Option<PruneOpts>,
    /// Options for `StepKind::Promote`.
    pub promote: Option<PromoteOpts>,
    /// Options for `StepKind::Relocate`.
    pub relocate: Option<RelocateOpts>,
    /// Options for `StepKind::CopyIgnored`.
    pub copy_ignored: Option<CopyIgnoredOpts>,
    /// Options for `StepKind::RemoveDir`.
    pub remove_dir: Option<RemoveDirOpts>,
    /// Options for `StepKind::Sync`.
    pub sync: Option<SyncWorktreeOpts>,
}

/// Result of [`run_step`]. Exactly one field corresponding to the dispatched
/// kind is populated.
#[napi(object)]
pub struct RunStepResult {
    /// Which step ran (echoed for caller convenience).
    pub kind: StepKind,
    /// Result of `StepKind::Prune` (populated when `kind == Prune`).
    pub prune: Option<PrunePlanNapi>,
    /// Result of `StepKind::Promote` (populated when `kind == Promote`).
    pub promote: Option<PromotePlanNapi>,
    /// Result of `StepKind::Relocate` (populated when `kind == Relocate`).
    pub relocate: Option<RelocatePlanNapi>,
    /// Result of `StepKind::CopyIgnored` (populated when `kind == CopyIgnored`).
    pub copy_ignored: Option<CopyIgnoredOutcomeNapi>,
    /// Result of `StepKind::RemoveDir` (populated when `kind == RemoveDir`).
    pub remove_dir: Option<RemoveDirResult>,
    /// Result of `StepKind::Sync` (populated when `kind == Sync`).
    pub sync: Option<SyncWorktreeResult>,
}

/// Generic step dispatcher.
///
/// Routes `opts.kind` to the matching SDK primitive. Returns a [`RunStepResult`]
/// envelope with exactly one result field populated. This is a convenience
/// for JS callers that already have a step-kind discriminant in their
/// pipeline state and want to dispatch without a `switch` on the JS side.
///
/// The function performs NO business logic beyond routing — every branch
/// delegates to one of the dedicated napi exports above.
///
/// # Errors
///
/// Returns a [`napi::Error`] when:
/// - The option field matching `opts.kind` is `None`.
/// - The underlying SDK primitive errors (forwarded as-is).
#[napi]
pub fn run_step(opts: RunStepOpts) -> napi::Result<RunStepResult> {
    match opts.kind {
        StepKind::Prune => {
            let prune_opts = opts
                .prune
                .ok_or_else(|| napi::Error::from_reason("run_step: missing `prune` options"))?;
            let plan = prune_worktrees(prune_opts)?;
            Ok(RunStepResult {
                kind: StepKind::Prune,
                prune: Some(plan),
                promote: None,
                relocate: None,
                copy_ignored: None,
                remove_dir: None,
                sync: None,
            })
        }
        StepKind::Promote => {
            let promote_opts = opts
                .promote
                .ok_or_else(|| napi::Error::from_reason("run_step: missing `promote` options"))?;
            let plan = promote_branch(promote_opts)?;
            Ok(RunStepResult {
                kind: StepKind::Promote,
                prune: None,
                promote: Some(plan),
                relocate: None,
                copy_ignored: None,
                remove_dir: None,
                sync: None,
            })
        }
        StepKind::Relocate => {
            let relocate_opts = opts
                .relocate
                .ok_or_else(|| napi::Error::from_reason("run_step: missing `relocate` options"))?;
            let plan = relocate_worktree(relocate_opts)?;
            Ok(RunStepResult {
                kind: StepKind::Relocate,
                prune: None,
                promote: None,
                relocate: Some(plan),
                copy_ignored: None,
                remove_dir: None,
                sync: None,
            })
        }
        StepKind::CopyIgnored => {
            let copy_opts = opts.copy_ignored.ok_or_else(|| {
                napi::Error::from_reason("run_step: missing `copy_ignored` options")
            })?;
            let outcome = copy_ignored(copy_opts)?;
            Ok(RunStepResult {
                kind: StepKind::CopyIgnored,
                prune: None,
                promote: None,
                relocate: None,
                copy_ignored: Some(outcome),
                remove_dir: None,
                sync: None,
            })
        }
        StepKind::RemoveDir => {
            let rm_opts = opts.remove_dir.ok_or_else(|| {
                napi::Error::from_reason("run_step: missing `remove_dir` options")
            })?;
            let result = remove_dir(rm_opts)?;
            Ok(RunStepResult {
                kind: StepKind::RemoveDir,
                prune: None,
                promote: None,
                relocate: None,
                copy_ignored: None,
                remove_dir: Some(result),
                sync: None,
            })
        }
        StepKind::Sync => {
            let sync_opts = opts
                .sync
                .ok_or_else(|| napi::Error::from_reason("run_step: missing `sync` options"))?;
            let result = sync_worktree(sync_opts)?;
            Ok(RunStepResult {
                kind: StepKind::Sync,
                prune: None,
                promote: None,
                relocate: None,
                copy_ignored: None,
                remove_dir: None,
                sync: Some(result),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_worktree_include_returns_empty_for_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let result = read_worktree_include(tmp.path().to_string_lossy().to_string());
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);
    }

    #[test]
    fn read_worktree_include_parses_negation() {
        let tmp = tempfile::tempdir().unwrap();
        let include_path = tmp.path().join(".worktreeinclude");
        std::fs::write(&include_path, "*.log\n!important.log\n").unwrap();
        let result = read_worktree_include(tmp.path().to_string_lossy().to_string()).unwrap();
        assert!(!result.is_empty(), "expected patterns; got empty");
        // Verify at least: one pattern with is_negation=false ("*.log"),
        // and one with is_negation=true ("important.log").
        let has_negation = result.iter().any(|p| p.is_negation);
        let has_non_negation = result.iter().any(|p| !p.is_negation);
        assert!(has_negation, "expected at least one negation pattern");
        assert!(
            has_non_negation,
            "expected at least one non-negation pattern"
        );
    }

    #[test]
    fn list_worktrees_returns_at_least_the_main_worktree() {
        let cwd = std::env::current_dir().unwrap();
        let opts = ListOpts {
            repo_root: cwd.to_string_lossy().to_string(),
        };
        let result = list_worktrees(opts);
        assert!(result.is_ok(), "list_worktrees errored: {:?}", result.err());
        let worktrees = result.unwrap();
        assert!(
            !worktrees.is_empty(),
            "expected at least the primary worktree"
        );
    }

    #[test]
    fn destroy_worktree_errors_on_nonexistent_path() {
        let opts = DestroyOpts {
            repo_root: std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .to_string(),
            worktree_path: "/tmp/definitely-does-not-exist-T10018".to_string(),
            force: false,
        };
        let result = destroy_worktree(opts);
        assert!(
            result.is_err(),
            "destroy_worktree should fail on missing path"
        );
    }

    #[test]
    fn copy_paths_parallel_handles_empty_paths() {
        let src = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        let opts = CopyOpts {
            force: false,
            root_guard: None,
            include_symlinks: false,
        };
        let result = copy_paths_parallel(
            src.path().to_string_lossy().to_string(),
            dest.path().to_string_lossy().to_string(),
            vec![],
            opts,
        );
        assert!(result.is_ok());
        let r = result.unwrap();
        assert_eq!(r.copied_count, 0);
        assert_eq!(r.skipped_count, 0);
    }

    // ── T10203 step-primitive adapter tests ──────────────────────────

    use std::process::Command;
    use tempfile::TempDir;

    fn init_repo_with_merged_branch() -> TempDir {
        let dir = TempDir::new().unwrap();
        let p = dir.path();
        Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(p)
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "t@t.t"])
            .current_dir(p)
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "t"])
            .current_dir(p)
            .status()
            .unwrap();
        std::fs::write(p.join("README.md"), "v0\n").unwrap();
        Command::new("git")
            .args(["add", "README.md"])
            .current_dir(p)
            .status()
            .unwrap();
        Command::new("git")
            .args(["commit", "-q", "-m", "init"])
            .current_dir(p)
            .status()
            .unwrap();
        Command::new("git")
            .args(["switch", "-c", "feat-merged"])
            .current_dir(p)
            .status()
            .unwrap();
        std::fs::write(p.join("feat.txt"), "x").unwrap();
        Command::new("git")
            .args(["add", "feat.txt"])
            .current_dir(p)
            .status()
            .unwrap();
        Command::new("git")
            .args(["commit", "-q", "-m", "feat work"])
            .current_dir(p)
            .status()
            .unwrap();
        Command::new("git")
            .args(["switch", "main"])
            .current_dir(p)
            .status()
            .unwrap();
        Command::new("git")
            .args(["merge", "-q", "--ff-only", "feat-merged"])
            .current_dir(p)
            .status()
            .unwrap();
        dir
    }

    #[test]
    fn prune_worktrees_surfaces_merged_branch_candidate() {
        let dir = init_repo_with_merged_branch();
        let plan = prune_worktrees(PruneOpts {
            repo_root: dir.path().to_string_lossy().to_string(),
            integration_target: "main".to_string(),
        })
        .expect("prune_worktrees should succeed on a fresh repo");
        assert_eq!(plan.integration_target, "main");
        assert!(
            plan.candidates
                .iter()
                .any(|c| c.branch.as_deref() == Some("feat-merged") && c.kind == "branch_only"),
            "expected feat-merged branch in plan"
        );
    }

    #[test]
    fn prune_worktrees_errors_on_invalid_repo_root() {
        let result = prune_worktrees(PruneOpts {
            repo_root: "/nonexistent/path/T10203".to_string(),
            integration_target: "main".to_string(),
        });
        assert!(result.is_err(), "expected error on missing repo");
    }

    #[test]
    fn promote_branch_already_in_main_is_a_noop_plan() {
        let dir = init_repo_with_merged_branch();
        // main is currently checked out — `promote_branch main` should report
        // already_in_main without bailing.
        let plan = promote_branch(PromoteOpts {
            repo_root: dir.path().to_string_lossy().to_string(),
            target_branch: "main".to_string(),
        })
        .expect("promote_branch should succeed when target is main");
        assert!(plan.already_in_main);
        assert_eq!(plan.main_branch, "main");
    }

    #[test]
    fn relocate_worktree_emits_candidate_for_mismatched_path() {
        let dir = init_repo_with_merged_branch();
        // The single main worktree lives at `dir.path()` and is on branch
        // `main`. Feed an expected_path that doesn't match — relocate should
        // emit one candidate.
        let plan = relocate_worktree(RelocateOpts {
            repo_root: dir.path().to_string_lossy().to_string(),
            expected_paths_branches: vec!["main".to_string()],
            expected_paths_targets: vec!["/wt/somewhere-else".to_string()],
        })
        .expect("relocate_worktree should succeed");
        assert_eq!(plan.candidates.len(), 1);
        assert_eq!(plan.candidates[0].branch, "main");
        assert_eq!(plan.candidates[0].expected_path, "/wt/somewhere-else");
    }

    #[test]
    fn relocate_worktree_rejects_mismatched_array_lengths() {
        let dir = init_repo_with_merged_branch();
        let result = relocate_worktree(RelocateOpts {
            repo_root: dir.path().to_string_lossy().to_string(),
            expected_paths_branches: vec!["main".to_string(), "feat".to_string()],
            expected_paths_targets: vec!["/wt/x".to_string()],
        });
        assert!(result.is_err());
    }

    #[test]
    fn copy_ignored_same_worktree_is_a_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let outcome = copy_ignored(CopyIgnoredOpts {
            source: tmp.path().to_string_lossy().to_string(),
            destination: tmp.path().to_string_lossy().to_string(),
            source_context: "T10203-test".to_string(),
            worktree_paths: vec![],
            exclude_patterns: vec![],
            force: false,
        })
        .expect("copy_ignored should succeed for same-worktree no-op");
        assert!(outcome.plan.same_worktree);
        assert_eq!(outcome.files, 0);
        assert_eq!(outcome.bytes, 0);
    }

    #[test]
    fn remove_dir_counts_files_and_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("tree");
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/file1.txt"), b"hello").unwrap();
        std::fs::write(root.join("a/b/file2.txt"), b"world!").unwrap();

        let r = remove_dir(RemoveDirOpts {
            path: root.to_string_lossy().to_string(),
        })
        .expect("remove_dir should succeed");
        assert_eq!(r.files, 2);
        assert_eq!(r.bytes, 11); // "hello" (5) + "world!" (6) = 11
        assert!(!root.exists());
    }

    #[test]
    fn remove_dir_missing_root_is_ok() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist");
        let r = remove_dir(RemoveDirOpts {
            path: missing.to_string_lossy().to_string(),
        })
        .expect("remove_dir should succeed even for missing root");
        assert_eq!(r.files, 0);
        assert_eq!(r.bytes, 0);
    }

    #[test]
    fn sync_worktree_copies_full_subtree_when_no_include_file() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join("a.txt"), b"alpha").unwrap();
        std::fs::create_dir(src.path().join("sub")).unwrap();
        std::fs::write(src.path().join("sub/b.txt"), b"bravo").unwrap();
        let r = sync_worktree(SyncWorktreeOpts {
            source: src.path().to_string_lossy().to_string(),
            destination: dst.path().to_string_lossy().to_string(),
            force: true,
            root_guard: None,
        })
        .expect("sync_worktree should succeed without include file");
        assert_eq!(r.patterns_applied, 0, "no include file = no patterns");
        assert!(r.copied_count >= 2, "expected at least a.txt + sub/b.txt");
        assert!(dst.path().join("a.txt").exists());
        assert!(dst.path().join("sub/b.txt").exists());
    }

    #[test]
    fn sync_worktree_filters_via_worktreeinclude() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join(".worktreeinclude"), "include-me.txt\n").unwrap();
        std::fs::write(src.path().join("include-me.txt"), b"yes").unwrap();
        std::fs::write(src.path().join("skip-me.txt"), b"no").unwrap();
        let r = sync_worktree(SyncWorktreeOpts {
            source: src.path().to_string_lossy().to_string(),
            destination: dst.path().to_string_lossy().to_string(),
            force: true,
            root_guard: None,
        })
        .expect("sync_worktree should succeed with include file");
        assert!(
            r.patterns_applied >= 1,
            "expected at least 1 pattern parsed"
        );
        assert!(dst.path().join("include-me.txt").exists());
        assert!(
            !dst.path().join("skip-me.txt").exists(),
            "skip-me.txt should have been filtered out"
        );
    }

    #[test]
    fn run_step_dispatches_to_remove_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("tree");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("a"), b"abc").unwrap();
        let result = run_step(RunStepOpts {
            kind: StepKind::RemoveDir,
            prune: None,
            promote: None,
            relocate: None,
            copy_ignored: None,
            remove_dir: Some(RemoveDirOpts {
                path: root.to_string_lossy().to_string(),
            }),
            sync: None,
        })
        .expect("run_step RemoveDir should succeed");
        assert!(matches!(result.kind, StepKind::RemoveDir));
        let rm = result.remove_dir.expect("expected remove_dir result");
        assert_eq!(rm.files, 1);
        assert_eq!(rm.bytes, 3);
    }

    #[test]
    fn run_step_dispatches_to_prune() {
        let dir = init_repo_with_merged_branch();
        let result = run_step(RunStepOpts {
            kind: StepKind::Prune,
            prune: Some(PruneOpts {
                repo_root: dir.path().to_string_lossy().to_string(),
                integration_target: "main".to_string(),
            }),
            promote: None,
            relocate: None,
            copy_ignored: None,
            remove_dir: None,
            sync: None,
        })
        .expect("run_step Prune should succeed");
        assert!(matches!(result.kind, StepKind::Prune));
        let plan = result.prune.expect("expected prune plan");
        assert_eq!(plan.integration_target, "main");
    }

    #[test]
    fn run_step_errors_on_missing_options_for_kind() {
        let result = run_step(RunStepOpts {
            kind: StepKind::Prune,
            prune: None, // missing
            promote: None,
            relocate: None,
            copy_ignored: None,
            remove_dir: None,
            sync: None,
        });
        assert!(result.is_err(), "expected missing-options error");
    }
}
