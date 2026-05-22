// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

#![forbid(unsafe_code)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

//! Parallel git-worktree provisioning + `.worktreeinclude` parsing for CLEO.
//!
//! `worktrunk-core` is the pure-Rust SDK that powers `cleo orchestrate spawn`'s
//! worktree provisioning. It replaces the previous per-file sequential `cp()`
//! TypeScript implementation with a 4-thread rayon-driven, reflink-aware copy
//! engine that respects symlinks and `.worktreeinclude` files.
//!
//! # Modules
//!
//! - [`copy`] — reflink (COW) + rayon parallel directory copy with progress
//!   callbacks and path-root guards.
//! - [`path`] — path canonicalization that works for non-existent paths,
//!   plus user-facing path display formatting.
//! - [`worktreeinclude`] — parser for `.worktreeinclude` files using the
//!   `ignore::gitignore` matcher (correct glob match, not literal `existsSync`).
//! - [`git_wt`] — minimal `git worktree` primitives (add, remove, list, lock,
//!   unlock) invoked via `std::process::Command`.
//! - [`progress`] — opt-in progress reporter; defaults to a zero-cost no-op so
//!   napi consumers pay nothing.
//!
//! # Example
//!
//! ```no_run
//! use worktrunk_core::copy::copy_dir_recursive;
//! use worktrunk_core::progress::Progress;
//! use std::path::Path;
//!
//! let progress = Progress::disabled();
//! let (files, bytes) = copy_dir_recursive(
//!     Path::new("/src/repo"),
//!     Path::new("/dst/worktree"),
//!     None,
//!     false,
//!     &progress,
//! ).unwrap();
//! println!("Copied {files} files ({bytes} bytes)");
//! ```

pub mod copy;
pub mod git_wt;
pub mod path;
pub mod progress;
pub mod worktreeinclude;

pub use copy::{copy_dir_recursive, copy_leaf};
pub use git_wt::{
    WorktreeHandle, WorktreeInfo, destroy_worktree, list_worktrees, lock_worktree,
    provision_worktree, unlock_worktree,
};
pub use path::{canonicalize_with_parents, format_path_for_display, paths_match};
pub use progress::Progress;
pub use worktreeinclude::{IncludePattern, apply_include_matcher, read_include_patterns};
