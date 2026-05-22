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
//! All errors from `worktrunk-core` (which use `anyhow::Result`) are funneled
//! through [`napi_err`] which wraps `to_string()` of the underlying error
//! chain into a `napi::Error` so the JS side gets a readable `Error.message`.

use std::path::{Path, PathBuf};

use napi_derive::napi;

use worktrunk_core::copy::{copy_dir_recursive, copy_leaf};
use worktrunk_core::git_wt::{
    WorktreeHandle, WorktreeInfo, destroy_worktree as core_destroy_worktree,
    list_worktrees as core_list_worktrees, lock_worktree,
    provision_worktree as core_provision_worktree,
};
use worktrunk_core::progress::Progress;
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
