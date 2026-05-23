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
//! - [`cache`] — on-disk JSON cache primitives (read/write/sweep/clear) under
//!   `<wt_dir>/cache/<kind>/`. Extracted from worktrunk's `src/cache.rs` per
//!   T10221 (ADR-078). No `Repository` dependency — callers pass the cache
//!   root as a `&Path`.
//! - [`copy`] — reflink (COW) + rayon parallel directory copy with progress
//!   callbacks and path-root guards.
//! - [`diff`] — pure git-diff parsers ([`diff::LineDiff`], [`diff::DiffStats`],
//!   [`diff::parse_numstat_line`], [`diff::parse_shortstat`]). Extracted from
//!   `worktrunk::git::diff` per T10221; the donor's `cformat!`-styled summary
//!   was intentionally dropped (CLI consumers compose color themselves).
//! - [`path`] — path canonicalization that works for non-existent paths,
//!   plus user-facing path display formatting.
//! - [`remove_dir`] — recursive parallel directory removal with optional
//!   progress reporting. Extracted from worktrunk's `src/remove_dir.rs` per
//!   T10221.
//! - [`sync`] — counting semaphore for limiting concurrency
//!   ([`sync::Semaphore`]). Extracted from worktrunk's `src/sync.rs` per
//!   T10221.
//! - [`worktreeinclude`] — parser for `.worktreeinclude` files using the
//!   `ignore::gitignore` matcher (correct glob match, not literal `existsSync`).
//! - [`git_wt`] — minimal `git worktree` primitives (add, remove, list, lock,
//!   unlock) invoked via `std::process::Command`.
//! - [`git`] — substitute SDK surface for worktrunk's `git::*` types
//!   ([`git::BranchDeletionMode`], [`git::RefSnapshot`], [`git::Repo`] trait,
//!   [`git::ProcessRepo`] default impl). See
//!   `docs/research/t10219-worktrunk-sdk-interface-audit.md` for rationale.
//! - [`config`] — field-only SDK projection of worktrunk's
//!   `config::UserConfig` ([`config::UserConfigDto`],
//!   [`config::CopyIgnoredConfig`]).
//! - [`progress`] — opt-in progress reporter; defaults to a zero-cost no-op so
//!   napi consumers pay nothing.
//!
//! # CLI-binary-only modules (intentionally NOT vendored)
//!
//! Two donor modules — `worktrunk::priority` and `worktrunk::signal_forwarder`
//! — were deliberately left out of `worktrunk-core` per the T10221 audit and
//! ADR-078's separation-of-concerns contract:
//!
//! - `worktrunk::priority` (donor `/mnt/projects/worktrunk/src/priority.rs`):
//!   shells out to `nice`/`ionice`/`taskpolicy` to lower the OS-level priority
//!   of the calling process so foreground sessions get the CPU/IO budget.
//!   This is a CLI-binary side effect — it mutates per-process resource
//!   limits and depends on which shell helpers the host environment ships
//!   (Darwin `taskpolicy`, Linux `nice` + `ionice`, no-op elsewhere). SDK
//!   consumers (napi worker threads, embedded `cleo orchestrate spawn`)
//!   already run with whatever priority their host process chose; they
//!   MUST NOT silently re-nice their host.
//!
//! - `worktrunk::signal_forwarder` (donor
//!   `/mnt/projects/worktrunk/src/signal_forwarder.rs`): installs SIGINT /
//!   SIGTERM handlers on the foreground `wt` binary and forwards them to
//!   child process groups. The entire module is `#[cfg(unix)]` and depends
//!   on POSIX pgroup semantics that only make sense when there IS a
//!   foreground binary owning the signal disposition. SDK consumers do not
//!   own the foreground signal disposition (the host process does), so
//!   re-installing handlers from a library is unsafe and would silently
//!   break napi shutdown.
//!
//! Both modules stay in the `worktrunk` CLI binary. Any SDK consumer that
//! needs equivalent behavior is responsible for managing it in its OWN
//! process-lifecycle layer.
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

pub mod cache;
pub mod config;
pub mod copy;
pub mod diff;
pub mod git;
pub mod git_wt;
pub mod path;
pub mod paths;
pub mod progress;
pub mod remove_dir;
pub mod step;
pub mod sync;
pub mod worktreeinclude;

pub use config::{CopyIgnoredConfig, UserConfigDto};
pub use copy::{copy_dir_recursive, copy_leaf};
pub use diff::{DiffStats, LineDiff, parse_numstat_line, parse_shortstat};
pub use git::{
    BranchDeletionMode, BranchRef, ProcessRepo, RefEntry, RefKind, RefSnapshot, RefType,
    RemovalPlan, Repo,
};
pub use git_wt::{
    WorktreeHandle, WorktreeInfo, destroy_worktree, list_worktrees, lock_worktree,
    provision_worktree, unlock_worktree,
};
pub use path::{canonicalize_with_parents, format_path_for_display, paths_match};
pub use paths::{compute_project_hash, resolve_task_worktree_path, resolve_worktree_root_for_hash};
pub use progress::Progress;
pub use remove_dir::remove_dir_with_progress;
pub use sync::{Semaphore, SemaphoreGuard};
pub use worktreeinclude::{IncludePattern, apply_include_matcher, read_include_patterns};
